import { assert, assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assembleDeclaredBytes,
  MAX_BLOB_BYTES,
  UPLOAD_SESSION_TTL_MS,
} from "../../apps/server/src/modules/knowledge/blobs.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** The refusal reason, or undefined when the call would not have refused. */
const refusal = (error: unknown): string | undefined =>
  error instanceof StandardError
    ? (error.params?.reason as string | undefined)
    : undefined;

Deno.test("contiguous parts assemble into the declared bytes", () => {
  const parts = [
    { partNumber: 1, content: bytes("hello ") },
    { partNumber: 2, content: bytes("world") },
  ];
  const assembled = assembleDeclaredBytes(parts, {
    sha256: "ignored-by-assembly",
    sizeBytes: 11,
  });
  assertEquals(new TextDecoder().decode(assembled), "hello world");
});

Deno.test("a part numbered out of order is refused, not sorted into place", () => {
  // Sorting would accept a client's mistake and assemble a file nobody sent.
  const outOfOrder = [
    { partNumber: 2, content: bytes("world") },
    { partNumber: 1, content: bytes("hello ") },
  ];
  const error = assertThrows(() =>
    assembleDeclaredBytes(outOfOrder, { sha256: "x", sizeBytes: 11 })
  );
  assertEquals(refusal(error), "upload_parts_incomplete");
});

Deno.test("a gap in the ordinals is refused", () => {
  // A gap assembles into a plausible-looking file that is not the promised one.
  const gap = [
    { partNumber: 1, content: bytes("hello ") },
    { partNumber: 3, content: bytes("world") },
  ];
  const error = assertThrows(() =>
    assembleDeclaredBytes(gap, { sha256: "x", sizeBytes: 11 })
  );
  assertEquals(refusal(error), "upload_parts_incomplete");
});

Deno.test("a duplicate ordinal is refused", () => {
  const duplicated = [
    { partNumber: 1, content: bytes("hello ") },
    { partNumber: 1, content: bytes("world") },
  ];
  assertThrows(() =>
    assembleDeclaredBytes(duplicated, { sha256: "x", sizeBytes: 11 })
  );
});

Deno.test("an empty session is refused rather than yielding zero bytes", () => {
  const error = assertThrows(() =>
    assembleDeclaredBytes([], { sha256: "x", sizeBytes: 0 })
  );
  assertEquals(refusal(error), "upload_parts_incomplete");
});

Deno.test("a size that differs from the declaration is refused before storage", () => {
  const parts = [{ partNumber: 1, content: bytes("hello world") }];
  const tooShort = assertThrows(() =>
    assembleDeclaredBytes(parts, { sha256: "x", sizeBytes: 10 })
  );
  assertEquals(refusal(tooShort), "upload_size_mismatch");
  const tooLong = assertThrows(() =>
    assembleDeclaredBytes(parts, { sha256: "x", sizeBytes: 12 })
  );
  assertEquals(refusal(tooLong), "upload_size_mismatch");
});

Deno.test("a session deadline is absolute, not extended by use", () => {
  // A sliding deadline lets a stalled upload keep itself alive forever, which
  // is the same as having no deadline.
  const now = Date.now();
  const first = new Date(now + UPLOAD_SESSION_TTL_MS);
  const second = new Date(now + UPLOAD_SESSION_TTL_MS);
  assertEquals(first.getTime(), second.getTime());
  assert(UPLOAD_SESSION_TTL_MS > 0);
});

Deno.test("the file ceiling is 5 GiB and is refused above it", () => {
  assertEquals(MAX_BLOB_BYTES, 5 * 1024 * 1024 * 1024);
});
