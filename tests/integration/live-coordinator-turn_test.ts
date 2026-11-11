import { assert, assertEquals } from "@std/assert";
import { sendMessage } from "../helpers/coordinator-turns.ts";
import { request } from "../helpers/durable-questions.ts";
import {
  claimAssignment,
  claimCoordinatorJob,
  holdLeaseRenewals,
  leaseExpired,
  type Live,
  MODEL_OUTPUT,
  planEffect,
  postOutcome,
  QUESTION_EFFECT,
  registeredWorker,
  seedLive,
  sleep,
  startTurn,
  until,
  withLiveWorker,
  workerAnswers,
  workerExecutor,
} from "../helpers/live-coordinator.ts";
import { postWorkerResult } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFx } from "../helpers/coordinator-turn-jobs-worker.ts";
import {
  claimNextTurn,
  executeClaimedTurn,
} from "../../apps/server/src/modules/conversation/turn-runtime.ts";
import type {
  CoordinatorTurnExecutor,
  CoordinatorTurnInput,
} from "../../apps/server/src/modules/conversation/coordinator.ts";
import {
  fund,
  seedAgentAndTurn,
  seedConversation,
} from "../helpers/coordinator-turn-jobs.ts";
import { sweepCoordinatorTurnJobs } from "../../packages/persistence/src/coordinator-jobs.ts";
import { pushCoordinatorCancelToWorker } from "../../apps/server/src/modules/conversation/coordinator-worker.ts";

type TurnRow = {
  id: string;
  status: string;
  failure: { code: string } | null;
};

async function turns(fx: WorkerFx, live: Live): Promise<TurnRow[]> {
  return (await fx.pgDatabase.query<TurnRow>(
    `select turn.id, turn.status, turn.failure
       from bakery.conversation_turns turn
       join bakery.messages message on message.id = turn.trigger_message_id
      where turn.conversation_id = $1 order by message.sequence`,
    [live.seed.conversationId],
  )).rows;
}

async function jobs(fx: WorkerFx, live: Live) {
  return (await fx.pgDatabase.query<{
    id: string;
    status: string;
    cancelRequested: boolean;
    attempts: number;
    reservation: string | null;
  }>(
    `select job.id, job.status,
            job.cancel_requested_at is not null as "cancelRequested",
            (select count(*)::int from bakery.job_attempts attempt
              where attempt.job_id = job.id) as attempts,
            (select reservation.status from bakery.budget_reservations reservation
              where reservation.id = job.installation_reservation_id)
              as reservation
       from bakery.jobs job
      where job.organization_id = $1 and job.conversation_turn_id is not null
        and job.conversation_turn_id in (
          select id from bakery.conversation_turns where conversation_id = $2)
      order by job.created_at`,
    [live.seed.organizationId, live.seed.conversationId],
  )).rows;
}

/** Queued worker cancel commands for the coordinator attempts of a conversation. */
async function cancelCommands(fx: WorkerFx, live: Live) {
  return (await fx.pgDatabase.query<
    { type: string; attemptStatus: string }
  >(
    `select command.command_type as type, attempt.status as "attemptStatus"
       from bakery.worker_commands command
       join bakery.job_attempts attempt
         on attempt.organization_id = command.organization_id
        and attempt.id = command.attempt_id
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
      where job.organization_id = $1 and job.conversation_turn_id in (
        select id from bakery.conversation_turns where conversation_id = $2)
      order by command.created_at`,
    [live.seed.organizationId, live.seed.conversationId],
  )).rows;
}

async function questions(fx: WorkerFx, live: Live, kind: string) {
  return (await fx.pgDatabase.query<
    { id: string; status: string; options: { id: string }[] | null }
  >(
    `select id, status, options from bakery.questions
      where organization_id = $1 and conversation_id = $2 and kind = $3
      order by created_at`,
    [live.seed.organizationId, live.seed.conversationId, kind],
  )).rows;
}

async function revisions(fx: WorkerFx, live: Live) {
  return (await fx.pgDatabase.query<
    { revision: number; status: string; supersedes: number | null }
  >(
    `select revision, status, supersedes_revision as supersedes
       from bakery.plan_revisions
      where organization_id = $1 and task_id = $2 order by revision`,
    [live.seed.organizationId, live.taskId],
  )).rows;
}

