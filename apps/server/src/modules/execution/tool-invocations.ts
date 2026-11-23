import type { Context } from "hono";
import { z } from "zod";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { canonicalJson } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { mcpWriteFailure } from "../mcp/effect-port.ts";
import { invokeMcpTool, type McpInvokeDeps } from "../mcp/invoke.ts";
import { McpToolCallError } from "../mcp/tool-transport.ts";
import {
  type EffectiveMcpTool,
  type EffectiveMcpTools,
  effectiveMcpTools,
  type SessionToolScope,
  sessionToolScope,
} from "../mcp/tool-gateway.ts";
import { assertActiveLease, lockAttempt } from "./events.ts";
import { jsonResponse, parseContract } from "./http.ts";
import {
  assertAttemptMutationSession,
  assertWorkerMutationSessionShape,
  type ExecutionRouteOptions,
  readAttemptId,
  sha256Hex,
  workerIdempotencyUuid,
  workerTransaction,
} from "./shared.ts";
import type { WorkerIdentity } from "./shared.ts";

/**
 * The worker side of the tool gateway (#436, docs/technical-design/
 * 25-one-engine.md 15.4). The worker runs a local MCP endpoint for each agent
 * session; it lists what `effective-tools` answers and sends every call to
 * `worker.invokeTool`. Both routes prove the attempt's lease, fence and worker
 * session first, as every attempt mutation does, and both read the session's
 * scope from the attempt's own rows, never from the worker.
 *
 * A call is recorded before it is sent and settled after, keyed by the
 * Idempotency-Key the worker sends: a replay of the key answers what happened
 * instead of sending again, and a write whose outcome is unknown is not sent a
 * second time (O26's default, at most once) but refused until a person settles
 * it. The credential never reaches the session: the server's broker sends the
 * call.
 */

export const EFFECTIVE_TOOLS_PATH = "/v1/worker/attempts/:id/effective-tools";
export const TOOL_INVOCATIONS_PATH = "/v1/worker/attempts/:id/tool-invocations";

/** The deps the gateway needs: the pinned-tool door the tool.call step also uses. */
export type ToolGatewayDeps = McpInvokeDeps;

const DEFAULT_TIMEOUT_MS = 60_000;

/** The lease proof the effective-tools listing takes; nothing else. */
export const EffectiveToolsRequestSchema = z.strictObject({
  leaseToken: z.string().min(1).max(500).describe(
    "Proof of the attempt's current lease, issued in the JobAssignment.",
  ),
  fence: z.string().regex(/^\d+$/).max(20).describe(
    "Fence value bound to the current attempt; a newer attempt's fence refuses the listing.",
  ),
  workerSessionId: z.uuid().optional().describe(
    "Worker session that holds the attempt; required for protocol v2 hosts.",
  ),
  workerSessionGeneration: z.string().regex(/^\d+$/).max(20).optional()
    .describe(
      "Generation of that worker session; required with workerSessionId.",
    ),
}).describe(
  "Lease proof a worker sends to list the effective tools of one attempt's session.",
);

type LeaseProof = Readonly<{
  leaseToken: string;
  fence: string;
  workerSessionId?: string | undefined;
  workerSessionGeneration?: string | undefined;
}>;

/** Proves the lease and reads the session's scope, in the caller's transaction. */
async function openGatewaySession(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
  attemptId: string,
  proof: LeaseProof,
): Promise<SessionToolScope> {
  assertWorkerMutationSessionShape(
    identity.host,
    proof.workerSessionId,
    proof.workerSessionGeneration,
  );
  const attempt = await lockAttempt(transaction, identity, attemptId);
  assertAttemptMutationSession(
    identity.host,
    attempt,
    proof.workerSessionId,
    proof.workerSessionGeneration,
  );
  assertActiveLease(
    attempt,
    identity,
    await sha256Hex(proof.leaseToken),
    proof.fence,
  );
  const scope = await sessionToolScope(
    transaction,
    identity.host.organization_id,
    attemptId,
  );
  // An attempt outside a workflow run has no bindings to reach.
  if (scope === null) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return scope;
}

function wireTool(tool: EffectiveMcpTool) {
  return {
    name: tool.name,
    toolName: tool.toolName,
    connectionId: tool.connectionId,
    connectionName: tool.connectionName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.readOnly,
    launchSpec: tool.launchSpec,
  };
}

