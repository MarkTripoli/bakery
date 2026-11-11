import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { withPgTransaction } from "../../platform/database.ts";
import { createReconciliationContext } from "../catalog/integration-gate.ts";
import { confirmedOutcome, type RequestRecord } from "./classify.ts";
import { authorityAdmission } from "./admission.ts";
import {
  DEFAULT_DEADLINE_MS,
  type DispatchDeps,
  standaloneSnapshots,
} from "./dispatch.ts";
import { observeProviderRequests } from "./observe.ts";
import {
  casReconcileLease,
  findEffectById,
  recordReconcileCheck,
} from "./repository.ts";
import {
  type ExternalEffectRow,
  MAX_RECONCILIATION_EVIDENCE_BYTES,
  type ReconciliationEvidence,
  ReconciliationEvidenceSchema,
} from "./schema.ts";

/** Seconds a reconciliation lease lasts; must exceed the reconcile deadline. */
export const DEFAULT_RECONCILE_LEASE_SECONDS = 120;

/** Collaborators reconciliation needs. */
export type ReconcileDeps =
  & DispatchDeps
  & Readonly<{
    reconcileLeaseSeconds?: number;
  }>;

export const ReconcileEffectInputSchema = z.strictObject({
  organizationId: z.uuid().describe("Organization that owns the effect."),
  effectId: z.uuid().describe("Effect to check against the provider."),
}).describe("Everything a caller supplies to reconcile one effect.");
export type ReconcileEffectInput = z.input<typeof ReconcileEffectInputSchema>;

/** How a reconciliation call ended. `skipped` means no check ran because nobody could take the lease. */
export type ReconcileResult = Readonly<{
  outcome: "confirmed" | "uncertain" | "skipped";
  effect: ExternalEffectRow;
}>;

const encoder = new TextEncoder();

function errorClassOf(error: unknown): string {
  const name = error instanceof StandardError
    ? error.code
    : error instanceof Error
    ? error.name
    : typeof error;
  return name.slice(0, 100);
}

function evidenceOf(
  input: Readonly<{
    attempt: number;
    requests: readonly RequestRecord[];
    outcome: ReconciliationEvidence["outcome"];
    error?: unknown;
  }>,
): ReconciliationEvidence {
  const refs = [...new Set(input.requests.map((r) => r.ref))].slice(0, 8);
  const evidence: ReconciliationEvidence = {
    attempt: input.attempt,
    requestCount: Math.min(100, input.requests.length),
    refs,
    settledOk: Math.min(
      100,
      input.requests.filter((r) => r.state === "fulfilled").length,
    ),
    rejected: Math.min(
      100,
      input.requests.filter((r) =>
        r.state === "rejected" || r.state === "not_sent" ||
        r.state === "unknown"
      ).length,
    ),
    outcome: input.outcome,
    ...(input.error === undefined
      ? {}
      : { errorClass: errorClassOf(input.error) }),
  };
  const parsed = ReconciliationEvidenceSchema.parse(evidence);
  if (
    encoder.encode(canonicalJson(parsed)).length >
      MAX_RECONCILIATION_EVIDENCE_BYTES
  ) throw new Error("reconciliation evidence exceeds its bound");
  return parsed;
}

/**
 * Checks one `uncertain` effect (or a `submitted` one whose dispatch lease
 * expired) against the provider using only the read-only reconcile requests.
 * It never runs the write handler: the only request set the context allows is
 * the action's reconcile requests, and fresh authority must still pass.
 *
 * A thrown reconcile, a malformed page, a denial or an unsettled request all
 * leave the effect `uncertain`, with the check time, attempt count and a
 * bounded evidence summary recorded. Match count and truncation are not
 * observable without an SDK union change; recording them is deferred.
 */
