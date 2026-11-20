/**
 * Which preview a probe answer earns (#437 slice 3).
 *
 * The table is design's (issue comment 7029326304), and the rows worth testing
 * are the ones where a wrong answer would mislead a reader: a host that could
 * not check a file must not be reported as a damaged file, a kind the probe
 * detected must beat the name the upload declared, and a described file over the
 * display limit is still too large to show.
 */
import { assertEquals } from "@std/assert";
import {
  declaredPreviewState,
  PREVIEW_IMAGE_LIMIT_BYTES,
  PREVIEW_TEXT_LIMIT_BYTES,
  previewState,
} from "../../apps/web/src/pages/preview-state.ts";
import type { ArtifactProbeResult } from "../../packages/contracts/src/artifact-probe.ts";

const probeSaying = (
  over: Partial<Extract<ArtifactProbeResult, { status: "described" }>>,
): ArtifactProbeResult => ({
  status: "described",
  kind: "image",
  mediaType: "image/png",
  byteLength: 1024,
  ...over,
} as ArtifactProbeResult);

Deno.test("no answer yet is a skeleton, not a state", () => {
  assertEquals(previewState(null), { kind: "pending" });
});

Deno.test("a described kind decides the preview, not the declared type", () => {
  assertEquals(previewState(probeSaying({ kind: "image" })), { kind: "image" });
  assertEquals(previewState(probeSaying({ kind: "text" })), { kind: "text" });
  assertEquals(previewState(probeSaying({ kind: "video" })), { kind: "video" });
  assertEquals(previewState(probeSaying({ kind: "audio" })), { kind: "audio" });
  // A file called .png that is really a zip is an archive.
  assertEquals(
    previewState(probeSaying({ kind: "archive", mediaType: "image/png" })),
    { kind: "unsupported" },
  );
  assertEquals(previewState(probeSaying({ kind: "pdf" })), {
    kind: "unsupported",
  });
  assertEquals(
    previewState(probeSaying({ kind: "unknown" })),
    { kind: "unsupported" },
  );
});

Deno.test("a host that could not check a file never says the file is broken", () => {
  for (const code of ["timeout", "memory"] as const) {
    assertEquals(
      previewState({ status: "refused", code }),
      { kind: "unchecked" },
      code,
    );
  }
  assertEquals(
    previewState({ status: "refused", code: "sandbox-unavailable" }),
    { kind: "host-unavailable" },
  );
  // The two that are about the bytes say so.
  for (const code of ["unreadable", "malformed"] as const) {
    assertEquals(
      previewState({ status: "refused", code }),
      { kind: "unreadable" },
      code,
    );
  }
});

Deno.test("too large names the limit that was hit", () => {
  assertEquals(
    previewState({ status: "refused", code: "too-large", limit: 25_000_000 }),
    { kind: "too-large", limit: 25_000_000 },
  );
  // A refusal that names no limit still has to render something honest.
  assertEquals(
    previewState({ status: "refused", code: "too-large" }),
    { kind: "too-large", limit: 0 },
  );
});

Deno.test("a described file over the display limit is still too large", () => {
  assertEquals(
    previewState(probeSaying({
      kind: "image",
      byteLength: PREVIEW_IMAGE_LIMIT_BYTES + 1,
    })),
    { kind: "too-large", limit: PREVIEW_IMAGE_LIMIT_BYTES },
  );
  assertEquals(
    previewState(probeSaying({
      kind: "text",
      byteLength: PREVIEW_TEXT_LIMIT_BYTES + 1,
    })),
    { kind: "too-large", limit: PREVIEW_TEXT_LIMIT_BYTES },
  );
  // Exactly at the limit is inside it.
  assertEquals(
    previewState(probeSaying({
      kind: "image",
      byteLength: PREVIEW_IMAGE_LIMIT_BYTES,
    })),
    { kind: "image" },
  );
  // Video and audio play by range, so they have no display limit.
  assertEquals(
    previewState(probeSaying({
      kind: "video",
      byteLength: PREVIEW_IMAGE_LIMIT_BYTES * 10,
    })),
    { kind: "video" },
  );
});

Deno.test("a digest mismatch outranks every other answer", () => {
  assertEquals(previewState(null, { mismatch: true }), { kind: "mismatch" });
  assertEquals(
    previewState(probeSaying({ kind: "image" }), { mismatch: true }),
    { kind: "mismatch" },
  );
});

Deno.test("a declared name can only justify a kind, never a refusal", () => {
  // A name is weaker evidence than bytes: it may say "show it as an image", but
  // it may never claim the file is damaged, too large, or that a host failed.
  assertEquals(declaredPreviewState("image/png"), { kind: "image" });
  assertEquals(declaredPreviewState("video/mp4"), { kind: "video" });
  assertEquals(declaredPreviewState("audio/mpeg"), { kind: "audio" });
  assertEquals(declaredPreviewState("text/markdown"), { kind: "text" });
  assertEquals(declaredPreviewState("application/json"), { kind: "text" });
  assertEquals(declaredPreviewState("application/zip"), {
    kind: "unsupported",
  });
  // A name with parameters still reads as its type.
  assertEquals(declaredPreviewState("text/plain; charset=utf-8"), {
    kind: "text",
  });
});
