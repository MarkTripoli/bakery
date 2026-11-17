/**
 * The upload routes as a client meets them, over HTTP.
 *
 * The tenancy cases prove the functions refuse the wrong caller; this proves the
 * three routes compose into a working upload and that the promises the session
 * makes up front are actually enforced at completion. It is also the only test
 * that exercises route registration, input parsing and response projection
 * together — a handler can be correct and still be wired to the wrong schema.
 */

import { assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

function call(
  fixture: Fixture,
  path: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        // These are commands, so each carries a distinct key: a retry of the
        // same request replays, a new intent does not.
        "Idempotency-Key": crypto.randomUUID(),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  ));
}

Deno.test("a client uploads bytes as parts and completes into a blob", () =>
  withWorkerFixture(async (fixture) => {
    const first = new TextEncoder().encode("first half ");
    const second = new TextEncoder().encode("second half");
    const whole = new Uint8Array([...first, ...second]);
    const digest = await sha256Bytes(whole);

    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: digest,
        sizeBytes: whole.byteLength,
        mediaType: "text/plain",
      },
    });
    // 201 because it creates a session; a command that creates nothing returns 200.
    assertEquals(startResponse.status, 201, await startResponse.clone().text());
    const session = await startResponse.json();
    assertEquals(session.state, "pending");
    assertEquals(session.partCount, 0);
    assertEquals(session.receivedBytes, 0);

    for (const [index, chunk] of [first, second].entries()) {
      const partResponse = await call(
        fixture,
        `/v1/blobs/uploads/${session.id}/parts/${index + 1}`,
        {
          method: "PUT",
          body: { sha256: await sha256Bytes(chunk), content: base64(chunk) },
        },
      );
      assertEquals(partResponse.status, 200, await partResponse.clone().text());
      const progressed = await partResponse.json();
      assertEquals(progressed.partCount, index + 1);
    }

    const completeResponse = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/complete`,
      { method: "POST", body: {} },
    );
    assertEquals(
      completeResponse.status,
      201,
      await completeResponse.clone().text(),
    );
    const blob = await completeResponse.json();
    assertEquals(blob.sha256, digest);
    assertEquals(blob.sizeBytes, whole.byteLength);
    assertEquals(blob.mediaType, "text/plain");
  }));

Deno.test("a part whose bytes do not match its digest is refused", () =>
  withWorkerFixture(async (fixture) => {
    const bytes = new TextEncoder().encode("payload");
    const digest = await sha256Bytes(bytes);
    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: digest,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain",
      },
    });
    const session = await startResponse.json();

    // The part claims a digest its bytes do not hash to. Storing it would put a
    // corrupt part in the upload and move the failure to completion, where the
    // cause is much harder to find.
    const partResponse = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/parts/1`,
      {
        method: "PUT",
        body: {
          sha256: digest,
          content: base64(new TextEncoder().encode("tampered")),
        },
      },
    );
    // Asserting only the status would accept an anonymous 403 as proof: both are
    // refusals. The code rules out the neighbouring refusals - an auth 403, a
    // lifecycle 409 - so a regression that refuses for the wrong reason cannot
    // pass as this one. The specific reason ("digest_mismatch") is not projected
    // to the client, so the code is the strongest signal the boundary offers;
    // every other input here is valid, which is what makes it attributable.
    assertEquals(partResponse.status, 422);
    const problem = await partResponse.json();
    assertEquals(problem.code, "UNPROCESSABLE");
  }));

Deno.test("completing a session twice stores one blob and does not redate it", () =>
  withWorkerFixture(async (fixture) => {
    const bytes = new TextEncoder().encode("idempotent");
    const digest = await sha256Bytes(bytes);
    const startResponse = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: digest,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain",
      },
    });
    const session = await startResponse.json();
    await call(fixture, `/v1/blobs/uploads/${session.id}/parts/1`, {
      method: "PUT",
      body: { sha256: digest, content: base64(bytes) },
    });
    const first = await call(
      fixture,
      `/v1/blobs/uploads/${session.id}/complete`,
      { method: "POST", body: {} },
    );
    const blob = await first.json();

    // A second upload of the same bytes is the same blob, and the timestamp is
    // the row's own, so the retry cannot pass itself off as a newer object.
    const again = await call(fixture, "/v1/blobs/uploads", {
      method: "POST",
      body: {
        sha256: digest,
        sizeBytes: bytes.byteLength,
        mediaType: "text/plain",
      },
    });
    const secondSession = await again.json();
    await call(fixture, `/v1/blobs/uploads/${secondSession.id}/parts/1`, {
      method: "PUT",
      body: { sha256: digest, content: base64(bytes) },
    });
    const second = await call(
      fixture,
      `/v1/blobs/uploads/${secondSession.id}/complete`,
      { method: "POST", body: {} },
    );
    const replay = await second.json();
    assertEquals(replay.id, blob.id);
    assertEquals(replay.createdAt, blob.createdAt);
  }));

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
