/**
 * The tool gateway: what a session may call, and what happened when it called.
 *
 * Chapter 25 §15.4 makes this a worker protocol surface, not a catalog one — the
 * worker exposes the endpoint, every call goes through the lease-protected route,
 * and the credential is presented as a bearer rather than in the body.
 *
 * Three rules shape this module, and each exists because of a specific failure:
 *
 * - **Liveness is delegated, never re-derived.** The attempt is claimed through
 *   `claimAttempt`, which is the same chain the other worker routes use. A
 *   gateway that compared the fence columns itself would look authoritative and
 *   silently drop whatever that chain checks — which is exactly how the attempt
 *   status check went missing from the credential module before it was fixed.
 * - **Outcome is keyed on the error class, never on the message.** A typed policy
 *   refusal is `denied`; anything else is `unknown`. `SESSION_TOOL_UNKNOWN` is a
 *   denial despite its name, and recording it as `unknown` would turn the
 *   clearest possible refusal into a shrug.
 * - **A call is never allowed to go unaudited.** The allowed path shares the
 *   operation's transaction, so a success and its record commit together or not
 *   at all. The refused paths commit their record separately, because a denial
 *   that rolls back is a denial nobody can see — and a denial must never become
 *   a 200 because the audit table was unwritable.
 */

import type { PgTransactionClient } from "@bakery/persistence";
import type { ActionDefinition } from "@bakery/contracts/action-registry";
import {
  claimAttempt,
  type ClaimedAttempt,
  reassertAttempt,
} from "./attempt-claim.ts";
import {
  assertSessionOperationLive,
  type SessionOperationClaim,
  SessionOperationError,
} from "./session-credential.ts";
import {
  recordSessionOperationAudit,
  recordSessionOperationRefusal,
  resolveSessionCredential,
} from "./session-credential-store.ts";
import {
  ACTION_GUARDED_POWERS,
  assertSessionToolAllowed,
  listSessionTools,
  powerForSessionScope,
  type SessionTool,
  SessionToolError,
} from "./session-tools.ts";
import {
  agentHoldsPower,
  attemptOrigin,
} from "../auth/application/agent-power-grants.ts";
import type { WorkerIdentity } from "./shared.ts";
import { sha256Hex } from "../../platform/canonical-json.ts";

/** What the gateway records for a call. Three values, and each means one thing. */
export type SessionCallOutcome = "allowed" | "denied" | "unknown";

/**
 * Every refusal the credential and tool surfaces raise deliberately.
 *
 * Written out rather than described as "the typed refusals" because a list that
 * says that is how one gets missed — and one was: SESSION_CREDENTIAL_INVALID is
 * both the most security-relevant denial here and the easiest to overlook, since
 * it is raised by resolution rather than by an explicit check.
 *
 * Note SESSION_TOOL_UNKNOWN sits in this list although the name says unknown: it
 * is raised when no tool of that name exists, which means the operation decided.
 * A reader who "fixes" it into the unknown bucket would be introducing the bug.
 */
const POLICY_REFUSALS: ReadonlySet<string> = new Set([
  "SESSION_CREDENTIAL_INVALID",
  "SESSION_CREDENTIAL_EXPIRED",
  "SESSION_CREDENTIAL_FENCE_STALE",
  "SESSION_SCOPE_DENIED",
  "SESSION_TOOL_DENIED",
  "SESSION_TOOL_PEOPLE_ONLY",
  "SESSION_TOOL_UNKNOWN",
]);

/**
 * Classifies a thrown error for the audit.
 *
 * Deliberately structural: it looks at the code the module raised, not at the
 * text, so a message rewrite cannot silently reclassify a denial as a failure.
 */
export function classifySessionFailure(
  error: unknown,
): Exclude<SessionCallOutcome, "allowed"> {
  if (error instanceof SessionOperationError) {
    return POLICY_REFUSALS.has(error.code) ? "denied" : "unknown";
  }
  if (error instanceof SessionToolError) {
    return POLICY_REFUSALS.has(error.code) ? "denied" : "unknown";
  }
  return "unknown";
}

export type SessionGatewayInput = Readonly<{
  transaction: PgTransactionClient;
  identity: WorkerIdentity;
  attemptId: string;
  /** The bearer the session was issued; never carried in a body or a log. */
  credentialToken: string;
  registry: readonly ActionDefinition[];
  now?: Date;
}>;

