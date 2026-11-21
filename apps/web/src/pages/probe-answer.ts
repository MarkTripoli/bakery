/**
 * The wire's flat probe answer, back in the shape the rest of the app reasons
 * about (issue #437, slices 2 and 3).
 *
 * The HTTP contract says one thing per field and `null` for "not measured",
 * because the transport description cannot express the probe's own union and
 * because null-per-fact is the rule the facts line follows. `previewFacts` and
 * `previewState` both want the union, so this is the single place the two meet.
 *
 * A `status` of null means no probe has answered for this blob yet, which is not
 * a refusal: it becomes `null` here, and a caller shows a skeleton rather than a
 * state. Anything else is rebuilt field by field, so a field the answer does not
 * carry stays absent instead of arriving as `undefined` on a described file.
 */
import type {
  ArtifactProbeFailureCode,
  ArtifactProbeKind,
  ArtifactProbeResult,
} from "@bakery/contracts/artifact-probe";

/** The generated output type, structurally. */
export type ProbeAnswer = Readonly<{
  status: "described" | "refused" | null;
  kind: string | null;
  mediaType: string | null;
  byteLength: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  lineCount: number | null;
  utf8: boolean | null;
  code: string | null;
  limit: number | null;
  probedAt: string | null;
}>;

export function probeFromAnswer(
  answer: ProbeAnswer | null | undefined,
): ArtifactProbeResult | null {
  if (!answer || answer.status === null) return null;
  if (answer.status === "refused") {
    if (answer.code === null) return null;
    return {
      status: "refused",
      code: answer.code as ArtifactProbeFailureCode,
      ...(answer.limit === null ? {} : { limit: answer.limit }),
    } as ArtifactProbeResult;
  }
  if (answer.kind === null || answer.mediaType === null) return null;
  return {
    status: "described",
    kind: answer.kind as ArtifactProbeKind,
    mediaType: answer.mediaType,
    byteLength: answer.byteLength ?? 0,
    ...(answer.width === null ? {} : { width: answer.width }),
    ...(answer.height === null ? {} : { height: answer.height }),
    ...(answer.durationMs === null ? {} : { durationMs: answer.durationMs }),
    ...(answer.lineCount === null ? {} : { lineCount: answer.lineCount }),
    ...(answer.utf8 === null ? {} : { utf8: answer.utf8 }),
  } as ArtifactProbeResult;
}
