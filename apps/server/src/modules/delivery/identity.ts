import { z } from "zod";
import {
  CHECK_KINDS,
  CHECK_REASONS,
  CHECK_RESULTS,
  type CheckKind,
  isCoherentCheckOutcome,
  ruleEntryDigest,
} from "@bakery/contracts/check-evidence";
import {
  type EffectiveRepositoryRuleEntry,
  REPOSITORY_RULE_KEYS,
} from "@bakery/contracts/repository-rules";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { CandidateMetadataSnapshot } from "./metadata-reader.ts";

/**
 * What a recorded check depends on, and how to tell that it changed. A row
 * stores the value of every part it is bound to; the candidate's current
 * identity supplies the same parts; a part that differs, or that the current
 * identity cannot supply, makes the row stale.
 */

/** Lowercase SHA-256 hex digest, the shape of every identity digest. */
export const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 hex digest of a canonical identity.",
);

/** Git object id: 40 hex characters (SHA-1) or 64 (SHA-256 repositories). */
export const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .describe("Lowercase hexadecimal git commit id.");

/** A schema that also accepts null, with the meaning of null spelled out. */
export function nullable<T extends z.ZodType>(
  schema: T,
  nullMeaning: string,
) {
  return z.union([schema, z.null().describe(nullMeaning)]).describe(
    `${schema.description ?? "Value"} Null means: ${nullMeaning}`,
  );
}

const RuleKeySchema = z.enum(REPOSITORY_RULE_KEYS).describe(
  "Repository rule key that a metadata check row evaluates.",
);

/** The identity parts a check row can be bound to. */
export const BOUND_PARTS = Object.freeze(
  [
    "head",
    "base",
    "profile",
    "checker",
    "subject",
    "commit_selection",
    "title",
    "body",
    "merge_message",
  ] as const,
);
export type BoundPart = typeof BOUND_PARTS[number];

/**
 * The parts each kind of check depends on. Every kind is bound to the head and
 * the base: delivery evidence binds the whole candidate, so a changed head or
 * base stales every recorded check, text checks included, and re-evaluating one
 * is cheap while keeping a stale pass is the risk. On top of that each kind
 * binds what it judges: a command its profile and checker, a commits check the
 * commit selection, a title, description or merge message check its own text.
 * `subject` is the digest of what the check enforces: the fixed command plus
 * its bound rule entry for a command, the rule entry for a metadata rule. The
 * effective policy digest is a record of the whole policy and is deliberately
 * not bound: an unrelated rule change must not stale a title check, and a
 * changed command or rule entry reaches its own row through `subject`.
 */
const BOUND_PARTS_BY_KIND: Readonly<Record<CheckKind, readonly BoundPart[]>> =
  Object.freeze({
    command: Object.freeze(
      ["head", "base", "profile", "checker", "subject"] as const,
    ),
    commits: Object.freeze(
      ["head", "base", "commit_selection", "subject"] as const,
    ),
    title: Object.freeze(["head", "base", "title", "subject"] as const),
    description: Object.freeze(["head", "base", "body", "subject"] as const),
    merge_message: Object.freeze(
      ["head", "base", "merge_message", "subject"] as const,
    ),
  });

/** The identity parts a check of `kind` is bound to, in comparison order. */
export function boundParts(kind: CheckKind): readonly BoundPart[] {
  return BOUND_PARTS_BY_KIND[kind];
}

/**
 * Key of one check's subject digest inside `CandidateIdentity.subjects`. A
 * command id and a rule key share a namespace in the fixed policy (a command
 * may be called `commits.semantic`), so the key says which one it names.
 */
export function subjectKey(kind: CheckKind, checkId: string): string {
  return kind === "command" ? `command:${checkId}` : `rule:${checkId}`;
}

