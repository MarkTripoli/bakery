import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import type { CandidateIdentity } from "../../../apps/server/src/modules/delivery/identity.ts";
import {
  commandSubjectDigest,
  metadataDigests,
  subjectKey,
} from "../../../apps/server/src/modules/delivery/identity.ts";
import {
  evaluateMetadataChecks,
  metadataRequirements,
  metadataSubjects,
  recordMetadataCheckRuns,
} from "../../../apps/server/src/modules/delivery/metadata-checks.ts";
import type { CandidateMetadataSnapshot } from "../../../apps/server/src/modules/delivery/metadata-reader.ts";
import { evaluateDeliveryChecks } from "../../../apps/server/src/modules/delivery/service.ts";
import type { CheckRequirement } from "../../../apps/server/src/modules/delivery/verdict.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../../apps/server/src/platform/postgres-errors.ts";
import { type ChecksFixture, openChecksFixture } from "./checks-fixture.ts";
import {
  commitRangeEntry,
  currentIdentity,
  descriptionEntry,
  digest,
  effectiveEntries,
  goodSnapshot,
  magicRuleEntry,
  SUBJECT_UNIT,
  titleRuleEntry,
} from "./identity-fixture.ts";
import { BASE_SHA, HEAD_SHA } from "./observations.ts";
import { insertCheckRun, seedRun } from "./run-fixture.ts";

/**
 * Service-boundary cases for the delivery verdict: the metadata rows and the
 * verdict are written and read through the application role against real
 * Postgres rows. They prove acceptance 1 (a changed head, base, title, body,
 * message or policy goes stale with the same head) and acceptance 2 (an
 * unavailable, skipped or placeholder-only check blocks) where the SQL runs,
 * not only on in-memory rows.
 */

const PG_FOREIGN_KEY_VIOLATION = "23503";
const POLICY = digest(0xabc);
const IDENTITY = {
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  profileDigest: digest(1),
  checkerDigest: digest(2),
};
const UNIT: CheckRequirement = {
  kind: "command",
  checkId: "unit",
  mode: "require",
};

type Candidate = {
  checks: ChecksFixture;
  organizationId: string;
  runId: string;
};

/** Records the evaluated metadata rows of `snapshot` through the app role. */
async function recordSnapshot(
  candidate: Candidate,
  rules: Array<Record<string, unknown>>,
  snapshot: CandidateMetadataSnapshot | null,
) {
  const entries = await effectiveEntries(rules);
  const rows = await evaluateMetadataChecks({
    entries,
    snapshot,
    identity: IDENTITY,
    policyDigest: POLICY,
  });
  const ids = await withPgTransaction(
    candidate.checks.fixture.appPg,
    (transaction) =>
      recordMetadataCheckRuns(transaction, {
        organizationId: candidate.organizationId,
        runId: candidate.runId,
        rows,
      }),
  );
  return { entries, rows, ids, requirements: metadataRequirements(entries) };
}

/** The candidate right now for these entries and this snapshot. */
async function identityNow(
  entries: Awaited<ReturnType<typeof effectiveEntries>>,
  snapshot: CandidateMetadataSnapshot | null,
  overrides: Partial<CandidateIdentity> = {},
): Promise<CandidateIdentity> {
  return currentIdentity({
    ...(await metadataDigests(snapshot)),
    subjects: {
      ...(await metadataSubjects(entries)),
      [SUBJECT_UNIT]: digest(3),
    },
    ...overrides,
  });
}

/** A recorded, passed `unit` command row bound to the default identity. */
function insertUnit(
  candidate: Candidate,
  overrides: Partial<Parameters<typeof insertCheckRun>[1]> = {},
) {
  return insertCheckRun(candidate.checks.owner, {
    organizationId: candidate.organizationId,
    runId: candidate.runId,
    checkId: "unit",
    kind: "command",
    profileDigest: digest(1),
    checkerDigest: digest(2),
    subjectDigest: digest(3),
    policyDigest: POLICY,
    ...overrides,
  });
}

