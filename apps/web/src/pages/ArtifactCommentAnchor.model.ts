import { contractSchemas } from "@bakery/contracts/contracts";
import type { ArtifactVersionResponse } from "../api/client.ts";

export type ArtifactAnchor =
  | Readonly<
    { kind: "text"; startLine: number; endLine: number; quote: string }
  >
  | Readonly<
    {
      kind: "markdown";
      blockIndex: number;
      blockText: string;
      selectedText: string;
      start: number;
      end: number;
      previousBlock: string | null;
      nextBlock: string | null;
    }
  >
  | Readonly<
    { kind: "image"; x: number; y: number; width: number; height: number }
  >
  | Readonly<
    {
      kind: "patch";
      path: string;
      side: "left" | "right";
      startLine: number;
      endLine: number;
      headSha: string;
      baseSha: string;
    }
  >;

export function isArtifactAnchor(value: unknown): value is ArtifactAnchor {
  return contractSchemas.CommentAnchor.safeParse(value).success;
}

export function imageAnchor(
  region: Readonly<{ x: number; y: number; width: number; height: number }>,
): ArtifactAnchor | null {
  const anchor = {
    kind: "image" as const,
    x: region.x / 100,
    y: region.y / 100,
    width: region.width / 100,
    height: region.height / 100,
  };
  return isArtifactAnchor(anchor) && anchor.x + anchor.width <= 1 &&
      anchor.y + anchor.height <= 1
    ? anchor
    : null;
}

export function textAnchor(
  text: string,
  startLine: number,
  endLine: number,
): ArtifactAnchor | null {
  const lines = text.split("\n");
  const anchor = {
    kind: "text" as const,
    startLine,
    endLine,
    quote: lines.slice(startLine - 1, endLine).join("\n"),
  };
  return startLine <= endLine && endLine <= lines.length &&
      isArtifactAnchor(anchor)
    ? anchor
    : null;
}

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
    } else lines.push(line);
  }
  if (lines.length) blocks.push(lines.join("\n"));
  return blocks;
}

export function patchAnchors(
  text: string,
  version: Pick<ArtifactVersionResponse, "subjectHeadSha" | "subjectBaseSha">,
): ArtifactAnchor[] {
  if (!version.subjectHeadSha || !version.subjectBaseSha) return [];
  const anchors: ArtifactAnchor[] = [];
  let leftPath = "";
  let rightPath = "";
  let left = 0;
  let right = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      leftPath = rightPath = "";
      inHunk = false;
    }
    if (!inHunk && line.startsWith("--- a/")) leftPath = line.slice(6);
    if (!inHunk && line.startsWith("+++ b/")) rightPath = line.slice(6);
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !/^[ +\-]/.test(line)) continue;
    for (const side of ["left", "right"] as const) {
      const path = side === "left" ? leftPath : rightPath;
      const present = side === "left"
        ? !line.startsWith("+")
        : !line.startsWith("-");
      const lineNumber = side === "left" ? left : right;
      if (path && present) {
        anchors.push({
          kind: "patch",
          path,
          side,
          startLine: lineNumber,
          endLine: lineNumber,
          headSha: version.subjectHeadSha,
          baseSha: version.subjectBaseSha,
        });
      }
    }
    if (!line.startsWith("+")) left++;
    if (!line.startsWith("-")) right++;
  }
  return anchors;
}
