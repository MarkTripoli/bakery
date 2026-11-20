/**
 * What the probe records, and what it refuses to record (#437 slice 2).
 *
 * The two rules that matter are negative, so they are tested as negatives: a
 * refusal about the *file* is stored, and a refusal about the *host* is not.
 * Getting those the wrong way round would either re-probe a 300 MB file on
 * every open or brand a perfectly good file unreadable for ever because a
 * machine had no user bus one afternoon.
 */
import { assertEquals } from "@std/assert";
import {
  isStorableProbe,
  probeFromRow,
  type StoredBlobProbe,
} from "../../apps/server/src/modules/knowledge/blob-probes.ts";

Deno.test("a refusal about the file is worth storing", () => {
  for (
    const code of ["too-large", "malformed", "unreadable", "memory"] as const
  ) {
    assertEquals(
      isStorableProbe({ status: "refused", code }),
      true,
      `${code} is a property of the bytes`,
    );
  }
});

Deno.test("a refusal about the host is never stored", () => {
  assertEquals(
    isStorableProbe({ status: "refused", code: "sandbox-unavailable" }),
    false,
  );
});

Deno.test("a timeout is stored: the same bytes will time out again", () => {
  // The budget is ours, not the file's, but re-probing on every open would pay
  // ten seconds per reader to learn the same thing.
  assertEquals(isStorableProbe({ status: "refused", code: "timeout" }), true);
});

Deno.test("a described blob is always storable", () => {
  assertEquals(
    isStorableProbe({
      status: "described",
      kind: "image",
      mediaType: "image/png",
      byteLength: 16,
      width: 2,
      height: 2,
    }),
    true,
  );
});

Deno.test("a described row comes back with exactly the fields that were measured", () => {
  const probedAt = new Date("2026-11-20T02:30:00.000Z");
  const stored = probeFromRow({
    status: "described",
    kind: "image",
    media_type: "image/png",
    byte_length: "16",
    width: 2,
    height: 2,
    duration_ms: null,
    line_count: null,
    utf8: null,
    failure_code: null,
    failure_limit: null,
    probed_at: probedAt,
  }) as StoredBlobProbe;
  // No `durationMs: undefined` key: a PNG has no duration, which is not the
  // same claim as a duration of zero.
  assertEquals(stored.result, {
    status: "described",
    kind: "image",
    mediaType: "image/png",
    byteLength: 16,
    width: 2,
    height: 2,
  });
  assertEquals(Object.hasOwn(stored.result, "durationMs"), false);
  assertEquals(stored.probedAt, probedAt);
});

Deno.test("a text row keeps its line count and its utf8 verdict, including false", () => {
  const stored = probeFromRow({
    status: "described",
    kind: "text",
    media_type: "text/plain",
    byte_length: 4,
    width: null,
    height: null,
    duration_ms: null,
    line_count: "12",
    // false is a measurement, not an absence.
    utf8: false,
    failure_code: null,
    failure_limit: null,
    probed_at: new Date(0),
  }) as StoredBlobProbe;
  assertEquals(stored.result, {
    status: "described",
    kind: "text",
    mediaType: "text/plain",
    byteLength: 4,
    lineCount: 12,
    utf8: false,
  });
});

Deno.test("a refused row comes back as the code and the limit that was hit", () => {
  const stored = probeFromRow({
    status: "refused",
    kind: null,
    media_type: null,
    byte_length: null,
    width: null,
    height: null,
    duration_ms: null,
    line_count: null,
    utf8: null,
    failure_code: "too-large",
    failure_limit: "67108864",
    probed_at: new Date(0),
  }) as StoredBlobProbe;
  assertEquals(stored.result, {
    status: "refused",
    code: "too-large",
    limit: 67_108_864,
  });
});

Deno.test("a refusal with no limit has no limit field", () => {
  const stored = probeFromRow({
    status: "refused",
    kind: null,
    media_type: null,
    byte_length: null,
    width: null,
    height: null,
    duration_ms: null,
    line_count: null,
    utf8: null,
    failure_code: "malformed",
    failure_limit: null,
    probed_at: new Date(0),
  }) as StoredBlobProbe;
  assertEquals(stored.result, { status: "refused", code: "malformed" });
  assertEquals(Object.hasOwn(stored.result, "limit"), false);
});
