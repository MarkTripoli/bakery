import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { type McpAsyncForm, parseMcpAsyncForm } from "./async-form.ts";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import type {
  McpEffectPort,
  McpWriteClass,
  McpWriteResult,
} from "../effects/mcp.ts";
import {
  type EffectFailureCode,
  type ExternalEffectRow,
  MAX_EFFECT_JSON_BYTES,
} from "../effects/schema.ts";
import { invokeMcpTool, type McpInvokeDeps } from "./invoke.ts";
import { McpToolCallError, type McpToolCallFailure } from "./tool-transport.ts";

/**
 * What the effect ledger asks of the MCP side for a write to a pinned tool
 * (#435, slice 2c; docs/technical-design/25-one-engine.md 15.4, O26). Every send
 * goes through the pinned-tool door, which re-checks the connection, the grant,
 * the binding and drift and validates the arguments against the pinned schema, so
 * this port adds only what the ledger needs on top: the classification the Admin
 * gave the tool, which decides how an unproven send is treated.
 *
 * The step is found through the effect's run step: its run names the workflow
 * version, and the step key (without the round marks of enclosing repeats) is the
 * key of the binding the version wrote at publish.
 */

type Classification = Readonly<{
  effectClass: McpWriteClass;
  keyArgument: string | null;
  pairedRead: string | null;
}>;

type Facts = Readonly<{
  workflowVersionId: string;
  stepKey: string;
  bindingDigest: string | null;
  allowedOperations: readonly string[];
  /** Null when the Admin never classified the tool: it runs at most once. */
  classified: (Classification & { digest: string }) | null;
  notAWrite: boolean;
  asyncForm: McpAsyncForm | null;
}>;

export const AsyncPollResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("pending").describe(
      "The operation exists and has not ended.",
    ),
  }).describe("A poll answer for an operation still running."),
  z.strictObject({
    state: z.literal("not_found").describe(
      "The server knows no operation under the key yet.",
    ),
  }).describe("A poll answer before the submitted operation is visible."),
  z.strictObject({
    state: z.literal("succeeded").describe("The operation ended and worked."),
    result: z.unknown().describe(
      "What the operation produced, published as the step's result.",
    ).optional().describe(
      "What the operation produced, published as the step's result.",
    ),
  }).describe("A poll answer for an operation that ended well."),
  z.strictObject({
    state: z.literal("failed").describe("The operation ended and failed."),
  }).describe("A poll answer for an operation that ended in failure."),
  z.strictObject({
    state: z.literal("canceled").describe(
      "The operation was canceled on the server.",
    ),
  }).describe("A poll answer for an operation the server canceled."),
]).describe(
  "The answer a poll tool of an asynchronous write gives, in the shape Bakery requires.",
);

type PollVerdict =
  | Readonly<{ status: "confirmed"; result: unknown }>
  | Readonly<{ status: "unconfirmed" }>
  | Readonly<{ status: "failed"; failureCode: EffectFailureCode }>;

export function pollVerdict(answer: unknown): PollVerdict {
  const parsed = AsyncPollResultSchema.safeParse(answer);
  if (!parsed.success) {
    return { status: "failed", failureCode: "async_poll_invalid" };
  }
  switch (parsed.data.state) {
    case "pending":
    case "not_found":
      return { status: "unconfirmed" };
    case "failed":
      return { status: "failed", failureCode: "async_poll_failed" };
    case "canceled":
      return { status: "failed", failureCode: "async_poll_canceled" };
    case "succeeded": {
      const result = parsed.data.result ?? null;
      return new TextEncoder().encode(canonicalJson(result)).length >
          MAX_EFFECT_JSON_BYTES
        ? { status: "failed", failureCode: "async_poll_invalid" }
        : { status: "confirmed", result };
    }
  }
}

