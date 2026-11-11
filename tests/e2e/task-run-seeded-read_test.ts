import { assertRunArchiveAcceptance } from "./helpers/run-archive-acceptance.ts";
import { seedRunRepositoryScope } from "./helpers/run-output-scope-seed.ts";
import { seedRunOutput } from "./helpers/run-output-seed.ts";
import { configureRunOutputState } from "./helpers/run-output-state.ts";
import { assertRunOutputState } from "./helpers/run-output-browser.ts";
import { assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { authRequest, sessionCookie } from "../helpers/auth.ts";
import { type Stack, upStack } from "./helpers/stack.ts";
import {
  ownedProcessGroup,
  terminateProcessGroup,
} from "./helpers/process-group.ts";

type Scope = { principalId: string; organizationId: string };

async function seedSuperuser(
  stack: Stack,
  email: string,
  password: string,
): Promise<void> {
  const pgDatabase = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: stack.ownerDatabaseUrl,
      BAKERY_PUBLIC_BASE_URL: stack.origin,
      BETTER_AUTH_SECRET: stack.authSecret,
    }).auth!;
    await createSuperuser({ pgDatabase, config }, {
      email,
      displayName: "Seeded task run reader",
      password,
    });
  } finally {
    await closePgDatabase(pgDatabase);
  }
}

