import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { upDurableCoreStack } from "../helpers/durable-core/stack.ts";
import { killOwnedSystemdUnit } from "../helpers/owned-process-group.ts";
import {
  assertWorkerRunning,
  fileExists,
  implementJobId,
  launchPresetWorker,
  provisionDelegatedCgroupV2,
  removePaths,
  seedPresetWorld,
  startPresetTaskRun,
  stopPresetWorker,
  until,
  waitForTerminalRun,
} from "../helpers/durable-core/preset-stack.ts";
import type { DurableCoreStack } from "../helpers/durable-core/stack.ts";

type AttemptRow = {
  id: string;
  attempt_no: number;
  status: string;
  worker_session_id: string;
  worker_session_generation: string;
  worker_host_id: string;
};

const RECOVERY_DETAIL_PREFIX = "PRESET_RECOVERY_DETAIL:";

/**
 * The parent relays only the child's exit code, so a failed assertion names the
 * settled state itself. Ids, generations and idempotency keys only; never the
 * worker credential or the enrollment token.
 */
function reportDetail(detail: Record<string, unknown>): void {
  console.error(`${RECOVERY_DETAIL_PREFIX}${JSON.stringify(detail)}`);
}

/** The heartbeat body a killed worker left in its state directory, if any. */
async function pendingHeartbeatLeftBehind(
  stateDir: string,
): Promise<Record<string, unknown> | null> {
  try {
    const registration = JSON.parse(
      await Deno.readTextFile(`${stateDir}/registration.json`),
    ) as {
      pendingHeartbeat?: {
        idempotencyKey?: string;
        body?: {
          workerSessionId?: string;
          workerSessionGeneration?: string;
        };
      };
    };
    const pending = registration.pendingHeartbeat;
    if (pending === undefined) return null;
    return {
      idempotencyKey: pending.idempotencyKey,
      workerSessionId: pending.body?.workerSessionId,
      workerSessionGeneration: pending.body?.workerSessionGeneration,
    };
  } catch (error) {
    return { unreadable: error instanceof Error ? error.name : "ERROR" };
  }
}

