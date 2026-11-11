import { z } from "zod";
import {
  CHECK_KINDS,
  CHECK_REASONS,
  CHECK_RESULTS,
  type CheckKind,
  type CheckReason,
  type CheckResult,
  isCoherentCheckOutcome,
} from "@bakery/contracts/check-evidence";
import { StandardError } from "@bakery/contracts/http";
import {
  evaluateRuleSample,
  type RuleSampleInput,
  type RuleSampleResult,
  SAMPLE_MAX_COMMIT_MESSAGE_CHARS,
  SAMPLE_MAX_COMMIT_MESSAGES,
  SAMPLE_MAX_DESCRIPTION_CHARS,
  SAMPLE_MAX_TITLE_CHARS,
} from "@bakery/contracts/repository-rule-preview";
import {
  type EffectiveRepositoryRuleEntry,
  REPOSITORY_RULE_KEYS,
  type RepositoryRuleKey,
} from "@bakery/contracts/repository-rules";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type BoundPart,
  boundParts,
  type CandidateIdentity,
  DigestSchema,
  GitShaSchema,
  metadataDigests,
  nullable,
  ruleSubjectDigest,
  subjectKey,
  unrecordedBoundParts,
} from "./identity.ts";
import type { CandidateMetadataSnapshot } from "./metadata-reader.ts";
import { type CheckRequirement, mergeRequirements } from "./verdict.ts";

/**
 * Commit, title, description and merge message checks. Each enabled rule is
 * judged by the existing pure validators (`evaluateRuleSample`) against a
 * trusted metadata snapshot, and the outcome is shaped as a check row bound to
 * exactly the identity parts it depends on. A rule that cannot be judged is
 * `unavailable`, never a pass.
 */

/** The identity parts a metadata evaluation is bound to. */
export type MetadataIdentity = Pick<
  CandidateIdentity,
  "headSha" | "baseSha" | "profileDigest" | "checkerDigest"
>;

/** One evaluated rule, ready to be recorded as a `check_runs` row. */
export const MetadataCheckRowSchema = z.object({
  checkId: z.enum(REPOSITORY_RULE_KEYS).describe(
    "Rule key; metadata checks use it as their check id.",
  ),
  kind: z.enum(CHECK_KINDS).describe("What the row observed."),
  ruleKey: z.enum(REPOSITORY_RULE_KEYS).describe("Rule the row evaluated."),
  result: z.enum(CHECK_RESULTS).describe("Outcome of the evaluation."),
  reason: z.enum(CHECK_REASONS).describe(
    "Why the evaluation has that outcome.",
  ),
  headSha: GitShaSchema.describe("Head commit the evaluation was bound to."),
  baseSha: nullable(
    GitShaSchema.describe("Base commit the evaluation was bound to."),
    "the base commit was not bound.",
  ),
  profileDigest: nullable(
    DigestSchema.describe("Profile digest the evaluation was bound to."),
    "the profile was not bound.",
  ),
  policyDigest: DigestSchema.describe(
    "Effective policy digest in force when the row was recorded.",
  ),
  subjectDigest: DigestSchema.describe("Digest of the rule entry evaluated."),
  checkerDigest: nullable(
    DigestSchema.describe(
      "Trusted checker digest the evaluation was bound to.",
    ),
    "the checker was not bound.",
  ),
  titleDigest: nullable(
    DigestSchema.describe("Digest of the title that was evaluated."),
    "the row does not depend on the title.",
  ),
  bodyDigest: nullable(
    DigestSchema.describe("Digest of the description that was evaluated."),
    "the row does not depend on the description.",
  ),
  mergeMessageDigest: nullable(
    DigestSchema.describe("Digest of the merge message that was evaluated."),
    "the row does not depend on the merge message.",
  ),
  commitSelectionDigest: nullable(
    DigestSchema.describe("Digest of the commit messages that were evaluated."),
    "the row does not depend on the commit messages.",
  ),
}).strict().superRefine((row, context) => {
  if (!isCoherentCheckOutcome(row.result, row.reason)) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "The reason does not explain the result.",
    });
  }
  if (row.checkId !== row.ruleKey) {
    context.addIssue({
      code: "custom",
      path: ["checkId"],
      message: "A metadata check is identified by its rule key.",
    });
  }
}).describe(
  "One commit, title, description, merge message or unbound rule evaluation, shaped as a check row.",
);
export type MetadataCheckRow = z.output<typeof MetadataCheckRowSchema>;

