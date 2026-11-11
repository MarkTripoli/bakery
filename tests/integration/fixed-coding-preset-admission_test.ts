import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  FIXED_CODING_PRESET,
  FIXED_CODING_REVIEWED_PRESET,
  renderImplementInstructions,
} from "../../packages/contracts/src/workflow-presets.ts";
import {
  closeWorkerScope,
  createWorkerScope,
} from "../helpers/worker-execution.ts";
import {
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  admitPresetRun,
  apiCall,
  createCodingAgent,
  createPresetTask,
  expectJson,
  presetBilling,
  presetBudgetEnv,
  presetBudgetPolicy,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { seedProviderPricingSnapshot } from "../helpers/funded-model-job.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";

type RunBody = {
  id: string;
  status: string;
  workflowVersionId: string;
  budgetLimitUsd: string;
};
type AvailabilityBody = {
  status: string;
  reasons: string[];
  minimumBudgetLimitUsd: string | null;
};
type PresetsPage = {
  items: Array<{
    id: string;
    digest: string;
    availability: AvailabilityBody | null;
  }>;
  nextCursor: string | null;
};

const withFixture = <T>(
  work: Parameters<typeof withWorkerFixture<T>>[0],
  budget = true,
) => withWorkerFixture(work, budget ? { env: presetBudgetEnv } : {});

async function availability(
  fixture: Parameters<typeof startPresetRun>[0],
  scope: Parameters<typeof startPresetRun>[1],
  repositoryId: string,
): Promise<AvailabilityBody> {
  const page = await expectJson<PresetsPage>(
    await apiCall(
      fixture,
      scope,
      "GET",
      `/v1/workflow-presets?repositoryId=${repositoryId}`,
    ),
    200,
  );
  // fixed-coding stays first; the reviewed preset is appended after it.
  assertEquals(page.items.map((item) => item.id), [
    "fixed-coding",
    "fixed-coding-reviewed",
  ]);
  assert(page.items[0].availability);
  return page.items[0].availability;
}

Deno.test("preset runs materialize one published version per organization and replay idempotently", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "mat");
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const first = await createPresetTask(fixture, fixture, repository);
    // A separate application: lockApplication cannot serialize these two
    // first runs, so only the preset advisory lock keeps one shared version.
    const secondRepository = await seedPresetRepository(
      fixture.pgDatabase,
      fixture,
      { agentVersionId: agent },
    );
    assertNotEquals(secondRepository.applicationId, repository.applicationId);
    const second = await createPresetTask(
      fixture,
      fixture,
      secondRepository,
      { title: "Second task" },
    );

    const [a, b] = await Promise.all([
      startPresetRun(fixture, fixture, first, repository),
      startPresetRun(fixture, fixture, second, secondRepository),
    ]);
    const runA = await expectJson<RunBody>(a, 201);
    const runB = await expectJson<RunBody>(b, 201);
    assertEquals(runA.workflowVersionId, runB.workflowVersionId);
    assertEquals(Number(runA.budgetLimitUsd), 5);

    const rows = await fixture.pgDatabase.query<{
      definitions: string;
      versions: string;
      digest: string;
      status: string;
      active: boolean;
    }>(
      `select count(distinct definition.id)::text as definitions,
              count(distinct version.id)::text as versions,
              min(version.digest) as digest, min(version.status) as status,
              bool_and(definition.active_version_id = version.id) as active
         from bakery.workflow_definitions definition
         join bakery.workflow_versions version
           on version.organization_id = definition.organization_id
          and version.workflow_id = definition.id
        where definition.organization_id = $1 and definition.slug = $2`,
      [fixture.organizationId, FIXED_CODING_PRESET.slug],
    );
    assertEquals(rows.rows[0], {
      definitions: "1",
      versions: "1",
      digest: FIXED_CODING_PRESET.digest,
      status: "published",
      active: true,
    });

    // Same key and body replays the stored run, never a second one.
    const replayKey = `replay-${crypto.randomUUID()}`;
    const third = await createPresetTask(fixture, fixture, repository, {
      title: "Replay task",
    });
    const original = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, third, repository, {
        idempotencyKey: replayKey,
      }),
      201,
    );
    const replay = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, third, repository, {
        idempotencyKey: replayKey,
      }),
      201,
    );
    assertEquals(replay.id, original.id);
    const mismatch = await startPresetRun(fixture, fixture, third, repository, {
      idempotencyKey: replayKey,
      extra: { budgetLimitUsd: "6.00" },
    });
    const mismatchText = await mismatch.clone().text();
    assertEquals(mismatch.status, 422, mismatchText);
    assertEquals((await mismatch.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    const runs = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.workflow_runs
        where organization_id = $1 and task_id = $2`,
      [fixture.organizationId, third.id],
    );
    assertEquals(runs.rows[0].count, "1");

    // A second organization materializes its own rows and stays isolated.
    const other = await createWorkerScope(fixture, "preset-other", fixture);
    try {
      const otherAgent = await seedFundedCodingAgent(fixture, other, "mat-b");
      const otherRepository = await seedPresetRepository(
        fixture.pgDatabase,
        other,
        { agentVersionId: otherAgent },
      );
      const otherTask = await createPresetTask(fixture, other, otherRepository);
      const otherRun = await expectJson<RunBody>(
        await startPresetRun(fixture, other, otherTask, otherRepository),
        201,
      );
      assertNotEquals(otherRun.workflowVersionId, runA.workflowVersionId);
      const isolated = await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.workflow_versions
          where organization_id = $1 and id = $2`,
        [other.organizationId, runA.workflowVersionId],
      );
      assertEquals(isolated.rows[0].count, "0");
    } finally {
      await closeWorkerScope(fixture, other);
    }
  }));