async function seedTaskRun(
  stack: Stack,
  email: string,
): Promise<{ taskId: string; runId: string; stepId: string; scope: Scope }> {
  const suffix = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const owner = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const scopeRows = await owner.query<Scope>(
      `select principal.id as "principalId",
              membership.organization_id as "organizationId"
         from bakery.principals principal
         join public."user" provider_user
           on provider_user.id = principal.provider_user_id
         join bakery.organization_memberships membership
           on membership.principal_id = principal.id
        where provider_user.email = $1`,
      [email],
    );
    const scope = scopeRows.rows[0];
    if (!scope) throw new Error("SEEDED_USER_SCOPE_REQUIRED");
    const now = new Date("2026-10-01T12:00:00.123Z");
    await owner.query(
      `insert into bakery.applications
         (id, organization_id, slug, name)
       values ($1, $2, $3, $4)`,
      [
        applicationId,
        scope.organizationId,
        `read-${suffix}`,
        "Seeded read app",
      ],
    );
    const repository = await seedRunRepositoryScope(owner, {
      ...scope,
      applicationId,
    });
    await owner.query(
      `insert into bakery.conversations
         (id, organization_id, application_id, title, created_by, repository_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        conversationId,
        scope.organizationId,
        applicationId,
        "Seeded read task",
        scope.principalId,
        repository.repositoryId,
      ],
    );
    await owner.query(
      `insert into bakery.tasks
         (id, organization_id, application_id, conversation_id, title,
          description, task_type, status, created_by, repository_id, repository_profile_id, repository_profile_revision, repository_profile_digest)
       values ($1, $2, $3, $4, $5, $6, 'feature', 'queued', $7, $8, $9, 1, $10)`,
      [
        taskId,
        scope.organizationId,
        applicationId,
        conversationId,
        "Seeded durable task",
        "Task loaded from the owned PostgreSQL fixture.",
        scope.principalId,
        repository.repositoryId,
        repository.profileId,
        repository.profileDigest,
      ],
    );
    await owner.query(
      `insert into bakery.workflow_definitions
         (id, organization_id, slug, name)
       values ($1, $2, $3, $4)`,
      [workflowId, scope.organizationId, `read-${suffix}`, "Seeded workflow"],
    );
    await owner.query(
      `insert into bakery.workflow_versions
         (id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by)
       values ($1, $2, $3, 1, 'name: seeded-read', $4::jsonb,
               $5, 'published', $6)`,
      [
        workflowVersionId,
        scope.organizationId,
        workflowId,
        JSON.stringify({
          name: "seeded-read",
          steps: [{ key: "inspect", position: 0 }],
        }),
        `seeded-read-${suffix}`,
        scope.principalId,
      ],
    );
    await owner.query(
      `update bakery.workflow_definitions
          set active_version_id = $2
        where organization_id = $1 and id = $3`,
      [scope.organizationId, workflowVersionId, workflowId],
    );
    await owner.query(
      `insert into bakery.workflow_runs
         (id, organization_id, task_id, workflow_version_id, requested_by,
          status, snapshot, budget_limit_usd, finished_at, created_at, updated_at, application_id, repository_id, repository_profile_id, repository_profile_revision, repository_profile_digest)
       values ($1, $2, $3, $4, $5, 'completed', $6::jsonb, 0, $7, $7, $7, $8, $9, $10, 1, $11)`,
      [
        runId,
        scope.organizationId,
        taskId,
        workflowVersionId,
        scope.principalId,
        JSON.stringify({ name: "seeded-read" }),
        now,
        applicationId,
        repository.repositoryId,
        repository.profileId,
        repository.profileDigest,
      ],
    );
    await owner.query(
      `insert into bakery.run_steps
         (id, organization_id, run_id, step_key, position, iteration, status,
          input, output, finished_at, created_at, updated_at)
       values ($1, $2, $3, 'inspect', 0, 0, 'completed', $4::jsonb,
               $5::jsonb, $6, $6, $6)`,
      [
        stepId,
        scope.organizationId,
        runId,
        JSON.stringify({}),
        JSON.stringify({ result: "read-proof" }),
        now,
      ],
    );
    await owner.query(
      `update bakery.tasks
          set current_run_id = $2
        where organization_id = $1 and id = $3`,
      [scope.organizationId, runId, taskId],
    );
    return { taskId, runId, stepId, scope };
  } finally {
    await closePgDatabase(owner);
  }
}

async function activateSeededAttempt(
  stack: Stack,
  fixture: { runId: string; stepId: string; scope: Scope },
): Promise<{ attemptId: string; jobId: string }> {
  const ids = {
    jobId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    workerPrincipalId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
  };
  const sessionId = crypto.randomUUID();
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    await database.query(
      `update bakery.workflow_runs set status = 'running', finished_at = null
         where organization_id = $1 and id = $2`,
      [fixture.scope.organizationId, fixture.runId],
    );
    await database.query(
      `update bakery.run_steps set status = 'running', finished_at = null
         where organization_id = $1 and id = $2`,
      [fixture.scope.organizationId, fixture.stepId],
    );
    await database.query(
      `insert into bakery.jobs
         (id, organization_id, run_step_id, action, input, requirements,
          status, current_fence, application_id, repository_id, repository_profile_id, repository_profile_revision, repository_profile_digest)
       select $1, $2, $3, 'harness.implement', '{}', '{}', 'running', 2, run.application_id, run.repository_id, run.repository_profile_id, run.repository_profile_revision, run.repository_profile_digest
       from bakery.workflow_runs run where run.organization_id=$2 and run.id=$4`,
      [ids.jobId, fixture.scope.organizationId, fixture.stepId, fixture.runId],
    );
    await database.query(
      `insert into bakery.principals (id, display_name, principal_type)
       values ($1, 'Seeded control worker', 'worker')`,
      [ids.workerPrincipalId],
    );
    await database.query(
      `insert into bakery.worker_hosts
         (id, organization_id, principal_id, principal_type, name, os,
          architecture, capabilities, slots, credential_hash,
          worker_session_id, worker_session_generation)
       values ($1, $2, $3, 'worker', 'atlas-01', 'linux', 'x64',
               '[]', 1, $4, $5, 1)`,
      [
        ids.hostId,
        fixture.scope.organizationId,
        ids.workerPrincipalId,
        `seeded-control-${ids.hostId}`,
        sessionId,
      ],
    );
    await database.query(
      `insert into bakery.job_attempts
         (id, organization_id, job_id, worker_host_id, worker_session_id,
          worker_session_generation, attempt_no, fence, lease_token_hash,
          lease_expires_at, status, started_at)
       values ($1, $2, $3, $4, $5, 1, 2, 2, $6,
               clock_timestamp() + interval '30 minutes', 'running',
               clock_timestamp())`,
      [
        ids.attemptId,
        fixture.scope.organizationId,
        ids.jobId,
        ids.hostId,
        sessionId,
        `seeded-lease-${ids.attemptId}`,
      ],
    );
    return { attemptId: ids.attemptId, jobId: ids.jobId };
  } finally {
    await closePgDatabase(database);
  }
}

async function completeSeededAttempt(
  stack: Stack,
  fixture: { runId: string; stepId: string; scope: Scope },
  attemptId: string,
): Promise<void> {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    await database.query(
      `update bakery.job_attempts set status = 'completed', ended_at = clock_timestamp()
         where organization_id = $1 and id = $2`,
      [fixture.scope.organizationId, attemptId],
    );
    await database.query(
      `update bakery.jobs set status = 'completed', updated_at = clock_timestamp()
         where organization_id = $1 and run_step_id = $2`,
      [fixture.scope.organizationId, fixture.stepId],
    );
    await database.query(
      `update bakery.run_steps set status = 'completed', finished_at = clock_timestamp()
         where organization_id = $1 and id = $2`,
      [fixture.scope.organizationId, fixture.stepId],
    );
    await database.query(
      `update bakery.workflow_runs set status = 'completed', finished_at = clock_timestamp(),
          updated_at = clock_timestamp()
         where organization_id = $1 and id = $2`,
      [fixture.scope.organizationId, fixture.runId],
    );
  } finally {
    await closePgDatabase(database);
  }
}

async function countWorkerCommands(
  stack: Stack,
  organizationId: string,
  attemptId: string,
): Promise<number> {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const result = await database.query<{ count: string }>(
      `select count(*)::text as count from bakery.worker_commands
         where organization_id = $1 and attempt_id = $2`,
      [organizationId, attemptId],
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await closePgDatabase(database);
  }
}

/** Terminal colour codes in Vite's output; built so no control byte is literal. */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Serves a `--mode test` production build through `vite preview`. The
 * unbundled dev server answers each hard load with hundreds of module
 * requests; on a loaded runner Chromium fails some with
 * ERR_INSUFFICIENT_RESOURCES and the page never mounts.
 */
async function startVite(
  serverOrigin: string,
): Promise<{ origin: string; stop: () => Promise<string> }> {
  const outDir = await Deno.makeTempDir({ prefix: "bakery-seeded-read-web-" });
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
    throw new Error("VITE_E2E_BUILD_FAILED");
  }
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const origin = `http://127.0.0.1:${port}`;
  console.log(`VITE_E2E_PORT=${port}`);
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
  let stopped: Promise<string> | undefined;
  /** Stops the preview server once and returns what it printed. */
  const stop = (): Promise<string> =>
    stopped ??= (async () => {
      await terminateProcessGroup(group);
      const output = (await Promise.all([stdout, stderr])).join("\n");
      await Deno.remove(outDir, { recursive: true }).catch(() => undefined);
      console.log("VITE_E2E_PROCESS_GROUP_CLEANUP=passed");
      return output;
    })();
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        if ((await fetch(origin)).ok) {
          return { origin, stop };
        }
      } catch {
        // Vite is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("VITE_E2E_SERVER_NOT_READY");
  } catch (error) {
    await stop();
    throw error;
  }
}

