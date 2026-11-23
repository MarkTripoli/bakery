import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type McpStdioLaunchSpec,
  McpStdioLaunchSpecSchema,
} from "@bakery/contracts/mcp-capabilities";

/**
 * Local (`stdio`) MCP servers (#441, docs/technical-design/25-one-engine.md
 * 15.4 "Local or remote", slice H).
 *
 * A stdio server is launched by the worker from a pinned command, never by the
 * server and never by the agent session. The launch is pinned twice: the
 * definition names the command, its arguments and the SHA-256 of the command
 * file. The worker copies the command into a private directory, hashes the
 * copy and runs the copy, so the file that runs is the file that was checked.
 *
 * A third-party server runs under the T1 sandbox: bubblewrap with fresh user,
 * PID, IPC, UTS and network namespaces, the system `/usr` read-only, a private
 * `/tmp`, and nothing of the worker's home, state, credentials or
 * environment. An operator who trusts a server puts its artifact digest on the
 * host's allowlist (`BAKERY_WORKER_MCP_STDIO_ALLOWLIST`); only then does it
 * run outside the sandbox, still with a cleared environment.
 *
 * Tools only (O31): the client offers no sampling, elicitation or roots, and
 * answers any request the server makes with "method not found".
 */

export const STDIO_SANDBOX_EXECUTABLE = "/usr/bin/bwrap";
/** Where the pinned command sits inside the sandbox. */
export const STDIO_SANDBOX_COMMAND = "/opt/bakery-mcp/server";
const PROTOCOL_VERSION = "2026-07-28";
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_PAGES = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const STDIO_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/tmp",
  LANG: "C.UTF-8",
});

/** The pinned launch of a stdio server, as an `mcp_servers.launch_spec`. */
export const StdioLaunchSpecSchema = McpStdioLaunchSpecSchema;
export type StdioLaunchSpec = McpStdioLaunchSpec;

/** How a launch runs: the T1 sandbox, or outside it because the operator allowlisted it. */
export type StdioIsolation = "sandbox" | "allowlisted";

export class StdioMcpError extends Error {
  constructor(readonly code: string, readonly diagnostic?: string) {
    super(code);
    this.name = "StdioMcpError";
  }
}

/** Reads `BAKERY_WORKER_MCP_STDIO_ALLOWLIST`: comma-separated artifact digests. */
export function parseStdioAllowlist(value: string | undefined): string[] {
  const entries = (value ?? "").split(",").map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const entry of entries) {
    if (!SHA256.test(entry)) {
      throw new Error("BAKERY_WORKER_MCP_STDIO_ALLOWLIST_INVALID");
    }
  }
  return [...new Set(entries)];
}

/** The isolation a launch gets: allowlisted only by its exact artifact digest. */
export function stdioIsolation(
  spec: Pick<StdioLaunchSpec, "artifactDigest">,
  allowlist: readonly string[],
): StdioIsolation {
  return allowlist.includes(spec.artifactDigest) ? "allowlisted" : "sandbox";
}

/** The bubblewrap arguments that run the pinned copy under the T1 sandbox. */
export function stdioSandboxArguments(
  pinnedCopy: string,
  args: readonly string[],
): string[] {
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--unshare-cgroup-try",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--symlink",
    "usr/bin",
    "/sbin",
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/opt/bakery-mcp",
    "--ro-bind",
    pinnedCopy,
    STDIO_SANDBOX_COMMAND,
    "--chdir",
    "/tmp",
    "--",
    STDIO_SANDBOX_COMMAND,
    ...args,
  ];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A pinned copy of the command, checked against the definition's digest. */
export type PinnedStdioCommand = Readonly<{
  path: string;
  directory: string;
  isolation: StdioIsolation;
  executable: string;
  args: readonly string[];
}>;

/**
 * Copies the command into a private directory and checks the copy's digest.
 * The copy is what runs, so a command file changed after the check cannot run.
 */
export async function pinStdioCommand(
  spec: StdioLaunchSpec,
  options: Readonly<{ allowlist: readonly string[]; workDir?: string }>,
): Promise<PinnedStdioCommand> {
  const directory = await mkdtemp(
    join(options.workDir ?? tmpdir(), "bakery-mcp-"),
  );
  const path = join(directory, "server");
  try {
    try {
      await copyFile(spec.command, path);
    } catch {
      throw new StdioMcpError("STDIO_MCP_COMMAND_MISSING");
    }
    const digest = sha256Hex(await readFile(path));
    if (digest !== spec.artifactDigest) {
      throw new StdioMcpError("STDIO_MCP_ARTIFACT_MISMATCH");
    }
    await chmod(path, 0o500);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const isolation = stdioIsolation(spec, options.allowlist);
  return Object.freeze({
    path,
    directory,
    isolation,
    executable: isolation === "sandbox" ? STDIO_SANDBOX_EXECUTABLE : path,
    args: Object.freeze(
      isolation === "sandbox"
        ? stdioSandboxArguments(path, spec.args)
        : [...spec.args],
    ),
  });
}

/** A tool as the local server listed it, before the server validates it. */
export type StdioListedTools = Readonly<{
  protocolVersion: string;
  tools: readonly unknown[];
}>;

/** One running local server, initialized and ready for tools/list and tools/call. */
export type StdioMcpServer = Readonly<{
  isolation: StdioIsolation;
  protocolVersion: string;
  listTools(signal?: AbortSignal): Promise<StdioListedTools>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: unknown[]; isError: boolean }>;
  close(): Promise<void>;
}>;

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