async function ask(fx: WorkerFx, live: Live, body: string) {
  const response = await sendMessage(fx, live.seed, "agent_request", body);
  assertEquals(response.status, 201);
  await response.body?.cancel();
}

/** Turn 1 of the live loop: reply, question and plan revision 1. */
async function firstTurn(fx: WorkerFx, live: Live) {
  const worker = await registeredWorker(fx, { name: "live-worker" });
  await ask(fx, live, "plan the change and ask what you need");
  const started = await startTurn(live, workerExecutor(fx));
  await workerAnswers(fx, worker, {
    effects: [
      { type: "reply", body: "Here is a first plan." },
      QUESTION_EFFECT,
      planEffect("Plan one"),
    ],
  });
  assertEquals((await started.run).kind, "processed");
  return worker;
}

Deno.test("(a) agent_request on a human_approval task gets a question, plan revision 1 and an open approval", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-a");
    await firstTurn(fx, live);
    assertEquals((await turns(fx, live)).map((t) => t.status), ["completed"]);
    const asked = await questions(fx, live, "question");
    assertEquals(asked.length, 1);
    assertEquals(asked[0].status, "open");
    assertEquals(await revisions(fx, live), [
      { revision: 1, status: "proposed", supersedes: null },
    ]);
    const approvals = await questions(fx, live, "approval");
    assertEquals(approvals.map((a) => a.status), ["open"]);
    const [job] = await jobs(fx, live);
    assertEquals(
      [job.status, job.attempts, job.reservation],
      ["completed", 1, "released"],
    );
    const replies = await fx.pgDatabase.query(
      `select 1 from bakery.messages
        where conversation_id = $1 and intent = 'agent_output'`,
      [live.seed.conversationId],
    );
    assertEquals(replies.rows.length, 1);
  }));

Deno.test("(b) answering queues turn 2; revision 2 supersedes revision 1 and its approval", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-b");
    const worker = await firstTurn(fx, live);
    const [question] = await questions(fx, live, "question");
    const answered = await request(
      fx,
      live.seed,
      `/v1/questions/${question.id}/answer`,
      { method: "PUT", body: { answer: { optionId: "pg" } } },
    );
    assertEquals(answered.status, 200);
    await answered.body?.cancel();
    assertEquals((await turns(fx, live)).map((t) => t.status), [
      "completed",
      "queued",
    ]);
    const second = await startTurn(live, workerExecutor(fx));
    await workerAnswers(fx, worker, {
      effects: [planEffect("Plan two, Postgres")],
    });
    assertEquals((await second.run).kind, "processed");
    assertEquals(await revisions(fx, live), [
      { revision: 1, status: "superseded", supersedes: null },
      { revision: 2, status: "proposed", supersedes: 1 },
    ]);
    const approvals = await questions(fx, live, "approval");
    assertEquals(approvals.length, 2);
    assert(approvals[0].status !== "open");
    assertEquals(approvals[1].status, "open");
    const rows = await jobs(fx, live);
    assertEquals(rows.map((r) => [r.status, r.attempts, r.reservation]), [
      ["completed", 1, "released"],
      ["completed", 1, "released"],
    ]);
  }));

Deno.test("(c) no worker: coordinator_worker_unavailable, job canceled, reservation released", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-c");
    await ask(fx, live, "anyone there?");
    const started = await startTurn(
      live,
      workerExecutor(fx, { claimTimeoutMs: 300, turnTimeoutMs: 5_000 }),
    );
    assertEquals((await started.run).kind, "processed");
    const [turn] = await turns(fx, live);
    assertEquals(turn.status, "failed");
    assertEquals(turn.failure?.code, "coordinator_worker_unavailable");
    const rows = await jobs(fx, live);
    assertEquals(rows.length, 1);
    assertEquals(
      [rows[0].status, rows[0].attempts, rows[0].reservation],
      ["canceled", 0, "released"],
    );
    assertEquals((await questions(fx, live, "question")).length, 0);
    assertEquals((await revisions(fx, live)).length, 0);
  }));

