import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  allRuleEntries,
  commitsEntry,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";
import {
  admitPresetRun,
  apiCall,
  createCodingAgent,
  createPresetTask,
  expectJson,
  presetBilling,
  presetBudgetEnv,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  addProfileRevision,
  asOverride,
  countRows,
  EMPTY_BASELINE_DIGEST,
  expectedPin,
  implementOnlyDefinition,
  insertRuleVersionRow,
  numbersRule,
  organizationEntries,
  pinnedRulesOf,
  provenanceOf,
  publishOrganizationRules,
  publishWorkflow,
  readSnapshot,
  type RuleEntry,
  seedRulesRepository,
  startRun,
  unboundNumbersRule,
} from "../helpers/pinned-rules.ts";
import { openRepositoryRulesFixture } from "../helpers/repository-rules-fixture.ts";
import {
  ORGANIZATION_RULES_MAX_BYTES,
  organizationRulesBytes,
} from "../../packages/contracts/src/repository-rules.ts";
import { repositoryRuleVersionDigest } from "../../apps/server/src/modules/repository-rules/postgres.ts";
import { pinEffectiveRepositoryRules } from "../../apps/server/src/modules/repository-rules/pinned.ts";
import { lockOrganization } from "../../apps/server/src/modules/auth/adapters/access-postgres.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";

const withFixture = <T>(
  work: Parameters<typeof withWorkerFixture<T>>[0],
) => withWorkerFixture(work, { env: presetBudgetEnv });

type Assignment = {
  jobId: string;
  input: { repositoryProfile: { repositoryRules?: unknown } };
};

async function claimImplementJob(
  fixture: Parameters<typeof claimAssignment>[0],
  label: string,
): Promise<Assignment> {
  const worker = await registeredWorker(fixture, {
    name: `pin-${label}-${crypto.randomUUID().slice(0, 8)}`,
    capabilities: workerFixtureCapabilities,
  });
  return await claimAssignment(fixture, worker, {
    supportedActions: ["harness.implement"],
  }) as unknown as Assignment;
}

const lockedTitle = { ...titleEntry(), locked: true, mode: "require" };

Deno.test("AC5: no rule versions and no overrides pin the empty baseline and behave as before", () =>
  withFixture(async (fixture) => {
    const repository = await seedRulesRepository(fixture, fixture, "empty");
    const { run } = await startRun(fixture, fixture, repository);
    assertEquals(run.status, "queued");
    const pin = await pinnedRulesOf(
      fixture.pgDatabase,
      fixture.organizationId,
      run.id,
    );
    assertEquals(pin, {
      organizationRevision: 0,
      profileId: repository.profileId,
      profileRevision: 1,
      entries: [],
      digest: EMPTY_BASELINE_DIGEST,
    });
    // The repository-scoped effective read reports the same baseline digest.
    const effective = await expectJson<{ digest: string; entries: unknown[] }>(
      await apiCall(
        fixture,
        fixture,
        "GET",
        `/v1/repositories/${repository.repositoryId}/rules`,
      ),
      200,
    );
    assertEquals(effective.digest, pin.digest);
    // The job of that run admits, claims and carries the same empty pin.
    await admitPresetRun(fixture.pgDatabase, fixture, run);
    const assignment = await claimImplementJob(fixture, "empty");
    assertEquals(assignment.input.repositoryProfile.repositoryRules, pin);
  }));

Deno.test("AC1, AC2 and AC4: runs keep their pinned rules while later runs follow new publications", async (test) => {
  await withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const orgRev1 = [commitsEntry(true), titleEntry()];
    const overrides1 = [asOverride({ ...titleEntry(90), mode: "require" })];
    const repository1 = await seedRulesRepository(fixture, fixture, "follow", {
      entries: overrides1,
    });
    await publishOrganizationRules(fixture, fixture, 0, orgRev1);

    const first = await startRun(fixture, fixture, repository1);
    const firstSnapshot = await readSnapshot(db, org, first.run.id);
    const firstPin = firstSnapshot.profile.repositoryRules!;
    const expectedFirst = await expectedPin(
      { revision: 1, entries: orgRev1 },
      overrides1,
      { id: repository1.profileId, revision: 1 },
    );

    await test.step("admission pins the organization revision, profile and provenance", () => {
      assertEquals(firstPin, expectedFirst);
      assertEquals(firstPin.organizationRevision, 1);
      assertEquals(provenanceOf(firstPin), {
        "commits.semantic": "locked_by_organization",
        "changeRequest.semanticTitle": "repository_override",
      });
    });

    // Newer organization revision (locks the title the run overrode) and a
    // newer active profile revision, both published after admission.
    const orgRev2 = [
      { ...commitsEntry(true), mode: "warn" },
      lockedTitle,
      unboundNumbersRule({ locked: true }),
    ];
    await publishOrganizationRules(fixture, fixture, 1, orgRev2);
    const repository2 = await addProfileRevision(db, fixture, repository1, 2, {
      entries: [asOverride(numbersRule({ mode: "warn" }))],
    });

    await test.step("AC1: the admitted run's snapshot never changes", async () => {
      const again = await readSnapshot(db, org, first.run.id);
      assertEquals(again.text, firstSnapshot.text);
    });

    await test.step("AC1 and AC4: every later job carries the original pin and is not blocked", async () => {
      await admitPresetRun(db, fixture, first.run);
      const assignment = await claimImplementJob(fixture, "later-job");
      assertEquals(
        assignment.input.repositoryProfile.repositoryRules,
        firstPin,
      );
      const rules = firstPin.entries.find((entry) =>
        entry.ruleKey === "changeRequest.semanticTitle"
      )!;
      // Not retroactively locked or weakened: the override still governs it.
      assertEquals(rules.provenance, "repository_override");
      assertEquals(rules.mode, "require");
      assertEquals(
        (rules.options as { maxSubjectLength: number }).maxSubjectLength,
        90,
      );
    });

    await test.step("AC2 and AC4: a run admitted afterwards sees the new revisions and the lock", async () => {
      const second = await startRun(fixture, fixture, repository2);
      const secondPin = await pinnedRulesOf(db, org, second.run.id);
      const expectedSecond = await expectedPin(
        { revision: 2, entries: orgRev2 },
        [asOverride(numbersRule({ mode: "warn" }))],
        { id: repository2.profileId, revision: 2 },
      );
      assertEquals(secondPin, expectedSecond);
      assertEquals(secondPin.organizationRevision, 2);
      assertEquals(secondPin.profileRevision, 2);
      assertNotEquals(secondPin.digest, firstPin.digest);
      assertEquals(provenanceOf(secondPin), {
        "commits.semantic": "locked_by_organization",
        "changeRequest.semanticTitle": "locked_by_organization",
        "code.magicNumbers": "locked_by_organization",
      });
      // The repository effective read agrees with what the run pinned.
      const effective = await expectJson<{ digest: string }>(
        await apiCall(
          fixture,
          fixture,
          "GET",
          `/v1/repositories/${repository2.repositoryId}/rules`,
        ),
        200,
      );
      assertEquals(effective.digest, secondPin.digest);
      // The first run is still on its own revision.
      assertEquals(
        (await pinnedRulesOf(db, org, first.run.id)).organizationRevision,
        1,
      );
    });
  });
});

Deno.test("admission never reads rules again: a corrupt later revision cannot touch an admitted run", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "no-reread");
    await publishOrganizationRules(fixture, fixture, 0, allRuleEntries());
    const { run } = await startRun(fixture, fixture, repository);
    const before = await readSnapshot(db, org, run.id);
    // Revision 2 is garbage. A job admission or claim that read rules again
    // would fail on it or pin it; the frozen snapshot must carry the job alone.
    await insertRuleVersionRow(
      db,
      org,
      2,
      { revision: 2, entries: "garbage" },
      "0".repeat(64),
    );
    await admitPresetRun(db, fixture, run);
    const assignment = await claimImplementJob(fixture, "no-reread");
    assertEquals(
      assignment.input.repositoryProfile.repositoryRules,
      before.profile.repositoryRules,
    );
    assertEquals((await readSnapshot(db, org, run.id)).text, before.text);
  }));

