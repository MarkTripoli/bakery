import { assert, assertEquals } from "@std/assert";
import {
  EMPTY_SLACK_APP,
  slackAppIdLooksRight,
  slackAppReady,
  type SlackAppValues,
} from "../../apps/web/src/screens/slack-app-details.ts";

const filled: SlackAppValues = {
  appId: "A0123ABCD",
  clientId: "1234567890.1234567890",
  clientSecret: "a".repeat(32),
  signingSecret: "b".repeat(32),
};

Deno.test("a new app needs every detail", () => {
  assert(slackAppReady(filled, false));
  // Nothing stored, so an empty secret field is a missing secret.
  assertEquals(slackAppReady({ ...filled, clientSecret: "" }, false), false);
  assertEquals(slackAppReady({ ...filled, signingSecret: "" }, false), false);
  assertEquals(slackAppReady(EMPTY_SLACK_APP, false), false);
});

Deno.test("replacing a stored app keeps secrets that were left empty", () => {
  // The secrets are write-only: the form cannot show them, so an empty field
  // means "keep what is stored" and the server must not be sent a blank one.
  assert(
    slackAppReady({ ...filled, clientSecret: "", signingSecret: "" }, true),
  );
});

Deno.test("the ids are required even when the secrets are stored", () => {
  assertEquals(slackAppReady({ ...filled, appId: "" }, true), false);
  assertEquals(slackAppReady({ ...filled, clientId: "  " }, true), false);
});

Deno.test("a field over the server's limit is refused before it is sent", () => {
  assertEquals(
    slackAppReady({ ...filled, appId: "A".repeat(201) }, false),
    false,
  );
  assertEquals(
    slackAppReady({ ...filled, clientSecret: "a".repeat(4097) }, true),
    false,
  );
  // The limit itself is allowed.
  assert(slackAppReady({ ...filled, clientId: "1".repeat(200) }, false));
});

Deno.test("a Slack app id starts with A and carries no spaces", () => {
  assert(slackAppIdLooksRight("A0123ABCD"));
  assert(slackAppIdLooksRight(" A0123ABCD "));
  // A client id pasted into the app id field is the mistake this catches.
  assertEquals(slackAppIdLooksRight("1234567890.1234567890"), false);
  assertEquals(slackAppIdLooksRight("A0123 ABCD"), false);
  assertEquals(slackAppIdLooksRight(""), false);
});
