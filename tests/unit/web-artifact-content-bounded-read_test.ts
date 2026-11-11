import { assertEquals } from "@std/assert";
import {
  ARTIFACT_CONTENT_OVER_LIMIT_STATUS,
  createBakeryApiClient,
} from "../../apps/web/src/api/client.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000003";
const sha256 = "a".repeat(64);

/** A body that records how many bytes were pulled and whether it was cancelled. */
function countingBody(chunks: number, chunkBytes: number) {
  const state = { pulled: 0, cancelled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent += 1;
      state.pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

function client(response: () => Response) {
  return createBakeryApiClient({
    baseUrl: "http://bakery.test",
    fetchImpl: () => Promise.resolve(response()),
  });
}

Deno.test("an advertised length over the bound is cancelled before any read", async () => {
  const { body, state } = countingBody(8, 1024);
  const result = await client(() =>
    new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": String(8 * 1024),
        etag: `"${sha256}"`,
      },
    })
  ).getArtifactContent({ organizationId, versionId, maxBytes: 4096 });
  assertEquals(result.ok, false);
  assertEquals(
    !result.ok && result.error.kind === "invalid-response" &&
      result.error.status,
    ARTIFACT_CONTENT_OVER_LIMIT_STATUS,
  );
  assertEquals(state.cancelled, true);
  assertEquals(state.pulled < 8 * 1024, true);
});

Deno.test("a stream that outgrows its advertised length is cancelled at the bound", async () => {
  // The header claims 1 KiB; the stream keeps going. The bound still holds.
  const { body, state } = countingBody(1000, 1024);
  const result = await client(() =>
    new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": "1024",
        etag: `"${sha256}"`,
      },
    })
  ).getArtifactContent({ organizationId, versionId, maxBytes: 4096 });
  assertEquals(result.ok, false);
  assertEquals(
    !result.ok && result.error.kind === "invalid-response" &&
      result.error.status,
    ARTIFACT_CONTENT_OVER_LIMIT_STATUS,
  );
  assertEquals(state.cancelled, true);
  // Held at most the bound plus the chunk that crossed it, never the megabyte.
  assertEquals(state.pulled <= 4096 + 2 * 1024, true);
});
