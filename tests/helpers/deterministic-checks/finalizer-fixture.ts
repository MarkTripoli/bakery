import { assert, assertEquals, assertExists } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  type CheckPins,
  deriveCheckPins,
} from "../../../apps/server/src/modules/delivery/check-pins.ts";
import { finalizeQualityCheck } from "../../../apps/server/src/modules/delivery/finalize-quality-check.ts";
import type { WorkerIdentity } from "../../../apps/server/src/modules/execution/shared.ts";
import { sha256Bytes } from "../../../apps/server/src/modules/knowledge/bytes.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import {
  type ExecutionState,
  type JobSeed,
  readExecutionState,
  registeredWorker,
  type WorkerFixture,
} from "../worker-execution.ts";
import { seedEligibleNonmodelJob } from "../worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  postWorkerResult,
  type RegisteredWorker,
  resultBody,
  type WorkerAssignment,
} from "../worker-execution/scenarios.ts";
import {
  type CheckReportFixture,
  DEFAULT_COMMANDS,
  type EvidenceRef,
  type ExecutionContext,
  fixedPolicyContext,
  observationFor,
  type Outcome,
  type PolicyOptions,
  type Rejection,
  reportFrom,
} from "./finalizer-policy.ts";
import { HEAD_SHA, type ObservationFixture } from "./observations.ts";

/**
 * Real-Postgres fixture for the `quality.check` finalizer. A job is admitted
 * and claimed through the real worker routes (a strict-v1 profile, the only
 * kind a fixture can claim without the whole inspection chain), then its
 * stored input is replaced with the fixed-policy input admission would have
 * written. The finalizer reads only that stored input, so everything it
 * verifies is real: the job, the attempt and its fence, the run step and task
 * that own the evidence, the pinned rules and the unique indexes.
 */

export type {
  CheckCommand,
  CheckReportFixture,
  EvidenceRef,
  Outcome,
  Rejection,
} from "./finalizer-policy.ts";
export { DEFAULT_COMMANDS } from "./finalizer-policy.ts";

export type CheckRunRow = {
  id: string;
  organization_id: string;
  run_id: string;
  run_step_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  fence: string | null;
  check_id: string;
  kind: string;
  rule_key: string | null;
  result: string;
  reason: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_digest: string | null;
  evidence_version_id: string | null;
  head_sha: string;
  base_sha: string | null;
  profile_digest: string | null;
  policy_digest: string;
  subject_digest: string;
  checker_digest: string | null;
  title_digest: string | null;
  body_digest: string | null;
  merge_message_digest: string | null;
  commit_selection_digest: string | null;
};

export type CheckScenario = {
  readonly fixture: WorkerFixture;
  readonly worker: RegisteredWorker;
  readonly job: JobSeed;
  readonly assignment: WorkerAssignment;
  readonly context: ExecutionContext;
  readonly pins: CheckPins;
  readonly organizationId: string;
  readonly taskId: string;
  /** Publishes one immutable check artifact version of this job's run step. */
  evidence(name: string, text?: string): Promise<EvidenceRef>;
  /** An honest report; `outcomes` maps a command id to what it did (default pass). */
  honest(
    outcomes?: Record<string, Outcome>,
  ): Promise<{ report: CheckReportFixture; evidence: EvidenceRef[] }>;
  /** Runs the finalizer in a transaction of the application role. */
  finalize(result: unknown): Promise<void>;
  /** Posts the result through the real worker route. */
  post(result: unknown, key?: string): Promise<Response>;
  rows(): Promise<CheckRunRow[]>;
  /** Count of `delivery.checkRuns.record` audit entries for an accepted report. */
  audits(): Promise<number>;
  /** Details of the `denied` entries of a refused report, oldest first. */
  deniedAudits(): Promise<unknown[]>;
  state(): Promise<ExecutionState>;
};

export type ScenarioOptions = PolicyOptions & {
  /** Selected check ids; defaults to every command. */
  checks?: string[];
  revision?: string;
  /** Replaces the whole stored job input after the claim. */
  input?: (base: Record<string, unknown>) => Record<string, unknown>;
  /** Overrides the context stored in the job input (a tampered pin). */
  context?: (base: ExecutionContext) => unknown;
  /** How long ago the attempt began; the window durations must fit in. */
  attemptAge?: string;
};

