import { assert, assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  admitDelivery,
  type RoutedDelivery,
} from "../../apps/server/src/modules/integrations/ingress-admission.ts";
import { githubIngress } from "../../apps/server/src/modules/catalog/integration-providers/github-ingress.ts";
import { hmacSha256 } from "../../apps/server/src/modules/catalog/integration-providers/webhook-signature.ts";
import type { WebhookIngress } from "@bakery/integration-sdk";

/**
 * The wiring between the ingress port and the host (#408 slice 6).
 *
 * `github-ingress.ts` is tested on its own for what it decides. These tests
 * cover the seam the host owns: that the ceiling is enforced before a signature
 * is checked, that every verify failure is one indistinguishable answer, that a
 * delivery with no id is refused because it could not be deduplicated, and that
 * each classified intent becomes the host's own vocabulary rather than being
 * dropped.
 *
 * The port is real throughout. A stand-in would let a test pass while the seam
 * disagreed with the provider it actually runs.
 */

const enc = (value: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(value);
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

const SECRET = enc("a-webhook-secret");
const NOW = new Date("2026-11-18T12:00:00.000Z");

/** A body GitHub would actually send, signed with the test secret. */
function signed(
  payload: unknown,
  headers: Record<string, string> = {},
) {
  const body = enc(JSON.stringify(payload));
  return {
    body,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(SECRET, body))}`,
      "x-github-event": "installation",
      "x-github-delivery": "delivery-1",
      ...headers,
    }),
    secrets: [SECRET],
    now: NOW,
  };
}

const installation = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  installation: { id: 42 },
  ...extra,
});

Deno.test("a verified delivery reaches the host with its id and its intents", () => {
  const admitted = admitDelivery(
    githubIngress,
    signed(installation("created")),
  );
  assertEquals(admitted.deliveryId, "delivery-1");
  assertEquals(admitted.routed, [{ kind: "lifecycle", event: "installed" }]);
});

Deno.test("oversize is refused before the signature is checked", () => {
  const input = signed(installation("created"));
  // One byte over the port's own declared ceiling, without a valid signature:
  // if the size check ran second, the error would be the signature's.
  const oversize = {
    ...input,
    body: new Uint8Array(githubIngress.maxBodyBytes + 1),
    headers: new Headers({ "x-hub-signature-256": "sha256=nonsense" }),
  };
  const error = assertThrows(
    () => admitDelivery(githubIngress, oversize),
    StandardError,
  );
  assertEquals(error.code, "BODY_TOO_LARGE");
});

Deno.test("every verify failure is one answer, so the endpoint cannot test secrets", () => {
  const body = enc(JSON.stringify(installation("created")));
  const cases: Headers[] = [
    // No signature at all.
    new Headers({ "x-github-event": "installation", "x-github-delivery": "d" }),
    // A signature of the right shape under the wrong secret.
    new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(enc("wrong"), body))}`,
      "x-github-event": "installation",
      "x-github-delivery": "d",
    }),
    // A malformed signature header.
    new Headers({
      "x-hub-signature-256": "sha1=abcd",
      "x-github-event": "installation",
      "x-github-delivery": "d",
    }),
  ];
  for (const headers of cases) {
    const error = assertThrows(
      () =>
        admitDelivery(githubIngress, {
          body,
          headers,
          secrets: [SECRET],
          now: NOW,
        }),
      StandardError,
    );
    // The same code for a forgery, a bad secret and a malformed signature
    // header: the caller learns nothing about which one it was.
    assertEquals(error.code, "AUTH_INVALID");
  }
});

Deno.test("a validly signed delivery without its id or event header is malformed, not unauthorised", () => {
  const body = enc(JSON.stringify(installation("created")));
  const signature = `sha256=${hex(hmacSha256(SECRET, body))}`;
  for (
    const headers of [
      new Headers({
        "x-hub-signature-256": signature,
        "x-github-event": "installation",
      }),
      new Headers({
        "x-hub-signature-256": signature,
        "x-github-delivery": "d",
      }),
    ]
  ) {
    const error = assertThrows(
      () =>
        admitDelivery(githubIngress, {
          body,
          headers,
          secrets: [SECRET],
          now: NOW,
        }),
      StandardError,
    );
    assertEquals(error.code, "MALFORMED_REQUEST");
  }
  // And without the signature the same missing headers are still a refusal to
  // authenticate: the 400 is only for a sender that proved it holds the secret.
  const unsigned = assertThrows(
    () =>
      admitDelivery(githubIngress, {
        body,
        headers: new Headers({ "x-github-event": "installation" }),
        secrets: [SECRET],
        now: NOW,
      }),
    StandardError,
  );
  assertEquals(unsigned.code, "AUTH_INVALID");
});

