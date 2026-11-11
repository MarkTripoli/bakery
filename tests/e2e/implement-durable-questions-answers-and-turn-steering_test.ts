/**
 * Real Inngest proof: a scripted coordinator turn asks a durable question, a
 * client answers it over HTTP, and exactly one follow-up turn resumes the
 * conversation; identical replays and conflicting answers change nothing.
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
  call,
  cleanupSeededOrganizations,
  type Harness,
  type Seed,
  seedOrganization,
  sendMessage,
} from "../helpers/coordinator-turns.ts";
import { request, seedTask } from "../helpers/durable-questions.ts";

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

Deno.test("real Inngest resumes a conversation exactly once after a question is answered", async () => {
  let scriptFile: string | undefined;
  const project = `bakery-e06-questions-${crypto.randomUUID().slice(0, 8)}`;
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
      "e2e-questions",
    );
    await seedTask(harness as never, seed);
    const scriptPath =
      `tests/fixtures/scripted-coordinator/${seed.conversationId}.json`;
    scriptFile = scriptPath;
    await Deno.writeTextFile(
      scriptPath,
      JSON.stringify({
        effects: [{
          type: "question",
          prompt: "Deploy to staging?",
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        }],
      }),
    );
    assertEquals(
      (await sendMessage(harness as never, seed, "agent_request", "deploy"))
        .status,
      201,
    );
    let open: { id: string };
    try {
      open = await until("open question", async () => {
        const response = await request(
          harness as never,
          seed,
          `/v1/questions?conversationId=${seed.conversationId}&status=open`,
        );
        const items = ((await response.json()) as { items: { id: string }[] })
          .items;
        return items.length === 1 ? items[0] : undefined;
      });
    } catch (error) {
      const turns = await database.query(
        `select status, failure from bakery.conversation_turns where conversation_id = $1`,
        [seed.conversationId],
      );
      throw new Error(
        `${(error as Error).message}: ${JSON.stringify(turns.rows)}`,
      );
    }
    // The resumed turn replies instead of asking again.
    await Deno.writeTextFile(
      scriptPath,
      JSON.stringify({
        effects: [{ type: "reply", body: "Deploying to staging." }],
      }),
    );
    const path = `/v1/questions/${open.id}/answer`;
    const answered = await request(harness as never, seed, path, {
      method: "PUT",
      body: { answer: { optionId: "yes" } },
    });
    assertEquals(answered.status, 200);
    const replay = await request(harness as never, seed, path, {
      method: "PUT",
      body: { answer: { optionId: "yes" } },
    });
    assertEquals(replay.status, 200);
    const conflicting = await request(harness as never, seed, path, {
      method: "PUT",
      body: { answer: { optionId: "no" } },
    });
    assertEquals(conflicting.status, 409);
    await until("resumed turn", async () => {
      const turns = await database.query<{ status: string }>(
        `select status from bakery.conversation_turns where conversation_id = $1
          order by created_at, id`,
        [seed.conversationId],
      );
      return turns.rows.length === 2 &&
          turns.rows.every((row) => row.status === "completed")
        ? true
        : undefined;
    });
    const replies = await database.query<{ body: string }>(
      `select body from bakery.messages where conversation_id = $1
        and intent = 'agent_output' order by sequence`,
      [seed.conversationId],
    );
    assertEquals(replies.rows.length, 1);
    assertEquals(replies.rows[0].body, "Deploying to staging.");
    const turn = await call(
      harness as never,
      seed,
      `/v1/conversations/${seed.conversationId}/turns?limit=5`,
    );
    assert(turn.ok);
  } finally {
    try {
      if (scriptFile) await Deno.remove(scriptFile).catch(() => undefined);
      if (database) {
        try {
          await cleanupSeededOrganizations({ pgDatabase: database });
        } finally {
          await closePgDatabase(database);
        }
      }
    } finally {
      await docker(["rm", "-f", dispatch], env);
      await run(["down", "-v"], true);
    }
  }
});
