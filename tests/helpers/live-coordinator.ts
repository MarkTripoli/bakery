import { assert, assertEquals } from "@std/assert";
import { type WorkerFx } from "./coordinator-turn-jobs-worker.ts";
import {
  billing as defaultBilling,
  cleanupCoordinatorScopes,
  policy,
  type ScopeSeed,
  seedConversation,
} from "./coordinator-turn-jobs.ts";
import { seedProviderPricingSnapshot } from "./funded-model-job.ts";
import type { Seed } from "./coordinator-turns.ts";
import {
  claimAssignment,
  postWorkerResult,
  resultBody,
  type WorkerAssignment,
} from "./worker-execution/scenarios.ts";
import { registeredWorker, workerRequest } from "./worker-execution.ts";
import { withWorkerFixture } from "./worker-execution/scenarios.ts";
import {
  claimNextTurn,
  executeClaimedTurn,
  type ProcessResult,
} from "../../apps/server/src/modules/conversation/turn-runtime.ts";
import {
  type CoordinatorTurnExecutor,
} from "../../apps/server/src/modules/conversation/coordinator.ts";
import {
  createWorkerCoordinatorExecutor,
  type WorkerCoordinatorOptions,
} from "../../apps/server/src/modules/conversation/coordinator-worker.ts";
import type { BillingConfig } from "../../packages/contracts/src/contracts.ts";
import type { PgDatabase } from "../../packages/persistence/src/postgres.ts";

export { policy };

export type Worker = Awaited<ReturnType<typeof registeredWorker>>;

export type Live = Readonly<{
  fx: WorkerFx;
  seed: Seed;
  scope: ScopeSeed;
  taskId: string;
  agentVersionId: string;
}>;

/** Worker fixture whose live-coordinator rows are removed before the org delete. */
export function withLiveWorker(
  work: (fixture: WorkerFx) => Promise<void>,
): Promise<void> {
  return withWorkerFixture(async (fixture) => {
    try {
      await work(fixture);
    } finally {
      const params = [fixture.organizationId];
      await fixture.pgDatabase.query(
        `delete from bakery.questions where organization_id = $1`,
        params,
      );
      await fixture.pgDatabase.query(
        `delete from bakery.plan_revisions where organization_id = $1`,
        params,
      );
      await cleanupCoordinatorScopes(
        fixture.pgDatabase,
        fixture.organizationId,
      );
      await fixture.pgDatabase.query(
        `delete from bakery.agent_sessions where organization_id = $1`,
        params,
      );
    }
  });
}

/**
 * Conversation, task (approval policy as given) and an enabled coordinator
 * agent with a claude_code config inside the worker fixture's organization.
 */