Deno.test("corrupt stored rules fail admission closed with a typed conflict and write nothing", async (test) => {
  await withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "corrupt");
    await publishOrganizationRules(fixture, fixture, 0, [titleEntry()]);
    const good = await startRun(fixture, fixture, repository);
    assertEquals(
      (await pinnedRulesOf(db, org, good.run.id)).organizationRevision,
      1,
    );
    const validEntries = [titleEntry()];
    const corruptions: Array<[string, unknown, string]> = [
      ["unknown rule key", {
        revision: 2,
        entries: [{ ...titleEntry(), ruleKey: "bogus.rule" }],
      }, "0".repeat(64)],
      [
        "entries is not an array",
        { revision: 2, entries: "x" },
        "0".repeat(64),
      ],
      ["entries missing", { revision: 2 }, "0".repeat(64)],
      [
        "stored digest differs from content",
        { revision: 2, entries: validEntries },
        "f".repeat(64),
      ],
      [
        "an entry with a weakened mode but the old digest",
        { revision: 2, entries: [{ ...titleEntry(), mode: "require" }] },
        await repositoryRuleVersionDigest(2, validEntries),
      ],
    ];
    let revision = 1;
    for (const [name, config, digest] of corruptions) {
      await test.step(name, async () => {
        revision += 1;
        await insertRuleVersionRow(db, org, revision, {
          ...(config as object),
          revision,
        }, digest);
        const runsBefore = await countRows(
          db,
          "select count(*) from bakery.workflow_runs where organization_id = $1",
          [org],
        );
        const bad = await startRunExpectingConflict(fixture, repository);
        assertEquals(bad.status, 409);
        assertEquals(bad.body.code, "STATE_CONFLICT");
        assertEquals(bad.body.reason, "repository_rules_unavailable");
        assertEquals(
          await countRows(
            db,
            "select count(*) from bakery.workflow_runs where organization_id = $1",
            [org],
          ),
          runsBefore,
        );
        // Nothing was written: the task is still draft with no current run.
        const task = await db.query<
          { status: string; current_run_id: string | null }
        >(
          "select status, current_run_id from bakery.tasks where organization_id = $1 and id = $2",
          [org, bad.taskId],
        );
        assertEquals(task.rows[0], { status: "draft", current_run_id: null });
        // The corrupt row stays the latest, so remove it for the next case.
        await db.query(
          `delete from bakery.organization_repository_rule_versions
            where organization_id = $1 and revision = $2`,
          [org, revision],
        );
      });
    }
  });
});

async function startRunExpectingConflict(
  fixture: Parameters<typeof startRun>[0] & {
    organizationId: string;
    principalId: string;
    adminCookie: string;
  },
  repository: Awaited<ReturnType<typeof seedRulesRepository>>,
) {
  const task = await createPresetTask(fixture, fixture, repository);
  const response = await startPresetRun(fixture, fixture, task, repository);
  const body = await response.json() as Record<string, unknown>;
  // The task must stay startable: nothing was written.
  return { status: response.status, body, taskId: task.id };
}

Deno.test("the rules read is bound to the organization and profile it was asked for", () =>
  withFixture(async (fixture) => {
    const repository = await seedRulesRepository(fixture, fixture, "scoped");
    await publishOrganizationRules(fixture, fixture, 0, [titleEntry()]);
    const profile = {
      repositoryId: repository.repositoryId,
      id: repository.profileId,
      revision: 1,
      digest: repository.profileDigest,
      repositoryRules: undefined,
    };
    const attempt = (
      organizationId: string,
      overrides: Partial<typeof profile>,
    ) =>
      withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) =>
          pinEffectiveRepositoryRules(transaction, organizationId, {
            ...profile,
            ...overrides,
          }),
      ).then(
        (pin) => ({ pin }),
        (error: { code?: string; params?: unknown }) => ({
          code: error.code,
          params: error.params,
        }),
      );
    const ok = await attempt(fixture.organizationId, {});
    assert("pin" in ok && ok.pin.organizationRevision === 1);
    const foreign = await attempt(crypto.randomUUID(), {});
    const unknownProfile = await attempt(fixture.organizationId, {
      id: crypto.randomUUID(),
    });
    const wrongRevision = await attempt(fixture.organizationId, {
      revision: 2,
    });
    const wrongDigest = await attempt(fixture.organizationId, {
      digest: "a".repeat(64),
    });
    const refusal = {
      code: "STATE_CONFLICT",
      params: { reason: "repository_rules_unavailable" },
    };
    // A foreign organization id is indistinguishable from an unknown profile.
    assertEquals(foreign, refusal);
    assertEquals(unknownProfile, refusal);
    assertEquals(wrongRevision, refusal);
    assertEquals(wrongDigest, refusal);
  }));

// ---------------------------------------------------------------------------
// AC3: workflow publication and activation re-check the effective rules.
// ---------------------------------------------------------------------------

const COMMAND = "magic.numbers";
const STRINGS_COMMAND = "magic.strings";

function stringsRule(overrides: Record<string, unknown> = {}) {
  return {
    ruleKey: "code.magicStrings",
    enabled: true,
    mode: "require",
    options: {
      checkBinding: STRINGS_COMMAND,
      allowedLiterals: [],
      excludedPaths: [],
    },
    locked: false,
    ...overrides,
  };
}

const checkStage = (checks: unknown, id = "check") => ({
  id,
  uses: "quality.check",
  with: { repositoryId: "$task.repositoryId", revision: "main", checks },
});
const implementStage = (id = "implement") => ({
  id,
  uses: "harness.implement",
  with: {
    repositoryId: "$task.repositoryId",
    planArtifact: "$input.plan",
    instructions: "$input.instructions",
  },
});
const repairStage = (id = "repair") => ({
  id,
  uses: "harness.repair",
  with: { repositoryId: "$task.repositoryId", findings: "$input.findings" },
});
const noopDefinition = {
  kind: "fixed",
  steps: [{ id: "first", uses: "workflow.noop" }],
};

type Problem = {
  code: string;
  issues: Array<{ path: unknown; code: string; message: string }>;
};

