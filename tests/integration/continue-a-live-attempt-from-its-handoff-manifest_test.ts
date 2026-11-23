/**
 * #33 slice 2: handoffManifests.continue through the real route and a real
 * database. One live source attempt stored a manifest; the person retires it and
 * the job is claimable again. What only the database proves: one winner however
 * many submissions race, the old fence cannot publish, the job's pinned input is
 * untouched, every refusal commits nothing, and nothing crosses an organization.
 */

import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { releaseReconciledHandoffs } from "../../apps/server/src/modules/execution/handoff-release.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  adminRequest,
  closeWorkerOrganization,
  createWorkerScope,
  type WorkerFixture,
  type WorkerScope,
} from "../helpers/worker-execution.ts";
import {
  body,
  COMMIT,
  type Json,
  liveAttempt,
  manifestFor,
  post,
  SHA,
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
  scope: WorkerScope = fixture,
) {
  return adminRequest(
    fixture,
    "/v1/handoff-manifests/" + manifestId + "/continuations",
    { runVersion: version },
    { idempotencyKey: crypto.randomUUID(), scope },
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
    // A claim always takes the next fence, so the new lease holds newFence + 1.
    assertEquals(
      claimed.fence,
      String(BigInt(String(continuation.newFence)) + 1n),
    );
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
        foreign,
      );
      assertEquals(response.status, 404);
      await response.body?.cancel();
      assertEquals((await state(fixture, live)).attempt, "leased");
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));

/**
 * The native session evidence the adapter wrote, and a manifest asking for an
 * exact resume. `evidence` overrides single fields so a test can break one.
 */
async function exactCandidate(
  fixture: WorkerFixture,
  live: Live,
  evidence: Json = {},
) {
  const host = await fixture.pgDatabase.query<{ worker_host_id: string }>(
    "select worker_host_id from bakery.job_attempts where id = $1",
    [live.assignment.attemptId],
  );
  await fixture.pgDatabase.query(
    "update bakery.agent_sessions set status = 'active', resume_ref = $2::jsonb where id = $1",
    [
      live.job.sessionId,
      JSON.stringify({
        nativeSessionId: "native-1",
        checkpointId: SHA,
        worktreeRevision: COMMIT,
        harnessVersion: "codex-1.2.3",
        workerHostId: host.rows[0].worker_host_id,
        ...evidence,
      }),
    ],
  );
  return await stored(fixture, live, { mode: "exact_harness_resume" });
}

async function checkpoints(fixture: WorkerFixture, live: Live) {
  const result = await fixture.pgDatabase.query<
    { current_checkpoints: unknown }
  >(
    "select current_checkpoints from bakery.jobs where id = $1",
    [live.job.jobId],
  );
  return result.rows[0].current_checkpoints;
}

async function auditDetails(fixture: WorkerFixture, continuationId: string) {
  const result = await fixture.pgDatabase.query<{ details: Json }>(
    "select details from bakery.audit_events where operation = 'handoffManifests.continue' and resource_id = $1",
    [continuationId],
  );
  return result.rows[0].details;
}

Deno.test("matching native session evidence continues as an exact harness resume carrying its checkpoint", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "continue-exact");
    const record = await exactCandidate(fixture, live);
    const response = await continueManifest(
      fixture,
      String(record.id),
      await runVersion(fixture, live.job.runId),
    );
    assert(response.status === 200 || response.status === 201);
    const continuation = await body(response);
    assertEquals(continuation.mode, "exact_harness_resume");
    assertEquals(await checkpoints(fixture, live), [{
      schemaVersion: 1,
      source: "handoff",
      manifestId: record.id,
      manifestDigest: record.digest,
      agentSessionId: live.job.sessionId,
      nativeSessionId: "native-1",
      checkpointId: SHA,
      worktreeRevision: COMMIT,
      harnessVersion: "codex-1.2.3",
      workerHostId: (await fixture.pgDatabase.query<{ worker_host_id: string }>(
        "select worker_host_id from bakery.job_attempts where id = $1",
        [live.assignment.attemptId],
      )).rows[0].worker_host_id,
      eligible: true,
    }]);
    const claimed = await claimAssignment(fixture, live.worker);
    assertEquals(claimed.jobId, live.job.jobId);
    assertEquals(
      (await auditDetails(fixture, String(continuation.id))).mode,
      "exact_harness_resume",
    );
  }));

Deno.test("one mismatched piece of native evidence continues as a fresh session and carries no checkpoint", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "continue-mismatch");
    const record = await exactCandidate(fixture, live, {
      worktreeRevision: "c".repeat(40),
    });
    const response = await continueManifest(
      fixture,
      String(record.id),
      await runVersion(fixture, live.job.runId),
    );
    assert(response.status === 200 || response.status === 201);
    const continuation = await body(response);
    assertEquals(continuation.mode, "fresh_session");
    assertEquals(await checkpoints(fixture, live), []);
    const details = await auditDetails(fixture, String(continuation.id));
    assertEquals(details.mode, "fresh_session");
    assertEquals(details.reason, "native_evidence_mismatch");
  }));

