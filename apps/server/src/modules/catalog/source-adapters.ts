import {
  gitLauncherArgs,
  SERVER_GIT_LAUNCHER,
} from "../../platform/server-exec.ts";
import type { JsonValue } from "@bakery/contracts/contracts";
import { canonicalJson } from "../../platform/canonical-json.ts";
import {
  parseGzipUstarArchive,
  type SkillArchiveFile,
  type SkillArchiveInventory,
  TarArchiveError,
} from "./tar-archive.ts";
import {
  MAX_DECODED_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_PATH_LENGTH,
  MAX_UPLOAD_FILES,
  type ValidatedSkillVersion,
  validateLocalSkillVersion,
} from "./validation.ts";
import { unicodeDefaultCaseFold } from "./unicode-case-fold.ts";

export const SKILL_SOURCE_TIMEOUT_MS = 30_000;
const MAX_GIT_TEXT_BYTES = 256 * 1024;
const MAX_GIT_HASH_BYTES = 129;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;

export const SKILL_SOURCE_GIT_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  XDG_CONFIG_HOME: "/nonexistent",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GCM_INTERACTIVE: "never",
  GIT_ALLOW_PROTOCOL: "https",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
});

/** Test-only environment for the explicit loopback HTTP source injection. */
export const SKILL_SOURCE_GIT_LOOPBACK_ENVIRONMENT = Object.freeze({
  ...SKILL_SOURCE_GIT_ENVIRONMENT,
  GIT_ALLOW_PROTOCOL: "https:http",
});

export type SkillSourceType = "git" | "url";

export type SkillSourceFetchRequest = Readonly<{
  sourceType: SkillSourceType;
  locator: string;
  requestedRevision: string;
  path?: string;
  expectedSourceRevision?: string;
  signal?: AbortSignal;
}>;

export type SkillSourceProof = Readonly<{
  sourceType: SkillSourceType;
  normalizedLocator: string;
  requestedRevision: string;
  sourceRevision: string;
  sourceProofDigest: string;
  normalizedPath: string;
  inventory: SkillArchiveInventory;
}>;

export type ValidatedPinnedSkillSource = Readonly<{
  proof: SkillSourceProof;
  version: ValidatedSkillVersion;
}>;

export interface SkillSourceAdapter {
  fetchPinnedSource(
    request: SkillSourceFetchRequest,
  ): Promise<SkillSourceProof>;
}

export type SkillSourceAdapterErrorCode =
  | "SOURCE_INVALID"
  | "SOURCE_LIMIT_EXCEEDED"
  | "SOURCE_ORIGIN_REJECTED"
  | "SOURCE_REVISION_MISMATCH"
  | "SOURCE_TIMEOUT"
  | "SOURCE_UNAVAILABLE";

export class SkillSourceAdapterError extends Error {
  readonly code: SkillSourceAdapterErrorCode;

  constructor(code: SkillSourceAdapterErrorCode) {
    super(code);
    this.name = "SkillSourceAdapterError";
    this.code = code;
  }
}

function fail(code: SkillSourceAdapterErrorCode): never {
  throw new SkillSourceAdapterError(code);
}

export type HttpSourceResponse = Readonly<{
  status: number;
  url: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}>;

export type HttpSourceFetch = (
  url: string,
  init: Readonly<{
    method: "GET";
    headers: Headers;
    redirect: "error";
    credentials: "omit";
    cache: "no-store";
    referrerPolicy: "no-referrer";
    signal: AbortSignal;
  }>,
) => Promise<HttpSourceResponse>;

export type GitCommandInvocation = Readonly<{
  executable: "/usr/bin/git";
  args: readonly string[];
  cwd: string;
  clearEnv: true;
  env: Readonly<Record<string, string>>;
  stdin: "null";
  stdout: "piped";
  stderr: "null";
  stdoutLimit: number;
  signal: AbortSignal;
}>;

export interface GitCommandRunner {
  run(invocation: GitCommandInvocation): Promise<Uint8Array>;
}

