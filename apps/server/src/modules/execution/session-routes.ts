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
import {
  type ActionContext,
  type ActionDefinition,
} from "@bakery/contracts/action-registry";
import type { AuthVariables } from "../auth/middleware.ts";
import type { ActionRegistry } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import {
  callSessionTool,
  listSessionToolsForCredential,
} from "./session-gateway.ts";
import {
  type SessionOperationClaim,
  SessionOperationError,
} from "./session-credential.ts";
import { SessionToolError } from "./session-tools.ts";
import { workerTransaction } from "./shared.ts";
import type { ExecutionRouteOptions } from "./shared.ts";

/** The header a session credential travels in. Never a query and never a body. */
export const SESSION_CREDENTIAL_HEADER = "x-session-credential";

export const SESSION_TOOLS_PATH = "/v1/worker/attempts/:id/session-tools";
export const SESSION_CALL_PATH = "/v1/worker/attempts/:id/session-call";

function readSessionCredential(headers: Headers): string {
  const value = headers.get(SESSION_CREDENTIAL_HEADER)?.trim();
  // A call without one is refused by the same code as a wrong one: telling a
  // caller its token is merely missing would let it probe.
  if (!value) throw new SessionOperationError("SESSION_CREDENTIAL_INVALID");
  return value;
}

export type SessionRouteOptions =
  & ExecutionRouteOptions
  & Readonly<{
    /** Every action a session may be offered; the list and the call share it. */
    registry: readonly ActionDefinition[];
    /**
     * The same actions, executable. Dispatching through the registry rather than
     * calling a handler directly is what makes the offered list and the callable
     * set one thing: an action cannot be listed and then be uncallable, nor be
     * callable while never offered.
     */
    executable: ActionRegistry;
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
export function sessionDispatchPrincipal(
  claim: SessionOperationClaim,
): Readonly<{ principalId: string; principalType: string }> {
  return {
    principalId: claim.actsForPrincipalId,
    principalType: claim.actsForPrincipalType,
  };
}

export function dispatchedContext(
  request: Request,
  attemptId: string,
  claim: SessionOperationClaim,
): ActionContext {
  return {
    request,
    params: { id: attemptId },
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    traceId: request.headers.get("traceparent") ?? crypto.randomUUID(),
    signal: request.signal,
    // The action's own authority guard runs as the person the run is for, so a
    // session can never reach further than that person could. The credential's
    // scopes narrowed the offer; this narrows the act.
    principal: sessionDispatchPrincipal(claim),
  };
}

export function createSessionRoutes(
  options: SessionRouteOptions,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get(SESSION_TOOLS_PATH, async (context) => {
    const attemptId = context.req.param("id") ?? "";
    const token = readSessionCredential(context.req.raw.headers);
    const tools = await workerTransaction(
      options.database,
      context.req.raw.headers,
      (transaction, identity) =>
        listSessionToolsForCredential({
          transaction,
          identity,
          attemptId,
          credentialToken: token,
          registry: options.registry,
        }),
    );
    return context.json({ tools });
  });

  app.post(SESSION_CALL_PATH, async (context) => {
    const attemptId = context.req.param("id") ?? "";
    const token = readSessionCredential(context.req.raw.headers);
    const body = await context.req.json().catch(() => {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }) as { tool?: unknown; arguments?: unknown };
    if (typeof body.tool !== "string" || body.tool.length === 0) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const tool = body.tool;
    const request = context.req.raw;

    const result = await workerTransaction(
      options.database,
      context.req.raw.headers,
      (transaction, identity) =>
        callSessionTool({
          transaction,
          identity,
          attemptId,
          credentialToken: token,
          registry: options.registry,
          tool,
          arguments: body.arguments ?? {},
          execute: (offered, claim) =>
            options.executable.execute(
              offered.name,
              dispatchedContext(request, attemptId, claim),
              body.arguments ?? {},
            ),
        }),
    );
    return context.json(result);
  });

  return app;
}

/** Re-exported so a caller can tell a policy refusal from a fault. */
export { SessionOperationError, SessionToolError };