Deno.test("(c2) a claim in the instant of the deadline wins: conditional cancel changes no row and the turn completes", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-c2");
    const worker = await registeredWorker(fx, { name: "late-worker" });
    await ask(fx, live, "late claim");
    let late: Awaited<ReturnType<typeof claimAssignment>> | undefined;
    const started = await startTurn(
      live,
      workerExecutor(fx, {
        claimTimeoutMs: 200,
        turnTimeoutMs: 10_000,
        beforeQueuedCancel: async () => {
          late ??= await claimAssignment(fx, worker, {
            supportedActions: ["coordinator.turn"],
          });
        },
      }),
    );
    const claimed = await until(() => Promise.resolve(late), "the late claim");
    await sleep(100);
    await postOutcome(fx, worker, claimed, {
      effects: [{ type: "reply", body: "Late but applied." }],
    });
    assertEquals((await started.run).kind, "processed");
    assertEquals((await turns(fx, live)).map((t) => t.status), ["completed"]);
    const rows = await jobs(fx, live);
    assertEquals(rows.length, 1);
    assertEquals(
      [rows[0].status, rows[0].attempts, rows[0].reservation],
      ["completed", 1, "released"],
    );
  }));

Deno.test("(d) a host with a failed capability:model check gives coordinator_credential_unavailable", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-d");
    const worker = await registeredWorker(fx, { name: "no-credential" });
    await fx.pgDatabase.query(
      `insert into bakery.worker_checks (
         organization_id, worker_host_id, check_id, check_version,
         host_generation, inventory_revision, status, reason, observed_at,
         expires_at
       )
       select host.organization_id, host.id, 'capability:model', '1',
              host.credential_generation, host.inventory_revision, 'fail',
              'claude not logged in', clock_timestamp(),
              clock_timestamp() + interval '10 minutes'
         from bakery.worker_hosts host where host.id = $1`,
      [worker.registration.workerHostId],
    );
    await ask(fx, live, "can you plan?");
    const started = await startTurn(live, workerExecutor(fx));
    assertEquals((await started.run).kind, "processed");
    const [turn] = await turns(fx, live);
    assertEquals(turn.failure?.code, "coordinator_credential_unavailable");
    const [job] = await jobs(fx, live);
    assertEquals(
      [job.status, job.attempts, job.reservation],
      ["canceled", 0, "released"],
    );
  }));

Deno.test("(e) cancel mid-run: the job gets a cancel request and the turn ends canceled", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-e");
    const worker = await registeredWorker(fx, { name: "cancel-worker" });
    await ask(fx, live, "cancel me");
    const started = await startTurn(live, workerExecutor(fx));
    const assignment = await claimCoordinatorJob(fx, worker);
    await fx.pgDatabase.query(
      `update bakery.conversation_turns
          set status = 'cancel_requested', version = version + 1
        where id = $1`,
      [started.turnId],
    );
    const result = await started.run;
    assertEquals(result.kind, "processed");
    assertEquals((await turns(fx, live)).map((t) => t.status), ["canceled"]);
    const [job] = await jobs(fx, live);
    assert(job.cancelRequested, "the job must carry the cancel request");
    // The worker is told to stop: the live attempt is canceled, its cancel
    // command is queued for the next heartbeat, and the funding is back.
    assertEquals([job.status, job.reservation], ["canceled", "released"]);
    assertEquals(await cancelCommands(fx, live), [
      { type: "cancel", attemptStatus: "canceled" },
    ]);
    // The late worker result is refused: the cancel request wins.
    const response = await postWorkerResult(
      fx,
      worker,
      assignment,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        localSeq: "1",
        status: "completed",
        result: { ...MODEL_OUTPUT, effects: [{ type: "noop" }] },
      },
      crypto.randomUUID(),
    );
    assertEquals(response.status, 409);
    await response.body?.cancel();
    assertEquals((await questions(fx, live, "question")).length, 0);
  }));

/** Wraps the executor to capture the input the runtime built. */
function capturing(inner: CoordinatorTurnExecutor) {
  const inputs: CoordinatorTurnInput[] = [];
  const executor: CoordinatorTurnExecutor = {
    execute(input, signal) {
      inputs.push(input);
      return inner.execute(input, signal);
    },
  };
  return { executor, inputs };
}