export async function seedLive(
  fx: WorkerFx,
  label: string,
  options: {
    policy?: Record<string, unknown>;
    billing?: BillingConfig;
  } = {},
): Promise<Live> {
  const scope = await seedConversation(
    fx.pgDatabase,
    fx.organizationId,
    fx.principalId,
    label,
  );
  const billing = options.billing ?? defaultBilling;
  await seedProviderPricingSnapshot(fx.pgDatabase, { billing });
  const agentId = crypto.randomUUID();
  const agentVersionId = crypto.randomUUID();
  await fx.pgDatabase.query(
    `insert into bakery.agent_definitions (id, organization_id, slug, name, enabled)
     values ($1, $2, 'coordinator', 'Coordinator', true)`,
    [agentId, fx.organizationId],
  );
  await fx.pgDatabase.query(
    `insert into bakery.agent_versions (id, organization_id, agent_id, revision, config, digest, created_by)
     values ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
    [
      agentVersionId,
      fx.organizationId,
      agentId,
      JSON.stringify({
        harness: "claude_code",
        billing,
        allowedCapabilities: ["model"],
      }),
      `digest-${agentVersionId}`,
      fx.principalId,
    ],
  );
  await fx.pgDatabase.query(
    `update bakery.agent_definitions set active_version_id = $3
      where organization_id = $1 and id = $2`,
    [fx.organizationId, agentId, agentVersionId],
  );
  const taskId = crypto.randomUUID();
  await fx.pgDatabase.query(
    `insert into bakery.tasks (id, organization_id, application_id, conversation_id, title,
       description, task_type, status, created_by, approval_policy)
     values ($1, $2, $3, $4, 'Live coordinator task', 'live coordinator fixture',
             'feature', 'queued', $5, $6::jsonb)`,
    [
      taskId,
      fx.organizationId,
      scope.applicationId,
      scope.conversationId,
      fx.principalId,
      JSON.stringify(options.policy ?? { plan: "human_approval" }),
    ],
  );
  const seed: Seed = {
    organizationId: fx.organizationId,
    principalId: fx.principalId,
    cookie: fx.adminCookie,
    applicationId: scope.applicationId,
    repositoryId: scope.repositoryId,
    conversationId: scope.conversationId,
    agentVersionId,
  };
  return { fx, seed, scope, taskId, agentVersionId };
}

export function workerExecutor(
  fx: WorkerFx,
  options: Partial<WorkerCoordinatorOptions> = {},
): CoordinatorTurnExecutor {
  return createWorkerCoordinatorExecutor({
    database: fx.runtimePgDatabase,
    budget: policy,
    claimTimeoutMs: 5_000,
    turnTimeoutMs: 20_000,
    pollMs: 20,
    ...options,
  });
}

export const MODEL_OUTPUT = {
  model: "claude-opus-5-5",
  claudeCodeVersion: "2.1.296",
} as const;

export const PLAN_STEPS = [{
  id: "s1",
  title: "Do the work",
  detail: "Exactly as described.",
}];

export const QUESTION_EFFECT = {
  type: "question",
  prompt: "Which database?",
  options: [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }],
} as const;

export function planEffect(title: string) {
  return { type: "planRevision", title, steps: PLAN_STEPS } as const;
}

export type StartedTurn = Readonly<{
  turnId: string;
  claimVersion: number;
  run: Promise<ProcessResult>;
}>;

const LEASE_RENEWAL = /\bset\s+lease_expires_at\b/;

export type HeldLeaseRenewals = Readonly<{
  /** Pool to hand to `startTurn`; only its lease renewals wait on `release`. */
  database: PgDatabase;
  /** Resolves once `count` renewals are parked: the executor is mid-run and due to beat. */
  parked(count?: number): Promise<void>;
  /** Lets every parked and later renewal reach the database. */
  release(): void;
  /** Releases on scope exit, so a failed assertion never leaves renewals parked. */
  [Symbol.dispose](): void;
}>;

/**
 * Wraps `database` so the executor's lease renewals park before they touch the
 * row. A test then decides when a beat may land, instead of racing a short
 * heartbeat timer against its own claim.
 */
export function holdLeaseRenewals(database: PgDatabase): HeldLeaseRenewals {
  const open = Promise.withResolvers<void>();
  let parked = 0;
  const held = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "query") return value.bind(target);
      return async (...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === "string"
          ? first
          : (first as { text?: string } | undefined)?.text;
        if (text !== undefined && LEASE_RENEWAL.test(text)) {
          parked++;
          await open.promise;
        }
        return await value.apply(target, args);
      };
    },
  });
  return {
    database: held,
    async parked(count = 1) {
      await until(
        () => Promise.resolve(parked >= count),
        "a parked lease renewal",
      );
    },
    release: () => open.resolve(),
    [Symbol.dispose]: () => open.resolve(),
  };
}

/** True once the turn's lease is past on the database clock. */
export async function leaseExpired(
  fx: WorkerFx,
  turnId: string,
): Promise<boolean> {
  const row = (await fx.pgDatabase.query<{ expired: boolean }>(
    `select coalesce(lease_expires_at < clock_timestamp(), true) as expired
       from bakery.conversation_turns where id = $1`,
    [turnId],
  )).rows[0];
  return row?.expired === true;
}

/** Claims the oldest queued turn and starts executing it with `executor`. */
export async function startTurn(
  live: Live,
  executor: CoordinatorTurnExecutor,
  options: {
    leaseMs?: number;
    heartbeatMs?: number;
    /** Pool the running turn heartbeats and applies through; the claim uses the runtime pool. */
    database?: PgDatabase;
  } = {},
): Promise<StartedTurn> {
  const identity = {
    organizationId: live.seed.organizationId,
    conversationId: live.seed.conversationId,
  };
  const claim = await claimNextTurn(live.fx.runtimePgDatabase, {
    ...identity,
    leaseMs: options.leaseMs ?? 60_000,
  });
  assertEquals(claim.kind, "claimed");
  if (claim.kind !== "claimed") throw new Error("turn not claimed");
  return {
    turnId: claim.turnId,
    claimVersion: claim.claimVersion,
    run: executeClaimedTurn(
      {
        database: options.database ?? live.fx.runtimePgDatabase,
        executor,
        leaseMs: options.leaseMs ?? 60_000,
        heartbeatMs: options.heartbeatMs ?? 100,
      },
      { ...identity, turnId: claim.turnId, claimVersion: claim.claimVersion },
    ),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once `check` returns a value, or fails after `timeoutMs`. */
export async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Simulated worker: claims the next coordinator job, once one is queued. */
export async function claimCoordinatorJob(
  fx: WorkerFx,
  worker: Worker,
): Promise<WorkerAssignment> {
  return await until(async () => {
    const claimKey = crypto.randomUUID();
    const response = await workerRequest(
      fx,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: ["model"],
        supportedActions: ["coordinator.turn"],
      },
      { idempotencyKey: claimKey },
    );
    if (response.status === 200) {
      return await response.json() as WorkerAssignment;
    }
    await response.body?.cancel();
    return null;
  }, "a coordinator job to claim");
}

export function fault(code: string) {
  return {
    type: "about:blank",
    title: "Coordinator turn failed",
    status: 503,
    detail: "worker fault",
    code,
    requestId: crypto.randomUUID(),
    retryable: false,
  };
}

/** Posts the terminal result of a claimed coordinator job as the worker. */
export async function postOutcome(
  fx: WorkerFx,
  worker: Worker,
  assignment: WorkerAssignment,
  outcome:
    | { effects: readonly unknown[] }
    | { faultCode: string },
): Promise<void> {
  const body = "faultCode" in outcome
    ? resultBody(assignment, {
      status: "failed",
      fault: fault(outcome.faultCode),
    })
    : resultBody(assignment, {
      result: { ...MODEL_OUTPUT, effects: outcome.effects },
    });
  const response = await postWorkerResult(
    fx,
    worker,
    assignment,
    body,
    crypto.randomUUID(),
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
}

/** Claims the coordinator job and posts `outcome`; returns the assignment. */
export async function workerAnswers(
  fx: WorkerFx,
  worker: Worker,
  outcome: Parameters<typeof postOutcome>[3],
): Promise<WorkerAssignment> {
  const assignment = await claimCoordinatorJob(fx, worker);
  await postOutcome(fx, worker, assignment, outcome);
  return assignment;
}

export { claimAssignment, registeredWorker };