type SkillSourceAdapterDependencies = Readonly<{
  httpFetch: HttpSourceFetch;
  gitRunner: GitCommandRunner;
  makeTempDirectory: () => Promise<string>;
  removeDirectory: (path: string) => Promise<void>;
  allowInsecureLoopback: boolean;
  timeoutMs: number;
}>;

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") {
    return true;
  }
  const match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  return Number(match[1]) === 127 &&
    match.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function hasAsciiControl(value: string, includeSpace = false): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint < (includeSpace ? 0x21 : 0x20) || codePoint === 0x7f)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeLocator(
  value: string,
  allowInsecureLoopback: boolean,
): string {
  if (
    value.length === 0 || value.length > 2_048 || value.trim() !== value ||
    hasAsciiControl(value)
  ) {
    fail("SOURCE_ORIGIN_REJECTED");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("SOURCE_ORIGIN_REJECTED");
  }
  const secure = url.protocol === "https:" && url.port === "";
  const injectedLoopback = allowInsecureLoopback && url.protocol === "http:" &&
    isLoopbackHostname(url.hostname);
  if (
    (!secure && !injectedLoopback) || url.username !== "" ||
    url.password !== "" || url.search !== "" || url.hash !== "" ||
    /%(?:00|2f|5c)/i.test(url.pathname)
  ) {
    fail("SOURCE_ORIGIN_REJECTED");
  }
  return url.href;
}

export function normalizeSkillSourceLocator(value: string): string {
  return normalizeLocator(value, false);
}

/** Normalizes the explicit loopback origin injected by a local test fixture. */
export function normalizeSkillSourceLocatorForTest(value: string): string {
  return normalizeLocator(value, true);
}

export function normalizeSkillSourcePath(raw: string | undefined): string {
  return normalizeSourcePath(raw);
}

function normalizeSourcePath(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "";
  if (raw.length > MAX_PATH_LENGTH) fail("SOURCE_INVALID");
  const path = raw.normalize("NFC");
  if (
    path.length === 0 || path.length > MAX_PATH_LENGTH ||
    path.startsWith("/") ||
    path.endsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.includes("//") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("SOURCE_INVALID");
  }
  return path;
}

function requireStrongEtag(value: string): string {
  if (
    value.length < 2 || value.length > 1_024 ||
    !/^"[\x21\x23-\x7e]*"$/.test(value)
  ) {
    fail("SOURCE_REVISION_MISMATCH");
  }
  return value;
}

function requireGitRevision(value: string): string {
  if (
    value.length === 0 || value.length > 255 || value.startsWith("-") ||
    hasAsciiControl(value, true) ||
    [..."~^:?*\\[]"].some((character) => value.includes(character)) ||
    value.includes("..") || value.includes("@{")
  ) {
    fail("SOURCE_INVALID");
  }
  return value;
}

