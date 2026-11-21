/**
 * The one line of measured facts under an artifact preview (issue #437,
 * design's answer in comment 7029326304).
 *
 * Two rules shape this, and both are about not lying:
 *
 * - **Only measured facts.** The probe answers with what the bytes themselves
 *   state. A format that does not state a duration gets no duration, not
 *   "unknown" and not `0`; a reader who cannot tell measured numbers from
 *   placeholders learns to distrust the line.
 * - **The app's own formatting.** Bytes go through the Files screens' formatter
 *   (`formatFileSize`: the catalog's unit keys, one fraction digit at most), so
 *   this line and the Size row beside it never disagree about how big a file is.
 *   "0.1 KiB" above "Size 77 B" is two facts, one of them wrong.
 *
 * A refusal produces no line at all: the refusal is already on screen as its
 * own state, and repeating it under an empty preview would say it twice.
 */
import type { SupportedLocale } from "@bakery/i18n";
import type { ArtifactProbeResult } from "@bakery/contracts/artifact-probe";
import { formatFileSize } from "./file-size.ts";

/** The translator this helper needs, injected so it stays free of React. */
export type PreviewFactsTranslate = (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

/**
 * A duration split into minutes and seconds, which is how the catalog says it:
 * "2 min 14 s". Rounded down, like a player's elapsed counter: 12.5 seconds is
 * "0 min 12 s", not "0 min 13 s" -- rounding up would claim a length the file
 * does not have yet.
 */
function durationParts(
  durationMs: number,
): { minutes: number; seconds: number } {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

/**
 * The facts line for one probe answer, or `""` when there is nothing measured
 * to show.
 */
export function previewFacts(
  probe: ArtifactProbeResult | null,
  locale: SupportedLocale,
  t: PreviewFactsTranslate,
): string {
  if (probe === null || probe.status !== "described") return "";
  const facts: string[] = [];
  const kindLabel = t(`files.preview.facts.${probe.kind}`, {
    kind: probe.kind.at(0)?.toUpperCase() + probe.kind.slice(1),
  });
  facts.push(kindLabel);
  if (probe.width !== undefined && probe.height !== undefined) {
    facts.push(
      t("files.preview.facts.pixels", {
        width: probe.width,
        height: probe.height,
      }),
    );
  }
  if (probe.durationMs !== undefined) {
    const { minutes, seconds } = durationParts(probe.durationMs);
    // Under a minute, "0 min 2 s" states a zero that is not a measurement. The
    // catalog has a seconds-only sentence for exactly this, and "2 min 14 s"
    // keeps its minutes (#437, UX review).
    facts.push(
      minutes === 0
        ? t("files.preview.facts.durationSeconds", { seconds })
        : t("files.preview.facts.duration", { minutes, seconds }),
    );
  }
  if (probe.lineCount !== undefined) {
    facts.push(t("files.preview.facts.lines", { lines: probe.lineCount }));
  }
  // The Files screens' own formatter, so this line and the Size row beside it say
  // the same thing in the same words.
  facts.push(formatFileSize(probe.byteLength, locale, t));
  return facts.join(" · ");
}
