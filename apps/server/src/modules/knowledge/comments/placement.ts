import {
  type AnchorVersion,
  type CommentAnchor,
  markdownBlocks,
  validateAnchor,
  versionText,
} from "./anchors.ts";
import { StandardError } from "@bakery/contracts/http";

export function commentPlacement(
  anchor: CommentAnchor | null,
  original: AnchorVersion,
  view: AnchorVersion,
) {
  const result = (
    status: "unanchored" | "original" | "mapped" | "outdated",
    placed: CommentAnchor | null,
  ) => ({ viewVersionId: view.id, status, anchor: placed });
  if (!anchor) return result("unanchored", null);
  if (original.id === view.id) return result("original", anchor);
  if (!view.content) return result("outdated", null);
  try {
    switch (anchor.kind) {
      case "markdown": {
        if (original.media_type !== view.media_type) {
          return result("outdated", null);
        }
        const blocks = markdownBlocks(versionText(view));
        let matches = blocks.flatMap((block, index) =>
          block === anchor.blockText ? [index] : []
        );
        if (matches.length > 1) {
          matches = matches.filter((index) =>
            (blocks[index - 1] ?? null) === anchor.previousBlock &&
            (blocks[index + 1] ?? null) === anchor.nextBlock
          );
        }
        const index = matches[0];
        if (matches.length !== 1 || index === undefined) {
          return result("outdated", null);
        }
        return result("mapped", {
          ...anchor,
          blockIndex: index,
          previousBlock: blocks[index - 1] ?? null,
          nextBlock: blocks[index + 1] ?? null,
        });
      }
      case "text": {
        if (original.media_type !== view.media_type) {
          return result("outdated", null);
        }
        const lines = versionText(view).split("\n");
        const count = anchor.endLine - anchor.startLine + 1;
        const matches = lines.flatMap((_, index) =>
          index + count <= lines.length &&
            lines.slice(index, index + count).join("\n") === anchor.quote
            ? [index]
            : []
        );
        const index = matches[0];
        return matches.length === 1 && index !== undefined
          ? result("mapped", {
            ...anchor,
            startLine: index + 1,
            endLine: index + count,
          })
          : result("outdated", null);
      }
      case "image":
        return original.sha256 === view.sha256
          ? result("mapped", anchor)
          : result("outdated", null);
      case "patch":
        validateAnchor(anchor, view);
        return result("mapped", anchor);
      default: {
        const unreachable: never = anchor;
        return unreachable;
      }
    }
  } catch (error) {
    if (error instanceof StandardError) return result("outdated", null);
    throw error;
  }
}