export function normalizeSkillSourceRevision(
  sourceType: SkillSourceType,
  value: string,
): string {
  return sourceType === "git"
    ? requireGitRevision(value)
    : requireStrongEtag(value);
}

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string"
    ? new TextEncoder().encode(bytes)
    : bytes;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(input).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new SkillSourceAdapterError("SOURCE_TIMEOUT"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new SkillSourceAdapterError("SOURCE_TIMEOUT"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        fail("SOURCE_LIMIT_EXCEEDED");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatenate(chunks, total);
}

function createBudget(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

const productionHttpFetch: HttpSourceFetch = async (url, init) => {
  const response = await fetch(url, init);
  return {
    status: response.status,
    url: response.url,
    headers: response.headers,
    body: response.body,
  };
};

async function killAndReap(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    // Process may already have exited.
  }
  try {
    await child.status;
  } catch {
    // Status can reject after forced termination.
  }
}

const productionGitRunner: GitCommandRunner = {
  async run(invocation) {
    let child: Deno.ChildProcess;
    try {
      // Never /usr/bin/git itself: the fixed launcher re-validates the
      // invocation, chooses the allowed protocols from the URL and sets git's
      // clean environment (the invocation's env is what the launcher pins).
      child = new Deno.Command(SERVER_GIT_LAUNCHER, {
        args: gitLauncherArgs(invocation.cwd, invocation.args),
        cwd: invocation.cwd,
        clearEnv: true,
        env: {},
        stdin: invocation.stdin,
        stdout: invocation.stdout,
        stderr: invocation.stderr,
      }).spawn();
    } catch {
      return fail("SOURCE_UNAVAILABLE");
    }
    const terminate = () => void killAndReap(child);
    invocation.signal.addEventListener("abort", terminate, { once: true });
    try {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const result = await abortable(reader.read(), invocation.signal);
          if (result.done) break;
          total += result.value.byteLength;
          if (total > invocation.stdoutLimit) {
            await reader.cancel().catch(() => undefined);
            await killAndReap(child);
            fail("SOURCE_LIMIT_EXCEEDED");
          }
          chunks.push(result.value);
        }
      } finally {
        reader.releaseLock();
      }
      const status = await abortable(child.status, invocation.signal);
      if (!status.success) fail("SOURCE_UNAVAILABLE");
      return concatenate(chunks, total);
    } catch (error) {
      await killAndReap(child);
      throw error;
    } finally {
      invocation.signal.removeEventListener("abort", terminate);
    }
  },
};

async function runGit(
  dependencies: SkillSourceAdapterDependencies,
  cwd: string,
  args: readonly string[],
  stdoutLimit: number,
  parentSignal?: AbortSignal,
): Promise<Uint8Array> {
  const budget = createBudget(parentSignal, dependencies.timeoutMs);
  try {
    return await dependencies.gitRunner.run({
      executable: "/usr/bin/git",
      args,
      cwd,
      clearEnv: true,
      env: dependencies.allowInsecureLoopback
        ? SKILL_SOURCE_GIT_LOOPBACK_ENVIRONMENT
        : SKILL_SOURCE_GIT_ENVIRONMENT,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      stdoutLimit,
      signal: budget.signal,
    });
  } catch (error) {
    if (budget.signal.aborted || budget.timedOut()) {
      return fail("SOURCE_TIMEOUT");
    }
    if (error instanceof SkillSourceAdapterError) throw error;
    return fail("SOURCE_UNAVAILABLE");
  } finally {
    budget.dispose();
  }
}

function decodeGitText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("SOURCE_INVALID");
  }
}

type GitTreeEntry = Readonly<{
  sourcePath: string;
  path: string;
  mode: "100644" | "100755";
  objectId: string;
}>;

function parseGitTree(
  output: Uint8Array,
  selectedPath: string,
): GitTreeEntry[] {
  const text = decodeGitText(output);
  if (text !== "" && !text.endsWith("\0")) fail("SOURCE_INVALID");
  const records = text === "" ? [] : text.slice(0, -1).split("\0");
  if (records.length > MAX_UPLOAD_FILES + 1) fail("SOURCE_LIMIT_EXCEEDED");
  const identities = new Set<string>();
  return records.map((record) => {
    const match = record.match(
      /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)$/,
    );
    if (!match || match[2] !== "blob") fail("SOURCE_INVALID");
    if (match[1] !== "100644" && match[1] !== "100755") {
      fail("SOURCE_INVALID");
    }
    const sourcePath = normalizeSourcePath(match[4]);
    const prefix = selectedPath === "" ? "" : `${selectedPath}/`;
    if (prefix !== "" && !sourcePath.startsWith(prefix)) fail("SOURCE_INVALID");
    const path = normalizeSourcePath(sourcePath.slice(prefix.length));
    const identity = unicodeDefaultCaseFold(path);
    if (identities.has(identity)) fail("SOURCE_INVALID");
    identities.add(identity);
    return Object.freeze({
      sourcePath,
      path,
      mode: match[1] as "100644" | "100755",
      objectId: match[3],
    });
  });
}