Deno.test("(f) re-executing a turn reattaches to its one job; a stale claim version applies nothing", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-f");
    const worker = await registeredWorker(fx, { name: "reattach-worker" });
    await ask(fx, live, "reattach");
    const spy = capturing(workerExecutor(fx));
    const started = await startTurn(live, spy.executor);
    await workerAnswers(fx, worker, {
      effects: [{ type: "reply", body: "Once." }],
    });
    assertEquals((await started.run).kind, "processed");
    // The Inngest step retries: same turn, same claim, same executor input.
    const again = await workerExecutor(fx).execute(
      spy.inputs[0],
      new AbortController().signal,
    );
    assertEquals(again, {
      status: "completed",
      effects: [{ type: "reply", body: "Once." }],
    });
    const replay = await executeClaimedTurn(
      {
        database: fx.runtimePgDatabase,
        executor: workerExecutor(fx),
        leaseMs: 60_000,
        heartbeatMs: 100,
      },
      {
        organizationId: live.seed.organizationId,
        conversationId: live.seed.conversationId,
        turnId: started.turnId,
        claimVersion: started.claimVersion,
      },
    );
    assertEquals(replay.kind, "lost");
    const rows = await jobs(fx, live);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].attempts, 1);
    const replies = await fx.pgDatabase.query(
      `select 1 from bakery.messages
        where conversation_id = $1 and intent = 'agent_output'`,
      [live.seed.conversationId],
    );
    assertEquals(replies.rows.length, 1);
  }));

Deno.test("(f2) interleaved takeover: executor A aborts without touching the job, B reattaches and the result applies once", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-f2");
    const worker = await registeredWorker(fx, { name: "takeover-worker" });
    await ask(fx, live, "takeover");
    // A: one-millisecond lease so recovery may reclaim the turn mid-poll. A's
    // lease renewals park before they touch the row, so none can land between
    // the lease running out and the reclaim (a renewal inside that millisecond
    // reads as a held lease: busy).
    using renewals = holdLeaseRenewals(fx.runtimePgDatabase);
    const a = await startTurn(live, workerExecutor(fx), {
      leaseMs: 1,
      heartbeatMs: 50,
      database: renewals.database,
    });
    const jobId = (await until(async () =>
      (await jobs(fx, live))[0], "A's job"))
      .id;
    await renewals.parked();
    await until(
      async () => await leaseExpired(fx, a.turnId),
      "A's lease to run out",
    );
    const reclaim = await claimNextTurn(fx.runtimePgDatabase, {
      organizationId: live.seed.organizationId,
      conversationId: live.seed.conversationId,
      leaseMs: 60_000,
    });
    assertEquals(reclaim.kind, "claimed");
    if (reclaim.kind !== "claimed") return;
    assert(reclaim.claimVersion > a.claimVersion);
    // A's parked heartbeat now lands, matches no row and aborts it; the job is
    // not canceled.
    renewals.release();
    assertEquals((await a.run).kind, "lost");
    const [afterA] = await jobs(fx, live);
    assertEquals(afterA.id, jobId);
    assertEquals([afterA.status, afterA.cancelRequested], ["queued", false]);
    const b = executeClaimedTurn(
      {
        database: fx.runtimePgDatabase,
        executor: workerExecutor(fx),
        leaseMs: 60_000,
        heartbeatMs: 100,
      },
      {
        organizationId: live.seed.organizationId,
        conversationId: live.seed.conversationId,
        turnId: reclaim.turnId,
        claimVersion: reclaim.claimVersion,
      },
    );
    await workerAnswers(fx, worker, {
      effects: [{ type: "reply", body: "Applied once." }],
    });
    assertEquals((await b).kind, "processed");
    assertEquals((await turns(fx, live)).map((t) => t.status), ["completed"]);
    const rows = await jobs(fx, live);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].id, jobId);
    assertEquals(rows[0].attempts, 1);
    const replies = await fx.pgDatabase.query(
      `select 1 from bakery.messages
        where conversation_id = $1 and intent = 'agent_output'`,
      [live.seed.conversationId],
    );
    assertEquals(replies.rows.length, 1);
  }));

Deno.test("(g) an invalid stored result gives coordinator_output_invalid and applies nothing", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-g");
    const worker = await registeredWorker(fx, { name: "invalid-worker" });
    await ask(fx, live, "bad output");
    const started = await startTurn(live, workerExecutor(fx));
    const assignment = await claimCoordinatorJob(fx, worker);
    // The server refuses an invalid completed result at submission, so the
    // stored row is tampered with to exercise the executor's own validation.
    await fx.pgDatabase.query(
      `update bakery.job_attempts
          set status = 'completed', result = $2::jsonb
        where id = $1`,
      [
        assignment.attemptId,
        JSON.stringify({
          status: "completed",
          result: { ...MODEL_OUTPUT, effects: [{ type: "approve" }] },
        }),
      ],
    );
    await fx.pgDatabase.query(
      `update bakery.jobs set status = 'completed' where id = $1`,
      [assignment.jobId],
    );
    assertEquals((await started.run).kind, "processed");
    const [turn] = await turns(fx, live);
    assertEquals(turn.failure?.code, "coordinator_output_invalid");
    assertEquals((await questions(fx, live, "approval")).length, 0);
    assertEquals((await revisions(fx, live)).length, 0);
  }));