export async function reconcileEffect(
  deps: ReconcileDeps,
  rawInput: ReconcileEffectInput,
): Promise<ReconcileResult> {
  const parsed = ReconcileEffectInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      detail: "invalid effect reconcile input",
      params: { reason: "invalid effect reconcile input" },
    });
  }
  const { organizationId, effectId } = parsed.data;
  const leased = await withPgTransaction(deps.database, async (tx) => {
    const taken = await casReconcileLease(
      tx,
      organizationId,
      effectId,
      deps.reconcileLeaseSeconds ?? DEFAULT_RECONCILE_LEASE_SECONDS,
    );
    if (taken) return { taken, current: null } as const;
    const current = await findEffectById(tx, organizationId, effectId);
    if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    return { taken: null, current } as const;
  });
  if (leased.taken === null) {
    return { outcome: "skipped", effect: leased.current };
  }
  const effect = leased.taken;
  const attempt = effect.reconciliationAttempts + 1;
  const record = async (
    check: Parameters<typeof recordReconcileCheck>[4],
  ): Promise<ReconcileResult> => {
    const written = await withPgTransaction(
      deps.database,
      (tx) =>
        recordReconcileCheck(
          tx,
          organizationId,
          effectId,
          effect.version,
          check,
        ),
    );
    if (written) {
      return {
        outcome: written.status === "confirmed" ? "confirmed" : "uncertain",
        effect: written,
      };
    }
    const current = await withPgTransaction(
      deps.database,
      (tx) => findEffectById(tx, organizationId, effectId),
    );
    if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    return {
      outcome: current.status === "confirmed" ? "confirmed" : "skipped",
      effect: current,
    };
  };
  const uncertainCheck = (
    requests: readonly RequestRecord[],
    outcome: ReconciliationEvidence["outcome"],
    error?: unknown,
  ) => ({
    confirmed: null,
    evidence: evidenceOf({ attempt, requests, outcome, error }),
  });

  const snapshots = standaloneSnapshots(deps.database, deps.snapshotsFor);
  let admission;
  try {
    admission = await authorityAdmission(deps.registry, snapshots, effect);
  } catch (error) {
    return await record(uncertainCheck([], "threw", error));
  }
  if (!admission.ok) {
    return await record(
      uncertainCheck(
        [],
        admission.failureCode === "resource_identity_changed"
          ? "identity_drift"
          : "denied",
      ),
    );
  }
  const { bound } = admission;
  const action = deps.registry.findAction(
    bound.providerId,
    bound.actionRef.id,
    bound.actionRef.version,
  );
  if (!action) return await record(uncertainCheck([], "denied"));

  const observed = observeProviderRequests(deps.providerRequests);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.deadlineMs ?? DEFAULT_DEADLINE_MS,
  );
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new DOMException("reconcile deadline", "TimeoutError")),
      { once: true },
    );
  });
  aborted.catch(() => {});
  let result:
    | Readonly<
      {
        ok: true;
        value: Awaited<ReturnType<typeof action.handler.invokeReconcile>>;
      }
    >
    | Readonly<{ ok: false; error: unknown }>;
  try {
    const value = await Promise.race([
      action.handler.invokeReconcile(
        createReconciliationContext(bound, effect.safeArguments, {
          registry: deps.registry,
          snapshots,
          providerRequests: observed.port,
          signal: controller.signal,
        }),
      ),
      aborted,
    ]);
    result = { ok: true, value };
  } catch (error) {
    result = { ok: false, error };
  } finally {
    clearTimeout(timer);
    observed.close();
    controller.abort();
  }
  const requests = observed.records();
  if (!result.ok) {
    return await record(uncertainCheck(requests, "threw", result.error));
  }
  if (requests.some((r) => r.state === "pending")) {
    return await record(uncertainCheck(requests, "uncertain"));
  }
  if (result.value.status !== "confirmed") {
    return await record(uncertainCheck(requests, "uncertain"));
  }
  const bounded = confirmedOutcome(result.value.result as unknown);
  return await record({
    confirmed: {
      remoteId: bounded.remoteId,
      safeResult: bounded.safeResult,
    },
    evidence: evidenceOf({ attempt, requests, outcome: "confirmed" }),
  });
}
