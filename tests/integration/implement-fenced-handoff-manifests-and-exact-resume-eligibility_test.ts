/**
 * #33 slice 1: the fenced handoff manifest through the real worker route and a
 * real database. The unit file pins what the server checks and overwrites; this
 * one pins what only the route and the schema prove: the lease and the fence
 * gate the write, the server's own rows decide what is true, one manifest
 * stands per attempt, and nothing crosses an organization.
 */

import { assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { createWorkerScope } from "../helpers/worker-execution.ts";
import {
  body,
  type Json,
  liveAttempt,
  manifestFor,
  person,
  post,
  SHA,
} from "../helpers/handoff-manifests.ts";

Deno.test("the worker of a live attempt stores one manifest, and a person reads it back", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-store");
    const manifest = await manifestFor(fixture, live.job);

    const created = await post(fixture, live, manifest);
    assertEquals(created.status, 201, await created.clone().text());
    const record = await body(created);
    assertEquals(record.status, "pending");
    assertEquals(record.sourceAttemptId, live.assignment.attemptId);
    assertEquals(record.runStepId, live.job.runStepId);
    assertEquals(record.safeBoundary, true);
    assertEquals(/^[0-9a-f]{64}$/.test(String(record.digest)), true);

    // The same manifest replays; a different one for the same attempt conflicts.
    const replay = await post(fixture, live, manifest);
    assertEquals(replay.status, 200);
    assertEquals((await body(replay)).digest, record.digest);
    const different = await post(
      fixture,
      live,
      { ...manifest, goal: "A different goal." },
    );
    assertEquals(different.status, 409);
    await different.body?.cancel();

    const read = await person(fixture, "/v1/handoff-manifests/" + record.id);
    assertEquals(read.status, 200, await read.clone().text());
    assertEquals((await body(read)).digest, record.digest);
  }));

Deno.test("the same bytes replay after the server's view of the step has changed", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-replay-after-change");
    const manifest = await manifestFor(fixture, live.job);
    const created = await post(fixture, live, manifest);
    assertEquals(created.status, 201, await created.clone().text());
    const record = await body(created);
    assertEquals(record.safeBoundary, true);

    // An effect now sits in flight: the server's own view of the step differs
    // from the one it stored, but the source's bytes are the same.
    await fixture.pgDatabase.query(
      `insert into bakery.external_effects
         (organization_id, run_step_id, operation, target, requesting_principal_id,
          actor_ref, idempotency_key, request_digest, adapter_version, status)
       values ($1, $2, 'test.operation', 'test-target', $3, 'actor', $4, $5, 'v1', 'submitted')`,
      [
        fixture.organizationId,
        live.job.runStepId,
        fixture.principalId,
        crypto.randomUUID(),
        SHA,
      ],
    );
    const replay = await post(fixture, live, manifest);
    assertEquals(replay.status, 200, await replay.clone().text());
    const again = await body(replay);
    assertEquals(again.id, record.id);
    // The stored manifest is unchanged: a replay never rewrites it.
    assertEquals(again.digest, record.digest);
    assertEquals(again.safeBoundary, true);

    // Different bytes are still a conflict.
    const different = await post(
      fixture,
      live,
      { ...manifest, goal: "A different goal." },
    );
    assertEquals(different.status, 409);
    await different.body?.cancel();
  }));

Deno.test("the server's journal and effect ledger decide the safe boundary, not the source", () =>
  withWorkerFixture(async (fixture) => {
    const beyond = await liveAttempt(fixture, "handoff-beyond");
    // The source says it is safe at sequence 5, but the journal holds none.
    const response = await post(
      fixture,
      beyond,
      await manifestFor(fixture, beyond.job, {
        checkpoint: { sequence: "5", digest: SHA, safeBoundary: true },
      }),
    );
    assertEquals(response.status, 201, await response.clone().text());
    const record = await body(response);
    assertEquals(record.safeBoundary, false);
    assertEquals(
      ((record.manifest as Json).checkpoint as Json).safeBoundary,
      false,
    );
  }));

Deno.test("a fenced, foreign or malformed write stores nothing", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-refused");
    const manifest = await manifestFor(fixture, live.job);
    const stored = async () =>
      Number(
        (await fixture.pgDatabase.query<{ count: number }>(
          "select count(*)::int as count from bakery.handoff_manifests where source_attempt_id = $1",
          [live.assignment.attemptId],
        )).rows[0].count,
      );

    // A wrong lease token.
    const wrongLease = await post(fixture, live, manifest, {
      leaseToken: "not-the-lease-token",
    });
    assertEquals(wrongLease.status, 409);
    await wrongLease.body?.cancel();

    // An identifier that is not the attempt's run step.
    const wrongStep = await post(fixture, live, {
      ...manifest,
      runStepId: crypto.randomUUID(),
    });
    assertEquals(wrongStep.status, 422);
    await wrongStep.body?.cancel();

    // An artifact reference the server does not hold.
    const ghost = (manifest.context as Json).artifactRefs as Json[];
    const wrongDigest = await post(fixture, live, {
      ...manifest,
      context: {
        ...(manifest.context as Json),
        artifactRefs: [{ ...ghost[0], sha256: "c".repeat(64) }],
      },
    });
    assertEquals(wrongDigest.status, 422);
    await wrongDigest.body?.cancel();

    assertEquals(await stored(), 0);

    // Once the job's fence moves on, the old attempt cannot publish at all.
    await fixture.pgDatabase.query(
      "update bakery.jobs set current_fence = current_fence + 1 where id = $1",
      [live.job.jobId],
    );
    const fenced = await post(fixture, live, manifest);
    assertEquals(fenced.status, 409);
    assertEquals((await body(fenced)).code, "LEASE_FENCED");
    assertEquals(await stored(), 0);
  }));

Deno.test("another organization cannot read a manifest", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "handoff-tenant");
    const created = await post(
      fixture,
      live,
      await manifestFor(fixture, live.job),
    );
    assertEquals(created.status, 201, await created.clone().text());
    const record = await body(created);
    const foreign = await createWorkerScope(fixture, "handoff-14", fixture);
    try {
      const read = await person(
        fixture,
        "/v1/handoff-manifests/" + record.id,
        foreign,
      );
      assertEquals(read.status, 404);
      await read.body?.cancel();
    } finally {
      const { closeWorkerOrganization } = await import(
        "../helpers/worker-execution.ts"
      );
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));
