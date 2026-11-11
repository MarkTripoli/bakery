import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import {
  type ActiveIntegrationRegistry,
  type AuthoritySnapshotPort,
  type BoundInvocation,
  createActionContext,
  type ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import {
  classifyDispatch,
  DEFAULT_MAX_DISPATCH_GENERATIONS,
  type HandlerEnd,
  type RequestRecord,
} from "./classify.ts";
import { observeProviderRequests } from "./observe.ts";
import { casOutcome, findEffectById } from "./repository.ts";
import {
  type EffectOutcome,
  EffectOutcomeSchema,
  type ExternalEffectRow,
} from "./schema.ts";

/** Wall-clock budget for one handler call, in milliseconds; below the dispatch lease. */
export const DEFAULT_DEADLINE_MS = 60_000;

/** Collaborators a dispatch needs after a claim has committed. */
export type DispatchDeps = Readonly<{
  database: PgDatabase;
  registry: ActiveIntegrationRegistry;
  snapshotsFor(transaction: PgTransactionClient): AuthoritySnapshotPort;
  providerRequests: ProviderRequestPort;
  deadlineMs?: number;
  maxDispatchGenerations?: number;
}>;

/** Authority port that opens a short transaction per load, for code that runs outside a transaction. */
export function standaloneSnapshots(
  database: PgDatabase,
  snapshotsFor: (transaction: PgTransactionClient) => AuthoritySnapshotPort,
): AuthoritySnapshotPort {
  return {
    load: (key) =>
      withPgTransaction(database, (tx) => snapshotsFor(tx).load(key)),
  };
}

/** What one dispatch produced: the outcome to record and the requests behind it. */
export type DispatchResult = Readonly<{
  outcome: EffectOutcome;
  requests: readonly RequestRecord[];
}>;

/**
 * Runs `run` against an observed request port under a deadline, then maps how
 * it ended to an outcome. The observed port closes the moment `run` settles or
 * the deadline passes, so a request started later never reaches the provider.
 * This is the seam the unit tests drive with fake handlers.
 */
export async function runObserved(
  input: Readonly<{
    inner: ProviderRequestPort;
    run(port: ProviderRequestPort, signal: AbortSignal): Promise<unknown>;
    deadlineMs: number;
    generation: number;
    maxGenerations: number;
  }>,
): Promise<DispatchResult> {
  const observed = observeProviderRequests(input.inner);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.deadlineMs);
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new DOMException("dispatch deadline", "TimeoutError")),
      { once: true },
    );
  });
  // The race must not leave a dangling rejection when the handler wins.
  aborted.catch(() => {});
  let end: HandlerEnd;
  try {
    const output = await Promise.race([
      input.run(observed.port, controller.signal),
      aborted,
    ]);
    end = { kind: "resolved", output };
  } catch {
    end = { kind: "threw", timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
    observed.close();
    controller.abort();
  }
  const requests = observed.records();
  return {
    outcome: classifyDispatch({
      end,
      requests,
      generation: input.generation,
      maxGenerations: input.maxGenerations,
    }),
    requests,
  };
}

/**
 * Performs the provider write of one effect whose claim has committed. This is
 * the only place the executor runs a handler's write; callers reach it only
 * with a `claimed` result.
 */
export async function dispatchEffect(
  deps: DispatchDeps,
  claimed: Readonly<{ effect: ExternalEffectRow; bound: BoundInvocation }>,
): Promise<DispatchResult> {
  const { effect, bound } = claimed;
  const action = deps.registry.findAction(
    bound.providerId,
    bound.actionRef.id,
    bound.actionRef.version,
  );
  if (!action) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const snapshots = standaloneSnapshots(deps.database, deps.snapshotsFor);
  return await runObserved({
    inner: deps.providerRequests,
    deadlineMs: deps.deadlineMs ?? DEFAULT_DEADLINE_MS,
    generation: effect.dispatchGeneration,
    maxGenerations: deps.maxDispatchGenerations ??
      DEFAULT_MAX_DISPATCH_GENERATIONS,
    run: (port, signal) =>
      action.handler.invoke(
        createActionContext(bound, {
          registry: deps.registry,
          snapshots,
          providerRequests: port,
          signal,
        }),
        effect.safeArguments,
      ),
  });
}

export const RecordOutcomeInputSchema = z.strictObject({
  organizationId: z.uuid().describe("Organization that owns the effect."),
  effectId: z.uuid().describe("Effect the dispatch attempt belongs to."),
  dispatchGeneration: z.number().int().min(1).describe(
    "Generation the claim committed; the outcome lands only while the row still holds it.",
  ),
  outcome: EffectOutcomeSchema,
}).describe("Everything needed to record how one dispatch attempt ended.");
export type RecordOutcomeInput = z.input<typeof RecordOutcomeInputSchema>;

/** Result of recording an outcome: whether the fence held, and the row as it stands. */
export type RecordOutcomeResult = Readonly<{
  applied: boolean;
  effect: ExternalEffectRow;
}>;

/**
 * Records a dispatch outcome under the fence `status = submitted` and the
 * claimed generation. A lost fence writes nothing and returns the current row.
 */
export async function recordOutcome(
  deps: Readonly<{ database: PgDatabase }>,
  rawInput: RecordOutcomeInput,
): Promise<RecordOutcomeResult> {
  const parsed = RecordOutcomeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      detail: "invalid effect outcome input",
      params: { reason: "invalid effect outcome input" },
    });
  }
  const { organizationId, effectId, dispatchGeneration, outcome } = parsed.data;
  return await withPgTransaction(deps.database, async (tx) => {
    const change = outcome.kind === "retry"
      ? { kind: "retry" as const, delaySeconds: outcome.retryAfterSeconds }
      : outcome.kind === "failed"
      ? { kind: "failed" as const, failureCode: outcome.failureCode }
      : outcome;
    const written = await casOutcome(
      tx,
      organizationId,
      effectId,
      dispatchGeneration,
      change,
    );
    if (written) return { applied: true, effect: written };
    const current = await findEffectById(tx, organizationId, effectId);
    if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    return { applied: false, effect: current };
  });
}
