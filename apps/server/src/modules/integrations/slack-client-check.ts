/**
 * "Check now": does Slack recognise this app's client ID and secret?
 *
 * The screen's first status row is not decoration. A person who pasted a secret
 * with a trailing space, or regenerated the client secret in Slack and forgot to
 * replace it here, gets no other signal until a person presses Approve in Slack and
 * nothing happens. Slack will not read its own credentials back, so the only way to
 * ask is to make a request that exercises them and read the refusal.
 *
 * `oauth.v2.access` is the endpoint for that. Called with a deliberately unusable
 * code it still parses `client_id` and `client_secret` first and answers one of:
 *
 *   invalid_client_id  -- Slack does not know this client ID
 *   bad_client_secret  -- it knows the ID and refuses the secret
 *   invalid_code       -- both are fine; the code is what failed, as intended
 *
 * so the three cases are told apart by the refusal rather than assumed. Anything
 * else -- a network failure, a 5xx, a body that is not Slack's shape -- is
 * "unreachable", which the screen shows as "Nothing changed. Try again." rather
 * than blaming a credential that may be perfectly good.
 *
 * Nothing here is authenticated by the result: a passing check proves the pair is
 * well-formed and current, not that a request came from Slack. That is the signing
 * secret's job, and only a real request proves it.
 */
import type { SlackCheckResult } from "./slack-app-credentials.ts";

const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.access";

/**
 * A code Slack will reject, always.
 *
 * It must be a string oauth.v2.access is willing to look up, so that the credential
 * complaints come first; an empty value or a missing field would be a malformed
 * request and tell us nothing about the pair.
 */
export const SLACK_CHECK_CODE = "bakery-credential-check-not-a-real-code";

/** What Slack called the refusal, mapped to the sentence the screen has for it. */
const REFUSALS: Readonly<Record<string, SlackCheckResult>> = {
  invalid_client_id: "client_id_refused",
  bad_client_secret: "client_secret_refused",
  invalid_client_secret: "client_secret_refused",
  invalid_code: "accepted",
};

export type SlackCheckOutcome = Readonly<{
  result: SlackCheckResult;
  /** Slack's own code, for a log line. Never a credential, never shown as copy. */
  slackError: string | null;
}>;

/**
 * Asks Slack, and says which of the four things happened.
 *
 * The transport is a parameter so a test can answer without a network, and so a
 * deployment with an egress proxy can supply one. The credential pair travels in
 * the form body, which is where Slack's own SDKs put it: a URL that carries a
 * secret ends up in a proxy log.
 */
export async function checkSlackClientCredentials(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}): Promise<SlackCheckOutcome> {
  const call = input.fetch ?? fetch;
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: SLACK_CHECK_CODE,
    grant_type: "authorization_code",
  });
  const response = await call(input.endpoint ?? TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  }).catch(() => null);
  // A transport failure says nothing about the credentials.
  if (response === null) return { result: "unreachable", slackError: null };
  const payload = await response.json().catch(() => null) as
    | { ok?: unknown; error?: unknown }
    | null;
  if (payload === null || typeof payload.ok !== "boolean") {
    return { result: "unreachable", slackError: null };
  }
  if (payload.ok === true) {
    // The code was supposed to be unusable. A success means this endpoint no longer
    // answers the question the way the screen's sentences assume, and reporting
    // "accepted" from it would be a confident wrong answer.
    return { result: "unreachable", slackError: null };
  }
  const code = typeof payload.error === "string" ? payload.error : null;
  const known = code === null ? undefined : REFUSALS[code];
  return known === undefined
    ? { result: "unreachable", slackError: code }
    : { result: known, slackError: code };
}
