import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import type {
  ActiveIntegrationRegistry,
  AuthoritySnapshotPort,
  BoundInvocation,
} from "../catalog/integration-gate.ts";
import {
  approvalAdmission,
  authorityAdmission,
  reservationAdmission,
  runAdmission,
} from "./admission.ts";
import {
  casClaim,
  casToFailed,
  findEffectById,
  lockEffectForClaim,
  lockRunScope,
  lockStepJobs,
  type RunScopeFacts,
  type StepJobFacts,
} from "./repository.ts";
import type { EffectFailureCode, ExternalEffectRow } from "./schema.ts";

/** Seconds a dispatch lease lasts unless the deps say otherwise; must exceed the provider deadline. */
export const DEFAULT_LEASE_SECONDS = 120;

/** Collaborators a claim needs; authority is read inside the claim transaction. */
export type ClaimDeps = Readonly<{
  database: PgDatabase;
  registry: ActiveIntegrationRegistry;
  snapshotsFor(transaction: PgTransactionClient): AuthoritySnapshotPort;
  leaseSeconds?: number;
}>;

export const ClaimEffectInputSchema = z.strictObject({
  organizationId: z.uuid().describe("Organization that owns the effect."),
  effectId: z.uuid().describe("Effect to claim for dispatch."),
  requestId: z.string().min(1).max(200).describe(
    "Request identifier written to the audit trail if the claim consumes an approval.",
  ),
  traceId: z.string().min(1).max(200).describe(
    "Trace identifier written to the audit trail if the claim consumes an approval.",
  ),
}).describe("Everything a caller supplies to claim one prepared effect.");
export type ClaimEffectInput = z.input<typeof ClaimEffectInputSchema>;

/** How a claim ended. Only `claimed` may be followed by provider I/O. */
export type ClaimResult =
  | Readonly<{
    outcome: "claimed";
    effect: ExternalEffectRow;
    bound: BoundInvocation;
  }>
  | Readonly<{
    outcome: "blocked";
    effect: ExternalEffectRow;
    failureCode: EffectFailureCode;
  }>
  | Readonly<{
    outcome: "not_claimable";
    effect: ExternalEffectRow;
    reason: "not_prepared" | "not_due";
  }>;

/**
 * Claims one prepared effect for dispatch in a single short transaction. The
 * transaction commits `prepared -> submitted`, the next dispatch generation and
 * the lease before the caller performs any provider I/O.
 *
 * Lock order: step jobs (share), run (share), effect (update), reservation
 * (share), approval question (update). It extends the budget lock order, and
 * it never waits on host, attempt, step or account rows, so it cannot close a
 * cycle with cancel, settlement or release.
 *
 * A blocking admission result moves the effect to `failed` with its code in
 * the same transaction and performs no I/O. A transport error loading
 * authority rolls the claim back; the effect stays `prepared`.
 */
export async function claimEffect(
  deps: ClaimDeps,
  rawArgs: ClaimEffectInput,
): Promise<ClaimResult> {
  const args = ClaimEffectInputSchema.safeParse(rawArgs);
  if (!args.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      detail: "invalid effect claim input",
      params: { reason: "invalid effect claim input" },
    });
  }
  const { organizationId, effectId, requestId, traceId } = args.data;
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  return await withPgTransaction(deps.database, async (tx) => {
    const peek = await findEffectById(tx, organizationId, effectId);
    if (!peek) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    let jobs: readonly StepJobFacts[] = [];
    let run: RunScopeFacts | null = null;
    if (peek.runStepId !== null) {
      jobs = await lockStepJobs(tx, organizationId, peek.runStepId);
      run = await lockRunScope(tx, organizationId, peek.runStepId);
      if (!run) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const locked = await lockEffectForClaim(tx, organizationId, effectId);
    if (!locked) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const effect = locked.row;
    if (effect.status !== "prepared") {
      return { outcome: "not_claimable", effect, reason: "not_prepared" };
    }
    if (!locked.due) {
      return { outcome: "not_claimable", effect, reason: "not_due" };
    }

    const block = async (
      failureCode: EffectFailureCode,
    ): Promise<ClaimResult> => {
      const failed = await casToFailed(
        tx,
        organizationId,
        effect.id,
        effect.dispatchGeneration,
        failureCode,
      );
      if (!failed) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "effect_claim_fence_lost" },
        });
      }
      return { outcome: "blocked", effect: failed, failureCode };
    };

    const runBlock = runAdmission(run, jobs);
    if (runBlock) return await block(runBlock);
    const reservationBlock = await reservationAdmission(tx, effect);
    if (reservationBlock) return await block(reservationBlock);
    // Authority is read-only and runs before the approval check, because the
    // approval check may consume the approval: a revoked grant must never
    // spend an approval on an effect that cannot dispatch.
    const authority = await authorityAdmission(
      deps.registry,
      deps.snapshotsFor(tx),
      effect,
    );
    if (!authority.ok) return await block(authority.failureCode);
    const approvalBlock = await approvalAdmission(tx, effect, run, {
      requestId,
      traceId,
    });
    if (approvalBlock) return await block(approvalBlock);

    const claimed = await casClaim(
      tx,
      organizationId,
      effect.id,
      effect.dispatchGeneration,
      leaseSeconds,
    );
    if (!claimed) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "effect_claim_fence_lost" },
      });
    }
    return { outcome: "claimed", effect: claimed, bound: authority.bound };
  });
}
