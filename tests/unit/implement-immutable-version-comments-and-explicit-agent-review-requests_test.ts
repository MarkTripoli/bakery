import { redactCommentAnchor } from "../../apps/server/src/modules/knowledge/comments/redaction.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  type AnchorVersion,
  markdownBlocks,
  validateAnchor,
} from "../../apps/server/src/modules/knowledge/comments/anchors.ts";
import { commentPlacement } from "../../apps/server/src/modules/knowledge/comments/placement.ts";
import { boundedCommentContext } from "../../apps/server/src/modules/knowledge/comments/context.ts";
import { validateCommentBody } from "../../apps/server/src/modules/knowledge/comments/store.ts";

const source = (text: string, media = "text/plain"): AnchorVersion => ({
  id: crypto.randomUUID(),
  content: new TextEncoder().encode(text),
  media_type: media,
  sha256: "a".repeat(64),
  subject_head_sha: null,
  subject_base_sha: null,
});
Deno.test("text anchors validate exact multibyte lines and map only unique matches", () => {
  const original = source("first\névidence\nlast");
  const anchor = {
    kind: "text",
    startLine: 2,
    endLine: 2,
    quote: "évidence",
  } as const;
  validateAnchor(anchor, original);
  assertThrows(() =>
    validateAnchor({ ...anchor, quote: "evidence" }, original)
  );
  assertEquals(
    commentPlacement(anchor, original, source("prefix\nfirst\névidence\nlast"))
      .anchor,
    { ...anchor, startLine: 3, endLine: 3 },
  );
  assertEquals(
    commentPlacement(anchor, original, source("évidence\névidence")).status,
    "outdated",
  );
  assertEquals(
    commentPlacement(anchor, original, source("changed")).status,
    "outdated",
  );
});
Deno.test("markdown keeps fences whole and rejects split surrogate selections", () => {
  const text = "heading\n\n```js\n\n😀\n```\n\ntail";
  const blocks = markdownBlocks(text);
  assertEquals(blocks, ["heading", "```js\n\n😀\n```", "tail"]);
  const version = source(text, "text/markdown");
  const anchor = {
    kind: "markdown",
    blockIndex: 1,
    blockText: blocks[1] ?? "",
    start: 7,
    end: 9,
    selectedText: "😀",
    previousBlock: "heading",
    nextBlock: "tail",
  } as const;
  validateAnchor(anchor, version);
  assertThrows(() =>
    validateAnchor({ ...anchor, end: 8, selectedText: "\ud83d" }, version)
  );
  assertThrows(() =>
    validateAnchor({ ...anchor, previousBlock: "forged" }, version)
  );
});
Deno.test("image and patch anchors reject out of bounds or absent evidence", () => {
  assertThrows(() =>
    validateAnchor(
      { kind: "image", x: 0.8, y: 0, width: 0.3, height: 1 },
      source("bytes", "image/png"),
    )
  );
  const anchor = {
    kind: "patch",
    path: "file.ts",
    side: "right",
    startLine: 1,
    endLine: 1,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
  } as const;
  const version = {
    ...source(
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      "text/x-diff",
    ),
    subject_head_sha: anchor.headSha,
    subject_base_sha: anchor.baseSha,
  };
  validateAnchor(anchor, version);
  assertThrows(() =>
    validateAnchor({ ...anchor, startLine: 2, endLine: 2 }, version)
  );
  assertThrows(() =>
    validateAnchor({ ...anchor, headSha: "c".repeat(40) }, version)
  );
});
Deno.test("comment and immutable context limits count UTF-8 bytes", () => {
  validateCommentBody("é".repeat(5120));
  assertThrows(() => validateCommentBody("é".repeat(5121)));
  const snapshot = {
    commentId: crypto.randomUUID(),
    version: 1,
    artifactVersionId: crypto.randomUUID(),
    rootId: null,
    authorId: crypto.randomUUID(),
    body: "é".repeat(5120),
    anchor: null,
  };
  assertEquals(boundedCommentContext([snapshot]).comments.length, 1);
  assertThrows(() =>
    boundedCommentContext([snapshot, snapshot, snapshot, snapshot])
  );
});

Deno.test("patch content resembling file headers cannot forge the anchor path", () => {
  const version = {
    ...source(
      "diff --git a/real.ts b/real.ts\n--- a/real.ts\n+++ b/real.ts\n@@ -1 +1 @@\n--- a/forged.ts\n+++ b/forged.ts",
      "text/x-diff",
    ),
    subject_head_sha: "a".repeat(40),
    subject_base_sha: "b".repeat(40),
  };
  for (const side of ["left", "right"] as const) {
    const anchor = {
      kind: "patch",
      path: "real.ts",
      side,
      startLine: 1,
      endLine: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    } as const;
    validateAnchor(anchor, version);
    assertThrows(() =>
      validateAnchor({ ...anchor, path: "forged.ts" }, version)
    );
  }
});

Deno.test("deleted markdown anchors retain geometry without quoted source or context", () => {
  const anchor = {
    kind: "markdown",
    blockIndex: 2,
    start: 4,
    end: 10,
    selectedText: "secret",
    blockText: "the secret block",
    previousBlock: "before secret",
    nextBlock: "after secret",
  } as const;
  assertEquals(redactCommentAnchor(anchor, true), {
    kind: "markdown",
    blockIndex: 2,
    start: 4,
    end: 10,
    selectedText: "",
    blockText: "",
    previousBlock: null,
    nextBlock: null,
  });
  assertEquals(redactCommentAnchor(anchor, false), anchor);
  const image = { kind: "image", x: 0, y: 0, width: 1, height: 1 } as const;
  assertEquals(redactCommentAnchor(image, true), image);
});
