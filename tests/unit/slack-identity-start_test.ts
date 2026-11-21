/**
 * The two ends of one linking round trip: the URL that sends a person to Slack,
 * and the fixed words that come back.
 *
 * The tests that matter are the ones about what a round trip can put in a URL.
 * Only the state we issued goes to Slack, and only a fixed outcome comes back -
 * a callback that echoed a Slack error would put a provider's words (and, in the
 * other providers, its tokens) in a URL a person can paste anywhere.
 */
import { assert, assertEquals } from "@std/assert";
import {
  isSlackLinkOutcome,
  outcomeForFailure,
  outcomeForLink,
  slackAuthorizeUrl,
  slackLinkResultLocation,
} from "../../apps/server/src/modules/integrations/slack-identity-start.ts";

Deno.test("slack linking: the authorize URL carries exactly the five facts Slack needs", () => {
  const url = new URL(slackAuthorizeUrl({
    clientId: "1234.5678",
    redirectUri: "https://bakery.example/v1/integration-auth/slack/callback",
    state: "state-token",
    nonce: "nonce-token",
  }));
  assertEquals(
    url.origin + url.pathname,
    "https://slack.com/openid/connect/authorize",
  );
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("scope"), "openid");
  assertEquals(url.searchParams.get("client_id"), "1234.5678");
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "https://bakery.example/v1/integration-auth/slack/callback",
  );
  assertEquals(url.searchParams.get("state"), "state-token");
  assertEquals(url.searchParams.get("nonce"), "nonce-token");
  // Nothing else rides along: an extra parameter is a fact Slack never asked for.
  assertEquals(
    [...url.searchParams.keys()].sort(),
    [
      "client_id",
      "nonce",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ].sort(),
  );
});

Deno.test("slack linking: the state is escaped into the query, not concatenated", () => {
  const url = new URL(slackAuthorizeUrl({
    clientId: "c",
    redirectUri: "https://bakery.example/cb",
    state: "a&b=c d",
    nonce: "n",
  }));
  // Re-parsed, the whole state comes back: an unescaped '&' would have split it
  // into a second parameter Slack would forward to us as something we never sent.
  assertEquals(url.searchParams.get("state"), "a&b=c d");
});

Deno.test("slack linking: every outcome ends on the row, and only known outcomes show a banner", () => {
  const location = new URL(
    slackLinkResultLocation("https://bakery.example", "wrong_workspace"),
  );
  assertEquals(location.pathname, "/settings/security");
  assertEquals(location.hash, "#slack");
  assertEquals(location.searchParams.get("slackLink"), "wrong_workspace");

  for (
    const code of [
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
    ] as const
  ) {
    assert(isSlackLinkOutcome(code), code);
    assertEquals(outcomeForFailure(code as never), code);
  }
  // A hand-edited or truncated URL renders no banner rather than a sentence
  // invented from whatever was typed.
  for (const value of ["", "linked2", "LINKED", "<script>", undefined, 1]) {
    assertEquals(isSlackLinkOutcome(value), false, String(value));
  }
});

Deno.test("slack linking: a link write reports which of three things happened", () => {
  // A person pressing twice is told nothing changed, not that they linked twice.
  assertEquals(outcomeForLink({ ok: true, outcome: "unchanged" }), "unchanged");
  assertEquals(outcomeForLink({ ok: true, outcome: "linked" }), "linked");
  assertEquals(outcomeForLink({ ok: true, outcome: "relinked" }), "relinked");
  // Every refusal reads the same to the person: the identity is not theirs.
  assertEquals(
    outcomeForLink({ ok: false, reason: "linked_to_another_member" }),
    "link_refused",
  );
  assertEquals(
    outcomeForLink({ ok: false, reason: "not_a_member" }),
    "link_refused",
  );
  assertEquals(
    outcomeForLink({ ok: false, reason: "malformed" }),
    "link_refused",
  );
});
