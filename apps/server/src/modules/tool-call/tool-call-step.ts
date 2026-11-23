import { z } from "zod";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import type {
  ActiveIntegrationRegistry,
  AuthoritySnapshotPort,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import { invokeIntegration } from "../catalog/integration-invoke.ts";
import {
  createEffectExecutor,
  type EffectExecutorDeps,
} from "../effects/index.ts";
import {
  createMcpEffectPort,
  mcpCallWasNotExecuted,
} from "../mcp/effect-port.ts";
import type { ToolCallRecorder } from "./tool-call-record.ts";
import { budgetRefusalReason, type ToolCallCosts } from "./tool-call-cost.ts";
import { invokeMcpTool, type McpInvokeDeps } from "../mcp/invoke.ts";
import { McpToolCallError } from "../mcp/tool-transport.ts";
import {
  type AsyncForm,
  asyncStatusOf,
  handleOf,
  readAsyncForm,
} from "../mcp/async-form.ts";
import { toRunEnvironment } from "../work/run-environment.ts";
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
 * A connection is one of two kinds. A native integration connection is called
 * through the integration door. An MCP server connection is called through the
 * pinned-tool door (`runMcp`): a read directly, a write through the effect ledger
 * (`runMcpWrite`). Neither kind is ever sent through the other's door.
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
  /**
   * What calls an MCP tool: the pinned-state port and the transport that sends the
   * call. Absent, an MCP connection is refused by name.
   */
  mcp?: McpInvokeDeps;
  /**
   * Writes each call to the run's tool feed: once when it first sends, once when
   * it settles. Absent, nothing is recorded (a test that does not read the feed).
   */
  toolCalls?: ToolCallRecorder;
  /**
   * Holds a step's per-call cost ceiling before it sends and ends the hold after.
   * Absent, a step that names a ceiling is refused by name rather than sent
   * unguarded.
   */
  costs?: ToolCallCosts;
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

/**
 * What a call answered, with whether it may have spent money. A failure is
 * taken as spending nothing unless its maker says the call may have reached the
 * server: the ceiling held for it is then charged rather than given back.
 */
type CallResult = EngineStepResult & { mayHaveSpent?: boolean };

function failed(
  code: string,
  message: string,
  mayHaveSpent = false,
): CallResult {
  return { kind: "failed", code, message, mayHaveSpent };
}

/** What the engine is told: the answer without the runner's own note on spending. */
function toStepResult(result: CallResult): EngineStepResult {
  return result.kind === "failed"
    ? { kind: "failed", code: result.code, message: result.message }
    : result;
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
  // The ledger that carries a write to an MCP tool: the same executor an
  // integration write uses, with the MCP port beside the integration registry.
  const mcpExecutor = deps.mcp === undefined
    ? undefined
    : createEffectExecutor({
      database: deps.database,
      registry: deps.registry,
      snapshotsFor: connection.snapshotsFor,
      providerRequests: deps.providerRequests,
      mcp: createMcpEffectPort({ database: deps.database, mcp: deps.mcp }),
      ...deps.effects,
    });

  /**
   * A tool on an MCP connection. The step must have been pinned at publish (the
   * version's binding names the connection, the snapshot digest and this tool);
   * the call goes through the pinned-tool door, which re-checks the grant, the
   * connection and drift, validates the arguments against the pinned schema and
   * sends through the server's broker.
   *
   * A tool an Admin classified as a read is sent directly. Every other tool is a
   * write (a tool with no classification runs at most once) and goes through the
   * effect ledger under the step's one effect key, so a crash or a second look
   * finds the same effect and never sends it twice. Nothing is sent against a
   * classification made for another snapshot than the step pinned.
   */
  async function runMcp(
    request: EngineStepRequest,
    input: { connectionId: string; tool: string; arguments: unknown },
  ): Promise<CallResult> {
    if (deps.mcp === undefined) {
      return failed(
        "TOOL_CALL_MCP_UNAVAILABLE",
        "This server has no MCP tool broker configured.",
      );
    }
    if (
      input.arguments === null || typeof input.arguments !== "object" ||
      Array.isArray(input.arguments)
    ) {
      return failed(
        "TOOL_CALL_INPUT_INVALID",
        "An MCP tool call takes its arguments as an object.",
      );
    }
    // The binding is keyed by the step's id from the root; the run's step key
    // also carries an @n for every enclosing repeat round.
    const stepKey = request.stepKey.replace(/@\d+/g, "");
    const facts = await withPgTransaction(deps.database, async (tx) => {
      const run = await tx.query<
        { workflow_version_id: string | null; environment: string }
      >(
        `select workflow_version_id, environment from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [request.organizationId, request.runId],
      );
      const versionId = run.rows[0]?.workflow_version_id ?? null;
      if (versionId === null) return null;
      const environment = toRunEnvironment(run.rows[0]?.environment);
      const pin = await tx.query<{ digest: string; allowed: unknown }>(
        `select mcp_snapshot_digest as digest,
                allowed_operations as allowed
           from bakery.capability_bindings
          where organization_id = $1 and workflow_version_id = $2
            and step_key = $3 and mcp_connection_id = $4
          limit 1`,
        [request.organizationId, versionId, stepKey, input.connectionId],
      );
      if (pin.rows[0] === undefined) return null;
      const effect = await tx.query<{
        effect_class: string;
        effect_key_argument: string | null;
        paired_read_tool: string | null;
        async_form: unknown;
        digest: string;
      }>(
        `select effect_class, effect_key_argument, paired_read_tool,
                async_form, snapshot_digest as digest
           from bakery.mcp_tool_classifications
          where organization_id = $1 and connection_id = $2 and tool_name = $3`,
        [request.organizationId, input.connectionId, input.tool],
      );
      const step = await tx.query<{ id: string }>(
        `select id from bakery.run_steps
          where organization_id = $1 and run_id = $2 and step_key = $3
            and iteration = $4`,
        [
          request.organizationId,
          request.runId,
          request.stepKey,
          request.iteration,
        ],
      );
      return {
        versionId,
        environment,
        pinnedDigest: pin.rows[0].digest,
        allowed: Array.isArray(pin.rows[0].allowed)
          ? pin.rows[0].allowed as unknown[]
          : [],
        effectClass: effect.rows[0]?.effect_class ?? null,
        keyArgument: effect.rows[0]?.effect_key_argument ?? null,
        pairedRead: effect.rows[0]?.paired_read_tool ?? null,
        asyncFormValue: effect.rows[0]?.async_form ?? null,
        classifiedAgainst: effect.rows[0]?.digest ?? null,
        runStepId: step.rows[0]?.id ?? null,
      };
    });
    if (facts === null) {
      return failed(
        "TOOL_CALL_MCP_NOT_PINNED",
        "This step was not pinned to an MCP tool when its version was published.",
      );
    }
    if (
      facts.classifiedAgainst !== null &&
      facts.classifiedAgainst !== facts.pinnedDigest
    ) {
      return failed(
        "TOOL_CALL_MCP_CLASSIFICATION_STALE",
        "The tool was classified against a different snapshot than the step pinned.",
      );
    }
    // An offline run may reach nothing outside (#427), so no tool of an MCP
    // server is sent from it, read or write.
    if (facts.environment !== "live") {
      return failed(
        "TOOL_CALL_MCP_OFFLINE",
        "This run is offline, so it cannot call a tool on an MCP server.",
      );
    }
    const asArguments = input.arguments as Record<string, unknown>;
    if (facts.effectClass !== "read") {
      // A declaration that cannot be read back is never guessed at: the call is
      // refused before anything is sent.
      let asyncForm: AsyncForm | null = null;
      try {
        asyncForm = readAsyncForm(facts.asyncFormValue);
      } catch {
        return failed(
          "TOOL_CALL_MCP_ASYNC_FORM_INVALID",
          "The Admin's asynchronous declaration for this tool cannot be read, so nothing was sent.",
        );
      }
      return await runMcpWrite(request, input.connectionId, input.tool, {
        arguments: asArguments,
        pinnedDigest: facts.pinnedDigest,
        effectClass: facts.effectClass,
        keyArgument: facts.keyArgument,
        pairedRead: facts.pairedRead,
        allowed: facts.allowed,
        runStepId: facts.runStepId,
        asyncForm,
        versionId: facts.versionId,
        stepKey,
      });
    }
    try {
      const result = await invokeMcpTool(deps.mcp, {
        organizationId: request.organizationId,
        actorRef: request.requestedBy,
        connectionId: input.connectionId,
        toolName: input.tool,
        pinnedDigest: facts.pinnedDigest,
        arguments: asArguments,
        hostId: null,
        workflowVersionId: facts.versionId,
        stepKey,
        startedByPrincipalId: request.requestedBy,
      });
      return {
        kind: "completed",
        output: actionResultSchema().parse({
          accepted: true,
          operation: result.toolName,
          externalEffectId: null,
          result: result.output ?? null,
        }),
      };
    } catch (error) {
      if (error instanceof McpToolCallError) {
        return failed(
          `TOOL_CALL_MCP_${error.reason.toUpperCase()}`,
          "The MCP server did not give a usable answer.",
          // A call that may have reached the server is charged its ceiling.
          !mcpCallWasNotExecuted(error.reason),
        );
      }
      if (!(error instanceof StandardError)) throw error;
      return failed(
        `TOOL_CALL_MCP_REFUSED_${refusalCode(error).toUpperCase()}`,
        "The call was refused before anything was sent.",
      );
    }
  }

  /**
   * One look at an asynchronous tool's job (#439): the paired read, given the
   * handle the submit answered with, says whether it is done, failed or still
   * running. The submit is in the ledger under the step's one effect key, so a
   * look never submits again; only this read is sent, and a read is safe to
   * repeat. A job that is still running leaves the step pending, to be looked at
   * again after the Admin's interval, and the step's own wait limit bounds how
   * long. A job the server accepted may have spent money, so its failure is
   * charged the ceiling like any call that may have run.
   */
  async function followJob(
    request: EngineStepRequest,
    connectionId: string,
    tool: string,
    write: Readonly<{
      pinnedDigest: string;
      pairedRead: string | null;
      asyncForm: AsyncForm | null;
      versionId: string;
      stepKey: string;
    }>,
    submit: Readonly<{ remoteId: string | null; submitted: unknown }>,
  ): Promise<CallResult> {
    const form = write.asyncForm;
    if (form === null || write.pairedRead === null || deps.mcp === undefined) {
      return failed(
        "TOOL_CALL_ASYNC_UNAVAILABLE",
        "The job was accepted but this server cannot read its status.",
        true,
      );
    }
    const handle = handleOf(submit.submitted, form.handlePath);
    if (handle === null) {
      return failed(
        "TOOL_CALL_ASYNC_HANDLE_MISSING",
        "The tool accepted the job but its answer carries no handle where the Admin said it would.",
        true,
      );
    }
    try {
      const status = await invokeMcpTool(deps.mcp, {
        organizationId: request.organizationId,
        actorRef: request.requestedBy,
        connectionId,
        toolName: write.pairedRead,
        pinnedDigest: write.pinnedDigest,
        arguments: { [form.handleArgument]: handle },
        hostId: null,
        workflowVersionId: write.versionId,
        stepKey: write.stepKey,
        startedByPrincipalId: request.requestedBy,
      });
      switch (asyncStatusOf(status.output, form)) {
        case "done":
          return {
            kind: "completed",
            output: actionResultSchema().parse({
              accepted: true,
              operation: tool,
              externalEffectId: submit.remoteId,
              result: status.output ?? null,
            }),
          };
        case "failed":
          return failed(
            "TOOL_CALL_ASYNC_FAILED",
            "The job reported that it failed.",
            true,
          );
        default:
          return { kind: "pending", retryAfterMs: form.pollEveryMs };
      }
    } catch (error) {
      // The server did not answer this look: a read is safe to repeat, so the
      // step waits and looks again rather than failing a job that may be fine.
      if (error instanceof McpToolCallError) {
        return { kind: "pending", retryAfterMs: form.pollEveryMs };
      }
      if (!(error instanceof StandardError)) throw error;
      return failed(
        `TOOL_CALL_MCP_REFUSED_${refusalCode(error).toUpperCase()}`,
        "The read of the job's status was refused.",
        true,
      );
    }
  }

  /**
   * A write to an MCP tool, through the ledger. The ledger row is the step's one
   * effect key; what an unproven send means depends on the Admin's class (see
   * `dispatchMcpEffect`). An unclassified tool is treated as opaque.
   */
  async function runMcpWrite(
    request: EngineStepRequest,
    connectionId: string,
    tool: string,
    write: Readonly<{
      arguments: Record<string, unknown>;
      pinnedDigest: string;
      effectClass: string | null;
      keyArgument: string | null;
      pairedRead: string | null;
      allowed: readonly unknown[];
      runStepId: string | null;
      /** How a job is followed, when the Admin declared the tool asynchronous. */
      asyncForm: AsyncForm | null;
      versionId: string;
      /** The step's key without the round marks, as its binding is keyed. */
      stepKey: string;
    }>,
  ): Promise<CallResult> {
    if (mcpExecutor === undefined) {
      return failed(
        "TOOL_CALL_MCP_UNAVAILABLE",
        "This server has no MCP tool broker configured.",
      );
    }
    if (write.runStepId === null) {
      return failed(
        "TOOL_CALL_MCP_STEP_UNKNOWN",
        "The run has no step row for this call, so its write cannot be recorded.",
      );
    }
    // A write that could not be confirmed later is not sent: the binding must
    // admit the read the Admin paired with it.
    if (
      write.effectClass === "write_reconcilable" &&
      (write.pairedRead === null || !write.allowed.includes(write.pairedRead))
    ) {
      return failed(
        "TOOL_CALL_MCP_RECONCILE_UNPINNED",
        "The read paired with this write is not pinned to the step, so an unproven write could not be confirmed.",
      );
    }
    const key = toolCallEffectKey(request);
    // A tool that takes an effect key gets the step's one key unless the
    // workflow named a value itself: the same key on every look is what makes a
    // second send safe.
    const args = write.effectClass === "write_idempotent" &&
        write.keyArgument !== null &&
        write.arguments[write.keyArgument] === undefined
      ? { ...write.arguments, [write.keyArgument]: key }
      : write.arguments;
    try {
      const prepared = await mcpExecutor.prepareMcpEffect({
        organizationId: request.organizationId,
        actorRef: request.requestedBy,
        requestingPrincipalId: request.requestedBy,
        connectionId,
        tool,
        snapshotDigest: write.pinnedDigest,
        arguments: args,
        idempotencyKey: key,
        runStepId: write.runStepId,
      });
      const ran = await mcpExecutor.runEffect({
        organizationId: request.organizationId,
        effectId: prepared.effectId,
        requestId: request.traceId,
        traceId: request.traceId,
      });
      switch (ran.outcome) {
        case "confirmed":
          // An asynchronous tool is confirmed when it accepted the job; the job
          // itself is followed by reading its status, once a look.
          if (write.asyncForm !== null) {
            return await followJob(request, connectionId, tool, write, {
              remoteId: ran.effect.remoteId,
              submitted: ran.effect.safeResult,
            });
          }
          return {
            kind: "completed",
            output: actionResultSchema().parse({
              accepted: true,
              operation: tool,
              externalEffectId: ran.effect.remoteId,
              result: ran.effect.safeResult ?? null,
            }),
          };
        case "failed":
          return failed(
            "TOOL_CALL_EFFECT_FAILED",
            `The MCP server did not take the write (${
              ran.effect.failureCode ?? "refused"
            }).`,
          );
        default:
          // In flight, uncertain or scheduled for another try: the engine looks
          // again and the same key reconciles it. An opaque write whose outcome
          // is unknown stays here until a person settles it.
          return { kind: "pending" };
      }
    } catch (error) {
      if (!(error instanceof StandardError)) throw error;
      return failed(
        `TOOL_CALL_MCP_REFUSED_${refusalCode(error).toUpperCase()}`,
        "The write was refused before anything was sent.",
      );
    }
  }

  /**
   * Holds the step's per-call cost ceiling, when it names one, and answers with
   * the failure that stops the call, or null when the call may go ahead. A step
   * with a ceiling is never sent without a hold: no budget configured, or an
   * account that cannot cover it, refuses the step before anything is sent.
   */
  async function hold(request: EngineStepRequest): Promise<CallResult | null> {
    const ceiling = request.costCeilingUsd;
    if (ceiling === null) return null;
    if (deps.costs === undefined) {
      return failed(
        "TOOL_CALL_COST_UNAVAILABLE",
        "This server has no budget configured to hold a per-call cost ceiling.",
      );
    }
    try {
      await deps.costs.reserve({
        organizationId: request.organizationId,
        runId: request.runId,
        runStepId: request.runStepId,
        callId: toolCallEffectKey(request),
        ceilingUsd: ceiling,
      });
      return null;
    } catch (error) {
      const reason = budgetRefusalReason(error);
      if (reason === null) throw error;
      return failed(
        "TOOL_CALL_BUDGET_EXCEEDED",
        "The run's or the installation's budget cannot cover this call's cost ceiling, so nothing was sent.",
      );
    }
  }

  /** Ends the hold once the call's answer is known; a step still waiting keeps it. */
  async function endHold(
    request: EngineStepRequest,
    result: CallResult,
  ): Promise<void> {
    if (request.costCeilingUsd === null || deps.costs === undefined) return;
    if (result.kind === "pending") return;
    await deps.costs.finish({
      organizationId: request.organizationId,
      runStepId: request.runStepId,
      callId: toolCallEffectKey(request),
      outcome: result.kind === "failed" && result.mayHaveSpent !== true
        ? "release"
        : "settle",
    });
  }

  async function run(request: EngineStepRequest): Promise<EngineStepResult> {
    const parsed = contractSchemas.ToolCallInput.safeParse(request.input);
    if (!parsed.success) {
      return failed(
        "TOOL_CALL_INPUT_INVALID",
        "The step input does not match the tool call contract.",
      );
    }
    const input = parsed.data;
    const record = deps.toolCalls;
    const call = {
      organizationId: request.organizationId,
      runId: request.runId,
      stepKey: request.stepKey,
      iteration: request.iteration,
      callId: toolCallEffectKey(request),
      connectionId: input.connectionId,
      toolName: input.tool,
    };
    // A look at a step whose write is unproven finds its started record and
    // adds none; only a settled call adds its second.
    if (record !== undefined) await record({ ...call, phase: "started" });
    const refused = await hold(request);
    const result = refused ?? await dispatch(request, input);
    // A refused hold never held anything, so there is nothing to end.
    if (refused === null) await endHold(request, result);
    if (record !== undefined) {
      if (result.kind === "completed") {
        await record({ ...call, phase: "completed" });
      } else if (result.kind === "failed") {
        await record({ ...call, phase: "failed", failureCode: result.code });
      }
    }
    return result;
  }

  async function dispatch(
    request: EngineStepRequest,
    input: z.output<typeof contractSchemas.ToolCallInput>,
  ): Promise<CallResult> {
    const kind = await kindOf(request.organizationId, input.connectionId);
    if (kind === null) {
      return failed(
        "TOOL_CALL_CONNECTION_NOT_FOUND",
        "The organization has no connection with that id.",
      );
    }
    if (kind === "mcp") return await runMcp(request, input);
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
    async abandon(request) {
      // The engine gave up on a step that was still waiting: whether its write
      // ran is not known, so the ceiling is charged, never given back.
      if (request.costCeilingUsd === null || deps.costs === undefined) return;
      await deps.costs.finish({
        organizationId: request.organizationId,
        runStepId: request.runStepId,
        callId: toolCallEffectKey(request),
        outcome: "settle",
      });
    },
    async run(request) {
      if (request.action !== TOOL_CALL_ACTION) {
        return toStepResult(
          failed(
            "TOOL_CALL_ACTION_UNKNOWN",
            "This runner does not own that action.",
          ),
        );
      }
      return toStepResult(await run(request));
    },
  };
}
