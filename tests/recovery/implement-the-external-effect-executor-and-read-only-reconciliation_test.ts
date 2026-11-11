import { assert, assertEquals } from "@std/assert";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  GITHUB_BINDING,
  loopbackExecutor,
  stageEffectRun,
} from "../helpers/external-effects.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";

type Call = { method: string; path: string };
type Comment = {
  id: number;
  body: string;
  user: { id: number; type: string };
};

/** Loopback GitHub shared across the kill: it outlives the child process. */
function startGithub(mode: "ok" | "store_then_hold") {
  const calls: Call[] = [];
  const comments: Comment[] = [];
  const stored = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      // A host-side port scanner probes new loopback listeners with GET /.
      if (!url.pathname.startsWith("/repos/")) {
        return new Response("not found", { status: 404 });
      }
      calls.push({ method: request.method, path: url.pathname });
      if (request.method === "POST") {
        const body = await request.json() as { body: string };
        const comment: Comment = {
          id: 9000 + comments.length,
          body: body.body,
          user: { id: GITHUB_BINDING.botUserId, type: "Bot" },
        };
        comments.push(comment);
        if (mode === "store_then_hold") {
          stored.resolve();
          await hold.promise;
          return new Response("{}", { status: 500 });
        }
        return Response.json(comment, { status: 201 });
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("per_page") ?? "100");
      return Response.json(comments.slice((page - 1) * size, page * size));
    },
  );
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    calls,
    comments,
    stored: stored.promise,
    posts: () => calls.filter((c) => c.method === "POST").length,
    lists: () => calls.filter((c) => c.method === "GET").length,
    stop: async () => {
      hold.resolve();
      await server.shutdown();
    },
  };
}

type Github = ReturnType<typeof startGithub>;

/** Spawns the child executor process; resolves stdout lines as they arrive. */
function spawnChild(
  mode: "block_before_send" | "plain",
  github: Github,
  staged: Awaited<ReturnType<typeof stageEffectRun>>,
  fixture: WorkerFixture,
) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-net",
      "--allow-sys",
      new URL(
        "./implement-the-external-effect-executor-and-read-only-reconciliation.child.ts",
        import.meta.url,
      ).pathname,
    ],
    env: {
      EFFECT_CHILD: JSON.stringify({
        databaseUrl: readTestDatabaseConfig().databaseUrl,
        origin: github.origin,
        mode,
        organizationId: fixture.organizationId,
        effectId: staged.effectId,
        snapshot: staged.rig.snapshot.current,
      }),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        waiters.splice(0).forEach((wake) => wake());
      }
    }
  })();
  const stderr = new Response(child.stderr).text();
  return {
    async waitFor(line: string, timeoutMs = 60_000) {
      const deadline = performance.now() + timeoutMs;
      while (!lines.includes(line)) {
        if (performance.now() > deadline) {
          throw new Error(
            `child never printed ${line}; stdout=${
              lines.join("|")
            } stderr=${await Promise.race(
              [stderr, Promise.resolve("(running)")],
            )}`,
          );
        }
        const tick = Promise.withResolvers<void>();
        waiters.push(tick.resolve);
        setTimeout(tick.resolve, 100);
        await tick.promise;
      }
    },
    async kill() {
      child.kill("SIGKILL");
      await child.status;
      await pump;
      await stderr;
    },
  };
}

async function expireLease(
  staged: Awaited<ReturnType<typeof stageEffectRun>>,
): Promise<void> {
  await staged.db.query(
    `update bakery.external_effects
        set lease_expires_at = clock_timestamp() - interval '1 second'
      where id = $1`,
    [staged.effectId],
  );
}

async function row(staged: Awaited<ReturnType<typeof stageEffectRun>>) {
  return (await staged.db.query(
    `select status, dispatch_generation, remote_id
       from bakery.external_effects where id = $1`,
    [staged.effectId],
  )).rows[0] as {
    status: string;
    dispatch_generation: number;
    remote_id: string | null;
  };
}

