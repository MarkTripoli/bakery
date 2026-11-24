/**
 * The worker-facing tool gateway routes (#401, chapter 25 §18.1).
 *
 * The gateway itself was merged in #513 and had no route: `callSessionTool` and
 * `listSessionToolsForCredential` were reached from exactly one place, their own
 * unit test, so an agent in a session could neither discover what it may call
 * nor call anything. These are the two routes that make it reachable, and they
 * add no authorisation logic of their own — every decision stays in
 * `session-gateway.ts`, which delegates liveness to `claimAttempt` the way
 * every other worker route does.
 *
 * Two credentials travel on these calls and they are not interchangeable:
 *
 * - `authorization: Bearer` is the **worker host** credential, which identifies
 *   the machine and is what `claimAttempt` checks the lease against.
 * - `x-session-credential` is the **session** credential, which names the
 *   attempt, the fence, the person acted for and the scopes.
 *
 * Separate headers because one `authorization` cannot carry both without one
 * impersonating the other, and the point of the session credential is that it
 * is strictly narrower than the host running it.
 */

import { Hono } from "hono";
import { type ActionContext } from "@bakery/contracts/action-registry";
import type { AuthVariables } from "../auth/middleware.ts";
import { StandardError } from "@bakery/contracts/http";
import {
  callSessionTool,
  listSessionToolsForCredential,
} from "./session-gateway.ts";
import {
  type SessionOperationClaim,
  SessionOperationError,
} from "./session-credential.ts";
import { resolveSessionCredential } from "./session-credential-store.ts";
import { SessionToolError } from "./session-tools.ts";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "@bakery/persistence";
import {
  assertHostRowIntegrity,
  type ExecutionRouteOptions,
  type HostRow,
  type WorkerIdentity,
} from "./shared.ts";
import type { SessionToolRegistry } from "./session-registry.ts";

/** The header a session credential travels in. Never a query and never a body. */
export const SESSION_CREDENTIAL_HEADER = "x-session-credential";

/**
 * Where a session asks, and what it asks for.
 *
 * The path carries no attempt id, because the credential already names one: a
 * session is not given the attempt's identifiers, only the file its credential
 * sits in. The credential is bound to that attempt's lease and fence, so
 * resolving it is how the server learns which attempt, and therefore which
 * organization and which host, is asking.
 */
export const SESSION_TOOLS_PATH = "/v1/session/tools";
export const SESSION_CALL_PATH = "/v1/session/call";

function readSessionCredential(headers: Headers): string {
  const value = headers.get(SESSION_CREDENTIAL_HEADER)?.trim();
  // A call without one is refused by the same code as a wrong one: telling a
  // caller its token is merely missing would let it probe.
  if (!value) {
    throw sessionRefusal(
      new SessionOperationError("SESSION_CREDENTIAL_INVALID"),
    );
  }
  return value;
}

export type SessionRouteOptions =
  & ExecutionRouteOptions
  & Readonly<{
    /**
     * The operations a session may be offered, and the way to run them.
     *
     * One object so the list and the call cannot disagree: an action cannot be
     * listed and then be uncallable, nor be callable while never offered.
     */
    sessionTools: SessionToolRegistry;
  }>;

/**
 * The context a dispatched action sees.
 *
 * `principal` is deliberately absent: the action runs under the session
 * credential's authority, which the gateway has already resolved and checked
 * against the live lease, and handing the host's principal down would let an
 * operation act as the machine's owner rather than the person the run is for.
 */
/**
 * The principal a dispatched action runs as.
 *
 * Exported so the "a session never exceeds the person" rule is testable without
 * a database: the claim is the only input, and the answer must be the person
 * the run is for rather than the worker host that picked the job up.
 */
const ORGANIZATION_HEADER = "Bakery-Organization-Id";

// A principal the guard cannot name is refused here rather than dispatched with
// an empty name: the guard would refuse it later for a reason that looks like
// missing authority, which is how every call once failed for everyone.
function requiredDisplayName(claim: SessionOperationClaim): string {
  const name = claim.actsForPrincipalDisplayName;
  if (name === undefined || name.trim() === "") {
    throw new SessionOperationError("SESSION_CREDENTIAL_NO_PRINCIPAL");
  }
  return name;
}