Deno.test("AC3: publishing or activating a workflow without a required stage is refused naming the rule key", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminB = { cookie: f.cookies.adminB, organizationId: organizationBId };
  const command = (who = adminA, extra: Record<string, unknown> = {}) => ({
    ...who,
    idempotencyKey: crypto.randomUUID(),
    ...extra,
  });
  let rulesRevision = 0;
  const publishRules = async (entries: unknown[], who = adminA) => {
    const response = await send(
      "POST",
      f.versionsPath(who.organizationId),
      { ...command(who), body: { expectedRevision: rulesRevision, entries } },
    );
    assertEquals(response.status, 201, await response.clone().text());
    rulesRevision += 1;
  };
  const scope = {
    organizationId: organizationAId,
    principalId: f.adminA.principalId,
    adminCookie: f.cookies.adminA,
  };
  const agentVersionId = await createCodingAgent(f.fixture, scope, "guard", {
    harness: "codex",
    billing: presetBilling("guard"),
  });
  const withAgent = (steps: unknown[]) => ({
    kind: "fixed",
    agents: { "harness.implement": agentVersionId },
    steps,
  });
  const createWorkflow = async (slug: string): Promise<string> => {
    const response = await send("POST", "/v1/workflows", {
      ...command(),
      body: { slug, name: slug, description: "" },
    });
    assertEquals(response.status, 201);
    return (await response.json() as { id: string }).id;
  };
  const newDraft = async (workflow: string, definition: unknown) => {
    const response = await send("POST", `/v1/workflows/${workflow}/versions`, {
      ...command(),
      body: { definition },
    });
    assertEquals(response.status, 201, await response.clone().text());
    return (await response.json() as { id: string }).id;
  };
  const publish = (workflow: string, draftId: string) =>
    send("POST", `/v1/workflows/${workflow}/versions/${draftId}/publish`, {
      ...command(),
      body: {},
      headers: { "If-Match": '"1"' },
    });
  const definitionVersion = async (workflow: string) =>
    (await (await send("GET", `/v1/workflows/${workflow}`, adminA)).json() as {
      version: number;
    }).version;
  const activate = async (workflow: string, versionId: string) =>
    send("POST", `/v1/workflows/${workflow}/activations`, {
      ...command(),
      body: { versionId },
      headers: { "If-Match": `"${await definitionVersion(workflow)}"` },
    });
  const problem = async (response: Response): Promise<Problem> => {
    const body = await response.json() as Record<string, unknown>;
    const params = (body.params ?? {}) as Record<string, unknown>;
    return {
      code: String(body.code),
      issues: (body.issues ?? params.issues ?? []) as Problem["issues"],
    };
  };
  const facts = async (workflow: string) => ({
    versions: await countRows(
      runtime,
      "select count(*) from bakery.workflow_versions where organization_id = $1 and workflow_id = $2",
      [organizationAId, workflow],
    ),
    drafts: await countRows(
      runtime,
      "select count(*) from bakery.workflow_drafts where organization_id = $1 and workflow_id = $2",
      [organizationAId, workflow],
    ),
    audit: await countRows(
      runtime,
      `select count(*) from bakery.audit_events
        where organization_id = $1
          and operation in ('workflowVersions.publish', 'workflowActivations.create')`,
      [organizationAId],
    ),
    events: await countRows(
      runtime,
      `select count(*) from bakery.domain_events
        where organization_id = $1
          and event_type in ('workflow.version_published', 'workflows.updated')`,
      [organizationAId],
    ),
    outbox: await countRows(
      runtime,
      "select count(*) from bakery.outbox where organization_id = $1",
      [organizationAId],
    ),
    active: (await runtime.query<{ active: string | null; version: number }>(
      `select active_version_id as active, version
         from bakery.workflow_definitions
        where organization_id = $1 and id = $2`,
      [organizationAId, workflow],
    )).rows[0],
  });
  let refusals = 0;
  const refusedPublish = async (
    slug: string,
    definition: unknown,
    expected: Array<{ code: string; ruleKey: string }>,
  ) => {
    // One draft per workflow, so every refusal gets its own workflow.
    refusals += 1;
    const workflow = await createWorkflow(`${slug}-${refusals}`);
    const draftId = await newDraft(workflow, definition);
    const before = await facts(workflow);
    const response = await publish(workflow, draftId);
    assertEquals(response.status, 422, await response.clone().text());
    const body = await problem(response);
    assertEquals(body.code, "UNPROCESSABLE");
    assertEquals(
      body.issues.map((issue) => issue.code),
      expected.map(({ code }) => code),
    );
    expected.forEach(({ ruleKey }, index) => {
      assert(
        body.issues[index].message.includes(`Rule ${ruleKey} `),
        body.issues[index].message,
      );
    });
    // Nothing written: no version, the draft stays, no audit, event or outbox.
    assertEquals(await facts(workflow), before);
    return draftId;
  };

  try {
    await test.step("no rule versions: publication and activation behave as before", async () => {
      const id = await createWorkflow("baseline");
      const draft = await newDraft(id, noopDefinition);
      assertEquals((await publish(id, draft)).status, 200);
      assertEquals((await activate(id, draft)).status, 200);
    });

    await publishRules([numbersRule()]);

    await test.step("a missing stage is refused on publish naming the rule key", async () => {
      await refusedPublish("missing-stage", withAgent([implementStage()]), [{
        code: "repository_rule_stage_missing",
        ruleKey: "code.magicNumbers",
      }]);
      // A different command, or checks that are not literal, prove nothing.
      await refusedPublish(
        "other-command",
        withAgent([implementStage(), checkStage(["lint"])]),
        [{
          code: "repository_rule_stage_missing",
          ruleKey: "code.magicNumbers",
        }],
      );
      await refusedPublish(
        "reference-checks",
        withAgent([implementStage(), checkStage("$input.checks")]),
        [{
          code: "repository_rule_stage_missing",
          ruleKey: "code.magicNumbers",
        }],
      );
    });

    await test.step("a reordered stage is refused: the check must follow the last implementation", async () => {
      await refusedPublish(
        "reordered",
        withAgent([checkStage([COMMAND]), implementStage()]),
        [{
          code: "repository_rule_stage_before_revision",
          ruleKey: "code.magicNumbers",
        }],
      );
    });

    await test.step("a compliant workflow publishes and activates", async () => {
      const id = await createWorkflow("compliant");
      const draft = await newDraft(
        id,
        withAgent([implementStage(), checkStage(["lint", COMMAND])]),
      );
      const published = await publish(id, draft);
      assertEquals(published.status, 200, await published.clone().text());
      const activated = await activate(id, draft);
      assertEquals(activated.status, 200, await activated.clone().text());
      assertEquals((await facts(id)).active.active, draft);
    });

    await test.step("activation re-checks: a version published before the rule is refused", async () => {
      const id = await createWorkflow("late-rule");
      // Published while the rules did not require it (rules revision 1 does,
      // so publish it as a rule-free organization would: temporarily empty).
      await publishRules([]);
      const draft = await newDraft(id, withAgent([implementStage()]));
      assertEquals((await publish(id, draft)).status, 200);
      await publishRules([numbersRule()]);
      const before = await facts(id);
      const response = await activate(id, draft);
      assertEquals(response.status, 422, await response.clone().text());
      const body = await problem(response);
      assertEquals(body.code, "UNPROCESSABLE");
      assertEquals(body.issues.map((issue) => issue.code), [
        "repository_rule_stage_missing",
      ]);
      assert(body.issues[0].message.includes("Rule code.magicNumbers "));
      // Nothing written: still not active, definition untouched, no audit.
      assertEquals(await facts(id), before);
      assertEquals(before.active.active, null);
    });

    await test.step("a workflow that never changes a revision is not bound", async () => {
      const id = await createWorkflow("not-bound");
      const draft = await newDraft(id, noopDefinition);
      const response = await publish(id, draft);
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals((await activate(id, draft)).status, 200);
    });

    await test.step("repair counts as a revision: a check before the repair is refused", async () => {
      await refusedPublish(
        "check-then-repair",
        withAgent([
          implementStage(),
          checkStage([COMMAND]),
          repairStage(),
        ]),
        [{
          code: "repository_rule_stage_before_revision",
          ruleKey: "code.magicNumbers",
        }],
      );
      const id = await createWorkflow("repair-then-check");
      const draft = await newDraft(
        id,
        withAgent([implementStage(), repairStage(), checkStage([COMMAND])]),
      );
      const response = await publish(id, draft);
      assertEquals(response.status, 200, await response.clone().text());
    });

    await test.step("the command id must match exactly", async () => {
      for (
        const near of [
          ["magic"],
          [`${COMMAND}.x`],
          [`x.${COMMAND}`],
          [COMMAND.toUpperCase()],
        ]
      ) {
        await refusedPublish(
          "near-miss",
          withAgent([implementStage(), checkStage(near)]),
          [{
            code: "repository_rule_stage_missing",
            ruleKey: "code.magicNumbers",
          }],
        );
      }
    });

    await test.step("a conditional check stage may be skipped, so it satisfies nothing", async () => {
      await refusedPublish(
        "conditional-check",
        withAgent([
          implementStage(),
          { ...checkStage([COMMAND]), if: "$input.enabled == true" },
        ]),
        [{
          code: "repository_rule_stage_missing",
          ruleKey: "code.magicNumbers",
        }],
      );
    });

    await test.step("a stored definition the runtime cannot read is refused at activation", async () => {
      const id = await createWorkflow("unreadable");
      const versionId = crypto.randomUUID();
      // Written past the publisher, which would have rejected it.
      await f.owner`
        insert into bakery.workflow_versions (
          id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by, version
        ) values (
          ${versionId}, ${organizationAId}, ${id}, 1, '',
          ${f.owner.json({ kind: "fixed", steps: "not-a-list" })},
          ${"a".repeat(64)}, 'published', ${f.adminA.principalId}, 1
        )`;
      const before = await facts(id);
      const response = await activate(id, versionId);
      assertEquals(response.status, 409, await response.clone().text());
      assertEquals(
        (await response.json() as { reason?: string }).reason,
        "workflow_version_invalid",
      );
      assertEquals(await facts(id), before);
      // A readable but non-fixed definition is named as such, not as invalid.
      const dynamicId = crypto.randomUUID();
      await f.owner`
        insert into bakery.workflow_versions (
          id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by, version
        ) values (
          ${dynamicId}, ${organizationAId}, ${id}, 2, '',
          ${
        f.owner.json({
          kind: "fixed",
          workflow: { kind: "dynamic" },
          steps: [{ id: "first", uses: "workflow.noop" }],
        })
      },
          ${"b".repeat(64)}, 'published', ${f.adminA.principalId}, 1
        )`;
      const beforeDynamic = await facts(id);
      const dynamic = await activate(id, dynamicId);
      assertEquals(dynamic.status, 409, await dynamic.clone().text());
      assertEquals(
        (await dynamic.json() as { reason?: string }).reason,
        "workflow_not_fixed",
      );
      assertEquals(await facts(id), beforeDynamic);
      // A compiler-grammar plan with a container node is valid, only not
      // executable yet: it is named as such, not as invalid (#108). It still
      // fails closed, because the guard cannot read nested steps.
      const planId = crypto.randomUUID();
      await f.owner`
        insert into bakery.workflow_versions (
          id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by, version
        ) values (
          ${planId}, ${organizationAId}, ${id}, 3, '',
          ${
        f.owner.json({
          apiVersion: "bakery.dev/v1",
          kind: "workflow",
          name: "plan-only",
          steps: [{
            id: "choose",
            branch: {
              when: '$input.target == "main"',
              then: [{ id: "on_main", uses: "workflow.noop", with: {} }],
              else: [{ id: "on_other", uses: "workflow.noop", with: {} }],
            },
          }],
        })
      },
          ${"c".repeat(64)}, 'published', ${f.adminA.principalId}, 1
        )`;
      const beforePlan = await facts(id);
      const plan = await activate(id, planId);
      assertEquals(plan.status, 409, await plan.clone().text());
      assertEquals(
        (await plan.json() as { reason?: string }).reason,
        "workflow_not_executable",
      );
      assertEquals(await facts(id), beforePlan);
    });

    await test.step("unreadable stored rules fail the guard closed on publish and activate", async () => {
      const id = await createWorkflow("corrupt-rules");
      // A version published and activated before the corruption.
      const draft = await newDraft(
        id,
        withAgent([implementStage(), checkStage([COMMAND])]),
      );
      assertEquals((await publish(id, draft)).status, 200);
      const other = await createWorkflow("corrupt-rules-draft");
      const pending = await newDraft(other, noopDefinition);
      const corruptions: Array<[string, unknown, string]> = [
        ["unknown rule key", {
          revision: rulesRevision + 1,
          entries: [{ ...numbersRule(), ruleKey: "bogus.rule" }],
        }, "0".repeat(64)],
        [
          "digest differs from content",
          {
            revision: rulesRevision + 1,
            entries: [numbersRule({ mode: "guide" })],
          },
          await repositoryRuleVersionDigest(rulesRevision + 1, [numbersRule()]),
        ],
      ];
      for (const [name, config, digest] of corruptions) {
        await f.owner`
          insert into bakery.organization_repository_rule_versions (
            id, organization_id, revision, config, digest
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${rulesRevision + 1},
            ${JSON.stringify(config)}::jsonb, ${digest}
          )`;
        try {
          const before = await facts(other);
          const published = await publish(other, pending);
          assertEquals(published.status, 409, `${name}: publish`);
          assertEquals(
            (await published.json() as { reason?: string }).reason,
            "repository_rules_unavailable",
          );
          assertEquals(await facts(other), before);
          const activated = await activate(id, draft);
          assertEquals(activated.status, 409, `${name}: activate`);
          assertEquals(
            (await activated.json() as { reason?: string }).reason,
            "repository_rules_unavailable",
          );
          assertEquals((await facts(id)).active.active, null);
        } finally {
          await f.owner`
            delete from bakery.organization_repository_rule_versions
             where organization_id = ${organizationAId}
               and revision = ${rulesRevision + 1}`;
        }
      }
    });

    await test.step("every unsatisfied rule is reported, in rule-key order", async () => {
      await publishRules([stringsRule(), numbersRule()]);
      await refusedPublish("two-rules", withAgent([implementStage()]), [
        { code: "repository_rule_stage_missing", ruleKey: "code.magicNumbers" },
        { code: "repository_rule_stage_missing", ruleKey: "code.magicStrings" },
      ]);
      const id = await createWorkflow("two-rules-ok");
      const draft = await newDraft(
        id,
        withAgent([implementStage(), checkStage([COMMAND, STRINGS_COMMAND])]),
      );
      assertEquals((await publish(id, draft)).status, 200);
    });

    await test.step("rules that cannot bind a stage never block", async () => {
      const id = await createWorkflow("non-blocking");
      const nonBlocking: Array<[string, unknown[]]> = [
        ["warn mode", [numbersRule({ mode: "warn" })]],
        ["guide mode", [numbersRule({ mode: "guide" })]],
        ["disabled", [numbersRule({ enabled: false })]],
        ["no check binding", [numbersRule({}, { checkBinding: null })]],
        ["removed in a later revision", []],
        ["require rule without a checker", [{ ...commitsEntry(true) }]],
      ];
      for (const [name, entries] of nonBlocking) {
        await publishRules(entries);
        const draft = await newDraft(id, {
          ...withAgent([implementStage()]),
          note: name,
        });
        const response = await publish(id, draft);
        assertEquals(response.status, 200, `${name}: ${await response.text()}`);
      }
    });

    await test.step("a rule publication in flight serializes with publish: the guard sees the committed rules", async () => {
      // Rules revision so far: allow the in-flight publication to be the next.
      await publishRules([]);
      const id = await createWorkflow("serialized");
      const draft = await newDraft(id, withAgent([implementStage()]));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const inFlight = withPgTransaction(runtime, async (transaction) => {
        // The same organization lock a rule publication holds until commit.
        await lockOrganization(transaction, organizationAId);
        held();
        await gate;
        await transaction.query(
          `insert into bakery.organization_repository_rule_versions (
             id, organization_id, revision, config, digest
           ) values ($1, $2, $3, $4::jsonb, $5)`,
          [
            crypto.randomUUID(),
            organizationAId,
            rulesRevision + 1,
            JSON.stringify({
              revision: rulesRevision + 1,
              entries: [numbersRule()],
            }),
            await repositoryRuleVersionDigest(rulesRevision + 1, [
              numbersRule(),
            ]),
          ],
        );
      });
      await holding;
      const publishing = Promise.resolve(publish(id, draft));
      let settled = false;
      void publishing.then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        assertEquals(
          settled,
          false,
          "publish ran past an in-flight rule publication",
        );
      } finally {
        release();
      }
      await inFlight;
      rulesRevision += 1;
      const response = await publishing;
      assertEquals(response.status, 422, await response.clone().text());
      assertEquals(
        (await problem(response)).issues.map((issue) => issue.code),
        ["repository_rule_stage_missing"],
      );
    });

    await test.step("another organization is not bound by these rules", async () => {
      await publishRules([numbersRule()]);
      const response = await send("POST", "/v1/workflows", {
        ...command(adminB),
        body: { slug: "other-org", name: "other-org", description: "" },
      });
      assertEquals(response.status, 201);
      const id = (await response.json() as { id: string }).id;
      const agentB = await createCodingAgent(
        f.fixture,
        {
          organizationId: organizationBId,
          principalId: f.adminB.principalId,
          adminCookie: f.cookies.adminB,
        },
        "guard-b",
        { harness: "codex", billing: presetBilling("guard-b") },
      );
      const draft = await send("POST", `/v1/workflows/${id}/versions`, {
        ...command(adminB),
        body: {
          definition: {
            kind: "fixed",
            agents: { "harness.implement": agentB },
            steps: [implementStage()],
          },
        },
      });
      const draftId = (await draft.json() as { id: string }).id;
      const published = await send(
        "POST",
        `/v1/workflows/${id}/versions/${draftId}/publish`,
        { ...command(adminB), body: {}, headers: { "If-Match": '"1"' } },
      );
      assertEquals(published.status, 200, await published.clone().text());
    });
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// Consistency: one read, taken at admission time, never mixed.
// ---------------------------------------------------------------------------

Deno.test("admission reads rules when it reaches the snapshot, not when the request arrived", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "late-read");
    await publishOrganizationRules(fixture, fixture, 0, [titleEntry()]);
    const task = await createPresetTask(fixture, fixture, repository);
    // Hold the repository row so admission blocks after it has started but
    // before it can build the snapshot; publish a newer revision meanwhile.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const blocker = withPgTransaction(db, async (transaction) => {
      await transaction.query(
        "select 1 from bakery.repositories where organization_id = $1 and id = $2 for update",
        [org, repository.repositoryId],
      );
      held();
      await gate;
    });
    await holding;
    // Whatever fails below, the held row lock must end or the lane hangs.
    let started: Promise<Response> | undefined;
    const lockedEntries = [
      { ...titleEntry(55), locked: true },
      unboundNumbersRule(),
    ];
    try {
      started = startPresetRun(fixture, fixture, task, repository);
      let waiting = 0;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        // pg_locks is visible to every role, unlike other roles' wait events.
        waiting = await countRows(
          db,
          "select count(*) from pg_locks where not granted",
          [],
        );
        if (waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert(waiting > 0, "admission never blocked on the held repository row");
      await publishOrganizationRules(fixture, fixture, 1, lockedEntries);
    } finally {
      release();
      await blocker;
    }
    const run = await expectJson<{ id: string }>(await started!, 201);
    const pin = await pinnedRulesOf(db, org, run.id);
    // Whole new revision with its own digest; never revision 1 with 2's digest.
    assertEquals(
      pin,
      await expectedPin({ revision: 2, entries: lockedEntries }, [], {
        id: repository.profileId,
        revision: 1,
      }),
    );
  }));