/**
 * Claims the attempt for this call and proves the credential is still live.
 *
 * The credential names its own lease hash, so this hands that to `claimAttempt`
 * rather than hashing a token it was never given. The result is that the gateway
 * is on the same lock-and-assert chain as every other worker route, with the
 * credential's extra conditions checked on top instead of in place of them.
 */
async function openSessionCall(input: SessionGatewayInput): Promise<{
  claim: SessionOperationClaim;
  credentialId: string;
  claimed: ClaimedAttempt;
  scopes: readonly string[];
}> {
  const now = input.now ?? new Date();
  const resolved = await resolveSessionCredential(
    input.transaction,
    input.credentialToken,
    now,
  );
  const { claim } = resolved;

  // The claim must name the attempt the caller is asking about, or a credential
  // for one attempt would authorise a call attributed to another.
  if (claim.attemptId !== input.attemptId) {
    throw new SessionOperationError("SESSION_CREDENTIAL_INVALID");
  }

  // The operation runs on its own connection while this transaction holds the
  // attempt, and its writes reference the attempt (the step write set's
  // foreign key). `no key update` still stops the fence moving but lets that
  // key-share check through; `update` would leave each waiting on the other.
  const claimed = await claimAttempt({
    transaction: input.transaction,
    identity: input.identity,
    attemptId: input.attemptId,
    lock: "no key update",
    proof: {
      tokenHash: claim.leaseTokenHash,
      fence: claim.fence.toString(),
      workerSessionId: claim.workerSessionId,
      workerSessionGeneration: claim.workerSessionGeneration.toString(),
    },
  });

  // Liveness against the attempt as it is now, above and beyond the lease: the
  // credential's own expiry, its organization and its session generation. The
  // row comes from the claim rather than a second query, so there is exactly one
  // place the fence is compared.
  assertSessionOperationLive(claim, claimed.attempt, input.identity, now);

  return {
    claim,
    credentialId: resolved.id,
    claimed,
    scopes: claim.scopes,
  };
}

/**
 * Lists the tools this session may call.
 *
 * The same derivation a future `session.tools` handler will use, exposed as a
 * function so the listing is testable without a route and so the route cannot
 * grow a second source of truth.
 */
export async function listSessionToolsForCredential(
  input: SessionGatewayInput,
): Promise<readonly SessionTool[]> {
  const open = await openSessionCall(input);
  return listSessionTools(open.scopes, input.registry);
}

export type SessionCallResult = Readonly<{
  outcome: SessionCallOutcome;
  result?: unknown;
}>;

/**
 * Calls one operation the session was offered.
 *
 * `execute` runs the operation itself. It is injected rather than dispatched
 * here so the gateway owns authorisation, liveness and the audit — the three
 * things that must not vary between operations — while the operation keeps
 * owning its own input validation and output.
 */