function operationKeyOf(
  effect: ExternalEffectRow,
  form: McpAsyncForm,
): string | null {
  const value = (effect.safeArguments as Record<string, unknown> | null)
    ?.[form.effectKeyArgument];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const WRITE_CLASSES: readonly string[] = [
  "write_idempotent",
  "write_reconcilable",
  "write_async",
  "write_opaque",
];

/** Failures that say the server never executed the call, or answered that it did not. */
const NOT_SENT: ReadonlySet<McpToolCallFailure> = new Set([
  "connection_unavailable",
  "transport_unsupported",
  "config_missing_placeholder",
  "endpoint_invalid",
  "refused_address",
]);
const REJECTED: ReadonlySet<McpToolCallFailure> = new Set([
  "auth_rejected",
  "endpoint_not_found",
  "redirect_refused",
  "server_error",
  "tool_failed",
]);

/** How one failed exchange maps to what the ledger records; anything else may have arrived. */
export function mcpWriteFailure(error: unknown): McpWriteResult {
  // A refusal by the door happens before anything is sent.
  if (error instanceof StandardError) {
    return { kind: "not_sent", retryable: false };
  }
  if (error instanceof McpToolCallError) {
    if (NOT_SENT.has(error.reason)) {
      return { kind: "not_sent", retryable: false };
    }
    if (REJECTED.has(error.reason)) {
      return { kind: "rejected", retryable: false };
    }
  }
  return { kind: "unknown" };
}

/**
 * Whether a paired read's answer is evidence the write happened: it carries some
 * value that is not empty. A write is paired with a read that answers with
 * nothing, or fails, when the write did not happen; that pairing is the Admin's.
 */
export function readAnswerIsEvidence(answer: unknown): boolean {
  if (answer === null || answer === undefined) return false;
  if (typeof answer === "string") return answer.trim().length > 0;
  if (Array.isArray(answer)) return answer.some(readAnswerIsEvidence);
  if (typeof answer === "object") {
    return Object.values(answer as Record<string, unknown>).some(
      readAnswerIsEvidence,
    );
  }
  return true;
}

/** The arguments a read tool declares, taken from the write's; a read declaring none gets none. */
export function argumentsForRead(
  writeArguments: unknown,
  readSchema: unknown,
): Record<string, unknown> {
  const source = writeArguments !== null && typeof writeArguments === "object"
    ? writeArguments as Record<string, unknown>
    : {};
  const properties = (readSchema as { properties?: unknown } | null)
    ?.properties;
  if (properties === null || typeof properties !== "object") return {};
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => Object.hasOwn(properties, name)),
  );
}

