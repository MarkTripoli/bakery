import type { ArtifactRef } from "./artifact-client.ts";
import {
  assertDurableCoreBoundaryProof,
  type DurableCoreBoundaryProof,
  type DurableCoreCase,
} from "../../../helpers/durable-core/evidence.ts";
import type { DurableCoreStack } from "../../../helpers/durable-core/stack.ts";

export type DurableCoreEvidence = {
  readonly revision: string;
  readonly configuration: {
    readonly project: string;
    readonly ports: Readonly<Record<string, number>>;
  };
  readonly runId: string;
  readonly effectKey: string;
  readonly artifactRef: ArtifactRef;
  readonly terminalResultCount: number;
  readonly artifactCount: number;
  readonly cases: readonly DurableCoreCase[];
  readonly logs: Readonly<Record<string, string>>;
};

const MAX_BOUNDARY_PROOF_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 32 * 1024;

function redactUriSuffix(suffix: string): string {
  const queryStart = suffix.indexOf("?");
  if (queryStart < 0) return suffix;
  const fragmentStart = suffix.indexOf("#", queryStart);
  const queryEnd = fragmentStart < 0 ? suffix.length : fragmentStart;
  const query = suffix.slice(queryStart + 1, queryEnd);
  if (!query) return suffix;
  const redactedQuery = query.split("&").map((parameter) => {
    const separator = parameter.indexOf("=");
    return separator < 0
      ? parameter
      : `${parameter.slice(0, separator)}=[redacted]`;
  }).join("&");
  return `${suffix.slice(0, queryStart + 1)}${redactedQuery}${
    suffix.slice(queryEnd)
  }`;
}

function redactUriUserInfo(
  _full: string,
  scheme: string,
  authority: string,
  suffix = "",
): string {
  const at = authority.lastIndexOf("@");
  const redactedSuffix = redactUriSuffix(suffix);
  if (at < 0) return `${scheme}${authority}${redactedSuffix}`;
  const userInfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  const separator = userInfo.indexOf(":");
  const redactedUserInfo = separator < 0
    ? "[redacted]"
    : `${userInfo.slice(0, separator)}:[redacted]`;
  return `${scheme}${redactedUserInfo}@${host}${redactedSuffix}`;
}

const SECRET_JSON_KEY =
  /(["'])(?:authorization|cookie|set[-_]?cookie|password|passwd|secret|token|credential|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token)\1\s*:\s*/gi;

function secretJsonValueEnd(
  value: string,
  start: number,
): { readonly end: number; readonly replacement: string } {
  const first = value[start];
  if (first === `"` || first === `'`) {
    for (let index = start + 1; index < value.length; index++) {
      if (value[index] === "\\") {
        index++;
        continue;
      }
      if (value[index] === "\n" || value[index] === "\r") {
        return {
          end: index,
          replacement: `${first}[redacted]`,
        };
      }
      if (value[index] === first) {
        return {
          end: index + 1,
          replacement: `${first}[redacted]${first}`,
        };
      }
    }
    return {
      end: value.length,
      replacement: `${first}[redacted]${first}`,
    };
  }
  if (first === "{" || first === "[") {
    const stack: string[] = [];
    for (let index = start; index < value.length; index++) {
      const character = value[index];
      if (character === `"` || character === `'`) {
        const quoteEnd = secretJsonValueEnd(value, index);
        index = quoteEnd.end - 1;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }
      if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (stack.at(-1) !== expected) {
          return { end: value.length, replacement: `"[redacted]"` };
        }
        stack.pop();
        if (stack.length === 0) {
          return { end: index + 1, replacement: `"[redacted]"` };
        }
      }
    }
    return { end: value.length, replacement: `"[redacted]"` };
  }
  let end = start;
  while (end < value.length && !/[\s,\]}]/.test(value[end]!)) end++;
  return { end, replacement: `"[redacted]"` };
}

function redactStructuredSecretValues(value: string): string {
  let cursor = 0;
  let redacted = "";
  SECRET_JSON_KEY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_JSON_KEY.exec(value)) !== null) {
    if (match.index < cursor) continue;
    const secret = secretJsonValueEnd(value, SECRET_JSON_KEY.lastIndex);
    redacted += value.slice(cursor, SECRET_JSON_KEY.lastIndex) +
      secret.replacement;
    cursor = secret.end;
    SECRET_JSON_KEY.lastIndex = secret.end;
  }
  return redacted + value.slice(cursor);
}

/**
 * Redacts credentials from arbitrary command output without changing the
 * surrounding evidence protocol. Query values are secret-bearing by default;
 * preserving their names still makes diagnostics useful without exporting
 * tokens embedded in URLs.
 */
