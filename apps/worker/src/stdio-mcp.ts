import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type McpStdioLaunchSpec,
  McpStdioLaunchSpecSchema,
} from "@bakery/contracts/mcp-capabilities";

export const STDIO_SANDBOX_EXECUTABLE = "/usr/bin/bwrap";
export const STDIO_SANDBOX_COMMAND = "/opt/bakery-mcp/server";
const PROTOCOL_VERSION = "2026-07-28";
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MAX_PAGES = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const STDIO_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/tmp",
  LANG: "C.UTF-8",
});

export const StdioLaunchSpecSchema = McpStdioLaunchSpecSchema;
export type StdioLaunchSpec = McpStdioLaunchSpec;

export type StdioIsolation = "sandbox" | "allowlisted";

export class StdioMcpError extends Error {
  constructor(
    readonly code: string,
    readonly diagnostic?: string,
    readonly requestWritten = true,
  ) {
    super(code);
    this.name = "StdioMcpError";
  }
}

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

export function stdioIsolation(
  spec: Pick<StdioLaunchSpec, "artifactDigest">,
  allowlist: readonly string[],
): StdioIsolation {
  return allowlist.includes(spec.artifactDigest) ? "allowlisted" : "sandbox";
}

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

async function copyAndHash(source: string, target: string): Promise<string> {
  let input: FileHandle;
  try {
    input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new StdioMcpError("STDIO_MCP_COMMAND_MISSING");
  }
  try {
    const info = await input.stat();
    if (!info.isFile()) throw new StdioMcpError("STDIO_MCP_COMMAND_NOT_A_FILE");
    if (info.size > MAX_COMMAND_BYTES) {
      throw new StdioMcpError("STDIO_MCP_COMMAND_TOO_LARGE");
    }
    const output = await open(target, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = new Uint8Array(COPY_CHUNK_BYTES);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return hash.digest("hex");
        copied += bytesRead;
        if (copied > MAX_COMMAND_BYTES) {
          throw new StdioMcpError("STDIO_MCP_COMMAND_TOO_LARGE");
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          written += (await output.write(chunk, written)).bytesWritten;
        }
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

export type PinnedStdioCommand = Readonly<{
  path: string;
  directory: string;
  isolation: StdioIsolation;
  executable: string;
  args: readonly string[];
}>;

export async function pinStdioCommand(
  spec: StdioLaunchSpec,
  options: Readonly<{ allowlist: readonly string[]; workDir?: string }>,
): Promise<PinnedStdioCommand> {
  const directory = await mkdtemp(
    join(options.workDir ?? tmpdir(), "bakery-mcp-"),
  );
  const path = join(directory, "server");
  try {
    const digest = await copyAndHash(spec.command, path);
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

export type StdioListedTools = Readonly<{
  protocolVersion: string;
  tools: readonly unknown[];
}>;

export type StdioMcpServer = Readonly<{
  isolation: StdioIsolation;
  protocolVersion: string;
  listTools(signal?: AbortSignal): Promise<StdioListedTools>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: unknown[]; isError: boolean }>;
  exited: Promise<void>;
  close(): Promise<void>;
}>;

function parseProtocolMessage(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

const ignoreBrokenPipe = () => undefined;

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

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
  const isRunning = () => exited === null && child.stdin !== null;
  const write = (message: Record<string, unknown>) => {
    if (!isRunning() || child.stdin === null) {
      throw exited ?? new StdioMcpError("STDIO_MCP_EXITED");
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const onMessage = (message: Record<string, unknown>) => {
    const id = message.id;
    if (typeof message.method === "string") {
      if (id !== undefined && id !== null && isRunning()) {
        write({ id, error: { code: -32601, message: "Method not found." } });
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
      const message = parseProtocolMessage(line);
      if (message !== null) onMessage(message);
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
  child.stdin!.on("error", ignoreBrokenPipe);

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
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new StdioMcpError("STDIO_MCP_ABORTED", undefined, false));
        return;
      }
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
        signal?.removeEventListener("abort", abort);
        reject(
          error instanceof StdioMcpError
            ? new StdioMcpError(error.code, error.diagnostic, false)
            : new StdioMcpError("STDIO_MCP_EXITED", undefined, false),
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
    exited: exit,
    close,
  });
}
