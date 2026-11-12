import {
  gitLauncherArgs,
  SERVER_GIT_LAUNCHER,
} from "../../platform/server-exec.ts";
import { createHash } from "node:crypto";
import { REPOSITORY_INSPECTION_LIMITS as LIMITS } from "@bakery/config";
import {
  type RepositoryInspectionCheck,
  type RepositoryInspectionJobInput,
  RepositoryInspectionPathSchema,
  type RepositoryInspectionSourceEnvelope,
  RepositoryInspectionSourceEnvelopeSchema,
  type RepositoryObservedProfileConfig,
  RepositoryObservedProfileConfigSchema,
  type RepositoryVersionedProfileConfig,
  RepositoryVersionedProfileConfigSchema,
} from "@bakery/contracts/repository-inspection";
import type { TrustedRepositorySource } from "../knowledge/import.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";

export class RepositoryInspectionError extends Error {
  constructor(
    readonly code:
      | "source_unavailable"
      | "source_authority"
      | "source_invalid"
      | "source_limit"
      | "deadline"
      | "unsupported_manifest",
  ) {
    super(code);
    this.name = "RepositoryInspectionError";
  }
}
function fail(code: RepositoryInspectionError["code"]): never {
  throw new RepositoryInspectionError(code);
}
const decoder = new TextDecoder("utf-8", { fatal: true });
// The git launcher (infra/server-exec/git.sh) sets RLIMIT_AS (256 MiB), which
// bounds decompression and pack allocations before any stdout, and git's clean
// environment.

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > max) fail("source_limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function git(
  cwd: string,
  args: string[],
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  let child: Deno.ChildProcess;
  try {
    // The fixed git launcher applies the address-space limit, hooks and
    // fsmonitor off, protocol.allow=never and the clean environment itself.
    child = new Deno.Command(SERVER_GIT_LAUNCHER, {
      args: gitLauncherArgs(cwd, args),
      cwd,
      clearEnv: true,
      env: {},
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    return fail("source_unavailable");
  }
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch { /* Already exited. */ }
  };
  const timer = setTimeout(kill, LIMITS.commandMs);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [bytes, status] = await Promise.all([
      readBounded(child.stdout, max),
      child.status,
    ]);
    signal.throwIfAborted();
    if (!status.success) fail("source_unavailable");
    return bytes;
  } catch (error) {
    kill();
    await child.status;
    if (signal.aborted) fail("deadline");
    if (error instanceof RepositoryInspectionError) throw error;
    return fail("source_invalid");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
}
async function objectSize(
  cwd: string,
  objectId: string,
  type: "commit" | "tree" | "blob",
  maximum: number,
  signal: AbortSignal,
): Promise<number> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) {
    fail("source_invalid");
  }
  const actualType = decoder.decode(
    await git(cwd, ["cat-file", "-t", objectId], 16, signal),
  );
  if (actualType !== `${type}\n`) fail("source_invalid");
  const output = decoder.decode(
    await git(cwd, ["cat-file", "-s", objectId], 32, signal),
  );
  if (!/^(?:0|[1-9][0-9]*)\n$/.test(output)) fail("source_invalid");
  const size = Number(output);
  if (!Number.isSafeInteger(size) || size > maximum) fail("source_limit");
  return size;
}