export function createMcpEffectPort(
  deps: Readonly<{
    database: PgDatabase;
    mcp: McpInvokeDeps;
  }>,
): McpEffectPort {
  async function factsOf(effect: ExternalEffectRow): Promise<Facts | null> {
    if (
      effect.mcpConnectionId === null || effect.runStepId === null ||
      effect.adapterManifestDigest === null
    ) return null;
    const connectionId = effect.mcpConnectionId;
    return await withPgTransaction(deps.database, async (tx) => {
      const step = await tx.query<{
        step_key: string;
        workflow_version_id: string | null;
        binding_digest: string | null;
        allowed_operations: unknown;
        async_form: unknown;
      }>(
        `select regexp_replace(rs.step_key, '@[0-9]+', '', 'g') as step_key,
                wr.workflow_version_id,
                cb.mcp_snapshot_digest as binding_digest,
                cb.allowed_operations,
                cb.mcp_async_form as async_form
           from bakery.run_steps rs
           join bakery.workflow_runs wr
             on wr.organization_id = rs.organization_id and wr.id = rs.run_id
           left join bakery.capability_bindings cb
             on cb.organization_id = rs.organization_id
            and cb.workflow_version_id = wr.workflow_version_id
            and cb.step_key = regexp_replace(rs.step_key, '@[0-9]+', '', 'g')
            and cb.mcp_connection_id = $3
          where rs.organization_id = $1 and rs.id = $2`,
        [effect.organizationId, effect.runStepId, connectionId],
      );
      const row = step.rows[0];
      if (row === undefined || row.workflow_version_id === null) return null;
      const classification = await tx.query<{
        effect_class: string;
        effect_key_argument: string | null;
        paired_read_tool: string | null;
        snapshot_digest: string;
      }>(
        `select effect_class, effect_key_argument, paired_read_tool,
                snapshot_digest
           from bakery.mcp_tool_classifications
          where organization_id = $1 and connection_id = $2 and tool_name = $3`,
        [effect.organizationId, connectionId, effect.operation],
      );
      const found = classification.rows[0];
      const allowed = Array.isArray(row.allowed_operations)
        ? row.allowed_operations.filter((x): x is string =>
          typeof x === "string"
        )
        : [];
      return {
        workflowVersionId: row.workflow_version_id,
        stepKey: row.step_key,
        bindingDigest: row.binding_digest,
        allowedOperations: allowed,
        classified:
          found !== undefined && WRITE_CLASSES.includes(found.effect_class)
            ? {
              effectClass: found.effect_class as McpWriteClass,
              keyArgument: found.effect_key_argument,
              pairedRead: found.paired_read_tool,
              digest: found.snapshot_digest,
            }
            : null,
        notAWrite: found !== undefined &&
          !WRITE_CLASSES.includes(found.effect_class),
        asyncForm: parseMcpAsyncForm(row.async_form),
      };
    });
  }

  const classOf = (facts: Facts): McpWriteClass =>
    facts.asyncForm !== null
      ? "write_async"
      : facts.classified?.effectClass ?? "write_opaque";

  const asyncFormDrifted = (facts: Facts): boolean =>
    (facts.asyncForm !== null) !==
      (facts.classified?.effectClass === "write_async");

  async function pinnedInputSchema(
    effect: ExternalEffectRow,
    toolName: string,
  ): Promise<unknown> {
    return await withPgTransaction(deps.database, async (tx) => {
      const snapshot = await tx.query<{ manifest: unknown }>(
        `select manifest from bakery.mcp_capability_snapshots
          where organization_id = $1 and connection_id = $2 and digest = $3
          limit 1`,
        [
          effect.organizationId,
          effect.mcpConnectionId,
          effect.adapterManifestDigest,
        ],
      );
      const tools = (snapshot.rows[0]?.manifest as
        | { tools?: { name?: unknown; inputSchema?: unknown }[] }
        | null)?.tools ?? [];
      return tools.find((tool) => tool.name === toolName)?.inputSchema;
    });
  }

  async function poll(
    effect: ExternalEffectRow,
    facts: Facts,
    form: McpAsyncForm,
    signal: AbortSignal,
  ): Promise<PollVerdict> {
    const key = operationKeyOf(effect, form);
    if (key === null || !facts.allowedOperations.includes(form.pollTool)) {
      return { status: "unconfirmed" };
    }
    const schema = await pinnedInputSchema(effect, form.pollTool);
    const answer = await send(effect, facts, form.pollTool, {
      ...argumentsForRead(effect.safeArguments, schema),
      [form.effectKeyArgument]: key,
    }, signal);
    return pollVerdict(answer.output);
  }

  async function send(
    effect: ExternalEffectRow,
    facts: Facts,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    return await invokeMcpTool(deps.mcp, {
      organizationId: effect.organizationId,
      actorRef: effect.actorRef,
      connectionId: effect.mcpConnectionId!,
      toolName,
      pinnedDigest: effect.adapterManifestDigest!,
      arguments: args,
      hostId: null,
      workflowVersionId: facts.workflowVersionId,
      stepKey: facts.stepKey,
      startedByPrincipalId: effect.requestingPrincipalId,
      signal,
    });
  }

  async function write(
    effect: ExternalEffectRow,
    signal: AbortSignal,
  ): Promise<McpWriteResult> {
    const facts = await factsOf(effect);
    if (facts === null) return { kind: "not_sent", retryable: false };
    try {
      const sent = await send(
        effect,
        facts,
        effect.operation,
        effect.safeArguments as Record<string, unknown>,
        signal,
      );
      const key = facts.asyncForm === null
        ? null
        : operationKeyOf(effect, facts.asyncForm);
      return key === null
        ? { kind: "done", output: sent.output }
        : { kind: "accepted", operationKey: key };
    } catch (error) {
      return mcpWriteFailure(error);
    }
  }

  return {
    async admit(effect) {
      const facts = await factsOf(effect);
      if (facts === null || facts.bindingDigest === null) {
        return { ok: false, failureCode: "authorization_denied" };
      }
      // The step pinned one snapshot, and the Admin classified the tool against
      // one: both must still be the snapshot this effect was prepared against.
      if (
        facts.bindingDigest !== effect.adapterManifestDigest ||
        facts.notAWrite ||
        asyncFormDrifted(facts) ||
        (facts.classified !== null &&
          facts.classified.digest !== effect.adapterManifestDigest)
      ) return { ok: false, failureCode: "adapter_changed" };
      return { ok: true, effectClass: classOf(facts) };
    },
    write,
    async confirm(effect, signal) {
      const facts = await factsOf(effect);
      if (facts === null) return { status: "unconfirmed" };
      const effectClass = classOf(facts);
      if (effectClass === "write_opaque") return { status: "unconfirmed" };
      if (facts.asyncForm !== null) {
        return await poll(effect, facts, facts.asyncForm, signal);
      }
      if (effectClass === "write_idempotent") {
        // Sending an idempotent write again under its effect key is how it is
        // proven: the server answers the same, and does the work once.
        const again = await write(effect, signal);
        return again.kind === "done"
          ? { status: "confirmed", result: again.output }
          : { status: "unconfirmed" };
      }
      const pairedRead = facts.classified?.pairedRead ?? null;
      if (pairedRead === null) return { status: "unconfirmed" };
      const schema = await pinnedInputSchema(effect, pairedRead);
      // A read is safe to repeat; it is the only thing sent here.
      const answer = await send(
        effect,
        facts,
        pairedRead,
        argumentsForRead(effect.safeArguments, schema),
        signal,
      );
      return readAnswerIsEvidence(answer.output)
        ? { status: "confirmed", result: answer.output }
        : { status: "unconfirmed" };
    },
  };
}
