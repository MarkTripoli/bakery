import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type CandidateIdentity,
  metadataDigests,
} from "../../../apps/server/src/modules/delivery/identity.ts";
import {
  commandSubjects,
  deriveCheckPins,
} from "../../../apps/server/src/modules/delivery/check-pins.ts";
import {
  evaluateMetadataChecks,
  metadataRequirements,
  metadataSubjects,
  recordMetadataCheckRuns,
} from "../../../apps/server/src/modules/delivery/metadata-checks.ts";
import type { EffectiveRepositoryRuleEntry } from "../../../packages/contracts/src/repository-rules.ts";
import type { CandidateMetadataSnapshot } from "../../../apps/server/src/modules/delivery/metadata-reader.ts";
import { evaluateDeliveryChecks } from "../../../apps/server/src/modules/delivery/service.ts";
import type { CheckRequirement } from "../../../apps/server/src/modules/delivery/verdict.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { withCheckFixture } from "./finalizer-integration-cases.ts";
import {
  type CheckScenario,
  DEFAULT_COMMANDS,
  seedCheckScenario,
} from "./finalizer-fixture.ts";
import { fixedPolicyContext } from "./finalizer-policy.ts";
import {
  commitRangeEntry,
  descriptionEntry,
  goodSnapshot,
  titleRuleEntry,
} from "./identity-fixture.ts";

/**
 * Acceptance 1 and 2 of #83 at the service boundary, over rows the finalizer
 * wrote: the check rows come from a worker report that went through the real
 * result route, the metadata rows from the metadata evaluator, and every
 * verdict is read back from Postgres by `evaluateDeliveryChecks`. Each case
 * changes one part of the candidate and names exactly the checks that go stale.
 */

const COMMAND_IDS = DEFAULT_COMMANDS.map(({ id }) => id);
const COMMAND_REQUIREMENTS: CheckRequirement[] = DEFAULT_COMMANDS.map((
  { id, mode },
) => ({ kind: "command", checkId: id, mode }));

type Candidate = {
  scenario: CheckScenario;
  snapshot: CandidateMetadataSnapshot;
  requirements: CheckRequirement[];
  /** The candidate right now, with parts replaced by `change`. */
  identity(change?: {
    pins?: Awaited<ReturnType<typeof deriveCheckPins>>;
    snapshot?: CandidateMetadataSnapshot;
    entries?: readonly EffectiveRepositoryRuleEntry[];
    overrides?: Partial<CandidateIdentity>;
  }): Promise<CandidateIdentity>;
  /** Status of every requirement, keyed `kind:checkId`. */
  statuses(identity: CandidateIdentity): Promise<Record<string, string>>;
  blocked(identity: CandidateIdentity): Promise<boolean>;
};

/**
 * Admits a worker report for the three default commands and records the
 * metadata rows for the same run. Everything is recorded against the pins the
 * job carries, as the delivery will compare it to the pins it carries now.
 */
