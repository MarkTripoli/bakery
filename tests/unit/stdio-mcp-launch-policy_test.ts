import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  parseStdioAllowlist,
  STDIO_SANDBOX_COMMAND,
  stdioIsolation,
  StdioLaunchSpecSchema,
  stdioSandboxArguments,
} from "../../apps/worker/src/stdio-mcp.ts";
import { readWorkerConfig } from "../../apps/worker/src/config.ts";

const DIGEST = "a".repeat(64);

Deno.test("a stdio launch pins an absolute command, plain arguments and a digest", () => {
  const spec = StdioLaunchSpecSchema.parse({
    command: "/usr/local/bin/mcp-files",
    artifactDigest: DIGEST,
  });
  assertEquals(spec.args, []);
  for (
    const bad of [
      { command: "mcp-files", artifactDigest: DIGEST },
      { command: "/usr/../bin/sh", artifactDigest: DIGEST },
      { command: "/bin/sh", artifactDigest: "ABC" },
      { command: "/bin/sh", args: ["a\0b"], artifactDigest: DIGEST },
      { command: "/bin/sh", artifactDigest: DIGEST, shell: true },
    ]
  ) {
    assert(!StdioLaunchSpecSchema.safeParse(bad).success, JSON.stringify(bad));
  }
});

Deno.test("only an exact allowlisted digest runs outside the sandbox", () => {
  assertEquals(stdioIsolation({ artifactDigest: DIGEST }, []), "sandbox");
  assertEquals(
    stdioIsolation({ artifactDigest: DIGEST }, ["b".repeat(64)]),
    "sandbox",
  );
  assertEquals(
    stdioIsolation({ artifactDigest: DIGEST }, [DIGEST]),
    "allowlisted",
  );
  assertEquals(parseStdioAllowlist(undefined), []);
  assertEquals(parseStdioAllowlist(` ${DIGEST}, ${DIGEST} ,`), [DIGEST]);
  assertThrows(
    () => parseStdioAllowlist("*"),
    Error,
    "BAKERY_WORKER_MCP_STDIO_ALLOWLIST_INVALID",
  );
});

function withEnv<T>(values: Record<string, string>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(values)) {
    previous.set(name, Deno.env.get(name));
  }
  try {
    for (const [name, value] of Object.entries(values)) {
      Deno.env.set(name, value);
    }
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("the worker reads its stdio allowlist from BAKERY_WORKER_MCP_STDIO_ALLOWLIST", () => {
  const base = {
    BAKERY_SERVER_URL: "http://127.0.0.1:8000",
    BAKERY_WORKER_STATE_DIR: "/tmp/bakery-441-stdio-allowlist-state",
    BAKERY_WORKER_CAPABILITIES: "git",
  };
  assertEquals(
    withEnv(
      { ...base, BAKERY_WORKER_MCP_STDIO_ALLOWLIST: DIGEST },
      () => readWorkerConfig().mcpStdioAllowlist,
    ),
    [DIGEST],
  );
  assertThrows(
    () =>
      withEnv(
        { ...base, BAKERY_WORKER_MCP_STDIO_ALLOWLIST: "/usr/bin/node" },
        () => readWorkerConfig(),
      ),
    Error,
    "BAKERY_WORKER_MCP_STDIO_ALLOWLIST_INVALID",
  );
});

Deno.test("the T1 sandbox has no network, no host home and only the pinned copy", () => {
  const args = stdioSandboxArguments("/state/bakery-mcp-x/server", ["--flag"]);
  for (
    const flag of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
    ]
  ) assert(args.includes(flag), flag);
  // Only /usr, ld.so.cache and the pinned copy come from the host, read-only.
  const binds: string[] = [];
  args.forEach((arg, index) => {
    if (arg === "--bind" || arg === "--dev-bind") binds.push(args[index + 1]!);
    if (arg === "--ro-bind" || arg === "--ro-bind-try") {
      binds.push(args[index + 1]!);
    }
  });
  assertEquals(binds, [
    "/usr",
    "/etc/ld.so.cache",
    "/state/bakery-mcp-x/server",
  ]);
  assert(!args.includes("--bind"));
  assertEquals(args.slice(-3), ["--", STDIO_SANDBOX_COMMAND, "--flag"]);
});
