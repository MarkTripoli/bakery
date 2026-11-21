import { assert, assertEquals } from "@std/assert";
import { ApiProblemError } from "@bakery/contracts/client";
import type { ArtifactProbeResult } from "@bakery/contracts/artifact-probe";
import { mismatchSubject } from "../../apps/web/src/pages/files/mismatch-selection.ts";
import { refusedDownload } from "../../apps/web/src/pages/files/media-failure.ts";
import { previewState } from "../../apps/web/src/pages/preview-state.ts";

function problem(code: string, status: number) {
  return new ApiProblemError({
    type: `http://127.0.0.1:0/problems/${code.toLowerCase()}`,
    title: "problem",
    status,
    code,
    retryable: false,
  });
}

Deno.test("a refused download is the file's fault", () => {
  // The panel and the preview must answer the same question the same way: a
  // read the server refused as a mismatch is a mismatch, not a failed download.
  assertEquals(
    refusedDownload(problem("ARTIFACT_CONTENT_MISMATCH", 409)),
    "mismatch",
  );
});

Deno.test("a download that merely failed is a failed download", () => {
  // Keeping this distinction is the whole point of the helper: blaming the file
  // for a network fault would tell someone their intact file is damaged.
  assertEquals(refusedDownload(new Error("offline")), "failed");
  assertEquals(refusedDownload(problem("SERVICE_UNAVAILABLE", 503)), "failed");
});

Deno.test("a refusal shown by the panel becomes the preview's state", () => {
  // FileDetails sets downloadRefused from the same refusal; the preview folds it
  // into the state it draws, or the panel would say "does not match" while the
  // preview still showed a player.
  assertEquals(previewState(sampleProbe(), { mismatch: true }), {
    kind: "mismatch",
  });
});

Deno.test("without that refusal the same probe is played", () => {
  // The mirror of the test above: drop the flag and the state must go back to the
  // player, which is what makes the fold a fold rather than a permanent state.
  assertEquals(previewState(sampleProbe(), { mismatch: false }), {
    kind: "video",
  });
});

Deno.test("the refusal is read on the frame that draws it", () => {
  // The preview derives its state from the refusal directly, not from state an
  // effect sets afterwards: a frame in between showed "The preview did not load."
  // before the banner replaced it (#437 review).
  const source = Deno.readTextFileSync(
    new URL(
      "../../apps/web/src/pages/files/FilePreview.tsx",
      import.meta.url,
    ),
  );
  assert(
    source.includes("const state: PreviewState = mismatchKnown"),
    "the preview must read the refusal, not state an effect sets",
  );
  assert(
    !source.includes("setMismatch("),
    "a second copy of the refusal in state is the one-frame flash",
  );
});

Deno.test("a refusal stays on the file and version that was refused", () => {
  const refused = mismatchSubject("file-a", undefined);
  // The same file and version is the same subject: re-rendering the panel must
  // not clear the state.
  assertEquals(mismatchSubject("file-a", undefined), refused);
  // Another file starts clean.
  assert(mismatchSubject("file-b", undefined) !== refused);
  // So does another version of the same file.
  assert(mismatchSubject("file-a", 3) !== refused);
});

Deno.test("the current version is not the same subject as a named one", () => {
  // A refusal on an older copy says nothing about the current file, and the
  // reverse, so the two must never collide.
  assert(mismatchSubject("file-a", undefined) !== mismatchSubject("file-a", 1));
});

/** A probed video, as the server describes one: enough to reach the player. */
function sampleProbe(): ArtifactProbeResult {
  return {
    status: "described",
    kind: "video",
    mediaType: "video/mp4",
    byteLength: 317_705,
    width: 320,
    height: 180,
    durationMs: 2000,
  };
}