async function openCandidate(
  scenario: CheckScenario,
  options: {
    outcomes?: Parameters<CheckScenario["honest"]>[0];
    snapshot?: CandidateMetadataSnapshot | null;
  } = {},
): Promise<Candidate> {
  const { fixture, pins } = scenario;
  const { report } = await scenario.honest(options.outcomes);
  const response = await scenario.post(report);
  assertEquals(response.status, 200, await response.clone().text());
  const entries = scenario.context.repositoryRules!.entries;
  const snapshot = options.snapshot === undefined
    ? goodSnapshot()
    : options.snapshot;
  const rows = await evaluateMetadataChecks({
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
  await withPgTransaction(
    fixture.runtimePgDatabase,
    (transaction) =>
      recordMetadataCheckRuns(transaction, {
        organizationId: scenario.organizationId,
        runId: scenario.job.runId,
        rows,
      }),
  );
  const requirements = [
    ...COMMAND_REQUIREMENTS,
    ...metadataRequirements(entries),
  ];
  const identity: Candidate["identity"] = async (change = {}) => {
    const now = change.pins ?? pins;
    return {
      headSha: now.headSha,
      baseSha: now.baseSha,
      profileDigest: now.profileDigest,
      checkerDigest: now.checkerDigest,
      subjects: {
        ...commandSubjects(now),
        ...await metadataSubjects(change.entries ?? entries),
      },
      ...await metadataDigests(change.snapshot ?? snapshot),
      ...change.overrides,
    };
  };
  const evaluate = (current: CandidateIdentity) =>
    withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) =>
        evaluateDeliveryChecks(transaction, {
          organizationId: scenario.organizationId,
          runId: scenario.job.runId,
          current,
          requirements,
        }),
    );
  return {
    scenario,
    snapshot: snapshot ?? goodSnapshot(),
    requirements,
    identity,
    async statuses(current) {
      const verdict = await evaluate(current);
      return Object.fromEntries(
        verdict.evaluations.map((
          evaluation,
        ) => [
          `${evaluation.requirement.kind}:${evaluation.requirement.checkId}`,
          evaluation.status,
        ]),
      );
    },
    async blocked(current) {
      return (await evaluate(current)).blocked;
    },
  };
}

/**
 * Every requirement of the candidate with the same status, except guidance:
 * a `guide` command is never consulted, so it reads `not_blocking` whatever
 * happened to the candidate.
 */
function all(candidate: Candidate, status: string): Record<string, string> {
  return Object.fromEntries(
    candidate.requirements.map((
      { kind, checkId, mode },
    ) => [`${kind}:${checkId}`, mode === "guide" ? "not_blocking" : status]),
  );
}

/** Command requirements that are consulted (everything but guidance). */
const CONSULTED_COMMANDS = DEFAULT_COMMANDS.filter(({ mode }) =>
  mode !== "guide"
).map(({ id }) => id);

const RULES = [
  commitRangeEntry("all_commits"),
  titleRuleEntry(),
  descriptionEntry(),
];
const SQUASH_RULES = [
  commitRangeEntry("final_squash_commit"),
  titleRuleEntry(),
  descriptionEntry(),
];

