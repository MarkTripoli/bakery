import { assert, assertEquals } from "@std/assert";
import type { IntakeIntent } from "@bakery/integration-sdk";
import { githubIngress } from "../../apps/server/src/modules/catalog/integration-providers/github-ingress.ts";
import { hmacSha256 } from "../../apps/server/src/modules/catalog/integration-providers/webhook-signature.ts";
import { INTAKE_MAX_BODY_BYTES } from "../../apps/server/src/modules/integrations/intake-body.ts";

/**
 * #408 slice 5: the GitHub delivery ingress behind the SDK's `WebhookIngress`.
 *
 * The first test pins the HMAC wrapper against Web Crypto, so the port cannot
 * drift from the primitive it claims to use; everything after it tests the
 * port's decisions, which is what the core relies on when it hands the provider
 * exact bytes.
 */

const enc = (value: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(value);
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const secret = enc("a-webhook-secret");
const NOW = new Date("2026-11-18T12:00:00.000Z");

const installation = (action: string, extra: Record<string, unknown> = {}) => ({
  event: "installation",
  action,
  installation: { id: 42 },
  ...extra,
});

Deno.test("the signature primitive agrees with Web Crypto", async () => {
  const cases: Array<[string, string]> = [
    ["key", "The quick brown fox jumps over the lazy dog"],
    ["secret", "x".repeat(1_000)],
    ["k".repeat(200), "a key longer than one block is hashed first"],
    ["k".repeat(64), "a key of exactly one block is not hashed"],
    ["k".repeat(65), "a key one byte over a block is hashed"],
  ];
  for (const [key, message] of cases) {
    const imported = await crypto.subtle.importKey(
      "raw",
      enc(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", imported, enc(message)),
    ) as Uint8Array<ArrayBuffer>;
    assertEquals(
      hex(hmacSha256(enc(key), enc(message))),
      hex(expected),
      `key ${key.length} bytes, message ${message.length} bytes`,
    );
  }
});

Deno.test("digest comparison is length-checked and constant-shape", async () => {
  const { equalDigests } = await import(
    "../../apps/server/src/modules/catalog/integration-providers/webhook-signature.ts"
  );
  const left = hmacSha256(secret, enc("a"));
  assertEquals(equalDigests(left, hmacSha256(secret, enc("a"))), true);
  assertEquals(equalDigests(left, hmacSha256(secret, enc("b"))), false);
  assertEquals(equalDigests(left, left.subarray(0, 31)), false);
  assertEquals(equalDigests(new Uint8Array(), new Uint8Array()), true);
});

Deno.test("a signed delivery of the exact bytes is accepted", () => {
  const body = enc(JSON.stringify(installation("created")));
  const result = githubIngress.verify({
    body,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, body))}`,
      "x-github-event": "installation",
      "x-github-delivery": "d1",
    }),
    secrets: [secret],
    now: NOW,
  });
  assertEquals(result.ok, true);
});

Deno.test("one flipped byte of the body is refused as a signature failure", () => {
  const body = enc(JSON.stringify(installation("created")));
  const signature = `sha256=${hex(hmacSha256(secret, body))}`;
  const tampered = new Uint8Array(body);
  tampered[tampered.length - 2] ^= 0x01;
  const result = githubIngress.verify({
    body: tampered,
    headers: new Headers({
      "x-hub-signature-256": signature,
      "x-github-event": "installation",
      "x-github-delivery": "d1",
    }),
    secrets: [secret],
    now: NOW,
  });
  assertEquals(result, { ok: false, reason: "signature" });
});

/**
 * Mutant note: "drop the signature presence check" survives this file, and it is
 * an equivalent mutant rather than a gap. Both refusals - an absent or unparseable
 * `x-hub-signature-256`, and no candidate secret at all - answer the same
 * `{ ok: false, reason: "signature" }`, so moving the null test into the comparison
 * below it, or deleting it and letting an empty secret list fail to match, changes
 * no observable outcome. Verified by applying both refactors and re-running this
 * file: 20 passed either way. A test cannot kill it without inventing a reason
 * string the ingress deliberately does not have - it does not disclose which check
 * refused, and that is the security property, not an oversight.
 */
Deno.test("a wrong secret, a wrong length and no secret are all refused", () => {
  const body = enc(JSON.stringify(installation("created")));
  const signature = `sha256=${hex(hmacSha256(secret, body))}`;
  const at = (headers: Record<string, string>, secrets: Uint8Array[]) =>
    githubIngress.verify({
      body,
      headers: new Headers({
        "x-github-event": "installation",
        "x-github-delivery": "d1",
        ...headers,
      }),
      secrets,
      now: NOW,
    });

  assertEquals(
    at({ "x-hub-signature-256": signature }, [enc("another-secret")]),
    { ok: false, reason: "signature" },
  );
  // A truncated signature is well formed to a reader but cannot be the digest.
  assertEquals(
    at({ "x-hub-signature-256": `sha256=${"a".repeat(62)}` }, [secret]),
    { ok: false, reason: "signature" },
  );
  assertEquals(at({}, [secret]), { ok: false, reason: "signature" });
  // No candidate at all, and an empty candidate: an unset secret never verifies.
  assertEquals(
    at({ "x-hub-signature-256": signature }, []),
    { ok: false, reason: "signature" },
  );
  assertEquals(
    at({ "x-hub-signature-256": signature }, [new Uint8Array()]),
    { ok: false, reason: "signature" },
  );
});

Deno.test("a rotation window accepts either secret", () => {
  const body = enc(JSON.stringify(installation("created")));
  const old = enc("the-previous-secret");
  const oldSignature = `sha256=${hex(hmacSha256(old, body))}`;
  const result = githubIngress.verify({
    body,
    headers: new Headers({
      "x-hub-signature-256": oldSignature,
      "x-github-event": "installation",
      "x-github-delivery": "d1",
    }),
    secrets: [secret, old],
    now: NOW,
  });
  assertEquals(result.ok, true);
});

Deno.test("an old delivery is refused as stale and a fresh one is not", () => {
  const stalePayload = {
    ...installation("created"),
    delivery_timestamp: "2026-11-18T05:00:00.000Z",
  };
  const stale = enc(JSON.stringify(stalePayload));
  const refused = githubIngress.verify({
    body: stale,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, stale))}`,
      "x-github-event": "installation",
      "x-github-delivery": "d1",
    }),
    secrets: [secret],
    now: NOW,
  });
  assertEquals(refused, { ok: false, reason: "stale" });

  // The same body, sent two hours ago: inside GitHub's three-hour retry window.
  const freshPayload = {
    ...installation("created"),
    delivery_timestamp: "2026-11-18T10:00:00.000Z",
  };
  const fresh = enc(JSON.stringify(freshPayload));
  assertEquals(
    githubIngress.verify({
      body: fresh,
      headers: new Headers({
        "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, fresh))}`,
        "x-github-event": "installation",
        "x-github-delivery": "d1",
      }),
      secrets: [secret],
      now: NOW,
    }).ok,
    true,
  );
});

