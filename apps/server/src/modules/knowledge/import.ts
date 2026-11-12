import {
  gitLauncherArgs,
  SERVER_GIT_LAUNCHER,
} from "../../platform/server-exec.ts";
import { isUuid, PrincipalType } from "@bakery/contracts/contracts";
import { parseStrongIfMatch, StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { appendAudit } from "@bakery/persistence/event-audit";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { sha256Bytes } from "./bytes.ts";
import { classifyArtifactMedia, inferArtifactMediaType } from "./media.ts";
import { commitArtifactVersion } from "./persistence.ts";
import { authorize } from "../auth/application/authorize.ts";
import { requireOrganizationRole } from "../auth/application/authority.ts";

const TRUSTED_REPOSITORIES_ENV = "BAKERY_TRUSTED_REPOSITORIES_JSON";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CONFIG_ENTRIES = 128;
const MAX_PATH_BYTES = 4096;
const MAX_GIT_METADATA_BYTES = 16 * 1024;
const MAX_GIT_COMMIT_BYTES = 1024 * 1024;
const MAX_GIT_TREE_BYTES = 10 * 1024 * 1024;
const MAX_CANONICAL_BYTES = 10 * 1024 * 1024;
const MAX_PATH_COMPONENTS = 64;
const GIT_PROOF_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_GIT_PROOFS = 4;
let activeGitProofs = 0;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONFIG_FIELDS: Readonly<Record<string, true>> = {
  schemaVersion: true,
  entries: true,
};
const ENTRY_FIELDS: Readonly<Record<string, true>> = {
  organizationId: true,
  applicationId: true,
  repositoryUuid: true,
  bareRepositoryPath: true,
  mappingRevision: true,
  mappingDigest: true,
  snapshotSha: true,
  status: true,
};
const SOURCE_FIELDS: Readonly<Record<string, true>> = {
  bareRepositoryPath: true,
  mappingRevision: true,
  mappingDigest: true,
  snapshotSha: true,
};
const MAPPING_REVISION_MAX_BYTES = 128;
const CONTROL_CHARACTER_MAX = 0x1f;
const DELETE_CHARACTER = 0x7f;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= CONTROL_CHARACTER_MAX || code === DELETE_CHARACTER) return true;
  }
  return false;
}

function isValidMappingRevision(value: string): boolean {
  return value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAPPING_REVISION_MAX_BYTES &&
    !hasControlCharacter(value);
}

type JsonRecord = Record<string, unknown>;
type EntryStatus = "active" | "revoked";

type OperatorEntry = Readonly<{
  organizationId: string;
  applicationId: string;
  repositoryUuid: string;
  bareRepositoryPath: string;
  mappingRevision: string;
  mappingDigest: string;
  snapshotSha: string;
  status: EntryStatus;
}>;

type OperatorConfig = ReadonlyMap<string, OperatorEntry>;

type ImportScopeRow = {
  taskId: string;
  applicationId: string;
  repositoryUuid: string;
  conversationId: string | null;
  parentId: string;
  parentRevision: number;
  parentVersion: number;
  currentVersionId: string | null;
};

export type VerifiedGitBlob = Readonly<{
  commitSha: string;
  path: string;
  mode: "100644" | "100755";
  blobSha: string;
  content: Uint8Array;
  sha256: string;
  mediaType: string;
}>;

export type TrustedRepositoryScope = Readonly<{
  organizationId: string;
  applicationId: string;
  repositoryUuid: string;
}>;

export type TrustedRepositorySource = Readonly<{
  bareRepositoryPath: string;
  mappingRevision: string;
  mappingDigest: string;
  snapshotSha: string;
}>;

export interface TrustedRepositoryResolver {
  resolve(scope: TrustedRepositoryScope): Promise<TrustedRepositorySource>;
}

export type ArtifactVersionImportContext = Readonly<{
  organizationId: string;
  principalId: string;
  artifactId: string;
  requestId: string;
  traceId?: string;
  signal?: AbortSignal;
}>;

export type ArtifactVersionImportHeaders = Readonly<{
  idempotencyKey: string;
  ifMatch: string;
}>;

export type ArtifactVersionImportInput = Readonly<{
  path: string;
  commitSha: string;
}>;

export type ArtifactVersionImportPreparation = Readonly<{
  context: ArtifactVersionImportContext;
  headers: ArtifactVersionImportHeaders;
  input: ArtifactVersionImportInput;
  expectedVersion: number;
  scope: ImportScopeRow;
  source: TrustedRepositorySource;
}>;

export type ArtifactVersionImportProof = Readonly<{
  source: TrustedRepositorySource;
  verified: VerifiedGitBlob;
}>;

export type ArtifactVersionImportOutput = Readonly<Record<string, unknown>>;