Deno.test("concurrent publication and admission: every snapshot is exactly one published revision", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const overrides = [asOverride(numbersRule({ mode: "warn" }))];
    const repositories = [];
    for (let index = 0; index < 4; index += 1) {
      repositories.push(
        await seedRulesRepository(fixture, fixture, `race-${index}`, {
          entries: overrides,
        }),
      );
    }
    const revisionEntries = (revision: number) => [
      { ...titleEntry(40 + revision), locked: revision % 2 === 0 },
      unboundNumbersRule({ mode: revision % 2 === 0 ? "require" : "warn" }),
    ];
    await publishOrganizationRules(fixture, fixture, 0, revisionEntries(1));
    const runs: Array<{ id: string; repository: typeof repositories[number] }> =
      [];
    let published = 1;
    for (let round = 0; round < 5; round += 1) {
      const tasks = [];
      for (const repository of repositories) {
        tasks.push({
          repository,
          task: await createPresetTask(fixture, fixture, repository),
        });
      }
      const next = published + 1;
      const [started] = await Promise.all([
        Promise.all(
          tasks.map(({ repository, task }) =>
            startPresetRun(fixture, fixture, task, repository)
          ),
        ),
        publishOrganizationRules(
          fixture,
          fixture,
          published,
          revisionEntries(next),
        ),
      ]);
      published = next;
      for (const [index, response] of started.entries()) {
        const run = await expectJson<{ id: string }>(response, 201);
        runs.push({ id: run.id, repository: tasks[index].repository });
      }
    }
    const versions = await db.query<
      { revision: number; config: { entries: never[] } }
    >(
      `select revision, config from bakery.organization_repository_rule_versions
        where organization_id = $1`,
      [org],
    );
    const byRevision = new Map(versions.rows.map((row) => [row.revision, row]));
    for (const { id, repository } of runs) {
      const { text, profile } = await readSnapshot(db, org, id);
      const pin = profile.repositoryRules!;
      const version = byRevision.get(pin.organizationRevision);
      assert(version, `revision ${pin.organizationRevision} was published`);
      assertEquals(
        pin,
        await expectedPin(
          { revision: version.revision, entries: version.config.entries },
          overrides,
          { id: repository.profileId, revision: 1 },
        ),
      );
      // Written once: a later read of the same row is byte-identical.
      assertEquals((await readSnapshot(db, org, id)).text, text);
    }
  }));