Deno.test("a tampered stored preset digest is rejected before any run exists", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "tamper");
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const seeded = await createPresetTask(fixture, fixture, repository);
    await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, seeded, repository),
      201,
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_versions set digest = $2
        where organization_id = $1`,
      [fixture.organizationId, "f".repeat(64)],
    );
    const task = await createPresetTask(fixture, fixture, repository, {
      title: "After tamper",
    });
    const response = await startPresetRun(fixture, fixture, task, repository);
    const text = await response.clone().text();
    assertEquals(response.status, 409, text);
    const problem = await response.json();
    assertEquals(problem.code, "STATE_CONFLICT");
    const runs = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.workflow_runs
        where organization_id = $1 and task_id = $2`,
      [fixture.organizationId, task.id],
    );
    assertEquals(runs.rows[0].count, "0");
  }));

Deno.test("run inputs equal the task row and oversized job input is rejected before run creation", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "inputs");
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });

    const worst = "x".repeat(20_000);
    const full = await createPresetTask(fixture, fixture, repository, {
      title: "Worst case",
      description: worst,
      taskType: "bug",
    });
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, full, repository),
      201,
    );
    const stored = await fixture.pgDatabase.query<{ inputs: unknown }>(
      `select snapshot->'inputs' as inputs from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, run.id],
    );
    assertEquals(stored.rows[0].inputs, {
      brief: { title: "Worst case", description: worst, taskType: "bug" },
      instructions: renderImplementInstructions({
        title: "Worst case",
        description: worst,
      }),
    });

    // 20000 control characters escape to about 120000 bytes of job input.
    const hostile = await createPresetTask(fixture, fixture, repository, {
      title: "Control characters",
      description: "\u0001".repeat(20_000),
    });
    const before = await fixture.pgDatabase.query<{ runs: string }>(
      `select count(*)::text as runs from bakery.workflow_runs
        where organization_id = $1`,
      [fixture.organizationId],
    );
    const key = `oversized-${crypto.randomUUID()}`;
    const rejected = await startPresetRun(
      fixture,
      fixture,
      hostile,
      repository,
      {
        idempotencyKey: key,
      },
    );
    assertEquals(rejected.status, 422);
    const problem = await rejected.json();
    assertEquals(problem.code, "UNPROCESSABLE");
    assertEquals(JSON.stringify(problem).includes("inputs_too_large"), true);
    const after = await fixture.pgDatabase.query<{ runs: string }>(
      `select count(*)::text as runs from bakery.workflow_runs
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(after.rows[0].runs, before.rows[0].runs);
    const task = await fixture.pgDatabase.query<{
      status: string;
      current_run_id: string | null;
    }>(
      `select status, current_run_id from bakery.tasks
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, hostile.id],
    );
    assertEquals(task.rows[0], { status: "draft", current_run_id: null });
    const receipt = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.idempotency_records
        where organization_id = $1 and operation = 'runs.create' and key = $2`,
      [fixture.organizationId, key],
    );
    assertEquals(receipt.rows[0].count, "0");

    // 4000 plain characters then 15320 control characters: the brief escapes
    // to 95981 bytes and the bounded instructions add 4015, so the run inputs
    // reach 100002 bytes. The instructions are part of the frozen inputs now,
    // so the inputs bound rejects before the resolved job input check can.
    const edge = await createPresetTask(fixture, fixture, repository, {
      title: "A",
      description: "x".repeat(4_000) + "\u0001".repeat(15_320),
    });
    const edgeBefore = await fixture.pgDatabase.query<{ runs: string }>(
      `select count(*)::text as runs from bakery.workflow_runs
        where organization_id = $1`,
      [fixture.organizationId],
    );
    const edgeRejected = await startPresetRun(
      fixture,
      fixture,
      edge,
      repository,
    );
    assertEquals(edgeRejected.status, 422);
    const edgeProblem = await edgeRejected.json();
    assertEquals(edgeProblem.code, "UNPROCESSABLE");
    assertEquals(
      JSON.stringify(edgeProblem).includes("inputs_too_large"),
      true,
    );
    const edgeAfter = await fixture.pgDatabase.query<{ runs: string }>(
      `select count(*)::text as runs from bakery.workflow_runs
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(edgeAfter.rows[0].runs, edgeBefore.rows[0].runs);
  }));

Deno.test("a resolved job input over the transport bound is rejected though the run inputs fit", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "resolved");
    // A maximal active profile (32 branch patterns of about 250 bytes) rides
    // into every job input as server context. It is not part of the run
    // inputs, so only the resolved-input check sees it.
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
      profileExtra: {
        branches: {
          base: "main",
          allowedPatterns: Array.from(
            { length: 32 },
            (_, index) => `feature/${index}-${"p".repeat(240)}`,
          ),
        },
      },
    });
    // 4000 plain characters keep the bounded instructions near 4 KB; 14800
    // control characters escape to 88800 bytes. The run inputs reach about
    // 97 KB and fit the 100000-byte bound. The brief job input adds the
    // 8 KB profile instead of the instructions and passes 100000.
    const task = await createPresetTask(fixture, fixture, repository, {
      title: "A",
      description: "x".repeat(4_000) + "\u0001".repeat(14_800),
    });
    const before = await fixture.pgDatabase.query<{ runs: string }>(
      `select count(*)::text as runs from bakery.workflow_runs
        where organization_id = $1`,
      [fixture.organizationId],
    );
    const rejected = await startPresetRun(fixture, fixture, task, repository);
    assertEquals(rejected.status, 422);
    const problem = await rejected.json();
    assertEquals(problem.code, "UNPROCESSABLE");
    const text = JSON.stringify(problem);
    assertEquals(text.includes("inputs_too_large"), true);
    assertEquals(text.includes("description"), true);
    const after = await fixture.pgDatabase.query<{ runs: string }>(
      `select count(*)::text as runs from bakery.workflow_runs
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(after.rows[0].runs, before.rows[0].runs);

    // Control: the same brief against a default profile fits, so the profile
    // alone tipped the resolved input over the bound.
    const plain = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const control = await createPresetTask(fixture, fixture, plain, {
      title: "A",
      description: "x".repeat(4_000) + "\u0001".repeat(14_800),
    });
    await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, control, plain),
      201,
    );
  }));

