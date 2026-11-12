// The containerized server opens and edits drafts through its bounded
// process launcher (no systemd in the image): nothing is seeded but the
// draft source, and every write goes through the real isolated worker.
import { assert, assertEquals } from "@std/assert";
import { seedCollaborationWorld } from "../helpers/collaboration-world.ts";
import { type Stack, upStack } from "./helpers/stack.ts";

function request(
  stack: Stack,
  path: string,
  cookie: string,
  organizationId: string,
  init: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    cookie,
    origin: stack.origin,
    "Bakery-Organization-Id": organizationId,
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return stack.fetch(
    new Request(`${stack.origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

Deno.test(
  "the containerized server opens and edits a draft in a bounded worker process",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upStack("draft-isolation");
    const query = (sql: string, params: unknown[]) => stack.psql(sql, params);
    const world = await seedCollaborationWorld(query, stack.authSecret, {
      label: "draft-iso-e2e",
      text: "alpha target omega",
    });
    const member = world.members[0]!;
    const org = world.organizationId;
    try {
      const opened = await request(
        stack,
        `/v1/artifacts/${world.artifactId}/drafts`,
        member.cookie,
        org,
        { method: "POST" },
      );
      assertEquals(opened.status, 201, await opened.clone().text());
      const draft = await opened.json() as {
        id: string;
        epoch: number;
        checkpointId: string;
        text: string;
      };
      assertEquals(draft.text, "alpha target omega");

      const sliced = await request(
        stack,
        `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=6&endUtf16=12`,
        member.cookie,
        org,
      );
      assertEquals(sliced.status, 200, await sliced.clone().text());
      const slice = await sliced.json() as {
        checkpointId: string;
        startCursor: string;
        endCursor: string;
        text: string;
        textDigest: string;
      };
      assertEquals(slice.text, "target");

      const edited = await request(
        stack,
        `/v1/drafts/${draft.id}/edits`,
        member.cookie,
        org,
        {
          method: "POST",
          body: {
            epoch: draft.epoch,
            sourceCheckpointId: slice.checkpointId,
            startCursor: slice.startCursor,
            endCursor: slice.endCursor,
            expectedText: slice.text,
            expectedDigest: slice.textDigest,
            replacement: "changed",
            mutationId: crypto.randomUUID(),
          },
        },
      );
      assertEquals(edited.status, 201, await edited.clone().text());
      const read = await request(
        stack,
        `/v1/drafts/${draft.id}`,
        member.cookie,
        org,
      );
      assertEquals(read.status, 200);
      assertEquals(
        (await read.json() as { text: string }).text,
        "alpha changed omega",
      );

      // The server's run grant cannot be repurposed: with exactly the
      // server's flags, Deno and a shell are refused, and the launcher
      // refuses anything but one job id.
      const probe = await stack.runOneOff([
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "deno",
        "server",
        "run",
        "--allow-env",
        "--allow-net",
        "--allow-sys=uid",
        "--allow-run=/workspace/infra/draft-worker/launch.sh",
        "tests/fixtures/draft-workers/run-grant-probe.ts",
      ]);
      assert(probe.success, probe.output);
      const line = probe.output.split("\n").find((text) =>
        text.startsWith("{")
      );
      assertEquals(JSON.parse(line ?? "{}"), {
        denoEval: "denied",
        shell: "denied",
        launcherEval: "exit:64",
        launcherExtra: "exit:64",
      });

      // The server stays ready after the workers it started have exited.
      const ready = await stack.fetch(
        new Request(`${stack.origin}/health/ready`),
      );
      assertEquals(ready.status, 200);
      const logs = await stack.logs("server");
      assert(
        !logs.includes("HOST_ISOLATION_UNAVAILABLE"),
        "isolation fell back",
      );
    } finally {
      await world.cleanup().catch(() => {});
      await stack.down();
    }
  },
);
