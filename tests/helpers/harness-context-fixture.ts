import type { JobAssignment } from "../../apps/worker/src/types.ts";

/** What a step with one pinned input slot hands a coding harness (#527). */
export type PinnedBrief = {
  /** The pinned digest; the prompt index must name it. */
  readonly digest: string;
  /** The assignment carrying the one declared slot and its pin. */
  readonly withContext: (assignment: JobAssignment) => JobAssignment;
  /** The route's answer: the bytes admission pinned, as the worker reads them. */
  readonly readAttemptContext: () => Promise<
    ReadonlyArray<{
      readonly artifactVersionId: string;
      readonly artifactId: string;
      readonly digest: string;
      readonly sizeBytes: number;
      readonly mediaType: string;
      readonly contentBase64: string;
    }>
  >;
};

const BRIEF = "# The brief";

/** One markdown slot, `brief`, written to `brief.md` in the attempt's context. */
export async function pinnedBrief(): Promise<PinnedBrief> {
  const bytes = new TextEncoder().encode(BRIEF);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = [...new Uint8Array(hash)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const served = {
    artifactVersionId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
    digest,
    sizeBytes: bytes.length,
    mediaType: "text/markdown",
    contentBase64: btoa(BRIEF),
  };
  return {
    digest,
    withContext: (assignment) => ({
      ...assignment,
      contextInputs: [{
        slot: "brief",
        path: "brief.md",
        digest,
        sizeBytes: bytes.length,
        mediaType: "text/markdown",
      }],
    } as JobAssignment),
    readAttemptContext: () => Promise.resolve([served]),
  };
}