/** `POST /v1/worker/attempts/{id}/effective-tools`: what the session's gateway lists. */
export async function effectiveToolsRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const proof = await parseContract(context, EffectiveToolsRequestSchema);
  const listed: EffectiveMcpTools = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const scope = await openGatewaySession(
        transaction,
        identity,
        attemptId,
        proof,
      );
      return await effectiveMcpTools(
        transaction,
        identity.host.organization_id,
        scope,
        identity.host.id,
      );
    },
  );
  return jsonResponse({
    tools: listed.tools.map(wireTool),
    unavailable: listed.unavailable,
  }, 200);
}

type CallRow = {
  id: string;
  status: "sent" | "completed" | "failed" | "refused";
  arguments_digest: string;
  result: unknown;
  failure_code: string | null;
  tool_name: string;
};

/** The broker result for a tool's answer: MCP content blocks when it gave some. */
export function brokerResult(toolName: string, output: unknown) {
  const content = output !== null && typeof output === "object" &&
      Array.isArray((output as { content?: unknown }).content)
    ? (output as { content: unknown[] }).content
    : [{ type: "text", text: JSON.stringify(output ?? null) }];
  return { toolName, content, isError: false, fault: null };
}

function failedResult(toolName: string, code: string) {
  return {
    toolName,
    content: [{
      type: "text",
      text: `The tool call failed (${code}).`,
    }],
    isError: true,
    fault: null,
  };
}

async function settle(
  options: ExecutionRouteOptions,
  headers: Headers,
  callId: string,
  outcome: Readonly<
    { status: "completed"; result: unknown } | {
      status: "failed";
      code: string;
    }
  >,
): Promise<void> {
  await workerTransaction(options.database, headers, async (transaction) => {
    await transaction.query(
      `update bakery.tool_gateway_calls
          set status = $2, result = $3::jsonb, failure_code = $4,
              settled_at = now()
        where id = $1 and status = 'sent'`,
      [
        callId,
        outcome.status,
        outcome.status === "completed"
          ? JSON.stringify(outcome.result ?? null)
          : null,
        outcome.status === "failed" ? outcome.code : null,
      ],
    );
  });
}