/**
 * Launches a pinned stdio server and completes the MCP handshake. Newline
 * delimited JSON-RPC on stdin and stdout; stderr is kept only as a bounded
 * diagnostic.
 */
export async function launchStdioMcpServer(
  spec: StdioLaunchSpec,
  options: Readonly<{
    allowlist: readonly string[];
    workDir?: string;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  }>,
): Promise<StdioMcpServer> {
  const pinned = await pinStdioCommand(spec, options);
  let child: ChildProcess;
  try {
    child = spawn(pinned.executable, [...pinned.args], {
      env: { ...STDIO_ENVIRONMENT },
      cwd: pinned.isolation === "sandbox" ? "/" : pinned.directory,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    await rm(pinned.directory, { recursive: true, force: true });
    throw new StdioMcpError("STDIO_MCP_LAUNCH_FAILED");
  }
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let buffered = "";
  let stderr = "";
  let exited: Error | null = null;
  let closed = false;

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const write = (message: Record<string, unknown>) => {
    if (exited !== null || child.stdin === null) {
      throw exited ?? new StdioMcpError("STDIO_MCP_EXITED");
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const onMessage = (message: Record<string, unknown>) => {
    const id = message.id;
    if (typeof message.method === "string") {
      // A request from the server (sampling, elicitation, roots): offered
      // nothing, so refused. A notification needs no answer.
      if (id !== undefined && id !== null) {
        try {
          write({ id, error: { code: -32601, message: "Method not found." } });
        } catch {
          // The process is gone; its pending requests are already failing.
        }
      }
      return;
    }
    if (typeof id !== "number") return;
    const waiter = pending.get(id);
    if (waiter === undefined) return;
    pending.delete(id);
    waiter.resolve(message);
  };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > MAX_LINE_BYTES && !buffered.includes("\n")) {
      exited = new StdioMcpError("STDIO_MCP_MESSAGE_TOO_LARGE");
      failAll(exited);
      child.kill("SIGKILL");
      return;
    }
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line === "") continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          onMessage(parsed as Record<string, unknown>);
        }
      } catch {
        // Not a protocol message (a stray log line); ignored.
      }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    if (stderr.length < MAX_STDERR_BYTES) {
      stderr = (stderr + chunk).slice(0, MAX_STDERR_BYTES);
    }
  });
  const exit = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited ??= new StdioMcpError("STDIO_MCP_EXITED", stderr);
      failAll(exited);
      resolve();
    });
    child.once("error", (error) => {
      exited ??= new StdioMcpError("STDIO_MCP_LAUNCH_FAILED", error.message);
      failAll(exited);
      resolve();
    });
  });
  child.stdin!.on("error", () => {
    // EPIPE after the process exited; the close handler reports it.
  });

  const close = async () => {
    if (closed) return;
    closed = true;
    if (exited === null) {
      child.stdin?.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exit;
      clearTimeout(timer);
    }
    await rm(pinned.directory, { recursive: true, force: true });
  };
  options.signal?.addEventListener("abort", () => void close(), { once: true });

  const request = (
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new StdioMcpError("STDIO_MCP_TIMEOUT"));
      }, timeoutMs);
      const abort = () => {
        pending.delete(id);
        clearTimeout(timer);
        reject(new StdioMcpError("STDIO_MCP_ABORTED"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (message.error !== undefined) {
            reject(new StdioMcpError("STDIO_MCP_SERVER_ERROR"));
            return;
          }
          const result = message.result;
          if (!result || typeof result !== "object" || Array.isArray(result)) {
            reject(new StdioMcpError("STDIO_MCP_INVALID_RESPONSE"));
            return;
          }
          resolve(result as Record<string, unknown>);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      try {
        write({ id, method, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new StdioMcpError("STDIO_MCP_EXITED"),
        );
      }
    });
  };

  let protocolVersion: string;
  try {
    const init = await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "bakery", version: "1" },
    }, options.signal);
    if (
      typeof init.protocolVersion !== "string" || init.protocolVersion === ""
    ) throw new StdioMcpError("STDIO_MCP_INVALID_RESPONSE");
    protocolVersion = init.protocolVersion;
    write({ method: "notifications/initialized" });
  } catch (error) {
    await close();
    throw error;
  }

  return Object.freeze({
    isolation: pinned.isolation,
    protocolVersion,
    async listTools(signal?: AbortSignal) {
      const tools: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const listed = await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        );
        if (!Array.isArray(listed.tools)) {
          throw new StdioMcpError("STDIO_MCP_INVALID_RESPONSE");
        }
        tools.push(...listed.tools);
        const next = listed.nextCursor;
        if (typeof next !== "string" || next === "") {
          return { protocolVersion, tools };
        }
        cursor = next;
      }
      throw new StdioMcpError("STDIO_MCP_TOO_MANY_PAGES");
    },
    async callTool(name, args, signal) {
      const result = await request(
        "tools/call",
        { name, arguments: args },
        signal,
      );
      return {
        content: Array.isArray(result.content) ? result.content : [],
        isError: result.isError === true,
      };
    },
    close,
  });
}
