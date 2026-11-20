/**
 * Which preview a probe answer earns (issue #437, design's answer in comment
 * 7029326304).
 *
 * Pure on purpose: the decision is a table, and a table is worth testing without
 * a browser. The screen renders whatever this returns and adds no judgement of
 * its own, so "a host problem is never blamed on the file" is a property of this
 * function rather than of three call sites.
 *
 * Two rules from the design that are easy to get wrong:
 *
 * - **The kind comes from the probe, not the declared media type.** A `.png`
 *   that is really a zip is an archive, and a preview that trusted the name
 *   would try to decode it as an image.
 * - **A refusal about the host is not a refusal about the file.** `timeout`,
 *   `memory` and `sandbox-unavailable` say nothing about the bytes, so they get
 *   a state that offers to try again; `unreadable` and `malformed` do, and say
 *   the file may be damaged.
 */
import type { ArtifactProbeResult } from "@bakery/contracts/artifact-probe";

/** The display limits the artifact page already had (#445). */
export const PREVIEW_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;
export const PREVIEW_TEXT_LIMIT_BYTES = 1024 * 1024;

export type PreviewState =
  /** No probe has answered yet: a skeleton, not a state. */
  | { readonly kind: "pending" }
  | { readonly kind: "image" }
  | { readonly kind: "text" }
  | { readonly kind: "video" }
  | { readonly kind: "audio" }
  /** A kind Bakery will not render, with the facts line still shown. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "too-large"; readonly limit: number }
  | { readonly kind: "unreadable" }
  /** The host could not check it: nothing is claimed about the file. */
  | { readonly kind: "unchecked" }
  | { readonly kind: "host-unavailable" }
  /** The bytes are not the bytes the record describes. */
  | { readonly kind: "mismatch" };

/**
 * The state for one probe answer.
 *
 * `mismatch` is decided by the caller, which is the only place that has both the
 * stored digest and the bytes it received; everything else is decided here.
 */
export function previewState(
  probe: ArtifactProbeResult | null,
  options: { readonly mismatch?: boolean } = {},
): PreviewState {
  if (options.mismatch === true) return { kind: "mismatch" };
  if (probe === null) return { kind: "pending" };
  if (probe.status === "refused") {
    switch (probe.code) {
      case "too-large":
        return { kind: "too-large", limit: probe.limit ?? 0 };
      case "unreadable":
      case "malformed":
        return { kind: "unreadable" };
      case "timeout":
      case "memory":
        return { kind: "unchecked" };
      case "sandbox-unavailable":
        return { kind: "host-unavailable" };
    }
  }
  switch (probe.kind) {
    case "image":
      // A described image over the display limit is still too large to show,
      // even though the probe could read its header.
      return probe.byteLength > PREVIEW_IMAGE_LIMIT_BYTES
        ? { kind: "too-large", limit: PREVIEW_IMAGE_LIMIT_BYTES }
        : { kind: "image" };
    case "text":
      return probe.byteLength > PREVIEW_TEXT_LIMIT_BYTES
        ? { kind: "too-large", limit: PREVIEW_TEXT_LIMIT_BYTES }
        : { kind: "text" };
    case "video":
      return { kind: "video" };
    case "audio":
      return { kind: "audio" };
    case "pdf":
    case "archive":
    case "unknown":
      return { kind: "unsupported" };
  }
}

/**
 * The states a declared media type can justify, for a file nothing has probed.
 *
 * A name is weaker evidence than bytes, so this is deliberately narrower than
 * `previewState`: it never claims a refusal, never claims a size limit the
 * caller has not measured itself, and anything it does not recognise is simply
 * unsupported. A version whose bytes are stored inline has no blob to probe, so
 * this is the only answer it will ever get.
 */
export function declaredPreviewState(mediaType: string): PreviewState {
  if (mediaType.startsWith("image/")) return { kind: "image" };
  if (mediaType.startsWith("video/")) return { kind: "video" };
  if (mediaType.startsWith("audio/")) return { kind: "audio" };
  if (
    mediaType.startsWith("text/") || mediaType === "application/json" ||
    mediaType === "application/xml"
  ) {
    return { kind: "text" };
  }
  return { kind: "unsupported" };
}