function parseGitObjectSize(output: Uint8Array, limit: number): number {
  const text = decodeGitText(output);
  if (!/^(?:0|[1-9][0-9]*)\n$/.test(text)) fail("SOURCE_INVALID");
  const value = Number(text.slice(0, -1));
  if (!Number.isSafeInteger(value) || value > limit) {
    fail("SOURCE_LIMIT_EXCEEDED");
  }
  return value;
}

async function loadGitInventory(
  dependencies: SkillSourceAdapterDependencies,
  directory: string,
  entries: readonly GitTreeEntry[],
  signal?: AbortSignal,
): Promise<SkillArchiveInventory> {
  let manifestBytes: Uint8Array | undefined;
  const files: SkillArchiveFile[] = [];
  let totalFileBytes = 0;
  for (const entry of entries) {
    const limit = entry.path === "manifest.json"
      ? MAX_MANIFEST_BYTES
      : MAX_DECODED_FILE_BYTES;
    const size = parseGitObjectSize(
      await runGit(
        dependencies,
        directory,
        ["cat-file", "-s", entry.objectId],
        32,
        signal,
      ),
      limit,
    );
    if (
      entry.path !== "manifest.json" &&
      totalFileBytes > MAX_DECODED_FILE_BYTES - size
    ) {
      fail("SOURCE_LIMIT_EXCEEDED");
    }
    const content = await runGit(
      dependencies,
      directory,
      ["cat-file", "blob", entry.objectId],
      size,
      signal,
    );
    if (content.byteLength !== size) fail("SOURCE_INVALID");
    if (entry.path === "manifest.json") {
      if (manifestBytes) fail("SOURCE_INVALID");
      manifestBytes = content;
    } else {
      totalFileBytes += size;
      files.push(Object.freeze({
        path: entry.path,
        content,
        isExecutable: entry.mode === "100755",
      }));
    }
  }
  if (!manifestBytes || files.length > MAX_UPLOAD_FILES) fail("SOURCE_INVALID");
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
    );
  } catch {
    return fail("SOURCE_INVALID");
  }
  if (
    manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
  ) {
    fail("SOURCE_INVALID");
  }
  return Object.freeze({
    manifest: Object.freeze(manifest as Record<string, unknown>),
    manifestBytes,
    files: Object.freeze(files),
  });
}

async function fetchGitSource(
  dependencies: SkillSourceAdapterDependencies,
  request: SkillSourceFetchRequest,
): Promise<SkillSourceProof> {
  const normalizedLocator = normalizeLocator(
    request.locator,
    dependencies.allowInsecureLoopback,
  );
  const requestedRevision = requireGitRevision(request.requestedRevision);
  const expectedRevision = request.expectedSourceRevision;
  if (expectedRevision !== undefined && !GIT_OBJECT_ID.test(expectedRevision)) {
    fail("SOURCE_INVALID");
  }
  const fetchRevision = expectedRevision ?? requestedRevision;
  const normalizedPath = normalizeSourcePath(request.path);
  const directory = await dependencies.makeTempDirectory();
  try {
    await runGit(
      dependencies,
      directory,
      ["init", "--bare"],
      4_096,
      request.signal,
    );
    await runGit(
      dependencies,
      directory,
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.askPass=",
        "-c",
        "http.followRedirects=false",
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "--depth=1",
        "--filter=blob:none",
        "--",
        normalizedLocator,
        fetchRevision,
      ],
      64 * 1024,
      request.signal,
    );
    const sourceRevision = decodeGitText(
      await runGit(
        dependencies,
        directory,
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        MAX_GIT_HASH_BYTES,
        request.signal,
      ),
    ).trim();
    if (!GIT_OBJECT_ID.test(sourceRevision)) fail("SOURCE_INVALID");
    if (expectedRevision !== undefined && sourceRevision !== expectedRevision) {
      fail("SOURCE_REVISION_MISMATCH");
    }
    const treeArgs = [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      "FETCH_HEAD",
      "--",
      ...(normalizedPath === "" ? [] : [normalizedPath]),
    ];
    const entries = parseGitTree(
      await runGit(
        dependencies,
        directory,
        treeArgs,
        MAX_GIT_TEXT_BYTES,
        request.signal,
      ),
      normalizedPath,
    );
    const inventory = await loadGitInventory(
      dependencies,
      directory,
      entries,
      request.signal,
    );
    const sourceProofDigest = await sha256(canonicalJson({
      sourceRevision,
      path: normalizedPath,
      entries: await Promise.all(entries.map(async (entry) => {
        const content = entry.path === "manifest.json"
          ? inventory.manifestBytes
          : inventory.files.find((file) => file.path === entry.path)?.content;
        if (!content) fail("SOURCE_INVALID");
        return {
          path: entry.path,
          mode: entry.mode,
          objectId: entry.objectId,
          sha256: await sha256(content),
        };
      })),
    }));
    return Object.freeze({
      sourceType: "git",
      normalizedLocator,
      requestedRevision,
      sourceRevision,
      sourceProofDigest,
      normalizedPath,
      inventory,
    });
  } finally {
    await dependencies.removeDirectory(directory).catch(() => undefined);
  }
}