async function evaluateNow(
  candidate: Candidate,
  current: CandidateIdentity,
  requirements: readonly CheckRequirement[],
  scope: { organizationId?: string; runId?: string } = {},
) {
  return await withPgTransaction(
    candidate.checks.fixture.appPg,
    (transaction) =>
      evaluateDeliveryChecks(transaction, {
        organizationId: scope.organizationId ?? candidate.organizationId,
        runId: scope.runId ?? candidate.runId,
        current,
        requirements,
      }),
  );
}

async function withCandidate(
  work: (candidate: Candidate) => Promise<void>,
): Promise<void> {
  const checks = await openChecksFixture();
  try {
    const organizationId = checks.fixture.organizationId;
    const run = await seedRun(checks.owner, checks.scope(organizationId));
    await work({ checks, organizationId, runId: run.runId });
  } finally {
    await checks.close();
  }
}

const statusesOf = (
  verdict: Awaited<ReturnType<typeof evaluateNow>>,
) =>
  Object.fromEntries(
    verdict.evaluations.map((
      { requirement, status },
    ) => [requirement.checkId, status]),
  );

export function registerServiceCases(): void {
  Deno.test("recorded metadata rows and a command row keep the delivery open until head, base, title, body or message changes", async () => {
    await withCandidate(async (candidate) => {
      const snapshot = goodSnapshot();
      const recorded = await recordSnapshot(
        candidate,
        [commitRangeEntry("all_commits"), titleRuleEntry(), descriptionEntry()],
        snapshot,
      );
      assertEquals(recorded.ids.length, 3);
      await insertUnit(candidate);
      const requirements = [UNIT, ...recorded.requirements];
      const now = (overrides: Partial<CandidateIdentity> = {}) =>
        identityNow(recorded.entries, snapshot, overrides);

      const fresh = await evaluateNow(candidate, await now(), requirements);
      assertFalse(fresh.blocked);
      assertEquals(statusesOf(fresh), {
        unit: "passed",
        "commits.semantic": "passed",
        "changeRequest.semanticTitle": "passed",
        "changeRequest.description": "passed",
      });

      // Same head, new title: only the title check goes stale.
      const retitled = goodSnapshot({ title: "feat: a different title" });
      const title = await evaluateNow(
        candidate,
        await identityNow(recorded.entries, retitled),
        requirements,
      );
      assert(title.blocked);
      assertEquals(statusesOf(title), {
        unit: "passed",
        "commits.semantic": "passed",
        "changeRequest.semanticTitle": "stale",
        "changeRequest.description": "passed",
      });
      assertEquals(
        title.blockedChecks.map(({ requirement }) => requirement.checkId),
        ["changeRequest.semanticTitle"],
      );
      assertEquals(
        title.evaluations[2].changed,
        ["title"],
      );

      // Same head, new body: only the description check goes stale.
      const body = await evaluateNow(
        candidate,
        await identityNow(
          recorded.entries,
          goodSnapshot({ body: `${snapshot.body}\nAnd more.` }),
        ),
        requirements,
      );
      assertEquals(statusesOf(body), {
        unit: "passed",
        "commits.semantic": "passed",
        "changeRequest.semanticTitle": "passed",
        "changeRequest.description": "stale",
      });

      // New commit messages stale the commits check alone.
      const messages = await evaluateNow(
        candidate,
        await identityNow(
          recorded.entries,
          goodSnapshot({ commitMessages: ["feat: squashed"] }),
        ),
        requirements,
      );
      assertEquals(statusesOf(messages)["commits.semantic"], "stale");
      assertEquals(statusesOf(messages).unit, "passed");

      // A new head or base stales every check, the text checks included.
      for (
        const moved of [{ headSha: "7".repeat(40) }, {
          baseSha: "6".repeat(40),
        }]
      ) {
        const verdict = await evaluateNow(
          candidate,
          await now(moved),
          requirements,
        );
        assertEquals(statusesOf(verdict), {
          unit: "stale",
          "commits.semantic": "stale",
          "changeRequest.semanticTitle": "stale",
          "changeRequest.description": "stale",
        });
      }

      // A changed profile, checker or fixed command stales the command alone.
      for (
        const changed of [
          { profileDigest: digest(50) },
          { checkerDigest: digest(51) },
          {
            subjects: { ...(await now()).subjects, [SUBJECT_UNIT]: digest(52) },
          },
        ]
      ) {
        const verdict = await evaluateNow(
          candidate,
          await now(changed),
          requirements,
        );
        assertEquals(statusesOf(verdict), {
          unit: "stale",
          "commits.semantic": "passed",
          "changeRequest.semanticTitle": "passed",
          "changeRequest.description": "passed",
        });
      }

      // Re-evaluating the new title and recording it makes the check fresh again.
      const second = await recordSnapshot(
        candidate,
        [commitRangeEntry("all_commits"), titleRuleEntry(), descriptionEntry()],
        retitled,
      );
      assertEquals(second.ids.length, 3);
      const renewed = await evaluateNow(
        candidate,
        await identityNow(recorded.entries, retitled),
        requirements,
      );
      assertEquals(
        statusesOf(renewed)["changeRequest.semanticTitle"],
        "passed",
      );
    });
  });

  Deno.test("an unavailable, missing, skipped or placeholder-only required check blocks at the service boundary", async () => {
    await withCandidate(async (candidate) => {
      const rules = [
        commitRangeEntry("all_commits"),
        titleRuleEntry(),
        descriptionEntry({ requiredSections: [] }),
        magicRuleEntry("code.magicNumbers", null),
      ];
      // An oversize title is unavailable; an empty body is a placeholder; the
      // unbound magic rule is unavailable; merge-only commits are skipped.
      const snapshot = goodSnapshot({
        title: `feat: ${"t".repeat(400)}`,
        body: "<!-- nothing -->",
        commitMessages: ["Merge branch 'main'"],
      });
      const recorded = await recordSnapshot(candidate, rules, snapshot);
      const verdict = await evaluateNow(
        candidate,
        await identityNow(recorded.entries, snapshot),
        recorded.requirements,
      );
      assert(verdict.blocked);
      assertEquals(
        verdict.evaluations.map((
          { requirement, status, reason },
        ) => [requirement.checkId, status, reason]),
        [
          ["commits.semantic", "unavailable", "skipped"],
          ["changeRequest.semanticTitle", "unavailable", "metadata_too_large"],
          ["changeRequest.description", "failed", "description_placeholder"],
          ["code.magicNumbers", "unavailable", "rule_unbound"],
        ],
      );
      assertEquals(verdict.blockedChecks.length, 4);

      // No requirement at all is a missing policy, not a delivery with nothing
      // to check, even though recorded rows exist for the run.
      const noPolicy = await evaluateNow(
        candidate,
        await identityNow(recorded.entries, snapshot),
        [],
      );
      assert(noPolicy.blocked);
      assertEquals(noPolicy.reason, "policy_missing");
      assertEquals(noPolicy.evaluations, []);

      // A command with no row at all is missing, and blocks.
      const missing = await evaluateNow(
        candidate,
        await identityNow(recorded.entries, snapshot),
        [UNIT],
      );
      assert(missing.blocked);
      assertEquals(missing.evaluations[0].status, "missing");
      assertEquals(missing.evaluations[0].reason, "no_row");

      // A command that could not run is unavailable and blocks apart from failed.
      await insertUnit(candidate, {
        result: "unavailable",
        reason: "tool_missing",
      });
      const unavailable = await evaluateNow(
        candidate,
        await identityNow(recorded.entries, snapshot),
        [UNIT],
      );
      assert(unavailable.blocked);
      assertEquals(unavailable.evaluations[0].status, "unavailable");
      assertEquals(unavailable.evaluations[0].reason, "tool_missing");
    });
  });

  Deno.test("an unreadable metadata source records every rule as missing evidence that blocks", async () => {
    await withCandidate(async (candidate) => {
      const recorded = await recordSnapshot(
        candidate,
        [titleRuleEntry(), descriptionEntry()],
        null,
      );
      const rows = await candidate.checks.owner.query<
        { result: string; reason: string; title_digest: string | null }
      >(
        `select result, reason, title_digest from bakery.check_runs
          where run_id = $1 order by check_id`,
        [candidate.runId],
      );
      assertEquals(
        rows.rows.map(({ result, reason }) => [result, reason]),
        [
          ["unavailable", "metadata_missing"],
          ["unavailable", "metadata_missing"],
        ],
      );
      assertEquals(rows.rows.map(({ title_digest }) => title_digest), [
        null,
        null,
      ]);
      // Whatever the current identity holds, a pass was never recorded, and the
      // verdict says what was recorded: the metadata was unavailable. It does
      // not read as a candidate that changed.
      const known = goodSnapshot();
      for (const current of [null, known]) {
        const verdict = await evaluateNow(
          candidate,
          await identityNow(recorded.entries, current),
          recorded.requirements,
        );
        assert(verdict.blocked);
        assertEquals(
          verdict.evaluations.map((
            { requirement, status, reason, changed },
          ) => [
            requirement.checkId,
            status,
            reason,
            changed,
          ]),
          [
            [
              "changeRequest.semanticTitle",
              "unavailable",
              "metadata_missing",
              [],
            ],
            [
              "changeRequest.description",
              "unavailable",
              "metadata_missing",
              [],
            ],
          ],
        );
        assertEquals(verdict.blockedChecks.length, 2);
      }
    });
  });

  Deno.test("a failed or unavailable row stays failed or unavailable after the candidate moves, and a pass goes stale", async () => {
    await withCandidate(async (candidate) => {
      const base = await identityNow([], null);
      await insertUnit(candidate, {
        checkId: "lint",
        result: "failed",
        reason: "exit_nonzero",
        subjectDigest: digest(30),
      });
      await insertUnit(candidate, {
        checkId: "types",
        result: "unavailable",
        reason: "tool_missing",
        subjectDigest: digest(31),
      });
      await insertUnit(candidate);
      const requirements: CheckRequirement[] = [
        UNIT,
        { kind: "command", checkId: "lint", mode: "require" },
        { kind: "command", checkId: "types", mode: "require" },
      ];
      const statuses = async (current: CandidateIdentity) =>
        Object.fromEntries(
          (await evaluateNow(candidate, current, requirements)).evaluations
            .map((
              { requirement, status, reason },
            ) => [requirement.checkId, `${status}/${reason}`]),
        );
      const subjects = {
        ...base.subjects,
        "command:lint": digest(30),
        "command:types": digest(31),
      };
      assertEquals(await statuses({ ...base, subjects }), {
        unit: "passed/verified",
        lint: "failed/exit_nonzero",
        types: "unavailable/tool_missing",
      });
      // A moved head, profile and subject change none of the recorded failures.
      assertEquals(
        await statuses({
          ...base,
          subjects: { ...subjects, "command:lint": digest(60) },
          headSha: "5".repeat(40),
          profileDigest: digest(61),
        }),
        {
          unit: "stale/stale",
          lint: "failed/exit_nonzero",
          types: "unavailable/tool_missing",
        },
      );
    });
  });

  Deno.test("a required magic rule bound to a command blocks as missing, passes on the command's fresh row and a warn rule never blocks", async () => {
    await withCandidate(async (candidate) => {
      const command = { id: "magic", argv: ["deno", "lint", "--rules"] };
      const key = subjectKey("command", command.id);
      const bound = async (mode: string) =>
        await effectiveEntries([
          magicRuleEntry("code.magicNumbers", command.id, mode),
        ]);
      const required = await bound("require");
      const subject = await commandSubjectDigest(command, required[0]);
      const requirements = metadataRequirements(required);
      assertEquals(requirements, [
        { kind: "command", checkId: command.id, mode: "require" },
      ]);
      const now = async (entries = required) =>
        currentIdentity({
          subjects: {
            [key]: await commandSubjectDigest(command, entries[0]),
          },
        });

      // No row of the bound command: missing, and a required rule blocks.
      const missing = await evaluateNow(candidate, await now(), requirements);
      assert(missing.blocked);
      assertEquals(
        missing.evaluations.map(({ status, reason }) => [status, reason]),
        [["missing", "no_row"]],
      );

      // A fresh passing row of the command satisfies the rule.
      await insertUnit(candidate, {
        checkId: command.id,
        subjectDigest: subject,
      });
      const passing = await evaluateNow(candidate, await now(), requirements);
      assertFalse(passing.blocked);
      assertEquals(passing.evaluations[0].status, "passed");

      // Editing the rule changes the command's subject and stales the row.
      const edited = await effectiveEntries([{
        ...magicRuleEntry("code.magicNumbers", command.id, "require"),
        options: {
          checkBinding: command.id,
          allowedNumbers: [0, 1, 2],
          excludedPaths: [],
        },
      }]);
      const stale = await evaluateNow(
        candidate,
        await now(edited),
        requirements,
      );
      assert(stale.blocked);
      assertEquals(stale.evaluations[0].status, "stale");

      // A newer failure of the command blocks as failed.
      await insertUnit(candidate, {
        checkId: command.id,
        subjectDigest: subject,
        result: "failed",
        reason: "exit_nonzero",
        createdAt: new Date("2030-01-01T00:00:00.000Z"),
      });
      const failing = await evaluateNow(candidate, await now(), requirements);
      assert(failing.blocked);
      assertEquals(failing.evaluations[0].status, "failed");

      // A warn rule over the same failing row is reported and never blocks.
      const warn = await evaluateNow(
        candidate,
        await now(),
        metadataRequirements(await bound("warn")),
      );
      assertFalse(warn.blocked);
      assertEquals(warn.evaluations[0].status, "failed");
      assertFalse(warn.evaluations[0].blocking);
    });
  });

  Deno.test("the newest recorded row wins in SQL and a tie never hides a failure", async () => {
    await withCandidate(async (candidate) => {
      const at = (second: number) =>
        new Date(`2026-10-31T12:00:0${second}.000Z`);
      const current = await identityNow([], null);
      // Older pass, newer failure: the failure decides.
      await insertUnit(candidate, { createdAt: at(1) });
      const failedId = await insertUnit(candidate, {
        createdAt: at(2),
        result: "failed",
        reason: "exit_nonzero",
      });
      const failing = await evaluateNow(candidate, current, [UNIT]);
      assert(failing.blocked);
      assertEquals(failing.evaluations[0].rowId, failedId);
      // A newer pass supersedes the older failure.
      const recoveredId = await insertUnit(candidate, { createdAt: at(3) });
      const recovered = await evaluateNow(candidate, current, [UNIT]);
      assertFalse(recovered.blocked);
      assertEquals(recovered.evaluations[0].rowId, recoveredId);
      // A pass and a failure recorded at the same instant: the failure wins.
      // The pass has the larger id, so only the ordering rule can pick the failure.
      const tiedFailure = await insertUnit(candidate, {
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: at(4),
        result: "failed",
        reason: "signal",
      });
      await insertUnit(candidate, {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        createdAt: at(4),
      });
      const tied = await evaluateNow(candidate, current, [UNIT]);
      assert(tied.blocked);
      assertEquals(tied.evaluations[0].rowId, tiedFailure);
      assertEquals(tied.evaluations[0].reason, "signal");
    });
  });

  Deno.test("a re-run attempt supersedes an earlier one without breaking the per-fence uniqueness", async () => {
    await withCandidate(async (candidate) => {
      const job = {
        jobId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
      };
      await insertUnit(candidate, {
        ...job,
        fence: "1",
        result: "failed",
        reason: "exit_nonzero",
        createdAt: new Date("2026-10-31T12:00:01.000Z"),
      });
      const rerun = await insertUnit(candidate, {
        ...job,
        attemptId: crypto.randomUUID(),
        fence: "2",
        createdAt: new Date("2026-10-31T12:00:02.000Z"),
      });
      const duplicate = await assertRejects(() =>
        insertUnit(candidate, { ...job, fence: "2" })
      );
      assertEquals(postgresErrorCode(duplicate), POSTGRES_UNIQUE_VIOLATION);
      const verdict = await evaluateNow(
        candidate,
        await identityNow([], null),
        [UNIT],
      );
      assertFalse(verdict.blocked);
      assertEquals(verdict.evaluations[0].rowId, rerun);
    });
  });

  Deno.test("recording validates the rows before any insert, so a refused call leaves the run untouched", async () => {
    const checks = await openChecksFixture();
    try {
      const orgA = checks.fixture.organizationId;
      const orgB = checks.otherOrganizationId;
      const runA = await seedRun(checks.owner, checks.scope(orgA));
      const sibling = await seedRun(checks.owner, checks.scope(orgA));
      const runB = await seedRun(checks.owner, checks.scope(orgB));
      const candidate: Candidate = {
        checks,
        organizationId: orgA,
        runId: runA.runId,
      };
      const entries = await effectiveEntries([
        titleRuleEntry(),
        descriptionEntry(),
      ]);
      const good = await evaluateMetadataChecks({
        entries,
        snapshot: goodSnapshot(),
        identity: IDENTITY,
        policyDigest: POLICY,
      });
      const count = async () =>
        Number(
          (await checks.owner.query<{ count: string }>(
            "select count(*) from bakery.check_runs where run_id = any($1::uuid[])",
            [[runA.runId, sibling.runId, runB.runId]],
          )).rows[0].count,
        );
      const record = (
        rows: typeof good,
        runStepId?: string | null,
        scope: { organizationId?: string; runId?: string } = {},
      ) =>
        withPgTransaction(
          checks.fixture.appPg,
          (transaction) =>
            recordMetadataCheckRuns(transaction, {
              organizationId: scope.organizationId ?? candidate.organizationId,
              runId: scope.runId ?? candidate.runId,
              runStepId,
              rows,
            }),
        );
      const refused = async (
        name: string,
        work: () => Promise<unknown>,
      ) => {
        const before = await count();
        const error = await assertRejects(work, StandardError, undefined, name);
        assertEquals(error.params?.reason, "check_row_invalid", name);
        assertEquals(await count(), before, `${name} wrote a row`);
      };

      // A step of a sibling run, of another organization's run, or one that
      // does not exist is refused; so is the right step under the wrong run.
      await refused("a sibling run's step", () => record(good, sibling.stepId));
      await refused(
        "another organization's step",
        () => record(good, runB.stepId),
      );
      await refused("an unknown step", () => record(good, crypto.randomUUID()));
      await refused(
        "the run's step under another organization",
        () =>
          record(good, runA.stepId, {
            organizationId: orgB,
            runId: runA.runId,
          }),
      );
      // The run's own step is recorded, with the step on the row.
      const ids = await record(good, runA.stepId);
      assertEquals(ids.length, 2);
      const stored = await checks.owner.query<{ run_step_id: string | null }>(
        "select run_step_id from bakery.check_runs where id = any($1::uuid[])",
        [ids],
      );
      assertEquals(stored.rows.map(({ run_step_id }) => run_step_id), [
        runA.stepId,
        runA.stepId,
      ]);

      // Rows for the same check twice, a pass with no digest and a pass under
      // a kind the rule does not have never reach the table, even when the
      // first row in the call is good.
      const [title, description] = good;
      await refused(
        "a duplicate check",
        () => record([title, description, title]),
      );
      await refused(
        "a pass with no title digest",
        () => record([description, { ...title, titleDigest: null }]),
      );
      await refused(
        "a pass with no base",
        () => record([{ ...description, baseSha: null }]),
      );
      // Every digest a title row binds is in place; only the kind is wrong.
      await refused(
        "a description rule under the title kind",
        () =>
          record([
            title,
            {
              ...description,
              kind: "title",
              titleDigest: description.bodyDigest,
            },
          ]),
      );
    } finally {
      await checks.close();
    }
  });

  Deno.test("delivery verdicts and metadata rows never cross an organization or a run", async () => {
    const checks = await openChecksFixture();
    try {
      const orgA = checks.fixture.organizationId;
      const orgB = checks.otherOrganizationId;
      const runA = await seedRun(checks.owner, checks.scope(orgA));
      const runA2 = await seedRun(checks.owner, checks.scope(orgA));
      const runB = await seedRun(checks.owner, checks.scope(orgB));
      const candidateA: Candidate = {
        checks,
        organizationId: orgA,
        runId: runA.runId,
      };
      const candidateB: Candidate = {
        checks,
        organizationId: orgB,
        runId: runB.runId,
      };
      const rules = [titleRuleEntry(), descriptionEntry()];
      const snapshot = goodSnapshot();
      const recorded = await recordSnapshot(candidateA, rules, snapshot);
      await insertUnit(candidateA);
      const requirements = [UNIT, ...recorded.requirements];
      const current = await identityNow(recorded.entries, snapshot);

      assertFalse(
        (await evaluateNow(candidateA, current, requirements)).blocked,
      );
      // Organization B asking about organization A's run sees nothing.
      const foreign = await evaluateNow(candidateA, current, requirements, {
        organizationId: orgB,
      });
      assert(foreign.blocked);
      assert(foreign.evaluations.every(({ status }) => status === "missing"));
      // Another run of the same organization sees nothing either.
      const sibling = await evaluateNow(candidateA, current, requirements, {
        runId: runA2.runId,
      });
      assert(sibling.blocked);
      assert(sibling.evaluations.every(({ status }) => status === "missing"));
      // Organization B's own run has nothing recorded.
      const own = await evaluateNow(candidateB, current, requirements);
      assert(own.blocked);

      // B's passing rows do not satisfy A, and A's failures do not block B.
      await recordSnapshot(candidateB, rules, snapshot);
      await insertUnit(candidateB);
      assertFalse(
        (await evaluateNow(candidateB, current, requirements)).blocked,
      );
      await insertUnit(candidateA, {
        createdAt: new Date("2030-01-01T00:00:00.000Z"),
        result: "failed",
        reason: "exit_nonzero",
      });
      assert((await evaluateNow(candidateA, current, requirements)).blocked);
      assertFalse(
        (await evaluateNow(candidateB, current, requirements)).blocked,
      );

      // Recording evidence for a run of another organization is refused, and
      // nothing is written under either organization.
      const before = await checks.owner.query<{ count: string }>(
        "select count(*) from bakery.check_runs where run_id = $1",
        [runA.runId],
      );
      const rows = await evaluateMetadataChecks({
        entries: recorded.entries,
        snapshot,
        identity: IDENTITY,
        policyDigest: POLICY,
      });
      const refusal = await assertRejects(() =>
        withPgTransaction(
          checks.fixture.appPg,
          (transaction) =>
            recordMetadataCheckRuns(transaction, {
              organizationId: orgB,
              runId: runA.runId,
              rows,
            }),
        )
      );
      assertEquals(postgresErrorCode(refusal), PG_FOREIGN_KEY_VIOLATION);
      const after = await checks.owner.query<{ count: string }>(
        "select count(*) from bakery.check_runs where run_id = $1",
        [runA.runId],
      );
      assertEquals(after.rows[0].count, before.rows[0].count);
    } finally {
      await checks.close();
    }
  });
}