/** The candidate as it stands now, to compare recorded checks against. */
export const CandidateIdentitySchema = z.object({
  headSha: GitShaSchema.describe("Commit id of the candidate head."),
  baseSha: nullable(
    GitShaSchema.describe("Commit id of the candidate base."),
    "the base commit is not known.",
  ),
  profileDigest: nullable(
    DigestSchema.describe("Digest of the pinned repository profile."),
    "no profile is pinned.",
  ),
  checkerDigest: nullable(
    DigestSchema.describe("Digest of the trusted checker configuration."),
    "no trusted checker is pinned.",
  ),
  subjects: z.record(
    z.string().min(1).max(200).describe(
      "Subject key built by subjectKey: command:<id> or rule:<ruleKey>.",
    ),
    DigestSchema.describe(
      "Current subject digest of that command or rule entry.",
    ),
  ).describe(
    "Current subject digest per command id or rule key, keyed by subjectKey.",
  ),
  titleDigest: nullable(
    DigestSchema.describe("Digest of the current pull request title."),
    "the title is not known.",
  ),
  bodyDigest: nullable(
    DigestSchema.describe("Digest of the current pull request description."),
    "the description is not known.",
  ),
  mergeMessageDigest: nullable(
    DigestSchema.describe("Digest of the current merge or squash message."),
    "no merge message is known.",
  ),
  commitSelectionDigest: nullable(
    DigestSchema.describe("Digest of the commit messages being delivered."),
    "the commit selection is not known.",
  ),
}).strict().describe(
  "Identity of the candidate right now. A recorded check is fresh only while every part it is bound to still matches.",
);
export type CandidateIdentity = z.output<typeof CandidateIdentitySchema>;

/** One recorded check as freshness and the verdict read it. */
export const CheckRunEvidenceSchema = z.object({
  id: z.uuid().describe("Identifier of the recorded check row."),
  checkId: z.string().min(1).max(200).describe(
    "Fixed policy command id, or the rule key of a metadata check.",
  ),
  kind: z.enum(CHECK_KINDS).describe("What the row observed."),
  ruleKey: nullable(RuleKeySchema, "the row is not tied to a rule."),
  result: z.enum(CHECK_RESULTS).describe("Outcome of the check."),
  reason: z.enum(CHECK_REASONS).describe("Why the check has that outcome."),
  createdAt: z.iso.datetime().describe(
    "When the row was recorded; the newest row for a check decides.",
  ),
  headSha: GitShaSchema.describe("Head commit the row was recorded against."),
  baseSha: nullable(
    GitShaSchema.describe("Base commit the row was recorded against."),
    "no base was recorded.",
  ),
  profileDigest: nullable(
    DigestSchema.describe("Profile digest recorded with the row."),
    "no profile digest was recorded.",
  ),
  subjectDigest: DigestSchema.describe(
    "Digest of the command or rule entry the row enforced.",
  ),
  checkerDigest: nullable(
    DigestSchema.describe("Trusted checker digest recorded with the row."),
    "no checker digest was recorded.",
  ),
  titleDigest: nullable(
    DigestSchema.describe("Title digest recorded with the row."),
    "no title was evaluated.",
  ),
  bodyDigest: nullable(
    DigestSchema.describe("Description digest recorded with the row."),
    "no description was evaluated.",
  ),
  mergeMessageDigest: nullable(
    DigestSchema.describe("Merge message digest recorded with the row."),
    "no merge message was evaluated.",
  ),
  commitSelectionDigest: nullable(
    DigestSchema.describe("Commit selection digest recorded with the row."),
    "no commit selection was evaluated.",
  ),
}).strict().describe(
  "The recorded check fields that freshness and the delivery verdict read.",
);
export type CheckRunEvidence = z.output<typeof CheckRunEvidenceSchema>;

/**
 * True when a row may count as evidence at all: its reason has to explain its
 * result. A row that contradicts itself is never a pass.
 */
export function isCoherentEvidence(
  row: Pick<CheckRunEvidence, "result" | "reason">,
): boolean {
  return isCoherentCheckOutcome(row.result, row.reason);
}

export type FreshnessAssessment =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly changed: readonly BoundPart[] };

/** The fields of a check row that hold what it was bound to. */
export type RecordedParts = Pick<
  CheckRunEvidence,
  | "headSha"
  | "baseSha"
  | "profileDigest"
  | "checkerDigest"
  | "subjectDigest"
  | "commitSelectionDigest"
  | "titleDigest"
  | "bodyDigest"
  | "mergeMessageDigest"
>;

/** What the row recorded for one bound part. */
function recordedPart(
  part: BoundPart,
  row: RecordedParts,
): string | null {
  switch (part) {
    case "head":
      return row.headSha;
    case "base":
      return row.baseSha;
    case "profile":
      return row.profileDigest;
    case "checker":
      return row.checkerDigest;
    case "subject":
      return row.subjectDigest;
    case "commit_selection":
      return row.commitSelectionDigest;
    case "title":
      return row.titleDigest;
    case "body":
      return row.bodyDigest;
    case "merge_message":
      return row.mergeMessageDigest;
  }
}