export function sessionDispatchPrincipal(
  claim: SessionOperationClaim,
): Readonly<{
  principalId: string;
  principalType: string;
  displayName: string;
}> {
  return {
    principalId: claim.actsForPrincipalId,
    principalType: claim.actsForPrincipalType,
    // The action's authority guard rebuilds its subject from this and refuses
    // one it cannot name. Omitting the name made every dispatched call fail
    // inside the guard with AUTH_FORBIDDEN - for an admin as well as an
    // outsider - so the route looked strict while refusing all work, and the
    // "a session never exceeds the person" test passed because nothing ever
    // succeeded in the first place.
    displayName: requiredDisplayName(claim),
  };
}

export function dispatchedContext(
  request: Request,
  attemptId: string,
  claim: SessionOperationClaim,
): ActionContext {
  // The action's guard reads the organization from the header, not the path, so
  // the dispatched request must carry it. Without it every call refused with
  // AUTH_FORBIDDEN before authority was even consulted.
  // The claim's organization always wins: a header the worker sent must not
  // widen the session beyond the organization the attempt was claimed in.
  // Built from the method and headers alone: the call's body was already read
  // to find the tool, and copying a request whose body is used throws.
  const dispatched = new Request(request.url, {
    method: request.method === "GET" || request.method === "HEAD"
      ? request.method
      : "POST",
    headers: new Headers(request.headers),
    signal: request.signal,
  });
  dispatched.headers.set(ORGANIZATION_HEADER, claim.organizationId);
  return {
    request: dispatched,
    // Route parameters come from the agent's arguments, per the operation's own
    // path (see splitCallArguments); the attempt id is not one of them.
    params: {},
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    traceId: request.headers.get("traceparent") ?? crypto.randomUUID(),
    signal: request.signal,
    // The action's own authority guard runs as the person the run is for, so a
    // session can never reach further than that person could. The credential's
    // scopes narrowed the offer; this narrows the act.
    principal: sessionDispatchPrincipal(claim),
    // The principal above is the person's, so without this marker an action
    // would be attributed to the person. It says an agent made the call (O50)
    // and names the attempt, which is how a guarded power finds the workflow the
    // agent runs under.
    agentSession: { attemptId },
    // Lets an action that reads across surfaces leave out the ones this
    // credential has no scope for, so a narrowed session cannot read through a
    // wider operation what its own narrower one would refuse.
    sessionScopes: claim.scopes,
  };
}

/**
 * Turns a session policy refusal into the typed problem a client can act on.
 *
 * Without this a bogus token, a token for another attempt and an unoffered tool
 * all surfaced as 500 INTERNAL: a client could not tell a refusal from a fault
 * and on-call was paged for bad tokens. Anything else is rethrown untouched.
 */
export function sessionRefusal(error: unknown): unknown {
  if (error instanceof SessionToolError) {
    if (error.code === "SESSION_TOOL_PEOPLE_ONLY") {
      return new StandardError({
        code: "AUTH_FORBIDDEN",
        params: { reason: "session_operation_people_only" },
        cause: error,
      });
    }
    return new StandardError({
      code: error.code === "SESSION_TOOL_UNKNOWN"
        ? "RESOURCE_NOT_FOUND"
        : "AUTH_FORBIDDEN",
      cause: error,
    });
  }
  if (error instanceof SessionOperationError) {
    switch (error.code) {
      case "SESSION_CREDENTIAL_INVALID":
        return new StandardError({ code: "AUTH_INVALID", cause: error });
      case "SESSION_CREDENTIAL_EXPIRED":
      case "SESSION_CREDENTIAL_FENCE_STALE":
        return new StandardError({ code: "AUTH_EXPIRED", cause: error });
      case "SESSION_SCOPE_DENIED":
      case "SESSION_CREDENTIAL_NO_PRINCIPAL":
        return new StandardError({ code: "AUTH_FORBIDDEN", cause: error });
    }
  }
  return error;
}

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw sessionRefusal(error);
  }
}

/**
 * The identity of the host that owns an attempt, read from the database.
 *
 * A worker route presented the host's bearer, so the host loads from its token
 * hash. A session call presents the session credential instead and must never
 * hold the machine's token, so the attempt's own row says which host owns it and
 * this loads that host by id. Every check downstream — the revoked status here,
 * the fence and the session generation in the gateway — then runs against the
 * real host row rather than an identity the caller asserted, and the row is
 * checked for integrity before any of them use it.
 *
 * `tokenHash` is empty because this caller used no host token. It is an
 * identity, not a credential: nothing here grants reach, and the session
 * credential still has to resolve and stay live for the call to happen.
 */