/** Seeds, claims and rewrites one `quality.check` job; see the file comment. */
export async function seedCheckScenario(
  fixture: WorkerFixture,
  options: ScenarioOptions = {},
): Promise<CheckScenario> {
  const commands = options.commands ?? DEFAULT_COMMANDS;
  const checks = options.checks ?? commands.map(({ id }) => id);
  const worker = await registeredWorker(fixture, {
    name: `b1002-checks-${crypto.randomUUID()}`,
  });
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    {
      input: {
        repositoryId: crypto.randomUUID(),
        revision: options.revision ?? HEAD_SHA,
        checks,
      },
    },
  );
  const assignment = await claimAssignment(fixture, worker, {
    supportedActions: ["quality.check"],
  });
  assertEquals(assignment.jobId, job.jobId);
  const claimed = (assignment.input as Record<string, unknown>)
    .repositoryProfile as Record<string, unknown>;
  const context = await fixedPolicyContext({
    organizationId: String(claimed.organizationId),
    applicationId: String(claimed.applicationId),
    repositoryId: String(claimed.repositoryId),
    id: String(claimed.id),
    revision: Number(claimed.revision),
  }, options);
  const clean = {
    repositoryId: context.repositoryId,
    revision: options.revision ?? HEAD_SHA,
    checks,
    repositoryProfile: context,
  };
  const base = options.context
    ? { ...clean, repositoryProfile: options.context(context) }
    : clean;
  const stored = options.input ? options.input(base) : base;
  await fixture.pgDatabase.query(
    `update bakery.jobs set input = $3::jsonb
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, job.jobId, JSON.stringify(stored)],
  );
  await fixture.pgDatabase.query(
    `update bakery.job_attempts set created_at = created_at - $3::interval
      where organization_id = $1 and id = $2`,
    [
      fixture.organizationId,
      assignment.attemptId,
      options.attemptAge ?? "1 hour",
    ],
  );
  const taskRow = await fixture.pgDatabase.query<{ task_id: string }>(
    `select task_id from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, job.runId],
  );
  assertExists(taskRow.rows[0]);
  const taskId = taskRow.rows[0].task_id;
  // Pins come from the untampered input, so a case that tampers with the
  // stored job can still build the report an honest worker would send.
  const pins = await deriveCheckPins(clean);
  const scenario: CheckScenario = {
    fixture,
    worker,
    job,
    assignment,
    context,
    pins,
    organizationId: fixture.organizationId,
    taskId,
    async evidence(name, text = `{"check":"${name}"}`) {
      return await publishEvidence(fixture, {
        taskId,
        runStepId: job.runStepId,
        name,
        text,
      });
    },
    async honest(outcomes = {}) {
      const evidence: EvidenceRef[] = [];
      const observations: ObservationFixture[] = [];
      for (const pin of this.pins.commands) {
        const ref = await this.evidence(
          `check-${job.jobId}-${assignment.fence}-${pin.checkId}.json`,
          `{"check":"${pin.checkId}","outcome":"${
            outcomes[pin.checkId] ?? "pass"
          }"}`,
        );
        evidence.push(ref);
        observations.push(
          observationFor(pin, outcomes[pin.checkId] ?? "pass", ref),
        );
      }
      return { report: reportFrom(this.pins, observations), evidence };
    },
    async finalize(result) {
      const attempt = await loadAttempt(fixture, assignment.attemptId);
      const host = await fixture.pgDatabase.query(
        "select * from bakery.worker_hosts where id = $1",
        [attempt.worker_host_id],
      );
      assertExists(host.rows[0]);
      await withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) =>
          finalizeQualityCheck(transaction, {
            attempt,
            identity: {
              tokenHash: "",
              host: host.rows[0] as unknown as WorkerIdentity["host"],
            },
            jobId: job.jobId,
            resultPayload: result,
            metadata: {
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
            },
          }),
      );
    },
    post(result, key = crypto.randomUUID()) {
      return postWorkerResult(
        fixture,
        worker,
        assignment,
        resultBody(assignment, { result: result as Record<string, unknown> }),
        key,
      );
    },
    async rows() {
      const result = await fixture.pgDatabase.query<CheckRunRow>(
        `select id, organization_id, run_id, run_step_id, job_id, attempt_id,
                fence::text, check_id, kind, rule_key, result, reason,
                exit_code, duration_ms, output_digest, evidence_version_id,
                head_sha, base_sha, profile_digest, policy_digest,
                subject_digest, checker_digest, title_digest, body_digest,
                merge_message_digest, commit_selection_digest
           from bakery.check_runs
          where organization_id = $1 and job_id = $2`,
        [fixture.organizationId, job.jobId],
      );
      // One transaction writes every row of a report at one instant, so the
      // job's own selection order is the only meaningful order to read them in.
      const position = (checkId: string) => pins.checks.indexOf(checkId);
      return result.rows.sort((a, b) =>
        position(a.check_id) - position(b.check_id)
      );
    },
    async audits() {
      const result = await fixture.pgDatabase.query<{ count: string }>(
        `select count(*) from bakery.audit_events
          where organization_id = $1 and operation = 'delivery.checkRuns.record'
            and resource_type = 'job_attempt' and resource_id = $2
            and outcome = 'succeeded'`,
        [fixture.organizationId, assignment.attemptId],
      );
      return Number(result.rows[0]!.count);
    },
    async deniedAudits() {
      const result = await fixture.pgDatabase.query<{ details: unknown }>(
        `select details from bakery.audit_events
          where organization_id = $1 and operation = 'delivery.checkRuns.record'
            and resource_type = 'job_attempt' and resource_id = $2
            and outcome = 'denied'
          order by created_at, id`,
        [fixture.organizationId, assignment.attemptId],
      );
      return result.rows.map(({ details }) => details);
    },
    state() {
      return readExecutionState(fixture.pgDatabase, job.jobId);
    },
  };
  return scenario;
}

