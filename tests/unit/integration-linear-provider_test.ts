import { assertEquals, assertFalse } from "@std/assert";
import { createHmac } from "node:crypto";
import {
  manifestDefects,
  serverProviderDefects,
} from "../../packages/integration-sdk/provider.ts";
import {
  isLinearWebhookBody,
  LINEAR_REPLAY_WINDOW_MS,
  LINEAR_SIGNATURE_HEADER,
  linearProviderManifest,
  linearServerProvider,
} from "../../packages/integration-linear/src/server/mod.ts";
import {
  LINEAR_STATE_TYPES,
  statusOf,
  statusTriggerFires,
} from "../../packages/integration-linear/src/server/mod.ts";

/**
 * The Linear provider package, checked the way startup would check it.
 *
 * The SDK's own `manifestDefects` and `serverProviderDefects` are what
 * `activateProviders` will fail on, so calling them here is not a re-implementation
 * of the rule - it is the rule. What these tests add is the part the SDK cannot
 * know: that Linear's manifest and implementation actually satisfy it.
 */

const secret = new TextEncoder().encode("linear-webhook-secret");
const body = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const signatureFor = (raw: Uint8Array, key: Uint8Array = secret) =>
  new Uint8Array(createHmac("sha256", key).update(raw).digest());

/** The host's verifier, as `apps/server` supplies it: HMAC then constant time. */
const signatureMatches = (
  input: { secret: Uint8Array; body: Uint8Array; signature: Uint8Array },
) => {
  const expected = signatureFor(input.body, input.secret);
  if (expected.byteLength !== input.signature.byteLength) return false;
  return expected.every((byte, index) => byte === input.signature[index]);
};

Deno.test("the Linear manifest and implementation pass the SDK's own checks", () => {
  assertEquals(manifestDefects(linearProviderManifest), []);
  assertEquals(serverProviderDefects(linearServerProvider), []);
});

Deno.test("the manifest claims the ticket family and an OAuth2 connect", () => {
  // These three are the item's scope, so they are asserted rather than assumed: a
  // later edit that dropped the family would still pass the SDK's checks, because a
  // facts-only provider is legal.
  assertEquals(linearProviderManifest.families, ["tickets"]);
  assertEquals(linearProviderManifest.connect.kind, "oauth2");
  assertEquals(linearProviderManifest.slug, "linear");
  assertEquals(linearProviderManifest.integrationId, "bakery.linear");
  // No code family: claiming one would make the engine ask Linear for branches.
  assertFalse(linearProviderManifest.families.includes("code" as never));
});

Deno.test("the OAuth2 profile asks for reads and the two writes the port makes", () => {
  const profile = linearServerProvider.impl.connect;
  assertEquals(profile.authorizeUrl.hostname, "linear.app");
  assertEquals(profile.tokenUrl.hostname, "api.linear.app");
  assertEquals([...profile.scopes], [
    "read",
    "issues:create",
    "comments:create",
  ]);
  // `write` grants every mutation Linear has; the port makes two.
  assertFalse(profile.scopes.includes("write"));
});

Deno.test("every documented state type maps to a distinct rank, in pipeline order", () => {
  const ranks = LINEAR_STATE_TYPES.map((type, index) => {
    const status = statusOf({ id: `state-${index}`, name: type, type });
    assertEquals(status?.rank, index);
    return status?.rank;
  });
  assertEquals(new Set(ranks).size, LINEAR_STATE_TYPES.length);
});

Deno.test("a team's own state name is the label and its type decides the rank", () => {
  // A team that renamed "In Progress" keeps its word on screen, and the rank comes
  // from `started` so grouping is comparable with a team that kept the default.
  const status = statusOf({
    id: "state-1",
    name: "Being discussed",
    type: "started",
  });
  assertEquals(status?.label, "Being discussed");
  assertEquals(status?.rank, LINEAR_STATE_TYPES.indexOf("started"));
});

Deno.test("an undocumented state type has no status rather than a guessed one", () => {
  // Folding an unknown type into `unstarted` would report a status nobody chose and
  // fire a trigger on the wrong move.
  assertEquals(
    statusOf({ id: "s", name: "Research", type: "research" }),
    undefined,
  );
});

Deno.test("a trigger fires on the type it names, and not on a move inside one", () => {
  const started = { id: "a", name: "In Progress", type: "started" };
  const review = { id: "b", name: "In Review", type: "started" };
  const done = { id: "c", name: "Done", type: "completed" };

  assertEquals(
    statusTriggerFires({ kind: "entered", type: "completed" }, {
      from: review,
      to: done,
    }),
    true,
  );
  assertEquals(
    statusTriggerFires({ kind: "left", type: "started" }, {
      from: started,
      to: done,
    }),
    true,
  );
  // Two states of one type: the type did not change, so a typed trigger must not
  // fire - that move is a cosmetic edit, and work started on it would be spurious.
  assertEquals(
    statusTriggerFires({ kind: "entered", type: "started" }, {
      from: started,
      to: review,
    }),
    false,
  );
  // `changed` is the trigger for exactly that move.
  assertEquals(
    statusTriggerFires({ kind: "changed" }, { from: started, to: review }),
    true,
  );
});