Deno.test("history that is no longer authorized is not reused: a purged cited version continues fresh", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "continue-revoked");
    const record = await exactCandidate(fixture, live);
    // The manifest cites its workspace artifact; retention purges its bytes.
    await fixture.pgDatabase.query(
      "update bakery.artifact_versions set purged_at = clock_timestamp() where task_id = $1",
      [live.job.taskId],
    );
    const response = await continueManifest(
      fixture,
      String(record.id),
      await runVersion(fixture, live.job.runId),
    );
    assert(response.status === 200 || response.status === 201);
    const continuation = await body(response);
    assertEquals(continuation.mode, "fresh_session");
    assertEquals(await checkpoints(fixture, live), []);
    assertEquals(
      (await auditDetails(fixture, String(continuation.id))).reason,
      "history_revoked",
    );
  }));

/** Runs the continuation of a fresh exact candidate after `revoke` has changed its history. */
function readManifest(
  fixture: WorkerFixture,
  manifestId: string,
  scope: WorkerScope = fixture,
) {
  return adminRequest(
    fixture,
    "/v1/handoff-manifests/" + manifestId,
    undefined,
    {
      method: "GET",
      scope,
    },
  );
}

// #72: the read says what a continuation would get now, from the same decision
// the admit makes, so the page is right before the click.

Deno.test("the manifest read says an exact resume will be tried, and the admit then does it; once continued the read says nothing", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "read-exact");
    const record = await exactCandidate(fixture, live);
    // The worker's own write makes no decision.
    assertEquals(record.decisionMode, null);
    assertEquals(record.freshReason, null);
    const before = await body(await readManifest(fixture, String(record.id)));
    assertEquals(before.decisionMode, "exact_harness_resume");
    assertEquals(before.freshReason, null);
    // A read admits nothing and moves nothing.
    assertEquals((await state(fixture, live)).attempt, "leased");
    const response = await continueManifest(
      fixture,
      String(record.id),
      await runVersion(fixture, live.job.runId),
    );
    const exact = await body(response);
    assertEquals(exact.mode, before.decisionMode);
    assertEquals(exact.freshReason, null);
    const after = await body(await readManifest(fixture, String(record.id)));
    assertEquals(after.status, "continued");
    assertEquals(after.decisionMode, null);
    assertEquals(after.freshReason, null);
  }));

Deno.test("the manifest read gives the reason a continuation would start fresh, the one the admit then records", () =>
  withWorkerFixture(async (fixture) => {
    const mismatched = await liveAttempt(fixture, "read-mismatch");
    const record = await exactCandidate(fixture, mismatched, {
      worktreeRevision: "c".repeat(40),
    });
    const read = await body(await readManifest(fixture, String(record.id)));
    assertEquals(read.decisionMode, "fresh_session");
    assertEquals(read.freshReason, "native_evidence_mismatch");
    const continuation = await body(
      await continueManifest(
        fixture,
        String(record.id),
        await runVersion(fixture, mismatched.job.runId),
      ),
    );
    assertEquals(continuation.mode, "fresh_session");
    assertEquals(
      (await auditDetails(fixture, String(continuation.id))).reason,
      read.freshReason,
    );
    // The reason is kept on the continuation and returned, so a page can say it
    // after the fact; an exact resume keeps none.
    assertEquals(continuation.freshReason, read.freshReason);
    const kept = await fixture.pgDatabase.query<
      { fresh_reason: string | null }
    >(
      "select fresh_reason from bakery.handoff_continuations where id = $1",
      [continuation.id],
    );
    assertEquals(kept.rows[0].fresh_reason, "native_evidence_mismatch");
  }));

Deno.test("a manifest that never asked for an exact resume reads as fresh for that reason, and another organization reads nothing", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "read-fresh-only");
    const record = await stored(fixture, live);
    const read = await body(await readManifest(fixture, String(record.id)));
    assertEquals(read.decisionMode, "fresh_session");
    assertEquals(read.freshReason, "exact_resume_not_requested");
    const other = await createWorkerScope(
      fixture,
      "handoff-read",
      fixture,
    );
    try {
      const foreign = await readManifest(fixture, String(record.id), other);
      assertEquals(foreign.status, 404);
      await foreign.body?.cancel();
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, other.organizationId);
    }
  }));

async function revokedHistory(
  name: string,
  revoke: (fixture: WorkerFixture, live: Live) => Promise<void>,
) {
  await withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, name);
    const record = await exactCandidate(fixture, live);
    await revoke(fixture, live);
    const response = await continueManifest(
      fixture,
      String(record.id),
      await runVersion(fixture, live.job.runId),
    );
    assert(response.status === 200 || response.status === 201);
    const continuation = await body(response);
    assertEquals(continuation.mode, "fresh_session");
    assertEquals(await checkpoints(fixture, live), []);
    assertEquals(
      (await auditDetails(fixture, String(continuation.id))).reason,
      "history_revoked",
    );
  });
}