/** `POST /v1/worker/attempts/{id}/tool-invocations` (`worker.invokeTool`). */
export function createToolInvocationRoute(deps: ToolGatewayDeps) {
  return async function toolInvocationRoute(
    context: Context,
    options: ExecutionRouteOptions,
  ): Promise<Response> {
    const attemptId = readAttemptId(context);
    const input = await parseContract(
      context,
      contractSchemas.BrokerToolInvocation,
    );
    const idempotencyKey = workerIdempotencyUuid(
      context.req.header("Idempotency-Key"),
    );
    const hasMcp = input.mcpConnectionId !== undefined;
    const hasIntegration = input.integrationConnectionId !== undefined;
    if (hasMcp === hasIntegration) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: { reason: "tool_invocation_connection_ambiguous" },
      });
    }
    // Native integration actions reach a session through the same gateway in
    // the design; this route serves MCP connections today and says so.
    if (!hasMcp) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: { reason: "tool_invocation_integration_unsupported" },
      });
    }
    const connectionId = input.mcpConnectionId!;
    const args = input.arguments;
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: { reason: "mcp_arguments_invalid" },
      });
    }
    // The key names one request: the connection, the tool as asked and its
    // arguments. A replay that differs in any of them is another call.
    const argumentsDigest = await sha256Hex(canonicalJson({
      mcpConnectionId: connectionId,
      toolName: input.toolName,
      arguments: args,
    }));
    const headers = context.req.raw.headers;

    const opened = await workerTransaction(
      options.database,
      headers,
      async (transaction, identity) => {
        const organizationId = identity.host.organization_id;
        const scope = await openGatewaySession(
          transaction,
          identity,
          attemptId,
          input,
        );
        const readPrevious = async () =>
          (await transaction.query<CallRow>(
            `select id, status, arguments_digest, result, failure_code, tool_name
               from bakery.tool_gateway_calls
              where organization_id = $1 and attempt_id = $2
                and idempotency_key = $3`,
            [organizationId, attemptId, idempotencyKey],
          )).rows[0];
        const previous = await readPrevious();
        if (previous !== undefined) {
          return { kind: "replay" as const, previous };
        }
        const { tools } = await effectiveMcpTools(
          transaction,
          organizationId,
          scope,
          identity.host.id,
        );
        const tool = tools.find((candidate) =>
          candidate.connectionId === connectionId &&
          (candidate.toolName === input.toolName ||
            candidate.name === input.toolName)
        );
        // A tool the gateway would not list is not callable by naming it.
        if (tool === undefined) {
          throw new StandardError({
            code: "AUTH_FORBIDDEN",
            params: { reason: "tool_not_effective" },
          });
        }
        // A local server is called by the worker that runs it, through the
        // local-tool-calls door; the server's broker cannot reach it.
        if (tool.launchSpec !== null) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { reason: "tool_invocation_local" },
          });
        }
        const inserted = await transaction.query<{ id: string }>(
          `insert into bakery.tool_gateway_calls (
             organization_id, attempt_id, idempotency_key, mcp_connection_id,
             tool_name, snapshot_digest, arguments_digest, read_only, status
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'sent')
           on conflict (organization_id, attempt_id, idempotency_key)
             do nothing
           returning id`,
          [
            organizationId,
            attemptId,
            idempotencyKey,
            connectionId,
            tool.toolName,
            tool.snapshotDigest,
            argumentsDigest,
            tool.readOnly,
          ],
        );
        const callId = inserted.rows[0]?.id;
        if (callId === undefined) {
          // A request with the same key committed its row first: this one is
          // its replay, never a second send. The attempt lock taken above
          // queues same-attempt calls today; this keeps the key safe without
          // relying on that lock.
          const raced = await readPrevious();
          if (raced === undefined) {
            throw new Error(
              "tool_gateway_calls row missing after key conflict",
            );
          }
          return { kind: "replay" as const, previous: raced };
        }
        return {
          kind: "send" as const,
          callId,
          organizationId,
          actorRef: scope.startedByPrincipalId,
          scope,
          tool,
        };
      },
    );

    if (opened.kind === "replay") {
      const previous = opened.previous;
      if (previous.arguments_digest !== argumentsDigest) {
        throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
      }
      if (previous.status === "completed") {
        return jsonResponse(
          brokerResult(previous.tool_name, previous.result),
          200,
          true,
        );
      }
      if (previous.status === "failed" || previous.status === "refused") {
        return jsonResponse(
          failedResult(previous.tool_name, previous.failure_code ?? "failed"),
          200,
          true,
        );
      }
      // Sent and never settled: it may have reached the server. Sending again
      // could do the write twice, so the call waits for a person.
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "tool_call_outcome_unknown" },
      });
    }

    const { tool, scope } = opened;
    const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const result = await invokeMcpTool(deps, {
        organizationId: opened.organizationId,
        actorRef: opened.actorRef,
        connectionId,
        toolName: tool.toolName,
        pinnedDigest: tool.snapshotDigest,
        arguments: args as Record<string, unknown>,
        // The server's own broker sends a remote call; local (stdio) servers
        // launched by the worker are a later slice (25-one-engine.md 15.7 H).
        hostId: null,
        workflowVersionId: scope.workflowVersionId,
        agentVersionId: scope.agentVersionId,
        stepKey: scope.stepKey,
        seatKey: scope.seatKey,
        startedByPrincipalId: scope.startedByPrincipalId,
        signal: timeout,
      });
      await settle(options, headers, opened.callId, {
        status: "completed",
        result: result.output,
      });
      return jsonResponse(brokerResult(tool.toolName, result.output), 200);
    } catch (error) {
      const failure = mcpWriteFailure(error);
      const code = error instanceof StandardError
        ? String(error.params?.reason ?? error.code).toLowerCase()
        : error instanceof McpToolCallError
        ? error.reason
        : "unknown";
      // A read may be sent again safely, so an unclear read is settled as
      // failed. A write that may have arrived stays sent: at most once.
      if (failure.kind === "unknown" && !tool.readOnly) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "tool_call_outcome_unknown" },
        });
      }
      await settle(options, headers, opened.callId, {
        status: "failed",
        code,
      });
      if (error instanceof StandardError) throw error;
      if (error instanceof McpToolCallError) {
        return jsonResponse(failedResult(tool.toolName, code), 200);
      }
      throw error;
    }
  };
}