Deno.test("multi-byte descriptions at the character limit are admitted with inputs equal to the task row", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "multibyte");
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    for (
      const [label, description] of [
        ["emoji", "\u{1F600}".repeat(10_000)],
        ["euro", "\u20AC".repeat(20_000)],
      ] as const
    ) {
      const task = await createPresetTask(fixture, fixture, repository, {
        title: `Multibyte ${label}`,
        description,
        taskType: "bug",
      });
      const run = await expectJson<RunBody>(
        await startPresetRun(fixture, fixture, task, repository),
        201,
      );
      const stored = await fixture.pgDatabase.query<{ inputs: unknown }>(
        `select snapshot->'inputs' as inputs from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, run.id],
      );
      const row = await fixture.pgDatabase.query<{
        title: string;
        description: string;
        task_type: string;
      }>(
        `select title, description, task_type from bakery.tasks
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, task.id],
      );
      assertEquals(stored.rows[0].inputs, {
        brief: {
          title: row.rows[0].title,
          description: row.rows[0].description,
          taskType: row.rows[0].task_type,
        },
        instructions: renderImplementInstructions({
          title: row.rows[0].title,
          description: row.rows[0].description,
        }),
      });
      assertEquals(row.rows[0].description, description);
    }
  }));

Deno.test("an emoji-heavy brief materializes an implement job with well-formed, bounded, marked instructions", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "emojiinst");
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const task = await createPresetTask(fixture, fixture, repository, {
      title: "Multibyte emoji",
      description: "\u{1F600}".repeat(10_000),
      taskType: "bug",
    });
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, task, repository),
      201,
    );
    const admitted = await admitPresetRun(fixture.pgDatabase, fixture, run);
    const job = await fixture.pgDatabase.query<{ instructions: string | null }>(
      `select input->>'instructions' as instructions from bakery.jobs
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, admitted.implementJobId],
    );
    assertEquals(job.rows.length, 1);
    const instructions = job.rows[0].instructions;
    assert(instructions !== null, "the job row stores instructions");
    assert(instructions.startsWith("Task: Multibyte emoji\n\n"));
    assertEquals(instructions.isWellFormed(), true);
    assert(instructions.length <= 4_000, `length ${instructions.length}`);
    assert(instructions.endsWith("\n[truncated]"));
  }));

Deno.test("inputs with a preset are unprocessable and malformed preset selectors are malformed", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "reject");
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const task = await createPresetTask(fixture, fixture, repository);
    const withInputs = await startPresetRun(
      fixture,
      fixture,
      task,
      repository,
      {
        extra: { inputs: { brief: "client supplied" } },
      },
    );
    assertEquals(withInputs.status, 422);
    assertEquals(
      JSON.stringify(await withInputs.json()).includes(
        "inputs_not_allowed_with_preset",
      ),
      true,
    );
    const both = await startPresetRun(fixture, fixture, task, repository, {
      extra: { workflowVersionId: crypto.randomUUID() },
    });
    assertEquals(both.status, 400);
    assertEquals((await both.json()).code, "MALFORMED_REQUEST");
    const neither = await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/tasks/${task.id}/runs`,
      {
        body: {
          executionMode: "repository",
          repositoryProfileId: repository.profileId,
        },
      },
    );
    assertEquals(neither.status, 400);
    assertEquals((await neither.json()).code, "MALFORMED_REQUEST");
    const untouched = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.tasks where organization_id = $1 and id = $2`,
      [fixture.organizationId, task.id],
    );
    assertEquals(untouched.rows[0].status, "draft");
  }));

const fixedPolicyDraft = (allowedEffects: readonly string[]) => ({
  schemaVersion: 1,
  commands: [{ id: "format.guide", argv: ["pnpm", "fmt"] }],
  allowedEffects,
  lockedConfiguration: { branches: true, worktree: true, checker: true },
  decisions: [{ commandId: "format.guide", mode: "guide" }],
});

Deno.test("availability names every failing admission rule from its real cause", () =>
  withFixture(async (fixture) => {
    const list = await expectJson<PresetsPage>(
      await apiCall(fixture, fixture, "GET", "/v1/workflow-presets"),
      200,
    );
    assertEquals(list.items.map((item) => item.id), [
      "fixed-coding",
      "fixed-coding-reviewed",
    ]);
    assertEquals(list.items.map((item) => item.availability), [null, null]);
    assertEquals(list.items[0].digest, FIXED_CODING_PRESET.digest);
    assertEquals(list.items[1].digest, FIXED_CODING_REVIEWED_PRESET.digest);
    assertEquals(list.nextCursor, null);
    assert(contractSchemas["Page<WorkflowPreset>"].safeParse(list).success);

    const suffix = crypto.randomUUID().slice(0, 8);
    const reasonsFor = async (
      options: Parameters<typeof seedPresetRepository>[2],
    ) => {
      const repository = await seedPresetRepository(
        fixture.pgDatabase,
        fixture,
        options,
      );
      return (await availability(fixture, fixture, repository.repositoryId))
        .reasons;
    };
    const funded = (
      label: string,
      extra: { max?: number; priced?: boolean } = {},
    ) =>
      seedFundedCodingAgent(fixture, fixture, `${label}-${suffix}`, {
        maxUsdReservation: extra.max,
        priced: extra.priced,
      });

    const ready = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: await funded("ready"),
    });
    assertEquals(await availability(fixture, fixture, ready.repositoryId), {
      status: "ready",
      reasons: [],
      minimumBudgetLimitUsd: "1",
    });

    assertEquals(await reasonsFor({ noActiveProfile: true }), [
      "no_active_profile",
    ]);
    assertEquals(
      await reasonsFor({
        agentVersionId: await funded("archived"),
        repositoryArchived: true,
      }),
      ["repository_archived"],
    );
    assertEquals(
      await reasonsFor({
        agentVersionId: await funded("app"),
        applicationArchived: true,
      }),
      ["application_archived"],
    );
    assertEquals(await reasonsFor({}), ["coding_agent_unbound"]);

    const disabled = await funded("disabled");
    await fixture.pgDatabase.query(
      `update bakery.agent_definitions set enabled = false
        where organization_id = $1 and id = (
          select agent_id from bakery.agent_versions where id = $2
        )`,
      [fixture.organizationId, disabled],
    );
    assertEquals(await reasonsFor({ agentVersionId: disabled }), [
      "coding_agent_disabled",
    ]);

    // A pinned skill that is no longer published makes the agent version
    // unusable: the verdict is the same as a disabled agent, never a failed list.
    const skillSourceId = crypto.randomUUID();
    const skillId = crypto.randomUUID();
    // Skill versions are content-addressed UUIDv8 identifiers.
    const skillVersionId = crypto.randomUUID().replace(
      /^(.{14}).(.)(.{3})/,
      (_match, head, _variant, rest) => `${head}8${"a"}${rest}`,
    );
    await fixture.pgDatabase.query(
      `insert into bakery.skill_sources
         (id, organization_id, source_type, locator, display_name)
       values ($1, $2, 'local_bundle', $3, 'Availability source')`,
      [skillSourceId, fixture.organizationId, `local://${skillSourceId}`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.skills (id, organization_id, source_id, slug, name)
       values ($1, $2, $3, $4, 'Availability skill')`,
      [skillId, fixture.organizationId, skillSourceId, `skill-${suffix}`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.skill_versions
         (id, organization_id, skill_id, revision, source_revision, digest,
          entry_path, manifest, status, created_by)
       values ($1, $2, $3, 1, 'availability', $4, 'SKILL.md', '{}'::jsonb,
               'published', $5)`,
      [
        skillVersionId,
        fixture.organizationId,
        skillId,
        "c".repeat(64),
        fixture.principalId,
      ],
    );
    const skillBilling = presetBilling(`skill-${suffix}`);
    await seedProviderPricingSnapshot(fixture.pgDatabase, {
      billing: skillBilling,
    });
    const skilled = await createCodingAgent(
      fixture,
      fixture,
      `skill-${suffix}`,
      {
        harness: "codex",
        billing: skillBilling,
        skillBindings: { main: skillVersionId },
      },
    );
    const skilledRepository = await seedPresetRepository(
      fixture.pgDatabase,
      fixture,
      { agentVersionId: skilled },
    );
    assertEquals(
      await availability(fixture, fixture, skilledRepository.repositoryId),
      { status: "ready", reasons: [], minimumBudgetLimitUsd: "1" },
    );
    await fixture.pgDatabase.query(
      "update bakery.skill_versions set status = 'draft' where id = $1",
      [skillVersionId],
    );
    assertEquals(
      await availability(fixture, fixture, skilledRepository.repositoryId),
      {
        status: "setup_required",
        reasons: ["coding_agent_disabled"],
        minimumBudgetLimitUsd: null,
      },
    );

    const unbilled = await createCodingAgent(
      fixture,
      fixture,
      `unbilled-${suffix}`,
      { harness: "codex" },
    );
    assertEquals(await reasonsFor({ agentVersionId: unbilled }), [
      "coding_agent_unbilled",
    ]);

    const denied = presetBilling(`denied-${suffix}`);
    await seedFundedCodingAgent(fixture, fixture, `unused-${suffix}`);
    const deniedAgent = await createCodingAgent(
      fixture,
      fixture,
      `denied-${suffix}`,
      { harness: "codex", billing: denied, allowedCapabilities: ["git"] },
    );
    assertEquals(await reasonsFor({ agentVersionId: deniedAgent }), [
      "coding_agent_capability_denied",
    ]);

    assertEquals(
      await reasonsFor({
        agentVersionId: await funded("unpriced", { priced: false }),
      }),
      ["coding_agent_unpriced"],
    );
    assertEquals(
      await reasonsFor({
        agentVersionId: await funded("effects"),
        profileExtra: { fixedPolicy: fixedPolicyDraft(["evidence_only"]) },
      }),
      ["profile_effect_denied"],
    );
    assertEquals(
      await reasonsFor({
        agentVersionId: await funded("small", { max: 6 }),
      }),
      ["budget_below_reservation"],
    );
    // The minimum is the coding step's reservation, null without a priced agent.
    const smallRepository = await seedPresetRepository(
      fixture.pgDatabase,
      fixture,
      { agentVersionId: await funded("minimum", { max: 6 }) },
    );
    assertEquals(
      (await availability(fixture, fixture, smallRepository.repositoryId))
        .minimumBudgetLimitUsd,
      "6",
    );
    const unboundRepository = await seedPresetRepository(
      fixture.pgDatabase,
      fixture,
      {},
    );
    assertEquals(
      (await availability(fixture, fixture, unboundRepository.repositoryId))
        .minimumBudgetLimitUsd,
      null,
    );
    const permitted = await reasonsFor({
      agentVersionId: await funded("permitted"),
      profileExtra: {
        fixedPolicy: fixedPolicyDraft(["artifact_only", "repository_revision"]),
      },
    });
    assertEquals(permitted, []);
  }));

