import { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";
import type { EffectiveRepositoryRuleEntry } from "../../../packages/contracts/src/repository-rules.ts";
import {
  type CheckPins,
  commandSubjects,
  deriveCheckPins,
} from "../../../apps/server/src/modules/delivery/check-pins.ts";
import {
  type CandidateIdentity,
  commandSubjectDigest,
  metadataDigests,
  ruleSubjectDigest,
  subjectKey,
} from "../../../apps/server/src/modules/delivery/identity.ts";
import {
  evaluateMetadataChecks,
  type MetadataCheckRow,
  metadataRequirements,
  metadataSubjects,
  recordMetadataCheckRuns,
} from "../../../apps/server/src/modules/delivery/metadata-checks.ts";
import {
  type CandidateMetadataReader,
  type CandidateMetadataSnapshot,
  loadMetadataSnapshot,
} from "../../../apps/server/src/modules/delivery/metadata-reader.ts";
import { evaluateDeliveryChecks } from "../../../apps/server/src/modules/delivery/service.ts";
import {
  type CandidateChecksVerdict,
  type CheckRequirement,
  mergeRequirements,
} from "../../../apps/server/src/modules/delivery/verdict.ts";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import { GOOD_METADATA } from "./e2e-candidate.ts";

/**
 * Re-judges the rows a real run recorded. The current identity of the
 * candidate is rebuilt from the job's own admission pins, exactly as a later
 * delivery decision would build it, then one part at a time is changed. The
 * only substitutes are the fixture metadata reader (no live GitHub reader
 * exists, G3) and the caller: the production caller of the command checks is
 * `evaluateReviewedChecks` (issue #94), which needs a recorded review, and the
 * merge gate `evaluateDeliveryCandidate` and the metadata checks have no
 * production caller until #97, so the delivery service is called directly here.
 */

export type Scenario = {
  readonly blocked: boolean;
  /** `kind:checkId` of each requirement whose newest row is stale. */
  readonly stale: readonly string[];
  /** Changed parts of each stale requirement, keyed by `kind:checkId`. */
  readonly changed: Readonly<Record<string, readonly string[]>>;
  /** Status of every requirement, keyed by `kind:checkId`. */
  readonly statuses: Readonly<Record<string, string>>;
  readonly verdict: CandidateChecksVerdict;
};

export type Rejudged = {
  readonly pins: CheckPins;
  readonly metadataRows: readonly MetadataCheckRow[];
  readonly metadataRowIds: readonly string[];
  readonly requirements: readonly CheckRequirement[];
  readonly scenarios: Readonly<Record<string, Scenario>>;
};

const FOREIGN_HEAD = "f".repeat(40);
const FOREIGN_BASE = "e".repeat(40);

function describe(verdict: CandidateChecksVerdict): Scenario {
  const stale: string[] = [];
  const changed: Record<string, readonly string[]> = {};
  const statuses: Record<string, string> = {};
  for (const evaluation of verdict.evaluations) {
    const key =
      `${evaluation.requirement.kind}:${evaluation.requirement.checkId}`;
    statuses[key] = evaluation.status;
    if (evaluation.status === "stale") {
      stale.push(key);
      changed[key] = evaluation.changed;
    }
  }
  return { blocked: verdict.blocked, stale, changed, statuses, verdict };
}

function withMetadata(
  change: Partial<CandidateMetadataSnapshot>,
): CandidateMetadataSnapshot {
  return {
    ...GOOD_METADATA,
    commitMessages: [...GOOD_METADATA.commitMessages],
    ...change,
  };
}

/**
 * Records the metadata rows a trusted fixture reader yields for the candidate,
 * then judges the run's rows against the current identity and against six
 * changed ones (title, body, merge message, head, base and a policy subject).
 */
export async function recordAndRejudge(input: {
  readonly appPg: PgDatabase;
  readonly organizationId: string;
  readonly runId: string;
  /** `bakery.jobs.input` of the run's quality.check job. */
  readonly jobInput: unknown;
}): Promise<Rejudged> {
  const { appPg, organizationId, runId } = input;
  const pins = await deriveCheckPins(input.jobInput);
  const context = RepositoryExecutionContextSchema.parse(
    (input.jobInput as Record<string, unknown>).repositoryProfile,
  );
  const entries: readonly EffectiveRepositoryRuleEntry[] =
    context.repositoryRules?.entries ?? [];

  const reader: CandidateMetadataReader = {
    read: () => Promise.resolve(withMetadata({})),
  };
  const snapshot = await loadMetadataSnapshot(reader, {
    organizationId,
    runId,
    headSha: pins.headSha,
    baseSha: pins.baseSha,
  });
  const metadataRows = await evaluateMetadataChecks({
    entries,
    snapshot,
    identity: {
      headSha: pins.headSha,
      baseSha: pins.baseSha,
      profileDigest: pins.profileDigest,
      checkerDigest: pins.checkerDigest,
    },
    policyDigest: pins.policyDigest,
  });
  const metadataRowIds = await withPgTransaction(
    appPg,
    (transaction) =>
      recordMetadataCheckRuns(transaction, {
        organizationId,
        runId,
        rows: metadataRows,
      }),
  );

  // The fixed policy and the bound magic-number rule both name `pass`; the
  // merge keeps one requirement for it, with the stricter mode.
  const requirements: CheckRequirement[] = mergeRequirements(
    pins.decisions.map(({ commandId, mode }): CheckRequirement => ({
      kind: "command",
      checkId: commandId,
      mode,
    })),
    metadataRequirements(entries),
  );
  const baseSubjects = {
    ...commandSubjects(pins),
    ...await metadataSubjects(entries),
  };
  const identity = async (
    snapshotNow: CandidateMetadataSnapshot | null,
    overrides: Partial<CandidateIdentity> = {},
  ): Promise<CandidateIdentity> => ({
    headSha: pins.headSha,
    baseSha: pins.baseSha,
    profileDigest: pins.profileDigest,
    checkerDigest: pins.checkerDigest,
    subjects: baseSubjects,
    ...await metadataDigests(snapshotNow),
    ...overrides,
  });
  const judge = async (current: CandidateIdentity): Promise<Scenario> =>
    describe(
      await withPgTransaction(
        appPg,
        (transaction) =>
          evaluateDeliveryChecks(transaction, {
            organizationId,
            runId,
            current,
            requirements,
          }),
      ),
    );

  const passRule = entries.find((entry) =>
    entry.ruleKey === "code.magicNumbers"
  )!;
  const titleRule = entries.find((entry) =>
    entry.ruleKey === "changeRequest.semanticTitle"
  )!;
  const passCommand = pins.commands.find(({ checkId }) => checkId === "pass")!;
  const scenarios: Record<string, Scenario> = {
    current: await judge(await identity(snapshot)),
    title: await judge(
      await identity(withMetadata({ title: "fix(checks): rename the change" })),
    ),
    body: await judge(
      await identity(
        withMetadata({
          body:
            "## Summary\nA different description.\n\n## Verification\nNot run.\n",
        }),
      ),
    ),
    mergeMessage: await judge(
      await identity(
        withMetadata({
          mergeMessage: "fix(checks): a different squash message",
        }),
      ),
    ),
    head: await judge(await identity(snapshot, { headSha: FOREIGN_HEAD })),
    base: await judge(await identity(snapshot, { baseSha: FOREIGN_BASE })),
    // The fixed command's argv changed: only the command that was edited moves.
    commandSubject: await judge(
      await identity(snapshot, {
        subjects: {
          ...baseSubjects,
          [subjectKey("command", "pass")]: await commandSubjectDigest(
            { id: "pass", argv: [...passCommand.argv, "--changed"] },
            passRule,
          ),
        },
      }),
    ),
    // A rule entry changed: only the check that enforces that entry moves.
    ruleSubject: await judge(
      await identity(snapshot, {
        subjects: {
          ...baseSubjects,
          [subjectKey("title", titleRule.ruleKey)]: await ruleSubjectDigest({
            ...titleRule,
            options: { ...titleRule.options, maxSubjectLength: 50 },
          } as EffectiveRepositoryRuleEntry),
        },
      }),
    ),
  };
  return { pins, metadataRows, metadataRowIds, requirements, scenarios };
}