function fail(
  code:
    | "AUTH_FORBIDDEN"
    | "DEPENDENCY_TIMEOUT"
    | "DEPENDENCY_UNAVAILABLE"
    | "PRECONDITION_FAILED"
    | "PRECONDITION_REQUIRED"
    | "RESOURCE_NOT_FOUND"
    | "UNPROCESSABLE",
): never {
  throw new StandardError({ code });
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(
  value: JsonRecord,
  fields: Readonly<Record<string, true>>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === Object.keys(fields).length &&
    keys.every((key) => Object.hasOwn(fields, key));
}

function boundedJsonBytes(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  if (typeof serialized !== "string") fail("DEPENDENCY_UNAVAILABLE");
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_CONFIG_BYTES) fail("DEPENDENCY_UNAVAILABLE");
  return bytes;
}

function canonicalBareRepositoryPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  if (
    new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES ||
    hasControlCharacter(value) || value.includes("\\") ||
    !value.startsWith("/") || value === "/" || value.endsWith("/") ||
    value.includes("//")
  ) fail("DEPENDENCY_UNAVAILABLE");
  const parts = value.slice(1).split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) fail("DEPENDENCY_UNAVAILABLE");
  const canonical = `/${parts.join("/")}`;
  if (canonical !== value) fail("DEPENDENCY_UNAVAILABLE");
  return value;
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  return value.toLowerCase();
}

function requireGitObjectId(value: unknown): string {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  return value;
}

function requireMappingRevision(value: unknown): string {
  if (typeof value !== "string" || !isValidMappingRevision(value)) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  return value;
}

function requireMappingDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  return value;
}

function mappingMaterial(entry: OperatorEntry): JsonRecord {
  return {
    applicationId: entry.applicationId,
    bareRepositoryPath: entry.bareRepositoryPath,
    mappingRevision: entry.mappingRevision,
    organizationId: entry.organizationId,
    repositoryUuid: entry.repositoryUuid,
    snapshotSha: entry.snapshotSha,
    status: entry.status,
  };
}

function configKey(scope: TrustedRepositoryScope): string {
  return `${scope.organizationId.toLowerCase()}\u001f${scope.applicationId.toLowerCase()}\u001f${scope.repositoryUuid.toLowerCase()}`;
}

function parseOperatorConfig(candidate: unknown): OperatorConfig {
  let decoded = candidate;
  if (typeof candidate === "string") {
    if (new TextEncoder().encode(candidate).byteLength > MAX_CONFIG_BYTES) {
      fail("DEPENDENCY_UNAVAILABLE");
    }
    try {
      decoded = JSON.parse(candidate);
    } catch {
      fail("DEPENDENCY_UNAVAILABLE");
    }
  }
  if (!isPlainRecord(decoded) || !hasExactFields(decoded, CONFIG_FIELDS)) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  boundedJsonBytes(decoded);
  if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.entries)) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  if (decoded.entries.length > MAX_CONFIG_ENTRIES) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  const entries = new Map<string, OperatorEntry>();
  for (const candidateEntry of decoded.entries) {
    if (
      !isPlainRecord(candidateEntry) ||
      !hasExactFields(candidateEntry, ENTRY_FIELDS)
    ) {
      fail("DEPENDENCY_UNAVAILABLE");
    }
    const entry: OperatorEntry = Object.freeze({
      organizationId: requireUuid(candidateEntry.organizationId),
      applicationId: requireUuid(candidateEntry.applicationId),
      repositoryUuid: requireUuid(candidateEntry.repositoryUuid),
      bareRepositoryPath: canonicalBareRepositoryPath(
        candidateEntry.bareRepositoryPath,
      ),
      mappingRevision: requireMappingRevision(candidateEntry.mappingRevision),
      mappingDigest: requireMappingDigest(candidateEntry.mappingDigest),
      snapshotSha: requireGitObjectId(candidateEntry.snapshotSha),
      status: candidateEntry.status === "active" ||
          candidateEntry.status === "revoked"
        ? candidateEntry.status
        : (() => fail("DEPENDENCY_UNAVAILABLE"))(),
    });
    const key = configKey(entry);
    if (entries.has(key)) fail("DEPENDENCY_UNAVAILABLE");
    entries.set(key, entry);
  }
  return entries;
}

function readEnvironmentConfig(): unknown {
  const encoded = Deno.env.get(TRUSTED_REPOSITORIES_ENV);
  if (encoded === undefined) return undefined;
  if (new TextEncoder().encode(encoded).byteLength > MAX_CONFIG_BYTES) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  try {
    return JSON.parse(encoded);
  } catch {
    fail("DEPENDENCY_UNAVAILABLE");
  }
}

function invalidResolver(): TrustedRepositoryResolver {
  return Object.freeze({
    resolve(): Promise<TrustedRepositorySource> {
      return Promise.reject(
        new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
      );
    },
  });
}

