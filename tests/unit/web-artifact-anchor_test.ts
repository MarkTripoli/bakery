import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  imageAnchor,
  isArtifactAnchor,
  markdownBlocks,
  patchAnchors,
  textAnchor,
} from "../../apps/web/src/pages/ArtifactCommentAnchor.model.ts";

Deno.test("keeps fenced markdown whole when internal blank lines separate code", () => {
  const source =
    "Before\n\n```ts\nconst first = 1;\n\nconst second = 2;\n```\n\nAfter";

  const blocks = markdownBlocks(source);

  assertEquals(blocks, [
    "Before",
    "```ts\nconst first = 1;\n\nconst second = 2;\n```",
    "After",
  ]);
});

Deno.test("preserves CRLF bytes when tokenizing markdown fences and paragraphs", () => {
  const source =
    "Before\r\n\r\n~~~\r\ninside\r\n\r\nstill inside\r\n~~~\r\n\r\nAfter\r\n";

  const blocks = markdownBlocks(source);

  assertEquals(blocks, [
    "Before\r",
    "~~~\r\ninside\r\n\r\nstill inside\r\n~~~\r",
    "After\r",
  ]);
});

Deno.test("keeps the longer fence open when a shorter marker appears inside it", () => {
  const source = "````\n```\n\ntext\n````\n\nNext";

  const blocks = markdownBlocks(source);

  assertEquals(blocks, ["````\n```\n\ntext\n````", "Next"]);
});

Deno.test("captures exact multiline quote when a CRLF line range is selected", () => {
  const source = "first\r\nsecond 😀\r\nthird\r\n";

  const anchor = textAnchor(source, 1, 2);

  assertEquals(anchor, {
    kind: "text",
    startLine: 1,
    endLine: 2,
    quote: "first\r\nsecond 😀\r",
  });
});

Deno.test("rejects text range when it is reversed or outside immutable content", () => {
  const source = "one\ntwo";

  const anchors = [
    textAnchor(source, 0, 1),
    textAnchor(source, 2, 1),
    textAnchor(source, 1, 3),
  ];

  assertEquals(anchors, [null, null, null]);
});

Deno.test("derives each patch side and full revision hashes when a diff has added and removed lines", () => {
  const source =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,2 +3,2 @@\n-old\n+new\n same";
  const version = {
    subjectHeadSha: "a".repeat(40),
    subjectBaseSha: "b".repeat(40),
  };

  const anchors = patchAnchors(source, version);

  assertEquals(anchors, [
    {
      kind: "patch",
      path: "src/a.ts",
      side: "left",
      startLine: 2,
      endLine: 2,
      headSha: version.subjectHeadSha,
      baseSha: version.subjectBaseSha,
    },
    {
      kind: "patch",
      path: "src/a.ts",
      side: "right",
      startLine: 3,
      endLine: 3,
      headSha: version.subjectHeadSha,
      baseSha: version.subjectBaseSha,
    },
    {
      kind: "patch",
      path: "src/a.ts",
      side: "left",
      startLine: 3,
      endLine: 3,
      headSha: version.subjectHeadSha,
      baseSha: version.subjectBaseSha,
    },
    {
      kind: "patch",
      path: "src/a.ts",
      side: "right",
      startLine: 4,
      endLine: 4,
      headSha: version.subjectHeadSha,
      baseSha: version.subjectBaseSha,
    },
  ]);
  assertEquals(anchors.every(isArtifactAnchor), true);
});

Deno.test("does not invent patch hashes when provenance is missing", () => {
  const source = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";

  const anchors = patchAnchors(source, {
    subjectHeadSha: null,
    subjectBaseSha: null,
  });

  assertEquals(anchors, []);
});

Deno.test("normalizes image percentages when a valid rectangle is selected", () => {
  const region = { x: 25, y: 10, width: 50, height: 60 };

  const anchor = imageAnchor(region);

  assertEquals(anchor, {
    kind: "image",
    x: 0.25,
    y: 0.1,
    width: 0.5,
    height: 0.6,
  });
});

Deno.test("rejects image region when dimensions overflow or have no area", () => {
  const regions = [
    { x: 80, y: 0, width: 30, height: 100 },
    { x: 0, y: 80, width: 100, height: 30 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: -1, y: 0, width: 10, height: 10 },
  ];

  const anchors = regions.map(imageAnchor);

  assertEquals(anchors, [null, null, null, null]);
});

Deno.test("preserves nullable markdown context when canonical creation input is parsed", () => {
  const anchor = {
    kind: "markdown",
    blockIndex: 0,
    selectedText: "Only 😀 block",
    start: 0,
    end: "Only 😀 block".length,
    blockText: "Only 😀 block",
    previousBlock: null,
    nextBlock: null,
  };

  const parsed = contractSchemas.ArtifactCommentCreate.safeParse({
    body: "Review",
    anchor,
  });

  assertEquals(parsed.success, true);
  if (parsed.success) {
    assertEquals<unknown>(parsed.data, { body: "Review", anchor });
  }
});