Deno.test("a delivery with no timestamp is not refused as a replay", () => {
  // Refusing it would hide a body the provider could read: staleness is a
  // guess about time, and there is no time to guess from.
  const result = githubIngress.verify({
    body: enc(JSON.stringify(installation("created"))),
    headers: new Headers({
      "x-hub-signature-256": `sha256=${
        hex(hmacSha256(secret, enc(JSON.stringify(installation("created")))))
      }`,
      "x-github-event": "installation",
      "x-github-delivery": "d1",
    }),
    secrets: [secret],
    now: NOW,
  });
  assertEquals(result.ok, true);
});

Deno.test("a signed body this provider cannot read is ignored, not refused", () => {
  // This used to answer `malformed`, which was wrong in two ways a real
  // delivery proved (see the integration lane):
  //
  //   - GitHub also sends legacy form-encoded deliveries, whose body is not
  //     JSON at all;
  //   - an event this provider does not mirror is acknowledged without reading
  //     its body, which is a security property, not a leniency.
  //
  // The signature is what proves the sender, and it is still required. Whether
  // an unreadable body is an error depends on the event, and only the host
  // knows which events it consumes, so this provider answers `ignored` and the
  // host's projection step still refuses a corrupt body for an event it does
  // consume.
  for (const body of [enc("not json"), enc("[]"), enc('"a string"')]) {
    const result = githubIngress.verify({
      body,
      headers: new Headers({
        "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, body))}`,
        "x-github-event": "star",
        "x-github-delivery": "d1",
      }),
      secrets: [secret],
      now: NOW,
    });
    assert(
      result.ok,
      `unreadable body verified: ${new TextDecoder().decode(body)}`,
    );
    assertEquals(githubIngress.classify(result.delivery), { kind: "ignored" });
  }

  // A body that names no event or no delivery id is still not a delivery.
  for (
    const headers of [
      new Headers({
        "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, enc("{}")))}`,
        "x-github-delivery": "d1",
      }),
      new Headers({
        "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, enc("{}")))}`,
        "x-github-event": "push",
      }),
    ]
  ) {
    assertEquals(
      githubIngress.verify({
        body: enc("{}"),
        headers,
        secrets: [secret],
        now: NOW,
      }),
      { ok: false, reason: "malformed" },
    );
  }
});