Deno.test("a requester who is no longer an active member does not get their history resumed", () =>
  revokedHistory("continue-removed-member", async (fixture, live) => {
    // The run acts for a person whose membership has been deactivated. (The
    // administrator who continues stays as they are.)
    const person = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
       values ($1,null,'former member','service')`,
      [person],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id,organization_id,principal_id,role,status,joined_at,created_at,
         updated_at,version
       ) values ($1,$2,$3,'developer','inactive',now(),now(),now(),1)`,
      [crypto.randomUUID(), fixture.organizationId, person],
    );
    await fixture.pgDatabase.query(
      "update bakery.workflow_runs set requested_by = $2 where id = $1",
      [live.job.runId, person],
    );
  }));

Deno.test("a cited artifact whose bytes changed does not get its history resumed", () =>
  revokedHistory("continue-changed-digest", async (fixture, live) => {
    await fixture.pgDatabase.query(
      "update bakery.artifact_versions set sha256 = $2 where task_id = $1",
      [live.job.taskId, "f".repeat(64)],
    );
  }));

function release(fixture: WorkerFixture) {
  return withPgTransaction(
    fixture.pgDatabase,
    (transaction) => releaseReconciledHandoffs(transaction),
  );
}

Deno.test("an effect in flight parks the continuation, and settling it releases the job as a fresh session", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "continue-parked");
    // Native evidence matches, so only the unsettled effect can stop a resume.
    const record = await exactCandidate(fixture, live);
    const effect = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.external_effects
         (organization_id, run_step_id, operation, target, requesting_principal_id,
          actor_ref, idempotency_key, request_digest, adapter_version, status)
       values ($1, $2, 'test.operation', 'test-target', $3, 'actor', $4, $5, 'v1', 'uncertain')
       returning id`,
      [
        fixture.organizationId,
        live.job.runStepId,
        fixture.principalId,
        crypto.randomUUID(),
        "a".repeat(64),
      ],
    );
    const before = await state(fixture, live);
    const response = await continueManifest(
      fixture,
      String(record.id),
      await runVersion(fixture, live.job.runId),
    );
    assert(response.status === 200 || response.status === 201);
    const continuation = await body(response);
    assertEquals(continuation.mode, "fresh_session");

    // Retired and fenced, but not queued: nothing may start a model turn yet.
    const parked = await state(fixture, live);
    assertEquals(parked.attempt, "lost");
    assertEquals(parked.job.status, "awaiting_reconciliation");
    assertEquals(
      parked.job.current_fence,
      String(BigInt(before.job.current_fence) + 1n),
    );
    assertEquals(await checkpoints(fixture, live), []);
    const details = await auditDetails(fixture, String(continuation.id));
    assertEquals(details.jobStatus, "awaiting_reconciliation");
    assertEquals(details.reason, "effects_unresolved");

    // While the effect is unsettled a coordinator pass releases nothing.
    assertEquals(await release(fixture), 0);
    assertEquals(
      (await state(fixture, live)).job.status,
      "awaiting_reconciliation",
    );

    // The effect settles; the next pass queues the job once, at the same fence.
    await fixture.pgDatabase.query(
      "update bakery.external_effects set status = 'confirmed' where id = $1",
      [effect.rows[0].id],
    );
    assertEquals(await release(fixture), 1);
    assertEquals(await release(fixture), 0);
    const queued = await state(fixture, live);
    assertEquals(queued.job.status, "queued");
    assertEquals(queued.job.current_fence, parked.job.current_fence);
    assertEquals(queued.job.input, before.job.input);

    // The effect was reconciled, never repeated: still the one row.
    const effects = await fixture.pgDatabase.query<{ n: number }>(
      "select count(*)::int as n from bakery.external_effects where run_step_id = $1",
      [live.job.runStepId],
    );
    assertEquals(effects.rows[0].n, 1);

    const claimed = await claimAssignment(fixture, live.worker);
    assertEquals(claimed.jobId, live.job.jobId);
    assertEquals(claimed.fence, String(BigInt(parked.job.current_fence) + 1n));
  }));

Deno.test("a job parked by another path is not released by the handoff pass", () =>
  withWorkerFixture(async (fixture) => {
    const live = await liveAttempt(fixture, "continue-other-park");
    await fixture.pgDatabase.query(
      "update bakery.jobs set status = 'awaiting_reconciliation' where id = $1",
      [live.job.jobId],
    );
    assertEquals(await release(fixture), 0);
    assertEquals(
      (await state(fixture, live)).job.status,
      "awaiting_reconciliation",
    );
  }));