async function validateTrustedRepositorySource(
  value: unknown,
  scope: TrustedRepositoryScope,
): Promise<TrustedRepositorySource> {
  if (!isPlainRecord(value) || !hasExactFields(value, SOURCE_FIELDS)) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  const source = Object.freeze({
    bareRepositoryPath: canonicalBareRepositoryPath(value.bareRepositoryPath),
    mappingRevision: requireMappingRevision(value.mappingRevision),
    mappingDigest: requireMappingDigest(value.mappingDigest),
    snapshotSha: requireGitObjectId(value.snapshotSha),
  });
  let computedDigest: string;
  try {
    computedDigest = await sha256Hex(canonicalJson({
      applicationId: scope.applicationId.toLowerCase(),
      bareRepositoryPath: source.bareRepositoryPath,
      mappingRevision: source.mappingRevision,
      organizationId: scope.organizationId.toLowerCase(),
      repositoryUuid: scope.repositoryUuid.toLowerCase(),
      snapshotSha: source.snapshotSha,
      status: "active",
    }));
  } catch {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  if (computedDigest !== source.mappingDigest) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  return source;
}

export function createTrustedRepositoryResolver(
  operatorConfig?: unknown,
): TrustedRepositoryResolver {
  let config: OperatorConfig;
  try {
    config = parseOperatorConfig(
      operatorConfig === undefined ? readEnvironmentConfig() : operatorConfig,
    );
  } catch {
    return invalidResolver();
  }
  return Object.freeze({
    async resolve(
      scope: TrustedRepositoryScope,
    ): Promise<TrustedRepositorySource> {
      if (
        !isUuid(scope.organizationId) || !isUuid(scope.applicationId) ||
        !isUuid(scope.repositoryUuid)
      ) fail("RESOURCE_NOT_FOUND");
      const entry = config.get(configKey(scope));
      if (!entry || entry.status !== "active") {
        fail("DEPENDENCY_UNAVAILABLE");
      }
      let computedDigest: string;
      try {
        computedDigest = await sha256Hex(canonicalJson(mappingMaterial(entry)));
      } catch {
        fail("DEPENDENCY_UNAVAILABLE");
      }
      if (computedDigest !== entry.mappingDigest) {
        fail("DEPENDENCY_UNAVAILABLE");
      }
      return Object.freeze({
        bareRepositoryPath: entry.bareRepositoryPath,
        mappingRevision: entry.mappingRevision,
        mappingDigest: entry.mappingDigest,
        snapshotSha: entry.snapshotSha,
      });
    },
  });
}

function canonicalRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("UNPROCESSABLE");
  if (
    new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES ||
    hasControlCharacter(value) || value.includes("\\") ||
    value.startsWith("/") || value.endsWith("/") || value.includes("//")
  ) fail("UNPROCESSABLE");
  const parts = value.split("/");
  if (parts.length > MAX_PATH_COMPONENTS) fail("UNPROCESSABLE");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    value !== parts.join("/")
  ) fail("UNPROCESSABLE");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) {
      const next = value.charCodeAt(index + 1);
      if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) {
        fail("UNPROCESSABLE");
      }
      index += 1;
    }
  }
  return value;
}

type GitProofBudget = Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}>;

function createGitProofBudget(
  parentSignal?: AbortSignal,
): GitProofBudget {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    GIT_PROOF_TIMEOUT_MS,
  );
  let abortParent: (() => void) | undefined;
  if (parentSignal) {
    abortParent = () => controller.abort();
    if (parentSignal.aborted) {
      abortParent();
    } else {
      parentSignal.addEventListener("abort", abortParent, { once: true });
    }
  }
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeoutId);
      if (parentSignal && abortParent) {
        parentSignal.removeEventListener("abort", abortParent);
      }
    },
  });
}

function assertSignalActive(signal: AbortSignal): void {
  if (signal.aborted) fail("DEPENDENCY_TIMEOUT");
}

async function killAndReap(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited before termination.
  }
  try {
    await child.status;
  } catch {
    // The process status may reject after an aborted command.
  }
}

async function readProcessOutput(
  child: Deno.ChildProcess,
  limit: number,
): Promise<Uint8Array> {
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The pipe may already be closed.
        }
        await killAndReap(child);
        fail("UNPROCESSABLE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readGitBlobOutput(
  child: Deno.ChildProcess,
  size: number,
): Promise<Uint8Array> {
  const reader = child.stdout.getReader();
  const output = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = output.byteLength - offset;
      if (result.value.byteLength > remaining) {
        try {
          await reader.cancel();
        } catch {
          // The pipe may already be closed.
        }
        await killAndReap(child);
        fail("UNPROCESSABLE");
      }
      output.set(result.value, offset);
      offset += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== size) fail("UNPROCESSABLE");
  return output;
}

