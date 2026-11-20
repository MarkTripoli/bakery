/**
 * #33 slice 2: handoffManifests.continue through the real route and a real
 * database. One live source attempt stored a manifest; the person retires it and
 * the job is claimable again. What only the database proves: one winner however
 * many submissions race, the old fence cannot publish, the job's pinned input is
 * untouched, every refusal commits nothing, and nothing crosses an organization.
 */

import { assert, assertEquals } from "@std/assert";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import {
  body,
  type Json,
  liveAttempt,
  manifestFor,
  post,
} from "../helpers/handoff-manifests.ts";

type Live = Awaited<ReturnType<typeof liveAttempt>>;

async function runVersion(fixture: WorkerFixture, runId: string) {
  const result = await fixture.pgDatabase.query<{ version: number }>(
    "select version from bakery.workflow_runs where id = $1",
    [runId],
  );
  return result.rows[0].version;
}

function continueManifest(
  fixture: WorkerFixture,
  manifestId: string,
  version: number,
  organizationId?: string,
) {
  return fixture.app.fetch(
    new Request(
      fixture.config.publicBaseUrl +
        "/v1/handoff-manifests/" + manifestId + "/continuations",
      {
        method: "POST",
        headers: {
          cookie: fixture.adminCookie,
          "bakery-organization-id": organizationId ?? fixture.organizationId,
          origin: fixture.config.publicBaseUrl,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ runVersion: version }),
      },
    ),
  );
}

async function stored(
  fixture: WorkerFixture,
  live: Live,
  overrides: Json = {},
) {
  const response = await post(
    fixture,
    live,
    await manifestFor(fixture, live.job, overrides),
  );
  assertEquals(response.status, 201, await response.clone().text());
  return await body(response);
}

async function state(fixture: WorkerFixture, live: Live) {
  const attempt = await fixture.pgDatabase.query<{ status: string }>(
    "select status from bakery.job_attempts where id = $1",
    [live.assignment.attemptId],
  );
  const job = await fixture.pgDatabase.query<
    {
      status: string;
      current_fence: string;
      input: unknown;
      agent_config: unknown;
      billing: unknown;
    }
  >(
    "select status, current_fence::text as current_fence, input, agent_config, billing from bakery.jobs where id = $1",
    [live.job.jobId],
  );
  return { attempt: attempt.rows[0].status, job: job.rows[0] };
}

Deno.test("a handoff fences the source, queues the job again on the same input, and a new attempt claims it", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "continue-happy");
    const record = await stored(fixture, live);
    const before = await state(fixture, live);
    assertEquals(before.attempt, "leased");
    const version = await runVersion(fixture, live.job.runId);

    const response = await continueManifest(
      fixture,
      String(record.id),
      version,
    );
    assert(
      response.status === 200 || response.status === 201,
      await response.clone().text(),
    );
    const continuation = await body(response);
    assertEquals(continuation.manifestId, record.id);
    assertEquals(continuation.sourceAttemptId, live.assignment.attemptId);
    assertEquals(continuation.previousFence, before.job.current_fence);
    assertEquals(
      continuation.newFence,
      String(BigInt(before.job.current_fence) + 1n),
    );
    assertEquals(continuation.mode, "fresh_session");

    const after = await state(fixture, live);
    assertEquals(after.attempt, "lost");
    assertEquals(after.job.status, "queued");
    assertEquals(after.job.current_fence, continuation.newFence);
    // The step's pinned inputs are untouched: the job is requeued, not rewritten.
    assertEquals(after.job.input, before.job.input);
    assertEquals(after.job.agent_config, before.job.agent_config);
    assertEquals(after.job.billing, before.job.billing);
    const manifest = await fixture.pgDatabase.query<{ status: string }>(
      "select status from bakery.handoff_manifests where id = $1",
      [record.id],
    );
    assertEquals(manifest.rows[0].status, "continued");

    // The old fence cannot publish anything any more.
    const fenced = await post(
      fixture,
      live,
      await manifestFor(fixture, live.job),
    );
    assertEquals(fenced.status, 409);
    assertEquals((await body(fenced)).code, "LEASE_FENCED");

    // A new attempt claims the same job at the new fence, with the same input.
    const claimed = await claimAssignment(fixture, live.worker);
    assertEquals(claimed.jobId, live.job.jobId);
    assertEquals(claimed.fence, continuation.newFence);
    assert(claimed.attemptId !== live.assignment.attemptId);
    assertEquals(claimed.input, live.assignment.input);
  }));

