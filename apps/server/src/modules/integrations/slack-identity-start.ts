/**
 * Where a person's Slack account gets linked: the two ends of one round trip.
 *
 * The pieces already exist and are each tested on their own — an attempt binds
 * the Slack app, workspace and nonce to one member's browser session
 * (`slack-identity-attempts.ts`), the identity token is verified against that
 * binding (`slack-identity.ts`), and a verified identity is linked to a current
 * member (`slack-identity-links.ts`). What was missing is the code that joins
 * them in the right order, and the order is the security property:
 *
 * 1. Slack's own sign-in runs first, with the state we issued. Nothing is
 *    trusted from the query string except that state.
 * 2. A callback claim matches state, session, member, pending status and expiry
 *    in one atomic update, so a replayed or borrowed link changes nothing.
 * 3. The token is verified against the *claimed* binding, never against
 *    anything the callback supplied, so a token for another workspace, app or
 *    attempt cannot pass.
 * 4. Only then is the link written, and the attempt is closed exactly once.
 *
 * Every outcome is one of the codes the web row already has sentences for, so a
 * person is never shown a Slack error and never sees a token or a code.
 */
import type { SlackAttemptFailureCode } from "./slack-identity-attempts.ts";
import type { SlackLinkRevokeReason } from "./slack-identity-links.ts";

/** Slack's own sign-in screen, which is where linking starts. */
export const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";

/** What the browser is sent to: Slack's sign-in for this attempt. */
export function slackAuthorizeUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
}): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  return url.toString();
}

/**
 * How a round trip ended, as the web row names it. `wrong_workspace` and
 * `expired` are outcomes rather than stored attempt codes: the first is decided
 * by the token's `team_id` claim, which is checked before the signature has any
 * meaning for us, and the second is a claim that found no pending attempt.
 */
export const SLACK_LINK_OUTCOMES = [
  "linked",
  "relinked",
  "unchanged",
  "provider_denied",
  "link_refused",
  "exchange_failed",
  "token_invalid",
  "nonce_unreadable",
  "superseded",
  "expired",
  "wrong_workspace",
] as const;

export type SlackLinkOutcome = (typeof SLACK_LINK_OUTCOMES)[number];

/** The outcome a stored attempt failure code becomes. */
export function outcomeForFailure(
  code: SlackAttemptFailureCode,
): SlackLinkOutcome {
  return code;
}

/**
 * The outcome a link write becomes. `linked`, `relinked` and `unchanged` are
 * distinct because a person who presses twice should be told nothing changed
 * rather than that they linked twice.
 */
export function outcomeForLink(
  result:
    | {
      readonly ok: true;
      readonly outcome: "linked" | "unchanged" | "relinked";
    }
    | { readonly ok: false; readonly reason: string },
): SlackLinkOutcome {
  return result.ok ? result.outcome : "link_refused";
}

/**
 * The redirect back to the page the row lives on, carrying the outcome. The
 * code is a fixed word from {@link SLACK_LINK_OUTCOMES}; nothing else from the
 * round trip is put in the URL.
 */
export function slackLinkResultLocation(
  baseUrl: string,
  outcome: SlackLinkOutcome,
): string {
  const url = new URL("/settings/security", baseUrl);
  url.searchParams.set("slackLink", outcome);
  url.hash = "slack";
  return url.toString();
}

/**
 * Whether a query parameter names a real outcome. A caller renders a banner
 * only for a known code, so a hand-edited URL shows nothing rather than a
 * sentence invented from whatever was typed.
 */
export function isSlackLinkOutcome(value: unknown): value is SlackLinkOutcome {
  return typeof value === "string" &&
    (SLACK_LINK_OUTCOMES as readonly string[]).includes(value);
}

/** Why a link was removed, in the row's words. */
export function isSlackUnlinkReason(
  value: unknown,
): value is SlackLinkRevokeReason {
  return value === "revoked_by_admin" || value === "unlinked_by_member" ||
    value === "membership_inactive";
}
