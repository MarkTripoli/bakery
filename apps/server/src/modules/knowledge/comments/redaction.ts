import type { CommentAnchor } from "./anchors.ts";

/** Tombstones retain geometry, never quoted source or surrounding text. */
export function redactCommentAnchor(
  anchor: CommentAnchor | null,
  deleted: boolean,
): CommentAnchor | null {
  if (!deleted || anchor === null) return anchor;
  switch (anchor.kind) {
    case "markdown":
      return {
        ...anchor,
        selectedText: "",
        blockText: "",
        previousBlock: null,
        nextBlock: null,
      };
    case "text":
      return { ...anchor, quote: "" };
    case "image":
    case "patch":
      return anchor;
    default: {
      const unreachable: never = anchor;
      return unreachable;
    }
  }
}