Deno.test("a delivery naming no installation is acknowledged as ignored", () => {
  // GitHub sends App-level and marketplace events that are legitimately about
  // no installation. They are not errors, and inventing work for them would
  // make every such delivery a write.
  const admitted = admitDelivery(
    githubIngress,
    signed({ action: "created" }),
  );
  assertEquals(admitted.routed, [{ kind: "ignored" }]);
});

Deno.test("a payload naming an installation it cannot route is still a delivery", () => {
  const admitted = admitDelivery(
    githubIngress,
    signed({ action: "created", installation: { id: -5 } }),
  );
  // A non-positive id is not an installation, so the provider answers `ignored`
  // rather than routing to an id that names nothing.
  assertEquals(admitted.routed, [{ kind: "ignored" }]);
});

Deno.test("each intent becomes the host's own vocabulary", () => {
  const cases: readonly [string, Record<string, unknown>, RoutedDelivery][] = [
    [
      "installation",
      installation("suspended"),
      { kind: "lifecycle", event: "suspended" },
    ],
    [
      "installation",
      installation("deleted"),
      { kind: "lifecycle", event: "revoked" },
    ],
    [
      "push",
      { installation: { id: 42 }, repository: { id: 900 } },
      { kind: "discovery" },
    ],
    [
      "issues",
      {
        action: "opened",
        installation: { id: 42 },
        repository: { id: 900 },
        issue: { id: 77 },
      },
      {
        kind: "refresh",
        subject: "ticket",
        resourceExternalId: "900",
        subjectExternalId: "77",
      },
    ],
    [
      "pull_request",
      {
        action: "opened",
        installation: { id: 42 },
        repository: { id: 900 },
        pull_request: { id: 88 },
      },
      {
        kind: "refresh",
        subject: "change",
        resourceExternalId: "900",
        subjectExternalId: "88",
      },
    ],
    [
      "check_run",
      {
        action: "completed",
        installation: { id: 42 },
        repository: { id: 900 },
        check_run: { id: 99 },
      },
      {
        kind: "refresh",
        subject: "check",
        resourceExternalId: "900",
        subjectExternalId: "99",
      },
    ],
  ];
  for (const [event, payload, expected] of cases) {
    const admitted = admitDelivery(
      githubIngress,
      signed(payload, { "x-github-event": event }),
    );
    assertEquals(admitted.routed, [expected], `event ${event}`);
  }
});

Deno.test("the provider's payload is carried through untouched", () => {
  // The projection step that follows reads the payload, so the seam must not
  // reshape or filter it: whatever the provider said is what the host sees.
  const payload = {
    action: "created",
    installation: { id: 42, account: { login: "someone" } },
    repositories: [{ id: 900 }],
  };
  const admitted = admitDelivery(githubIngress, signed(payload));
  assertEquals(admitted.projection, payload);
});

Deno.test("a provider that verifies but names no delivery id is refused by the seam", () => {
  // The id is the receipt's key. Without one the host would key on a digest it
  // was never told to compute, so two different deliveries could collide.
  //
  // GitHub always sends one and its own ingress refuses a delivery without one,
  // so this drives the seam with a provider that verifies happily and omits the
  // id: the guard under test is the seam's, not the provider's.
  const permissive: WebhookIngress = {
    ...githubIngress,
    verify: () => ({ ok: true, delivery: { anything: true } }),
    classify: () => ({
      kind: "routed",
      externalAuthorizationId: "42",
      projection: {},
      intents: [{ kind: "discovery" }],
    }),
  };
  const error = assertThrows(
    () =>
      admitDelivery(permissive, {
        body: enc("{}"),
        headers: new Headers(),
        secrets: [SECRET],
        now: NOW,
      }),
    StandardError,
  );
  assertEquals(error.code, "MALFORMED_REQUEST");

  // And a provider that does name one is admitted, so the guard refuses only
  // the case it is for.
  const named: WebhookIngress = {
    ...permissive,
    verify: () => ({ ok: true, delivery: {}, deliveryId: "d-1" }),
  };
  assertEquals(
    admitDelivery(named, {
      body: enc("{}"),
      headers: new Headers(),
      secrets: [SECRET],
      now: NOW,
    }).deliveryId,
    "d-1",
  );

  // GitHub's own ingress still refuses an id-less delivery earlier, as
  // malformed at verify: a provider-level refusal the seam never sees.
  const body = enc(JSON.stringify(installation("created")));
  assertEquals(
    githubIngress.verify({
      body,
      headers: new Headers({
        "x-hub-signature-256": `sha256=${hex(hmacSha256(SECRET, body))}`,
        "x-github-event": "installation",
      }),
      secrets: [SECRET],
      now: NOW,
    }),
    { ok: false, reason: "malformed" },
  );
});

Deno.test("the ceiling the seam enforces is the one the provider declared", () => {
  // Not a number chosen here: the provider's stated bound is what the host
  // reads, so a provider that declares a smaller ceiling is honoured.
  assertEquals(githubIngress.maxBodyBytes, 262_144);
  const atLimit = signed(installation("created"));
  assert(atLimit.body.byteLength < githubIngress.maxBodyBytes);
  // The largest body the provider accepts still verifies.
  const admitted = admitDelivery(githubIngress, atLimit);
  assertEquals(admitted.deliveryId, "delivery-1");
});