type Verdict = { readonly result: CheckResult; readonly reason: CheckReason };

const PASSED: Verdict = { result: "passed", reason: "verified" };
const FAILED: Verdict = { result: "failed", reason: "rule_violation" };
const PLACEHOLDER: Verdict = {
  result: "failed",
  reason: "description_placeholder",
};
const MISSING: Verdict = { result: "unavailable", reason: "metadata_missing" };
const TOO_LARGE: Verdict = {
  result: "unavailable",
  reason: "metadata_too_large",
};
const UNBOUND: Verdict = { result: "unavailable", reason: "rule_unbound" };
const UNSUPPORTED: Verdict = {
  result: "unavailable",
  reason: "unsupported_checker",
};
const SKIPPED: Verdict = { result: "unavailable", reason: "skipped" };

/**
 * The kind of check row an enabled rule produces, or null when the rule
 * produces no metadata row. Semantic commits are judged on every commit, or on
 * the merge message alone when the rule looks only at the final squash commit.
 * A magic-value rule with a bound command is judged by that command's own row;
 * only an unbound one is recorded here, as unavailable.
 */
function metadataKind(entry: EffectiveRepositoryRuleEntry): CheckKind | null {
  if (!entry.enabled) return null;
  switch (entry.ruleKey) {
    case "commits.semantic":
      return entry.options.range === "final_squash_commit"
        ? "merge_message"
        : "commits";
    case "changeRequest.semanticTitle":
      return "title";
    case "changeRequest.description":
      return "description";
    case "code.magicNumbers":
    case "code.magicStrings":
      return entry.options.checkBinding === null ? "command" : null;
  }
}

/**
 * The command an enabled magic-value rule is bound to, or null for any other
 * rule, a disabled rule or an unbound magic rule. A bound rule is enforced by
 * that command's own row, written by the `quality.check` finalizer.
 */
function boundCommandId(entry: EffectiveRepositoryRuleEntry): string | null {
  if (!entry.enabled) return null;
  switch (entry.ruleKey) {
    case "code.magicNumbers":
    case "code.magicStrings":
      return entry.options.checkBinding;
    default:
      return null;
  }
}

/**
 * The requirements the enabled rules of these entries answer, one per check:
 *
 * - a commit, title, description or merge message rule, and an unbound
 *   magic-value rule, answer their own metadata row (`evaluateMetadataChecks`);
 * - a magic-value rule bound to a command answers that command's row, with the
 *   rule's mode, so a required bound rule blocks until its command has run and
 *   passed. The command row's subject key is `subjectKey("command", id)`; its
 *   digest comes from the pins (`commandSubjects`), not from this module,
 *   because it covers the command's argv.
 *
 * Two rules bound to one command give one requirement with the stricter mode.
 * When asking whether a delivery is blocked, join these with the commands' own
 * requirements through `mergeRequirements`: the fixed policy and a bound rule
 * both name that command, and the merge keeps one entry with the stricter mode.
 */
export function metadataRequirements(
  entries: readonly EffectiveRepositoryRuleEntry[],
): CheckRequirement[] {
  const requirements: CheckRequirement[] = [];
  for (const entry of entries) {
    const kind = metadataKind(entry);
    const command = boundCommandId(entry);
    if (kind !== null) {
      requirements.push({ kind, checkId: entry.ruleKey, mode: entry.mode });
    } else if (command !== null) {
      requirements.push({
        kind: "command",
        checkId: command,
        mode: entry.mode,
      });
    }
  }
  return mergeRequirements(requirements);
}

