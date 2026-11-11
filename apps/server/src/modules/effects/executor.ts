import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import { withPgTransaction } from "../../platform/database.ts";
import { claimEffect, DEFAULT_LEASE_SECONDS } from "./claim.ts";
import {
  DEFAULT_DEADLINE_MS,
  type DispatchDeps,
  dispatchEffect,
  recordOutcome,
  standaloneSnapshots,
} from "./dispatch.ts";
import { prepareEffect } from "./prepare.ts";
import {
  DEFAULT_RECONCILE_LEASE_SECONDS,
  type ReconcileDeps,
  reconcileEffect,
  type ReconcileEffectInput,
  type ReconcileResult,
} from "./reconcile.ts";
import { readEffectState } from "./repository.ts";
import type {
  ExternalEffectRow,
  PrepareEffectInput,
  PrepareEffectResult,
} from "./schema.ts";

/** Collaborators of the executor: ledger database, registry, authority, and the provider request port. */
export type EffectExecutorDeps =
  & ReconcileDeps
  & Readonly<{
    /** Seconds a dispatch lease lasts; must exceed the dispatch deadline. */
    leaseSeconds?: number;
  }>;

export const RunEffectInputSchema = z.strictObject({
  organizationId: z.uuid().describe("Organization that owns the effect."),
  effectId: z.uuid().describe("Effect to drive toward a proven outcome."),
  requestId: z.string().min(1).max(200).describe(
    "Request identifier written to the audit trail if the claim consumes an approval.",
  ),
  traceId: z.string().min(1).max(200).describe(
    "Trace identifier written to the audit trail if the claim consumes an approval.",
  ),
}).describe("Everything a caller supplies to run one effect.");
export type RunEffectInput = z.input<typeof RunEffectInputSchema>;

/** What `runEffect` did. `dispatched` is true only when this call won the claim and ran the write. */
export type RunEffectResult = Readonly<{
  outcome:
    | "confirmed"
    | "failed"
    | "uncertain"
    | "retry_scheduled"
    | "in_flight";
  effect: ExternalEffectRow;
  dispatched: boolean;
}>;

export type EffectExecutor = Readonly<{
  prepareEffect(input: PrepareEffectInput): Promise<PrepareEffectResult>;
  reconcileEffect(input: ReconcileEffectInput): Promise<ReconcileResult>;
  runEffect(input: RunEffectInput): Promise<RunEffectResult>;
}>;

function settled(
  effect: ExternalEffectRow,
  dispatched: boolean,
): RunEffectResult {
  switch (effect.status) {
    case "confirmed":
      return { outcome: "confirmed", effect, dispatched };
    case "failed":
      return { outcome: "failed", effect, dispatched };
    case "uncertain":
      return { outcome: "uncertain", effect, dispatched };
    case "prepared":
      return { outcome: "retry_scheduled", effect, dispatched };
    case "submitted":
      return { outcome: "in_flight", effect, dispatched };
  }
}

function invalidTimings(reason: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    detail: reason,
    params: { reason },
  });
}

/**
 * Both leases must be positive whole seconds that outlast the handler
 * deadline. A shorter lease would let a reconcile (or a second claim's
 * recovery) start beside a dispatch that is still running.
 */
export function assertLeaseTimings(
  deps: Readonly<{
    leaseSeconds?: number;
    reconcileLeaseSeconds?: number;
    deadlineMs?: number;
  }>,
): void {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    invalidTimings("effect_deadline_must_be_positive");
  }
  for (
    const [name, seconds] of [
      ["dispatch", deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS],
      [
        "reconcile",
        deps.reconcileLeaseSeconds ?? DEFAULT_RECONCILE_LEASE_SECONDS,
      ],
    ] as const
  ) {
    if (!Number.isInteger(seconds) || seconds <= 0) {
      invalidTimings(`effect_${name}_lease_must_be_positive_integer`);
    }
    if (seconds * 1000 <= deadlineMs) {
      invalidTimings(`effect_${name}_lease_must_exceed_deadline`);
    }
  }
}

/**
 * The one door for integration writes. A write runs only after `claimEffect`
 * committed `prepared -> submitted` with a new dispatch generation; after an
 * uncertain outcome only the read-only reconcile requests run, and an
 * uncertain effect is never replaced by a new one.
 */
export function createEffectExecutor(deps: EffectExecutorDeps): EffectExecutor {
  assertLeaseTimings(deps);
  const claimDeps = {
    database: deps.database,
    registry: deps.registry,
    snapshotsFor: deps.snapshotsFor,
    ...(deps.leaseSeconds === undefined
      ? {}
      : { leaseSeconds: deps.leaseSeconds }),
  };
  const dispatchDeps: DispatchDeps = deps;

  const runEffect = async (
    rawInput: RunEffectInput,
  ): Promise<RunEffectResult> => {
    const parsed = RunEffectInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        detail: "invalid effect run input",
        params: { reason: "invalid effect run input" },
      });
    }
    const { organizationId, effectId, requestId, traceId } = parsed.data;
    const state = await withPgTransaction(
      deps.database,
      (tx) => readEffectState(tx, organizationId, effectId),
    );
    if (!state) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const { row } = state;
    if (row.status === "confirmed" || row.status === "failed") {
      return settled(row, false);
    }
    if (row.status === "submitted" && state.leaseLive) {
      return settled(row, false);
    }
    if (row.status === "submitted" || row.status === "uncertain") {
      const result = await reconcileEffect(deps, { organizationId, effectId });
      return result.outcome === "skipped"
        ? { outcome: "in_flight", effect: result.effect, dispatched: false }
        : settled(result.effect, false);
    }
    if (!state.due) return settled(row, false);

    const claim = await claimEffect(claimDeps, {
      organizationId,
      effectId,
      requestId,
      traceId,
    });
    if (claim.outcome === "blocked") return settled(claim.effect, false);
    if (claim.outcome === "not_claimable") {
      return settled(claim.effect, false);
    }
    const dispatched = await dispatchEffect(dispatchDeps, claim);
    const recorded = await recordOutcome(deps, {
      organizationId,
      effectId,
      dispatchGeneration: claim.effect.dispatchGeneration,
      outcome: dispatched.outcome,
    });
    return settled(recorded.effect, true);
  };

  return {
    prepareEffect: (input) =>
      prepareEffect({
        database: deps.database,
        registry: deps.registry,
        snapshots: standaloneSnapshots(deps.database, deps.snapshotsFor),
      }, input),
    reconcileEffect: (input) => reconcileEffect(deps, input),
    runEffect,
  };
}