async function fetchUrlSource(
  dependencies: SkillSourceAdapterDependencies,
  request: SkillSourceFetchRequest,
): Promise<SkillSourceProof> {
  const normalizedLocator = normalizeLocator(
    request.locator,
    dependencies.allowInsecureLoopback,
  );
  const requestedRevision = requireStrongEtag(request.requestedRevision);
  if (
    request.expectedSourceRevision !== undefined &&
    request.expectedSourceRevision !== requestedRevision
  ) {
    fail("SOURCE_REVISION_MISMATCH");
  }
  const normalizedPath = normalizeSourcePath(request.path);
  const budget = createBudget(request.signal, dependencies.timeoutMs);
  try {
    let response: HttpSourceResponse;
    try {
      response = await dependencies.httpFetch(normalizedLocator, {
        method: "GET",
        headers: new Headers({ "if-match": requestedRevision }),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: budget.signal,
      });
    } catch {
      if (budget.signal.aborted || budget.timedOut()) fail("SOURCE_TIMEOUT");
      return fail("SOURCE_UNAVAILABLE");
    }
    if (response.url !== normalizedLocator) fail("SOURCE_ORIGIN_REJECTED");
    if (response.status === 412) fail("SOURCE_REVISION_MISMATCH");
    if (response.status !== 200 || response.body === null) {
      fail("SOURCE_UNAVAILABLE");
    }
    const responseEtag = response.headers.get("etag");
    if (
      responseEtag === null ||
      requireStrongEtag(responseEtag) !== requestedRevision
    ) {
      fail("SOURCE_REVISION_MISMATCH");
    }
    const compressed = await readBoundedBody(
      response.body,
      12 * 1024 * 1024,
      budget.signal,
    );
    const sourceProofDigest = await sha256(compressed);
    let inventory: SkillArchiveInventory;
    try {
      inventory = await parseGzipUstarArchive(compressed, normalizedPath);
    } catch (error) {
      if (error instanceof TarArchiveError) fail("SOURCE_INVALID");
      throw error;
    }
    return Object.freeze({
      sourceType: "url",
      normalizedLocator,
      requestedRevision,
      sourceRevision: requestedRevision,
      sourceProofDigest,
      normalizedPath,
      inventory,
    });
  } catch (error) {
    if (budget.signal.aborted || budget.timedOut()) fail("SOURCE_TIMEOUT");
    if (error instanceof SkillSourceAdapterError) throw error;
    return fail("SOURCE_UNAVAILABLE");
  } finally {
    budget.dispose();
  }
}

class DefaultSkillSourceAdapter implements SkillSourceAdapter {
  readonly #dependencies: SkillSourceAdapterDependencies;

  constructor(dependencies: SkillSourceAdapterDependencies) {
    this.#dependencies = dependencies;
  }

