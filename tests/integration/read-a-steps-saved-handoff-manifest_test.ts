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

Deno.test("a step shows its newest manifest, and a save-time tie goes to the higher id", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-step-newest");
    const created = await post(
      fixture,
      live,
      await manifestFor(fixture, live.job),
    );
    assertEquals(created.status, 201, await created.clone().text());
    const saved = await body(created);
    const db = fixture.pgDatabase;

    // Three earlier attempts of the same job, each with its own attempt number
    // and fence, so every manifest below has its own source attempt and the
    // one-manifest-per-attempt constraint holds.
    const attemptOf = async (offset: number) => {
      const inserted = await db.query<{ id: string }>(
        `insert into bakery.job_attempts
           (organization_id, job_id, worker_host_id, worker_session_id,
            worker_session_generation, attempt_no, fence, lease_token_hash,
            lease_expires_at, status, ended_at)
         select organization_id, job_id, worker_host_id, worker_session_id,
                worker_session_generation, attempt_no + $2, fence + $2,
                lease_token_hash, lease_expires_at, 'expired', now()
           from bakery.job_attempts where id = $1
         returning id`,
        [live.assignment.attemptId, offset],
      );
      return inserted.rows[0].id;
    };
    // A manifest of another attempt of the step, saved `minutes` from the
    // route's one, with a chosen id and status.
    const manifestOf = (
      id: string,
      attemptId: string,
      minutes: number,
      status: string,
    ) =>
      db.query(
        `insert into bakery.handoff_manifests
           (id, organization_id, task_id, run_id, run_step_id, source_attempt_id,
            source_fence, mode, digest, request_digest, safe_boundary, status,
            manifest, created_at)
         select $1::uuid, organization_id, task_id, run_id, run_step_id, $2::uuid,
                source_fence, mode, digest, request_digest, safe_boundary, $3,
                manifest, created_at + make_interval(mins => $4::integer)
           from bakery.handoff_manifests where id = $5`,
        [id, attemptId, status, minutes, saved.id],
      );
    const older = "00000000-0000-4000-8000-0000000000a1";
    const lowerTie = "11111111-1111-4111-8111-111111111111";
    const higherTie = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await manifestOf(older, await attemptOf(100), -1, "blocked");
    await manifestOf(lowerTie, await attemptOf(200), 1, "continued");
    await manifestOf(higherTie, await attemptOf(300), 1, "blocked");

    const shown = async () =>
      (await stepOf(
        await person(fixture, `/v1/runs/${live.job.runId}/steps`),
        live.job.runStepId,
      )).handoffManifest as Json;
    const at = (minutes: number) =>
      new Date(Date.parse(String(saved.createdAt)) + minutes * 60_000)
        .toISOString();

    // Two saved at the same instant, newest of all: the higher id wins.
    assertEquals(await shown(), {
      id: higherTie,
      status: "blocked",
      savedAt: at(1),
    });
    await db.query("delete from bakery.handoff_manifests where id = $1", [
      higherTie,
    ]);
    assertEquals(await shown(), {
      id: lowerTie,
      status: "continued",
      savedAt: at(1),
    });
    await db.query("delete from bakery.handoff_manifests where id = $1", [
      lowerTie,
    ]);
    // The older one is never shown while a newer one exists.
    assertEquals(await shown(), {
      id: saved.id,
      status: "pending",
      savedAt: saved.createdAt,
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
