import type { Inngest } from "inngest";
import { StandardError } from "@bakery/contracts/http";
import { EXTERNAL_EFFECT_IN_FLIGHT } from "@bakery/persistence/external-effect-holds";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import {
  type BudgetRecoveryFailureKind,
  clearBudgetRecoveryFailure,
  findExpiredBudgetReleaseCandidates,
  findProviderUsageReceiptCandidates,
  reconcileProviderUsageReceipt,
  recordBudgetRecoveryFailure,
  releaseWorkflowAction,
} from "./budget.ts";

const DEFAULT_RECONCILIATION_LIMIT = 50;

function failureCode(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.split(":", 1)[0]!.slice(0, 200);
  }
  return "BUDGET_RECOVERY_CANDIDATE_FAILED";
}

function isEffectInFlight(error: unknown): boolean {
  return error instanceof StandardError &&
    error.code === "STATE_CONFLICT" &&
    (error.params as { reason?: unknown } | undefined)?.reason ===
      EXTERNAL_EFFECT_IN_FLIGHT;
}

async function rememberFailure(
  database: PgDatabase,
  options: Readonly<{
    kind: BudgetRecoveryFailureKind;
    organizationId: string;
    installationReservationId: string;
    candidateId: string;
    error: unknown;
  }>,
): Promise<void> {
  await withPgTransaction(database, async (transaction) => {
    await recordBudgetRecoveryFailure(transaction, {
      kind: options.kind,
      organizationId: options.organizationId,
      installationReservationId: options.installationReservationId,
      candidateId: options.candidateId,
      errorCode: failureCode(options.error),
    });
  });
}

export async function reconcileBudgetLedger(
  database: PgDatabase,
  limit = DEFAULT_RECONCILIATION_LIMIT,
): Promise<{ providerReceipts: number; releases: number }> {
  const providerCandidates = await withPgTransaction(
    database,
    (transaction) => findProviderUsageReceiptCandidates(transaction, limit),
  );
  let providerReceipts = 0;
  for (const candidate of providerCandidates) {
    const candidateId = candidate.usageRecordId ?? candidate.receiptId;
    try {
      const reconciled = await withPgTransaction(
        database,
        async (transaction) => {
          const result = await reconcileProviderUsageReceipt(
            transaction,
            candidate,
          );
          await clearBudgetRecoveryFailure(transaction, {
            kind: "provider-receipt",
            organizationId: candidate.organizationId,
            candidateId,
          });
          return result;
        },
      );
      if (reconciled) providerReceipts++;
    } catch (error) {
      if (isEffectInFlight(error)) continue;
      await rememberFailure(database, {
        kind: "provider-receipt",
        organizationId: candidate.organizationId,
        installationReservationId: candidate.installationReservationId,
        candidateId,
        error,
      });
    }
  }

  const releaseCandidates = await withPgTransaction(
    database,
    (transaction) => findExpiredBudgetReleaseCandidates(transaction, limit),
  );
  let releases = 0;
  for (const candidate of releaseCandidates) {
    try {
      await withPgTransaction(database, async (transaction) => {
        await releaseWorkflowAction(transaction, candidate);
        await clearBudgetRecoveryFailure(transaction, {
          kind: "release",
          organizationId: candidate.organizationId,
          candidateId: candidate.evidenceId,
        });
      });
      releases++;
    } catch (error) {
      // A live external effect claimed the reservation between the candidate
      // query and this transaction. Not a failure: skip, retry on the next pass.
      if (isEffectInFlight(error)) continue;
      await rememberFailure(database, {
        kind: "release",
        organizationId: candidate.organizationId,
        installationReservationId: candidate.installationReservationId,
        candidateId: candidate.evidenceId,
        error,
      });
    }
  }
  return { providerReceipts, releases };
}

export function createBakeryBudgetRecovery(options: {
  client: Inngest;
  database: PgDatabase;
  limit?: number;
}) {
  const limit = options.limit ?? DEFAULT_RECONCILIATION_LIMIT;
  return options.client.createFunction(
    {
      id: "bakery-budget-recovery",
      retries: 3,
      triggers: [
        { cron: "* * * * *" },
        { event: "bakery/budget.reconcile.v1" },
      ],
    },
    async ({ step }) => {
      return await step.run(
        "reconcile-budget-ledger",
        () => reconcileBudgetLedger(options.database, limit),
      );
    },
  );
}