Deno.test("the secrets are released after verification, never before it", () => {
  // QA's second mutant: calling `releaseSecrets` before `verify` still releases
  // exactly once, so a counter cannot see the difference. What it changes is
  // whether the secret is still readable when the signature is compared, so the
  // observation has to happen inside `verify`.
  const order: string[] = [];
  const watching: WebhookIngress = {
    ...githubIngress,
    verify: (input) => {
      // The secret must still be intact at this point; a wipe here would make
      // every signature fail in production while still "releasing once".
      order.push(`verify:secret=${input.secrets[0]?.byteLength ?? 0}`);
      return githubIngress.verify(input);
    },
  };
  admitDelivery(watching, {
    ...signed(installation("created")),
    releaseSecrets: () => order.push("release"),
  });
  assertEquals(
    order,
    ["verify:secret=16", "release"],
    "verify first, then release",
  );

  // And a body the provider refuses is never verified, so release must still
  // happen even though `verify` was skipped entirely.
  order.length = 0;
  const narrow: WebhookIngress = { ...watching, maxBodyBytes: 8 };
  assertThrows(() =>
    admitDelivery(narrow, {
      ...signed(installation("created")),
      releaseSecrets: () => order.push("release"),
    })
  );
  assertEquals(order, ["release"], "released even though verify never ran");
});

Deno.test("the secrets are released exactly once on every exit", () => {
  // QA found the release was only exercised through the route, so every unit
  // test passed whether or not `admitDelivery` called it. These cases pin the
  // call site instead: once, after verification, on every path.
  const body = enc(JSON.stringify(installation("created")));
  const good = signed(installation("created"));

  const count = (fn: () => unknown): number => {
    const released = 0;
    try {
      fn();
    } catch {
      // The outcome does not matter here; only whether release ran.
    }
    return released;
  };

  // A successful delivery.
  let releases = 0;
  admitDelivery(githubIngress, {
    ...good,
    releaseSecrets: () => {
      releases += 1;
    },
  });
  assertEquals(releases, 1, "released once on success");

  // A bad signature: the failing path must release too.
  releases = 0;
  assertThrows(() =>
    admitDelivery(githubIngress, {
      body,
      headers: new Headers({
        "x-hub-signature-256": `sha256=${hex(hmacSha256(enc("wrong"), body))}`,
        "x-github-event": "installation",
        "x-github-delivery": "d",
      }),
      secrets: [SECRET],
      now: NOW,
      releaseSecrets: () => {
        releases += 1;
      },
    })
  );
  assertEquals(releases, 1, "released once on a bad signature");

  // A verify that throws rather than answering: still released.
  releases = 0;
  const throwing: WebhookIngress = {
    ...githubIngress,
    verify: () => {
      throw new Error("provider blew up");
    },
  };
  assertThrows(() =>
    admitDelivery(throwing, {
      ...good,
      releaseSecrets: () => {
        releases += 1;
      },
    })
  );
  assertEquals(releases, 1, "released once when verify throws");

  // The case QA named as the LOW: a provider whose ceiling is smaller than the
  // body, so the refusal happens before verification ever runs. A `finally`
  // scoped only to `verify` would leak here.
  releases = 0;
  const narrow: WebhookIngress = { ...githubIngress, maxBodyBytes: 8 };
  const tooLarge = assertThrows(
    () =>
      admitDelivery(narrow, {
        ...good,
        releaseSecrets: () => {
          releases += 1;
        },
      }),
    StandardError,
  );
  assertEquals(tooLarge.code, "BODY_TOO_LARGE");
  assertEquals(releases, 1, "released once on an oversize refusal");

  // And nothing is released when the caller has no secret to release.
  assertEquals(count(() => admitDelivery(githubIngress, good)), 0);
});

Deno.test("an empty or whitespace delivery id is absent, not a key", () => {
  // The `undefined` mutant died; the empty string is the other way a provider
  // can fail to name a delivery, and it must be refused the same way.
  for (const deliveryId of ["", "   "]) {
    const permissive: WebhookIngress = {
      ...githubIngress,
      verify: () => ({ ok: true, delivery: {}, deliveryId }),
      classify: () => ({
        kind: "routed",
        externalAuthorizationId: "42",
        projection: {},
        intents: [{ kind: "discovery" }],
      }),
    };
    const error = assertThrows(
      () =>
        admitDelivery(permissive, {
          body: enc("{}"),
          headers: new Headers(),
          secrets: [SECRET],
          now: NOW,
        }),
      StandardError,
    );
    assertEquals(error.code, "MALFORMED_REQUEST", JSON.stringify(deliveryId));
  }
});