async function gitOutput(
  bareRepositoryPath: string,
  args: readonly string[],
  limit: number,
  signal: AbortSignal,
  expectedSize?: number,
): Promise<Uint8Array> {
  assertSignalActive(signal);
  let child: Deno.ChildProcess;
  try {
    // The fixed git launcher sets git's clean environment itself.
    child = new Deno.Command(SERVER_GIT_LAUNCHER, {
      args: gitLauncherArgs(bareRepositoryPath, args),
      clearEnv: true,
      env: {},
      signal,
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  const onAbort = () => {
    void killAndReap(child);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (
      expectedSize !== undefined &&
      (!Number.isSafeInteger(expectedSize) || expectedSize < 0 ||
        expectedSize > limit)
    ) {
      fail("UNPROCESSABLE");
    }
    const output = expectedSize === undefined
      ? await readProcessOutput(child, limit)
      : await readGitBlobOutput(child, expectedSize);
    const status = await child.status;
    if (!status.success) fail("DEPENDENCY_UNAVAILABLE");
    return output;
  } catch (error) {
    await killAndReap(child);
    if (signal.aborted) fail("DEPENDENCY_TIMEOUT");
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function gitHashObject(
  bareRepositoryPath: string,
  content: Uint8Array,
  signal: AbortSignal,
  objectType: "blob" | "commit" | "tree" = "blob",
): Promise<string> {
  assertSignalActive(signal);
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(SERVER_GIT_LAUNCHER, {
      args: gitLauncherArgs(bareRepositoryPath, [
        "hash-object",
        "-t",
        objectType,
        "--stdin",
        "--no-filters",
      ]),
      clearEnv: true,
      env: {},
      signal,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  const outputPromise = readProcessOutput(child, MAX_GIT_METADATA_BYTES);
  const onAbort = () => {
    void killAndReap(child);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    assertSignalActive(signal);
    const stdin = child.stdin;
    if (!stdin) fail("DEPENDENCY_UNAVAILABLE");
    const writer = stdin.getWriter();
    try {
      await writer.write(content);
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    const output = await outputPromise;
    const status = await child.status;
    if (!status.success) fail("DEPENDENCY_UNAVAILABLE");
    return requireGitObjectId(decodeGitOutput(output));
  } catch (error) {
    await killAndReap(child);
    await outputPromise.catch(() => {});
    if (signal.aborted) fail("DEPENDENCY_TIMEOUT");
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function decodeGitOutput(output: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output).trim();
  } catch {
    fail("DEPENDENCY_UNAVAILABLE");
  }
}

async function gitText(
  bareRepositoryPath: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  return decodeGitOutput(
    await gitOutput(
      bareRepositoryPath,
      args,
      MAX_GIT_METADATA_BYTES,
      signal,
    ),
  );
}

function parseGitObjectSize(value: string, limit: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail("UNPROCESSABLE");
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    fail("UNPROCESSABLE");
  }
  return size;
}

async function verifyRawGitObject(
  bareRepositoryPath: string,
  objectId: string,
  objectType: "commit" | "tree",
  signal: AbortSignal,
): Promise<Uint8Array> {
  const actualType = await gitText(
    bareRepositoryPath,
    ["cat-file", "-t", objectId],
    signal,
  );
  if (actualType !== objectType) fail("UNPROCESSABLE");
  const limit = objectType === "tree"
    ? MAX_GIT_TREE_BYTES
    : MAX_GIT_COMMIT_BYTES;
  const size = parseGitObjectSize(
    await gitText(
      bareRepositoryPath,
      ["cat-file", "-s", objectId],
      signal,
    ),
    limit,
  );
  const content = await gitOutput(
    bareRepositoryPath,
    ["cat-file", objectType, objectId],
    limit,
    signal,
    size,
  );
  if (content.byteLength !== size) fail("UNPROCESSABLE");
  const contentObjectId = await gitHashObject(
    bareRepositoryPath,
    content,
    signal,
    objectType,
  );
  if (contentObjectId !== objectId) fail("UNPROCESSABLE");
  return content;
}

function parseCommitTreeSha(
  content: Uint8Array,
  expectedObjectIdLength: number,
): string {
  const newline = content.indexOf(0x0a);
  if (newline <= 0) fail("UNPROCESSABLE");
  let firstLine: string;
  try {
    firstLine = new TextDecoder("utf-8", { fatal: true }).decode(
      content.subarray(0, newline),
    );
  } catch {
    fail("UNPROCESSABLE");
  }
  const match = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(firstLine);
  if (!match || match[1].length !== expectedObjectIdLength) {
    fail("UNPROCESSABLE");
  }
  return requireGitObjectId(match[1]);
}

type VerifiedGitTreeEntry = Readonly<{
  mode: "40000" | "100644" | "100755";
  type: "blob" | "tree";
  objectId: string;
}>;

function parseTreeEntry(
  tree: Uint8Array,
  name: string,
  objectIdLength: number,
): VerifiedGitTreeEntry {
  const expectedName = new TextEncoder().encode(name);
  const oidBytes = objectIdLength / 2;
  let match: VerifiedGitTreeEntry | undefined;
  for (let offset = 0; offset < tree.byteLength;) {
    const space = tree.indexOf(0x20, offset);
    const nul = tree.indexOf(0, space + 1);
    if (
      space <= offset || nul <= space + 1 ||
      nul + 1 + oidBytes > tree.byteLength
    ) {
      fail("UNPROCESSABLE");
    }
    const nameStart = space + 1;
    if (
      nul - nameStart === expectedName.byteLength &&
      expectedName.every((byte, index) => tree[nameStart + index] === byte)
    ) {
      if (match) fail("UNPROCESSABLE");
      const mode = new TextDecoder("ascii", { fatal: true }).decode(
        tree.subarray(offset, space),
      );
      if (mode !== "40000" && mode !== "100644" && mode !== "100755") {
        fail("UNPROCESSABLE");
      }
      let objectId = "";
      for (let index = nul + 1; index < nul + 1 + oidBytes; index += 1) {
        objectId += tree[index].toString(16).padStart(2, "0");
      }
      match = {
        mode,
        type: mode === "40000" ? "tree" : "blob",
        objectId,
      };
    }
    offset = nul + 1 + oidBytes;
  }
  if (!match) fail("UNPROCESSABLE");
  return match;
}

async function readVerifiedGitBlob(
  source: TrustedRepositorySource,
  input: ArtifactVersionImportInput,
  signal: AbortSignal,
): Promise<VerifiedGitBlob> {
  const path = canonicalRelativePath(input.path);
  const commitSha = requireGitObjectId(input.commitSha);
  if (commitSha !== source.snapshotSha) fail("UNPROCESSABLE");
  const isBare = await gitText(
    source.bareRepositoryPath,
    ["rev-parse", "--is-bare-repository"],
    signal,
  );
  if (isBare !== "true") fail("UNPROCESSABLE");
  const isShallow = await gitText(
    source.bareRepositoryPath,
    ["rev-parse", "--is-shallow-repository"],
    signal,
  );
  if (isShallow !== "false") fail("UNPROCESSABLE");
  const resolvedCommit = await gitText(
    source.bareRepositoryPath,
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${commitSha}^{commit}`,
    ],
    signal,
  );
  if (resolvedCommit !== commitSha) fail("UNPROCESSABLE");
  const rawCommit = await verifyRawGitObject(
    source.bareRepositoryPath,
    commitSha,
    "commit",
    signal,
  );
  let treeSha = parseCommitTreeSha(rawCommit, commitSha.length);
  const parts = path.split("/");
  let finalEntry: VerifiedGitTreeEntry | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const tree = await verifyRawGitObject(
      source.bareRepositoryPath,
      treeSha,
      "tree",
      signal,
    );
    const entry = parseTreeEntry(tree, parts[index], commitSha.length);
    const isFinal = index === parts.length - 1;
    if (isFinal) {
      finalEntry = entry;
      break;
    }
    if (entry.type !== "tree" || entry.mode !== "40000") {
      fail("UNPROCESSABLE");
    }
    const nextTreeSha = requireGitObjectId(entry.objectId);
    if (nextTreeSha.length !== commitSha.length) fail("UNPROCESSABLE");
    treeSha = nextTreeSha;
  }
  if (!finalEntry || finalEntry.type !== "blob") fail("UNPROCESSABLE");
  if (finalEntry.mode !== "100644" && finalEntry.mode !== "100755") {
    fail("UNPROCESSABLE");
  }
  const mode = finalEntry.mode as "100644" | "100755";
  const blobSha = requireGitObjectId(finalEntry.objectId);
  if (blobSha.length !== commitSha.length) fail("UNPROCESSABLE");
  const blobType = await gitText(
    source.bareRepositoryPath,
    ["cat-file", "-t", blobSha],
    signal,
  );
  if (blobType !== "blob") fail("UNPROCESSABLE");
  const sizeText = await gitText(
    source.bareRepositoryPath,
    ["cat-file", "-s", blobSha],
    signal,
  );
  const size = parseGitObjectSize(sizeText, MAX_CANONICAL_BYTES);
  const content = await gitOutput(
    source.bareRepositoryPath,
    ["cat-file", "blob", blobSha],
    MAX_CANONICAL_BYTES,
    signal,
    size,
  );
  if (content.byteLength !== size) fail("UNPROCESSABLE");
  const contentBlobSha = await gitHashObject(
    source.bareRepositoryPath,
    content,
    signal,
  );
  if (contentBlobSha !== blobSha) fail("UNPROCESSABLE");
  const sha256 = await sha256Bytes(content);
  const media = classifyArtifactMedia({
    declaredType: inferArtifactMediaType(path),
    content,
  });
  if (media === null) fail("UNPROCESSABLE");
  return Object.freeze({
    commitSha,
    path,
    mode,
    blobSha,
    content,
    sha256,
    mediaType: media.mediaType,
  });
}

function validateImportInput(
  input: ArtifactVersionImportInput,
): ArtifactVersionImportInput {
  if (!isPlainRecord(input)) fail("UNPROCESSABLE");
  const keys = Object.keys(input);
  if (
    keys.length !== 2 || !keys.includes("path") || !keys.includes("commitSha")
  ) {
    fail("UNPROCESSABLE");
  }
  canonicalRelativePath(input.path);
  const commitSha = typeof input.commitSha === "string"
    ? input.commitSha.toLowerCase()
    : "";
  if (!GIT_OBJECT_ID.test(commitSha)) fail("UNPROCESSABLE");
  return commitSha === input.commitSha
    ? input
    : { path: input.path, commitSha };
}

function validateImportContext(context: ArtifactVersionImportContext): void {
  if (
    !isUuid(context.organizationId) || !isUuid(context.principalId) ||
    !isUuid(context.artifactId) ||
    (context.traceId !== undefined && typeof context.traceId !== "string")
  ) fail("AUTH_FORBIDDEN");
}

function validateImportHeaders(headers: ArtifactVersionImportHeaders): number {
  if (
    !isPlainRecord(headers) || typeof headers.idempotencyKey !== "string" ||
    headers.idempotencyKey.trim().length === 0 ||
    new TextEncoder().encode(headers.idempotencyKey).byteLength > 255 ||
    typeof headers.ifMatch !== "string"
  ) fail("PRECONDITION_REQUIRED");
  const expectedVersion = parseStrongIfMatch(headers.ifMatch);
  if (expectedVersion === undefined) fail("PRECONDITION_REQUIRED");
  return expectedVersion;
}

async function loadImportScope(
  transaction: PgTransactionClient,
  context: ArtifactVersionImportContext,
  lockRows = true,
): Promise<ImportScopeRow> {
  const organizationId = context.organizationId.toLowerCase();
  const artifactId = context.artifactId.toLowerCase();
  let lockedApplicationId: string | undefined;
  if (lockRows) {
    // The archive command owns the application row. Lock it before the task
    // and artifact, then recheck the complete scope under the same transaction.
    const application = await transaction.query<{ applicationId: string }>(
      `select application.id as "applicationId"
         from bakery.artifacts as a
         join bakery.tasks as t
           on t.organization_id = a.organization_id
          and t.id = a.task_id
         join bakery.applications as application
           on application.organization_id = t.organization_id
          and application.id = t.application_id
        where a.organization_id = $1
          and a.id = $2
          and application.archived_at is null
        for share of application`,
      [organizationId, artifactId],
    );
    lockedApplicationId = application.rows[0]?.applicationId;
    if (!isUuid(lockedApplicationId)) fail("RESOURCE_NOT_FOUND");
  }
  const result = await transaction.query<ImportScopeRow>(
    `select a.task_id as "taskId",
            t.application_id as "applicationId",
            r.id as "repositoryUuid",
            t.conversation_id as "conversationId",
            a.id as "parentId",
            a.revision as "parentRevision",
            a.version as "parentVersion",
            a.current_version_id as "currentVersionId"
       from bakery.artifacts as a
       join bakery.tasks as t
         on t.organization_id = a.organization_id
        and t.id = a.task_id
       join bakery.repositories as r
         on r.organization_id = t.organization_id
        and r.id = t.repository_id
        and r.application_id = t.application_id
       join bakery.applications as application
         on application.organization_id = t.organization_id
        and application.id = t.application_id
      where a.organization_id = $1
        and a.id = $2
        and r.archived_at is null
        and t.archived_at is null
        and application.archived_at is null
        ${lockRows ? "and application.id = $3" : ""}
      ${lockRows ? "for update of a, t" : ""}`,
    lockRows
      ? [organizationId, artifactId, lockedApplicationId]
      : [organizationId, artifactId],
  );
  const row = result.rows[0];
  if (!row) fail("RESOURCE_NOT_FOUND");
  if (
    !isUuid(row.taskId) || !isUuid(row.applicationId) ||
    !isUuid(row.repositoryUuid) || !isUuid(row.parentId) ||
    !Number.isSafeInteger(row.parentRevision) || row.parentRevision < 1 ||
    !Number.isSafeInteger(row.parentVersion) || row.parentVersion < 1
  ) fail("RESOURCE_NOT_FOUND");
  await assertImportScopeAuthority(
    transaction,
    context,
    row.repositoryUuid,
    lockRows,
  );
  return row;
}

async function assertImportScopeAuthority(
  transaction: PgTransactionClient,
  context: ArtifactVersionImportContext,
  repositoryUuid: string,
  lockRows: boolean,
): Promise<void> {
  // Recheck and hold membership, then principal and repository through commit.
  // A caller's concurrent membership command can hold principal before
  // membership; fail fast on that row rather than form a lock cycle.
  const membership = await transaction.query<{
    role: string | null;
    status: string | null;
  }>(
    `select role, status
       from bakery.organization_memberships
      where organization_id = $1
        and principal_id = $2
      ${lockRows ? "for update" : ""}`,
    [
      context.organizationId.toLowerCase(),
      context.principalId.toLowerCase(),
    ],
  );
  const membershipRow = membership.rows[0];
  if (membershipRow?.status !== "active" || membershipRow.role === null) {
    fail("AUTH_FORBIDDEN");
  }
  const role = requireOrganizationRole(membershipRow.role);

  type AuthorityRow = {
    principalType: string;
    disabledAt: Date | string | null;
    archivedAt: Date | string | null;
  };
  let authorityRow: AuthorityRow | undefined;
  try {
    const authority = await transaction.query<AuthorityRow>(
      `select principal.principal_type as "principalType",
              principal.disabled_at as "disabledAt",
              repository.archived_at as "archivedAt"
         from bakery.principals as principal
         join bakery.repositories as repository
           on repository.organization_id = $1
          and repository.id = $3
        where principal.id = $2
        ${lockRows ? "for update of principal, repository nowait" : ""}`,
      [
        context.organizationId.toLowerCase(),
        context.principalId.toLowerCase(),
        repositoryUuid.toLowerCase(),
      ],
    );
    authorityRow = authority.rows[0];
  } catch (error) {
    if (
      lockRows && error !== null && typeof error === "object" &&
      "code" in error && error.code === "55P03"
    ) fail("DEPENDENCY_UNAVAILABLE");
    throw error;
  }
  if (
    !authorityRow || authorityRow.principalType !== "human" ||
    authorityRow.disabledAt !== null || authorityRow.archivedAt !== null
  ) fail("AUTH_FORBIDDEN");
  authorize(
    {
      subject: { principalType: PrincipalType.Human },
      role,
      capabilities: [],
    },
    "artifactVersion:write",
    { action: "artifactVersions.import" },
  );
}

async function resolveImportSource(
  resolver: TrustedRepositoryResolver,
  organizationId: string,
  scope: ImportScopeRow,
): Promise<TrustedRepositorySource> {
  const repositoryScope: TrustedRepositoryScope = {
    organizationId,
    applicationId: scope.applicationId,
    repositoryUuid: scope.repositoryUuid,
  };
  return await validateTrustedRepositorySource(
    await resolver.resolve(repositoryScope),
    repositoryScope,
  );
}

export async function prepareArtifactVersionImport(
  transaction: PgTransactionClient,
  context: ArtifactVersionImportContext,
  headers: ArtifactVersionImportHeaders,
  resolver: TrustedRepositoryResolver,
  input: ArtifactVersionImportInput,
): Promise<ArtifactVersionImportPreparation> {
  validateImportContext(context);
  const normalizedContext = {
    ...context,
    organizationId: context.organizationId.toLowerCase(),
    principalId: context.principalId.toLowerCase(),
    artifactId: context.artifactId.toLowerCase(),
  };
  const expectedVersion = validateImportHeaders(headers);
  const normalizedInput = validateImportInput(input);
  const scope = await loadImportScope(transaction, normalizedContext, false);
  if (scope.parentVersion !== expectedVersion) {
    fail("PRECONDITION_FAILED");
  }
  const source = await resolveImportSource(
    resolver,
    normalizedContext.organizationId,
    scope,
  );
  return Object.freeze({
    context: normalizedContext,
    headers,
    input: normalizedInput,
    expectedVersion,
    scope,
    source,
  });
}

export async function proveArtifactVersionImport(
  preparation: ArtifactVersionImportPreparation,
): Promise<ArtifactVersionImportProof> {
  if (activeGitProofs >= MAX_CONCURRENT_GIT_PROOFS) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  activeGitProofs += 1;
  try {
    const budget = createGitProofBudget(preparation.context.signal);
    try {
      assertSignalActive(budget.signal);
      const verified = await readVerifiedGitBlob(
        preparation.source,
        preparation.input,
        budget.signal,
      );
      assertSignalActive(budget.signal);
      return Object.freeze({
        source: preparation.source,
        verified,
      });
    } finally {
      budget.dispose();
    }
  } finally {
    activeGitProofs -= 1;
  }
}

function assertSameImportSource(
  expected: TrustedRepositorySource,
  actual: TrustedRepositorySource,
): void {
  if (
    expected.bareRepositoryPath !== actual.bareRepositoryPath ||
    expected.mappingRevision !== actual.mappingRevision ||
    expected.mappingDigest !== actual.mappingDigest ||
    requireGitObjectId(expected.snapshotSha) !==
      requireGitObjectId(actual.snapshotSha)
  ) fail("DEPENDENCY_UNAVAILABLE");
}

function assertImportProof(
  proof: ArtifactVersionImportProof,
  source: TrustedRepositorySource,
  input: ArtifactVersionImportInput,
): VerifiedGitBlob {
  const path = canonicalRelativePath(input.path);
  const commitSha = requireGitObjectId(input.commitSha);
  const { verified } = proof;
  const verifiedCommitSha = requireGitObjectId(verified.commitSha);
  const blobSha = requireGitObjectId(verified.blobSha);
  if (
    verifiedCommitSha !== commitSha ||
    verifiedCommitSha !== source.snapshotSha ||
    verified.path !== path ||
    (verified.mode !== "100644" && verified.mode !== "100755") ||
    !(verified.content instanceof Uint8Array) ||
    verified.content.byteLength > MAX_CANONICAL_BYTES ||
    typeof verified.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(verified.sha256) ||
    typeof verified.mediaType !== "string"
  ) fail("DEPENDENCY_UNAVAILABLE");
  const media = classifyArtifactMedia({
    declaredType: verified.mediaType,
    content: verified.content,
  });
  if (media === null || media.mediaType !== verified.mediaType) {
    fail("DEPENDENCY_UNAVAILABLE");
  }
  return Object.freeze({
    ...verified,
    commitSha: verifiedCommitSha,
    blobSha,
  });
}

export async function importArtifactVersion(
  transaction: PgTransactionClient,
  context: ArtifactVersionImportContext,
  headers: ArtifactVersionImportHeaders,
  resolver: TrustedRepositoryResolver,
  input: ArtifactVersionImportInput,
  proof: ArtifactVersionImportProof,
): Promise<ArtifactVersionImportOutput> {
  validateImportContext(context);
  const organizationId = context.organizationId.toLowerCase();
  const principalId = context.principalId.toLowerCase();
  const expectedVersion = validateImportHeaders(headers);
  const normalizedInput = validateImportInput(input);
  const scope = await loadImportScope(transaction, {
    ...context,
    organizationId,
    principalId,
    artifactId: context.artifactId.toLowerCase(),
  });
  if (scope.parentVersion !== expectedVersion) {
    fail("PRECONDITION_FAILED");
  }
  const source = await resolveImportSource(resolver, organizationId, scope);
  assertSameImportSource(proof.source, source);
  const verified = assertImportProof(proof, source, normalizedInput);
  const metadata = {
    sourceRepositoryId: scope.repositoryUuid,
    path: verified.path,
    commitSha: verified.commitSha,
  } satisfies Record<string, unknown>;
  const traceId = context.traceId?.trim() || crypto.randomUUID();
  const response = await commitArtifactVersion(transaction, {
    scope: {
      organizationId,
      taskId: scope.taskId,
      applicationId: scope.applicationId,
      repositoryId: scope.repositoryUuid,
      conversationId: scope.conversationId,
    },
    parent: {
      id: scope.parentId,
      revision: scope.parentRevision,
      version: scope.parentVersion,
      currentVersionId: scope.currentVersionId,
    },
    version: {
      parentVersionId: scope.currentVersionId === null
        ? null
        : `"${scope.currentVersionId}"`,
      runStepId: null,
      authorId: principalId,
      subjectHeadSha: verified.commitSha,
      subjectBaseSha: null,
      stepKey: null,
      metadata,
      content: verified.content,
      sha256: verified.sha256,
      mediaType: verified.mediaType,
    },
    promotion: { kind: "human" },
    traceId,
  });
  if (typeof response.id !== "string" || response.id.length === 0) {
    throw new Error("ARTIFACT_VERSION_IMPORT_VERSION_ID_MISSING");
  }
  const auditRowCount = await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "artifactVersions.import",
    resourceType: "artifact_version",
    resourceId: response.id,
    requestId: context.requestId,
    traceId,
    details: {
      idempotencyKey: headers.idempotencyKey,
      mappingRevision: source.mappingRevision,
      mappingDigest: source.mappingDigest,
      snapshotSha: source.snapshotSha,
      blobSha: verified.blobSha,
      canonicalSize: verified.content.byteLength,
      sha256: verified.sha256,
      repoUuid: scope.repositoryUuid,
      path: verified.path,
      commitSha: verified.commitSha,
    },
  });
  if (auditRowCount !== 1) {
    throw new Error("ARTIFACT_VERSION_IMPORT_AUDIT_INSERT_FAILED");
  }
  return response;
}