async function readObject(
  cwd: string,
  objectId: string,
  type: "commit" | "tree" | "blob",
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const size = await objectSize(cwd, objectId, type, maximum, signal);
  const bytes = await git(cwd, ["cat-file", type, objectId], size, signal);
  if (bytes.length !== size) fail("source_invalid");
  await verifyGitObject(objectId, type, bytes);
  return bytes;
}
async function proveRepositoryAncestors(
  path: string,
  uid: number | null,
  signal: AbortSignal,
): Promise<void> {
  const components = path.split("/");
  const ancestors = components.slice(1).map((_, index) =>
    components.slice(0, index + 1).join("/") || "/"
  );
  signal.throwIfAborted();
  // GNU stat does not dereference the final component without -L. Its fixed
  // numeric format proves ancestor metadata without granting Deno ancestor read.
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("/usr/bin/stat", {
      args: ["--format=%f:%u", "--", ...ancestors],
      cwd: "/",
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    return fail("source_unavailable");
  }
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch { /* Already exited. */ }
  };
  const timer = setTimeout(kill, LIMITS.commandMs);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [bytes, status] = await Promise.all([
      readBounded(child.stdout, ancestors.length * 32),
      child.status,
    ]);
    signal.throwIfAborted();
    if (!status.success) fail("source_authority");
    const output = decoder.decode(bytes);
    if (!output.endsWith("\n")) fail("source_authority");
    const records = output.slice(0, -1).split("\n");
    if (records.length !== ancestors.length) fail("source_authority");
    for (const record of records) {
      const match = /^([0-9a-f]{1,4}):([0-9]{1,10})$/.exec(record);
      if (!match) fail("source_authority");
      const mode = parseInt(match[1], 16);
      const owner = Number(match[2]);
      const trustedStickyRoot = owner === 0 && (mode & 0o1000) !== 0;
      if (
        (mode & 0o170000) !== 0o040000 || (owner !== uid && owner !== 0) ||
        ((mode & 0o022) !== 0 && !trustedStickyRoot)
      ) fail("source_authority");
    }
  } catch (error) {
    kill();
    await child.status;
    if (signal.aborted) fail("deadline");
    if (error instanceof RepositoryInspectionError) throw error;
    return fail("source_authority");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
}
async function validateRepository(
  path: string,
  signal: AbortSignal,
): Promise<void> {
  if (
    !path.startsWith("/") || path === "/" ||
    path.split("/").some((part, i) =>
      i > 0 && (!part || part === "." || part === "..")
    )
  ) fail("source_authority");
  if (await Deno.realPath(path) !== path) fail("source_authority");
  const uid = Deno.uid();
  await proveRepositoryAncestors(path, uid, signal);
  let count = 0;
  const scan = async (candidate: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (++count > 16384 || depth > 32) fail("source_limit");
    const stat = await Deno.lstat(candidate);
    if (
      stat.isSymlink || (!stat.isFile && !stat.isDirectory) ||
      stat.uid === null || (stat.uid !== uid && stat.uid !== 0) ||
      ((stat.mode ?? 0) & 0o022) !== 0
    ) fail("source_authority");
    if (stat.isDirectory) {
      for await (const entry of Deno.readDir(candidate)) {
        await scan(`${candidate}/${entry.name}`, depth + 1);
      }
    }
  };
  await scan(path, 0);
  for (
    const suffix of ["objects/info/alternates", "objects/info/http-alternates"]
  ) {
    try {
      if ((await Deno.stat(`${path}/${suffix}`)).size > 0) {
        fail("source_authority");
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if ((await Deno.stat(`${path}/config`)).size > 65536) fail("source_limit");
  const config = await Deno.readTextFile(`${path}/config`);
  if (config.length > 65536 || /\[\s*(?:include|includeIf)\b/i.test(config)) {
    fail("source_authority");
  }
  let extensions = false;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      extensions = /^\[\s*extensions\s*\]$/i.test(line);
    } else if (extensions && !/^objectformat\s*=\s*sha256$/i.test(line)) {
      fail("source_authority");
    }
  }
}
const base64 = (bytes: Uint8Array): string => {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(value);
};

async function verifyGitObject(
  objectId: string,
  type: "commit" | "tree" | "blob",
  bytes: Uint8Array,
): Promise<void> {
  const header = new TextEncoder().encode(`${type} ${bytes.length}\0`);
  const material = new Uint8Array(header.length + bytes.length);
  material.set(header);
  material.set(bytes, header.length);
  const actual = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        objectId.length === 40 ? "SHA-1" : "SHA-256",
        material,
      ),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== objectId) fail("source_invalid");
}