async function loadAttempt(fixture: WorkerFixture, attemptId: string) {
  const result = await fixture.pgDatabase.query<{
    id: string;
    organization_id: string;
    job_id: string;
    worker_host_id: string;
    worker_session_id: string;
    worker_session_generation: string;
    fence: string;
    lease_token_hash: string;
    lease_expires_at: Date;
    lease_expired: boolean;
    job_current_fence: string;
    status: string;
    last_event_seq: string;
  }>(
    `select attempt.id, attempt.organization_id, attempt.job_id,
            attempt.worker_host_id, attempt.worker_session_id,
            attempt.worker_session_generation::text, attempt.fence::text,
            attempt.lease_token_hash, attempt.lease_expires_at,
            attempt.lease_expires_at <= clock_timestamp() as lease_expired,
            job.current_fence::text as job_current_fence, attempt.status,
            attempt.last_event_seq::text
       from bakery.job_attempts attempt
       join bakery.jobs job on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
      where attempt.organization_id = $1 and attempt.id = $2`,
    [fixture.organizationId, attemptId],
  );
  assertExists(result.rows[0]);
  return result.rows[0];
}

/** Inserts an artifact and its one immutable version for the job's run step. */
export async function publishEvidence(
  fixture: WorkerFixture,
  input: {
    taskId: string;
    runStepId: string | null;
    name: string;
    text: string;
  },
): Promise<EvidenceRef> {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const content = new TextEncoder().encode(input.text);
  const sha256 = await sha256Bytes(content);
  await fixture.pgDatabase.query(
    `insert into bakery.artifacts
       (id, organization_id, task_id, artifact_type, name)
     values ($1, $2, $3, 'check', $4)`,
    [artifactId, fixture.organizationId, input.taskId, input.name],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions
       (id, organization_id, artifact_id, task_id, run_step_id, author_id,
        revision, content, sha256, size_bytes, media_type)
     values ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 'application/json')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      input.taskId,
      input.runStepId,
      fixture.principalId,
      content,
      sha256,
      content.length,
    ],
  );
  await fixture.pgDatabase.query(
    `update bakery.artifacts set current_version_id = $1, revision = 2
      where id = $2`,
    [versionId, artifactId],
  );
  return { artifactId, versionId, sha256 };
}

/** Marks an artifact version purged the way the retention collector does. */
export async function purgeEvidence(
  fixture: WorkerFixture,
  versionId: string,
): Promise<void> {
  await fixture.pgDatabase.query(
    `update bakery.artifact_versions
        set content = null, purged_at = now(), purge_policy = 'retention-v1'
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, versionId],
  );
}

/** Rows of every job of the organization; used to prove nothing was written. */
export async function organizationCheckRunCount(
  fixture: WorkerFixture,
  organizationId = fixture.organizationId,
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ count: string }>(
    "select count(*) from bakery.check_runs where organization_id = $1",
    [organizationId],
  );
  return Number(result.rows[0]!.count);
}

/**
 * Asserts the finalizer refuses `result` with the given problem code and
 * reason, and that the refusal left nothing behind: no row, no audit entry.
 * Called directly, the finalizer throws and its transaction rolls back whole;
 * the denied audit entry of a refusal belongs to the route (see
 * `finalizeOrDenyQualityCheck`).
 */
export async function assertFinalizerRejects(
  scenario: CheckScenario,
  result: unknown,
  expected: Rejection,
): Promise<void> {
  let thrown: unknown;
  try {
    await scenario.finalize(result);
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof StandardError,
    `expected a StandardError, got ${String(thrown)}`,
  );
  assertEquals(thrown.code, expected.code);
  assertEquals(thrown.params?.reason, expected.reason);
  assertEquals(await scenario.rows(), []);
  assertEquals(await scenario.audits(), 0);
  assertEquals(await scenario.deniedAudits(), []);
}
