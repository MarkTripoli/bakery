import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { ZodError } from "zod";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  INTAKE_MAX_BODY_BYTES,
  readBoundedBody,
} from "../../../apps/server/src/modules/integrations/intake-body.ts";
import { parseSignatureHeader } from "../../../apps/server/src/modules/integrations/intake-signature.ts";
import {
  deliveryFailure,
  DeliveryIdentitySchema,
  readWebhookSecret,
  verifyWithWebhookSecret,
  type WebhookSecret,
} from "../../../apps/server/src/modules/integrations/intake-receipts.ts";
import { withVerifiedDelivery } from "../../../apps/server/src/modules/integrations/actions.ts";
import {
  encryptInstallationSecret,
  loadSecretKey,
} from "../../../apps/server/src/modules/secrets/crypto.ts";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import { signDelivery } from "./signed-delivery.ts";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

/** A body that yields its first chunk and then waits, like a client trickling bytes. */
function stalledStream(first: Uint8Array<ArrayBuffer>) {
  const state = { cancelled: false };
  let sent = false;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (sent) return new Promise<void>(() => {});
      sent = true;
      controller.enqueue(first);
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

function request(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Request {
  return new Request("https://bakery.test/v1/webhooks/github", {
    method: "POST",
    body: stream,
    // Required for a streamed request body; the runtime types do not list it.
    ...{ duplex: "half" },
  });
}

async function timeoutCode(work: () => Promise<unknown>): Promise<string> {
  const error = await assertRejects(work, StandardError);
  return error.code;
}

Deno.test("issue 71 receipts: a body read stops at the abort signal, cancels the stream and fails as a timeout", async () => {
  const stalled = stalledStream(bytes('{"a"'));
  const controller = new AbortController();
  const pending = readBoundedBody(
    request(stalled.stream),
    INTAKE_MAX_BODY_BYTES,
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort("deadline");
  const error = await assertRejects(() => pending, StandardError);
  assertEquals(error.code, "DEPENDENCY_TIMEOUT");
  assert(stalled.state.cancelled, "the trickling stream is cancelled");

  // A signal that is already aborted reads nothing at all.
  const idle = stalledStream(bytes("{}"));
  const aborted = AbortSignal.abort("deadline");
  assertEquals(
    await timeoutCode(() =>
      readBoundedBody(request(idle.stream), INTAKE_MAX_BODY_BYTES, aborted)
    ),
    "DEPENDENCY_TIMEOUT",
  );
  assert(idle.state.cancelled);
});

Deno.test("issue 71 receipts: a body read under a live signal completes and leaves no listener behind", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (
    ...args: Parameters<typeof add>
  ) => {
    listeners += 1;
    return add(...args);
  };
  signal.removeEventListener = (
    ...args: Parameters<typeof remove>
  ) => {
    listeners -= 1;
    return remove(...args);
  };
  const result = await readBoundedBody(
    request(
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(stream) {
          stream.enqueue(bytes('{"ok"'));
          stream.enqueue(bytes(":true}"));
          stream.close();
        },
      }),
    ),
    INTAKE_MAX_BODY_BYTES,
    signal,
  );
  assertEquals(new TextDecoder().decode(result), '{"ok":true}');
  assertEquals(listeners, 0, "every listener was removed");
  // Aborting after the read finished has nothing left to affect.
  controller.abort("late");
});

Deno.test("issue 71 receipts: the webhook secret is zeroed after a good verdict, a bad one and a failure", async () => {
  const secret = "webhook-secret-for-zeroing";
  const raw = bytes("{}");
  const good = parseSignatureHeader(await signDelivery(secret, raw));
  assert(good !== null);
  const held = (): WebhookSecret => ({
    registrationId: crypto.randomUUID(),
    secret: bytes(secret),
  });
  const isZero = (value: Uint8Array) => value.every((byte) => byte === 0);

  const accepted = held();
  assert(await verifyWithWebhookSecret(accepted, good, raw));
  assert(isZero(accepted.secret), "zeroed after a valid signature");
  assertEquals(accepted.secret.byteLength, secret.length);

  const forged = held();
  const other = parseSignatureHeader(await signDelivery("another-secret", raw));
  assertFalse(await verifyWithWebhookSecret(forged, other, raw));
  assert(isZero(forged.secret), "zeroed after a forged signature");

  const missing = held();
  assertFalse(await verifyWithWebhookSecret(missing, null, raw));
  assert(isZero(missing.secret), "zeroed when no signature was sent");

  // Verification itself failing still leaves no secret behind.
  const broken = held();
  await assertRejects(() =>
    verifyWithWebhookSecret(
      broken,
      good,
      undefined as unknown as Uint8Array<ArrayBuffer>,
    )
  );
  assert(isZero(broken.secret), "zeroed when verification throws");
});