Deno.test("(g2) the worker's own OUTPUT_INVALID fault gives coordinator_output_invalid", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-g2");
    const worker = await registeredWorker(fx, { name: "fault-worker" });
    await ask(fx, live, "bad output");
    const started = await startTurn(live, workerExecutor(fx));
    await workerAnswers(fx, worker, {
      faultCode: "CLAUDE_COORDINATOR_OUTPUT_INVALID",
    });
    assertEquals((await started.run).kind, "processed");
    assertEquals(
      (await turns(fx, live))[0].failure?.code,
      "coordinator_output_invalid",
    );
  }));

Deno.test("(h) an api billing route gives coordinator_billing_unsupported and no job", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-h", {
      billing: {
        provider: "anthropic",
        billingAccountId: "coordinator-turn-jobs-test",
        model: "claude-opus-5-5",
        billingRoute: "api",
        maxTokens: 8_000,
        maxUsdReservation: 0.25,
        pricingMetadataSnapshot: "coordinator-turn-jobs-price-api",
      },
    });
    await ask(fx, live, "api route");
    const started = await startTurn(live, workerExecutor(fx));
    assertEquals((await started.run).kind, "processed");
    assertEquals(
      (await turns(fx, live))[0].failure?.code,
      "coordinator_billing_unsupported",
    );
    assertEquals((await jobs(fx, live)).length, 0);
  }));

Deno.test("(i) a busy worker gives coordinator_worker_busy after one attempt", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-i");
    const worker = await registeredWorker(fx, { name: "busy-worker" });
    await ask(fx, live, "busy");
    const started = await startTurn(live, workerExecutor(fx));
    await workerAnswers(fx, worker, { faultCode: "CLAUDE_COORDINATOR_BUSY" });
    assertEquals((await started.run).kind, "processed");
    assertEquals(
      (await turns(fx, live))[0].failure?.code,
      "coordinator_worker_busy",
    );
    const [job] = await jobs(fx, live);
    assertEquals([job.status, job.attempts], ["failed", 1]);
  }));

Deno.test("(j) recovery sweep cancels the job of a finished turn and frees its funding", () =>
  withLiveWorker(async (fx) => {
    const seed = await seedConversation(
      fx.pgDatabase,
      fx.organizationId,
      fx.principalId,
      "lc-j",
    );
    const scope = await seedAgentAndTurn(fx.pgDatabase, seed);
    await fund(fx.runtimePgDatabase, scope);
    await fx.pgDatabase.query(
      `update bakery.conversation_turns set status = 'failed' where id = $1`,
      [scope.turnId],
    );
    const swept = await sweepCoordinatorTurnJobs(fx.runtimePgDatabase);
    assert(swept.orphansCanceled >= 1);
    const job = await fx.pgDatabase.query<
      { status: string; reservation: string }
    >(
      `select job.status, reservation.status as reservation
         from bakery.jobs job
         join bakery.budget_reservations reservation
           on reservation.id = job.installation_reservation_id
        where job.conversation_turn_id = $1`,
      [scope.turnId],
    );
    assertEquals(job.rows[0], { status: "canceled", reservation: "released" });
    // A second sweep finds nothing left to do for this job.
    assertEquals(await sweepCoordinatorTurnJobs(fx.runtimePgDatabase), {
      orphansCanceled: 0,
      reservationsReleased: 0,
      failures: 0,
    });
    const account = await fx.pgDatabase.query<{ status: string }>(
      `select reservation.status
         from bakery.budget_reservations reservation
         join bakery.jobs job
           on job.installation_reservation_id = reservation.id
        where job.conversation_turn_id = $1`,
      [scope.turnId],
    );
    assertEquals(account.rows[0].status, "released");
  }));