Deno.test("the declared body ceiling is the host's, not GitHub's 25 MB", () => {
  assertEquals(githubIngress.maxBodyBytes, INTAKE_MAX_BODY_BYTES);
  assert(githubIngress.maxBodyBytes <= 256 * 1024);
});

const classify = (payload: unknown) => {
  const verified = githubIngress.verify({
    body: enc(JSON.stringify(payload)),
    headers: new Headers({
      "x-hub-signature-256": `sha256=${
        hex(hmacSha256(secret, enc(JSON.stringify(payload))))
      }`,
      "x-github-event": String(
        (payload as Record<string, unknown> | null)?.event ?? "push",
      ),
      "x-github-delivery": "d1",
    }),
    secrets: [secret],
    now: NOW,
  });
  assert(verified.ok, "the fixture is signed with the candidate secret");
  return githubIngress.classify(
    (verified as { delivery: unknown }).delivery,
  );
};

Deno.test("an installation delivery is a lifecycle intent in the SDK's words", () => {
  assertEquals(classify(installation("created")), {
    kind: "routed",
    externalAuthorizationId: "42",
    projection: installation("created"),
    intents: [{ kind: "lifecycle", event: "installed" }],
  });
  assertEquals(
    (classify(installation("suspended")) as {
      intents: readonly IntakeIntent[];
    }).intents,
    [{ kind: "lifecycle", event: "suspended" }],
  );
  // GitHub's `deleted` is the SDK's `revoked`: the installation is gone, not
  // merely suspended, and the host treats those two differently.
  assertEquals(
    (classify(installation("deleted")) as { intents: readonly IntakeIntent[] })
      .intents,
    [{ kind: "lifecycle", event: "revoked" }],
  );
  // `new_permissions_accepted` changes nothing about whether the installation
  // works, so it must not be read as an install.
  assertEquals(
    (classify(installation("new_permissions_accepted")) as {
      intents: readonly IntakeIntent[];
    })
      .intents,
    [{ kind: "discovery" }],
  );
});

Deno.test("an issue delivery is never read as an installation lifecycle", () => {
  const intents = (classify({
    event: "issues",
    action: "created",
    installation: { id: 42 },
    repository: { id: 900 },
    issue: { id: 7 },
  }) as { intents: readonly IntakeIntent[] }).intents;
  // An issue is a ticket. This assertion previously said `check`, which is what
  // the code did rather than what the SDK's vocabulary allows.
  assertEquals(intents, [{
    kind: "refresh",
    subject: "ticket",
    resourceExternalId: "900",
    subjectExternalId: "7",
  }]);
});

Deno.test("a delivery about no installation is ignored, not refused", () => {
  // GitHub's App-level ping and marketplace events are about no installation.
  assertEquals(classify({ event: "ping", zen: "hi" }), { kind: "ignored" });
  // `classify` is called with whatever a verified delivery carried, so a shape
  // the port never saw is answered rather than thrown on.
  assertEquals(githubIngress.classify(null), { kind: "ignored" });
  assertEquals(githubIngress.classify("a string"), { kind: "ignored" });
  // An installation id that is not a positive safe integer cannot name one.
  assertEquals(
    classify({
      event: "installation",
      action: "created",
      installation: { id: "42" },
    }),
    { kind: "ignored" },
  );
  assertEquals(
    classify({
      event: "installation",
      action: "created",
      installation: { id: -1 },
    }),
    { kind: "ignored" },
  );
});