/**
 * The parts of `kind` that `row` recorded no value for, in comparison order.
 * A row that is to count as a pass has to record every part its kind is bound
 * to: `assessFreshness` treats a missing value as a changed part, so a pass
 * without one could never be fresh and only hides how it was made.
 */
export function unrecordedBoundParts(
  kind: CheckKind,
  row: RecordedParts,
): BoundPart[] {
  return boundParts(kind).filter((part) => recordedPart(part, row) === null);
}

/** What the candidate says now for one bound part, or null when it cannot. */
function currentPart(
  part: BoundPart,
  row: CheckRunEvidence,
  current: CandidateIdentity,
): string | null {
  switch (part) {
    case "head":
      return current.headSha;
    case "base":
      return current.baseSha;
    case "profile":
      return current.profileDigest;
    case "checker":
      return current.checkerDigest;
    case "subject": {
      const key = subjectKey(row.kind, row.checkId);
      return Object.hasOwn(current.subjects, key)
        ? current.subjects[key]
        : null;
    }
    case "commit_selection":
      return current.commitSelectionDigest;
    case "title":
      return current.titleDigest;
    case "body":
      return current.bodyDigest;
    case "merge_message":
      return current.mergeMessageDigest;
  }
}

/**
 * Compares a recorded row with the candidate as it is now. A part counts as
 * unchanged only when both sides hold the same value; a part the current
 * identity cannot supply, or one the row never recorded, counts as changed, so
 * missing information can never keep evidence fresh.
 */
export function assessFreshness(
  row: CheckRunEvidence,
  current: CandidateIdentity,
): FreshnessAssessment {
  const changed = boundParts(row.kind).filter((part) => {
    const recorded = recordedPart(part, row);
    const now = currentPart(part, row, current);
    return recorded === null || now === null || recorded !== now;
  });
  return changed.length === 0 ? { fresh: true } : { fresh: false, changed };
}

/** Digest of a rule entry; the subject of a metadata check. */
export function ruleSubjectDigest(
  entry: EffectiveRepositoryRuleEntry,
): Promise<string> {
  return ruleEntryDigest(entry);
}

/**
 * Subject digest of a fixed policy command: its id and argv, plus the digest
 * of the rule entry that binds it when there is one. Changing either the
 * command or its bound rule changes the subject, and nothing else does.
 */
export async function commandSubjectDigest(
  command: { readonly id: string; readonly argv: readonly string[] },
  boundRule: EffectiveRepositoryRuleEntry | null,
): Promise<string> {
  return await sha256Hex(canonicalJson({
    command: { id: command.id, argv: command.argv },
    ruleEntryDigest: boundRule ? await ruleEntryDigest(boundRule) : null,
  }));
}

/** The metadata identities of a snapshot; null where it holds nothing. */
export type MetadataDigests = {
  readonly titleDigest: string | null;
  readonly bodyDigest: string | null;
  readonly mergeMessageDigest: string | null;
  readonly commitSelectionDigest: string | null;
};

/**
 * Identities of the trusted metadata snapshot. The recorder and the caller
 * that builds the current `CandidateIdentity` both use this, so a row and the
 * identity it is compared with digest the same text the same way. A missing
 * snapshot yields only nulls: nothing is known, so nothing can be fresh.
 */
export async function metadataDigests(
  snapshot: CandidateMetadataSnapshot | null,
): Promise<MetadataDigests> {
  if (snapshot === null) {
    return {
      titleDigest: null,
      bodyDigest: null,
      mergeMessageDigest: null,
      commitSelectionDigest: null,
    };
  }
  return {
    titleDigest: await sha256Hex(canonicalJson({ title: snapshot.title })),
    bodyDigest: await sha256Hex(canonicalJson({ body: snapshot.body })),
    mergeMessageDigest: snapshot.mergeMessage === null
      ? null
      : await sha256Hex(canonicalJson({ mergeMessage: snapshot.mergeMessage })),
    commitSelectionDigest: await sha256Hex(
      canonicalJson({ commitMessages: snapshot.commitMessages }),
    ),
  };
}