// ---------------------------------------------------------------------------
// Server-side digest verification at claim time (the one fixed-policy path).
// ---------------------------------------------------------------------------

Deno.test("claim refuses a job whose pinned rules were altered, then admits it once restored", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "tamper");
    await publishOrganizationRules(fixture, fixture, 0, [
      { ...commitsEntry(true), mode: "require" },
      titleEntry(),
    ]);
    const { run } = await startRun(fixture, fixture, repository);
    const admitted = await admitPresetRun(db, fixture, run);
    const stored = await db.query<
      { input: { repositoryProfile: Record<string, unknown> } }
    >(
      "select input from bakery.jobs where organization_id = $1 and id = $2",
      [org, admitted.implementJobId],
    );
    const input = stored.rows[0].input;
    const pin = input.repositoryProfile.repositoryRules as {
      entries: Array<Record<string, unknown>>;
      digest: string;
    };
    assert(pin.entries.length === 2);
    const worker = await registeredWorker(fixture, {
      name: `pin-tamper-${crypto.randomUUID().slice(0, 8)}`,
      capabilities: workerFixtureCapabilities,
    });
    const claim = async () => {
      const claimKey = crypto.randomUUID();
      const response = await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities: workerFixtureCapabilities,
          supportedActions: ["harness.implement"],
        },
        { idempotencyKey: claimKey },
      );
      await response.body?.cancel();
      return response.status;
    };
    const setJob = (repositoryRules: unknown) =>
      db.query(
        "update bakery.jobs set input = $3::jsonb where organization_id = $1 and id = $2",
        [
          org,
          admitted.implementJobId,
          JSON.stringify({
            ...input,
            repositoryProfile: {
              ...input.repositoryProfile,
              repositoryRules,
            },
          }),
        ],
      );
    const weakened = {
      ...pin,
      entries: pin.entries.map((entry, index) =>
        index === 0 ? { ...entry, mode: "guide" } : entry
      ),
    };
    // Job input no longer equals the frozen snapshot: refused.
    await setJob({ ...pin, digest: "0".repeat(64) });
    assertEquals(await claim(), 204);
    await setJob(weakened);
    assertEquals(await claim(), 204);
    // Stripping the pin from the job is a difference from the snapshot too.
    await setJob(undefined);
    assertEquals(await claim(), 204);
    // Snapshot and job agree on weakened entries but the digest was not
    // recomputed: the digest check, not the equality check, must refuse it.
    const snapshot = await db.query<
      { snapshot: { repositoryProfile: Record<string, unknown> } }
    >(
      "select snapshot from bakery.workflow_runs where organization_id = $1 and id = $2",
      [org, run.id],
    );
    const original = snapshot.rows[0].snapshot;
    await db.query(
      "update bakery.workflow_runs set snapshot = $3::jsonb where organization_id = $1 and id = $2",
      [
        org,
        run.id,
        JSON.stringify({
          ...original,
          repositoryProfile: {
            ...original.repositoryProfile,
            repositoryRules: weakened,
          },
        }),
      ],
    );
    await setJob(weakened);
    assertEquals(await claim(), 204);
    const attempts = await countRows(
      db,
      "select count(*) from bakery.job_attempts where organization_id = $1 and job_id = $2",
      [org, admitted.implementJobId],
    );
    assertEquals(attempts, 0);
    // Restored to the frozen pin the very same job is claimable.
    await db.query(
      "update bakery.workflow_runs set snapshot = $3::jsonb where organization_id = $1 and id = $2",
      [org, run.id, JSON.stringify(original)],
    );
    await setJob(pin);
    assertEquals(await claim(), 200);
  }));