export async function inspectTrustedRepositorySource(
  scope: {
    organizationId: string;
    applicationId: string;
    repositoryId: string;
  },
  mapping: TrustedRepositorySource,
  signal?: AbortSignal,
): Promise<RepositoryInspectionSourceEnvelope> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, LIMITS.durationMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mapping.snapshotSha)) {
      fail("source_invalid");
    }
    const path = mapping.bareRepositoryPath;
    await validateRepository(path, controller.signal);
    const text = async (args: string[]) =>
      decoder.decode(await git(path, args, 256, controller.signal)).trim();
    if (
      await text(["rev-parse", "--is-bare-repository"]) !== "true" ||
      await text(["rev-parse", "--is-shallow-repository"]) !== "false"
    ) fail("source_invalid");
    const commit = await readObject(
      path,
      mapping.snapshotSha,
      "commit",
      LIMITS.fileBytes,
      controller.signal,
    );
    const firstLineEnd = commit.indexOf(10);
    if (firstLineEnd < 0 || firstLineEnd > 80) fail("source_invalid");
    const treeLine = /^tree ([0-9a-f]+)$/.exec(
      decoder.decode(commit.subarray(0, firstLineEnd)),
    );
    if (!treeLine || treeLine[1].length !== mapping.snapshotSha.length) {
      fail("source_invalid");
    }
    const records: {
      path: string;
      mode: "100644" | "100755";
      blobSha: string;
    }[] = [];
    let treeCount = 0;
    let treeBytes = 0;
    const visitTree = async (
      treeId: string,
      prefix: string,
      depth: number,
    ): Promise<void> => {
      controller.signal.throwIfAborted();
      if (++treeCount > LIMITS.entries || depth > LIMITS.pathSegments) {
        fail("source_limit");
      }
      const bytes = await readObject(
        path,
        treeId,
        "tree",
        LIMITS.entries * 640 - treeBytes,
        controller.signal,
      );
      treeBytes += bytes.length;
      let offset = 0;
      const names = new Set<string>();
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset);
        const nul = bytes.indexOf(0, space + 1);
        const hashBytes = mapping.snapshotSha.length / 2;
        if (
          space < offset || nul <= space || nul + 1 + hashBytes > bytes.length
        ) fail("source_invalid");
        const mode = decoder.decode(bytes.subarray(offset, space));
        const name = decoder.decode(bytes.subarray(space + 1, nul));
        const filePath = `${prefix}${name}`;
        if (
          name.includes("/") || names.has(name) ||
          !RepositoryInspectionPathSchema.safeParse(filePath).success
        ) fail("source_invalid");
        names.add(name);
        const objectId = [...bytes.subarray(nul + 1, nul + 1 + hashBytes)].map((
          byte,
        ) => byte.toString(16).padStart(2, "0")).join("");
        offset = nul + 1 + hashBytes;
        if (mode === "40000") {
          await visitTree(objectId, `${filePath}/`, depth + 1);
        } else if (mode === "100644" || mode === "100755") {
          records.push({ path: filePath, mode, blobSha: objectId });
          if (records.length > LIMITS.entries) fail("source_limit");
        } else fail("source_invalid");
      }
    };
    await visitTree(treeLine[1], "", 1);
    const entries: RepositoryInspectionSourceEnvelope["entries"] = [];
    let total = 0;
    for (const record of records) {
      const bytes = await readObject(
        path,
        record.blobSha,
        "blob",
        Math.min(LIMITS.fileBytes, LIMITS.decodedBytes - total),
        controller.signal,
      );
      total += bytes.length;
      const hash = [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            bytes as Uint8Array<ArrayBuffer>,
          ),
        ),
      ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      entries.push({
        path: record.path,
        mode: record.mode,
        sha256: hash,
        contentBase64: base64(bytes),
      });
    }
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifestDigest = await sha256Hex(
      canonicalJson(
        entries.map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          sha256: entry.sha256,
          size: atob(entry.contentBase64).length,
        })),
      ),
    );
    const envelope = RepositoryInspectionSourceEnvelopeSchema.parse({
      ...scope,
      source: {
        mappingRevision: mapping.mappingRevision,
        mappingDigest: mapping.mappingDigest,
        baseSha: mapping.snapshotSha,
        manifestDigest,
      },
      entries,
    });
    if (
      new TextEncoder().encode(canonicalJson(envelope)).length >
        LIMITS.envelopeBytes
    ) fail("source_limit");
    controller.signal.throwIfAborted();
    return envelope;
  } catch (error) {
    if (error instanceof RepositoryInspectionError) throw error;
    return fail(controller.signal.aborted ? "deadline" : "source_unavailable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function repositoryInspectionSourceMetadata(
  envelope: RepositoryInspectionSourceEnvelope,
): Promise<RepositoryInspectionJobInput["source"]> {
  const canonical = canonicalJson(
    RepositoryInspectionSourceEnvelopeSchema.parse(envelope),
  );
  const envelopeBytes = new TextEncoder().encode(canonical).length;
  const decodedBytes = envelope.entries.reduce(
    (sum, entry) => sum + atob(entry.contentBase64).length,
    0,
  );
  if (
    envelopeBytes > LIMITS.envelopeBytes || decodedBytes > LIMITS.decodedBytes
  ) fail("source_limit");
  return {
    ...envelope.source,
    envelopeDigest: await sha256Hex(canonical),
    envelopeBytes,
    decodedBytes,
    entryCount: envelope.entries.length,
  };
}

function permitsConfigFreeDenoCheck(
  prefix: string,
  manifests: ReadonlyMap<string, Record<string, unknown> | null>,
): boolean {
  let directory = prefix;
  let nearest = true;
  for (;;) {
    const path = manifests.has(`${directory}deno.json`)
      ? `${directory}deno.json`
      : `${directory}deno.jsonc`;
    if (manifests.has(path)) {
      const config = manifests.get(path);
      if (!config) return false;
      if (nearest) {
        // --no-config cannot reproduce compiler options, injected types/libs,
        // or unstable API settings. An empty setting does not alter the check.
        const options = config.compilerOptions;
        if (
          options !== undefined &&
          (options === null || typeof options !== "object" ||
            Array.isArray(options) || Object.keys(options).length !== 0)
        ) return false;
        if (
          config.unstable !== undefined &&
          (!Array.isArray(config.unstable) || config.unstable.length !== 0)
        ) return false;
        nearest = false;
      }
      // Ancestor workspace discovery may apply root settings to a member even
      // when a nearer config exists. No workspace graph is admitted here.
      if (
        config.workspace !== undefined &&
        (!Array.isArray(config.workspace) || config.workspace.length !== 0)
      ) return false;
    }
    if (directory === "") return true;
    directory = directory.replace(/[^/]+\/$/, "");
  }
}

export function deriveRepositoryInspectionConfig(
  baseline: RepositoryVersionedProfileConfig,
  envelope: RepositoryInspectionSourceEnvelope,
): RepositoryObservedProfileConfig {
  const config = RepositoryVersionedProfileConfigSchema.parse(baseline);
  const checks: RepositoryInspectionCheck[] = [
    {
      id: "source.integrity",
      template: "source.integrity.v1",
      tool: null,
      paths: [],
      required: true,
    },
    ...(["git", "deno", "node"] as const).map((tool) => ({
      id: `tool.${tool}`,
      template: "tool.version.v1" as const,
      tool,
      paths: [],
      required: tool === "git",
    })),
  ];
  const requiredTools = new Set(["git"]);
  const manifests = envelope.entries.filter((entry) =>
    /(?:^|\/)(?:package\.json|deno\.json|deno\.jsonc)$/.test(entry.path)
  );
  const objects = new Map<string, Record<string, unknown> | null>();
  for (const manifest of manifests) {
    let value: unknown;
    try {
      value = JSON.parse(
        decoder.decode(
          Uint8Array.from(
            atob(manifest.contentBase64),
            (character) => character.charCodeAt(0),
          ),
        ),
      );
    } catch {
      value = null;
    }
    objects.set(
      manifest.path,
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null,
    );
  }
  for (let index = 0; index < manifests.length; index++) {
    const manifest = manifests[index];
    const object = objects.get(manifest.path);
    const scripts = object
      ?.[manifest.path.endsWith("package.json") ? "scripts" : "tasks"];
    if (
      !object ||
      (scripts !== undefined &&
        (scripts === null || typeof scripts !== "object" ||
          Array.isArray(scripts)))
    ) {
      checks.push({
        id: `manifest.${index}`,
        template: "unsupported.v1",
        tool: null,
        paths: [],
        required: true,
      });
      if (checks.length > 64) fail("source_limit");
      continue;
    }
    const commands = Object.entries((scripts ?? {}) as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (let ordinal = 0; ordinal < commands.length; ordinal++) {
      const [, command] = commands[ordinal];
      const match = typeof command === "string"
        ? /^(node --check|deno check) ([A-Za-z0-9_.@+\/-]+(?: [A-Za-z0-9_.@+\/-]+)*)$/
          .exec(command)
        : null;
      const prefix = manifest.path.includes("/")
        ? manifest.path.slice(0, manifest.path.lastIndexOf("/") + 1)
        : "";
      const paths = match
        ? match[2].split(" ").map((path) => `${prefix}${path}`)
        : [];
      const tool = match?.[1] === "node --check"
        ? "node"
        : match
        ? "deno"
        : null;
      const valid = tool &&
        (tool !== "deno" || permitsConfigFreeDenoCheck(prefix, objects)) &&
        paths.length > 0 && paths.length <= 64 &&
        (tool !== "node" || paths.length === 1) && paths.every((path) => {
          const entry = envelope.entries.find((candidate) =>
            candidate.path === path
          );
          if (
            !entry || !RepositoryInspectionPathSchema.safeParse(path).success
          ) return false;
          if (tool === "node") return /\.(?:js|cjs|mjs)$/.test(path);
          // No import graph is admitted without a path-confined module loader.
          // Even local imports can otherwise read files outside the private source.
          try {
            const content = decoder.decode(
              Uint8Array.from(
                atob(entry.contentBase64),
                (character) => character.charCodeAt(0),
              ),
            );
            return /\.(?:ts|js)$/.test(path) &&
              !/\b(?:import|from|require)\b|<reference\b|sourceMappingURL|sourceURL|\\u/
                .test(content);
          } catch {
            return false;
          }
        });
      checks.push({
        id: `manifest.${index}.check.${ordinal}`,
        template: valid
          ? tool === "node" ? "node.syntax.v1" : "deno.check.v1"
          : "unsupported.v1",
        tool: valid ? tool : null,
        paths: valid ? paths : [],
        required: true,
      });
      if (valid && tool) requiredTools.add(tool);
      if (checks.length > 64) fail("source_limit");
    }
  }
  for (const check of checks) {
    if (check.template === "tool.version.v1" && check.tool) {
      check.required = requiredTools.has(check.tool);
    }
  }
  const checkPolicy = {
    schemaVersion: 1 as const,
    platform: "linux" as const,
    tools: (["git", "deno", "node"] as const).map((tool) => ({
      tool,
      required: requiredTools.has(tool),
    })),
    checks,
  };
  const fixedPolicy = config.fixedPolicy === undefined ? undefined : {
    ...config.fixedPolicy,
    trustedChecker: {
      kind: "repository-inspection" as const,
      configDigest: createHash("sha256").update(canonicalJson(checkPolicy))
        .digest("hex"),
    },
  };
  return RepositoryObservedProfileConfigSchema.parse({
    schemaVersion: 2,
    workflow: config.workflow,
    branches: config.branches,
    worktree: config.worktree,
    checkPolicy,
    ...(fixedPolicy === undefined ? {} : { fixedPolicy }),
    // Agent bindings and overrides are repository intent, not observation:
    // carry them forward so the activated observed profile resolves the same
    // step agents and the same effective rules. Without the bindings a run on
    // an observed profile could never admit a model step (`model_agent_required`).
    ...(config.agentBindings === undefined
      ? {}
      : { agentBindings: config.agentBindings }),
    ...(config.repositoryRules === undefined
      ? {}
      : { repositoryRules: config.repositoryRules }),
  });
}
