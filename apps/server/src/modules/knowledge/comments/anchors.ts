import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";

export type CommentAnchor = z.infer<typeof contractSchemas.CommentAnchor>;
export type AnchorVersion = {
  readonly id: string;
  readonly content: Uint8Array | null;
  readonly media_type: string;
  readonly sha256: string;
  readonly subject_head_sha: string | null;
  readonly subject_base_sha: string | null;
};

export function invalidAnchor(): never {
  throw new StandardError({ code: "UNPROCESSABLE" });
}

export function versionText(version: AnchorVersion): string {
  if (!version.content) invalidAnchor();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(version.content);
  } catch (error) {
    if (error instanceof TypeError) invalidAnchor();
    throw error;
  }
}

/** Paragraphs and fenced blocks share exact text, including internal blank lines. */
export function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      lines.push(line);
      if (
        marker && marker[0] === fence[0] && marker.length >= fence.length &&
        /^ {0,3}(?:`+|~+)\s*$/.test(line)
      ) {
        blocks.push(lines.join("\n"));
        lines = [];
        fence = undefined;
      }
    } else if (marker) {
      if (lines.length) blocks.push(lines.join("\n"));
      lines = [line];
      fence = marker;
    } else if (line.trim() === "") {
      if (lines.length) blocks.push(lines.join("\n"));
      lines = [];
    } else {
      lines.push(line);
    }
  }
  if (lines.length) blocks.push(lines.join("\n"));
  return blocks;
}

function utf16Boundary(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 &&
    after <= 0xdfff);
}

function validatePatch(
  anchor: Extract<CommentAnchor, { kind: "patch" }>,
  version: AnchorVersion,
) {
  if (
    anchor.headSha !== version.subject_head_sha ||
    anchor.baseSha !== version.subject_base_sha
  ) invalidAnchor();
  let path: string | undefined;
  let left = 0;
  let right = 0;
  let inHunk = false;
  const found = new Set<number>();
  for (const line of versionText(version).split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = undefined;
      inHunk = false;
    }
    if (
      !inHunk && line.startsWith(anchor.side === "left" ? "--- a/" : "+++ b/")
    ) {
      path = line.slice(6);
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !/^[ +\-]/.test(line)) continue;
    const onSide = anchor.side === "left"
      ? !line.startsWith("+")
      : !line.startsWith("-");
    if (path === anchor.path && onSide) {
      found.add(anchor.side === "left" ? left : right);
    }
    if (!line.startsWith("+")) left++;
    if (!line.startsWith("-")) right++;
  }
  if (
    anchor.endLine < anchor.startLine ||
    anchor.endLine - anchor.startLine >= found.size
  ) invalidAnchor();
  for (let line = anchor.startLine; line <= anchor.endLine; line++) {
    if (!found.has(line)) invalidAnchor();
  }
}

export function validateAnchor(
  anchor: CommentAnchor,
  version: AnchorVersion,
): void {
  if (!version.content) invalidAnchor();
  switch (anchor.kind) {
    case "markdown": {
      if (!version.media_type.startsWith("text/markdown")) invalidAnchor();
      const blocks = markdownBlocks(versionText(version));
      const block = blocks[anchor.blockIndex];
      if (
        block === undefined || block !== anchor.blockText ||
        anchor.start >= anchor.end ||
        !utf16Boundary(block, anchor.start) ||
        !utf16Boundary(block, anchor.end) ||
        block.slice(anchor.start, anchor.end) !== anchor.selectedText ||
        anchor.end > block.length ||
        (blocks[anchor.blockIndex - 1] ?? null) !== anchor.previousBlock ||
        (blocks[anchor.blockIndex + 1] ?? null) !== anchor.nextBlock
      ) invalidAnchor();
      return;
    }
    case "text": {
      if (!version.media_type.startsWith("text/")) invalidAnchor();
      const lines = versionText(version).split("\n");
      if (
        anchor.startLine > anchor.endLine || anchor.endLine > lines.length ||
        lines.slice(anchor.startLine - 1, anchor.endLine).join("\n") !==
          anchor.quote
      ) invalidAnchor();
      return;
    }
    case "image":
      if (
        !version.media_type.startsWith("image/") ||
        anchor.x + anchor.width > 1 ||
        anchor.y + anchor.height > 1
      ) invalidAnchor();
      return;
    case "patch":
      if (!version.media_type.startsWith("text/")) invalidAnchor();
      validatePatch(anchor, version);
      return;
    default: {
      const unreachable: never = anchor;
      return unreachable;
    }
  }
}