Deno.test("step admission refuses a snapshot whose pinned rules no longer match their digest", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "snapshot");
    await publishOrganizationRules(fixture, fixture, 0, [
      { ...commitsEntry(true), mode: "require" },
    ]);
    const { run } = await startRun(fixture, fixture, repository);
    const stored = await db.query<{
      snapshot: {
        repositoryProfile: {
          repositoryRules: { entries: Array<Record<string, unknown>> };
        };
      };
    }>(
      "select snapshot from bakery.workflow_runs where organization_id = $1 and id = $2",
      [org, run.id],
    );
    const original = stored.rows[0].snapshot;
    const pin = original.repositoryProfile.repositoryRules;
    // A weakened mode with the digest left as admitted.
    const weakened = {
      ...original,
      repositoryProfile: {
        ...original.repositoryProfile,
        repositoryRules: {
          ...pin,
          entries: pin.entries.map((entry) => ({ ...entry, mode: "guide" })),
        },
      },
    };
    await db.query(
      "update bakery.workflow_runs set snapshot = $3::jsonb where organization_id = $1 and id = $2",
      [org, run.id, JSON.stringify(weakened)],
    );
    await assertRejects(
      () => admitPresetRun(db, fixture, run),
      Error,
    );
    assertEquals(
      await countRows(
        db,
        "select count(*) from bakery.jobs where organization_id = $1 and run_step_id in (select id from bakery.run_steps where organization_id = $1 and run_id = $2)",
        [org, run.id],
      ),
      0,
    );
    // Restored, the same run admits.
    await db.query(
      "update bakery.workflow_runs set snapshot = $3::jsonb where organization_id = $1 and id = $2",
      [org, run.id, JSON.stringify(original)],
    );
    await admitPresetRun(db, fixture, run);
  }));

Deno.test("AC4: a lock added after admission leaves the running run unblocked and unweakened", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const overrides = [asOverride({ ...titleEntry(90), mode: "require" })];
    const repository = await seedRulesRepository(
      fixture,
      fixture,
      "lock-late",
      {
        entries: overrides,
      },
    );
    // Revision 1 locks nothing.
    await publishOrganizationRules(fixture, fixture, 0, [titleEntry()]);
    const { run } = await startRun(fixture, fixture, repository);
    const pin = await pinnedRulesOf(db, org, run.id);
    assertEquals(provenanceOf(pin), {
      "changeRequest.semanticTitle": "repository_override",
    });
    // Revision 2 locks the rule the run overrode.
    await publishOrganizationRules(fixture, fixture, 1, [lockedTitle]);
    await admitPresetRun(db, fixture, run);
    const assignment = await claimImplementJob(fixture, "lock-late");
    assertEquals(assignment.input.repositoryProfile.repositoryRules, pin);
    const next = await startRun(fixture, fixture, repository);
    assertEquals(
      provenanceOf(await pinnedRulesOf(db, org, next.run.id)),
      { "changeRequest.semanticTitle": "locked_by_organization" },
    );
  }));

// ---------------------------------------------------------------------------
// AC3 at run admission: no route around a required stage.
// ---------------------------------------------------------------------------

type Refusal = {
  status: number;
  code?: string;
  reason?: string;
  issues?: Array<{ code: string; message: string; path: unknown }>;
};

async function attemptRun(
  fixture:
    & Parameters<typeof startRun>[0]
    & Parameters<typeof createPresetTask>[1],
  repository: Awaited<ReturnType<typeof seedRulesRepository>>,
  body: Record<string, unknown> | "preset",
): Promise<Refusal & { taskId: string; runId?: string }> {
  const task = await createPresetTask(fixture, fixture, repository);
  const response = body === "preset"
    ? await startPresetRun(fixture, fixture, task, repository)
    : await apiCall(fixture, fixture, "POST", `/v1/tasks/${task.id}/runs`, {
      body: {
        executionMode: "repository",
        repositoryProfileId: repository.profileId,
        budgetLimitUsd: "5",
        inputs: { plan: crypto.randomUUID(), instructions: "Do it." },
        ...body,
      },
    });
  const parsed = await response.json() as Refusal & { id?: string };
  return {
    ...parsed,
    status: response.status,
    taskId: task.id,
    runId: parsed.id,
  };
}

async function taskUntouched(
  db: Parameters<typeof countRows>[0],
  org: string,
  taskId: string,
) {
  const task = await db.query<
    { status: string; current_run_id: string | null }
  >(
    "select status, current_run_id from bakery.tasks where organization_id = $1 and id = $2",
    [org, taskId],
  );
  assertEquals(task.rows[0], { status: "draft", current_run_id: null });
}

Deno.test("AC3 at admission: a run cannot start without a required check by preset, old version or active version", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "admission");
    const agent = repository.agentVersionId!;
    // Published and active BEFORE any rule exists.
    const old = await publishWorkflow(
      fixture,
      fixture,
      "pre-rule",
      implementOnlyDefinition(agent),
      { activate: true },
    );
    // Runnable and repository-bound, but it never changes a revision.
    const noop = await publishWorkflow(fixture, fixture, "brief-only", {
      kind: "fixed",
      steps: [{
        id: "brief",
        uses: "task.brief",
        with: { brief: "$input.brief", repositoryId: "$task.repositoryId" },
      }],
    });
    const runCount = () =>
      countRows(
        db,
        "select count(*) from bakery.workflow_runs where organization_id = $1",
        [org],
      );

    // Empty baseline: nothing is bound, the same run starts as before.
    const baseline = await attemptRun(fixture, repository, {
      workflowId: old.workflowId,
    });
    assertEquals(baseline.status, 201, JSON.stringify(baseline));
    assertEquals(
      (await pinnedRulesOf(db, org, baseline.runId!)).entries,
      [],
    );

    // A rule that cannot bind a stage (warn, or no checker) leaves it alone.
    await publishOrganizationRules(fixture, fixture, 0, [
      numbersRule({ mode: "warn" }),
      commitsEntry(true),
    ]);
    assertEquals(
      (await attemptRun(fixture, repository, { workflowId: old.workflowId }))
        .status,
      201,
    );

    // A locked require rule bound to a command now binds every route.
    await publishOrganizationRules(fixture, fixture, 1, [
      numbersRule({ locked: true }),
    ]);
    const runsBefore = await runCount();
    const refusals = {
      preset: await attemptRun(fixture, repository, "preset"),
      versionById: await attemptRun(fixture, repository, {
        workflowVersionId: old.versionId,
      }),
      activeByWorkflowId: await attemptRun(fixture, repository, {
        workflowId: old.workflowId,
      }),
    };
    for (const [name, refusal] of Object.entries(refusals)) {
      assertEquals(refusal.status, 422, `${name}: ${JSON.stringify(refusal)}`);
      assertEquals(refusal.code, "UNPROCESSABLE", name);
      assertEquals(
        refusal.issues?.map((issue) => issue.code),
        ["repository_rule_stage_missing"],
        name,
      );
      assert(
        refusal.issues![0].message.includes("Rule code.magicNumbers "),
        name,
      );
      await taskUntouched(db, org, refusal.taskId);
    }
    assertEquals(await runCount(), runsBefore);

    // A compliant workflow is admitted and its run still pins the rule.
    const compliant = await publishWorkflow(
      fixture,
      fixture,
      "compliant",
      {
        kind: "fixed",
        agents: { "harness.implement": agent },
        steps: [implementStage(), checkStage([COMMAND])],
      },
      { activate: true },
    );
    const admitted = await attemptRun(fixture, repository, {
      workflowId: compliant.workflowId,
    });
    assertEquals(admitted.status, 201, JSON.stringify(admitted));
    assertEquals(
      provenanceOf(await pinnedRulesOf(db, org, admitted.runId!)),
      { "code.magicNumbers": "locked_by_organization" },
    );

    // A workflow that never changes a revision is not bound.
    const unbound = await attemptRun(fixture, repository, {
      workflowVersionId: noop.versionId,
      inputs: { brief: "Write the brief." },
    });
    assertEquals(unbound.status, 201, JSON.stringify(unbound));

    // A rule published after admission never touches the admitted run (AC4).
    await publishOrganizationRules(fixture, fixture, 2, [
      numbersRule({ locked: true }, { checkBinding: "other.command" }),
    ]);
    assertEquals(
      (await pinnedRulesOf(db, org, admitted.runId!)).organizationRevision,
      2,
    );
  }));