export const LOCAL_TOOL_CALLS_PATH = "/v1/worker/attempts/:id/local-tool-calls";
export const LOCAL_TOOL_CALL_OUTCOME_PATH =
  "/v1/worker/attempts/:id/local-tool-calls/:callId/outcome";

const leaseProofFields = EffectiveToolsRequestSchema.shape;

/** Opening one call to a local (stdio) tool the worker runs itself (#441). */
export const LocalToolCallOpenSchema = z.strictObject({
  ...leaseProofFields,
  mcpConnectionId: z.uuid().describe(
    "The local MCP connection, placed on the calling worker's host.",
  ),
  toolName: z.string().min(1).max(200).describe(
    "The tool's name as the gateway listed it or as the server named it.",
  ),
  arguments: z.record(
    z.string().describe("One argument's name."),
    z.unknown().describe("One argument's value."),
  ).describe(
    "The call's arguments, checked against the pinned input schema.",
  ),
}).describe(
  "A worker asks to make one local stdio tool call for an attempt's session; the server checks and records it first.",
);

/** The outcome of a local call, once the worker has it. */
export const LocalToolCallOutcomeSchema = z.strictObject({
  ...leaseProofFields,
  status: z.enum(["completed", "failed"]).describe(
    "completed when the local server answered; failed when it did not run or refused.",
  ),
  content: z.array(z.unknown().describe("One MCP content block.")).max(1000)
    .optional().describe("The tool's content blocks, for a completed call."),
  isError: z.boolean().optional().describe(
    "Whether the tool reported a failure, for a completed call.",
  ),
  failureCode: z.string().regex(/^[a-z0-9_]{1,100}$/).optional().describe(
    "Short reason for a failed call, such as stdio_mcp_launch_failed.",
  ),
}).describe(
  "A worker records how one local stdio tool call ended; only a call still sent is settled, once.",
);

const MAX_LOCAL_RESULT_BYTES = 1024 * 1024;

/**
 * `POST /v1/worker/attempts/{id}/local-tool-calls` (#441): the server's half of
 * a call to a local stdio tool. It proves the lease, finds the tool among the
 * session's effective tools on this host, records the call as sent under the
 * Idempotency-Key, and runs the same pinned-tool checks a remote call gets
 * (pin, drift, grant, the arguments against the pinned schema, and that the
 * calling host is the one the connection is placed on). Only then does the
 * worker send it to the process it launched, and report the outcome. A replay
 * answers what happened; a call sent and never settled is not sent again.
 */