/**
 * A mounted secrets key and the webhook secret `value` encrypted under it, as
 * the registration, secret and active version rows hold it. `cleanup` removes
 * the key directory.
 */
async function storedWebhookSecret(value: string) {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-webhook-secret-",
  });
  const keyFile = async (name: string) => {
    const file = `${directory}/${name}`;
    await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
      mode: 0o600,
    });
    return file;
  };
  const keyId = "unit-webhook-key-v1";
  const secretsKey = { file: await keyFile("key"), keyId };
  const binding = { secretId: crypto.randomUUID(), revision: 3, keyId };
  const cipher = await encryptInstallationSecret(
    await loadSecretKey(secretsKey),
    binding,
    value,
  );
  return {
    secretsKey,
    /** A different mounted key under the same key id, which cannot open the row. */
    otherKey: { file: await keyFile("other"), keyId },
    row: {
      registrationId: crypto.randomUUID(),
      secretId: binding.secretId,
      revision: binding.revision,
      keyId,
      ciphertext: cipher.ciphertext,
      nonce: cipher.nonce,
    },
    cleanup: () => Deno.remove(directory, { recursive: true }),
  };
}

/** A pool whose only query answers `rows`, remembering what it was asked. */
function databaseAnswering(rows: unknown[]) {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  const database = {
    query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return Promise.resolve({ rows });
    },
  } as unknown as PgDatabase;
  return { database, calls };
}

/**
 * Runs `work` with every `crypto.subtle.decrypt` result recorded, so a test
 * can look at the decrypted buffer after the code under test is done with it.
 */
async function recordingDecrypt<T>(
  work: () => Promise<T>,
): Promise<{ value: T; decrypted: ArrayBuffer[] }> {
  const decrypted: ArrayBuffer[] = [];
  const original = crypto.subtle.decrypt;
  crypto.subtle.decrypt = async (
    ...args: Parameters<SubtleCrypto["decrypt"]>
  ) => {
    const result = await original.apply(crypto.subtle, args);
    decrypted.push(result);
    return result;
  };
  try {
    return { value: await work(), decrypted };
  } finally {
    crypto.subtle.decrypt = original;
  }
}

Deno.test("issue 71 receipts: the webhook secret read returns an independent copy and zeroes the bytes it decrypted", async () => {
  const value = "webhook-secret-read-copy-91";
  const stored = await storedWebhookSecret(value);
  try {
    const { database, calls } = databaseAnswering([stored.row]);
    const { value: read, decrypted } = await recordingDecrypt(() =>
      readWebhookSecret(database, stored.secretsKey)
    );
    assert(read !== null, "the stored secret opens");
    assertEquals(read.registrationId, stored.row.registrationId);
    assertEquals(new TextDecoder().decode(read.secret), value);

    // The returned bytes are their own ArrayBuffer-backed copy: not a view of
    // the decrypted buffer, not offset into a larger one, not shared memory.
    assertEquals(decrypted.length, 1, "exactly one decryption happened");
    const source = decrypted[0];
    assertEquals(source.byteLength, value.length, "the source held the secret");
    assertNotStrictEquals(read.secret.buffer, source);
    assertInstanceOf(read.secret.buffer, ArrayBuffer);
    assertEquals(read.secret.byteOffset, 0);
    assertEquals(read.secret.buffer.byteLength, read.secret.byteLength);

    // The decrypted source is wiped before the function returns.
    assert(
      new Uint8Array(source).every((byte) => byte === 0),
      "the decrypted source bytes are zeroed",
    );
    // Wiping the returned copy, as the caller does, is the caller's own job
    // and does not depend on the source.
    read.secret.fill(0);
    assert(read.secret.every((byte) => byte === 0));

    assertEquals(calls.length, 1, "one query reads the secret");
    assertEquals(calls[0].values, ["github"], "scoped to the GitHub provider");
  } finally {
    await stored.cleanup();
  }
});

