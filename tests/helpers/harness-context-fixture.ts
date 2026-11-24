import type { JobAssignment } from "../../apps/worker/src/types.ts";

/** What a step with one pinned input slot hands a coding harness (#527). */
export type PinnedBrief = {
  /** The pinned digest; the prompt index must name it. */
  readonly digest: string;
  /** The assignment carrying the one declared slot and its pin. */
  readonly withContext: (assignment: JobAssignment) => JobAssignment;
  /** The route's answer: the bytes admission pinned, as the worker reads them. */
  readonly readAttemptContext: () => Promise<{
    readonly inputs: ReadonlyArray<{
      readonly artifactVersionId: string;
      readonly artifactId: string;
      readonly digest: string;
      readonly sizeBytes: number;
      readonly mediaType: string;
      readonly contentBase64: string;
    }>;
    readonly facts: null;
  }>;
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
    readAttemptContext: () =>
      Promise.resolve({ inputs: [served], facts: null }),
  };
}

/**
 * One pinned input slot holding `text`, as admission pins the artifact a
 * previous step published: the same artifact id, version id and digest the
 * previous step reported, so a test can prove the exact version was passed on.
 */
export async function pinnedInput(options: {
  readonly slot: string;
  readonly path: string;
  readonly text: string;
  readonly artifactId?: string;
  readonly artifactVersionId?: string;
}): Promise<PinnedBrief> {
  const bytes = new TextEncoder().encode(options.text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = [...new Uint8Array(hash)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const served = {
    artifactVersionId: options.artifactVersionId ?? crypto.randomUUID(),
    artifactId: options.artifactId ?? crypto.randomUUID(),
    digest,
    sizeBytes: bytes.length,
    mediaType: "text/markdown",
    contentBase64: btoa(String.fromCharCode(...bytes)),
  };
  return {
    digest,
    withContext: (assignment) =>
      ({
        ...assignment,
        contextInputs: [{
          slot: options.slot,
          path: options.path,
          digest,
          sizeBytes: bytes.length,
          mediaType: "text/markdown",
        }],
      }) as JobAssignment,
    readAttemptContext: () =>
      Promise.resolve({ inputs: [served], facts: null }),
  };
}