Deno.test("a repository delivery the payload never names becomes a sweep", () => {
  // The set of reachable repositories may have changed, so the host re-sweeps
  // instead of applying a delta it cannot see.
  assertEquals(
    (classify({
      event: "installation_repositories",
      installation: { id: 42 },
    }) as {
      intents: readonly IntakeIntent[];
    }).intents,
    [{ kind: "discovery" }],
  );
  assertEquals(
    (classify({
      event: "push",
      installation: { id: 42 },
      repository: { id: 900 },
    }) as { intents: readonly IntakeIntent[] }).intents,
    [{ kind: "discovery" }],
  );
});

Deno.test("a prototype key never looks like a lifecycle action", () => {
  // `LIFECYCLE_ACTIONS[action]` on a plain object answers for `constructor`
  // and `toString` too, which put a function where a lifecycle event belongs.
  // Named after the object's own properties, not inherited ones.
  for (
    const action of ["constructor", "toString", "hasOwnProperty", "__proto__"]
  ) {
    // It falls through to the repository/no-repository branches rather than
    // claiming a lifecycle event, and never carries a function as its event.
    const result = classify({
      event: "installation",
      action,
      installation: { id: 42 },
    }) as { kind: string; intents?: readonly { kind: string }[] };
    assertEquals(result.kind, "routed");
    for (const intent of result.intents ?? []) {
      assert(intent.kind !== "lifecycle");
    }
  }
});

Deno.test("an issue delivery refreshes a ticket and a pull request a change", () => {
  // The SDK's vocabulary is ticket, change and check. Answering `check` for an
  // issue or a pull request handed the host the wrong engine subject, so it
  // looked up an id that names nothing there.
  const intent = (event: string, key: string) =>
    (classify({
      event,
      action: "opened",
      installation: { id: 42 },
      repository: { id: 900 },
      [key]: { id: 77 },
    }) as { intents: readonly IntakeIntent[] }).intents[0];

  assertEquals(intent("issues", "issue"), {
    kind: "refresh",
    subject: "ticket",
    resourceExternalId: "900",
    subjectExternalId: "77",
  });
  assertEquals(intent("issue_comment", "issue"), {
    kind: "refresh",
    subject: "ticket",
    resourceExternalId: "900",
    subjectExternalId: "77",
  });
  assertEquals(intent("pull_request", "pull_request"), {
    kind: "refresh",
    subject: "change",
    resourceExternalId: "900",
    subjectExternalId: "77",
  });
  assertEquals(intent("pull_request_review", "pull_request"), {
    kind: "refresh",
    subject: "change",
    resourceExternalId: "900",
    subjectExternalId: "77",
  });
  // Only a check-shaped event names a check.
  assertEquals(intent("check_run", "check_run"), {
    kind: "refresh",
    subject: "check",
    resourceExternalId: "900",
    subjectExternalId: "77",
  });
  assertEquals(intent("workflow_run", "workflow_run"), {
    kind: "refresh",
    subject: "check",
    resourceExternalId: "900",
    subjectExternalId: "77",
  });
});

Deno.test("the subject follows the event, not whichever key the payload carries", () => {
  // A pull request payload that also carries an `issue` object must not be read
  // as a ticket: searching for the first key that exists would let the payload's
  // shape choose the subject instead of what the delivery says it is.
  const both = (classify({
    event: "pull_request",
    action: "opened",
    installation: { id: 42 },
    repository: { id: 900 },
    issue: { id: 11 },
    pull_request: { id: 22 },
  }) as { intents: readonly IntakeIntent[] }).intents[0];
  assertEquals(both, {
    kind: "refresh",
    subject: "change",
    resourceExternalId: "900",
    subjectExternalId: "22",
  });

  // An issue event carrying no issue object is a discovery sweep, not a guess.
  assertEquals(
    (classify({
      event: "issues",
      action: "opened",
      installation: { id: 42 },
      repository: { id: 900 },
      pull_request: { id: 22 },
    }) as { intents: readonly IntakeIntent[] }).intents,
    [{ kind: "discovery" }],
  );
});