Deno.test("two submissions race and exactly one wins; a repeat is refused", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "continue-race");
    const record = await stored(fixture, live);
    const version = await runVersion(fixture, live.job.runId);
    const results = await Promise.all([
      continueManifest(fixture, String(record.id), version),
      continueManifest(fixture, String(record.id), version),
    ]);
    const statuses = results.map((response) => response.status).sort();
    for (const response of results) await response.body?.cancel();
    assertEquals(
      statuses.filter((status) => status < 300).length,
      1,
      JSON.stringify(statuses),
    );
    assertEquals(
      statuses.filter((status) => status === 409 || status === 412).length,
      1,
    );
    const count = await fixture.pgDatabase.query<{ count: number }>(
      "select count(*)::int as count from bakery.handoff_continuations where manifest_id = $1",
      [record.id],
    );
    assertEquals(count.rows[0].count, 1);
    const after = await state(fixture, live);
    assertEquals(
      after.job.current_fence,
      String(BigInt(live.assignment.fence) + 1n),
    );
  }));

Deno.test("a refused handoff commits nothing and says why", () =>
  withWorkerFixture(async (fixture) => {
    const refusedWith = async (_live: Live, record: Json, version: number) => {
      const response = await continueManifest(
        fixture,
        String(record.id),
        version,
      );
      const parsed = await body(response);
      return { status: response.status, parsed };
    };
    const untouched = async (live: Live) => {
      const after = await state(fixture, live);
      assertEquals(after.attempt, "leased");
      assertEquals(after.job.current_fence, live.assignment.fence);
    };

    // A stale run version.
    const stale = await liveAttempt(fixture, "continue-stale");
    const staleRecord = await stored(fixture, stale);
    const staleResult = await refusedWith(
      stale,
      staleRecord,
      (await runVersion(fixture, stale.job.runId)) + 1,
    );
    assertEquals(staleResult.status, 412);
    await untouched(stale);

    // A cancel that got there first.
    const canceled = await liveAttempt(fixture, "continue-cancel");
    const canceledRecord = await stored(fixture, canceled);
    await fixture.pgDatabase.query(
      "update bakery.jobs set cancel_requested_at = now() where id = $1",
      [canceled.job.jobId],
    );
    const canceledResult = await refusedWith(
      canceled,
      canceledRecord,
      await runVersion(fixture, canceled.job.runId),
    );
    assertEquals(canceledResult.status, 409);
    assertEquals(
      JSON.stringify(canceledResult.parsed).includes("cancel_requested"),
      true,
    );
    await untouched(canceled);

    // An effect still in flight.
    const effect = await liveAttempt(fixture, "continue-effect");
    const effectRecord = await stored(fixture, effect);
    await fixture.pgDatabase.query(
      `insert into bakery.external_effects
         (organization_id, run_step_id, operation, target, requesting_principal_id,
          actor_ref, idempotency_key, request_digest, adapter_version, status)
       values ($1, $2, 'test.operation', 'test-target', $3, 'actor', $4, $5, 'v1', 'uncertain')`,
      [
        fixture.organizationId,
        effect.job.runStepId,
        fixture.principalId,
        crypto.randomUUID(),
        "a".repeat(64),
      ],
    );
    const effectResult = await refusedWith(
      effect,
      effectRecord,
      await runVersion(fixture, effect.job.runId),
    );
    assertEquals(effectResult.status, 409);
    assertEquals(
      JSON.stringify(effectResult.parsed).includes("effects_unresolved"),
      true,
    );
    await untouched(effect);

    // A workspace capture that did not finish.
    const paused = await liveAttempt(fixture, "continue-paused");
    const base = await manifestFor(fixture, paused.job);
    const pausedPosted = await post(fixture, paused, {
      ...base,
      repository: { ...(base.repository as Json), captureStatus: "paused" },
    });
    assertEquals(pausedPosted.status, 201);
    const pausedRecord = await body(pausedPosted);
    const pausedResult = await refusedWith(
      paused,
      pausedRecord,
      await runVersion(fixture, paused.job.runId),
    );
    assertEquals(pausedResult.status, 409);
    assertEquals(
      JSON.stringify(pausedResult.parsed).includes("capture_incomplete"),
      true,
    );
    await untouched(paused);
  }));

Deno.test("another organization cannot continue a manifest", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "continue-tenant");
    const record = await stored(fixture, live);
    const foreign = await createWorkerScope(
      fixture,
      "handoff-continue",
      fixture,
    );
    try {
      const response = await continueManifest(
        fixture,
        String(record.id),
        await runVersion(fixture, live.job.runId),
        foreign.organizationId,
      );
      assertEquals(response.status, 404);
      await response.body?.cancel();
      assertEquals((await state(fixture, live)).attempt, "leased");
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));