export function redactDurableCoreText(value: string): string {
  const uriRedacted = value.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)([/?#][^\s]*)?/gi,
    redactUriUserInfo,
  );
  const jsonRedacted = redactStructuredSecretValues(uriRedacted);
  const headerRedacted = jsonRedacted.replace(
    /(authorization|cookie|set[-_]?cookie)(\s*[:=]\s*)[^\r\n]*/gi,
    "$1$2[redacted]",
  );
  const cliHeaderRedacted = headerRedacted.replace(
    /(--(?:authorization|cookie|set[-_]?cookie)(?:=|\s+))[^\r\n]*/gi,
    "$1[redacted]",
  );
  const cliRedacted = cliHeaderRedacted.replace(
    /(--(?:password|passwd|secret|token|credential|api[-_]?key|client[-_]?secret)(?:=|\s+))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi,
    "$1[redacted]",
  );
  const keyValueRedacted = cliRedacted.replace(
    /((?:authorization|cookie|set[-_]?cookie|password|passwd|secret|token|credential|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token)(?:\s*[:=]\s*))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&?#]+)/gi,
    "$1[redacted]",
  );
  const bearerRedacted = keyValueRedacted.replace(
    /\bBearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&?#]+)/gi,
    "Bearer [redacted]",
  );
  return bearerRedacted.replace(
    /\b(Set-Cookie|Cookie)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gi,
    "$1 [redacted]",
  );
}

function boundedLog(value: string): string {
  const redacted = redactDurableCoreText(value);
  const bytes = new TextEncoder().encode(redacted);
  if (bytes.byteLength <= MAX_LOG_BYTES) return redacted;
  return new TextDecoder().decode(
    bytes.slice(bytes.byteLength - MAX_LOG_BYTES),
  );
}

export async function checkoutRevision(): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: Deno.cwd(),
    clearEnv: true,
    env: Object.fromEntries(
      ["PATH", "HOME", "TMPDIR"].flatMap((name) => {
        const value = Deno.env.get(name);
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error("DURABLE_CORE_REVISION_UNAVAILABLE");
  const revision = new TextDecoder().decode(result.stdout).trim();
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error("DURABLE_CORE_REVISION_INVALID");
  }
  return revision;
}

export async function collectDurableCoreEvidence(options: {
  readonly stack: DurableCoreStack;
  readonly runId: string;
  readonly effectKey: string;
  readonly artifactRef: ArtifactRef;
  readonly terminalResultCount: number;
  readonly artifactCount: number;
  readonly cases: readonly DurableCoreCase[];
}): Promise<DurableCoreEvidence> {
  const services = [
    "server",
    "migrate",
    "postgres",
    "redis",
    "inngest",
    "worker",
  ] as const;
  const logs: Record<string, string> = {};
  for (const service of services) {
    logs[service] = boundedLog(await options.stack.logs(service));
  }
  return {
    revision: await checkoutRevision(),
    configuration: {
      project: options.stack.project,
      ports: options.stack.ports,
    },
    runId: options.runId,
    effectKey: options.effectKey,
    artifactRef: options.artifactRef,
    terminalResultCount: options.terminalResultCount,
    artifactCount: options.artifactCount,
    cases: options.cases,
    logs,
  };
}

export async function writeDurableCoreEvidence(
  path: string,
  evidence: DurableCoreEvidence,
): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}

function proofDirectory(): string {
  const directory = Deno.env.get("BAKERY_DURABLE_CORE_PROOF_DIR")?.trim();
  if (!directory || !directory.startsWith("/") || directory.includes("\0")) {
    throw new Error("DURABLE_CORE_BOUNDARY_PROOF_DIRECTORY_INVALID");
  }
  if (directory.split("/").some((part: string) => part === "..")) {
    throw new Error("DURABLE_CORE_BOUNDARY_PROOF_DIRECTORY_UNSAFE");
  }
  return directory.replace(/\/+$/, "") || "/";
}

async function ensureProofDirectory(path: string): Promise<string> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error("DURABLE_CORE_BOUNDARY_PROOF_DIRECTORY_UNSAFE");
  }
  const resolved = await Deno.realPath(path);
  if (resolved !== path) {
    throw new Error("DURABLE_CORE_BOUNDARY_PROOF_DIRECTORY_UNSAFE");
  }
  await Deno.chmod(path, 0o700);
  const privateDirectory = await Deno.stat(path);
  if (((privateDirectory.mode ?? 0) & 0o777) !== 0o700) {
    throw new Error("DURABLE_CORE_BOUNDARY_PROOF_DIRECTORY_NOT_PRIVATE");
  }
  return path;
}

export function parseDurableCoreBoundaryProof(
  candidate: unknown,
  options: {
    readonly revision?: string;
    readonly runId?: string;
  } = {},
): DurableCoreBoundaryProof {
  assertDurableCoreBoundaryProof(candidate, options);
  return candidate;
}

export async function writeDurableCoreBoundaryProof(
  proof: DurableCoreBoundaryProof,
): Promise<string | undefined> {
  const configured = Deno.env.get("BAKERY_DURABLE_CORE_PROOF_DIR")?.trim();
  if (!configured) return undefined;
  const expectedRunId = Deno.env.get("BAKERY_DURABLE_CORE_RUN_ID")?.trim();
  if (!expectedRunId) {
    throw new Error("DURABLE_CORE_BOUNDARY_RUN_ID_MISSING");
  }
  const validatedProof = parseDurableCoreBoundaryProof(proof, {
    revision: proof.revision,
  });
  const directory = await ensureProofDirectory(proofDirectory());
  const path = `${directory}/${validatedProof.kind}-boundary.json`;
  const text = `${JSON.stringify(validatedProof, null, 2)}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_BOUNDARY_PROOF_BYTES) {
    throw new Error("DURABLE_CORE_BOUNDARY_PROOF_TOO_LARGE");
  }
  await Deno.writeTextFile(path, text, { createNew: true, mode: 0o600 });
  return path;
}
