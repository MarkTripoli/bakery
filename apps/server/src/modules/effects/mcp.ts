import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import {
  classifyDispatch,
  DEFAULT_MAX_DISPATCH_GENERATIONS,
  type HandlerEnd,
  type RequestRecord,
  retryOrExhaust,
} from "./classify.ts";
import { computeRequestDigest } from "./digest.ts";
import {
  findEffectByKey,
  insertPreparedEffect,
  runStepExists,
} from "./repository.ts";
import {
  type EffectFailureCode,
  type EffectOutcome,
  type ExternalEffectRow,
  MAX_EFFECT_JSON_BYTES,
  MCP_TARGET_PREFIX,
} from "./schema.ts";

/**
 * Writes to a tool on an MCP connection, through the same ledger as an
 * integration write (docs/technical-design/25-one-engine.md, 15.4, O26).
 *
 * The ledger owns what it always owned: the intent row, the claim that moves
 * `prepared` to `submitted` under a fence, the recorded outcome and the rule
 * that an uncertain effect is never replaced by a new one. This module owns only
 * what differs for MCP: the target, and what a send, a retry and a confirmation
 * mean for each way an Admin classified the tool.
 */

/** How an Admin classified a write tool; a read never reaches the ledger. */
export type McpWriteClass =
  | "write_idempotent"
  | "write_reconcilable"
  | "write_async"
  | "write_opaque";

/** How one send of a write ended, as far as the sender can tell. */
export type McpWriteResult =
  | Readonly<{ kind: "done"; output: unknown }>
  | Readonly<{ kind: "accepted"; operationKey: string }>
  /** Refused before anything left the server: no connection, no grant, a drifted tool. */
  | Readonly<{ kind: "not_sent"; retryable: boolean }>
  /** The server answered with a definite error: the write did not happen. */
  | Readonly<{
    kind: "rejected";
    retryable: boolean;
    retryAfterSeconds?: number;
  }>
  /** Something may have reached the server (a timeout, a broken answer, a dropped line). */
  | Readonly<{ kind: "unknown" }>;

/** What the ledger asks of the MCP side. Every call is read or send; none writes the ledger. */
export type McpEffectPort = Readonly<{
  /**
   * Fresh authority for one effect, read at claim and again at dispatch: the
   * connection is usable, the step's binding and snapshot digest still hold, and
   * the tool is still classified as a write against that snapshot.
   */
  admit(
    effect: ExternalEffectRow,
  ): Promise<
    | Readonly<{ ok: true; effectClass: McpWriteClass }>
    | Readonly<{ ok: false; failureCode: EffectFailureCode }>
  >;
  /** Sends the write once, with the arguments the ledger stored. */
  write(
    effect: ExternalEffectRow,
    signal: AbortSignal,
  ): Promise<McpWriteResult>;
  /**
   * Looks for proof the write happened, without sending it again unless the tool
   * is idempotent: an idempotent write is confirmed by sending it again under the
   * same effect key, a reconcilable one by its paired read, and an opaque one is
   * never confirmed here (only a person can settle it).
   */
  confirm(
    effect: ExternalEffectRow,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ status: "confirmed"; result: unknown }>
    | Readonly<{ status: "unconfirmed" }>
    | Readonly<{ status: "failed"; failureCode: EffectFailureCode }>
  >;
}>;

export const isMcpEffect = (effect: Pick<ExternalEffectRow, "target">) =>
  effect.target.startsWith(MCP_TARGET_PREFIX);

/** The stable target of a write to one tool on one connection. */
export const mcpEffectTarget = (connectionId: string, tool: string): string =>
  `${MCP_TARGET_PREFIX}${connectionId}:${tool}`;

const encoder = new TextEncoder();
const unprocessable = (reason: string) =>
  new StandardError({
    code: "UNPROCESSABLE",
    detail: reason,
    params: { reason },
  });

export const PrepareMcpEffectInputSchema = z.strictObject({
  organizationId: z.uuid().describe("Organization that owns the effect."),
  actorRef: z.string().min(1).max(200).describe(
    "Reference of the invoking actor, written to the ledger as the effect's actor.",
  ),
  requestingPrincipalId: z.uuid().describe(
    "Principal whose authority the call carries.",
  ),
  connectionId: z.uuid().describe("MCP connection the tool is called on."),
  tool: z.string().min(1).max(200).describe("Name of the tool to call."),
  snapshotDigest: z.string().min(1).max(200).describe(
    "Digest of the capability snapshot the step pinned; rechecked at claim.",
  ),
  arguments: z.record(
    z.string().describe("Name of one argument of the tool."),
    z.unknown().describe("Value of that argument."),
  ).describe(
    "The tool's arguments, validated against the pinned schema when sent.",
  ),
  idempotencyKey: z.string().min(1).max(400).describe(
    "The one effect key of the step: a repeat of the same key is the same effect.",
  ),
  runStepId: z.uuid().nullable().describe(
    "Run step that caused the effect, or null for an effect outside a run.",
  ),
}).describe(
  "Everything a caller supplies to record the intent of one MCP write.",
);
export type PrepareMcpEffectInput = z.input<typeof PrepareMcpEffectInputSchema>;

