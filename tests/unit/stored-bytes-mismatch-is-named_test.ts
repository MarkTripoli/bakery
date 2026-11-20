/**
 * A file whose stored bytes are not its recorded bytes is refused, and says so
 * (#437 slice 2, design answer 3).
 *
 * The page must show a danger banner rather than a preview or a download, and a
 * banner needs something to say. `INTERNAL` is not it: that reads as "Bakery
 * broke", and the person cannot do anything with it. The mismatch is a named
 * refusal a page can branch on, while a *writer* meeting the same mismatched
 * bytes keeps `INTERNAL`, because that is this code's defect and no reader can
 * act on it. These tests hold both halves, since the whole value of the split is
 * that the two audiences stay apart.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { FAULTS, StandardError } from "../../packages/contracts/src/http.ts";
import { assertStoredBytes } from "../../apps/server/src/modules/knowledge/stored-bytes.ts";

const bytes = new TextEncoder().encode("these are the real bytes");
const digest = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");

Deno.test("bytes that match their record pass", async () => {
  await assertStoredBytes(
    { size_bytes: bytes.byteLength, sha256: digest },
    bytes,
  );
});

Deno.test("a reader names a mismatch, so the page can say what is wrong", async () => {
  const other = new TextEncoder().encode("these are different bytes");
  const error = await assertRejects(
    () =>
      assertStoredBytes(
        { size_bytes: other.byteLength, sha256: digest },
        other,
        { mismatch: "content-mismatch" },
      ),
    StandardError,
  );
  assertEquals(error.code, "ARTIFACT_CONTENT_MISMATCH");
  // 409, not 404 and not 500: the file is there, its record is there, and what
  // is stored under it is something else.
  assertEquals(FAULTS[error.code][0], 409);
  // And a client can retry it: the bytes may be repaired, so this is not a
  // permanent client error.
  assertEquals(FAULTS[error.code][1], false);
});

Deno.test("a writer meeting the same bytes keeps it internal", async () => {
  const other = new TextEncoder().encode("these are different bytes");
  const error = await assertRejects(
    () =>
      assertStoredBytes(
        { size_bytes: other.byteLength, sha256: digest },
        other,
      ),
    StandardError,
  );
  assertEquals(
    error.code,
    "INTERNAL",
    "a write that mismatches is this code's defect, not the reader's problem",
  );
});

Deno.test("a size that disagrees is still internal on both sides", async () => {
  // The size check runs before the hash and is never a user-facing mismatch: a
  // row whose size is wrong is a corrupt row, whichever side notices.
  for (const mismatch of ["content-mismatch", undefined] as const) {
    const error = await assertRejects(
      () =>
        assertStoredBytes(
          { size_bytes: bytes.byteLength + 1, sha256: digest },
          bytes,
          mismatch === undefined ? {} : { mismatch },
        ),
      StandardError,
    );
    assertEquals(error.code, "INTERNAL");
  }
});

Deno.test("the read paths that serve files all ask for the named refusal", async () => {
  // The option is worthless if a reader forgets it, and a forgotten one shows up
  // as a file that silently reports itself broken. Both readers that serve bytes
  // to a person are read here, at the call sites, not at the helper.
  for (
    const path of [
      "../../apps/server/src/modules/knowledge/reads.ts",
      "../../apps/server/src/modules/knowledge/storage-reads.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(path, import.meta.url));
    const calls = source.match(/assertStoredBytes\([^;]*?\);/gs) ?? [];
    assert(calls.length > 0, `${path} checks its bytes`);
    for (const call of calls) {
      assert(
        call.includes('mismatch: "content-mismatch"'),
        `${path}: a reader that does not name the mismatch: ${call}`,
      );
    }
  }
});