export function registerFinalizerDeliveryCases(): void {
  Deno.test("rows the finalizer wrote keep a delivery open until head, base, profile, checker or a command changes, and then only the affected checks go stale", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture, { rules: RULES });
      const candidate = await openCandidate(scenario);
      const fresh = all(candidate, "passed");
      // The failed warn command is not part of this run: all three pass.
      assertEquals(await candidate.statuses(await candidate.identity()), fresh);
      assertFalse(await candidate.blocked(await candidate.identity()));

      // A changed head or base stales every check, commands and metadata alike.
      for (const part of ["headSha", "baseSha"] as const) {
        const changed = await candidate.identity({
          overrides: { [part]: "9".repeat(40) },
        });
        assertEquals(
          await candidate.statuses(changed),
          all(candidate, "stale"),
          part,
        );
        assert(await candidate.blocked(changed), part);
      }
      // A changed profile or checker reaches the command rows only.
      for (const part of ["profileDigest", "checkerDigest"] as const) {
        const statuses = await candidate.statuses(
          await candidate.identity({ overrides: { [part]: "8".repeat(64) } }),
        );
        for (const id of CONSULTED_COMMANDS) {
          assertEquals(statuses[`command:${id}`], "stale", `${part} ${id}`);
        }
        assertEquals(statuses["command:format"], "not_blocking", part);
        for (
          const key of [
            "commits:commits.semantic",
            "title:changeRequest.semanticTitle",
            "description:changeRequest.description",
          ]
        ) assertEquals(statuses[key], "passed", `${part} ${key}`);
      }
      // A changed fixed-policy command (its argv) stales that command only.
      const changedPolicy = await deriveCheckPins({
        repositoryId: scenario.context.repositoryId,
        revision: scenario.pins.headSha,
        checks: COMMAND_IDS,
        repositoryProfile: await fixedPolicyContext({
          organizationId: scenario.context.organizationId,
          applicationId: scenario.context.applicationId,
          repositoryId: scenario.context.repositoryId,
          id: scenario.context.id,
          revision: scenario.context.revision,
        }, {
          commands: DEFAULT_COMMANDS.map((command) =>
            command.id === "unit"
              ? { ...command, argv: ["pnpm", "test:unit", "--changed"] }
              : command
          ),
          rules: RULES,
        }),
      });
      const policyStatuses = await candidate.statuses(
        await candidate.identity({
          pins: {
            ...scenario.pins,
            commands: changedPolicy.commands,
          },
        }),
      );
      assertEquals(policyStatuses["command:unit"], "stale");
      assertEquals(policyStatuses["command:lint"], "passed");
      assertEquals(policyStatuses["command:format"], "not_blocking");
      assertEquals(
        policyStatuses["title:changeRequest.semanticTitle"],
        "passed",
      );

      // A changed title, body or commit selection reaches its own check only.
      const snapshot = candidate.snapshot;
      for (
        const [change, stale] of [
          [
            { title: "feat(delivery): another title" },
            "title:changeRequest.semanticTitle",
          ],
          [
            { body: `${snapshot.body}\nMore detail.` },
            "description:changeRequest.description",
          ],
          [
            { commitMessages: ["fix: another commit"] },
            "commits:commits.semantic",
          ],
        ] as const
      ) {
        const changed: CandidateMetadataSnapshot = {
          ...snapshot,
          ...change,
          commitMessages: "commitMessages" in change
            ? [...change.commitMessages]
            : snapshot.commitMessages,
        };
        const statuses = await candidate.statuses(
          await candidate.identity({ snapshot: changed }),
        );
        assertEquals(
          Object.entries(statuses).filter(([, status]) => status === "stale")
            .map(([key]) => key),
          [stale],
          JSON.stringify(change),
        );
      }
      // A changed merge message touches no check of this run: no rule here
      // judges the squash message, so nothing recorded depends on it.
      assertEquals(
        await candidate.statuses(
          await candidate.identity({
            snapshot: { ...snapshot, mergeMessage: "fix: squashed" },
          }),
        ),
        fresh,
      );
    });
  });

  Deno.test("a changed merge message stales the squash message check and nothing else", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture, {
        rules: SQUASH_RULES,
      });
      const candidate = await openCandidate(scenario);
      assertEquals(
        await candidate.statuses(await candidate.identity()),
        all(candidate, "passed"),
      );
      const statuses = await candidate.statuses(
        await candidate.identity({
          snapshot: { ...candidate.snapshot, mergeMessage: "fix: squashed" },
        }),
      );
      assertEquals(
        Object.entries(statuses).filter(([, status]) => status === "stale")
          .map(([key]) => key),
        ["merge_message:commits.semantic"],
      );
    });
  });

  Deno.test("an unrelated rule change or an organization revision bump over equal entries leaves every recorded check fresh", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture, { rules: RULES });
      const candidate = await openCandidate(scenario);
      // Same entries, later organization revision: the policy digest and every
      // subject stay equal, so nothing recorded depends on the revision.
      const bumped = await seedCheckScenario(fixture, {
        rules: RULES,
        rulesRevision: 7,
      });
      assertEquals(bumped.pins.policyDigest, scenario.pins.policyDigest);
      assertEquals(
        await candidate.statuses(
          await candidate.identity({
            pins: bumped.pins,
            entries: bumped.context.repositoryRules!.entries,
          }),
        ),
        all(candidate, "passed"),
      );
      // Another rule enabled: the effective policy differs, but no recorded
      // check enforces it, so only the policy record changes.
      const widened = await seedCheckScenario(fixture, {
        rules: [...RULES, {
          ruleKey: "code.magicStrings",
          enabled: true,
          mode: "warn",
          options: {
            checkBinding: null,
            allowedLiterals: [],
            excludedPaths: [],
          },
          locked: false,
        }],
      });
      assert(widened.pins.policyDigest !== scenario.pins.policyDigest);
      assertEquals(
        await candidate.statuses(
          await candidate.identity({
            pins: widened.pins,
            entries: widened.context.repositoryRules!.entries,
          }),
        ),
        all(candidate, "passed"),
      );
    });
  });

  Deno.test("a required unavailable command, a missing check and a placeholder-only description each block the delivery", async () => {
    await withCheckFixture(async (fixture) => {
      // Unavailable: the tool was missing, so the required command blocks.
      const unavailable = await openCandidate(
        await seedCheckScenario(fixture, { rules: RULES }),
        { outcomes: { unit: "tool_missing" } },
      );
      const now = await unavailable.identity();
      assert(await unavailable.blocked(now));
      assertEquals(
        (await unavailable.statuses(now))["command:unit"],
        "unavailable",
      );

      // Failed is told apart from unavailable and blocks too.
      const failed = await openCandidate(
        await seedCheckScenario(fixture, { rules: RULES }),
        { outcomes: { unit: "fail" } },
      );
      assertEquals(
        (await failed.statuses(await failed.identity()))["command:unit"],
        "failed",
      );
      assert(await failed.blocked(await failed.identity()));

      // Missing: a required check nothing ever recorded.
      const open = await openCandidate(
        await seedCheckScenario(fixture, { rules: RULES }),
      );
      const withDeploy: CheckRequirement[] = [
        ...open.requirements,
        { kind: "command", checkId: "deploy", mode: "require" },
      ];
      const current = await open.identity();
      const verdict = await withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) =>
          evaluateDeliveryChecks(transaction, {
            organizationId: open.scenario.organizationId,
            runId: open.scenario.job.runId,
            current,
            requirements: withDeploy,
          }),
      );
      assert(verdict.blocked);
      assertEquals(
        verdict.blockedChecks.map((
          { requirement, status },
        ) => [requirement.checkId, status]),
        [["deploy", "missing"]],
      );

      // Placeholder-only description: an empty body and the untouched
      // template both fail the description check, whatever sections it lists.
      for (
        const body of ["", "   \n", "## Summary\n\n## Verification\n"]
      ) {
        const placeholder = await openCandidate(
          await seedCheckScenario(fixture, {
            rules: [
              titleRuleEntry(),
              descriptionEntry({ requiredSections: [] }),
            ],
          }),
          { snapshot: goodSnapshot({ body }) },
        );
        const current = await placeholder.identity();
        const statuses = await placeholder.statuses(current);
        assertEquals(
          statuses["description:changeRequest.description"],
          "failed",
          JSON.stringify(body),
        );
        assert(await placeholder.blocked(current));
        assertEquals(statuses["title:changeRequest.semanticTitle"], "passed");
      }

      // No metadata source at all: the metadata rules are recorded as
      // unavailable (metadata_missing) with no digests. The verdict reports
      // that true state rather than a changed candidate, none of them counts
      // as a pass, and the delivery stays blocked. The commands the finalizer
      // recorded stay fresh.
      const unread = await openCandidate(
        await seedCheckScenario(fixture, { rules: RULES }),
        { snapshot: null },
      );
      const unreadNow = await unread.identity({ snapshot: goodSnapshot() });
      assert(await unread.blocked(unreadNow));
      const unreadStatuses = await unread.statuses(unreadNow);
      for (
        const key of [
          "commits:commits.semantic",
          "title:changeRequest.semanticTitle",
          "description:changeRequest.description",
        ]
      ) assertEquals(unreadStatuses[key], "unavailable", key);
      assertEquals(unreadStatuses["command:unit"], "passed");
    });
  });
}