/** What recording the intent of an MCP write answers: the effect, and whether it already existed. */
export type PrepareMcpEffectResult = Readonly<{
  effectId: string;
  status: ExternalEffectRow["status"];
  replayed: boolean;
}>;

/**
 * Records the intent of one MCP write, or returns the effect an equal earlier
 * request already recorded; a repeat of the key with other facts is a mismatch.
 * Authority is read at claim, as for an integration write.
 */
export async function prepareMcpEffect(
  deps: Readonly<{ database: PgDatabase }>,
  rawInput: PrepareMcpEffectInput,
): Promise<PrepareMcpEffectResult> {
  const parsed = PrepareMcpEffectInputSchema.safeParse(rawInput);
  if (!parsed.success) throw unprocessable("invalid effect prepare input");
  const input = parsed.data;
  if (
    encoder.encode(canonicalJson(input.arguments)).length >
      MAX_EFFECT_JSON_BYTES
  ) throw unprocessable("effect_arguments_too_large");
  const target = mcpEffectTarget(input.connectionId, input.tool);
  const digest = await computeRequestDigest({
    operation: input.tool,
    actionVersion: 0,
    target,
    connectionId: input.connectionId,
    // The pinned snapshot stands where an integration effect names its resource:
    // the same tool call against another snapshot is another request.
    resourceId: input.snapshotDigest,
    externalAccountId: null,
    externalResourceId: null,
    arguments: input.arguments,
    actorRef: input.actorRef,
    runStepId: input.runStepId,
    automationDefinitionId: null,
    budgetReservationId: null,
    approval: null,
  });
  const key = {
    organizationId: input.organizationId,
    operation: input.tool,
    target,
    idempotencyKey: input.idempotencyKey,
  };
  const replay = (existing: ExternalEffectRow): PrepareMcpEffectResult => {
    if (existing.requestDigest !== digest) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return { effectId: existing.id, status: existing.status, replayed: true };
  };
  return await withPgTransaction(deps.database, async (tx) => {
    const existing = await findEffectByKey(tx, key);
    if (existing) return replay(existing);
    if (
      input.runStepId !== null &&
      !await runStepExists(tx, input.organizationId, input.runStepId)
    ) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const inserted = await insertPreparedEffect(tx, {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      runStepId: input.runStepId,
      automationDefinitionId: null,
      operation: input.tool,
      actionVersion: null,
      target,
      integrationConnectionId: null,
      integrationResourceId: null,
      mcpConnectionId: input.connectionId,
      integrationInstallId: null,
      integrationGrantId: null,
      adapterManifestDigest: input.snapshotDigest,
      requestingPrincipalId: input.requestingPrincipalId,
      actorRef: input.actorRef,
      idempotencyKey: input.idempotencyKey,
      requestDigest: digest,
      safeArguments: input.arguments,
      externalAccountId: null,
      externalResourceId: null,
      adapterVersion: "mcp",
      authorizationRevision: null,
      budgetReservationId: null,
      approvalId: null,
      approvalStage: null,
      approvalPolicyDigest: null,
    });
    if (inserted) {
      return {
        effectId: inserted.id,
        status: inserted.status,
        replayed: false,
      };
    }
    const winner = await findEffectByKey(tx, key);
    if (!winner) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "effect_key_vanished" },
      });
    }
    return replay(winner);
  });
}

/** Deadline and retry limits a dispatch or a confirmation runs under. */
export type McpRunLimits = Readonly<{
  deadlineMs: number;
  maxDispatchGenerations?: number;
}>;

/** What one dispatch produced: the outcome to record and the request behind it. */
export type McpDispatchResult = Readonly<{
  outcome: EffectOutcome;
  requests: readonly RequestRecord[];
}>;