async function loadHostIdentityForSession(
  transaction: PgTransactionClient,
  hostId: string,
): Promise<WorkerIdentity> {
  const result = await transaction.query<HostRow>(
    `select id, organization_id, principal_id, principal_type, name, os,
            architecture, capabilities, slots, status, desired_mode,
            credential_hash, credential_generation, protocol_version,
            inventory_revision, readiness_revision, worker_session_id,
            worker_session_generation, last_heartbeat_at
       from bakery.worker_hosts
      where id = $1
      for update`,
    [hostId],
  );
  const host = result.rows[0];
  if (host === undefined || host.status === "revoked") {
    throw new SessionOperationError("SESSION_CREDENTIAL_INVALID");
  }
  // The same integrity check every worker route runs on this row, so a session
  // call cannot act on a host row those routes would refuse: a wrong principal
  // type, a malformed token hash or an incoherent session pair.
  try {
    assertHostRowIntegrity(host);
  } catch (error) {
    // A row that fails the check is not a usable host, and naming that would tell
    // a caller something about a machine it cannot reach. It answers as a bad
    // credential, which is what it is from here.
    throw new SessionOperationError("SESSION_CREDENTIAL_INVALID", {
      cause: error,
    });
  }
  return { tokenHash: "", host };
}

/**
 * Which attempt is asking, and the host it belongs to.
 *
 * The session credential is the whole authority on this route: it was minted for
 * one attempt, names that attempt's lease hash and fence, and expires with the
 * lease. So resolving it is how the server learns the attempt without a host
 * bearer, and the host identity is then loaded from the attempt's own row rather
 * than presented by the caller.
 *
 * That keeps every downstream check real: `claimAttempt` still locks the attempt
 * under this host and still compares the fence, and `assertSessionOperationLive`
 * still checks the host's session generation.
 *
 * A credential that resolves to an attempt with no host, or to a host row that no
 * longer exists or is revoked, is refused with the same code as a bad credential:
 * telling a caller which of the three failed would let it probe.
 */
async function resolveSession(
  transaction: PgTransactionClient,
  credentialToken: string,
): Promise<{ attemptId: string; identity: WorkerIdentity }> {
  const { claim } = await resolveSessionCredential(
    transaction,
    credentialToken,
    new Date(),
  );
  const host = await transaction.query<{ worker_host_id: string }>(
    `select worker_host_id from bakery.job_attempts where id = $1`,
    [claim.attemptId],
  );
  const hostId = host.rows[0]?.worker_host_id;
  if (hostId === undefined) {
    throw new SessionOperationError("SESSION_CREDENTIAL_INVALID");
  }
  const identity = await loadHostIdentityForSession(transaction, hostId);
  return { attemptId: claim.attemptId, identity };
}

export function createSessionRoutes(
  options: SessionRouteOptions,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get(SESSION_TOOLS_PATH, async (context) => {
    const token = readSessionCredential(context.req.raw.headers);
    const tools = await refusing(() =>
      withPgTransaction(options.database, async (transaction) => {
        const session = await resolveSession(transaction, token);
        return await listSessionToolsForCredential({
          transaction,
          identity: session.identity,
          attemptId: session.attemptId,
          credentialToken: token,
          registry: options.sessionTools.list(),
        });
      })
    );
    return context.json({ tools });
  });

  app.post(SESSION_CALL_PATH, async (context) => {
    const token = readSessionCredential(context.req.raw.headers);
    const body = await context.req.json().catch(() => {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }) as { tool?: unknown; arguments?: unknown };
    if (typeof body.tool !== "string" || body.tool.length === 0) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const tool = body.tool;
    const request = context.req.raw;

    const result = await refusing(() =>
      withPgTransaction(options.database, async (transaction) => {
        const session = await resolveSession(transaction, token);
        return await callSessionTool({
          transaction,
          identity: session.identity,
          attemptId: session.attemptId,
          credentialToken: token,
          registry: options.sessionTools.list(),
          tool,
          arguments: body.arguments ?? {},
          execute: (offered, claim) =>
            options.sessionTools.execute(
              offered.name,
              dispatchedContext(request, claim.attemptId, claim),
              body.arguments ?? {},
            ),
        });
      })
    );
    return context.json(result);
  });

  return app;
}

/** Re-exported so a caller can tell a policy refusal from a fault. */
export { SessionOperationError, SessionToolError };