Deno.test("a new ticket satisfies entered and never left", () => {
  const backlog = { id: "a", name: "Backlog", type: "backlog" };
  assertEquals(
    statusTriggerFires({ kind: "entered", type: "backlog" }, { to: backlog }),
    true,
  );
  assertEquals(
    statusTriggerFires({ kind: "left", type: "backlog" }, { to: backlog }),
    false,
  );
});

Deno.test("a valid signature verifies and a forged one is refused", () => {
  const payload = body({
    action: "update",
    type: "Issue",
    webhookId: "delivery-1",
    webhookTimestamp: Date.now(),
    organizationId: "org-1",
    data: { id: "issue-1" },
  });
  const ok = linearServerProvider.impl.ingress.verify({
    body: payload,
    headers: new Headers([[
      LINEAR_SIGNATURE_HEADER,
      hex(signatureFor(payload)),
    ]]),
    secrets: [secret],
    now: new Date(),
    signatureMatches,
  });
  assertEquals(ok.ok, true);
  assertEquals(ok.ok === true ? ok.deliveryId : null, "delivery-1");

  const forged = linearServerProvider.impl.ingress.verify({
    body: payload,
    headers: new Headers([[
      LINEAR_SIGNATURE_HEADER,
      hex(signatureFor(payload, new TextEncoder().encode("not-the-secret"))),
    ]]),
    secrets: [secret],
    now: new Date(),
    signatureMatches,
  });
  assertEquals(forged, { ok: false, reason: "signature" });
});

Deno.test("an unset secret never verifies, and a rotation list still finds the real one", () => {
  const payload = body({
    action: "update",
    type: "Issue",
    webhookId: "delivery-2",
    webhookTimestamp: Date.now(),
    organizationId: "org-1",
    data: { id: "issue-2" },
  });
  const empty = new Uint8Array();
  // A real HMAC accepts a delivery signed with an empty key, so a webhook with no
  // secret configured would verify anything the sender signed with nothing. Only
  // the guard in `verify` stands between the two.
  assertEquals(
    signatureMatches({
      secret: empty,
      body: payload,
      signature: signatureFor(payload, empty),
    }),
    true,
  );
  const headers = new Headers([[
    LINEAR_SIGNATURE_HEADER,
    hex(signatureFor(payload, empty)),
  ]]);
  const verify = (secrets: Uint8Array[], signed: Headers) =>
    linearServerProvider.impl.ingress.verify({
      body: payload,
      headers: signed,
      secrets,
      now: new Date(),
      signatureMatches,
    });
  assertEquals(verify([empty], headers), { ok: false, reason: "signature" });
  // A rotation window that holds an unset slot next to the real secret still
  // verifies with the real one, and still refuses the empty-key signature.
  const realHeaders = new Headers([[
    LINEAR_SIGNATURE_HEADER,
    hex(signatureFor(payload)),
  ]]);
  assertEquals(verify([empty, secret], realHeaders).ok, true);
  assertEquals(verify([empty, secret], headers), {
    ok: false,
    reason: "signature",
  });
});

/** Verifies a signed body at `now`, the way the host would hand it to the port. */
const verifySigned = (payload: Uint8Array, now = new Date()) =>
  linearServerProvider.impl.ingress.verify({
    body: payload,
    headers: new Headers([[
      LINEAR_SIGNATURE_HEADER,
      hex(signatureFor(payload)),
    ]]),
    secrets: [secret],
    now,
    signatureMatches,
  });

Deno.test("a signed delivery with no usable timestamp is refused, not let past the window", () => {
  const base = {
    action: "update",
    type: "Issue",
    organizationId: "org-1",
    data: { id: "issue-1" },
  };
  // Absent, null and a string are what a body JSON can carry instead of a number;
  // a skipped freshness check would accept every one of them at any age.
  for (const webhookTimestamp of [undefined, null, "1700000000000"]) {
    assertEquals(
      verifySigned(body({ ...base, webhookTimestamp })),
      { ok: false, reason: "malformed" },
      String(webhookTimestamp),
    );
  }
  assertEquals(
    verifySigned(body({ ...base, webhookTimestamp: Date.now() })).ok,
    true,
  );
});

Deno.test("a routed delivery must name its workspace, at the top level of the body", () => {
  const base = {
    action: "update",
    webhookTimestamp: Date.now(),
    data: { id: "issue-1", issueId: "issue-1" },
  };
  for (const type of ["Issue", "Comment"]) {
    // Missing, empty, blank, and the old wrong place (inside `data`).
    for (
      const named of [
        {},
        { organizationId: "" },
        { organizationId: "   " },
        { organizationId: 7 },
        { data: { ...base.data, organizationId: "org-1" } },
      ]
    ) {
      assertEquals(
        verifySigned(body({ ...base, type, ...named })),
        { ok: false, reason: "malformed" },
        `${type} ${JSON.stringify(named)}`,
      );
    }
    assertEquals(
      verifySigned(body({ ...base, type, organizationId: "org-1" })).ok,
      true,
    );
  }
  // A delivery this provider never routes does not need a workspace to be ignored.
  assertEquals(
    verifySigned(body({ ...base, type: "Attachment" })).ok,
    true,
  );
});