/** Runs `run` under a deadline; the signal it is given aborts when the deadline passes or it settles. */
async function underDeadline<T>(
  deadlineMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; timedOut: boolean; error: unknown }>
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new DOMException("mcp deadline", "TimeoutError")),
      { once: true },
    );
  });
  aborted.catch(() => {});
  try {
    return {
      ok: true,
      value: await Promise.race([run(controller.signal), aborted]),
    };
  } catch (error) {
    return { ok: false, timedOut: controller.signal.aborted, error };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Sends the write of one claimed MCP effect and maps how it ended to an outcome.
 * The outcome table is the ledger's own (`classifyDispatch`); the one thing the
 * class changes is an unproven send: a tool that takes an effect key may simply be
 * sent again, so its unproven send is retried, where a reconcilable or opaque
 * tool's stays `uncertain` and is never sent a second time.
 */
export async function dispatchMcpEffect(
  deps: Readonly<{ mcp?: McpEffectPort }> & McpRunLimits,
  effect: ExternalEffectRow,
): Promise<McpDispatchResult> {
  const maxGenerations = deps.maxDispatchGenerations ??
    DEFAULT_MAX_DISPATCH_GENERATIONS;
  const none = (outcome: EffectOutcome): McpDispatchResult => ({
    outcome,
    requests: [],
  });
  if (deps.mcp === undefined) {
    return none({ kind: "failed", failureCode: "authorization_denied" });
  }
  let admitted;
  try {
    admitted = await deps.mcp.admit(effect);
  } catch {
    // Reading authority failed before anything was sent: look again later.
    return none(retryOrExhaust(effect.dispatchGeneration, maxGenerations));
  }
  if (!admitted.ok) {
    return none({ kind: "failed", failureCode: admitted.failureCode });
  }
  const ref = `${effect.operation}@mcp`;
  const sent = await underDeadline(
    deps.deadlineMs,
    (signal) => deps.mcp!.write(effect, signal),
  );
  let record: RequestRecord;
  let end: HandlerEnd;
  if (!sent.ok) {
    // A call that did not come back may still have arrived.
    record = {
      ref,
      state: sent.timedOut ? "pending" : "unknown",
      retryable: false,
    };
    end = { kind: "threw", timedOut: sent.timedOut };
  } else if (sent.value.kind === "accepted") {
    return {
      outcome: { kind: "uncertain", remoteId: sent.value.operationKey },
      requests: [{ ref, state: "fulfilled", retryable: false }],
    };
  } else if (sent.value.kind === "done") {
    record = { ref, state: "fulfilled", retryable: false };
    end = { kind: "resolved", output: sent.value.output };
  } else if (sent.value.kind === "unknown") {
    record = { ref, state: "unknown", retryable: false };
    end = { kind: "threw", timedOut: false };
  } else {
    record = {
      ref,
      state: sent.value.kind,
      retryable: sent.value.retryable,
      ...(sent.value.kind === "rejected" &&
          sent.value.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: sent.value.retryAfterSeconds }
        : {}),
    };
    end = { kind: "threw", timedOut: false };
  }
  const classified = classifyDispatch({
    end,
    requests: [record],
    generation: effect.dispatchGeneration,
    maxGenerations,
  });
  const outcome = classified.kind === "uncertain" &&
      admitted.effectClass === "write_idempotent"
    ? retryOrExhaust(effect.dispatchGeneration, maxGenerations)
    : classified;
  return { outcome, requests: [record] };
}

/** What one confirmation found, in the terms reconciliation records. */
export type McpConfirmResult =
  | Readonly<{
    kind: "confirmed";
    result: unknown;
    requests: readonly RequestRecord[];
  }>
  | Readonly<{
    kind: "uncertain";
    requests: readonly RequestRecord[];
    outcome: "uncertain" | "threw" | "denied";
    error?: unknown;
  }>
  | Readonly<{
    kind: "failed";
    failureCode: EffectFailureCode;
    requests: readonly RequestRecord[];
  }>;

/** Looks for proof of one unsettled MCP write. It never sends a write a second time unless the tool is idempotent. */
export async function confirmMcpEffect(
  deps: Readonly<{ mcp?: McpEffectPort }> & McpRunLimits,
  effect: ExternalEffectRow,
): Promise<McpConfirmResult> {
  if (deps.mcp === undefined) {
    return { kind: "uncertain", requests: [], outcome: "denied" };
  }
  let admitted;
  try {
    admitted = await deps.mcp.admit(effect);
  } catch (error) {
    return { kind: "uncertain", requests: [], outcome: "threw", error };
  }
  if (!admitted.ok) {
    return { kind: "uncertain", requests: [], outcome: "denied" };
  }
  const ref = `${effect.operation}@mcp`;
  const checked = await underDeadline(
    deps.deadlineMs,
    (signal) => deps.mcp!.confirm(effect, signal),
  );
  if (!checked.ok) {
    return {
      kind: "uncertain",
      requests: [{
        ref,
        state: checked.timedOut ? "pending" : "unknown",
        retryable: false,
      }],
      outcome: "threw",
      error: checked.error,
    };
  }
  const requests: RequestRecord[] = [{
    ref,
    state: "fulfilled",
    retryable: false,
  }];
  switch (checked.value.status) {
    case "confirmed":
      return { kind: "confirmed", result: checked.value.result, requests };
    case "failed":
      return {
        kind: "failed",
        failureCode: checked.value.failureCode,
        requests,
      };
    case "unconfirmed":
      return { kind: "uncertain", requests, outcome: "uncertain" };
  }
}
