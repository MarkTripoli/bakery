import { assert, assertEquals } from "@std/assert";
import { apiCall, expectJson } from "../helpers/fixed-coding-preset.ts";
import { deriveReviewPins } from "../../apps/server/src/modules/delivery/review-pins.ts";
import {
  loopFixtureCloseStep,
  loopTest,
  shareLoopFixture,
  withReviewedRun,
} from "../helpers/review-repair/loop-world.ts";

shareLoopFixture();

type VersionRow = { workflow_id: string; workflow_version_id: string };

type Step = { repeat?: { max: number }; [key: string]: unknown };

function bounds(definition: { steps: Step[] }) {
  return definition.steps
    .filter((step) => step.repeat !== undefined)
    .map((step) => step.repeat!.max);
}

loopTest(
  "a workflow edit mid-run leaves the running task's review policy alone",
  async () => {
    await withReviewedRun(async (world) => {
      const steps = await world.steps();
      const reviewStep = steps.find((step) =>
        step.step_key.startsWith("review")
      );
      assert(reviewStep, "the run admitted its review step");

      const inputBefore = await world.jobInput(reviewStep.id);
      const dispatchBefore = await world.dispatchInput(reviewStep.step_key);
      const pinsBefore = await deriveReviewPins(inputBefore);

      const run = await world.fixture.pgDatabase.query<VersionRow>(
        `select r.workflow_version_id, v.workflow_id
           from bakery.workflow_runs r
           join bakery.workflow_versions v
             on v.organization_id = r.organization_id
            and v.id = r.workflow_version_id
          where r.organization_id = $1 and r.id = $2`,
        [world.fixture.organizationId, world.runId],
      );
      const pinned = run.rows[0];
      assert(pinned, "the run names the version it was admitted on");

      const version = await expectJson<{
        normalizedSpec: { steps: Step[] };
      }>(
        await apiCall(
          world.fixture,
          world.fixture,
          "GET",
          `/v1/workflows/${pinned.workflow_id}/versions/${pinned.workflow_version_id}`,
        ),
        200,
      );
      const edited = structuredClone(version.normalizedSpec);
      const original = bounds(edited);
      assert(original.length > 0, "the plan bounds its review loop");
      edited.steps
        .filter((step) => step.repeat !== undefined)
        .forEach((step) => {
          step.repeat!.max = 1;
        });
      assertEquals(bounds(edited), original.map(() => 1));

      const draft = await expectJson<{ id: string }>(
        await apiCall(
          world.fixture,
          world.fixture,
          "POST",
          `/v1/workflows/${pinned.workflow_id}/versions`,
          { body: { definition: edited } },
        ),
        201,
      );
      await expectJson(
        await apiCall(
          world.fixture,
          world.fixture,
          "POST",
          `/v1/workflows/${pinned.workflow_id}/versions/${draft.id}/publish`,
          { body: {}, headers: { "If-Match": '"1"' } },
        ),
        200,
      );

      const after = await world.fixture.pgDatabase.query<VersionRow>(
        `select r.workflow_version_id, v.workflow_id
           from bakery.workflow_runs r
           join bakery.workflow_versions v
             on v.organization_id = r.organization_id
            and v.id = r.workflow_version_id
          where r.organization_id = $1 and r.id = $2`,
        [world.fixture.organizationId, world.runId],
      );
      assertEquals(after.rows[0], pinned);
      assertEquals(await world.jobInput(reviewStep.id), inputBefore);
      assertEquals(
        await world.dispatchInput(reviewStep.step_key),
        dispatchBefore,
      );

      const turn = await world.review(0);
      assertEquals(turn.pins.policyDigest, pinsBefore.policyDigest);
      const posted = await turn.post(turn.report([]));
      assertEquals(posted.status, 200, await posted.clone().text());
      assertEquals(
        (await world.cycles()).map((cycle) => cycle.policy_digest),
        [pinsBefore.policyDigest],
      );
    });
  },
);

loopFixtureCloseStep("a workflow edit mid-run");
