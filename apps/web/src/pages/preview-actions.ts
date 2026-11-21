import type { PreviewState } from "./preview-state.ts";

/** What a preview may offer beside its sentence. */
export type PreviewAction = {
  readonly label: string;
  readonly onClick: () => void;
};

/**
 * The buttons a preview state earns (#437, UX reviews).
 *
 * One rule, so the pane and the page cannot disagree: a fault in the file earns
 * nothing — a damaged file will be damaged again, and a promise to the contrary is
 * a lie — while a host that could not check it earns "Try again". Download is
 * never one of those: it belongs to the surface that owns it, and a surface that
 * has none must not grow a second copy of the retry to fill the space.
 */
export function previewActions(
  state: PreviewState,
  options: {
    readonly retry: PreviewAction;
    readonly download: PreviewAction | undefined;
  },
): {
  readonly action: PreviewAction | undefined;
  readonly secondaryAction: PreviewAction | undefined;
} {
  if (state.kind === "host-unavailable") {
    return { action: options.retry, secondaryAction: options.download };
  }
  return { action: options.download, secondaryAction: undefined };
}

/**
 * Does this surface offer a file for download?
 *
 * Kept as a function because two surfaces ask it — the Files panel and the
 * artifact page — and the answer must be the same on both: a file whose bytes are
 * not the bytes its record describes is not offered, and neither is one whose
 * content was removed.
 */
export function offersDownload(
  rule: { readonly mismatch: boolean; readonly contentRemoved: boolean },
): boolean {
  return !rule.mismatch && !rule.contentRemoved;
}