export function createLocalToolCallRoute(deps: ToolGatewayDeps) {
  return async function localToolCallRoute(
    context: Context,
    options: ExecutionRouteOptions,
  ): Promise<Response> {
    const attemptId = readAttemptId(context);
    const input = await parseContract(context, LocalToolCallOpenSchema);
    const idempotencyKey = workerIdempotencyUuid(
      context.req.header("Idempotency-Key"),
    );
    const argumentsDigest = await sha256Hex(canonicalJson(input.arguments));
    const headers = context.req.raw.headers;
    const opened = await workerTransaction(
      options.database,
      headers,
      async (transaction, identity) => {
        const organizationId = identity.host.organization_id;
        const scope = await openGatewaySession(
          transaction,
          identity,
          attemptId,
          input,
        );
        const previous = (await transaction.query<CallRow>(
          `select id, status, arguments_digest, result, failure_code, tool_name
             from bakery.tool_gateway_calls
            where organization_id = $1 and attempt_id = $2
              and idempotency_key = $3`,
          [organizationId, attemptId, idempotencyKey],
        )).rows[0];
        if (previous !== undefined) {
          return { kind: "replay" as const, previous };
        }
        const { tools } = await effectiveMcpTools(
          transaction,
          organizationId,
          scope,
          identity.host.id,
        );
        const tool = tools.find((candidate) =>
          candidate.connectionId === input.mcpConnectionId &&
          candidate.launchSpec !== null &&
          (candidate.toolName === input.toolName ||
            candidate.name === input.toolName)
        );
        if (tool === undefined) {
          throw new StandardError({
            code: "AUTH_FORBIDDEN",
            params: { reason: "tool_not_effective" },
          });
        }
        const inserted = await transaction.query<{ id: string }>(
          `insert into bakery.tool_gateway_calls (
             organization_id, attempt_id, idempotency_key, mcp_connection_id,
             tool_name, snapshot_digest, arguments_digest, read_only, status
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'sent')
           returning id`,
          [
            organizationId,
            attemptId,
            idempotencyKey,
            input.mcpConnectionId,
            tool.toolName,
            tool.snapshotDigest,
            argumentsDigest,
            tool.readOnly,
          ],
        );
        return {
          kind: "open" as const,
          callId: inserted.rows[0]!.id,
          organizationId,
          hostId: identity.host.id,
          actorRef: scope.startedByPrincipalId ?? identity.host.principal_id,
          scope,
          tool,
        };
      },
    );
    if (opened.kind === "replay") {
      const previous = opened.previous;
      if (previous.arguments_digest !== argumentsDigest) {
        throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
      }
      if (previous.status === "sent") {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "tool_call_outcome_unknown" },
        });
      }
      return jsonResponse(
        {
          callId: previous.id,
          status: previous.status === "completed" ? "completed" : "failed",
          result: previous.status === "completed"
            ? brokerResult(previous.tool_name, previous.result)
            : failedResult(
              previous.tool_name,
              previous.failure_code ?? "failed",
            ),
        },
        200,
        true,
      );
    }
    const { tool, scope } = opened;
    // The same door a remote call goes through, with a transport that sends
    // nothing: the worker sends the call once every check here has passed.
    try {
      await invokeMcpTool({
        pinnedState: deps.pinnedState,
        transport: { invoke: () => Promise.resolve(null) },
      }, {
        organizationId: opened.organizationId,
        actorRef: opened.actorRef,
        connectionId: input.mcpConnectionId,
        toolName: tool.toolName,
        pinnedDigest: tool.snapshotDigest,
        arguments: input.arguments,
        hostId: opened.hostId,
        workflowVersionId: scope.workflowVersionId,
        agentVersionId: scope.agentVersionId,
        stepKey: scope.stepKey,
        seatKey: scope.seatKey,
        startedByPrincipalId: scope.startedByPrincipalId,
      });
    } catch (error) {
      const code = error instanceof StandardError
        ? String(error.params?.reason ?? error.code).toLowerCase()
        : "unknown";
      await settle(options, headers, opened.callId, { status: "failed", code });
      throw error;
    }
    return jsonResponse({
      callId: opened.callId,
      status: "open",
      result: null,
    }, 200);
  };
}

/**
 * `POST /v1/worker/attempts/{id}/local-tool-calls/{callId}/outcome` (#441): the
 * worker records how a local call ended. Lease-proved like every attempt
 * mutation; only a call of this attempt, on a local connection, still sent, is
 * settled, and only once. A worker that never learned the outcome of a write
 * sends nothing, so the call stays sent for a person to settle.
 */
export async function localToolCallOutcomeRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const callId = z.uuid().safeParse(context.req.param("callId"));
  if (!callId.success) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const input = await parseContract(context, LocalToolCallOutcomeSchema);
  if (
    input.status === "completed"
      ? input.failureCode !== undefined || input.content === undefined
      : input.content !== undefined
  ) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: "local_tool_outcome_invalid" },
    });
  }
  const result = input.status === "completed"
    ? { content: input.content, isError: input.isError === true }
    : null;
  if (
    result !== null &&
    new TextEncoder().encode(JSON.stringify(result)).length >
      MAX_LOCAL_RESULT_BYTES
  ) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: "local_tool_result_too_large" },
    });
  }
  const settled = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      await openGatewaySession(transaction, identity, attemptId, input);
      const updated = await transaction.query<{ tool_name: string }>(
        `update bakery.tool_gateway_calls call
            set status = $4, result = $5::jsonb, failure_code = $6,
                settled_at = now()
           from bakery.mcp_connections connection
          where call.organization_id = $1 and call.attempt_id = $2
            and call.id = $3 and call.status = 'sent'
            and connection.organization_id = call.organization_id
            and connection.id = call.mcp_connection_id
            and connection.worker_host_id = $7
          returning call.tool_name`,
        [
          identity.host.organization_id,
          attemptId,
          callId.data,
          input.status,
          result === null ? null : JSON.stringify(result),
          input.status === "failed" ? (input.failureCode ?? "failed") : null,
          identity.host.id,
        ],
      );
      return updated.rows[0] ?? null;
    },
  );
  if (settled === null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "local_tool_call_not_open" },
    });
  }
  return jsonResponse({ callId: callId.data, status: input.status }, 200);
}
