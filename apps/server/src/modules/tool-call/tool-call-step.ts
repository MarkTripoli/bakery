import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import type {
  ActiveIntegrationRegistry,
  AuthoritySnapshotPort,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import { invokeIntegration } from "../catalog/integration-invoke.ts";
import type { EffectExecutorDeps } from "../effects/index.ts";
import {
  connectionInvokeDeps,
  toConnectionInvokeResponse,
} from "../integrations/invoke.ts";
import type {
  EngineStepRequest,
  EngineStepResult,
  EngineStepRunner,
} from "../workflow-adapter/engine-steps.ts";

/**
 * The `tool.call` step (#435, docs/technical-design/25-one-engine.md 15.4): one
 * deterministic call of one pinned tool on a connection, with no agent. The
 * engine settles it in its own admission, as it settles a delivery step, so no
 * worker host is involved and the call runs as the person who started the run.
 *
 * One effect key runs end to end: the step key `<runId>:<stepKey>:<iteration>`
 * names the send to the effect ledger, so a step replayed after a crash finds
 * its own effect and reconciles it instead of sending twice. A read returns at
 * once. A write completes the step only when its effect is confirmed; while the
 * outcome is not known the step stays pending and is looked at again, and an
 * effect that failed fails the step with a fixed code. Nothing here retries a
 * send itself.
 *
 * This runner calls native integration connections. A connection that is an MCP
 * server is refused by name until its call path lands, never sent through the
 * integration door.
 */

/** The kind a connection id resolves to, or null when the organization has no such connection. */
export type ToolConnectionKind = "integration" | "mcp";

export type ToolCallStepDeps = Readonly<{
  database: PgDatabase;
  registry: ActiveIntegrationRegistry;
  providerRequests: ProviderRequestPort;
  /** Reads authority from here instead of the database. For tests that fake the authority. */
  snapshots?: AuthoritySnapshotPort;
  /** Lease, deadline and generation bounds of the effect ledger; the defaults unless a test narrows them. */
  effects?: Partial<
    Pick<
      EffectExecutorDeps,
      "leaseSeconds" | "deadlineMs" | "maxDispatchGenerations"
    >
  >;
  /** Finds which kind of connection an id names. Defaults to the connection tables. */
  connectionKind?: (
    organizationId: string,
    connectionId: string,
  ) => Promise<ToolConnectionKind | null>;
}>;

export const TOOL_CALL_ACTION = "tool.call";

/** The idempotency key of one step: the step's own identity, stricter than any author-supplied key. */
export function toolCallEffectKey(
  request: Readonly<{ runId: string; stepKey: string; iteration: number }>,
): string {
  return `${request.runId}:${request.stepKey}:${request.iteration}`;
}

function failed(code: string, message: string): EngineStepResult {
  return { kind: "failed", code, message };
}

/** The reason a refusal carries, when it is a fixed lower-case token; otherwise the error code. */
function refusalCode(error: StandardError): string {
  const reason = error.params?.reason;
  return typeof reason === "string" && /^[a-z_]+$/.test(reason)
    ? reason
    : String(error.code).toLowerCase();
}

function postgresConnectionKind(
  database: PgDatabase,
): NonNullable<ToolCallStepDeps["connectionKind"]> {
  return (organizationId, connectionId) =>
    withPgTransaction(database, async (transaction) => {
      const integration = await transaction.query(
        `select 1 from bakery.integration_connections
          where organization_id = $1 and id = $2`,
        [organizationId, connectionId],
      );
      if (integration.rows.length > 0) return "integration" as const;
      const mcp = await transaction.query(
        `select 1 from bakery.mcp_connections
          where organization_id = $1 and id = $2`,
        [organizationId, connectionId],
      );
      return mcp.rows.length > 0 ? "mcp" as const : null;
    });
}

function actionResultSchema(): { parse(value: unknown): unknown } {
  const schema = (contractSchemas as unknown as Record<
    string,
    { parse(value: unknown): unknown } | undefined
  >).ActionResult;
  if (schema === undefined) throw new StandardError({ code: "INTERNAL" });
  return schema;
}

export function createToolCallStepRunner(
  deps: ToolCallStepDeps,
): EngineStepRunner {
  const connection = connectionInvokeDeps(deps.registry, deps.providerRequests);
  const kindOf = deps.connectionKind ?? postgresConnectionKind(deps.database);

  async function run(request: EngineStepRequest): Promise<EngineStepResult> {
    const parsed = contractSchemas.ToolCallInput.safeParse(request.input);
    if (!parsed.success) {
      return failed(
        "TOOL_CALL_INPUT_INVALID",
        "The step input does not match the tool call contract.",
      );
    }
    const input = parsed.data;
    const kind = await kindOf(request.organizationId, input.connectionId);
    if (kind === null) {
      return failed(
        "TOOL_CALL_CONNECTION_NOT_FOUND",
        "The organization has no connection with that id.",
      );
    }
    if (kind === "mcp") {
      return failed(
        "TOOL_CALL_MCP_UNAVAILABLE",
        "Calling a tool on an MCP connection is not available yet.",
      );
    }
    if (input.toolVersion === undefined || input.resourceId === undefined) {
      return failed(
        "TOOL_CALL_INPUT_INVALID",
        "An integration tool call names the pinned tool version and the resource.",
      );
    }
    const snapshots = deps.snapshots ?? {
      load: (snapshotKey) =>
        withPgTransaction(
          deps.database,
          (transaction) =>
            connection.snapshotsFor(transaction).load(snapshotKey),
        ),
    };
    const snapshotsFor = deps.snapshots === undefined
      ? connection.snapshotsFor
      : () => deps.snapshots!;
    try {
      const result = await invokeIntegration({
        database: deps.database,
        registry: deps.registry,
        snapshotsFor,
        providerRequests: deps.providerRequests,
        snapshots,
        ...deps.effects,
      }, {
        organizationId: request.organizationId,
        actorRef: request.requestedBy,
        connectionId: input.connectionId,
        input: {
          actionId: input.tool,
          actionVersion: input.toolVersion,
          resourceId: input.resourceId,
          arguments: input.arguments,
        },
        idempotencyKey: toolCallEffectKey(request),
        traceId: request.traceId,
      });
      if (result.route === "ledger") {
        switch (result.run.outcome) {
          case "confirmed":
            break;
          case "failed":
            return failed(
              "TOOL_CALL_EFFECT_FAILED",
              "The provider did not accept the write.",
            );
          default:
            // In flight, uncertain or scheduled for another try: the engine
            // looks again and the same key reconciles it.
            return { kind: "pending" };
        }
      }
      return {
        kind: "completed",
        output: actionResultSchema().parse(toConnectionInvokeResponse(result)),
      };
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      if (error.code === "UNPROCESSABLE") {
        return failed(
          "TOOL_CALL_ARGUMENTS_REFUSED",
          "The call was refused before anything was sent: the tool or its arguments are not valid.",
        );
      }
      return failed(
        `TOOL_CALL_REFUSED_${refusalCode(error).toUpperCase()}`,
        "The connection refused the call.",
      );
    }
  }

  return {
    handles: (action) => action === TOOL_CALL_ACTION,
    run(request) {
      if (request.action !== TOOL_CALL_ACTION) {
        return Promise.resolve(
          failed(
            "TOOL_CALL_ACTION_UNKNOWN",
            "This runner does not own that action.",
          ),
        );
      }
      return run(request);
    },
  };
}