Deno.test("(j2) sweep keeps funding held for a claimed job until the job is terminal", () =>
  withLiveWorker(async (fx) => {
    const seed = await seedConversation(
      fx.pgDatabase,
      fx.organizationId,
      fx.principalId,
      "lc-j2",
    );
    const scope = await seedAgentAndTurn(fx.pgDatabase, seed);
    await fund(fx.runtimePgDatabase, scope);
    await fx.pgDatabase.query(
      `update bakery.jobs set status = 'leased', current_fence = 1
        where conversation_turn_id = $1`,
      [scope.turnId],
    );
    await fx.pgDatabase.query(
      `update bakery.conversation_turns set status = 'failed' where id = $1`,
      [scope.turnId],
    );
    const state = () =>
      fx.pgDatabase.query<
        { status: string; cancelRequested: boolean; reservation: string }
      >(
        `select job.status, job.cancel_requested_at is not null as "cancelRequested",
                reservation.status as reservation
           from bakery.jobs job
           join bakery.budget_reservations reservation
             on reservation.id = job.installation_reservation_id
          where job.conversation_turn_id = $1`,
        [scope.turnId],
      ).then((r) => r.rows[0]);
    const first = await sweepCoordinatorTurnJobs(fx.runtimePgDatabase);
    assert(first.orphansCanceled >= 1);
    assertEquals(await state(), {
      status: "leased",
      cancelRequested: true,
      reservation: "held",
    });
    assertEquals(first.reservationsReleased, 0);
    await fx.pgDatabase.query(
      `update bakery.jobs set status = 'failed' where conversation_turn_id = $1`,
      [scope.turnId],
    );
    const second = await sweepCoordinatorTurnJobs(fx.runtimePgDatabase);
    assert(second.reservationsReleased >= 1);
    assertEquals((await state()).reservation, "released");
  }));

Deno.test("(m3) a deactivated coordinator version gives coordinator_unconfigured", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-m3");
    await ask(fx, live, "unconfigured");
    await fx.pgDatabase.query(
      `update bakery.agent_definitions set enabled = false
        where organization_id = $1 and slug = 'coordinator'`,
      [live.seed.organizationId],
    );
    const started = await startTurn(
      live,
      workerExecutor(fx, { claimTimeoutMs: 300, turnTimeoutMs: 5_000 }),
    );
    assertEquals((await started.run).kind, "processed");
    const [turn] = await turns(fx, live);
    assertEquals(turn.failure?.code, "coordinator_unconfigured");
    const [job] = await jobs(fx, live);
    assertEquals([job.status, job.attempts], ["canceled", 0]);
  }));

Deno.test("(m4) deadlines run from job age: a backdated claimed job times out at once", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-m4");
    await registeredWorker(fx, { name: "age-worker" });
    await ask(fx, live, "old job");
    const started = await startTurn(
      live,
      workerExecutor(fx, {
        claimTimeoutMs: 600_000,
        turnTimeoutMs: 1_800_000,
      }),
    );
    const job = await until(async () => (await jobs(fx, live))[0], "the job");
    // Claimed, so only the turn deadline applies; older than it.
    await fx.pgDatabase.query(
      `update bakery.jobs set status = 'leased', current_fence = 1,
              created_at = clock_timestamp() - interval '2 hours'
        where id = $1`,
      [job.id],
    );
    const begun = Date.now();
    assertEquals((await started.run).kind, "processed");
    assert(Date.now() - begun < 5_000, "timeout must not restart the clock");
    const [turn] = await turns(fx, live);
    assertEquals(turn.failure?.code, "coordinator_timeout");
  }));

Deno.test("(m19) a failing cancel push does not replace the turn timeout", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-m19");
    await registeredWorker(fx, { name: "push-fault-worker" });
    await ask(fx, live, "push fault");
    const pushed: string[] = [];
    const started = await startTurn(
      live,
      workerExecutor(fx, {
        claimTimeoutMs: 600_000,
        turnTimeoutMs: 1_800_000,
        pushCancel: (job) => {
          pushed.push(job.jobId);
          return Promise.reject(new Error("push transport down"));
        },
      }),
    );
    const job = await until(async () => (await jobs(fx, live))[0], "the job");
    // Claimed and past the turn deadline: the executor cancels and pushes.
    await fx.pgDatabase.query(
      `update bakery.jobs set status = 'leased', current_fence = 1,
              created_at = clock_timestamp() - interval '2 hours'
        where id = $1`,
      [job.id],
    );
    assertEquals((await started.run).kind, "processed");
    assertEquals(pushed, [job.id]);
    const [turn] = await turns(fx, live);
    assertEquals(turn.failure?.code, "coordinator_timeout");
    // The cancel request committed before the push, so lease reclaim can end
    // the job.
    const [after] = await jobs(fx, live);
    assert(after.cancelRequested, "the job must carry the cancel request");
  }));

