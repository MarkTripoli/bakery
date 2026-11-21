import { StandardError } from "@bakery/contracts/http";
import {
  mcpHostEligible,
  type McpInvocationDenial,
  type McpInvocationInput,
  McpInvocationInputSchema,
  type McpTransport,
} from "@bakery/contracts/mcp-capabilities";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";

/**
 * Invoking a pinned external MCP tool (issue #20, criterion 1).
 *
 * The rule this file enforces is that a grant is fixed at bind time and
 * rechecked at invoke time: nothing about a connection's current state is
 * trusted to still be what it was when the operator bound it. Three things can
 * change underneath a pinned binding - the remote server's schema, the
 * connection's status, and the grant itself - and each one is refused by name
 * rather than dispatched hopefully.
 *
 * Refusal is the only outcome of a failed check. There is deliberately no
 * "resolve again and retry" branch: a drift that silently re-pins would let a
 * server widen its own authority by changing what it advertises, which is the
 * exact failure the fixed grant exists to prevent.
 */

/** What the invoke path needs to know, read fresh at invoke time. */
export type McpPinnedState = Readonly<{
  /** Status of the connection right now, not when it was bound. */
  connectionStatus: "enabled" | "disabled" | "degraded" | "revoked";
  /**
   * The snapshot pinned by the binding, or null when the binding pinned
   * nothing - a connection that has never had a successful discovery.
   */
  pinnedSnapshot:
    | Readonly<{
      id: string;
      digest: string;
      /** Tool names in the pinned snapshot, so a new tool cannot be invoked. */
      toolNames: readonly string[];
    }>
    | null;
  /** The snapshot the connection currently points at, or null if none. */
  currentSnapshot:
    | Readonly<{
      id: string;
      digest: string;
    }>
    | null;
  /** Whether a live grant still covers this connection for this actor. */
  grantLive: boolean;
  /** Names in `enabled_capabilities`: what an operator actually permitted. */
  enabledCapabilities: readonly string[];
  /** The connection's transport: `stdio` is not portable across hosts. */
  transport: McpTransport;
  /** The worker host a `stdio` connection is bound to, if any. */
  workerHostId: string | null;
  /** Operations the caller's binding admits; empty admits nothing. */
  allowedOperations: readonly string[];
  /** Whether the host dispatching this call may currently run MCP work. */
  dispatchingHostEligible: boolean;
  /**
   * Set for a personal connection (O27): who it belongs to, and whether its owner
   * has granted the workflow this call is made for. Absent or null is an
   * organization connection.
   */
  personal?:
    | Readonly<{ ownerPrincipalId: string; useGrantLive: boolean }>
    | null;
}>;

/** Reads the pinned state for one invocation. Server-side; never caller-supplied. */
export type McpPinnedStatePort = {
  load(input: {
    organizationId: string;
    connectionId: string;
    actorRef: string;
    /**
     * The host dispatching this call. Its eligibility is read from the host's
     * own row inside the store; the caller only says which host it is.
     */
    hostId: string;
    /**
     * The ownership the caller is invoking as. A binding owned by a different
     * workflow, agent, step, repository, skill version or automation version
     * must not match, so every slot is part of the read rather than something
     * the check layer could forget to apply.
     */
    workflowVersionId?: string | null;
    agentVersionId?: string | null;
    stepKey?: string | null;
    repositoryId?: string | null;
    skillVersionOwnerId?: string | null;
    automationVersionId?: string | null;
    /** The person who started the run, or null when none did. */
    startedByPrincipalId?: string | null;
  }): Promise<McpPinnedState | null>;
};