/**
 * Subject digests of the rows these entries produce, keyed for
 * `CandidateIdentity.subjects`. The recorder and a caller building the current
 * identity both use this, so a rule entry is digested one way everywhere.
 */
export async function metadataSubjects(
  entries: readonly EffectiveRepositoryRuleEntry[],
): Promise<Record<string, string>> {
  const subjects: Record<string, string> = {};
  for (const entry of entries) {
    const kind = metadataKind(entry);
    if (kind !== null) {
      subjects[subjectKey(kind, entry.ruleKey)] = await ruleSubjectDigest(
        entry,
      );
    }
  }
  return subjects;
}

/** Removes `<!-- ... -->` comments in one pass; an unclosed comment drops the rest. */
function stripHtmlComments(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("<!--", at);
    if (open === -1) {
      out += text.slice(at);
      break;
    }
    out += text.slice(at, open);
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    at = close + 3;
  }
  return out;
}

/**
 * What a reader sees of `text`, for comparing it with a template: comments
 * removed, line endings folded, each line trimmed at both ends with inner runs
 * of spaces and tabs collapsed, and blank lines dropped altogether. Whitespace
 * is the one thing a body can change without saying anything, so it must not
 * separate a body from its template.
 */
function visibleText(text: string): string {
  return stripHtmlComments(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * A description that says nothing: empty, only comments and whitespace, or the
 * template itself with its comments removed and its whitespace ignored. The
 * section validator passes any body when a rule lists no required sections, so
 * this runs regardless.
 */
function isPlaceholderBody(body: string, template: string): boolean {
  const visible = visibleText(body);
  return visible === "" || visible === visibleText(template);
}

function sampleVerdict(result: RuleSampleResult): Verdict {
  if (result.status === "pass") return PASSED;
  if (result.status === "fail") return FAILED;
  const codes = result.findings.map(({ code }) => code);
  if (codes.includes("sample_not_provided")) return MISSING;
  if (codes.includes("merge_or_revert_exempt")) return SKIPPED;
  return UNSUPPORTED;
}

/**
 * Judges one enabled rule. A magic-value rule has no checker of its own here,
 * so it is unbound whatever the snapshot holds; any other rule needs a
 * snapshot to read.
 */
function judge(
  entry: EffectiveRepositoryRuleEntry,
  snapshot: CandidateMetadataSnapshot | null,
): Verdict {
  if (
    entry.ruleKey === "code.magicNumbers" ||
    entry.ruleKey === "code.magicStrings"
  ) {
    return UNBOUND;
  }
  if (snapshot === null) return MISSING;
  let sample: RuleSampleInput;
  switch (entry.ruleKey) {
    case "commits.semantic": {
      if (entry.options.range === "final_squash_commit") {
        if (snapshot.mergeMessage === null) return MISSING;
        if (snapshot.mergeMessage.length > SAMPLE_MAX_COMMIT_MESSAGE_CHARS) {
          return TOO_LARGE;
        }
        sample = { commitMessages: [snapshot.mergeMessage] };
        break;
      }
      // The validator slices to its bounds without saying so, so anything over
      // them is refused here rather than judged on a truncated copy.
      if (
        snapshot.commitMessages.length > SAMPLE_MAX_COMMIT_MESSAGES ||
        snapshot.commitMessages.some((message) =>
          message.length > SAMPLE_MAX_COMMIT_MESSAGE_CHARS
        )
      ) return TOO_LARGE;
      sample = { commitMessages: snapshot.commitMessages };
      break;
    }
    case "changeRequest.semanticTitle":
      if (snapshot.title.length > SAMPLE_MAX_TITLE_CHARS) return TOO_LARGE;
      sample = { pullRequestTitle: snapshot.title };
      break;
    case "changeRequest.description":
      if (snapshot.body.length > SAMPLE_MAX_DESCRIPTION_CHARS) {
        return TOO_LARGE;
      }
      if (isPlaceholderBody(snapshot.body, entry.options.template)) {
        return PLACEHOLDER;
      }
      sample = { pullRequestDescription: snapshot.body };
      break;
  }
  const results = evaluateRuleSample([entry], sample);
  const result = results.find(({ ruleKey }) => ruleKey === entry.ruleKey);
  return result ? sampleVerdict(result) : UNSUPPORTED;
}

/**
 * Evaluates every enabled metadata rule against the snapshot and returns one
 * row per rule. A missing snapshot makes every row `unavailable` with reason
 * `metadata_missing`. Disabled or absent rules produce no row. Each row stores
 * the current value of exactly the parts `boundParts(kind)` names, so what is
 * recorded here is what `assessFreshness` later compares.
 */
export async function evaluateMetadataChecks(input: {
  readonly entries: readonly EffectiveRepositoryRuleEntry[];
  readonly snapshot: CandidateMetadataSnapshot | null;
  readonly identity: MetadataIdentity;
  readonly policyDigest: string;
}): Promise<MetadataCheckRow[]> {
  const digests = await metadataDigests(input.snapshot);
  const rows: MetadataCheckRow[] = [];
  for (const entry of input.entries) {
    const kind = metadataKind(entry);
    if (kind === null) continue;
    const verdict = judge(entry, input.snapshot);
    const bound = new Set<BoundPart>(boundParts(kind));
    rows.push(MetadataCheckRowSchema.parse({
      checkId: entry.ruleKey,
      kind,
      ruleKey: entry.ruleKey,
      ...verdict,
      headSha: input.identity.headSha,
      baseSha: bound.has("base") ? input.identity.baseSha : null,
      profileDigest: bound.has("profile") ? input.identity.profileDigest : null,
      policyDigest: input.policyDigest,
      subjectDigest: await ruleSubjectDigest(entry),
      checkerDigest: bound.has("checker") ? input.identity.checkerDigest : null,
      titleDigest: bound.has("title") ? digests.titleDigest : null,
      bodyDigest: bound.has("body") ? digests.bodyDigest : null,
      mergeMessageDigest: bound.has("merge_message")
        ? digests.mergeMessageDigest
        : null,
      commitSelectionDigest: bound.has("commit_selection")
        ? digests.commitSelectionDigest
        : null,
    }));
  }
  return rows;
}

/** `VALIDATION_FAILED` reason when a row handed to the recorder cannot be trusted. */
export const CHECK_ROW_INVALID_REASON = "check_row_invalid";

function invalidRow(detail: string, index?: number): never {
  throw new StandardError({
    code: "VALIDATION_FAILED",
    params: {
      reason: CHECK_ROW_INVALID_REASON,
      detail,
      ...(index === undefined ? {} : { index }),
    },
  });
}

/** The check kinds each rule key may be recorded under. */
const KINDS_BY_RULE: Readonly<Record<RepositoryRuleKey, readonly CheckKind[]>> =
  Object.freeze({
    "commits.semantic": Object.freeze(["commits", "merge_message"] as const),
    "changeRequest.semanticTitle": Object.freeze(["title"] as const),
    "changeRequest.description": Object.freeze(["description"] as const),
    "code.magicNumbers": Object.freeze(["command"] as const),
    "code.magicStrings": Object.freeze(["command"] as const),
  });

/**
 * Refuses a row that could not have come from `evaluateMetadataChecks`. The
 * recorder takes rows as data, so it cannot tell who built them: a pass is
 * accepted only when it is shaped the way an honest pass is, because a freshness
 * check can only compare what the row recorded.
 *
 * - the reason explains the result, and the kind belongs to the rule;
 * - a magic-value rule's row is only ever `unavailable`: nothing here judges it;
 * - a `passed` row records every part its kind is bound to, so a pass with no
 *   digest (which could never be fresh) cannot be written.
 */
function assertTrustworthyRow(row: MetadataCheckRow, index: number): void {
  if (!KINDS_BY_RULE[row.ruleKey].includes(row.kind)) {
    invalidRow(`kind ${row.kind} is not recorded for ${row.ruleKey}`, index);
  }
  // No checker of a magic-value rule runs here; its bound command is its
  // evidence. A pass or a failure under the rule's own name was not observed.
  if (row.kind === "command" && row.result !== "unavailable") {
    invalidRow(`a ${row.ruleKey} row here can only be unavailable`, index);
  }
  if (row.result === "passed") {
    const missing = unrecordedBoundParts(row.kind, row);
    if (missing.length > 0) {
      invalidRow(`a pass records no ${missing.join(", ")}`, index);
    }
  }
}

/**
 * Proves the run step the rows are attributed to is a step of this very run and
 * organization. `check_runs.run_step_id` has no foreign key, so without this a
 * caller could attribute evidence to any step.
 */
async function assertRunStep(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly runStepId: string;
  },
): Promise<void> {
  const step = await transaction.query<{ id: string }>(
    `select id from bakery.run_steps
      where organization_id = $1 and run_id = $2 and id = $3`,
    [input.organizationId, input.runId, input.runStepId],
  );
  if (step.rows.length !== 1) {
    invalidRow("the run step does not belong to this run");
  }
}

/**
 * Inserts evaluated metadata rows through the application role. The row's
 * organization is the insert's own `organization_id`, and the composite
 * foreign key to the run refuses a run that belongs to another organization,
 * so a caller cannot record evidence across tenants. Every row is validated
 * before the first insert, so a refused call writes nothing:
 *
 * - shape, and a reason that explains the result (`MetadataCheckRowSchema`);
 * - a kind that belongs to the rule, and a pass that records every bound part;
 * - at most one row per (kind, check id) in one call: the evaluator produces
 *   one row per check, and a second would only be a way to shadow the first;
 * - a `runStepId`, when given, is a step of this run and organization.
 *
 * Callers pass rows straight from `evaluateMetadataChecks`; none may be built
 * from request data. Returns the new row ids in input order.
 */
export async function recordMetadataCheckRuns(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly runStepId?: string | null;
    readonly rows: readonly MetadataCheckRow[];
  },
): Promise<string[]> {
  const rows = input.rows.map((candidate) =>
    MetadataCheckRowSchema.parse(candidate)
  );
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    assertTrustworthyRow(row, index);
    const key = `${row.kind}\u0000${row.checkId}`;
    if (seen.has(key)) {
      invalidRow(`${row.kind} ${row.checkId} appears twice in one call`, index);
    }
    seen.add(key);
  }
  if (input.runStepId !== undefined && input.runStepId !== null) {
    await assertRunStep(transaction, {
      organizationId: input.organizationId,
      runId: input.runId,
      runStepId: input.runStepId,
    });
  }
  const ids: string[] = [];
  for (const row of rows) {
    const id = crypto.randomUUID();
    await transaction.query(
      `insert into bakery.check_runs (
         id, organization_id, run_id, run_step_id, check_id, kind, rule_key,
         result, reason, head_sha, base_sha, profile_digest, policy_digest,
         subject_digest, checker_digest, title_digest, body_digest,
         merge_message_digest, commit_selection_digest
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19
       )`,
      [
        id,
        input.organizationId,
        input.runId,
        input.runStepId ?? null,
        row.checkId,
        row.kind,
        row.ruleKey,
        row.result,
        row.reason,
        row.headSha,
        row.baseSha,
        row.profileDigest,
        row.policyDigest,
        row.subjectDigest,
        row.checkerDigest,
        row.titleDigest,
        row.bodyDigest,
        row.mergeMessageDigest,
        row.commitSelectionDigest,
      ],
    );
    ids.push(id);
  }
  return ids;
}