  async fetchPinnedSource(
    request: SkillSourceFetchRequest,
  ): Promise<SkillSourceProof> {
    if (request.sourceType === "git") {
      return await fetchGitSource(this.#dependencies, request);
    }
    if (request.sourceType === "url") {
      return await fetchUrlSource(this.#dependencies, request);
    }
    return fail("SOURCE_INVALID");
  }
}

const productionDependencies: SkillSourceAdapterDependencies = Object.freeze({
  httpFetch: productionHttpFetch,
  gitRunner: productionGitRunner,
  makeTempDirectory: () => Deno.makeTempDir({ prefix: "bakery-skill-source-" }),
  removeDirectory: (path) => Deno.remove(path, { recursive: true }),
  allowInsecureLoopback: false,
  timeoutMs: SKILL_SOURCE_TIMEOUT_MS,
});

async function ensurePrivateScratchDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await Deno.lstat(path);
  if (
    stat.isSymlink || !stat.isDirectory || stat.uid === null ||
    stat.uid !== Deno.uid() || stat.mode === null ||
    (stat.mode & 0o777) !== 0o700
  ) {
    fail("SOURCE_UNAVAILABLE");
  }
}

/** Creates the production HTTPS-only, credential-free source adapter. */
export function createSkillSourceAdapter(
  skillFileRoot?: string,
): SkillSourceAdapter {
  if (skillFileRoot === undefined) {
    return new DefaultSkillSourceAdapter(productionDependencies);
  }
  const scratchRoot = `${skillFileRoot}/.bakery-source-scratch`;
  return new DefaultSkillSourceAdapter({
    ...productionDependencies,
    makeTempDirectory: async () => {
      await ensurePrivateScratchDirectory(skillFileRoot);
      await ensurePrivateScratchDirectory(scratchRoot);
      return await Deno.makeTempDir({
        dir: scratchRoot,
        prefix: "fetch-",
      });
    },
  });
}

/** Creates an adapter with explicit local-only dependencies for deterministic tests. */
export function createSkillSourceAdapterForTest(
  overrides: Partial<SkillSourceAdapterDependencies>,
): SkillSourceAdapter {
  return new DefaultSkillSourceAdapter({
    ...productionDependencies,
    ...overrides,
  });
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Reconciles a proved source inventory through the unchanged catalog validator. */
export async function validatePinnedSkillSource(
  options: Readonly<{
    proof: SkillSourceProof;
    skillId: string;
    revision: number;
    registeredLicense: string;
  }>,
): Promise<ValidatedPinnedSkillSource> {
  const { proof } = options;
  const manifest = proof.inventory.manifest;
  if (
    typeof manifest.digest !== "string" || !DIGEST.test(manifest.digest) ||
    typeof manifest.entryPath !== "string" || !Array.isArray(manifest.files)
  ) {
    fail("SOURCE_INVALID");
  }
  const declared = new Map<
    string,
    { mediaType: string; isExecutable: boolean }
  >();
  for (const value of manifest.files) {
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.path !== "string" || typeof value.mediaType !== "string" ||
      typeof value.isExecutable !== "boolean"
    ) {
      fail("SOURCE_INVALID");
    }
    declared.set(value.path, {
      mediaType: value.mediaType,
      isExecutable: value.isExecutable,
    });
  }
  let version: ValidatedSkillVersion;
  try {
    version = await validateLocalSkillVersion({
      id: options.skillId,
      revision: options.revision,
      digest: manifest.digest,
      entryPath: manifest.entryPath,
      manifest: { ...manifest } as JsonValue,
      files: proof.inventory.files.map((file) => {
        const declaration = declared.get(file.path);
        if (!declaration || declaration.isExecutable !== file.isExecutable) {
          fail("SOURCE_INVALID");
        }
        return {
          path: file.path,
          mediaType: declaration.mediaType,
          isExecutable: file.isExecutable,
          contentBase64: encodeBase64(file.content),
        };
      }),
    });
  } catch (error) {
    if (error instanceof SkillSourceAdapterError) throw error;
    return fail("SOURCE_INVALID");
  }
  if (version.manifest.license !== options.registeredLicense) {
    fail("SOURCE_INVALID");
  }
  return Object.freeze({ proof, version });
}
