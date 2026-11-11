import { z } from "zod";

/**
 * The trusted source of the metadata a candidate is judged on. Title, body,
 * commit messages and merge message come from the provider, never from the
 * caller being judged: no HTTP route accepts a snapshot. Only a fixture reader
 * exists so far; a live GitHub reader is not wired yet.
 */

/**
 * No maximum lengths on purpose: the evaluator measures a snapshot against the
 * preview bounds itself and records `metadata_too_large`, because the rule
 * validators slice silently and a truncated text must never be judged.
 */
export const CandidateMetadataSnapshotSchema = z.object({
  commitMessages: z.array(
    z.string().describe("Full message of one commit, subject first."),
  ).describe("Messages of the commits being delivered, oldest first."),
  title: z.string().describe("Current pull request title."),
  body: z.string().describe("Current pull request description, as written."),
  mergeMessage: z.union([
    z.string().describe("The message the merge or squash commit will carry."),
    z.null().describe("The provider has not produced a merge message."),
  ]).describe(
    "The merge or squash message the provider would use, or null when unknown.",
  ),
}).strict().describe(
  "Trusted snapshot of the commit, title, description and merge messages a candidate is judged on.",
);
export type CandidateMetadataSnapshot = z.output<
  typeof CandidateMetadataSnapshotSchema
>;

/** Which candidate a reader should describe. */
export type CandidateMetadataRef = {
  readonly organizationId: string;
  readonly runId: string;
  readonly headSha: string;
  readonly baseSha: string | null;
};

/**
 * Port to a trusted metadata source. Implementations must read provider state
 * the candidate cannot write; `null` means the source has nothing for this
 * candidate.
 */
export type CandidateMetadataReader = {
  read(ref: CandidateMetadataRef): Promise<CandidateMetadataSnapshot | null>;
};

/**
 * Reads a snapshot and returns it only when the reader produced a well-formed
 * one. A reader that returns null, throws, or returns something else yields
 * null, and the caller records every metadata check as unavailable: a failing
 * source must read as missing evidence, never as a pass.
 */
export async function loadMetadataSnapshot(
  reader: CandidateMetadataReader,
  ref: CandidateMetadataRef,
): Promise<CandidateMetadataSnapshot | null> {
  let value: unknown;
  try {
    value = await reader.read(ref);
  } catch {
    return null;
  }
  const parsed = CandidateMetadataSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
