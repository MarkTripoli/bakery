/**
 * #415: what makes a Slack request Slack's, and what makes it a replay.
 *
 * The ingress for buttons and thread replies is the one place where a stranger
 * can make Bakery record a decision under somebody's name, so the checks are
 * tested as rules rather than as one happy path: a body that was edited, a
 * timestamp that was edited, a secret that is not the app's, and a request that is
 * merely a copy of an earlier one all have to fail, and each has to fail for its
 * own reason so the log says which.
 */
import { assert, assertEquals } from "@std/assert";
import {
  signSlackRequest,
  SLACK_SIGNATURE_TOLERANCE_SECONDS,
  type SlackRequestRefusal,
  slackSigningMessage,
  verifySlackRequest,
} from "../../apps/server/src/modules/integrations/slack-request-signature.ts";

const SECRET = "8f14e45fceea167a5a36dedd4bea2543";
const NOW = 1_760_000_000;
const BODY = new TextEncoder().encode(
  'payload={"type":"block_actions","actions":[{"action_id":"approve"}]}',
);

async function signed(
  body: Uint8Array<ArrayBuffer> = BODY,
  timestamp = String(NOW),
  secret = SECRET,
) {
  return {
    signingSecret: SECRET,
    signatureHeader: await signSlackRequest({
      signingSecret: secret,
      timestamp,
      rawBody: body,
    }),
    timestampHeader: timestamp,
    rawBody: body,
    now: NOW,
  };
}

Deno.test("a request Slack signed verifies, and names the key that makes it a replay", async () => {
  const verdict = await verifySlackRequest(await signed());
  assert(verdict.ok);
  assertEquals(verdict.timestamp, NOW);
  // 64 lowercase hex digits and nothing else: this is what a caller stores under
  // a unique constraint, so a second identical request changes nothing.
  assertEquals(/^[0-9a-f]{64}$/.test(verdict.replayKey), true);
  // The digest identifies the body without keeping it.
  assertEquals(/^[0-9a-f]{64}$/.test(verdict.bodyDigest), true);
});

Deno.test("the same request replayed carries the same replay key, so a unique index refuses it", async () => {
  const first = await verifySlackRequest(await signed());
  const replay = await verifySlackRequest(await signed());
  assert(first.ok && replay.ok);
  assertEquals(replay.replayKey, first.replayKey);
  assertEquals(replay.bodyDigest, first.bodyDigest);

  // A different body, or the same body at a different second, is a different
  // key: a decision at 12:00:00 and the same decision at 12:00:01 are two
  // requests, and both are Slack's.
  const otherBody = await verifySlackRequest(
    await signed(
      new TextEncoder().encode('payload={"type":"view_submission"}'),
    ),
  );
  assert(otherBody.ok);
  assert(otherBody.replayKey !== first.replayKey);

  const otherSecond = await verifySlackRequest(
    await signed(BODY, String(NOW - 1)),
  );
  assert(otherSecond.ok);
  assert(otherSecond.replayKey !== first.replayKey);
});

Deno.test("an edited body does not verify, whatever else is copied with it", async () => {
  const headers = await signed();
  const tampered = new TextEncoder().encode(
    'payload={"type":"block_actions","actions":[{"action_id":"reject"}]}',
  );
  const verdict = await verifySlackRequest({ ...headers, rawBody: tampered });
  assertEquals(verdict, { ok: false, reason: "signature_mismatch" });
});

Deno.test("a timestamp that was not signed cannot be edited to look fresh", async () => {
  const headers = await signed();
  const verdict = await verifySlackRequest({
    ...headers,
    timestampHeader: String(NOW + 10),
  });
  assertEquals(verdict, { ok: false, reason: "signature_mismatch" });
});

Deno.test("a request outside the window is refused before its body is read", async () => {
  // Slack's own 300 seconds, enforced in both directions: a timestamp far in the
  // future is as suspect as an old one, and accepting it would widen the window a
  // captured request can be used in.
  const oldEnough = NOW - SLACK_SIGNATURE_TOLERANCE_SECONDS - 1;
  assertEquals(
    await verifySlackRequest({
      ...await signed(BODY, String(oldEnough)),
      now: NOW,
    }),
    { ok: false, reason: "stale_timestamp" },
  );
  const tooNew = NOW + SLACK_SIGNATURE_TOLERANCE_SECONDS + 1;
  assertEquals(
    await verifySlackRequest({
      ...await signed(BODY, String(tooNew)),
      now: NOW,
    }),
    { ok: false, reason: "stale_timestamp" },
  );
  // Exactly on the boundary is still inside it.
  const boundary = await verifySlackRequest({
    ...await signed(BODY, String(NOW - SLACK_SIGNATURE_TOLERANCE_SECONDS)),
    now: NOW,
  });
  assertEquals(boundary.ok, true);
});

Deno.test("another app's secret does not sign for this one", async () => {
  const verdict = await verifySlackRequest(
    await signed(BODY, String(NOW), "not-the-app-secret"),
  );
  assertEquals(verdict, { ok: false, reason: "signature_mismatch" });
});

Deno.test("an unset secret verifies nothing at all", async () => {
  // The failure this guards is a deployment that forgot the variable: an empty
  // key must not be a key that any request can satisfy.
  const verdict = await verifySlackRequest({
    signingSecret: "",
    // A plausible-looking signature, because signing with an empty key is itself
    // impossible: what matters is that nothing verifies against "".
    signatureHeader: `v0=${"0".repeat(64)}`,
    timestampHeader: String(NOW),
    rawBody: BODY,
    now: NOW,
  });
  assertEquals(verdict, { ok: false, reason: "signature_mismatch" });
});

Deno.test("a missing or malformed header is refused by name", async () => {
  const valid = await signed();
  const cases: readonly [
    string | null,
    string | null,
    SlackRequestRefusal,
  ][] = [
    [null, String(NOW), "missing_signature"],
    [valid.signatureHeader, null, "missing_timestamp"],
    // Uppercase hex, a missing version prefix, a short digest and whitespace are
    // all different from what Slack sends, so none of them is read as equal.
    [valid.signatureHeader.toUpperCase(), String(NOW), "malformed_signature"],
    [
      valid.signatureHeader.replace("v0=", ""),
      String(NOW),
      "malformed_signature",
    ],
    [valid.signatureHeader.slice(0, -2), String(NOW), "malformed_signature"],
    [` ${valid.signatureHeader}`, String(NOW), "malformed_signature"],
    [valid.signatureHeader, " 1760000000", "malformed_timestamp"],
    [valid.signatureHeader, "1760000000.5", "malformed_timestamp"],
    [valid.signatureHeader, "-1760000000", "malformed_timestamp"],
    [valid.signatureHeader, "", "malformed_timestamp"],
  ];
  for (const [signatureHeader, timestampHeader, reason] of cases) {
    assertEquals(
      await verifySlackRequest({
        ...valid,
        signatureHeader,
        timestampHeader,
      }),
      { ok: false, reason },
      `${String(signatureHeader)} / ${String(timestampHeader)}`,
    );
  }
});

Deno.test("the signed string is exactly Slack's version, timestamp and body", () => {
  // Written out rather than derived, because getting this wrong is the difference
  // between verifying Slack and verifying something that merely looks like it.
  assertEquals(
    new TextDecoder().decode(slackSigningMessage("1760000000", BODY)),
    'v0:1760000000:payload={"type":"block_actions","actions":[{"action_id":"approve"}]}',
  );
});
