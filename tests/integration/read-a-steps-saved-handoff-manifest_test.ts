/**
 * #72: the run step read says whether a step has a saved handoff manifest, so
 * the UI can show it. The step carries the newest manifest's id, status and
 * save time, null before one is saved, and another organization reads neither
 * the run's steps nor the manifest.
 */

import { assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
} from "../helpers/worker-execution.ts";
import {
  body,
  type Json,
  liveAttempt,
  manifestFor,
  person,
  post,
} from "../helpers/handoff-manifests.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";

async function stepOf(
  response: Response,
  runStepId: string,
): Promise<Json> {
  assertEquals(response.status, 200, await response.clone().text());
  const page = await response.json() as { items: unknown[] };
  const step = page.items
    .map((item) => contractSchemas.RunStep.parse(item))
    .find((item) => item.id === runStepId);
  if (!step) throw new Error(`step ${runStepId} is not on the page`);
  return step as unknown as Json;
}

Deno.test("a step shows no manifest before one is saved, then the saved one", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-step-read");
    const stepsPath = `/v1/runs/${live.job.runId}/steps`;

    const before = await stepOf(
      await person(fixture, stepsPath),
      live.job.runStepId,
    );
    assertEquals(before.handoffManifest, null);

    const created = await post(
      fixture,
      live,
      await manifestFor(fixture, live.job),
    );
    assertEquals(created.status, 201, await created.clone().text());
    const record = await body(created);

    const after = await stepOf(
      await person(fixture, stepsPath),
      live.job.runStepId,
    );
    assertEquals(after.handoffManifest, {
      id: record.id,
      status: "pending",
      savedAt: record.createdAt,
    });
  }));

Deno.test("another organization reads neither the step nor its manifest", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-step-foreign");
    const created = await post(
      fixture,
      live,
      await manifestFor(fixture, live.job),
    );
    assertEquals(created.status, 201, await created.clone().text());
    const record = await body(created);
    const foreign = await createWorkerScope(fixture, "handoff-72", fixture);
    try {
      const steps = await person(
        fixture,
        `/v1/runs/${live.job.runId}/steps`,
        foreign,
      );
      assertEquals(steps.status, 404);
      await steps.body?.cancel();
      const manifest = await person(
        fixture,
        "/v1/handoff-manifests/" + record.id,
        foreign,
      );
      assertEquals(manifest.status, 404);
      await manifest.body?.cancel();
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));
