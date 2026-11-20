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
 * - **The app's own formatting.** Bytes go through the same rule as
 *   `TaskRunArtifactCard` — `Intl.NumberFormat` with one fraction digit over
 *   kilobytes, and the catalog's own unit — so the facts line and the artifact
 *   card never disagree about how big a file is.
 *
 * A refusal produces no line at all: the refusal is already on screen as its
 * own state, and repeating it under an empty preview would say it twice.
 */
import type { ArtifactProbeResult } from "@bakery/contracts/artifact-probe";

/** The translator this helper needs, injected so it stays free of React. */
export type PreviewFactsTranslate = (
  key: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

/**
 * A duration as minutes and seconds, which is how a player shows it.
 *
 * Rounded down, like a player's elapsed counter: 12.5 seconds is "0:12", not
 * "0:13". Rounding up would claim a length the file does not have yet.
 */
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The facts line for one probe answer, or `""` when there is nothing measured
 * to show.
 */
export function previewFacts(
  probe: ArtifactProbeResult | null,
  locale: string,
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
    facts.push(
      t("files.preview.facts.duration", {
        duration: formatDuration(probe.durationMs),
      }),
    );
  }
  if (probe.lineCount !== undefined) {
    facts.push(t("files.preview.facts.lines", { lines: probe.lineCount }));
  }
  facts.push(
    t("tasks.run.artifact.size", {
      size: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
        .format(probe.byteLength / 1024),
    }),
  );
  return facts.join(" · ");
}
