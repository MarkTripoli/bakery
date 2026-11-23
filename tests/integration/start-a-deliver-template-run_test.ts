import { assert, assertEquals } from "@std/assert";
import { WORKFLOW_PRESETS } from "../../packages/contracts/src/workflow-presets.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  seedFundedCodingAgent,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { onboardObserved } from "../helpers/review-repair/preset-integration-cases.ts";

// #429: the Deliver templates are built-in workflows. The preset read carries
// their whole definition and says whether the composer can start them; a run of
// one takes its plan sign-off switch (gates) from the request, pausing for the
// plan by default, and no other run accepts it.

type PresetsPage = {
  items: Array<{
    id: string;
    digest: string;
    definition: { name?: string; inputs?: Record<string, unknown> };
    startableFromComposer: boolean;
  }>;
};

const withFixture = <T>(work: Parameters<typeof withWorkerFixture<T>>[0]) =>
  withWorkerFixture(work, { env: presetBudgetEnv });

const MODEL_ACTIONS = [
  "harness.implement",
  "harness.repair",
  "review.independent",
  "agent.freeform",
] as const;

Deno.test("the preset read lists the Deliver templates after the coding presets, each with its whole definition (#429)", () =>
  withFixture(async (fixture) => {
    const page = await expectJson<PresetsPage>(
      await apiCall(fixture, fixture, "GET", "/v1/workflow-presets"),
      200,
    );
    assertEquals(page.items.map((item) => item.id), [
      "fixed-coding",
      "fixed-coding-reviewed",
      "deliver-oneshot",
      "deliver-lean",
      "deliver-full",
      "deliver-prd",
    ]);
    for (const item of page.items) {
      const preset = WORKFLOW_PRESETS.find((p) => p.id === item.id)!;
      assertEquals(item.digest, preset.digest);
      assertEquals(item.definition, JSON.parse(JSON.stringify(preset.spec)));
      assert(item.startableFromComposer, item.id);
    }
    const deliver = page.items.filter((item) => item.id.startsWith("deliver-"));
    for (const item of deliver) {
      assertEquals(item.definition.name, item.id);
      assert(Object.hasOwn(item.definition.inputs ?? {}, "gates"), item.id);
    }
  }));

Deno.test("a Deliver run takes gates from the request and defaults to the plan sign-off; other runs refuse it (#429)", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "gates");
    // A repository onboarded through the real inspection route, so its active
    // profile has the observed fixed policy the check and review steps need, with
    // one funded agent bound to each model action.
    const repository = await onboardObserved(
      fixture,
      Object.fromEntries(MODEL_ACTIONS.map((action) => [action, agent])),
    );
    const gatesOf = async (runId: string) =>
      (await fixture.pgDatabase.query<{ gates: unknown }>(
        `select snapshot -> 'inputs' -> 'gates' as gates
           from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, runId],
      )).rows[0].gates;
    const start = async (extra: Record<string, unknown>, title: string) => {
      const task = await createPresetTask(fixture, fixture, repository, {
        title,
      });
      return await startPresetRun(fixture, fixture, task, repository, {
        extra,
      });
    };

    const byDefault = await expectJson<{ id: string }>(
      await start({ presetId: "deliver-oneshot" }, "default gates"),
      201,
    );
    assertEquals(await gatesOf(byDefault.id), "plan");
    const ungated = await expectJson<{ id: string }>(
      await start({ presetId: "deliver-oneshot", gates: "none" }, "no gates"),
      201,
    );
    assertEquals(await gatesOf(ungated.id), "none");
    const gated = await expectJson<{ id: string }>(
      await start({ presetId: "deliver-lean", gates: "plan" }, "plan gates"),
      201,
    );
    assertEquals(await gatesOf(gated.id), "plan");

    // A preset that declares no gates input refuses the field, and so does a run
    // of a workflow version.
    const fixedCoding = await start(
      { presetId: "fixed-coding", gates: "plan" },
      "fixed coding gates",
    );
    assertEquals(fixedCoding.status, 422);
    assert((await fixedCoding.text()).includes("gates_not_accepted"));
    // A value that is not plan or none is malformed.
    const malformed = await start(
      { presetId: "deliver-oneshot", gates: "maybe" },
      "bad gates",
    );
    assert(malformed.status >= 400 && malformed.status < 500);
    await malformed.body?.cancel();
  }));