Deno.test("issue 71 receipts: a webhook secret that cannot be opened reads as null and a database failure is thrown", async () => {
  const stored = await storedWebhookSecret("webhook-secret-failure-paths");
  try {
    const opens = async (
      row: Record<string, unknown>,
      key: Parameters<typeof readWebhookSecret>[1],
    ) => await readWebhookSecret(databaseAnswering([row]).database, key);

    // Control: the same row opens under the right key, so every null below is
    // the named cause and not a bad fixture.
    assert(await opens(stored.row, stored.secretsKey) !== null);

    // No registration, no webhook secret id or no active version: no row joins.
    assertStrictEquals(
      await readWebhookSecret(
        databaseAnswering([]).database,
        stored.secretsKey,
      ),
      null,
    );
    // No secrets key mounted, an unreadable key file, and a key that is not the one it was sealed under.
    assertStrictEquals(await opens(stored.row, undefined), null);
    assertStrictEquals(
      await opens(stored.row, {
        ...stored.secretsKey,
        file: `${stored.secretsKey.file}.missing`,
      }),
      null,
    );
    assertStrictEquals(await opens(stored.row, stored.otherKey), null);
    // The ciphertext was altered, or was sealed for another revision, secret or key id.
    const tampered = new Uint8Array(stored.row.ciphertext);
    tampered[0] ^= 1;
    assertStrictEquals(
      await opens({ ...stored.row, ciphertext: tampered }, stored.secretsKey),
      null,
    );
    assertStrictEquals(
      await opens({ ...stored.row, revision: 4 }, stored.secretsKey),
      null,
    );
    assertStrictEquals(
      await opens(
        { ...stored.row, secretId: crypto.randomUUID() },
        stored.secretsKey,
      ),
      null,
    );
    assertStrictEquals(
      await opens({ ...stored.row, keyId: "unit-webhook-key-v2" }, {
        ...stored.secretsKey,
        keyId: "unit-webhook-key-v2",
      }),
      null,
    );
    // A nonce of the wrong size is rejected before any decryption.
    assertStrictEquals(
      await opens(
        { ...stored.row, nonce: new Uint8Array(11) },
        stored.secretsKey,
      ),
      null,
    );

    // A database failure is not a missing secret: it is thrown so the route
    // answers a retryable 503 instead of a 401.
    const outage = Object.assign(new Error("terminating connection"), {
      code: "57P01",
    });
    const failing = {
      query: () => Promise.reject(outage),
    } as unknown as PgDatabase;
    const thrown = await assertRejects(() =>
      readWebhookSecret(failing, stored.secretsKey)
    );
    assertStrictEquals(thrown, outage);
  } finally {
    await stored.cleanup();
  }
});

Deno.test("issue 71 receipts: a database failure becomes a retryable dependency error that logs no message", () => {
  const context = { requestId: "req-1", traceId: "trace-1" };
  const canary = "row-data-canary-91c2";
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => lines.push(String(line));
  try {
    for (
      const failure of [
        Object.assign(new Error(canary), { code: "57P01" }),
        Object.assign(new Error(canary), { code: "23503" }),
        new Error(`Connection terminated ${canary}`),
      ]
    ) {
      const mapped = deliveryFailure(failure, "commit", context);
      assertInstanceOf(mapped, StandardError);
      assertEquals(mapped.code, "DEPENDENCY_UNAVAILABLE");
      assertStrictEquals(mapped.cause, failure);
    }
    assertEquals(lines.length, 3, "one structured line per failure");
    for (const line of lines) {
      assertFalse(line.includes(canary), "the error message is never logged");
      const parsed = JSON.parse(line);
      assertEquals(parsed.event, "github_webhook_unavailable");
      assertEquals(parsed.stage, "commit");
      assertEquals(parsed.requestId, "req-1");
    }
    // Anything that is not a database failure passes through untouched.
    const refusal = new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    const program = new TypeError(canary);
    const aborted = new DOMException("Action aborted", "AbortError");
    assertStrictEquals(deliveryFailure(refusal, "commit", context), refusal);
    assertStrictEquals(deliveryFailure(program, "commit", context), program);
    assertStrictEquals(deliveryFailure(aborted, "secret", context), aborted);
    assertEquals(lines.length, 3);
  } finally {
    console.warn = warn;
  }
});

Deno.test("issue 71 receipts: a verified delivery needs a well-formed identity before the action sees it", () => {
  const good = {
    registrationId: crypto.randomUUID(),
    deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    eventName: "issues",
    digest: "a".repeat(64),
  };
  assertEquals(DeliveryIdentitySchema.parse(good), good);
  for (
    const bad of [
      { registrationId: "not-a-uuid" },
      { deliveryId: "has space" },
      { deliveryId: "x".repeat(256) },
      { deliveryId: "" },
      { eventName: "Issues" },
      { eventName: "" },
      { digest: "A".repeat(64) },
      { digest: "a".repeat(63) },
    ]
  ) {
    assertThrows(
      () => DeliveryIdentitySchema.parse({ ...good, ...bad }),
      ZodError,
    );
  }
  assertThrows(() => DeliveryIdentitySchema.parse({ ...good, extra: 1 }));
  // The slot refuses to be filled from a malformed identity.
  const context = {
    request: new Request("https://bakery.test/v1/webhooks/github"),
    params: {},
    requestId: "req",
    traceId: "trace",
    signal: new AbortController().signal,
  };
  assertThrows(
    () =>
      withVerifiedDelivery(context, {
        ...good,
        digest: "short",
        event: { supported: false, eventName: "star" },
      }),
    ZodError,
  );
  const filled = withVerifiedDelivery(context, {
    ...good,
    event: { supported: false, eventName: "star" },
  });
  assertEquals(filled.requestId, "req");
  assertFalse(
    Object.keys(filled).includes("event"),
    "no plain property carries the delivery",
  );
});