Deno.test("availability reports an unconfigured server budget policy", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `nopolicy-${crypto.randomUUID().slice(0, 8)}`,
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    assertEquals(
      await availability(fixture, fixture, repository.repositoryId),
      {
        status: "setup_required",
        reasons: ["budget_policy_unavailable"],
        minimumBudgetLimitUsd: "1",
      },
    );
  }, false));

Deno.test("a ready verdict admits the implement job with exactly one server-created session that claims and replays", () =>
  withFixture(async (fixture) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `claim-${suffix}`,
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    assertEquals(
      await availability(fixture, fixture, repository.repositoryId),
      { status: "ready", reasons: [], minimumBudgetLimitUsd: "1" },
    );
    const task = await createPresetTask(fixture, fixture, repository);
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, task, repository),
      201,
    );
    const admitted = await admitPresetRun(fixture.pgDatabase, fixture, run);

    const sessions = await fixture.pgDatabase.query<{
      id: string;
      run_step_id: string;
      conversation_id: string;
      agent_version_id: string;
      harness: string;
      status: string;
    }>(
      `select id, run_step_id, conversation_id, agent_version_id, harness, status
         from bakery.agent_sessions
        where organization_id = $1 and run_step_id = any($2::uuid[])`,
      [fixture.organizationId, [
        admitted.briefStepId,
        admitted.implementStepId,
      ]],
    );
    assertEquals(sessions.rows.length, 1);
    const session = sessions.rows[0];
    assertEquals(session.run_step_id, admitted.implementStepId);
    assertEquals(session.conversation_id, task.conversationId);
    assertEquals(session.agent_version_id, agent);
    assertEquals(session.harness, "codex");
    assertEquals(session.status, "starting");

    const worker = await registeredWorker(fixture, {
      name: `preset-claim-${suffix}`,
      capabilities: workerFixtureCapabilities,
    });
    const claimKey = crypto.randomUUID();
    const claimBody = {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
      supportedActions: ["harness.implement"],
    };
    const first = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      claimBody,
      { idempotencyKey: claimKey },
    );
    assertEquals(first.status, 200);
    const assignment = await first.json() as Record<string, unknown>;
    assertEquals(assignment.jobId, admitted.implementJobId);
    assertEquals(assignment.action, "harness.implement");
    assertEquals(assignment.agentSessionId, session.id);
    assert(contractSchemas.JobAssignment.safeParse(assignment).success);
    // The implement step consumes the version its brief step completed with.
    assertEquals(
      (assignment.input as { planArtifact?: string }).planArtifact,
      admitted.briefVersionId,
    );
    // The approved-plan instructions come from the frozen snapshot inputs.
    assertEquals(
      (assignment.input as { instructions?: string }).instructions,
      renderImplementInstructions({
        title: "Add upload retry",
        description: "Retry failed uploads twice.",
      }),
    );
    // The session id is not part of the frozen job input.
    assertEquals(
      JSON.stringify(assignment.input).includes(session.id),
      false,
    );

    const replay = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      claimBody,
      { idempotencyKey: claimKey },
    );
    assertEquals(replay.status, 200);
    const replayed = await replay.json() as Record<string, unknown>;
    assertEquals(replayed.agentSessionId, session.id);
    assertEquals(replayed.attemptId, assignment.attemptId);

    // A second admission never creates a second session for the step.
    await admitPresetRun(fixture.pgDatabase, fixture, run).catch(() => {});
    const again = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.agent_sessions
        where organization_id = $1 and run_step_id = $2`,
      [fixture.organizationId, admitted.implementStepId],
    );
    assertEquals(again.rows[0].count, "1");
  }));

Deno.test("claim-time admission rejects implement instructions that drift from the snapshot by one character", () =>
  withFixture(async (fixture) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `drift-${suffix}`,
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const task = await createPresetTask(fixture, fixture, repository);
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, task, repository),
      201,
    );
    const admitted = await admitPresetRun(fixture.pgDatabase, fixture, run);
    const stored = await fixture.pgDatabase.query<
      { input: Record<string, unknown> }
    >(
      `select input from bakery.jobs where organization_id = $1 and id = $2`,
      [fixture.organizationId, admitted.implementJobId],
    );
    const input = stored.rows[0].input;
    assertEquals(typeof input.instructions, "string");
    const worker = await registeredWorker(fixture, {
      name: `preset-drift-${suffix}`,
      capabilities: workerFixtureCapabilities,
    });
    const claim = async () => {
      const claimKey = crypto.randomUUID();
      return await workerRequest(
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
    };
    const setInstructions = (value: string) =>
      fixture.pgDatabase.query(
        `update bakery.jobs set input = $3::jsonb
          where organization_id = $1 and id = $2`,
        [
          fixture.organizationId,
          admitted.implementJobId,
          JSON.stringify({ ...input, instructions: value }),
        ],
      );
    await setInstructions((input.instructions as string) + "!");
    const drifted = await claim();
    assertEquals(drifted.status, 204);
    await drifted.body?.cancel();
    const attempts = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.job_attempts
        where organization_id = $1 and job_id = $2`,
      [fixture.organizationId, admitted.implementJobId],
    );
    assertEquals(attempts.rows[0].count, "0");
    await setInstructions(input.instructions as string);
    const matched = await claim();
    assertEquals(matched.status, 200);
    await matched.body?.cancel();
  }));