// ---------------------------------------------------------------------------
// Size: the pin has to fit the job transport, so the baseline is bounded.
// ---------------------------------------------------------------------------

const descriptionBallast = (template: string) => ({
  ruleKey: "changeRequest.description",
  enabled: true,
  mode: "guide",
  options: { template, requiredSections: [] },
  locked: false,
});

/** Valid organization entries whose canonical UTF-8 size is exactly `target`. */
function rulesWithBytes(target: number): RuleEntry[] {
  const entries = (paths: string[]): RuleEntry[] => [
    descriptionBallast("径".repeat(8000)),
    unboundNumbersRule({}, { excludedPaths: paths }),
  ];
  const coarse: string[] = [];
  const cjkPath = "径".repeat(100);
  // Leave room for two fine-tuning paths of 1..200 ASCII characters each.
  while (
    coarse.length < 29 &&
    organizationRulesBytes(
        organizationEntries(entries([...coarse, cjkPath, "a", "a"])),
      ) <=
      target
  ) coarse.push(cjkPath);
  const base = organizationRulesBytes(
    organizationEntries(entries([...coarse, "a", "a"])),
  );
  const need = target - base + 2;
  assert(need >= 2 && need <= 400, `cannot land on ${target}: ${need}`);
  const first = Math.min(200, need - 1);
  const result = entries([
    ...coarse,
    "a".repeat(first),
    "a".repeat(need - first),
  ]);
  assertEquals(organizationRulesBytes(organizationEntries(result)), target);
  return result;
}

Deno.test("organization rules are bounded in UTF-8 bytes at publication", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const versions = () =>
      countRows(
        db,
        "select count(*) from bakery.organization_repository_rule_versions where organization_id = $1",
        [org],
      );
    const publish = (expectedRevision: number, entries: RuleEntry[]) =>
      apiCall(
        fixture,
        fixture,
        "POST",
        `/v1/organizations/${org}/repository-rule-versions`,
        { body: { expectedRevision, entries } },
      );
    const refusedTooLarge = async (entries: RuleEntry[], name: string) => {
      const before = await versions();
      const response = await publish(0, entries);
      const body = await response.json() as {
        code: string;
        issues: Array<{ path: unknown; code: string }>;
      };
      assertEquals(response.status, 422, `${name}: ${JSON.stringify(body)}`);
      assertEquals(body.code, "UNPROCESSABLE", name);
      assertEquals(body.issues.map((issue) => issue.code), [
        "repository_rules_too_large",
      ], name);
      assertEquals(body.issues[0].path, ["entries"], name);
      assertEquals(await versions(), before, `${name}: nothing written`);
    };
    // Exactly at the ceiling is accepted; one byte more is refused.
    await refusedTooLarge(
      rulesWithBytes(ORGANIZATION_RULES_MAX_BYTES + 1),
      "one byte over",
    );
    // Characters are not bytes: 8000 control characters escape to 48,000 bytes
    // and 8000 CJK characters take 24,000.
    await refusedTooLarge(
      [descriptionBallast("\u0001".repeat(8000))],
      "control characters",
    );
    const atCeiling = await publish(
      0,
      rulesWithBytes(ORGANIZATION_RULES_MAX_BYTES),
    );
    assertEquals(atCeiling.status, 201, await atCeiling.clone().text());
    await atCeiling.body?.cancel();
    assertEquals(await versions(), 1);
    // 8000 CJK characters alone fit: the bound is on bytes, not on schema.
    const cjk = await publish(1, [descriptionBallast("径".repeat(8000))]);
    assertEquals(cjk.status, 201, await cjk.clone().text());
    await cjk.body?.cancel();
  }));

Deno.test("an oversized stored baseline is refused at admission with a typed error, never a stuck queued run", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "oversize");
    const plain = await publishWorkflow(fixture, fixture, "oversize-brief", {
      kind: "fixed",
      steps: [{
        id: "brief",
        uses: "task.brief",
        with: { brief: "$input.brief", repositoryId: "$task.repositoryId" },
      }],
    });
    // Valid for the schema, far over the ceiling: written past the publisher.
    const huge = [
      {
        ...descriptionBallast("\u0001".repeat(8000)),
        options: {
          template: "\u0001".repeat(8000),
          requiredSections: Array.from(
            { length: 16 },
            () => "\u0001".repeat(100),
          ),
          writingGuidance: "\u0001".repeat(2000),
        },
      },
      unboundNumbersRule({}, {
        excludedPaths: Array.from({ length: 32 }, () => "\u0001".repeat(200)),
      }),
    ];
    assert(organizationRulesBytes(organizationEntries(huge)) > 100_000);
    await insertRuleVersionRow(
      db,
      org,
      1,
      { revision: 1, entries: huge },
      await repositoryRuleVersionDigest(1, huge),
    );
    const runCount = () =>
      countRows(
        db,
        "select count(*) from bakery.workflow_runs where organization_id = $1",
        [org],
      );
    const before = await runCount();
    for (
      const [name, body] of [
        ["preset", "preset" as const],
        ["plain workflow", {
          workflowVersionId: plain.versionId,
          inputs: { brief: "Write the brief." },
        }],
      ] as const
    ) {
      const refusal = await attemptRun(fixture, repository, body);
      assertEquals(refusal.status, 422, `${name}: ${JSON.stringify(refusal)}`);
      assertEquals(refusal.code, "UNPROCESSABLE", name);
      assertEquals(
        refusal.issues?.map((issue) => [issue.path, issue.code]),
        [[["repositoryRules"], "repository_rules_too_large"]],
        name,
      );
      await taskUntouched(db, org, refusal.taskId);
    }
    assertEquals(await runCount(), before);
    // Recoverable: a smaller revision admits again.
    await insertRuleVersionRow(
      db,
      org,
      2,
      { revision: 2, entries: [] },
      await repositoryRuleVersionDigest(2, []),
    );
    const again = await attemptRun(fixture, repository, {
      workflowVersionId: plain.versionId,
      inputs: { brief: "Write the brief." },
    });
    assertEquals(again.status, 201, JSON.stringify(again));
  }));

