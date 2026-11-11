/**
 * External effect ledger: persisted intent for every external side effect.
 * This surface grows phase by phase; consumers import only from here.
 *
 * Budget: a live effect (submitted, uncertain, or prepared on an unexpired
 * reservation) pins its reservation against budget recovery only (release and
 * provider-receipt reconcile skip or refuse it). The worker's own terminal
 * result still settles, so an effect that stays uncertain never makes a job's
 * result unresolvable.
 */
// claim.ts stays internal: `runEffect` is the only entry that moves an effect
// out of prepared. A bare claim would commit submitted with nothing to dispatch.
export { DEFAULT_LEASE_SECONDS } from "./claim.ts";
export {
  classifyDispatch,
  DEFAULT_MAX_DISPATCH_GENERATIONS,
  type HandlerEnd,
  type RequestRecord,
  type RequestState,
  retryDelaySeconds,
} from "./classify.ts";
// dispatch.ts stays internal: `runEffect` is the only door to a provider write,
// and an outcome is recorded only by the executor that holds the claim.
export { DEFAULT_DEADLINE_MS } from "./dispatch.ts";
export {
  createEffectExecutor,
  type EffectExecutor,
  type EffectExecutorDeps,
  type RunEffectInput,
  RunEffectInputSchema,
  type RunEffectResult,
} from "./executor.ts";
export { type ObservedPort, observeProviderRequests } from "./observe.ts";
export {
  DEFAULT_RECONCILE_LEASE_SECONDS,
  type ReconcileDeps,
  reconcileEffect,
  type ReconcileEffectInput,
  ReconcileEffectInputSchema,
  type ReconcileResult,
} from "./reconcile.ts";
export { computeRequestDigest, type EffectIdentity } from "./digest.ts";
export { type PrepareDeps, prepareEffect } from "./prepare.ts";
export {
  EFFECT_FAILURE_CODES,
  EffectApprovalRefSchema,
  EffectFailureCodeSchema,
  type EffectOutcome,
  EffectOutcomeSchema,
  type ExternalEffectRow,
  ExternalEffectRowSchema,
  type ExternalEffectStatus,
  ExternalEffectStatusSchema,
  type PrepareEffectInput,
  PrepareEffectInputSchema,
  type PrepareEffectResult,
  PrepareEffectResultSchema,
  type ReconciliationEvidence,
  ReconciliationEvidenceSchema,
} from "./schema.ts";