Deno.test("(m5) a queued job older than the claim deadline gives coordinator_worker_unavailable", () =>
  withLiveWorker(async (fx) => {
    const live = await seedLive(fx, "lc-m5");
    await registeredWorker(fx, { name: "age-worker-2" });
    await ask(fx, live, "unclaimed job");
    const started = await startTurn(
      live,
      workerExecutor(fx, {
        claimTimeoutMs: 600_000,
        turnTimeoutMs: 1_800_000,
      }),
    );
    const job = await until(async () => (await jobs(fx, live))[0], "the job");
    // Past the claim deadline, inside the turn deadline.
    await fx.pgDatabase.query(
      `update bakery.jobs set created_at = clock_timestamp() - interval '20 minutes'
        where id = $1`,
      [job.id],
    );
    const begun = Date.now();
    assertEquals((await started.run).kind, "processed");
    assert(Date.now() - begun < 5_000, "claim deadline must not restart");
    const [turn] = await turns(fx, live);
    assertEquals(turn.failure?.code, "coordinator_worker_unavailable");
  }));

type SweepRow = Awaited<ReturnType<typeof seedAgentAndTurn>>;

/**
 * One funded coordinator job in its own conversation. The org allows a single
 * `coordinator` slug, so earlier definitions are parked first. `createdAt`
 * orders the sweep query; `jobStatus` is the state the sweep finds.
 */
async function seedSweepRow(
  fx: WorkerFx,
  label: string,
  options: {
    jobStatus: "queued" | "failed";
    turnStatus: "failed" | "active";
    createdAt: string;
    broken: boolean;
  },
): Promise<SweepRow> {
  await fx.pgDatabase.query(
    `update bakery.agent_definitions set slug = 'coordinator-' || id::text
      where organization_id = $1 and slug = 'coordinator'`,
    [fx.organizationId],
  );
  const row = await seedAgentAndTurn(
    fx.pgDatabase,
    await seedConversation(
      fx.pgDatabase,
      fx.organizationId,
      fx.principalId,
      label,
    ),
  );
  await fund(fx.runtimePgDatabase, row);
  if (options.broken) {
    // The held amount exceeds the account's reserved balance, so releasing
    // it throws budget_reservation_balance_invalid.
    await fx.pgDatabase.query(
      `update bakery.budget_reservations set reserved_usd = reserved_usd + 1000
        where id = (select installation_reservation_id from bakery.jobs
                     where conversation_turn_id = $1)`,
      [row.turnId],
    );
  }
  await fx.pgDatabase.query(
    `update bakery.jobs set status = $2, created_at = $3::timestamptz
      where conversation_turn_id = $1`,
    [row.turnId, options.jobStatus, options.createdAt],
  );
  await fx.pgDatabase.query(
    `update bakery.conversation_turns set status = $2 where id = $1`,
    [row.turnId, options.turnStatus],
  );
  return row;
}

async function sweepState(fx: WorkerFx, row: SweepRow) {
  return (await fx.pgDatabase.query<
    { job: string; reservation: string; reservedUsd: string }
  >(
    `select job.status as job, reservation.status as reservation,
            account.reserved_usd::text as "reservedUsd"
       from bakery.jobs job
       join bakery.budget_reservations reservation
         on reservation.id = job.installation_reservation_id
       join bakery.budget_accounts account
         on account.id = reservation.budget_account_id
      where job.conversation_turn_id = $1`,
    [row.turnId],
  )).rows[0];
}

