import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import {
  launchStdioMcpServer,
  StdioMcpError,
} from "../../apps/worker/src/stdio-mcp.ts";

const FIXTURE = new URL(
  "../fixtures/stdio-mcp/fixture-server.sh",
  import.meta.url,
).pathname;
const RUN = { sanitizeResources: false, sanitizeOps: false } as const;

async function fixtureDigest(): Promise<string> {
  return createHash("sha256").update(await readFile(FIXTURE)).digest("hex");
}

async function withListener<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function probe(allowlist: string[]) {
  const secret = await Deno.makeTempFile({ prefix: "bakery-441-host-" });
  Deno.env.set("BAKERY_SECRET", "worker-only");
  try {
    return await withListener(async (port) => {
      const server = await launchStdioMcpServer({
        command: FIXTURE,
        args: [String(port)],
        artifactDigest: await fixtureDigest(),
      }, { allowlist });
      try {
        const listed = await server.listTools();
        assertEquals(
          listed.tools.map((tool) => (tool as { name: string }).name),
          ["echo", "probe"],
        );
        const echoed = await server.callTool("echo", { text: "hi" });
        assertEquals(echoed, {
          content: [{ type: "text", text: "hi" }],
          isError: false,
        });
        const seen = await server.callTool("probe", { path: secret });
        return {
          isolation: server.isolation,
          ...JSON.parse((seen.content[0] as { text: string }).text),
        };
      } finally {
        await server.close();
      }
    });
  } finally {
    Deno.env.delete("BAKERY_SECRET");
    await Deno.remove(secret);
  }
}

Deno.test(
  "a third-party stdio server runs in the T1 sandbox: no host files, no network, no worker env",
  RUN,
  async () => {
    const seen = await probe([]);
    assertEquals(seen.isolation, "sandbox");
    assertEquals(seen.pathVisible, false);
    assert(seen.network !== "connected", `network ${seen.network}`);
    assertEquals(seen.home, "/tmp");
    assertEquals(seen.secret, null);
  },
);

Deno.test(
  "an operator-allowlisted stdio server runs outside the sandbox with a cleared environment",
  RUN,
  async () => {
    const seen = await probe([await fixtureDigest()]);
    assertEquals(seen.isolation, "allowlisted");
    assertEquals(seen.pathVisible, true);
    assertEquals(seen.network, "connected");
    assertEquals(seen.secret, null);
  },
);

Deno.test(
  "a command whose digest is not the pinned one is refused and never runs",
  RUN,
  async () => {
    const error = await assertRejects(
      () =>
        launchStdioMcpServer({
          command: FIXTURE,
          args: [],
          artifactDigest: "0".repeat(64),
        }, { allowlist: [] }),
      StdioMcpError,
    );
    assertEquals(error.code, "STDIO_MCP_ARTIFACT_MISMATCH");
  },
);