Deno.test("a plain workflow with an omitted request key admits as before, with and without rules", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "omitted");
    const plain = await publishWorkflow(fixture, fixture, "omitted-key", {
      kind: "fixed",
      steps: [{
        id: "brief",
        uses: "task.brief",
        with: { brief: "$input.brief", repositoryId: "$task.repositoryId" },
      }],
    });
    const start = () =>
      attemptRun(fixture, repository, {
        workflowVersionId: plain.versionId,
        inputs: {},
      });
    // No rules at all: the request omits `brief` and still starts, as on main.
    const bare = await start();
    assertEquals(bare.status, 201, JSON.stringify(bare));
    // With a rule that cannot bind a stage: unchanged.
    await publishOrganizationRules(fixture, fixture, 0, [
      unboundNumbersRule({ locked: true }),
    ]);
    const ruled = await start();
    assertEquals(ruled.status, 201, JSON.stringify(ruled));
    assertEquals(
      (await pinnedRulesOf(db, org, ruled.runId!)).organizationRevision,
      1,
    );
  }));

Deno.test("a bound rule published after admission leaves the admitted run claimable and refuses later runs", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "after");
    const { run } = await startRun(fixture, fixture, repository);
    const before = await readSnapshot(db, org, run.id);
    await publishOrganizationRules(fixture, fixture, 0, [
      numbersRule({ locked: true }),
    ]);
    // The admitted run keeps its pin (the empty baseline), admits its jobs and
    // is claimed even though the same workflow would now be refused at start.
    await admitPresetRun(db, fixture, run);
    const assignment = await claimImplementJob(fixture, "after");
    assertEquals(
      assignment.input.repositoryProfile.repositoryRules,
      before.profile.repositoryRules,
    );
    assertEquals((await readSnapshot(db, org, run.id)).text, before.text);
    const later = await attemptRun(fixture, repository, "preset");
    assertEquals(later.status, 422, JSON.stringify(later));
    assertEquals(
      later.issues?.map((issue) => issue.code),
      ["repository_rule_stage_missing"],
    );
  }));

Deno.test("steps that read earlier outputs are measured with an allowance, so a near-limit pin cannot stall them", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "allowance");
    const brief = {
      id: "brief",
      uses: "task.brief",
      with: { brief: "$input.brief", repositoryId: "$task.repositoryId" },
    };
    const first = await publishWorkflow(fixture, fixture, "allow-one", {
      kind: "fixed",
      steps: [brief],
    });
    const second = await publishWorkflow(fixture, fixture, "allow-two", {
      kind: "fixed",
      steps: [brief, {
        id: "again",
        uses: "task.brief",
        with: {
          brief: "$step.brief.artifact.versionId",
          repositoryId: "$task.repositoryId",
        },
      }],
    });
    // n control-character paths grow the stored baseline by about 1.2 KB each.
    const rules = (paths: number): RuleEntry[] => [
      {
        ...descriptionBallast("\u0001".repeat(8000)),
        options: {
          template: "\u0001".repeat(8000),
          requiredSections: Array.from(
            { length: 16 },
            () => "\u0001".repeat(100),
          ),
          writingGuidance: "\u0001".repeat(2000),
        },
      },
      unboundNumbersRule({}, {
        excludedPaths: Array.from(
          { length: paths },
          () => "\u0001".repeat(200),
        ),
      }),
    ];
    let revision = 0;
    const attempt = async (paths: number, version: string) => {
      revision += 1;
      const entries = rules(paths);
      await insertRuleVersionRow(
        db,
        org,
        revision,
        { revision, entries },
        await repositoryRuleVersionDigest(revision, entries),
      );
      return await attemptRun(fixture, repository, {
        workflowVersionId: version,
        inputs: { brief: "Write the brief." },
      });
    };
    // Largest path count whose first step still fits the job input.
    let low = 0;
    let high = 32;
    assertEquals((await attempt(low, first.versionId)).status, 201);
    assertEquals((await attempt(high, first.versionId)).status, 422);
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if ((await attempt(mid, first.versionId)).status === 201) low = mid;
      else high = mid;
    }
    // Same baseline and first step, plus a step that reads the first one's
    // output: it is measured with the allowance, which no longer fits.
    const refused = await attempt(low, second.versionId);
    assertEquals(refused.status, 422, JSON.stringify(refused));
    assertEquals(
      refused.issues?.map((issue) => issue.code),
      ["repository_rules_too_large"],
    );
    // One path fewer leaves room for the allowance and admits it.
    const admitted = await attempt(low - 2, second.versionId);
    assertEquals(admitted.status, 201, JSON.stringify(admitted));
  }));

Deno.test("a missing required check is refused before input resolution or size is considered", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "verdict");
    // Reads `$input.plan` and `$input.instructions`.
    const implementOnly = await publishWorkflow(
      fixture,
      fixture,
      "unresolved-implement",
      implementOnlyDefinition(repository.agentVersionId!),
    );
    await publishOrganizationRules(fixture, fixture, 0, [
      numbersRule({ locked: true }),
    ]);
    // The unresolved-key case only shows the rule guard applies to plain
    // workflows; the oversized case proves the ordering: the rule verdict
    // comes before the job-input size check.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unresolved key", {}],
      ["oversized input", {
        plan: crypto.randomUUID(),
        instructions: "x".repeat(99_800),
      }],
    ];
    for (const [name, inputs] of cases) {
      const refusal = await attemptRun(fixture, repository, {
        workflowVersionId: implementOnly.versionId,
        inputs,
      });
      assertEquals(
        refusal.status,
        422,
        `${name}: ${JSON.stringify(refusal).slice(0, 300)}`,
      );
      assertEquals(refusal.code, "UNPROCESSABLE", name);
      assertEquals(
        refusal.issues?.map((issue) => issue.code),
        ["repository_rule_stage_missing"],
        name,
      );
      await taskUntouched(db, org, refusal.taskId);
    }
  }));

Deno.test("an oversized plain run input is reported on inputs, not on a preset description", () =>
  withFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    const org = fixture.organizationId;
    const repository = await seedRulesRepository(fixture, fixture, "bigplain");
    const plain = await publishWorkflow(fixture, fixture, "big-brief", {
      kind: "fixed",
      steps: [{
        id: "brief",
        uses: "task.brief",
        with: { brief: "$input.brief", repositoryId: "$task.repositoryId" },
      }],
    });
    const refusal = await attemptRun(fixture, repository, {
      workflowVersionId: plain.versionId,
      inputs: { brief: "x".repeat(99_800) },
    });
    assertEquals(refusal.status, 422, JSON.stringify(refusal).slice(0, 400));
    assertEquals(
      refusal.issues?.map((issue) => [issue.path, issue.code]),
      [[["inputs"], "inputs_too_large"]],
    );
    await taskUntouched(db, org, refusal.taskId);
  }));

Deno.test("preset availability reports a bound require rule exactly when admission refuses the start", () =>
  withFixture(async (fixture) => {
    const repository = await seedRulesRepository(fixture, fixture, "avail");
    const availability = async () => {
      const page = await expectJson<{
        items: Array<{
          availability: { status: string; reasons: string[] } | null;
        }>;
      }>(
        await apiCall(
          fixture,
          fixture,
          "GET",
          `/v1/workflow-presets?repositoryId=${repository.repositoryId}`,
        ),
        200,
      );
      return page.items[0].availability;
    };
    // The same pin and the same check decide both answers at every revision.
    const rules: Array<[string, RuleEntry[], boolean]> = [
      ["no rules", [], false],
      ["warn rule", [numbersRule({ mode: "warn" })], false],
      ["unbound require rule", [unboundNumbersRule()], false],
      ["bound require rule", [numbersRule({ locked: true })], true],
      ["bound rule removed", [], false],
    ];
    let revision = 0;
    for (const [name, entries, blocked] of rules) {
      if (entries.length > 0 || revision > 0) {
        await publishOrganizationRules(fixture, fixture, revision, entries);
        revision += 1;
      }
      const verdict = await availability();
      assertEquals(
        verdict?.reasons.includes("required_check_missing"),
        blocked,
        `${name}: ${JSON.stringify(verdict)}`,
      );
      assertEquals(verdict?.status, blocked ? "setup_required" : "ready", name);
      const start = await attemptRun(fixture, repository, "preset");
      assertEquals(start.status, blocked ? 422 : 201, `${name}: start`);
    }
  }));