export async function callSessionTool(
  input:
    & SessionGatewayInput
    & Readonly<{
      tool: string;
      arguments: unknown;
      /**
       * Runs the operation. Handed the resolved claim, because the operation
       * runs as the person the run is for: `actsForPrincipalId` and its type
       * live on the claim, and a session must never exceed that person.
       */
      execute: (
        tool: SessionTool,
        claim: SessionOperationClaim,
      ) => Promise<unknown>;
    }>,
): Promise<SessionCallResult> {
  // A refusal that happens before a credential resolves cannot be recorded in
  // the audit, whose key is that credential. It is still recorded: the refusal
  // table holds what is actually known here — the organization the caller's host
  // belongs to, the attempt it asked about, and the hash of the token it
  // presented — rather than leaving the refusal unrecorded or inventing the
  // missing identities to fill the audit's columns.
  let open: Awaited<ReturnType<typeof openSessionCall>>;
  try {
    open = await openSessionCall(input);
  } catch (error) {
    await recordSessionOperationRefusal(input.transaction, {
      organizationId: input.identity.host.organization_id,
      attemptId: input.attemptId,
      presentedTokenHash: await sha256Hex(input.credentialToken),
      operation: input.tool,
      outcome: classifySessionFailure(error),
    });
    throw error;
  }

  const outcomeOf = (error: unknown): SessionCallOutcome =>
    classifySessionFailure(error);

  let scope: string;
  try {
    scope = assertSessionToolAllowed(open.scopes, input.tool);
  } catch (error) {
    await recordSessionOperationAudit(input.transaction, {
      organizationId: open.claim.organizationId,
      credentialId: open.credentialId,
      attemptId: input.attemptId,
      actsForPrincipalId: open.claim.actsForPrincipalId,
      workerSessionId: open.claim.workerSessionId,
      operation: input.tool,
      scope: "",
      outcome: outcomeOf(error),
    });
    throw error;
  }

  const tool = listSessionTools(open.scopes, input.registry).find(
    (candidate) => candidate.name === input.tool,
  );
  if (!tool) {
    // Offered a scope but not a tool: the two derivations disagreeing is a bug,
    // and it must not be reported as a denial the caller can retry past.
    const error = new SessionToolError("SESSION_TOOL_UNKNOWN", input.tool);
    await recordSessionOperationAudit(input.transaction, {
      organizationId: open.claim.organizationId,
      credentialId: open.credentialId,
      attemptId: input.attemptId,
      actsForPrincipalId: open.claim.actsForPrincipalId,
      workerSessionId: open.claim.workerSessionId,
      operation: input.tool,
      scope,
      outcome: "unknown",
    });
    throw error;
  }

  // Holding a granted power's scope proves the grant was live at claim, not that
  // it still is: a revoked grant stops the next call. A power whose operation
  // checks its own grant live (ACTION_GUARDED_POWERS) is left to it, so the
  // refusal names its reason instead of a bare denial.
  const power = powerForSessionScope(scope);
  if (power !== null && !ACTION_GUARDED_POWERS.has(power)) {
    const origin = await attemptOrigin(
      input.transaction,
      open.claim.organizationId,
      input.attemptId,
    );
    const stillGranted = origin !== null && await agentHoldsPower(
      input.transaction,
      {
        organizationId: open.claim.organizationId,
        power,
        workflowId: origin.workflowId,
        accessTokenId: null,
      },
    );
    if (!stillGranted) {
      const error = new SessionToolError(
        "SESSION_TOOL_DENIED",
        tool.name,
        scope,
      );
      await recordSessionOperationAudit(input.transaction, {
        organizationId: open.claim.organizationId,
        credentialId: open.credentialId,
        attemptId: input.attemptId,
        actsForPrincipalId: open.claim.actsForPrincipalId,
        workerSessionId: open.claim.workerSessionId,
        operation: tool.name,
        scope,
        outcome: outcomeOf(error),
      });
      throw error;
    }
  }

  try {
    const result = await input.execute(tool, open.claim);
    // After the work, before the answer: a lease that lapsed while the
    // operation ran must leave the caller with nothing.
    await reassertAttempt(open.claimed);
    // Same transaction as the operation, so a success is never unaudited. If
    // this insert fails the whole transaction rolls back, and the operation's
    // writes roll back with it — which is the point.
    await recordSessionOperationAudit(input.transaction, {
      organizationId: open.claim.organizationId,
      credentialId: open.credentialId,
      attemptId: input.attemptId,
      actsForPrincipalId: open.claim.actsForPrincipalId,
      workerSessionId: open.claim.workerSessionId,
      operation: tool.name,
      scope,
      outcome: "allowed",
    });
    return { outcome: "allowed", result };
  } catch (error) {
    const outcome = outcomeOf(error);
    // A typed refusal decided the call; anything else failed. Either way the
    // original error propagates, because an audit-write failure must not
    // replace the real cause with itself.
    await recordSessionOperationAudit(input.transaction, {
      organizationId: open.claim.organizationId,
      credentialId: open.credentialId,
      attemptId: input.attemptId,
      actsForPrincipalId: open.claim.actsForPrincipalId,
      workerSessionId: open.claim.workerSessionId,
      operation: tool.name,
      scope,
      outcome,
    });
    throw error;
  }
}

/** Exposed for the guard test: the mapping is data, so a test can assert it. */
export function sessionPolicyRefusalCodes(): readonly string[] {
  return [...POLICY_REFUSALS].sort();
}