Deno.test("a real GitHub delivery carries no timestamp, so it is never stale", () => {
  // GitHub sends no delivery timestamp in a header or in the body:
  // `installation.updated_at` is when the installation changed, not when this
  // delivery was sent. A payload shaped exactly like a real one, with an
  // installation updated long ago, must still verify - the delivery id is what
  // refuses a replay, at the receipt.
  const real = enc(JSON.stringify({
    action: "created",
    installation: {
      id: 42,
      updated_at: "2020-01-01T00:00:00.000Z",
      created_at: "2020-01-01T00:00:00.000Z",
    },
    repositories: [{ id: 900 }],
    sender: { id: 7, login: "someone" },
  }));
  const result = githubIngress.verify({
    body: real,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, real))}`,
      "x-github-event": "installation",
      "x-github-delivery": "d-1",
    }),
    secrets: [secret],
    now: NOW,
  });
  assertEquals(result.ok, true);
});

Deno.test("a verified delivery exposes its id so a redelivery can be refused", () => {
  // The delivery id is the only replay guard that works for GitHub, because a
  // payload carries no send time. The port hands the id to the host, whose
  // receipt refuses a second application of the same id; without it the host has
  // nothing to key on and a replay applies twice.
  //
  // This test covers the port's half only - that the id leaves the ingress. The
  // receipt's half is proved against the real receipt and a real database in
  // `tests/helpers/github-intake/receipts-integration.ts` ("an exact duplicate
  // acknowledges the original receipt and writes nothing; changed bytes or
  // event name are refused"). A stand-in for the receipt was removed from this
  // file: it asserted the stand-in, so it could not have failed if the receipt
  // regressed.
  const body = enc(JSON.stringify({
    action: "created",
    installation: { id: 42 },
  }));
  const result = githubIngress.verify({
    body,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, body))}`,
      "x-github-event": "installation",
      "x-github-delivery": "redelivered-1",
    }),
    secrets: [secret],
    now: NOW,
  });
  assertEquals(result.ok, true);
  assertEquals(
    (result as { deliveryId?: string }).deliveryId,
    "redelivered-1",
  );

  // A delivery whose id is absent never verifies at all: GitHub always sends it,
  // and a delivery without one could not be deduplicated.
  const noId = githubIngress.verify({
    body,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, body))}`,
      "x-github-event": "installation",
    }),
    secrets: [secret],
    now: NOW,
  });
  assertEquals(noId, { ok: false, reason: "malformed" });

  // The id comes from the header, and only from the header. A body that carries its
  // own idea of a delivery id - a real GitHub body never does - must not be able to
  // choose the key the receipt deduplicates on, because then a sender could replay
  // one delivery under new keys forever. A mutant that prefers the body's id passes
  // every other test in this file: they all leave the body's id absent, so the
  // mutant only differs when both are present, which is the case below.
  const bodyWithId = enc(JSON.stringify({
    action: "created",
    installation: { id: 42 },
    deliveryId: "claimed-by-the-body",
  }));
  const spoofed = githubIngress.verify({
    body: bodyWithId,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, bodyWithId))}`,
      "x-github-event": "installation",
      "x-github-delivery": "from-the-header",
    }),
    secrets: [secret],
    now: NOW,
  });
  assertEquals(
    (spoofed as { deliveryId?: string }).deliveryId,
    "from-the-header",
    "a body must not name its own delivery id",
  );
});

Deno.test("a legacy form-encoded delivery reads the same as the JSON one", () => {
  // GitHub's older Apps post `payload=<urlencoded json>`. The route used to
  // parse that itself; now the provider does, because the encoding is GitHub's
  // wire format and the host should only ever see the payload.
  const payload = { action: "created", installation: { id: 42 } };
  const body = enc(`payload=${encodeURIComponent(JSON.stringify(payload))}`);
  const result = githubIngress.verify({
    body,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, body))}`,
      "x-github-event": "installation",
      "x-github-delivery": "d1",
      "content-type": "application/x-www-form-urlencoded",
    }),
    secrets: [secret],
    now: NOW,
  });
  assert(result.ok);
  const delivery = result.delivery as { payload: unknown };
  assertEquals(delivery.payload, payload);
  assertEquals(githubIngress.classify(result.delivery), {
    kind: "routed",
    externalAuthorizationId: "42",
    projection: payload,
    intents: [{ kind: "lifecycle", event: "installed" }],
  });

  // A form whose single field is not `payload` is not a GitHub delivery body.
  const other = enc("notpayload=%7B%7D");
  const rejected = githubIngress.verify({
    body: other,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${hex(hmacSha256(secret, other))}`,
      "x-github-event": "star",
      "x-github-delivery": "d1",
      "content-type": "application/x-www-form-urlencoded",
    }),
    secrets: [secret],
    now: NOW,
  });
  // Unreadable, not refused: the signature is what proves the sender.
  assert(rejected.ok);
  assertEquals(githubIngress.classify(rejected.delivery), { kind: "ignored" });
});