Deno.test("no verifier means refusal, never acceptance", () => {
  // The host supplies the HMAC. A provider that accepted a delivery without one
  // would accept any forgery the moment the wiring was misconfigured.
  const payload = body({ action: "update", type: "Issue", data: {} });
  const result = linearServerProvider.impl.ingress.verify({
    body: payload,
    headers: new Headers([[
      LINEAR_SIGNATURE_HEADER,
      hex(signatureFor(payload)),
    ]]),
    secrets: [secret],
    now: new Date(),
  });
  assertEquals(result, { ok: false, reason: "signature" });
});

Deno.test("an old or future delivery is stale, and the window is the stated one", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const at = (offset: number) =>
    body({
      action: "update",
      type: "Issue",
      webhookTimestamp: now.getTime() + offset,
      organizationId: "org-1",
      data: { id: "issue-1" },
    });
  const verify = (payload: Uint8Array) =>
    linearServerProvider.impl.ingress.verify({
      body: payload,
      headers: new Headers([[
        LINEAR_SIGNATURE_HEADER,
        hex(signatureFor(payload)),
      ]]),
      secrets: [secret],
      now,
      signatureMatches,
    });

  assertEquals(verify(at(0)).ok, true);
  assertEquals(verify(at(-LINEAR_REPLAY_WINDOW_MS + 1)).ok, true);
  assertEquals(verify(at(-LINEAR_REPLAY_WINDOW_MS - 1)), {
    ok: false,
    reason: "stale",
  });
  // A future timestamp is refused too: it would otherwise stay inside the window
  // for as long as the sender chose.
  assertEquals(verify(at(LINEAR_REPLAY_WINDOW_MS + 1)), {
    ok: false,
    reason: "stale",
  });
});

Deno.test("a signed body this provider cannot read is ignored, not refused", () => {
  // The signature proves who sent it; it does not prove the body is an issue
  // delivery. Refusing here would fail the delivery permanently, and acknowledging
  // it costs nothing because classification ignores it.
  const payload = new TextEncoder().encode("<html>not json</html>");
  const result = linearServerProvider.impl.ingress.verify({
    body: payload,
    headers: new Headers([[
      LINEAR_SIGNATURE_HEADER,
      hex(signatureFor(payload)),
    ]]),
    secrets: [secret],
    now: new Date(),
    signatureMatches,
  });
  assertEquals(result.ok, true);
  assertEquals(
    linearServerProvider.impl.ingress.classify(
      result.ok === true ? result.delivery : null,
    ),
    { kind: "ignored" },
  );
});

Deno.test("an issue delivery routes to a ticket refresh naming the issue", () => {
  const delivery = {
    action: "update",
    type: "Issue",
    webhookId: "delivery-1",
    organizationId: "org-1",
    data: { id: "issue-1" },
  };
  const classified = linearServerProvider.impl.ingress.classify(delivery);
  assertEquals(classified.kind, "routed");
  if (classified.kind !== "routed") throw new Error("expected routed");
  assertEquals(classified.intents, [{
    kind: "refresh",
    subject: "ticket",
    resourceExternalId: "issue-1",
    subjectExternalId: "issue-1",
  }]);
  assertEquals(classified.externalAuthorizationId, "org-1");
});

Deno.test("a comment delivery routes to the issue it was written on", () => {
  const classified = linearServerProvider.impl.ingress.classify({
    action: "create",
    type: "Comment",
    organizationId: "org-1",
    data: { id: "comment-1", issueId: "issue-9" },
  });
  if (classified.kind !== "routed") throw new Error("expected routed");
  // The comment names no issue unless `issueId` is read: `data.id` is the comment.
  assertEquals(classified.intents[0], {
    kind: "refresh",
    subject: "ticket",
    resourceExternalId: "issue-9",
    subjectExternalId: "issue-9",
  });
});

Deno.test("an event outside the ticket family is ignored", () => {
  for (
    const type of ["Document", "Attachment", "Project", "Cycle"]
  ) {
    assertEquals(
      linearServerProvider.impl.ingress.classify({
        action: "update",
        type,
        data: { id: "x" },
      }),
      { kind: "ignored" },
      `${type} must not move work`,
    );
  }
});

Deno.test("a delivery naming no issue is ignored rather than routed", () => {
  // Routing to an empty external id would make the host write a projection keyed on
  // the empty string, which is a row nothing can ever reach.
  assertEquals(
    linearServerProvider.impl.ingress.classify({
      action: "update",
      type: "Issue",
      organizationId: "org-1",
      data: {},
    }),
    { kind: "ignored" },
  );
});

Deno.test("isLinearWebhookBody reads type and action, nothing more", () => {
  assertEquals(isLinearWebhookBody({ type: "Issue", action: "update" }), true);
  assertEquals(isLinearWebhookBody({ type: "Issue" }), false);
  assertEquals(isLinearWebhookBody(null), false);
  assertEquals(isLinearWebhookBody("Issue"), false);
});

/** Lowercase hex, so a test failure shows the digest rather than an array. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
