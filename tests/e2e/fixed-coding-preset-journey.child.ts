import { assert, assertEquals } from "@std/assert";
import { upDurableCoreStack } from "../helpers/durable-core/stack.ts";
import {
  postJson,
  responseJson,
} from "../helpers/durable-core/engine-admission.ts";
import {
  assertWorkerRunning,
  fileExists,
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
import {
  ownedProcessGroup,
  terminateProcessGroup,
} from "./helpers/process-group.ts";

/*
 * Owner-role SQL in this journey, each with no application write path:
 * - provider_pricing_snapshots: pricing is operator authority and `bakery_app`
 *   can only read it (migration 0064); `seedPresetWorld` seeds one snapshot.
 * - The `createSuperuser` bootstrap inside `authenticatedClients`: the stack
 *   has no sign-up path.
 * Everything else (application, agent, version, repository, profile, tasks,
 * dependency, runs, controls) goes through the real API, and the browser only
 * ever talks to the API through the web dev server's proxy.
 */

const BUDGET_LIMIT_USD = "0.10";
const BROWSER_TIMEOUT_MS = 300_000;

type Vite = { origin: string; stop: () => Promise<void> };

/**
 * Serves a production build through `vite preview`. The unbundled dev server
 * answers each hard load with hundreds of module requests, and Chromium then
 * fails some with ERR_INSUFFICIENT_RESOURCES,
 * leaving a blank page on deep links and reloads.
 */
async function startVite(serverOrigin: string): Promise<Vite> {
  const outDir = await Deno.makeTempDir({ prefix: "bakery-journey-web-" });
  const build = await new Deno.Command("pnpm", {
    args: [
      "--dir",
      "apps/web",
      "exec",
      "vite",
      "build",
      "--mode",
      "test",
      "--outDir",
      outDir,
      "--emptyOutDir",
    ],
    stdout: "null",
    stderr: "inherit",
  }).output();
  if (!build.success) {
    await Deno.remove(outDir, { recursive: true });
    throw new Error("JOURNEY_WEB_BUILD_FAILED");
  }
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const origin = `http://127.0.0.1:${port}`;
  const command = new Deno.Command("setsid", {
    args: [
      "pnpm",
      "--dir",
      "apps/web",
      "exec",
      "vite",
      "preview",
      "--outDir",
      outDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    env: {
      ...Deno.env.toObject(),
      BAKERY_SERVER_PORT: new URL(serverOrigin).port,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const group = ownedProcessGroup(command);
  const stdout = new Response(command.stdout).text();
  const stderr = new Response(command.stderr).text();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await terminateProcessGroup(group);
    await Promise.all([stdout, stderr]);
    await Deno.remove(outDir, { recursive: true }).catch(() => undefined);
  };
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        if ((await fetch(origin)).ok) return { origin, stop };
      } catch {
        // Vite is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("JOURNEY_VITE_NOT_READY");
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The stack as the browser sees it: every request enters through Vite. */
function throughWebServer(stack: DurableCoreStack, origin: string) {
  const target = new URL(origin);
  return {
    ...stack,
    origin,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      url.protocol = target.protocol;
      url.host = target.host;
      const headers = new Headers(request.headers);
      if (headers.has("origin")) headers.set("origin", origin);
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.clone().arrayBuffer();
      return await fetch(
        new Request(url, { method: request.method, headers, body }),
      );
    },
  } satisfies DurableCoreStack;
}

async function presetRun(
  stack: DurableCoreStack,
  world: PresetWorld,
  taskId: string,
  runId: string,
): Promise<PresetRun> {
  const rows = await stack.psql<{ id: string; step_key: string }>(
    `select id, step_key from bakery.run_steps
      where organization_id = $1 and run_id = $2`,
    [world.organizationId, runId],
  );
  const stepId = (key: string): string => {
    const found = rows.find((row) => row.step_key === key)?.id;
    assert(found, `step ${key} missing`);
    return found;
  };
  return {
    taskId,
    runId,
    briefStepId: stepId("brief"),
    implementStepId: stepId("implement"),
  };
}

async function main() {
  let stack: DurableCoreStack | undefined;
  let vite: Vite | undefined;
  let lease:
    | Awaited<ReturnType<typeof provisionDelegatedCgroupV2>>
    | undefined;
  let worker: Awaited<ReturnType<typeof launchPresetWorker>> | undefined;
  let workerStateDir = "";
  const harnessDir = await Deno.makeTempDir({
    prefix: "bakery-preset-journey-",
  });
  try {
    stack = await upDurableCoreStack("preset-journey", {
      jobCompletionTimeout: "30s",
    });
    vite = await startVite(stack.origin);
    // The browser origin is the public web URL; keep the normal origin guard.
    await stack.restartServer({ BAKERY_PUBLIC_BASE_URL: vite.origin });
    const web = throughWebServer(stack, vite.origin);
    lease = await provisionDelegatedCgroupV2("bakery-preset-journey-");
    const world = await seedPresetWorld(web);
    worker = await launchPresetWorker(web, world, {
      cgroupRoot: lease.root,
      serverUrl: stack.origin,
      scriptedHarnessDir: harnessDir,
      slots: 4,
    });
    const liveWorker = worker;
    workerStateDir = worker.stateDir;
    const baseInput = {
      baseUrl: vite.origin,
      sessionCookie: world.clients.producer.cookie ?? "",
      organizationId: world.organizationId,
      repositoryId: world.repositoryId,
      budgetLimitUsd: BUDGET_LIMIT_USD,
      harnessDir,
    };
    const browser = async (
      phase: string,
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const child = new Deno.Command("node", {
        args: ["apps/web/tests/helpers/fixed-coding-journey-browser.mjs"],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The browser driver already exited.
        }
      }, BROWSER_TIMEOUT_MS);
      try {
        const writer = child.stdin.getWriter();
        await writer.write(
          new TextEncoder().encode(
            JSON.stringify({ ...baseInput, ...input, phase }),
          ),
        );
        await writer.close();
        const [status, out, err] = await Promise.all([
          child.status,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assertEquals(
          status.code,
          0,
          `JOURNEY_BROWSER_PHASE_FAILED:${phase}:${status.code}\n${err}\n${out}`,
        );
        const line = out.split("\n").find((value) =>
          value.startsWith("JOURNEY_RESULT=")
        );
        assert(line, `JOURNEY_RESULT missing for ${phase}`);
        console.log(`JOURNEY_PHASE=${phase}:passed`);
        return JSON.parse(line.slice("JOURNEY_RESULT=".length));
      } finally {
        clearTimeout(timer);
      }
    };
    const started = async (run: PresetRun): Promise<string> => {
      const jobId = await implementJobId(web, world, run);
      await until(
        `scripted harness started ${jobId}`,
        90_000,
        async () =>
          (await fileExists(`${harnessDir}/${jobId}.started`))
            ? true
            : undefined,
        () => assertWorkerRunning(liveWorker),
      );
      return jobId;
    };
    const release = async (jobId: string) =>
      await Deno.writeTextFile(`${harnessDir}/${jobId}.release`, "release\n");
    const terminal = (run: PresetRun) =>
      waitForTerminalRun(
        web,
        world,
        run,
        120_000,
        () => assertWorkerRunning(liveWorker),
      );

    // Cases 1-4, desktop: submit with a lost run response, progress,
    // reconnect, artifact.
    const title = `Journey ${crypto.randomUUID().slice(0, 8)}`;
    const description = "Add a <b>health</b> endpoint & test it.\nSecond line.";
    const submitted = await browser("submit", { title, description });
    const primary = await presetRun(
      web,
      world,
      String(submitted.taskId),
      String(submitted.runId),
    );
    const counts = await web.psql<{ tasks: string; runs: string }>(
      `select (select count(*) from bakery.tasks
                where organization_id = $1 and title = $2)::text as tasks,
              (select count(*) from bakery.workflow_runs
                where organization_id = $1 and task_id = $3)::text as runs`,
      [world.organizationId, title, primary.taskId],
    );
    assertEquals(counts[0], { tasks: "1", runs: "1" });
    const mainJob = await started(primary);
    const progress = await browser("progress", {
      taskId: primary.taskId,
      runId: primary.runId,
    });
    const reconnect = await browser("reconnect", {
      taskId: primary.taskId,
      runId: primary.runId,
      jobId: mainJob,
    });
    assertEquals(reconnect.status, "completed");
    assertEquals(await terminal(primary), {
      run_status: "completed",
      task_status: "completed",
    });
    const artifact = await browser("artifact", {
      taskId: primary.taskId,
      runId: primary.runId,
    });

    // Case 5: cancel races completion; the UI equals the API winner.
    const raced = await startPresetTaskRun(web, world, { title: "Race" });
    const raceJob = await started(raced);
    const race = await browser("race", {
      taskId: raced.taskId,
      runId: raced.runId,
      jobId: raceJob,
    });
    const raceFinal = await runAndTaskStatus(web, world, raced);
    assertEquals(raceFinal.run_status, race.winner);

    // Case 6: a run that depends on an incomplete task stays blocked.
    const prerequisite = await startPresetTaskRun(web, world, {
      title: "Prerequisite",
    });
    const prerequisiteJob = await started(prerequisite);
    const dependentTask = await responseJson(
      await postJson(
        world.clients.producer,
        "/v1/tasks",
        {
          applicationId: world.applicationId,
          repositoryId: world.repositoryId,
          repositoryProfileId: world.repositoryProfileId,
          taskType: "feature",
          title: "Dependent",
          description: "Waits for the prerequisite task.",
        },
        `journey-dependent-${crypto.randomUUID()}`,
      ),
      201,
      "DEPENDENT_TASK_CREATE",
    );
    const dependentId = String(dependentTask.id);
    await responseJson(
      await postJson(
        world.clients.producer,
        `/v1/tasks/${dependentId}/dependencies`,
        { dependsOnTaskId: prerequisite.taskId, condition: "completed" },
        `journey-dependency-${crypto.randomUUID()}`,
      ),
      201,
      "DEPENDENCY_CREATE",
    );
    const dependentRun = await responseJson(
      await postJson(
        world.clients.producer,
        `/v1/tasks/${dependentId}/runs`,
        {
          presetId: "fixed-coding",
          executionMode: "repository",
          repositoryProfileId: world.repositoryProfileId,
          budgetLimitUsd: "0.100000",
        },
        `journey-dependent-run-${crypto.randomUUID()}`,
      ),
      201,
      "DEPENDENT_RUN_CREATE",
    );
    assertEquals(dependentRun.status, "blocked");
    const blockedInput = {
      taskId: dependentId,
      runId: String(dependentRun.id),
    };
    await browser("blocked", blockedInput);
    await release(prerequisiteJob);
    assertEquals(await terminal(prerequisite), {
      run_status: "completed",
      task_status: "completed",
    });
    const stillBlocked = await browser("blocked", blockedInput);
    assertEquals(stillBlocked.status, "blocked");

    // Case 7: pause and resume are admitted and acknowledged in order.
    const controlled = await startPresetTaskRun(web, world, {
      title: "Pause and resume",
    });
    const controlledJob = await started(controlled);
    const pauseResume = await browser("pauseResume", {
      taskId: controlled.taskId,
      runId: controlled.runId,
    });
    const controlCommands = () =>
      web.psql<{
        action: string;
        status: string;
        acknowledged_at: string | null;
      }>(
        `select command.payload ->> 'controlAction' as action,
                command.status,
                command.acknowledged_at::text
           from bakery.worker_commands command
           join bakery.job_attempts attempt
             on attempt.organization_id = command.organization_id
            and attempt.id = command.attempt_id
          where command.organization_id = $1
            and attempt.job_id = $2
            and command.payload ->> 'controlAction' in ('pause', 'resume')
          order by command.created_at, command.id
          limit 3`,
        [world.organizationId, controlledJob],
      );
    const controlledDeadline = Date.now() + 120_000;
    const controlledRemaining = () =>
      Math.max(1, controlledDeadline - Date.now());
    try {
      assertEquals(pauseResume.paused, true);
      assertEquals(pauseResume.resumed, true);
      await until(
        `pause and resume acknowledged for ${controlled.runId}`,
        controlledRemaining(),
        async () => {
          const commands = await controlCommands();
          const rejected = commands.filter((command) =>
            command.status === "rejected"
          );
          assertEquals(
            rejected,
            [],
            `control command rejected: ${JSON.stringify(commands)}`,
          );
          if (commands.length < 2) return undefined;
          assertEquals(
            commands.map((command) => command.action),
            ["pause", "resume"],
            `control command order invalid: ${JSON.stringify(commands)}`,
          );
          return commands.every((command) =>
              command.status === "acknowledged" &&
              command.acknowledged_at !== null
            )
            ? commands
            : undefined;
        },
        () => assertWorkerRunning(liveWorker),
      );
      await release(controlledJob);
      const controlledFinal = await waitForTerminalRun(
        web,
        world,
        controlled,
        controlledRemaining(),
        () => assertWorkerRunning(liveWorker),
      );
      assertEquals(controlledFinal.run_status, "completed");
    } catch (error) {
      const [run, commands] = await Promise.all([
        runAndTaskStatus(web, world, controlled).catch((diagnosticError) => ({
          diagnostic_error: diagnosticError instanceof Error
            ? diagnosticError.message
            : String(diagnosticError),
        })),
        controlCommands().catch((diagnosticError) => [{
          diagnostic_error: diagnosticError instanceof Error
            ? diagnosticError.message
            : String(diagnosticError),
        }]),
      ]);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}:CONTROLLED_STATE:${JSON.stringify({ run, commands })}`,
        { cause: error },
      );
    }

    // Case 8: phone create, then reload and deep links.
    const phoneTitle = `Phone ${crypto.randomUUID().slice(0, 8)}`;
    const phoneCreated = await browser("phoneCreate", {
      viewport: "phone",
      title: phoneTitle,
      description,
    });
    const phone = await presetRun(
      web,
      world,
      String(phoneCreated.taskId),
      String(phoneCreated.runId),
    );
    await release(await started(phone));
    assertEquals((await terminal(phone)).run_status, "completed");
    const phoneReload = await browser("phoneReload", {
      viewport: "phone",
      taskId: phone.taskId,
      runId: phone.runId,
    });

    await stopPresetWorker(worker);
    worker = undefined;
    console.log(JSON.stringify({
      evidence: "FIXED_CODING_PRESET_JOURNEY_CONFIRMED",
      composeProject: stack.project,
      webOrigin: vite.origin,
      cases: {
        desktopSubmit: {
          taskId: primary.taskId,
          runId: primary.runId,
          counts: "1/1",
        },
        progress,
        reconnect,
        artifact,
        cancelRace: { runId: raced.runId, uiAndApiWinner: race.winner },
        blocked: stillBlocked,
        pauseResume,
        phone: { create: phoneCreated, reload: phoneReload },
      },
    }));
    await lease.release();
    lease = undefined;
    await vite.stop();
    vite = undefined;
    await stack.down();
    stack = undefined;
  } catch (error) {
    // Bounded server diagnostics help explain a failed browser phase.
    const text = await stack?.logs("server").catch(() => "");
    if (text) console.log(`SERVER_LOG_TAIL\n${text.slice(-6000)}`);
    const database = await stack?.logs("postgres").catch(() => "");
    const errors = (database ?? "").split("\n").filter((line) =>
      /ERROR|FATAL|DETAIL|STATEMENT/.test(line)
    ).join("\n");
    if (errors) console.log(`POSTGRES_ERRORS\n${errors.slice(-4000)}`);
    throw error;
  } finally {
    if (worker) await stopPresetWorker(worker).catch(() => undefined);
    await lease?.release().catch(() => undefined);
    await vite?.stop().catch(() => undefined);
    await stack?.down().catch(() => undefined);
    await removePaths([harnessDir, workerStateDir]);
  }
}

Deno.test({
  name: "fixed coding preset journey runs from the web app to a durable result",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: main,
});