Deno.test("an organization with a materialized revision 1 preset starts a revision 2 run", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "rev1");
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const legacySpec = structuredClone(FIXED_CODING_PRESET.spec) as unknown as {
      steps: Array<{ id: string; with: Record<string, string> }>;
    };
    delete legacySpec.steps.find((step) => step.id === "implement")!.with
      .instructions;
    const legacyDigest = await sha256Hex(canonicalJson(legacySpec));
    assertNotEquals(legacyDigest, FIXED_CODING_PRESET.digest);
    const definition = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.workflow_definitions (
         organization_id, slug, name, description, enabled
       ) values ($1, $2, 'fixed-coding', 'legacy revision 1', true)
       returning id`,
      [fixture.organizationId, FIXED_CODING_PRESET.slug],
    );
    const legacy = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.workflow_versions (
         organization_id, workflow_id, revision, source_yaml, normalized_spec,
         digest, status, created_by
       ) values ($1, $2, 1, 'kind: fixed', $3::jsonb, $4, 'published', $5)
       returning id`,
      [
        fixture.organizationId,
        definition.rows[0].id,
        canonicalJson(legacySpec),
        legacyDigest,
        fixture.principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_definitions set active_version_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, definition.rows[0].id, legacy.rows[0].id],
    );
    const task = await createPresetTask(fixture, fixture, repository);
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, task, repository),
      201,
    );
    assertNotEquals(run.workflowVersionId, legacy.rows[0].id);
    const versions = await fixture.pgDatabase.query<
      { revision: number; digest: string }
    >(
      `select revision, digest from bakery.workflow_versions
        where organization_id = $1 and workflow_id = $2 order by revision`,
      [fixture.organizationId, definition.rows[0].id],
    );
    assertEquals(versions.rows, [
      { revision: 1, digest: legacyDigest },
      { revision: 2, digest: FIXED_CODING_PRESET.digest },
    ]);
  }));