Deno.test("(j3) a job whose release throws is skipped and counted, later rows still sweep", () =>
  withLiveWorker(async (fx) => {
    const bad = await seedSweepRow(fx, "lc-j3-bad", {
      jobStatus: "failed",
      turnStatus: "failed",
      createdAt: "2026-01-01T00:00:00Z",
      broken: true,
    });
    const good = await seedSweepRow(fx, "lc-j3-good", {
      jobStatus: "failed",
      turnStatus: "failed",
      createdAt: "2026-01-02T00:00:00Z",
      broken: false,
    });
    const before = await sweepState(fx, good);
    const swept = await sweepCoordinatorTurnJobs(fx.runtimePgDatabase);
    assertEquals(swept.failures, 1);
    assertEquals(swept.reservationsReleased, 1);
    // State, not counters: the good hold is gone, the bad one is untouched.
    const after = await sweepState(fx, good);
    assertEquals(after.reservation, "released");
    assertEquals(
      Number(before.reservedUsd) - Number(after.reservedUsd),
      0.25,
      "the account drops by exactly the good reservation",
    );
    const left = await sweepState(fx, bad);
    assertEquals(left.job, "failed");
    assertEquals(left.reservation, "held");
  }));

Deno.test("(m14) a queued cancel rolled back with its release is not counted", () =>
  withLiveWorker(async (fx) => {
    const bad = await seedSweepRow(fx, "lc-m14", {
      jobStatus: "queued",
      turnStatus: "failed",
      createdAt: "2026-01-01T00:00:00Z",
      broken: true,
    });
    const swept = await sweepCoordinatorTurnJobs(fx.runtimePgDatabase);
    assertEquals(swept, {
      orphansCanceled: 0,
      reservationsReleased: 0,
      failures: 1,
    });
    // The transaction rolled back: the job is still queued, funding held.
    const left = await sweepState(fx, bad);
    assertEquals([left.job, left.reservation], ["queued", "held"]);
  }));

Deno.test("(m15) persistently failing rows do not starve later rows", () =>
  withLiveWorker(async (fx) => {
    // Two broken rows sit ahead of the good one. A page of one would keep
    // re-reading the first broken row forever without keyset paging.
    await seedSweepRow(fx, "lc-m15-bad-1", {
      jobStatus: "failed",
      turnStatus: "failed",
      createdAt: "2026-01-01T00:00:00Z",
      broken: true,
    });
    await seedSweepRow(fx, "lc-m15-bad-2", {
      jobStatus: "failed",
      turnStatus: "failed",
      createdAt: "2026-01-02T00:00:00Z",
      broken: true,
    });
    const good = await seedSweepRow(fx, "lc-m15-good", {
      jobStatus: "failed",
      turnStatus: "failed",
      createdAt: "2026-01-03T00:00:00Z",
      broken: false,
    });
    const swept = await sweepCoordinatorTurnJobs(fx.runtimePgDatabase, 1);
    assertEquals(swept.failures, 2);
    assertEquals(swept.reservationsReleased, 1);
    assertEquals((await sweepState(fx, good)).reservation, "released");
  }));

Deno.test("(m2) the sweep asks the worker of a claimed job to stop", () =>
  withLiveWorker(async (fx) => {
    const row = await seedSweepRow(fx, "lc-m2", {
      jobStatus: "queued",
      turnStatus: "active",
      createdAt: "2026-01-01T00:00:00Z",
      broken: false,
    });
    const worker = await registeredWorker(fx, { name: "sweep-cancel-worker" });
    await claimCoordinatorJob(fx, worker);
    // The executor died and the turn ended: only the sweep can end the job.
    await fx.pgDatabase.query(
      `update bakery.conversation_turns set status = 'failed' where id = $1`,
      [row.turnId],
    );
    const swept = await sweepCoordinatorTurnJobs(fx.runtimePgDatabase, 50, {
      onCancelRequested: async (job) => {
        await pushCoordinatorCancelToWorker(fx.runtimePgDatabase, job);
      },
    });
    assertEquals(swept.orphansCanceled, 1);
    const state = await sweepState(fx, row);
    assertEquals([state.job, state.reservation], ["canceled", "released"]);
    assertEquals(
      (await fx.pgDatabase.query<{ type: string }>(
        `select command.command_type as type
           from bakery.worker_commands command
           join bakery.job_attempts attempt
             on attempt.organization_id = command.organization_id
            and attempt.id = command.attempt_id
           join bakery.jobs job
             on job.organization_id = attempt.organization_id
            and job.id = attempt.job_id
          where job.conversation_turn_id = $1`,
        [row.turnId],
      )).rows,
      [{ type: "cancel" }],
    );
  }));