/** The transport that actually sends the call once the checks pass. */
export type McpToolTransport = {
  invoke(input: {
    connectionId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
};

export type McpInvokeDeps = Readonly<{
  pinnedState: McpPinnedStatePort;
  transport: McpToolTransport;
}>;

export type McpInvokeInput =
  & McpInvocationInput
  & Readonly<{
    organizationId: string;
    actorRef: string;
    /**
     * The worker host dispatching this call. Only the dispatch path knows which
     * host it is, so it is supplied; whether that host may run MCP work is NOT
     * taken from the caller and is read from `worker_hosts` instead.
     */
    hostId: string;
    /**
     * The ownership the call is made for, when it is made for one. A binding
     * owned by a different workflow, agent, step, repository, skill version or
     * automation version does not match, which is why these travel with the call
     * rather than being looked up later. Omitted means "owned by nothing", so a
     * binding that names an owner cannot serve an unowned caller.
     */
    workflowVersionId?: string | null;
    agentVersionId?: string | null;
    stepKey?: string | null;
    repositoryId?: string | null;
    skillVersionOwnerId?: string | null;
    automationVersionId?: string | null;
    /**
     * The person who started the run this call belongs to. Absent or null means no
     * person did (a schedule, a webhook, an automation), and a personal connection
     * is refused for that: it acts as its owner, and nobody is there to answer for
     * it. An organization connection does not read this.
     */
    startedByPrincipalId?: string | null;
  }>;

export type McpInvokeResult = Readonly<{
  toolName: string;
  output: unknown;
  /** The digest the call ran against, recorded so an audit can tie it to a snapshot. */
  digest: string;
  /**
   * Whom the call acted for: the owner of a personal connection, so the feed and
   * the audit can say so, or null for an organization connection.
   */
  actingForPrincipalId: string | null;
}>;

/**
 * A refusal, as a StandardError the routes and Bakery's own MCP transport can
 * both serialise. The code names the check, so an operator fixing it knows
 * whether to re-authorize, re-bind or change hosts.
 */
export function mcpInvocationRefusal(
  denial: McpInvocationDenial,
  detail: string,
): StandardError {
  return new StandardError({
    code: "STATE_CONFLICT",
    detail,
    params: { reason: denial },
  });
}

/**
 * Whether a binding's operation list admits this tool.
 *
 * The list holds tool names and the wildcard `*`. Matching is exact rather than
 * prefix-based: a tool called `search_admin` must not be admitted by a grant for
 * `search`, because that is how a narrow grant silently widens.
 */
export function operationAllowed(
  toolName: string,
  allowedOperations: readonly string[],
): boolean {
  if (allowedOperations.includes("*")) return true;
  return allowedOperations.includes(toolName);
}

/**
 * Decide, from state read at invoke time, whether this call may proceed.
 *
 * Pure and total: every branch that is not an explicit pass becomes a named
 * denial. Written as one function so the order of checks is one readable list
 * rather than a set of early returns scattered through the transport.
 */
export function mcpInvocationDenial(
  input: Pick<
    McpInvokeInput,
    "toolName" | "pinnedDigest" | "hostId" | "startedByPrincipalId"
  >,
  state: McpPinnedState,
): { denial: McpInvocationDenial; detail: string } | null {
  // A revoked or disabled connection is refused before anything else: the
  // operator's last word on the connection outranks every other check.
  if (state.connectionStatus === "revoked") {
    return {
      denial: "connection_revoked",
      detail: "The MCP connection was revoked; bind a live connection.",
    };
  }
  if (state.connectionStatus !== "enabled") {
    // `disabled` and `degraded` are both unavailable, and both are refused
    // here rather than being reported as drift, so the operator is not sent
    // looking for a schema change that did not happen.
    return {
      denial: "connection_revoked",
      detail: `The MCP connection is ${state.connectionStatus}, not enabled.`,
    };
  }
  // A personal connection acts as its owner (O27). It is never used without a
  // person behind the run, and a run someone else started needs the owner's
  // explicit grant to this workflow.
  if (state.personal) {
    if (!input.startedByPrincipalId) {
      return {
        denial: "personal_unattended",
        detail: "A personal connection is not used by a run no person started.",
      };
    }
    if (
      input.startedByPrincipalId !== state.personal.ownerPrincipalId &&
      !state.personal.useGrantLive
    ) {
      return {
        denial: "personal_use_not_granted",
        detail:
          "The owner of this personal connection has not granted it to this workflow.",
      };
    }
  }
  if (!state.grantLive) {
    return {
      denial: "grant_revoked",
      detail: "The grant covering this connection is no longer live.",
    };
  }
  // A binding admits a named set of operations. An empty or non-matching list
  // admits nothing: "the grant exists" is not "this tool is granted".
  if (!operationAllowed(input.toolName, state.allowedOperations)) {
    return {
      denial: "grant_revoked",
      detail: "The caller's grant does not admit this operation.",
    };
  }
  // A `stdio` server runs in a process on one worker host. Dispatching it from
  // any other host - or from a host that cannot run MCP work - would reach
  // nothing, so it is refused rather than attempted.
  if (
    !mcpHostEligible(
      { transport: state.transport, boundHostId: state.workerHostId },
      {
        hostId: input.hostId,
        eligible: state.dispatchingHostEligible,
      },
    )
  ) {
    return {
      denial: "host_ineligible",
      detail: state.transport === "stdio" && state.workerHostId === null
        ? "This stdio connection names no host, so it cannot be dispatched anywhere."
        : "This connection cannot run on the host dispatching the call.",
    };
  }
  if (state.pinnedSnapshot === null) {
    return {
      denial: "snapshot_missing",
      detail: "This binding pins no capability snapshot; discover first.",
    };
  }
  // A tool the binding did not enable cannot be reached by naming it. This is
  // checked against the operator's list, not the server's, so a server adding
  // a tool cannot make it invocable.
  if (!state.enabledCapabilities.includes(input.toolName)) {
    return {
      denial: "capability_not_bound",
      detail: "That tool is not in this connection's enabled capabilities.",
    };
  }
  if (!state.pinnedSnapshot.toolNames.includes(input.toolName)) {
    return {
      denial: "schema_drift",
      detail: "The pinned snapshot does not contain that tool.",
    };
  }
  // The two digests answer different questions. `pinnedDigest` is what the
  // caller believes it is calling against, so a caller holding a stale copy is
  // refused. `currentSnapshot.digest` is what the server now advertises, so a
  // remote change is refused even when the caller's copy is the one it pinned.
  if (state.pinnedSnapshot.digest !== input.pinnedDigest) {
    return {
      denial: "schema_drift",
      detail:
        "The invocation's pinned digest does not match the bound snapshot.",
    };
  }
  // A binding whose snapshot is not the connection's current one is drift, and
  // no current snapshot at all is worse: nothing can be compared, and treating
  // that as "no drift" would let an unverifiable call through.
  if (state.currentSnapshot === null) {
    return {
      denial: "schema_drift",
      detail:
        "The connection has no current snapshot, so drift cannot be ruled out.",
    };
  }
  if (state.currentSnapshot.digest !== state.pinnedSnapshot.digest) {
    return {
      denial: "schema_drift",
      detail:
        "The remote server's schema changed since this snapshot was pinned.",
    };
  }
  return null;
}

/**
 * Invoke one pinned MCP tool.
 *
 * Reads state through the port, refuses by name when any check fails, and only
 * then reaches the transport. The digest that ran is returned so the caller can
 * record which snapshot a successful call was made against.
 */
export async function invokeMcpTool(
  deps: McpInvokeDeps,
  rawInput: McpInvokeInput,
): Promise<McpInvokeResult> {
  const parsed = McpInvocationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      detail: "invalid MCP invocation input",
      params: { reason: "invalid_mcp_invocation_input" },
    });
  }
  // The contract schema covers only what travels on the wire, so the caller
  // context parsed alongside it is merged back here rather than being dropped.
  const input = {
    ...parsed.data,
    hostId: rawInput.hostId,
    startedByPrincipalId: rawInput.startedByPrincipalId ?? null,
  };

  const state = await deps.pinnedState.load({
    organizationId: rawInput.organizationId,
    connectionId: input.connectionId,
    actorRef: rawInput.actorRef,
    hostId: rawInput.hostId,
    workflowVersionId: rawInput.workflowVersionId ?? null,
    agentVersionId: rawInput.agentVersionId ?? null,
    stepKey: rawInput.stepKey ?? null,
    // Every owner slot is passed, not just the three the first version carried:
    // a binding owned by a repository, skill version or automation version names
    // an owner, and omitting its slot would let it serve an unowned caller.
    repositoryId: rawInput.repositoryId ?? null,
    skillVersionOwnerId: rawInput.skillVersionOwnerId ?? null,
    automationVersionId: rawInput.automationVersionId ?? null,
    startedByPrincipalId: rawInput.startedByPrincipalId ?? null,
  });
  if (state === null) {
    // An unknown connection is a denial, not an empty pass. Falling through to
    // the transport here would invoke a server nobody granted.
    throw mcpInvocationRefusal(
      "connection_revoked",
      "The MCP connection is not available to this actor.",
    );
  }

  const denial = mcpInvocationDenial(input, state);
  if (denial !== null) {
    throw mcpInvocationRefusal(denial.denial, denial.detail);
  }

  const output = await deps.transport.invoke({
    connectionId: input.connectionId,
    toolName: input.toolName,
    arguments: input.arguments,
  });
  return {
    toolName: input.toolName,
    output,
    // Safe by construction: `mcpInvocationDenial` above returned null only
    // after establishing a pinned snapshot exists.
    digest: state.pinnedSnapshot!.digest,
    actingForPrincipalId: state.personal?.ownerPrincipalId ?? null,
  };
}

/**
 * Digest a manifest the way a binding pins it.
 *
 * Re-exported so a caller rechecking a live server compares with the same
 * canonical form the snapshot used; a second implementation here would be a
 * drift detector that disagrees with itself.
 */
export async function mcpManifestDigest(manifest: {
  protocolVersion: string;
  tools: readonly {
    name: string;
    description: string;
    inputSchema: unknown;
    /** Present only when the server declared one; absent leaves the digest as it was. */
    outputSchema?: unknown;
    annotations?: unknown;
  }[];
}): Promise<string> {
  return await sha256Hex(canonicalJson({
    protocolVersion: manifest.protocolVersion,
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: tool.outputSchema }),
      ...(tool.annotations === undefined
        ? {}
        : { annotations: tool.annotations }),
    })),
  }));
}
