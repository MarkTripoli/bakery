/**
 * Real Inngest proof: the outbox dispatcher delivers conversation.turn_changed
 * to a running server whose test-only scripted coordinator executes each turn.
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
  type Harness,
  type Seed,
  seedOrganization,
  sendMessage,
} from "../helpers/coordinator-turns.ts";

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

Deno.test("real Inngest executes queued coordinator turns serially and honors the pinned cutoff", async () => {
  const project = `bakery-e06-turns-${crypto.randomUUID().slice(0, 8)}`;
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
      "e2e-turns",
    );
    const status = async (): Promise<string[]> =>
      (await database.query<{ status: string }>(
        `select status from bakery.conversation_turns where conversation_id = $1
          order by created_at, id`,
        [seed.conversationId],
      )).rows.map((row) => row.status);

    // Discussion starts nothing; two requests run serially to completion.
    assertEquals(
      (await sendMessage(harness as never, seed, "discussion", "thinking"))
        .status,
      201,
    );
    assertEquals(
      (await sendMessage(harness as never, seed, "agent_request", "first"))
        .status,
      201,
    );
    assertEquals(
      (await sendMessage(harness as never, seed, "agent_request", "second"))
        .status,
      201,
    );
    await until("two completed turns", async () => {
      const current = await status();
      return current.length === 2 && current.every((s) => s === "completed")
        ? current
        : undefined;
    });
    const transcript = await database.query<{ intent: string }>(
      `select intent from bakery.messages where conversation_id = $1 order by sequence`,
      [seed.conversationId],
    );
    assertEquals(
      transcript.rows.map((r) => r.intent).filter((i) => i === "agent_output")
        .length,
      2,
    );
    const active = await database.query(
      `select 1 from bakery.conversation_turns where conversation_id = $1 and status in ('active','cancel_requested')`,
      [seed.conversationId],
    );
    assertEquals(active.rows.length, 0);

    // Dispatcher down: the turn stays queued with its pinned cutoff while the transcript grows.
    assertEquals((await docker(["stop", dispatch], env)).success, true);
    const ask = await (await sendMessage(
      harness as never,
      seed,
      "agent_request",
      "third",
    )).json() as { sequence: string };
    await sendMessage(harness as never, seed, "discussion", "added while down");
    const queued = (await status()).at(-1);
    assertEquals(queued, "queued");
    assertEquals((await docker(["start", dispatch], env)).success, true);
    await until(
      "third turn",
      async () => ((await status()).at(-1) === "completed" ? true : undefined),
    );
    const pin = await database.query<{ context_through_sequence: string }>(
      `select context_through_sequence::text from bakery.conversation_turns
        where conversation_id = $1 order by created_at desc, id desc limit 1`,
      [seed.conversationId],
    );
    assertEquals(pin.rows[0].context_through_sequence, ask.sequence);
    const turn = await call(
      harness as never,
      seed,
      `/v1/conversations/${seed.conversationId}/turns?limit=1`,
    );
    assert(turn.ok);
  } finally {
    try {
      if (database) await closePgDatabase(database);
    } finally {
      await docker(["rm", "-f", dispatch], env);
      await run(["down", "-v"], true);
    }
  }
});