Deno.test("V1: a crash after the claim and before the send never writes; recovery only lists", () =>
  withWorkerFixture(async (fixture) => {
    const github = startGithub("ok");
    try {
      const staged = await stageEffectRun(fixture, "recovery-v1");
      const child = spawnChild("block_before_send", github, staged, fixture);
      try {
        await child.waitFor("READY_BEFORE_SEND");
        // The claim committed before the child reached the provider.
        const claimed = await row(staged);
        assertEquals(claimed.status, "submitted");
        assertEquals(claimed.dispatch_generation, 1);
      } finally {
        await child.kill();
      }
      assertEquals(github.posts(), 0);

      await expireLease(staged);
      const executor = loopbackExecutor({
        database: staged.db,
        port: staged.rig.port,
        origin: github.origin,
      });
      const run = () =>
        executor.runEffect({
          organizationId: fixture.organizationId,
          effectId: staged.effectId,
          requestId: "parent-request",
          traceId: "parent-trace",
        });
      const first = await run();
      assertEquals(first.outcome, "uncertain");
      assertEquals(first.dispatched, false);
      assertEquals(first.effect.dispatchGeneration, 1);
      assertEquals(github.posts(), 0);
      assertEquals(github.lists(), 1);
      // Absence cannot prove the write never happened: it stays uncertain.
      for (let i = 0; i < 2; i++) {
        assertEquals((await run()).outcome, "uncertain");
      }
      assertEquals(github.posts(), 0);
      assertEquals((await row(staged)).dispatch_generation, 1);
    } finally {
      await github.stop();
    }
  }));

Deno.test("V2: a write the provider stored before the kill is found by reconcile and never repeated", () =>
  withWorkerFixture(async (fixture) => {
    const github = startGithub("store_then_hold");
    try {
      const staged = await stageEffectRun(fixture, "recovery-v2");
      const child = spawnChild("plain", github, staged, fixture);
      try {
        await github.stored;
        assertEquals(github.posts(), 1);
        // The child is blocked on the response; the ledger still says submitted.
        assertEquals((await row(staged)).status, "submitted");
      } finally {
        await child.kill();
      }

      await expireLease(staged);
      const executor = loopbackExecutor({
        database: staged.db,
        port: staged.rig.port,
        origin: github.origin,
      });
      const run = () =>
        executor.runEffect({
          organizationId: fixture.organizationId,
          effectId: staged.effectId,
          requestId: "parent-request",
          traceId: "parent-trace",
        });
      const first = await run();
      assertEquals(first.outcome, "confirmed");
      assertEquals(first.dispatched, false);
      assertEquals(first.effect.remoteId, String(github.comments[0]!.id));
      for (let i = 0; i < 3; i++) {
        const again = await run();
        assertEquals(again.outcome, "confirmed");
        assertEquals(again.dispatched, false);
      }
      assertEquals(github.posts(), 1);
      assertEquals(github.lists(), 1);
      assertEquals((await row(staged)).dispatch_generation, 1);
    } finally {
      await github.stop();
    }
  }));

Deno.test("V3: a timeout, then a restart, only reconciles", () =>
  withWorkerFixture(async (fixture) => {
    const github = startGithub("store_then_hold");
    try {
      const staged = await stageEffectRun(fixture, "recovery-v3");
      const first = loopbackExecutor({
        database: staged.db,
        port: staged.rig.port,
        origin: github.origin,
        options: { deadlineMs: 300 },
      });
      const timedOut = await first.runEffect({
        organizationId: fixture.organizationId,
        effectId: staged.effectId,
        requestId: "request-1",
        traceId: "trace-1",
      });
      assertEquals(timedOut.outcome, "uncertain");
      assertEquals(timedOut.dispatched, true);
      assertEquals(github.posts(), 1);

      // A restarted process: fresh executor, same database.
      const restarted = loopbackExecutor({
        database: staged.db,
        port: staged.rig.port,
        origin: github.origin,
      });
      for (let i = 0; i < 2; i++) {
        const result = await restarted.runEffect({
          organizationId: fixture.organizationId,
          effectId: staged.effectId,
          requestId: "request-2",
          traceId: "trace-2",
        });
        assertEquals(result.dispatched, false);
        assertEquals(result.outcome, "confirmed");
      }
      assertEquals(github.posts(), 1);
      assert(github.lists() >= 1);
    } finally {
      await github.stop();
    }
  }));
