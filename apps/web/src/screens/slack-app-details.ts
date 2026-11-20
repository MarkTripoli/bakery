/**
 * What the Slack app form accepts, kept apart from the section that draws it so
 * the rules can be tested without a browser (#415).
 */

/** Longest app ID, client ID and secret the server accepts. */
export const SLACK_FIELD_MAX = 200;
export const SLACK_SECRET_MAX = 4096;

/** The Slack app's ID prefix; a value without it is a paste error. */
export const SLACK_APP_ID_PREFIX = "A";

/** What the administrator typed. Secrets are never filled from the server. */
export type SlackAppValues = {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string;
};

export const EMPTY_SLACK_APP: SlackAppValues = {
  appId: "",
  clientId: "",
  clientSecret: "",
  signingSecret: "",
};

/** Both secrets reachable and every field within bounds: what the server takes. */
export function slackAppReady(
  values: SlackAppValues,
  stored: boolean,
): boolean {
  return values.appId.trim() !== "" && values.clientId.trim() !== "" &&
    // Replace may leave a secret empty, because the stored one is kept.
    (stored ||
      (values.clientSecret.trim() !== "" &&
        values.signingSecret.trim() !== "")) &&
    values.appId.length <= SLACK_FIELD_MAX &&
    values.clientId.length <= SLACK_FIELD_MAX &&
    values.clientSecret.length <= SLACK_SECRET_MAX &&
    values.signingSecret.length <= SLACK_SECRET_MAX;
}

/** A Slack app ID starts with A and carries no spaces. */
export function slackAppIdLooksRight(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(SLACK_APP_ID_PREFIX) && !/\s/.test(trimmed);
}
