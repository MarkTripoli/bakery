import { assert, assertEquals } from "@std/assert";
import { upDurableCoreStack } from "../helpers/durable-core/stack.ts";
import { postJson } from "../helpers/durable-core/engine-admission.ts";
import {
  assertWorkerRunning,
  fileExists,
  HOSTILE_BRIEF_DESCRIPTION,
  implementJobId,
  launchPresetWorker,
  type PresetRun,
  type PresetWorld,
  provisionDelegatedCgroupV2,
  removePaths,
  runAndTaskStatus,
  seedPresetWorld,
  startPresetTaskRun,
  stopPresetWorker,
  until,
  waitForTerminalRun,
} from "../helpers/durable-core/preset-stack.ts";
import type { DurableCoreStack } from "../helpers/durable-core/stack.ts";

const CANCEL_RACE_ITERATIONS = 10;

type StepRow = {
  step_key: string;
  status: string;
  output: unknown;
  error: unknown;
};

async function steps(
  stack: DurableCoreStack,
  world: PresetWorld,
  run: PresetRun,
): Promise<Map<string, StepRow>> {
  const rows = await stack.psql<StepRow>(
    `select step_key, status, output, error from bakery.run_steps
      where organization_id = $1 and run_id = $2`,
    [world.organizationId, run.runId],
  );
  return new Map(rows.map((row) => [row.step_key, row]));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readHeaders(stack: DurableCoreStack, world: PresetWorld): Headers {
  return new Headers({
    origin: stack.origin,
    cookie: world.clients.consumer.cookie ?? "",
    "Bakery-Organization-Id": world.organizationId,
  });
}

async function waitForStart(
  dir: string,
  jobId: string,
  worker: Parameters<typeof assertWorkerRunning>[0],
): Promise<void> {
  await until(
    `scripted harness started ${jobId}`,
    90_000,
    async () =>
      (await fileExists(`${dir}/${jobId}.started`)) ? true : undefined,
    () => assertWorkerRunning(worker),
  );
}

async function release(dir: string, jobId: string): Promise<void> {
  await Deno.writeTextFile(`${dir}/${jobId}.release`, "release\n");
}

type ArtifactVersionRow = {
  id: string;
  artifact_type: string;
  name: string;
  sha256: string;
  media_type: string;
  run_step_id: string;
};

async function artifactVersions(
  stack: DurableCoreStack,
  world: PresetWorld,
  run: PresetRun,
): Promise<ArtifactVersionRow[]> {
  return await stack.psql<ArtifactVersionRow>(
    `select version.id, artifact.artifact_type, artifact.name,
            version.sha256, version.media_type, version.run_step_id
       from bakery.artifact_versions version
       join bakery.artifacts artifact
         on artifact.organization_id = version.organization_id
        and artifact.id = version.artifact_id
      where version.organization_id = $1
        and version.run_step_id = any($2::uuid[])
      order by version.created_at, version.id`,
    [world.organizationId, [run.briefStepId, run.implementStepId]],
  );
}

Deno.test({
  name:
    "fixed coding preset executes through real Inngest and the production worker",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let stack: DurableCoreStack | undefined;
    let lease:
      | Awaited<ReturnType<typeof provisionDelegatedCgroupV2>>
      | undefined;
    let scriptedWorker:
      | Awaited<ReturnType<typeof launchPresetWorker>>
      | undefined;
    let faultWorker:
      | Awaited<ReturnType<typeof launchPresetWorker>>
      | undefined;
    const stateDirs: string[] = [];
    const scriptedDir = await Deno.makeTempDir({
      prefix: "bakery-preset-scripted-",
    });
    try {
      stack = await upDurableCoreStack("preset-exec", {
        jobCompletionTimeout: "30s",
      });
      lease = await provisionDelegatedCgroupV2("bakery-preset-exec-");
      const world = await seedPresetWorld(stack);
      scriptedWorker = await launchPresetWorker(stack, world, {
        cgroupRoot: lease.root,
        scriptedHarnessDir: scriptedDir,
        slots: CANCEL_RACE_ITERATIONS,
      });
      const worker = scriptedWorker;
      stateDirs.push(worker.stateDir);

      // Completion: brief artifact, held implement, then the released patch.
      const completion = await startPresetTaskRun(stack, world, {
        title: "<script>Completion</script>",
      });
      const completionJob = await implementJobId(stack, world, completion);
      await waitForStart(scriptedDir, completionJob, worker);
      const held = await steps(stack, world, completion);
      assertEquals(held.get("brief")?.status, "completed");
      assertEquals(held.get("implement")?.status, "running");
      const session = await stack.psql<{ id: string; status: string }>(
        `select id, status from bakery.agent_sessions
          where organization_id = $1 and run_step_id = $2`,
        [world.organizationId, completion.implementStepId],
      );
      assertEquals(session.length, 1);
      await release(scriptedDir, completionJob);
      const completed = await waitForTerminalRun(
        stack,
        world,
        completion,
        120_000,
        () => assertWorkerRunning(worker),
      );
      assertEquals(completed, {
        run_status: "completed",
        task_status: "completed",
      });
      const done = await steps(stack, world, completion);
      assertEquals(done.get("brief")?.status, "completed");
      assertEquals(done.get("implement")?.status, "completed");
      const implementOutput = done.get("implement")?.output as {
        sessionId: string;
        artifacts: Array<{ versionId: string; sha256: string }>;
        headSha: string;
        baseSha: string;
      };
      assertEquals(implementOutput.sessionId, session[0].id);
      assertEquals(implementOutput.headSha.length, 40);
      const briefOutput = done.get("brief")?.output as {
        artifact: { versionId: string; sha256: string };
      };

      const versions = await artifactVersions(stack, world, completion);
      const briefVersions = versions.filter((row) =>
        row.run_step_id === completion.briefStepId
      );
      const patchVersions = versions.filter((row) =>
        row.run_step_id === completion.implementStepId
      );
      assertEquals(briefVersions.length, 1);
      assertEquals(patchVersions.length, 1);
      assertEquals(patchVersions[0].artifact_type, "patch");
      assertEquals(briefVersions[0].media_type, "application/json");
      assertEquals(briefVersions[0].id, briefOutput.artifact.versionId);
      assertEquals(patchVersions[0].id, implementOutput.artifacts[0].versionId);

      // The immutable brief round-trips through the byte boundary unchanged.
      const contentResponse = await stack.fetch(
        new Request(
          `${stack.origin}/v1/artifact-versions/${briefVersions[0].id}/content`,
          { headers: readHeaders(stack, world) },
        ),
      );
      assertEquals(contentResponse.status, 200);
      const briefBytes = new Uint8Array(await contentResponse.arrayBuffer());
      assertEquals(await sha256Hex(briefBytes), briefOutput.artifact.sha256);
      const brief = JSON.parse(new TextDecoder().decode(briefBytes));
      assertEquals(brief.schema, "bakery.task-brief/v1");
      assertEquals(brief.title, "<script>Completion</script>");
      assertEquals(brief.description, HOSTILE_BRIEF_DESCRIPTION);
      assertEquals(
        contentResponse.headers.get("x-content-type-options")?.toLowerCase(),
        "nosniff",
      );
      assert(
        contentResponse.headers.get("content-disposition")?.toLowerCase()
          .startsWith("attachment"),
        "brief must be served as an attachment",
      );
      assert(
        contentResponse.headers.get("content-security-policy")?.includes(
          "sandbox",
        ),
        "brief must carry a sandboxing CSP",
      );
      const briefDisposition = contentResponse.headers.get(
        "content-disposition",
      );
      const patchResponse = await stack.fetch(
        new Request(
          `${stack.origin}/v1/artifact-versions/${patchVersions[0].id}/content`,
          { headers: readHeaders(stack, world) },
        ),
      );
      assertEquals(patchResponse.status, 200);
      const patchBytes = new Uint8Array(await patchResponse.arrayBuffer());
      assertEquals(
        await sha256Hex(patchBytes),
        implementOutput.artifacts[0].sha256,
      );
      const patchDisposition = patchResponse.headers.get("content-disposition");
      assert(
        patchDisposition?.toLowerCase().startsWith("attachment"),
        `patch disposition ${patchDisposition}`,
      );
      assertEquals(
        patchResponse.headers.get("x-content-type-options")?.toLowerCase(),
        "nosniff",
      );

      // Cancel race: cancel and release fire together; the server picks one winner.
      const raceOnce = async (index: number) => {
        const run = await startPresetTaskRun(stack!, world, {
          title: `Cancel race ${index}`,
        });
        const jobId = await implementJobId(stack!, world, run);
        await waitForStart(scriptedDir, jobId, worker);
        const [control] = await Promise.all([
          postJson(
            world.clients.producer,
            `/v1/runs/${run.runId}/controls`,
            { action: "cancel", reason: `race ${index}` },
            `preset-cancel-${crypto.randomUUID()}`,
          ),
          release(scriptedDir, jobId),
        ]);
        const controlText = await control.text();
        const terminal = await waitForTerminalRun(
          stack!,
          world,
          run,
          120_000,
          () => assertWorkerRunning(worker),
        );
        return { run, control, controlText, terminal };
      };
      // Batches keep the single Inngest dev server from starving admissions.
      const outcomes: Awaited<ReturnType<typeof raceOnce>>[] = [];
      for (let start = 0; start < CANCEL_RACE_ITERATIONS; start += 5) {
        outcomes.push(
          ...await Promise.all(
            Array.from({ length: 5 }, (_, offset) => raceOnce(start + offset)),
          ),
        );
      }
      const concurrentWinners: Record<string, number> = {};
      const deterministicWinners: Record<string, number> = {};
      for (const { run, control, controlText, terminal } of outcomes) {
        concurrentWinners[terminal.run_status] =
          (concurrentWinners[terminal.run_status] ?? 0) + 1;
        assert(
          ["completed", "canceled"].includes(terminal.run_status),
          `run ${run.runId} ended ${terminal.run_status}`,
        );
        const rows = await steps(stack, world, run);
        const jobs = await stack.psql<{ status: string; attempts: string }>(
          `select job.status, count(attempt.id)::text as attempts
             from bakery.jobs job
             left join bakery.job_attempts attempt
               on attempt.organization_id = job.organization_id
              and attempt.job_id = job.id
            where job.organization_id = $1 and job.run_step_id = $2
            group by job.status`,
          [world.organizationId, run.implementStepId],
        );
        assertEquals(jobs.length, 1, "one implement job per run");
        const implement = rows.get("implement")!;
        if (terminal.run_status === "completed") {
          assertEquals(implement.status, "completed");
          assertEquals(jobs[0].status, "completed");
          assertEquals(terminal.task_status, "completed");
          // The cancel arrived after the winning result and was refused.
          assertEquals(control.status, 409, controlText);
          assert(
            controlText.includes("ALREADY_TERMINAL") ||
              controlText.includes("STATE_CONFLICT"),
            controlText,
          );
        } else {
          assertEquals(implement.status, "canceled");
          assertEquals(jobs[0].status, "canceled");
          assert(
            control.status >= 200 && control.status < 300,
            `cancel winner got ${control.status}: ${controlText}`,
          );
          assertEquals(terminal.task_status, "canceled");
        }
        const final = await runAndTaskStatus(stack, world, run);
        assertEquals(final, terminal, "terminal state is stable");
      }

      // Deterministic orders prove both winners the concurrent loop may not hit.
      const cancelRun = (run: PresetRun, reason: string) =>
        postJson(
          world.clients.producer,
          `/v1/runs/${run.runId}/controls`,
          { action: "cancel", reason },
          `preset-cancel-${crypto.randomUUID()}`,
        );
      const completionFirst = await startPresetTaskRun(stack, world, {
        title: "Completion first",
      });
      const completionFirstJob = await implementJobId(
        stack,
        world,
        completionFirst,
      );
      await waitForStart(scriptedDir, completionFirstJob, worker);
      await release(scriptedDir, completionFirstJob);
      const completionFirstTerminal = await waitForTerminalRun(
        stack,
        world,
        completionFirst,
        120_000,
        () => assertWorkerRunning(worker),
      );
      assertEquals(completionFirstTerminal, {
        run_status: "completed",
        task_status: "completed",
      });
      const lateCancel = await cancelRun(completionFirst, "after completion");
      const lateCancelText = await lateCancel.text();
      assertEquals(lateCancel.status, 409, lateCancelText);
      assert(lateCancelText.includes("ALREADY_TERMINAL"), lateCancelText);
      assertEquals(
        await runAndTaskStatus(stack, world, completionFirst),
        completionFirstTerminal,
      );
      deterministicWinners.completed = (deterministicWinners.completed ?? 0) +
        1;

      const cancelFirst = await startPresetTaskRun(stack, world, {
        title: "Cancel first",
      });
      const cancelFirstJob = await implementJobId(stack, world, cancelFirst);
      await waitForStart(scriptedDir, cancelFirstJob, worker);
      const earlyCancel = await cancelRun(cancelFirst, "before release");
      assert(
        earlyCancel.status >= 200 && earlyCancel.status < 300,
        await earlyCancel.text(),
      );
      await release(scriptedDir, cancelFirstJob);
      const cancelFirstTerminal = await waitForTerminalRun(
        stack,
        world,
        cancelFirst,
        120_000,
        () => assertWorkerRunning(worker),
      );
      assertEquals(cancelFirstTerminal, {
        run_status: "canceled",
        task_status: "canceled",
      });
      const cancelFirstSteps = await steps(stack, world, cancelFirst);
      assertEquals(cancelFirstSteps.get("implement")?.status, "canceled");
      deterministicWinners.canceled = (deterministicWinners.canceled ?? 0) + 1;
      assert(
        (deterministicWinners.completed ?? 0) >= 1 &&
          (deterministicWinners.canceled ?? 0) >= 1,
        `both winners required: ${JSON.stringify(deterministicWinners)}`,
      );

      await stopPresetWorker(scriptedWorker);
      scriptedWorker = undefined;

      // Production fault: no scripted harness, so implement fails honestly.
      faultWorker = await launchPresetWorker(stack, world, {
        cgroupRoot: lease.root,
      });
      stateDirs.push(faultWorker.stateDir);
      const fault = await startPresetTaskRun(stack, world, {
        title: "Production fault",
      });
      const faulted = await waitForTerminalRun(
        stack,
        world,
        fault,
        120_000,
        () => assertWorkerRunning(faultWorker!),
      );
      assertEquals(faulted.run_status, "failed");
      const faultSteps = await steps(stack, world, fault);
      assertEquals(faultSteps.get("brief")?.status, "completed");
      assertEquals(faultSteps.get("implement")?.status, "failed");
      assert(
        JSON.stringify(faultSteps.get("implement")?.error).includes(
          "DETERMINISTIC_EVIDENCE_UNAVAILABLE",
        ),
        JSON.stringify(faultSteps.get("implement")?.error),
      );
      const faultArtifacts = await artifactVersions(stack, world, fault);
      assertEquals(faultArtifacts.length, 1);
      assertEquals(faultArtifacts[0].run_step_id, fault.briefStepId);
      await stopPresetWorker(faultWorker);
      faultWorker = undefined;

      console.log(JSON.stringify({
        evidence: "FIXED_CODING_PRESET_EXECUTION_CONFIRMED",
        composeProject: stack.project,
        completionRunId: completion.runId,
        cancelRaceIterations: CANCEL_RACE_ITERATIONS,
        cancelRaceConcurrentWinners: concurrentWinners,
        cancelRaceDeterministicWinners: deterministicWinners,
        productionFaultRunId: fault.runId,
        productionWorkerCommand: "pnpm --filter @bakery/worker start",
        scriptedHarness: "test-only, gated on BAKERY_ENV=test",
        briefDisposition,
        patchDisposition,
      }));
      await lease.release();
      lease = undefined;
      await stack.down();
      stack = undefined;
    } finally {
      for (const handle of [scriptedWorker, faultWorker]) {
        if (handle) await stopPresetWorker(handle).catch(() => undefined);
      }
      await lease?.release().catch(() => undefined);
      await stack?.down().catch(() => undefined);
      await removePaths([scriptedDir, ...stateDirs]);
    }
  },
});