async function assertSeededRunInBrowser(
  baseUrl: string,
  fixture: {
    taskId: string;
    runId: string;
    stepId: string;
    scope: Scope;
  },
  cookie: string,
  phase: "terminal" | "eligible" | "intake",
): Promise<string | undefined> {
  const child = new Deno.Command("node", {
    args: ["apps/web/tests/helpers/seeded-run-browser.mjs"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify({
    baseUrl,
    fixtureIds: {
      organizationId: fixture.scope.organizationId,
      taskId: fixture.taskId,
      runId: fixture.runId,
      stepId: fixture.stepId,
    },
    sessionCookie: cookie,
    phase,
  })));
  await writer.close();
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assertEquals(
    status.code,
    0,
    `Seeded browser helper failed with exit code ${status.code}: ${stderr}`,
  );
  console.log(`PHONE_BROWSER_PHASE=${phase}:passed`);
  return stdout.match(/SEEDED_CONTROL_KEY=([^\n]+)/)?.[1];
}

Deno.test(
  "real phone task intake preserves profile pins and seeded run controls replay once",
  async () => {
    const stack = await upStack("seeded-read");
    let vite: { origin: string; stop: () => Promise<string> } | undefined;
    let failed = false;
    const email = `e2e-seeded-read-${crypto.randomUUID()}@example.test`;
    const password = `Seeded-Read-${crypto.randomUUID()}`;
    try {
      await seedSuperuser(stack, email, password);
      const fixture = await seedTaskRun(stack, email);
      const signIn = await stack.fetch(
        authRequest("/api/auth/sign-in/email", { email, password }),
      );
      assertEquals(signIn.status, 200);
      const cookie = sessionCookie(signIn);
      const headers = {
        cookie,
        "Bakery-Organization-Id": fixture.scope.organizationId,
      };
      const taskResponse = await stack.fetch(
        new Request(
          `${stack.origin}/v1/tasks/${fixture.taskId}`,
          { headers },
        ),
      );
      assertEquals(taskResponse.status, 200);
      assertEquals((await taskResponse.json()).currentRunId, fixture.runId);
      const runResponse = await stack.fetch(
        new Request(
          `${stack.origin}/v1/runs/${fixture.runId}`,
          { headers },
        ),
      );
      assertEquals(runResponse.status, 200);
      assertEquals((await runResponse.json()).status, "completed");
      const stepsResponse = await stack.fetch(
        new Request(
          `${stack.origin}/v1/runs/${fixture.runId}/steps?limit=25`,
          { headers },
        ),
      );
      assertEquals(stepsResponse.status, 200);
      assertEquals((await stepsResponse.json()).items[0].id, fixture.stepId);
      assertEquals(
        (await stack.psql<{ role: string }>(
          "select current_user as role",
        ))[0]?.role,
        "bakery",
      );
      const connectedRoles = await stack.psql<{ role: string }>(
        "select distinct usename as role from pg_stat_activity where datname = current_database()",
      );
      assertEquals(
        connectedRoles.some(({ role }) => role === "bakery_app"),
        true,
      );
      console.log("OWNED_POSTGRES_AUTH=owner:bakery,server:bakery_app");

      vite = await startVite(stack.origin);
      // The real browser origin is the public web URL, not the API's bind port.
      // Configure the normal origin guard; never rewrite/bypass it in the proxy.
      await stack.restartServer({ BAKERY_PUBLIC_BASE_URL: vite.origin });
      await assertRunArchiveAcceptance(stack, {
        principalId: fixture.scope.principalId,
        organizationId: fixture.scope.organizationId,
        baseUrl: vite.origin,
        sessionCookie: cookie,
      });
      await assertSeededRunInBrowser(vite.origin, fixture, cookie, "intake");
      await assertSeededRunInBrowser(vite.origin, fixture, cookie, "terminal");
      const active = await activateSeededAttempt(stack, fixture);
      const output = await seedRunOutput(stack, fixture, active.attemptId);
      assertEquals(output.jobId, active.jobId);
      await assertRunOutputState({
        baseUrl: vite.origin,
        organizationId: fixture.scope.organizationId,
        taskId: fixture.taskId,
        sessionCookie: cookie,
        state: "default",
        evidenceDir: ".omo/evidence/run-production/live",
      });

      const stateFailures: string[] = [];
      for (
        const state of [
          "exit",
          "timeout",
          "lost-lease",
          "truncated",
          "interrupted",
        ] as const
      ) {
        await configureRunOutputState(
          stack,
          fixture,
          output,
          active.attemptId,
          state,
        );
        try {
          await assertRunOutputState({
            baseUrl: vite.origin,
            organizationId: fixture.scope.organizationId,
            taskId: fixture.taskId,
            sessionCookie: cookie,
            state,
            evidenceDir: ".omo/evidence/run-production/live",
          });
        } catch (error) {
          stateFailures.push(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      await configureRunOutputState(
        stack,
        fixture,
        output,
        active.attemptId,
        "default",
      );
      const key = await assertSeededRunInBrowser(
        vite.origin,
        fixture,
        cookie,
        "eligible",
      );
      assertEquals(key !== undefined, true);
      assertEquals(
        await countWorkerCommands(
          stack,
          fixture.scope.organizationId,
          active.attemptId,
        ),
        1,
      );
      await completeSeededAttempt(stack, fixture, active.attemptId);
      await assertSeededRunInBrowser(vite.origin, fixture, cookie, "terminal");
      assertEquals(
        stateFailures,
        [],
        "Every production state and recovery action must pass",
      );
    } catch (error) {
      failed = true;
      // Keep owned server diagnostics private; never print cookies or raw logs.
      const directory = Deno.env.get("TMPDIR");
      if (directory) {
        const path =
          `${directory}/task-intake-server-${crypto.randomUUID()}.log`;
        await Deno.writeTextFile(path, await stack.logs("server"), {
          mode: 0o600,
        });
        console.log(`PRIVATE_SERVER_DIAGNOSTIC=${path}`);
      }
      throw error;
    } finally {
      const viteOutput = vite ? await vite.stop() : "";
      if (failed) {
        // Vite's own optimizer, reload and error lines only, bounded: a
        // mid-session re-optimization or reload leaves the page unrendered.
        const lines = viteOutput.replaceAll(ANSI_SGR, "")
          .split("\n").filter((line) =>
            /\[vite\]|error|optimiz|reload/i.test(line)
          );
        // The events socket's proxy resets are routine; count them only.
        const socketResets = lines.filter((line) =>
          /ws proxy|ECONNRESET/.test(line)
        ).length;
        console.log(`VITE_E2E_OUTPUT_TAIL=${
          JSON.stringify({
            socketResets,
            lines: lines.filter((line) => !/ws proxy|ECONNRESET/.test(line))
              .slice(-20).map((line) => line.slice(0, 240)),
          })
        }`);
      }
      await stack.down();
    }
  },
);