Deno.test("runs.create refuses a budget below the coding reservation", () =>
  withFixture(async (fixture) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `floor-${suffix}`,
      { maxUsdReservation: 1.5 },
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const task = await createPresetTask(fixture, fixture, repository);
    const refused = await startPresetRun(fixture, fixture, task, repository, {
      extra: { budgetLimitUsd: "0.5" },
    });
    assertEquals(refused.status, 409);
    assertEquals(
      (await refused.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const runs = await fixture.pgDatabase.query(
      "select 1 from bakery.workflow_runs where organization_id = $1 and task_id = $2",
      [fixture.organizationId, task.id],
    );
    assertEquals(runs.rows.length, 0);
    const taskRow = await fixture.pgDatabase.query<{ status: string }>(
      "select status from bakery.tasks where organization_id = $1 and id = $2",
      [fixture.organizationId, task.id],
    );
    assertEquals(taskRow.rows[0]?.status, "draft");
    const accepted = await startPresetRun(fixture, fixture, task, repository, {
      extra: { budgetLimitUsd: "1.5" },
    });
    assertEquals(accepted.status, 201);
    await accepted.body?.cancel();
  }));

Deno.test("admission refused by the budget cap fails the run with that reason", () =>
  withFixture(async (fixture) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `cap-${suffix}`,
      { maxUsdReservation: 1.5 },
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const task = await createPresetTask(fixture, fixture, repository);
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, task, repository, {
        extra: { budgetLimitUsd: "1.5" },
      }),
      201,
    );
    const engine = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 1,
      budgetPolicy: presetBudgetPolicy,
    });
    const owner = await engine.acquireEngineOwner(
      run.id,
      crypto.randomUUID(),
      60_000,
    );
    assert(owner);
    const key = (stepKey: string) => ({
      runId: run.id,
      stepKey,
      iteration: 0,
      actionVersion: run.workflowVersionId,
    });
    const steps = await fixture.pgDatabase.query<
      { id: string; step_key: string }
    >(
      `select id, step_key from bakery.run_steps
        where organization_id = $1 and run_id = $2`,
      [fixture.organizationId, run.id],
    );
    const stepId = (stepKey: string) =>
      steps.rows.find((step) => step.step_key === stepKey)!.id;
    assert((await engine.admit(key("brief"), owner)).jobId);
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set status = 'completed', output = $3::jsonb, finished_at = now()
        where organization_id = $1 and id = $2`,
      [
        fixture.organizationId,
        stepId("brief"),
        JSON.stringify({
          artifact: {
            artifactId: crypto.randomUUID(),
            versionId: crypto.randomUUID(),
            sha256: "d".repeat(64),
          },
        }),
      ],
    );
    // Simulates a run admitted before the creation guard, or one whose
    // cumulative spend left less than the reservation.
    await fixture.pgDatabase.query(
      "update bakery.workflow_runs set budget_limit_usd = '0.5' where organization_id = $1 and id = $2",
      [fixture.organizationId, run.id],
    );
    const refused = await engine.admit(key("implement"), owner);
    assertEquals(refused.terminal, true);

    const state = await fixture.pgDatabase.query<
      { run: string; task: string; step: string; error: unknown }
    >(
      `select run.status as run, task.status as task, step.status as step,
              step.error
         from bakery.run_steps step
         join bakery.workflow_runs run on run.id = step.run_id
         join bakery.tasks task on task.id = run.task_id
        where step.id = $1`,
      [stepId("implement")],
    );
    assertEquals(state.rows[0]?.run, "failed");
    assertEquals(state.rows[0]?.task, "failed");
    assertEquals(state.rows[0]?.step, "failed");
    assertEquals(
      (state.rows[0]?.error as { code?: string }).code,
      "BUDGET_CAP_EXCEEDED",
    );
    const jobs = await fixture.pgDatabase.query(
      "select 1 from bakery.jobs where organization_id = $1 and run_step_id = $2",
      [fixture.organizationId, stepId("implement")],
    );
    assertEquals(jobs.rows.length, 0);
    const holds = await fixture.pgDatabase.query<{ count: string }>(
      `select (
         (select count(*) from bakery.budget_action_intents
           where organization_id = $1 and run_step_id = $2) +
         (select count(*) from bakery.budget_reservations
           where organization_id = $1 and run_step_id = $2)
       )::text as count`,
      [fixture.organizationId, stepId("implement")],
    );
    assertEquals(holds.rows[0]?.count, "0");
    // A second pass is terminal and never throws the budget conflict again.
    const again = await engine.admit(key("implement"), owner).then(
      (admission) => admission.terminal ? "terminal" : "admitted",
      (error: unknown) =>
        error instanceof StandardError ? error.code : "owner-lost",
    );
    assert(again === "terminal" || again === "owner-lost", again);
  }));

Deno.test("a budget replay mismatch is still thrown and leaves the run running", () =>
  withFixture(async (fixture) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await seedFundedCodingAgent(
      fixture,
      fixture,
      `replay-${suffix}`,
      { maxUsdReservation: 1.5 },
    );
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      agentVersionId: agent,
    });
    const task = await createPresetTask(fixture, fixture, repository);
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, task, repository, {
        extra: { budgetLimitUsd: "1.5" },
      }),
      201,
    );
    const admitted = await admitPresetRun(fixture.pgDatabase, fixture, run);
    // Drop the job so engine admission replays the already held reservation
    // with a different content digest.
    await fixture.pgDatabase.query(
      "update bakery.budget_action_intents set content_digest = $3 where organization_id = $1 and run_step_id = $2",
      [fixture.organizationId, admitted.implementStepId, "f".repeat(64)],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.jobs where organization_id = $1 and id = $2",
      [fixture.organizationId, admitted.implementJobId],
    );
    await fixture.pgDatabase.query(
      "update bakery.run_steps set status = 'pending' where organization_id = $1 and id = $2",
      [fixture.organizationId, admitted.implementStepId],
    );
    const engine = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 1,
      budgetPolicy: presetBudgetPolicy,
    });
    const owner = await engine.acquireEngineOwner(
      run.id,
      crypto.randomUUID(),
      60_000,
    );
    assert(owner);
    const error = await engine.admit({
      runId: run.id,
      stepKey: "implement",
      iteration: 0,
      actionVersion: run.workflowVersionId,
    }, owner).then(() => undefined, (cause: unknown) => cause);
    assert(error instanceof StandardError);
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(
      (error.params as { reason?: string }).reason,
      "budget_replay_content_mismatch",
    );
    const status = await fixture.pgDatabase.query<{ status: string }>(
      "select status from bakery.workflow_runs where id = $1",
      [run.id],
    );
    assertEquals(status.rows[0]?.status, "running");
  }));
