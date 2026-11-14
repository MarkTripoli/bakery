/**
 * Real Inngest proof: a scripted coordinator turn proposes a plan revision that
 * opens an approval; a human requests changes, the resumed turn proposes
 * revision 2 with a fresh approval, and approving it binds the exact revision.
 */
import { assert, assertEquals } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  reserveProcessLoopbackPort,
  retryOnPortCollision,
} from "../fixtures/loopback-port-allocation.ts";
import {
  type Harness,
  type Seed,
  seedOrganization,
  sendMessage,
} from "../helpers/coordinator-turns.ts";
import { request, seedTask } from "../helpers/durable-questions.ts";
import { registerLaneStack } from "../helpers/lane-stack-registry.ts";

type Result = { success: boolean; output: string };

async function docker(
  args: string[],
  env: Record<string, string>,
): Promise<Result> {
  const result = await new Deno.Command("docker", {
    args,
    cwd: Deno.cwd(),
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    output: new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  };
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until<T>(
  label: string,
  read: () => Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

Deno.test("real Inngest turns request-changes into revision 2 and approval binds the exact revision", async () => {
  let scriptFile: string | undefined;
  const project = `bakery-e06-approvals-${crypto.randomUUID().slice(0, 8)}`;
  registerLaneStack(project);
  const dispatch = `${project}-dispatch`;
  const authSecret = `turns-auth-${crypto.randomUUID()}-secret`;
  const bakeryPassword = `turns-bakery-${crypto.randomUUID()}`;
  const eventKey = `turns-event-${crypto.randomUUID()}`;
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    BAKERY_ENV: "test",
    BAKERY_SCRIPTED_COORDINATOR_DIR:
      "/workspace/tests/fixtures/scripted-coordinator",
    BAKERY_INNGEST_EVENT_KEY: eventKey,
    BAKERY_LOCAL_INNGEST_PASSWORD: `turns-inngest-${crypto.randomUUID()}`,
    BAKERY_LOCAL_POSTGRES_PASSWORD: `turns-postgres-${crypto.randomUUID()}`,
    BAKERY_LOCAL_REDIS_PASSWORD: `turns-redis-${crypto.randomUUID()}`,
    BAKERY_LOCAL_BAKERY_PASSWORD: bakeryPassword,
    BAKERY_LOCAL_APP_PASSWORD: `turns-app-${crypto.randomUUID()}`,
    BETTER_AUTH_SECRET: authSecret,
  };
  const compose = [
    "compose",
    "--project-name",
    project,
    "-f",
    "infra/compose.yaml",
  ];
  const run = async (args: string[], allowFailure = false) => {
    const result = await docker([...compose, ...args], env);
    if (!result.success && !allowFailure) {
      const logs = await docker(
        [...compose, "logs", "--no-color", "server"],
        env,
      );
      throw new Error(
        `docker ${
          args.join(" ")
        } failed:\n${result.output}\nServer logs:\n${logs.output}`,
      );
    }
    return result.output;
  };
  // Opened once the stack is up: its port is drawn by the boot attempt.
  let database!: PgDatabase;
  try {
    // A lost host-port bind re-runs the whole boot on fresh ports, after the
    // project the failed attempt created is removed.
    await retryOnPortCollision({
      run: async () => {
        env.BAKERY_INNGEST_PORT = String(reserveProcessLoopbackPort());
        env.BAKERY_POSTGRES_PORT = String(reserveProcessLoopbackPort());
        env.BAKERY_SERVER_PORT = String(reserveProcessLoopbackPort());
        await run([
          "up",
          "-d",
          "--wait",
          "postgres",
          "redis",
          "inngest",
          "migrate",
          "server",
        ]);
      },
      cleanupOwnedAttempt: async () => {
        await run(["down", "-v", "--remove-orphans"]);
      },
    });
    const serverUrl = `http://127.0.0.1:${env.BAKERY_SERVER_PORT}`;
    database = openPgDatabase(
      `postgres://bakery:${bakeryPassword}@127.0.0.1:${env.BAKERY_POSTGRES_PORT}/bakery`,
    );
    await until("server", async () => {
      try {
        return (await fetch(`${serverUrl}/health/live`)).ok ? true : undefined;
      } catch {
        return undefined;
      }
    });
    // Events sent before Inngest syncs the function wait for the recovery cron.
    const inngestUrl = `http://127.0.0.1:${env.BAKERY_INNGEST_PORT}`;
    await until("Inngest to register bakery-conversation-turn", async () => {
      try {
        const response = await fetch(`${inngestUrl}/v0/gql`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ functions { slug } }" }),
        });
        const body = await response.json() as {
          data?: { functions?: { slug: string }[] };
        };
        return body.data?.functions?.some((fn) =>
            fn.slug.endsWith("-bakery-conversation-turn")
          )
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    });
    const startDispatch = async () => {
      await run([
        "run",
        "-d",
        "--name",
        dispatch,
        "--no-deps",
        "-e",
        `INNGEST_EVENT_KEY=${eventKey}`,
        "server",
        "sh",
        "-eu",
        "-c",
        'export BAKERY_APP_DATABASE_URL="postgres://bakery_app:$BAKERY_LOCAL_APP_PASSWORD@postgres:5432/bakery"; exec deno run --allow-env --allow-net apps/server/src/dispatch.ts',
      ]);
    };
    await startDispatch();

    const harness: Harness = {
      pgDatabase: database,
      config: { auth: { secret: authSecret } },
      app: {
        fetch: (request) => {
          const url = new URL(request.url);
          const headers = new Headers(request.headers);
          if (headers.has("origin")) headers.set("origin", serverUrl);
          return fetch(
            new Request(`${serverUrl}${url.pathname}${url.search}`, {
              method: request.method,
              headers,
              body: request.method === "GET" ? undefined : request.body,
            }),
          );
        },
      },
    };
    const seed: Seed = await seedOrganization(
      harness as never,
      "e2e-approvals",
    );
    const taskId = await seedTask(harness as never, seed);
    await database.query(
      `update bakery.tasks set approval_policy = '{"plan":"human_approval"}'::jsonb where id = $1`,
      [taskId],
    );
    const scriptPath =
      `tests/fixtures/scripted-coordinator/${seed.conversationId}.json`;
    scriptFile = scriptPath;
    const script = (title: string) =>
      Deno.writeTextFile(
        scriptPath,
        JSON.stringify({
          effects: [{
            type: "planRevision",
            title,
            steps: [{ id: "s1", title: "Do it", detail: "As described" }],
          }],
        }),
      );
    await script("Plan v1");
    assertEquals(
      (await sendMessage(harness as never, seed, "agent_request", "plan"))
        .status,
      201,
    );
    type Approval = { id: string; version: number; status: string };
    const approvalsWith = (count: number) =>
      until(`${count} approvals`, async () => {
        const response = await request(
          harness as never,
          seed,
          `/v1/approvals?taskId=${taskId}&limit=10`,
        );
        const items = ((await response.json()) as { items: Approval[] }).items;
        return items.length === count ? items.reverse() : undefined;
      });
    const [first] = await approvalsWith(1);
    assertEquals(first.status, "open");
    await script("Plan v2");
    const decisionPath = (id: string) => `/v1/approvals/${id}/decision`;
    const changes = await request(
      harness as never,
      seed,
      decisionPath(first.id),
      {
        method: "POST",
        body: {
          decision: "request_changes",
          comment: "Add a rollback step",
          expectedVersion: first.version,
        },
      },
    );
    assertEquals(changes.status, 200);
    const [, second] = await approvalsWith(2);
    const revisions = await request(
      harness as never,
      seed,
      `/v1/plan-revisions?taskId=${taskId}`,
    );
    const items = ((await revisions.json()) as {
      items: { revision: number; status: string }[];
    }).items.reverse();
    assertEquals(items.map((item) => [item.revision, item.status]), [
      [1, "superseded"],
      [2, "proposed"],
    ]);
    const stale = await request(
      harness as never,
      seed,
      decisionPath(first.id),
      {
        method: "POST",
        body: { decision: "approve", expectedVersion: first.version },
      },
    );
    assertEquals(stale.status, 409);
    const approved = await request(
      harness as never,
      seed,
      decisionPath(second.id),
      {
        method: "POST",
        body: { decision: "approve", expectedVersion: second.version },
      },
    );
    assertEquals(approved.status, 200);
    const final = await database.query<{ revision: number; status: string }>(
      `select revision, status from bakery.plan_revisions where task_id = $1 order by revision`,
      [taskId],
    );
    assertEquals(final.rows.map((row) => [row.revision, row.status]), [
      [1, "superseded"],
      [2, "approved"],
    ]);
    const turns = await database.query<{ status: string }>(
      `select status from bakery.conversation_turns where conversation_id = $1`,
      [seed.conversationId],
    );
    assertEquals(turns.rows.every((row) => row.status === "completed"), true);
    assert(turns.rows.length === 2);
  } finally {
    try {
      if (scriptFile) await Deno.remove(scriptFile).catch(() => undefined);
      if (database) await closePgDatabase(database);
    } finally {
      await docker(["rm", "-f", dispatch], env);
      await run(["down", "-v"], true);
    }
  }
});