Deno.test({
  name:
    "a killed worker's held implement step is recovered once by the restarted worker",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let stack: DurableCoreStack | undefined;
    let lease:
      | Awaited<ReturnType<typeof provisionDelegatedCgroupV2>>
      | undefined;
    let worker: Awaited<ReturnType<typeof launchPresetWorker>> | undefined;
    const stateDirs: string[] = [];
    const scriptedDir = await Deno.makeTempDir({
      prefix: "bakery-preset-recovery-",
    });
    try {
      stack = await upDurableCoreStack("preset-recovery", {
        jobCompletionTimeout: "30s",
      });
      lease = await provisionDelegatedCgroupV2("bakery-preset-recovery-");
      const world = await seedPresetWorld(stack);
      worker = await launchPresetWorker(stack, world, {
        cgroupRoot: lease.root,
        scriptedHarnessDir: scriptedDir,
      });
      stateDirs.push(worker.stateDir);
      const run = await startPresetTaskRun(stack, world, {
        title: "Recovery after worker kill",
      });
      const jobId = await implementJobId(stack, world, run);
      const firstWorker = worker;
      await until(
        "implement held by the first worker",
        90_000,
        async () =>
          (await fileExists(`${scriptedDir}/${jobId}.started`))
            ? true
            : undefined,
        () => assertWorkerRunning(firstWorker),
      );
      const before = await stack.psql<AttemptRow>(
        `select id, attempt_no, status, worker_session_id,
                worker_session_generation::text as worker_session_generation,
                worker_host_id
           from bakery.job_attempts
          where organization_id = $1 and job_id = $2
          order by attempt_no`,
        [world.organizationId, jobId],
      );
      assertEquals(before.length, 1);

      // SIGKILL: no drain, no shutdown receipt, the attempt is left leased.
      await killOwnedSystemdUnit(firstWorker.unit);
      await Deno.remove(`${scriptedDir}/${jobId}.started`);
      const pendingAtRelaunch = await pendingHeartbeatLeftBehind(
        firstWorker.stateDir,
      );

      // The same registered worker identity restarts from its persisted state.
      worker = await launchPresetWorker(stack, world, {
        cgroupRoot: lease.root,
        scriptedHarnessDir: scriptedDir,
        stateDir: firstWorker.stateDir,
        tokenPath: firstWorker.tokenPath,
        name: firstWorker.name,
      });
      const restarted = worker;
      await until(
        "implement held again by the restarted worker",
        180_000,
        async () =>
          (await fileExists(`${scriptedDir}/${jobId}.started`))
            ? true
            : undefined,
        () => assertWorkerRunning(restarted),
      );
      const mid = await stack.psql<AttemptRow>(
        `select id, attempt_no, status, worker_session_id,
                worker_session_generation::text as worker_session_generation,
                worker_host_id
           from bakery.job_attempts
          where organization_id = $1 and job_id = $2
          order by attempt_no`,
        [world.organizationId, jobId],
      );
      try {
        assert(mid.length >= 2, "the restarted worker took a new attempt");
        assertNotEquals(
          mid.at(-1)!.worker_session_id,
          before[0].worker_session_id,
        );
        assertNotEquals(mid.at(-1)!.id, before[0].id);
      } catch (error) {
        const host = await stack.psql<{
          worker_session_id: string | null;
          worker_session_generation: string;
        }>(
          `select worker_session_id,
                  worker_session_generation::text as worker_session_generation
             from bakery.worker_hosts
            where organization_id = $1 and id = $2`,
          [world.organizationId, before[0].worker_host_id],
        ).catch(() => []);
        reportDetail({
          restart: {
            killedSessionId: before[0].worker_session_id,
            pendingAtRelaunch,
            host: host[0] ?? null,
            attempts: mid,
          },
        });
        throw error;
      }

      await Deno.writeTextFile(`${scriptedDir}/${jobId}.release`, "release\n");
      const terminal = await waitForTerminalRun(
        stack,
        world,
        run,
        120_000,
        () => assertWorkerRunning(restarted),
      );
      assertEquals(terminal.run_status, "completed");

      const completedAttempts = await stack.psql<{ count: string }>(
        `select count(*)::text as count from bakery.job_attempts
          where organization_id = $1 and job_id = $2 and status = 'completed'`,
        [world.organizationId, jobId],
      );
      assertEquals(completedAttempts[0].count, "1");
      const implement = await stack.psql<{ status: string; output: unknown }>(
        `select status, output from bakery.run_steps
          where organization_id = $1 and id = $2`,
        [world.organizationId, run.implementStepId],
      );
      assertEquals(implement[0].status, "completed");
      const patches = await stack.psql<{ count: string }>(
        `select count(*)::text as count
           from bakery.artifact_versions version
           join bakery.artifacts artifact
             on artifact.organization_id = version.organization_id
            and artifact.id = version.artifact_id
          where version.organization_id = $1 and version.run_step_id = $2
            and artifact.artifact_type = 'patch'`,
        [world.organizationId, run.implementStepId],
      );
      assertEquals(patches[0].count, "1");
      const sessions = await stack.psql<{ count: string }>(
        `select count(*)::text as count from bakery.agent_sessions
          where organization_id = $1 and run_step_id = $2`,
        [world.organizationId, run.implementStepId],
      );
      assertEquals(sessions[0].count, "1");

      console.log(JSON.stringify({
        evidence: "FIXED_CODING_PRESET_RECOVERY_CONFIRMED",
        composeProject: stack.project,
        runId: run.runId,
        attempts: mid.length,
        completedAttempts: 1,
        patchArtifactVersions: 1,
        agentSessions: 1,
      }));
      await stopPresetWorker(restarted);
      worker = undefined;
      await lease.release();
      lease = undefined;
      await stack.down();
      stack = undefined;
    } finally {
      if (worker) await stopPresetWorker(worker).catch(() => undefined);
      await lease?.release().catch(() => undefined);
      await stack?.down().catch(() => undefined);
      await removePaths([scriptedDir, ...stateDirs]);
    }
  },
});
