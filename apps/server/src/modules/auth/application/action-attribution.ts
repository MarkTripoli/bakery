import type { ActionContext } from "@bakery/contracts/action-registry";
import { PrincipalType } from "@bakery/contracts/contracts";

/**
 * Who an action is attributed to and whether it is labelled as an agent's
 * action (chapter 25, O50). The principal is always the authenticated one the
 * request acts for; an agent never gets an identity of its own here.
 */
export type ActionAttribution = Readonly<{
  /** The principal the action is attributed to (the person, or the seat's own identity). */
  principalId: string;
  /** `agent` for an agent's action, `person` for a person's own action. */
  actorKind: "person" | "agent";
  /** The access token an agent presented, or null. */
  accessTokenId: string | null;
}>;

/**
 * Attributes one authorized action. A person acts through a signed-in browser
 * session. Everything else is labelled as an agent's action, attributed to the
 * principal it acts for: a request with an access token (agents, MCP and
 * local harnesses act for the token's principal) and a service or worker
 * principal (the seat's own identity).
 */
export function attributeAction(
  context: Pick<ActionContext, "principal" | "accessToken" | "agentSession">,
  principalId: string,
): ActionAttribution {
  const principalType = typeof context.principal === "object" &&
      context.principal !== null &&
      "principalType" in context.principal
    ? (context.principal as { principalType: unknown }).principalType
    : undefined;
  const accessTokenId = context.accessToken?.id ?? null;
  // A session call carries the person's own principal (a human), so the
  // principal type alone would label an agent's action as the person's. The
  // session marker is what says an agent made the call (O50).
  const agent = accessTokenId !== null ||
    context.agentSession !== undefined ||
    principalType !== PrincipalType.Human;
  return Object.freeze({
    principalId,
    actorKind: agent ? "agent" : "person",
    accessTokenId,
  });
}
