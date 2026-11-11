import {
  evaluateArtifacts,
  evaluateEvidence,
  expectedLaneStatus,
  parsePolicy,
} from "./evaluate.ts";

/** Release-asset transport for CI evidence. Release assets are not Actions artifacts. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 512;
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const MAX_ASSET_PAGES = 10;
export const MAX_ACTIVE_RUN_PAGES = 10;
// GitHub permits at most 1,000 assets per release. Keep the complete
// platform-valid inventory lookup and retention mutations below github.token's
// 1,000-request hourly limit, with each delete applied before the next lookup.
export const MAX_RETENTION_API_REQUESTS = 950;
export const MAX_ARCHIVE_METADATA_BYTES = 256 * 1024;
export const MAX_ARCHIVE_METADATA_LINE_BYTES = 16 * 1024;
// Paper emits two JSON summaries; the checked-in inputs are far below this
// bound, while the per-entry and archive limits remain the final guards.
export const MAX_LOG_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_LOG_CHUNK_BYTES = 64 * 1024;
export const MAX_LOG_CHUNKS = 512;
export const MAX_LOG_FRAME_BYTES = 48 * 1024 * 1024;
export const MAX_JOB_LOG_BYTES = 64 * 1024 * 1024;
export const MAX_TRUSTED_VERDICT_BYTES = 64 * 1024;
export const MAX_LOG_LOCATION_BYTES = 4096;
export const RELEASE_TAG = "ci-evidence";
export const SUCCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const FAILURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_RELEASE_ASSETS = 500;
const ARCHIVE_CHILD_EXIT_TIMEOUT_MS = 1_000;

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_UPLOADS_ORIGIN = "https://uploads.github.com";

type Release = {
  readonly id: number;
  readonly tag_name: string;
  readonly prerelease?: boolean;
  readonly upload_url: string;
};

type Asset = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly state?: string;
  readonly created_at?: string;
  readonly browser_download_url?: string;
  readonly url?: string;
};

type WorkflowRun = {
  readonly id: number;
  readonly status?: string;
  readonly conclusion: string | null;
};

export type ReleaseApi = {
  request(path: string, init?: RequestInit): Promise<Response>;
};

export type EvidenceManifest = {
  readonly runId: string;
  readonly runAttempt: string;
  readonly workflow: string;
  readonly candidate: string;
  readonly base: string;
  readonly lane: string;
  readonly files: readonly string[];
};

type LaneLogExpectation =
  & Pick<EvidenceManifest, "runAttempt" | "lane">
  & Partial<
    Pick<EvidenceManifest, "runId" | "workflow" | "candidate" | "base">
  >
  & { files?: readonly string[] };

export type TrustedVerdict = {
  readonly version: 1;
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly workflow: string;
  readonly candidate: string;
  readonly base: string;
  readonly status: "success" | "failure";
  readonly failures: readonly string[];
};

export type PublishedEvidence = {
  readonly assetId: number;
  readonly assetName: string;
  readonly browserUrl: string;
  readonly size: number;
  readonly sha256: string;
};

export type ArchiveEntry = {
  readonly path: string;
  readonly bytes: number;
};

export type ReleasePruneSummary = {
  readonly before: number;
  readonly after: number;
  readonly deleted: number;
  /** A lower bound when classificationComplete is false. */
  readonly protectedActive: number;
  readonly classificationComplete: boolean;
  /** Assets whose workflow-run state was not classified. */
  readonly unclassified: number;
};

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(`release evidence API ${response.status}`);
  return await response.json() as T;
};

const positiveRunAttempt = (value: string): bigint | null => {
  if (!/^\d+$/.test(value)) return null;
  const attempt = BigInt(value);
  return attempt > 0n ? attempt : null;
};

const identity = (runId: string, runAttempt: string): void => {
  if (!/^\d+$/.test(runId) || positiveRunAttempt(runAttempt) === null) {
    throw new Error("release evidence: invalid run identity");
  }
};

export const assetName = (
  runId: string,
  runAttempt: string,
  lane: string,
  jobId?: number,
) => {
  identity(runId, runAttempt);
  if (!/^[A-Za-z0-9_.-]+$/.test(lane)) {
    throw new Error("release evidence: invalid lane");
  }
  if (
    jobId !== undefined &&
    (!Number.isSafeInteger(jobId) || jobId <= 0)
  ) {
    throw new Error("release evidence: invalid job identity");
  }
  return jobId === undefined
    ? `evidence-${runId}-${runAttempt}-${lane}.zip`
    : `evidence-${runId}-${runAttempt}-job-${jobId}-${lane}.zip`;
};

const safeArchivePath = (path: string): boolean =>
  path.length > 0 && !path.includes("\\") && !path.includes("\0") &&
  !/[*?[\]]/.test(path) &&
  !path.startsWith("/") && path.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".."
  );

export const validateManifest = (manifest: EvidenceManifest): void => {
  identity(manifest.runId, manifest.runAttempt);
  if (
    !manifest.workflow || !manifest.candidate || !manifest.base ||
    !manifest.lane || !Array.isArray(manifest.files)
  ) {
    throw new Error("release evidence: incomplete manifest identity");
  }
  const paths = new Set<string>();
  const expectedEvidencePath = `evidence/${manifest.lane}.txt`;
  let evidencePathCount = 0;
  for (const path of manifest.files) {
    if (
      !safeArchivePath(path) || path === "manifest.json" || paths.has(path) ||
      !path.startsWith("evidence/") && !path.startsWith("candidate-artifacts/")
    ) {
      throw new Error(`release evidence: unsafe or duplicate path ${path}`);
    }
    if (path.startsWith("evidence/")) {
      evidencePathCount++;
      if (path !== expectedEvidencePath) {
        throw new Error(
          `release evidence: evidence destination is not owned by ${manifest.lane}`,
        );
      }
    }
    paths.add(path);
  }
  if (evidencePathCount !== 1) {
    throw new Error(
      `release evidence: manifest must contain ${expectedEvidencePath}`,
    );
  }
};

export const validateArchiveEntries = (
  entries: readonly ArchiveEntry[],
): void => {
  if (entries.length === 0 || entries.length > MAX_FILES) {
    throw new Error("release evidence: invalid file count");
  }
  const paths = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (
      !safeArchivePath(entry.path) || paths.has(entry.path) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
    ) {
      throw new Error(`release evidence: invalid archive entry ${entry.path}`);
    }
    if (
      entry.path !== "manifest.json" && !entry.path.startsWith("evidence/") &&
      !entry.path.startsWith("candidate-artifacts/")
    ) {
      throw new Error(`release evidence: unsafe archive path ${entry.path}`);
    }
    if (entry.bytes > MAX_ENTRY_BYTES) {
      throw new Error(
        `release evidence: entry exceeds byte limit ${entry.path}`,
      );
    }
    paths.add(entry.path);
    total += entry.bytes;
    if (total > MAX_EXTRACTED_BYTES) {
      throw new Error("release evidence: archive exceeds byte limit");
    }
  }
};

const normalizeGithubApiUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value, GITHUB_API_ORIGIN);
  } catch {
    throw new Error("release evidence: invalid GitHub pagination URL");
  }
  if (
    url.origin !== GITHUB_API_ORIGIN || url.username || url.password ||
    url.hash
  ) {
    throw new Error("release evidence: unsafe GitHub pagination URL");
  }
  return `${url.origin}${url.pathname}${url.search}`;
};

const parseNextLink = (link: string | null): string | null => {
  const next = link?.split(",").find((part) => part.includes('rel="next"'));
  const match = next?.match(/<([^>]+)>/);
  return match ? normalizeGithubApiUrl(match[1]) : null;
};

const releaseFromResponse = async (response: Response): Promise<Release> => {
  const release = await json<Release>(response);
  if (
    !Number.isSafeInteger(release.id) || release.id <= 0 ||
    release.tag_name !== RELEASE_TAG || !release.upload_url
  ) {
    throw new Error("release evidence: malformed release");
  }
  return release;
};

const getRelease = async (api: ReleaseApi): Promise<Release> => {
  const response = await api.request(`/releases/tags/${RELEASE_TAG}`);
  if (response.status === 404) {
    throw new Error("release evidence: release is missing");
  }
  return await releaseFromResponse(response);
};

export async function getOrCreateRelease(api: ReleaseApi): Promise<Release> {
  const existing = await api.request(`/releases/tags/${RELEASE_TAG}`);
  if (existing.ok) return await releaseFromResponse(existing);
  if (existing.status !== 404) {
    throw new Error(`release evidence: release lookup ${existing.status}`);
  }
  const created = await api.request("/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tag_name: RELEASE_TAG,
      name: "CI evidence",
      prerelease: true,
    }),
  });
  if (created.status === 422) {
    return await getRelease(api);
  }
  return await releaseFromResponse(created);
}

export async function findAsset(
  api: ReleaseApi,
  releaseId: number,
  name: string,
): Promise<Asset | null> {
  let path: string | null = `/releases/${releaseId}/assets?per_page=100&page=1`;
  let page = 0;
  let match: Asset | null = null;
  while (path) {
    page++;
    if (page > MAX_ASSET_PAGES) {
      throw new Error("release evidence: asset pagination limit exceeded");
    }
    const response = await api.request(path);
    const assets = await json<readonly Asset[]>(response);
    if (!Array.isArray(assets)) {
      throw new Error("release evidence: malformed asset list");
    }
    for (const asset of assets) {
      if (asset.name !== name) continue;
      if (match) throw new Error(`release evidence: duplicate asset ${name}`);
      match = asset;
    }
    path = parseNextLink(response.headers.get("link"));
  }
  return match;
}

const assetIsUploaded = (asset: Asset): boolean =>
  asset.state === undefined || asset.state === "uploaded";

const partialAssetId = async (
  api: ReleaseApi,
  releaseId: number,
  name: string,
): Promise<number | null> => {
  const asset = await findAsset(api, releaseId, name);
  return asset && !assetIsUploaded(asset) ? asset.id : null;
};

const uploadAsset = async (
  api: ReleaseApi,
  release: Release,
  name: string,
  archive: Uint8Array,
): Promise<Asset> => {
  const uploadUrl = `${release.upload_url.split("{", 1)[0]}?name=${
    encodeURIComponent(name)
  }`;
  const response = await api.request(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": "application/zip",
      "content-length": String(archive.byteLength),
    },
    body: archive as unknown as BodyInit,
  });
  if (response.ok) {
    const asset = await response.json() as Asset;
    if (
      !Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.name !== name
    ) {
      throw new Error("release evidence: malformed uploaded asset");
    }
    return asset;
  }
  const body = await response.json().catch(() => null) as
    | { id?: number; name?: string }
    | null;
  const candidateId = body?.name === name && Number.isSafeInteger(body.id)
    ? body.id
    : await partialAssetId(api, release.id, name);
  if (candidateId !== null && candidateId !== undefined) {
    await deletePartialPublication(api, candidateId);
  }
  throw new Error(`release evidence: asset upload ${response.status}`);
};

export async function publishEvidence(
  api: ReleaseApi,
  manifest: EvidenceManifest,
  archive: Uint8Array,
  jobId?: number,
): Promise<PublishedEvidence> {
  validateManifest(manifest);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("release evidence: archive exceeds byte limit");
  }
  const release = await getOrCreateRelease(api);
  const name = assetName(
    manifest.runId,
    manifest.runAttempt,
    manifest.lane,
    jobId,
  );
  const existing = await findAsset(api, release.id, name);
  if (existing) {
    if (assetIsUploaded(existing)) {
      if (existing.name !== name) {
        throw new Error(
          `release evidence: immutable asset identity mismatch ${name}`,
        );
      }
      const existingArchive = await downloadAssetArchive(api, existing);
      const [expectedDigest, actualDigest] = await Promise.all([
        sha256Hex(archive),
        sha256Hex(existingArchive),
      ]);
      const sameBytes = archive.byteLength === existingArchive.byteLength &&
        archive.every((byte, index) => byte === existingArchive[index]);
      if (!sameBytes || expectedDigest !== actualDigest) {
        throw new Error(
          `release evidence: immutable asset content mismatch ${name}`,
        );
      }
      return {
        assetId: existing.id,
        assetName: existing.name,
        browserUrl: existing.browser_download_url ?? "",
        size: archive.byteLength,
        sha256: expectedDigest,
      };
    }
    await deletePartialPublication(api, existing.id);
  }
  const asset = await uploadAsset(api, release, name, archive);
  const digest = await sha256Hex(archive);
  return {
    assetId: asset.id,
    assetName: asset.name,
    browserUrl: asset.browser_download_url ?? "",
    size: archive.byteLength,
    sha256: digest,
  };
}
export const parseArchiveListing = (listing: string): ArchiveEntry[] => {
  const entries: ArchiveEntry[] = [];
  let archiveEntries = 0;
  for (const line of listing.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!match) continue;
    archiveEntries++;
    if (archiveEntries > MAX_FILES) {
      throw new Error("release evidence: too many archive entries");
    }
    const path = match[2];
    if (path.endsWith("/")) continue;
    entries.push({ path, bytes: Number(match[1]) });
  }
  validateArchiveEntries(entries);
  return entries;
};

const parentPath = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : ".";
};

const joinSafe = (root: string, relative: string): string => {
  if (!safeArchivePath(relative)) {
    throw new Error("release evidence: unsafe path");
  }
  return `${root}/${relative}`;
};

const downloadArchive = async (
  response: Response,
  destination: string,
): Promise<void> => {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength && /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("release evidence: downloaded archive exceeds byte limit");
  }
  if (!response.body) throw new Error("release evidence: asset has no body");
  const file = await Deno.open(destination, {
    create: true,
    write: true,
    truncate: true,
  });
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error(
          "release evidence: downloaded archive exceeds byte limit",
        );
      }
      let offset = 0;
      while (offset < next.value.byteLength) {
        offset += await file.write(next.value.subarray(offset));
      }
    }
  } finally {
    file.close();
  }
};
const downloadAssetArchive = async (
  api: ReleaseApi,
  asset: Asset,
): Promise<Uint8Array> => {
  if (
    !Number.isSafeInteger(asset.id) || asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) || asset.size < 0
  ) {
    throw new Error("release evidence: malformed existing asset");
  }
  if (asset.size > MAX_ARCHIVE_BYTES) {
    throw new Error("release evidence: downloaded archive exceeds byte limit");
  }
  const scratchDir = scratchDirectory();
  await ensureDirectoryPath(scratchDir);
  const temp = await Deno.makeTempFile({ dir: scratchDir, suffix: ".zip" });
  try {
    const response = await api.request(`/releases/assets/${asset.id}`, {
      headers: { accept: "application/octet-stream" },
    });
    if (!response.ok) {
      throw new Error(`release evidence: asset download ${response.status}`);
    }
    await downloadArchive(response, temp);
    return await Deno.readFile(temp);
  } finally {
    await Deno.remove(temp).catch(() => undefined);
  }
};

const streamCommandLines = async (
  command: string,
  args: readonly string[],
  onLine: (line: string) => void,
): Promise<void> => {
  const child = new Deno.Command(command, {
    args: [...args],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let pending = "";
  const fail = (message: string): never => {
    try {
      child.kill();
    } catch {
      // The process already exited.
    }
    throw new Error(message);
  };
  try {
    for await (const chunk of child.stdout) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_ARCHIVE_METADATA_BYTES) {
        fail("release evidence: archive metadata exceeds byte limit");
      }
      pending += decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.length > MAX_ARCHIVE_METADATA_LINE_BYTES) {
          fail("release evidence: archive metadata line exceeds byte limit");
        }
        onLine(line);
      }
      if (pending.length > MAX_ARCHIVE_METADATA_LINE_BYTES) {
        fail("release evidence: archive metadata line exceeds byte limit");
      }
    }
    pending += decoder.decode();
    if (pending.length > MAX_ARCHIVE_METADATA_LINE_BYTES) {
      fail("release evidence: archive metadata line exceeds byte limit");
    }
    if (pending) onLine(pending);
    const status = await child.status;
    if (!status.success) {
      throw new Error("release evidence: archive operation failed");
    }
  } catch (error) {
    try {
      child.kill();
    } catch {
      // The process already exited.
    }
    await child.status;
    throw error;
  }
};

const streamArchiveListing = async (
  archivePath: string,
): Promise<ArchiveEntry[]> => {
  const entries: ArchiveEntry[] = [];
  let archiveEntries = 0;
  await streamCommandLines("unzip", ["-l", archivePath], (line) => {
    const match = line.trim().match(/^(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!match) return;
    archiveEntries++;
    if (archiveEntries > MAX_FILES) {
      throw new Error("release evidence: too many archive entries");
    }
    const path = match[2];
    if (!path.endsWith("/")) entries.push({ path, bytes: Number(match[1]) });
  });
  validateArchiveEntries(entries);
  return entries;
};

const assertArchiveEntryTypes = async (archivePath: string): Promise<void> => {
  await streamCommandLines("unzip", ["-Z", "-v", archivePath], (line) => {
    const match = line.match(/Unix file attributes \(([0-7]+) octal\)/);
    if (!match) return;
    const mode = Number.parseInt(match[1], 8);
    const type = mode & 0o170000;
    if (type !== 0o100000 && type !== 0o040000) {
      throw new Error(
        "release evidence: archive entry is not a regular file",
      );
    }
  });
};

const assertNoSymlink = async (path: string): Promise<Deno.FileInfo> => {
  const info = await Deno.lstat(path);
  if (info.isSymlink || !info.isFile) {
    throw new Error(
      `release evidence: archive entry is not a regular file ${path}`,
    );
  }
  return info;
};

const assertDestinationPath = async (path: string): Promise<void> => {
  const parent = path.slice(0, path.lastIndexOf("/")) || ".";
  await assertNoSymlinkComponents(parent);
  const destination = await Deno.lstat(path).catch(() => null);
  if (destination?.isSymlink || (destination && !destination.isFile)) {
    throw new Error(`release evidence: destination path is unsafe ${path}`);
  }
};

const assertNoSymlinkComponents = async (path: string): Promise<void> => {
  const absolutePath = path.startsWith("/") ? path : `${Deno.cwd()}/${path}`;
  const resolvedPath = await Deno.realPath(absolutePath);
  if (resolvedPath !== absolutePath) {
    throw new Error(`release evidence: source path is unsafe ${path}`);
  }
};

const assertSourceDirectory = async (path: string): Promise<void> => {
  const info = await Deno.lstat(path);
  if (info.isSymlink || !info.isDirectory) {
    throw new Error(`release evidence: source directory is unsafe ${path}`);
  }
  await assertNoSymlinkComponents(path);
};

const ensureDirectoryPath = async (path: string): Promise<void> => {
  const info = await Deno.lstat(path).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  });
  if (!info) {
    await Deno.mkdir(path, { recursive: true });
  }
  const finalInfo = await Deno.lstat(path);
  if (finalInfo.isSymlink || !finalInfo.isDirectory) {
    throw new Error(`release evidence: destination path is unsafe ${path}`);
  }
};

const scratchDirectory = (): string =>
  Deno.env.get("SCRATCH_DIR") ?? Deno.env.get("HANDOFF_DIR") ?? Deno.cwd();

const createScratchDirectory = async (prefix: string): Promise<string> => {
  const root = scratchDirectory();
  await ensureDirectoryPath(root);
  return await Deno.makeTempDir({ dir: root, prefix });
};

type ArchiveEntryProcess = {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly status: Promise<{ readonly success: boolean }>;
  readonly kill: () => void;
};

const waitForArchiveStatus = async (
  status: Promise<{ readonly success: boolean }>,
): Promise<{ readonly success: boolean }> => {
  let timeout!: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(
            "release evidence: archive extraction process did not exit",
          ),
        ),
      ARCHIVE_CHILD_EXIT_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([status, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
};

const terminateArchiveEntry = async (
  child: ArchiveEntryProcess,
): Promise<void> => {
  try {
    child.kill();
  } catch {
    // The process already exited.
  }
  await waitForArchiveStatus(child.status);
};
const spawnArchiveEntry = (
  archivePath: string,
  entryPath: string,
): ArchiveEntryProcess => {
  const child = new Deno.Command("unzip", {
    args: ["-p", archivePath, entryPath],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  return {
    stdout: child.stdout,
    status: child.status,
    kill: () => child.kill("SIGKILL"),
  };
};

const streamArchiveEntry = async (
  archivePath: string,
  entry: ArchiveEntry,
  extractedBytes: { value: number },
  spawn = spawnArchiveEntry,
): Promise<Uint8Array> => {
  const child = spawn(archivePath, entry.path);
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    for await (const chunk of child.stdout) {
      byteCount += chunk.byteLength;
      extractedBytes.value += chunk.byteLength;
      if (
        byteCount > MAX_ENTRY_BYTES ||
        extractedBytes.value > MAX_EXTRACTED_BYTES
      ) {
        throw new Error("release evidence: extracted bytes exceed limit");
      }
      chunks.push(chunk);
    }
    const status = await waitForArchiveStatus(child.status);
    if (!status.success) {
      throw new Error(
        `release evidence: archive extraction failed ${entry.path}`,
      );
    }
    if (byteCount !== entry.bytes) {
      throw new Error(
        `release evidence: extracted byte count mismatch ${entry.path}`,
      );
    }
  } catch (error) {
    await terminateArchiveEntry(child);
    throw error;
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const archiveOutputs = (
  files: readonly string[],
  extracted: ReadonlyMap<string, Uint8Array>,
): Array<[string, Uint8Array]> => {
  return files.map((file) => {
    const bytes = extracted.get(file);
    if (!bytes) {
      throw new Error(`release evidence: archive entry is missing ${file}`);
    }
    return [file, bytes];
  });
};

type ArchiveOutputLocation = {
  readonly root: string;
  readonly relative: string;
};

const archiveOutputLocation = (
  file: string,
  evidenceDir: string,
  artifactDir: string,
): ArchiveOutputLocation => {
  if (file.startsWith("evidence/")) {
    return {
      root: evidenceDir,
      relative: file.slice("evidence/".length),
    };
  }
  if (file.startsWith("candidate-artifacts/")) {
    return {
      root: artifactDir,
      relative: file.slice("candidate-artifacts/".length),
    };
  }
  throw new Error(`release evidence: unsupported archive destination ${file}`);
};

const assertAllowedArchiveFiles = (
  actual: EvidenceManifest,
  allowedFiles: readonly string[] | undefined,
): void => {
  if (allowedFiles === undefined) return;
  const allowed = new Set(allowedFiles);
  if (
    actual.files.length !== allowed.size ||
    actual.files.some((file) => !allowed.has(file))
  ) {
    throw new Error(
      `release evidence: manifest destinations are not policy-declared for ${actual.lane}`,
    );
  }
};

const extractArchive = async (
  archivePath: string,
  expected: LaneLogExpectation | null,
  lane: string | null,
  evidenceDir: string,
  artifactDir: string,
  allowedFiles?: readonly string[],
): Promise<EvidenceManifest> => {
  // Count directory entries in the bounded listing before inspecting verbose
  // metadata. A ZIP with thousands of empty directories must not first expand
  // into an unbounded metadata string.
  const entries = await streamArchiveListing(archivePath);
  await assertArchiveEntryTypes(archivePath);
  const files = entries.map((entry) => entry.path);
  if (!files.includes("manifest.json")) {
    throw new Error("release evidence: archive listing mismatch");
  }
  const extracted = new Map<string, Uint8Array>();
  const extractedBytes = { value: 0 };
  for (const entry of entries) {
    extracted.set(
      entry.path,
      await streamArchiveEntry(archivePath, entry, extractedBytes),
    );
  }
  const manifestBytes = extracted.get("manifest.json");
  if (!manifestBytes) {
    throw new Error("release evidence: manifest is missing");
  }
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("release evidence: manifest exceeds byte limit");
  }
  const actual = JSON.parse(
    new TextDecoder().decode(manifestBytes),
  ) as EvidenceManifest;
  validateManifest(actual);
  if (lane !== null && actual.lane !== lane) {
    throw new Error(`release evidence: manifest lane mismatch for ${lane}`);
  }
  if (expected) {
    const fields = [
      "runId",
      "runAttempt",
      "workflow",
      "candidate",
      "base",
      "lane",
    ] as const;
    for (const field of fields) {
      if (
        expected[field] !== undefined &&
        actual[field] !== expected[field]
      ) {
        throw new Error("release evidence: manifest identity mismatch");
      }
    }
    if (
      expected.files !== undefined &&
      (actual.files.length !== expected.files.length ||
        actual.files.some((file, index) => file !== expected.files?.[index]))
    ) {
      throw new Error("release evidence: manifest file mismatch");
    }
  }
  const declared = new Set(actual.files);
  if (
    files.length !== declared.size + 1 ||
    files.some((file) => file !== "manifest.json" && !declared.has(file))
  ) {
    throw new Error(
      "release evidence: manifest does not reconcile with archive",
    );
  }
  assertAllowedArchiveFiles(actual, allowedFiles);
  const outputs = archiveOutputs(actual.files, extracted);
  for (const [file, bytes] of outputs) {
    const { root, relative } = archiveOutputLocation(
      file,
      evidenceDir,
      artifactDir,
    );
    const destination = joinSafe(root, relative);
    await ensureDirectoryPath(parentPath(destination));
    await assertDestinationPath(destination);
    await Deno.writeFile(destination, bytes);
  }
  return actual;
};

const fetchAsset = async (
  api: ReleaseApi,
  asset: Asset,
  evidenceDir: string,
  expected: LaneLogExpectation | null,
  lane: string | null,
  artifactDir: string,
  allowedFiles?: readonly string[],
): Promise<EvidenceManifest> => {
  if (asset.state !== undefined && asset.state !== "uploaded") {
    throw new Error(`release evidence: asset is not uploaded ${asset.name}`);
  }
  if (asset.size > MAX_ARCHIVE_BYTES) {
    throw new Error("release evidence: downloaded archive exceeds byte limit");
  }
  await ensureDirectoryPath(evidenceDir);
  await ensureDirectoryPath(artifactDir);
  const scratchDir = scratchDirectory();
  await ensureDirectoryPath(scratchDir);
  const temp = await Deno.makeTempFile({
    dir: scratchDir,
    suffix: ".zip",
  });
  try {
    const response = await api.request(`/releases/assets/${asset.id}`, {
      headers: { accept: "application/octet-stream" },
    });
    if (!response.ok) {
      throw new Error(`release evidence: asset download ${response.status}`);
    }
    await downloadArchive(response, temp);
    return await extractArchive(
      temp,
      expected,
      lane,
      evidenceDir,
      artifactDir,
      allowedFiles,
    );
  } finally {
    await Deno.remove(temp).catch(() => undefined);
  }
};

export async function fetchEvidence(
  api: ReleaseApi,
  assetId: number,
  manifest: EvidenceManifest,
  evidenceDir: string,
  artifactDir: string,
): Promise<void> {
  validateManifest(manifest);
  const asset: Asset = {
    id: assetId,
    name: assetName(manifest.runId, manifest.runAttempt, manifest.lane),
    size: 0,
  };
  await fetchAsset(
    api,
    asset,
    evidenceDir,
    manifest,
    manifest.lane,
    artifactDir,
  );
}

export async function deletePartialPublication(
  api: ReleaseApi,
  assetId: number,
): Promise<void> {
  const response = await api.request(`/releases/assets/${assetId}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`release evidence: partial cleanup ${response.status}`);
  }
}

const normalizeGithubApiOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("release evidence: invalid GitHub API origin");
  }
  const isDefault = url.origin === GITHUB_API_ORIGIN;
  const isLoopback = url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (!isDefault && !isLoopback) {
    throw new Error("release evidence: unsafe GitHub API origin");
  }
  return url.origin;
};
export const githubRequestUrl = (
  repository: string,
  path: string,
  apiOrigin = GITHUB_API_ORIGIN,
): string => {
  const origin = normalizeGithubApiOrigin(apiOrigin);
  if (path.startsWith("/") && !path.startsWith("//")) {
    return `${origin}/repos/${repository}${path}`;
  }
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    throw new Error("release evidence: invalid GitHub request URL");
  }
  if (
    (url.origin !== GITHUB_API_ORIGIN &&
      url.origin !== GITHUB_UPLOADS_ORIGIN) ||
    url.username || url.password || url.hash
  ) {
    throw new Error("release evidence: unsafe GitHub request URL");
  }
  return url.href;
};

export const githubApiFromEnv = (options: {
  readonly apiOrigin?: string;
} = {}): ReleaseApi => {
  const token = Deno.env.get("GITHUB_TOKEN");
  const repository = Deno.env.get("GITHUB_REPOSITORY");
  if (!token || !repository) {
    throw new Error("release evidence: missing GitHub credentials");
  }
  const apiOrigin = normalizeGithubApiOrigin(
    options.apiOrigin ?? GITHUB_API_ORIGIN,
  );
  return {
    request: (path, init = {}) =>
      fetch(githubRequestUrl(repository, path, apiOrigin), {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          ...(init.headers ?? {}),
        },
      }),
  };
};

const manifestFromEnv = (
  lane: string,
  files: readonly string[],
): EvidenceManifest => ({
  runId: Deno.env.get("RUN_ID") ?? "",
  runAttempt: Deno.env.get("RUN_ATTEMPT") ?? "",
  workflow: Deno.env.get("WORKFLOW_SHA") ?? "",
  candidate: Deno.env.get("CANDIDATE_SHA") ?? "",
  base: Deno.env.get("BASE_SHA") ?? "",
  lane,
  files,
});

const relativeFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isSymlink) {
      throw new Error(
        `release evidence: source symlink rejected ${entry.name}`,
      );
    }
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      for (const child of await relativeFiles(path)) {
        files.push(`${entry.name}/${child}`);
      }
    } else if (entry.isFile) {
      files.push(entry.name);
    } else {
      throw new Error(`release evidence: source entry is not regular ${path}`);
    }
    if (files.length > MAX_FILES) {
      throw new Error("release evidence: too many files");
    }
  }
  return files;
};

const boundedCommandOutput = async (
  command: string,
  args: readonly string[],
  cwd: string,
  maxBytes: number,
): Promise<Uint8Array> => {
  const child = new Deno.Command(command, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of child.stdout) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        child.kill();
        throw new Error("release evidence: archive exceeds byte limit");
      }
      chunks.push(chunk);
    }
    const status = await child.status;
    if (!status.success) {
      throw new Error("release evidence: archive creation failed");
    }
  } catch (error) {
    try {
      child.kill();
    } catch {
      // The process already exited.
    }
    await child.status;
    throw error;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const copyArchiveSource = async (
  stage: string,
  source: string,
  target: string,
  relative: string,
  totals: { files: number; bytes: number },
): Promise<string> => {
  const sourcePath = joinSafe(source, relative);
  const info = await assertNoSymlink(sourcePath);
  if (info.size > MAX_ENTRY_BYTES) {
    throw new Error(
      `release evidence: entry exceeds byte limit ${relative}`,
    );
  }
  totals.files++;
  totals.bytes += info.size;
  if (totals.files + 1 > MAX_FILES) {
    throw new Error("release evidence: too many files");
  }
  if (totals.bytes > MAX_EXTRACTED_BYTES) {
    throw new Error("release evidence: archive exceeds byte limit");
  }
  const archivePath = `${target}/${relative}`;
  const destination = joinSafe(stage, archivePath);
  await Deno.mkdir(parentPath(destination), { recursive: true });
  await Deno.writeFile(destination, await Deno.readFile(sourcePath));
  return archivePath;
};

const collectLaneArchive = async (
  stage: string,
  lane: string,
  evidenceDir: string,
  artifactDir: string,
): Promise<string[]> => {
  await assertSourceDirectory(evidenceDir);
  const files: string[] = [];
  const totals = { files: 0, bytes: 0 };
  files.push(
    await copyArchiveSource(
      stage,
      evidenceDir,
      "evidence",
      `${lane}.txt`,
      totals,
    ),
  );
  const artifactInfo = await Deno.lstat(artifactDir).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  });
  if (artifactInfo) {
    await assertSourceDirectory(artifactDir);
    for (const entry of await relativeFiles(artifactDir)) {
      files.push(
        await copyArchiveSource(
          stage,
          artifactDir,
          "candidate-artifacts",
          entry,
          totals,
        ),
      );
    }
  }
  return files;
};

const createLaneArchive = async (
  lane: string,
  evidenceDir: string,
  artifactDir: string,
): Promise<{ manifest: EvidenceManifest; archive: Uint8Array }> => {
  const stage = await createScratchDirectory("release-evidence-");
  try {
    const files = await collectLaneArchive(
      stage,
      lane,
      evidenceDir,
      artifactDir,
    );
    const manifest = manifestFromEnv(lane, files);
    validateManifest(manifest);
    await Deno.writeTextFile(
      joinSafe(stage, "manifest.json"),
      JSON.stringify(manifest),
    );
    const archive = await boundedCommandOutput(
      "zip",
      ["-qr", "-", "."],
      stage,
      MAX_LOG_ARCHIVE_BYTES,
    );
    return { manifest, archive };
  } finally {
    await Deno.remove(stage, { recursive: true }).catch(() => undefined);
  }
};

type LaneLogIdentity = Pick<
  EvidenceManifest,
  "runId" | "runAttempt" | "workflow" | "candidate" | "base" | "lane"
>;

type ReconstructedLaneLog = {
  readonly archive: Uint8Array;
  readonly identity: LaneLogIdentity;
};

type RunJob = {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
};

type LaneDefinition = {
  readonly lane: string;
  readonly job: string;
  readonly artifactPaths: readonly string[];
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const base64Encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64Decode = (value: string): Uint8Array => {
  if (
    value.length === 0 || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("release evidence: malformed log archive chunk");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};
const GITHUB_LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z) (.*)$/;

const parseGithubJobLog = (log: string): string[] => {
  const lines = log.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const framed: string[] = [];
  for (const line of lines) {
    if (line === "") continue;
    const match = line.match(GITHUB_LOG_LINE);
    if (!match) {
      if (/^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(line)) {
        throw new Error("release evidence: malformed job log framing");
      }
      continue;
    }
    if (!Number.isFinite(Date.parse(match[1]))) {
      throw new Error("release evidence: malformed job log framing");
    }
    framed.push(match[2]);
  }
  if (framed.length === 0) {
    throw new Error("release evidence: malformed job log framing");
  }
  return framed;
};

const MAX_LOG_CHUNK_BASE64_BYTES = 4 * Math.ceil(MAX_LOG_CHUNK_BYTES / 3);

const concatenateChunks = (chunks: readonly Uint8Array[]): Uint8Array => {
  const archiveBytes = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const archive = new Uint8Array(archiveBytes);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
};

const decodeLogChunks = (
  chunks: readonly (string | undefined)[],
): Uint8Array => {
  const decoded: Uint8Array[] = [];
  let totalBytes = 0;
  for (const chunk of chunks) {
    if (chunk === undefined || chunk.length > MAX_LOG_CHUNK_BASE64_BYTES) {
      throw new Error("release evidence: log archive chunk exceeds byte limit");
    }
    const bytes = base64Decode(chunk);
    if (bytes.byteLength > MAX_LOG_CHUNK_BYTES) {
      throw new Error("release evidence: log archive chunk exceeds byte limit");
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_LOG_ARCHIVE_BYTES) {
      throw new Error("release evidence: log archive exceeds byte limit");
    }
    decoded.push(bytes);
  }
  return concatenateChunks(decoded);
};

const logIdentityFields = (identity: LaneLogIdentity): string =>
  `run_id=${identity.runId} run_attempt=${identity.runAttempt} ` +
  `workflow=${identity.workflow} candidate=${identity.candidate} ` +
  `base=${identity.base} lane=${identity.lane}`;

export async function encodeLaneLog(
  manifest: EvidenceManifest,
  archive: Uint8Array,
): Promise<string> {
  validateManifest(manifest);
  if (archive.byteLength === 0 || archive.byteLength > MAX_LOG_ARCHIVE_BYTES) {
    throw new Error("release evidence: log archive exceeds byte limit");
  }
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < archive.byteLength;
    offset += MAX_LOG_CHUNK_BYTES
  ) {
    if (chunks.length >= MAX_LOG_CHUNKS) {
      throw new Error("release evidence: log archive has too many chunks");
    }
    chunks.push(
      base64Encode(archive.subarray(offset, offset + MAX_LOG_CHUNK_BYTES)),
    );
  }
  const digest = await sha256Hex(archive);
  return [
    `BAKERY_EVIDENCE_BEGIN version=1 ${logIdentityFields(manifest)} ` +
    `archive_bytes=${archive.byteLength} chunks=${chunks.length} sha256=${digest}`,
    ...chunks.map((chunk, index) =>
      `BAKERY_EVIDENCE_CHUNK lane=${manifest.lane} index=${index} data=${chunk}`
    ),
    `BAKERY_EVIDENCE_END lane=${manifest.lane} chunks=${chunks.length} sha256=${digest}`,
    "",
  ].join("\n");
}

export async function reconstructLaneLog(
  log: string,
  expected: LaneLogExpectation,
): Promise<ReconstructedLaneLog> {
  const lines = parseGithubJobLog(log).filter((line) =>
    line.startsWith("BAKERY_EVIDENCE_")
  );
  if (
    new TextEncoder().encode(lines.join("\n")).byteLength >
      MAX_LOG_FRAME_BYTES
  ) {
    throw new Error("release evidence: evidence frame exceeds byte limit");
  }
  const begins = lines.filter((line) =>
    line.startsWith("BAKERY_EVIDENCE_BEGIN ")
  );
  const ends = lines.filter((line) => line.startsWith("BAKERY_EVIDENCE_END "));
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error("release evidence: incomplete lane log");
  }
  const begin = begins[0].match(
    /^BAKERY_EVIDENCE_BEGIN version=1 run_id=([A-Za-z0-9_.-]+) run_attempt=([A-Za-z0-9_.-]+) workflow=([A-Za-z0-9_.-]+) candidate=([A-Za-z0-9_.-]+) base=([A-Za-z0-9_.-]+) lane=([A-Za-z0-9_.-]+) archive_bytes=(\d+) chunks=(\d+) sha256=([0-9a-f]{64})$/,
  );
  const end = ends[0].match(
    /^BAKERY_EVIDENCE_END lane=([A-Za-z0-9_.-]+) chunks=(\d+) sha256=([0-9a-f]{64})$/,
  );
  if (!begin || !end) throw new Error("release evidence: malformed lane log");
  const identity: LaneLogIdentity = {
    runId: begin[1],
    runAttempt: begin[2],
    workflow: begin[3],
    candidate: begin[4],
    base: begin[5],
    lane: begin[6],
  };
  const currentAttempt = positiveRunAttempt(expected.runAttempt);
  const embeddedAttempt = positiveRunAttempt(identity.runAttempt);
  if (
    currentAttempt === null || embeddedAttempt === null ||
    embeddedAttempt > currentAttempt
  ) {
    throw new Error("release evidence: lane log identity mismatch");
  }
  for (
    const field of ["runId", "workflow", "candidate", "base", "lane"] as const
  ) {
    if (expected[field] !== undefined && expected[field] !== identity[field]) {
      throw new Error("release evidence: lane log identity mismatch");
    }
  }
  const archiveBytes = Number(begin[7]);
  const chunkCount = Number(begin[8]);
  if (
    end[1] !== identity.lane || Number(end[2]) !== chunkCount ||
    !Number.isSafeInteger(archiveBytes) || archiveBytes <= 0 ||
    !Number.isSafeInteger(chunkCount) || chunkCount <= 0 ||
    end[3] !== begin[9]
  ) {
    throw new Error("release evidence: invalid lane log bounds");
  }
  if (archiveBytes > MAX_LOG_ARCHIVE_BYTES) {
    throw new Error("release evidence: log archive exceeds byte limit");
  }
  if (chunkCount > MAX_LOG_CHUNKS) {
    throw new Error("release evidence: log archive has too many chunks");
  }
  const chunks: Array<string | undefined> = [];
  for (const line of lines) {
    const chunk = line.match(
      /^BAKERY_EVIDENCE_CHUNK lane=([A-Za-z0-9_.-]+) index=(\d+) data=(.*)$/,
    );
    if (!chunk) continue;
    if (chunk[1] !== identity.lane) {
      throw new Error("release evidence: lane log chunk mismatch");
    }
    const index = Number(chunk[2]);
    if (
      !Number.isSafeInteger(index) || index < 0 || index >= chunkCount ||
      chunks[index] !== undefined
    ) {
      throw new Error("release evidence: invalid lane log chunk index");
    }
    chunks[index] = chunk[3];
  }
  if (
    chunks.length !== chunkCount || chunks.some((chunk) => chunk === undefined)
  ) {
    throw new Error("release evidence: incomplete lane log chunks");
  }
  const archive = decodeLogChunks(chunks);
  if (
    archive.byteLength !== archiveBytes ||
    await sha256Hex(archive) !== begin[9]
  ) {
    throw new Error("release evidence: lane log digest mismatch");
  }
  return { archive, identity };
}

const readBoundedEvidenceFrames = async (
  response: Response,
): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength && /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_JOB_LOG_BYTES
  ) {
    throw new Error("release evidence: job log exceeds byte limit");
  }
  if (!response.body) throw new Error("release evidence: job log has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const frames: string[] = [];
  let buffer = "";
  let totalBytes = 0;
  let frameBytes = 0;
  const consumeLine = (line: string) => {
    if (line === "") return;
    const match = line.match(GITHUB_LOG_LINE);
    if (!match) {
      if (/^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(line)) {
        throw new Error("release evidence: malformed job log framing");
      }
      return;
    }
    if (!Number.isFinite(Date.parse(match[1]))) {
      throw new Error("release evidence: malformed job log framing");
    }
    if (!match[2].startsWith("BAKERY_EVIDENCE_")) return;
    frameBytes += encoder.encode(`${line}\n`).byteLength;
    if (frameBytes > MAX_LOG_FRAME_BYTES) {
      throw new Error("release evidence: evidence frame exceeds byte limit");
    }
    frames.push(line);
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_JOB_LOG_BYTES) {
        await reader.cancel();
        throw new Error("release evidence: job log exceeds byte limit");
      }
      buffer += decoder.decode(next.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    consumeLine(buffer.replace(/\r$/, ""));
  } finally {
    reader.releaseLock();
  }
  return frames.length > 0 ? `${frames.join("\n")}\n` : "";
};

const GITHUB_ACTIONS_LOG_HOST_PATTERN =
  /^productionresultssa\d+\.blob\.core\.windows\.net$/;

export const validateLogRedirect = (location: string): string => {
  if (
    new TextEncoder().encode(location).byteLength > MAX_LOG_LOCATION_BYTES
  ) {
    throw new Error("release evidence: job log redirect exceeds byte limit");
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error("release evidence: invalid job log redirect");
  }
  const signatures = url.searchParams.getAll("sig");
  if (
    url.protocol !== "https:" || url.username || url.password || url.hash ||
    !GITHUB_ACTIONS_LOG_HOST_PATTERN.test(url.hostname) ||
    signatures.length !== 1 || !signatures[0]
  ) {
    throw new Error("release evidence: unsafe job log redirect");
  }
  return url.href;
};

const acquireJobLog = async (
  api: ReleaseApi,
  jobId: number,
): Promise<string> => {
  const response = await api.request(`/actions/jobs/${jobId}/logs`, {
    redirect: "manual",
  });
  if (response.status < 300 || response.status >= 400) {
    throw new Error("release evidence: job log redirect missing");
  }
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("release evidence: job log redirect missing");
  }
  return validateLogRedirect(location);
};

export const downloadJobLog = async (location: string): Promise<string> => {
  const finalResponse = await fetch(validateLogRedirect(location), {
    credentials: "omit",
    redirect: "error",
  });
  if (!finalResponse.ok) {
    throw new Error(
      `release evidence: job log download ${finalResponse.status}`,
    );
  }
  return await readBoundedEvidenceFrames(finalResponse);
};

const listRunJobs = async (
  api: ReleaseApi,
  runId: string,
  runAttempt: string,
): Promise<RunJob[]> => {
  const jobs: RunJob[] = [];
  let path: string | null =
    `/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=1`;
  let page = 0;
  while (path) {
    page++;
    if (page > MAX_ASSET_PAGES) {
      throw new Error("release evidence: job pagination limit exceeded");
    }
    const response = await api.request(path);
    const body = await json<{ jobs: RunJob[] }>(response);
    if (!Array.isArray(body.jobs)) {
      throw new Error("release evidence: malformed job list");
    }
    for (const job of body.jobs) {
      if (
        !Number.isSafeInteger(job.id) || job.id <= 0 ||
        typeof job.name !== "string" ||
        (job.conclusion !== null && typeof job.conclusion !== "string")
      ) {
        throw new Error("release evidence: malformed job");
      }
      jobs.push(job);
    }
    path = parseNextLink(response.headers.get("link"));
  }
  return jobs;
};

const laneDefinitions = async (path: string): Promise<LaneDefinition[]> => {
  const policy = JSON.parse(await Deno.readTextFile(path)) as {
    lanes?: Array<{
      lane?: unknown;
      job?: unknown;
      artifacts?: unknown;
    }>;
  };
  if (!Array.isArray(policy.lanes) || policy.lanes.length === 0) {
    throw new Error("release evidence: malformed lane policy");
  }
  const seenLanes = new Set<string>();
  const seenJobs = new Set<string>();
  return policy.lanes.map((lane) => {
    if (
      typeof lane.lane !== "string" || typeof lane.job !== "string" ||
      !/^[A-Za-z0-9_.-]+$/.test(lane.lane) || lane.job.length === 0 ||
      seenLanes.has(lane.lane) || seenJobs.has(lane.job)
    ) {
      throw new Error("release evidence: malformed lane policy");
    }
    seenLanes.add(lane.lane);
    seenJobs.add(lane.job);
    const artifactEntries = lane.artifacts ?? [];
    if (!Array.isArray(artifactEntries)) {
      throw new Error("release evidence: malformed lane policy");
    }
    const artifactPaths = artifactEntries.map((entry) => {
      if (
        typeof entry !== "object" || entry === null ||
        !("path" in entry) || typeof entry.path !== "string" ||
        !safeArchivePath(entry.path)
      ) {
        throw new Error("release evidence: malformed lane policy");
      }
      return `candidate-artifacts/${entry.path}`;
    });
    return { lane: lane.lane, job: lane.job, artifactPaths };
  });
};

const archiveFilesForLane = (definition: LaneDefinition): string[] => [
  `evidence/${definition.lane}.txt`,
  ...definition.artifactPaths,
];

type StagedLaneOutputs = {
  readonly manifest: EvidenceManifest;
  readonly evidenceDir: string;
  readonly artifactDir: string;
};

const commitStagedLaneOutputs = async (
  staged: readonly StagedLaneOutputs[],
  evidenceDir: string,
  artifactDir: string,
): Promise<void> => {
  const planned: Array<{
    readonly archivePath: string;
    readonly source: string;
    readonly destination: string;
  }> = [];
  const destinations = new Set<string>();
  const destinationDirectories = new Set<string>();
  for (const lane of staged) {
    for (const archivePath of lane.manifest.files) {
      if (destinations.has(archivePath)) {
        throw new Error(
          `release evidence: duplicate archive destination ${archivePath}`,
        );
      }
      if (destinationDirectories.has(archivePath)) {
        throw new Error(
          `release evidence: conflicting archive destination ${archivePath}`,
        );
      }
      let parent = archivePath;
      while (true) {
        const separator = parent.lastIndexOf("/");
        if (separator < 0) break;
        parent = parent.slice(0, separator);
        if (destinations.has(parent)) {
          throw new Error(
            `release evidence: conflicting archive destinations ${parent} and ${archivePath}`,
          );
        }
        destinationDirectories.add(parent);
      }
      destinations.add(archivePath);
      const sourceLocation = archiveOutputLocation(
        archivePath,
        lane.evidenceDir,
        lane.artifactDir,
      );
      const destinationLocation = archiveOutputLocation(
        archivePath,
        evidenceDir,
        artifactDir,
      );
      planned.push({
        archivePath,
        source: joinSafe(sourceLocation.root, sourceLocation.relative),
        destination: joinSafe(
          destinationLocation.root,
          destinationLocation.relative,
        ),
      });
    }
  }
  for (const entry of planned) {
    await assertNoSymlink(entry.source);
    await ensureDirectoryPath(parentPath(entry.destination));
    await assertDestinationPath(entry.destination);
  }
  for (const entry of planned) {
    await Deno.writeFile(entry.destination, await Deno.readFile(entry.source));
  }
};

type ProcessRunLanesOptions = {
  readonly evidenceDir: string;
  readonly artifactDir: string;
  readonly scratchPrefix: string;
  readonly afterLane?: (
    manifest: EvidenceManifest,
    archive: Uint8Array,
    jobId: number,
    evidenceDir: string,
    artifactDir: string,
  ) => Promise<void>;
};

const processRunLanes = async (
  api: ReleaseApi,
  options: ProcessRunLanesOptions,
): Promise<void> => {
  const runId = Deno.env.get("RUN_ID") ?? "";
  const runAttempt = Deno.env.get("RUN_ATTEMPT") ?? "";
  const workflow = Deno.env.get("WORKFLOW_SHA") ?? "";
  const expectedCandidate = Deno.env.get("CANDIDATE_SHA") || undefined;
  const expectedBase = Deno.env.get("BASE_SHA") || undefined;
  identity(runId, runAttempt);
  if (!workflow) throw new Error("release evidence: missing workflow identity");
  const policyPath = Deno.env.get("REQUIRED_CHECKS_POLICY");
  if (!policyPath) throw new Error("release evidence: missing lane policy");
  const definitions = await laneDefinitions(policyPath);
  const jobs = await listRunJobs(api, runId, runAttempt);
  const scratch = await createScratchDirectory(options.scratchPrefix);
  await ensureDirectoryPath(options.evidenceDir);
  await ensureDirectoryPath(options.artifactDir);
  let candidate = expectedCandidate;
  let base = expectedBase;
  const staged: StagedLaneOutputs[] = [];
  try {
    for (const definition of definitions) {
      const matching = jobs.filter((job) => job.name === definition.job);
      if (matching.length !== 1) {
        throw new Error(
          `release evidence: expected one job for ${definition.lane}`,
        );
      }
      const job = matching[0];
      const envStatus = Deno.env.get(`LANE_${definition.lane.toUpperCase()}`);
      if (envStatus && envStatus !== job.conclusion) {
        throw new Error(
          `release evidence: job result mismatch ${definition.lane}`,
        );
      }
      if (job.conclusion !== "success") continue;
      const location = await acquireJobLog(api, job.id);
      const log = await downloadJobLog(location);
      const reconstructed = await reconstructLaneLog(log, {
        runId,
        runAttempt,
        workflow,
        candidate,
        base,
        lane: definition.lane,
      });
      candidate ??= reconstructed.identity.candidate;
      base ??= reconstructed.identity.base;
      const expected = {
        runId,
        runAttempt: reconstructed.identity.runAttempt,
        workflow,
        candidate: candidate ?? "",
        base: base ?? "",
        lane: definition.lane,
      };
      const archivePath = joinSafe(scratch, `${definition.lane}.zip`);
      await Deno.writeFile(archivePath, reconstructed.archive);
      const laneStage = joinSafe(scratch, `lanes/${definition.lane}`);
      const laneEvidenceDir = joinSafe(laneStage, "evidence");
      const laneArtifactDir = joinSafe(laneStage, "candidate-artifacts");
      await ensureDirectoryPath(laneEvidenceDir);
      await ensureDirectoryPath(laneArtifactDir);
      const manifest = await extractArchive(
        archivePath,
        expected,
        definition.lane,
        laneEvidenceDir,
        laneArtifactDir,
        archiveFilesForLane(definition),
      );
      await options.afterLane?.(
        manifest,
        reconstructed.archive,
        job.id,
        laneEvidenceDir,
        laneArtifactDir,
      );
      staged.push({
        manifest,
        evidenceDir: laneEvidenceDir,
        artifactDir: laneArtifactDir,
      });
    }
    await commitStagedLaneOutputs(
      staged,
      options.evidenceDir,
      options.artifactDir,
    );
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => undefined);
  }
};
const reusePublishedRunLanes = async (
  api: ReleaseApi,
  evidenceDir: string,
  artifactDir: string,
): Promise<boolean> => {
  const runId = Deno.env.get("RUN_ID") ?? "";
  const runAttempt = Deno.env.get("RUN_ATTEMPT") ?? "";
  const workflow = Deno.env.get("WORKFLOW_SHA") ?? "";
  let candidate = Deno.env.get("CANDIDATE_SHA") || undefined;
  let base = Deno.env.get("BASE_SHA") || undefined;
  const policyPath = Deno.env.get("REQUIRED_CHECKS_POLICY");
  if (!policyPath) throw new Error("release evidence: missing lane policy");
  const definitions = await laneDefinitions(policyPath);
  const jobs = await listRunJobs(api, runId, runAttempt);
  let release: Release;
  try {
    release = await getRelease(api);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "release evidence: release is missing"
    ) {
      return false;
    }
    throw error;
  }
  const assets = await listAssetsForLookup(api, release.id);
  const currentAttempt = BigInt(runAttempt);
  const ready: Array<
    {
      definition: LaneDefinition;
      job: RunJob;
      asset: Asset;
      runAttempt: string;
    }
  > = [];
  for (const definition of definitions) {
    const matching = jobs.filter((job) => job.name === definition.job);
    if (matching.length !== 1) {
      throw new Error(
        `release evidence: expected one job for ${definition.lane}`,
      );
    }
    const job = matching[0];
    const envStatus = Deno.env.get(`LANE_${definition.lane.toUpperCase()}`);
    if (envStatus && envStatus !== job.conclusion) {
      throw new Error(
        `release evidence: job result mismatch ${definition.lane}`,
      );
    }
    if (job.conclusion !== "success") continue;
    const reusable = assets
      .map((asset) => {
        const parsed = parseAssetIdentity(asset.name);
        return parsed && parsed.runId === runId &&
            parsed.lane === definition.lane &&
            parsed.jobId === String(job.id) &&
            BigInt(parsed.runAttempt) <= currentAttempt &&
            assetIsUploaded(asset)
          ? { asset, runAttempt: parsed.runAttempt }
          : null;
      })
      .filter((entry): entry is { asset: Asset; runAttempt: string } =>
        entry !== null
      )
      .sort((left, right) => {
        const leftAttempt = BigInt(left.runAttempt);
        const rightAttempt = BigInt(right.runAttempt);
        return rightAttempt === leftAttempt
          ? 0
          : rightAttempt > leftAttempt
          ? 1
          : -1;
      })[0];
    if (!reusable) return false;
    ready.push({ definition, job, ...reusable });
  }
  const scratch = await createScratchDirectory("trusted-lane-reuse-");
  const staged: StagedLaneOutputs[] = [];
  try {
    for (const { definition, asset, runAttempt: assetAttempt } of ready) {
      const laneStage = joinSafe(scratch, `lanes/${definition.lane}`);
      const laneEvidenceDir = joinSafe(laneStage, "evidence");
      const laneArtifactDir = joinSafe(laneStage, "candidate-artifacts");
      await ensureDirectoryPath(laneEvidenceDir);
      await ensureDirectoryPath(laneArtifactDir);
      const manifest = await fetchAsset(
        api,
        asset,
        laneEvidenceDir,
        {
          runId,
          runAttempt: assetAttempt,
          workflow,
          candidate,
          base,
          lane: definition.lane,
        },
        definition.lane,
        laneArtifactDir,
        archiveFilesForLane(definition),
      );
      candidate ??= manifest.candidate;
      base ??= manifest.base;
      staged.push({
        manifest,
        evidenceDir: laneEvidenceDir,
        artifactDir: laneArtifactDir,
      });
    }
    await commitStagedLaneOutputs(staged, evidenceDir, artifactDir);
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => undefined);
  }
  return true;
};
export async function publishRunLanes(api: ReleaseApi): Promise<void> {
  const evidenceDir = Deno.env.get("EVIDENCE_DIR") ?? "evidence";
  const artifactDir = Deno.env.get("ARTIFACT_DIR") ?? "candidate-artifacts";
  if (await reusePublishedRunLanes(api, evidenceDir, artifactDir)) return;
  await processRunLanes(api, {
    evidenceDir,
    artifactDir,
    scratchPrefix: "trusted-lane-",
    afterLane: async (
      manifest,
      archive,
      jobId,
      laneEvidenceDir,
      laneArtifactDir,
    ) => {
      const published = await publishEvidence(api, manifest, archive, jobId);
      await fetchEvidence(
        api,
        published.assetId,
        manifest,
        laneEvidenceDir,
        laneArtifactDir,
      );
    },
  });
}
export async function verifyRunLanesOutput(
  api: ReleaseApi,
  outputPath: string,
): Promise<void> {
  const repository = Deno.env.get("GITHUB_REPOSITORY") ?? "";
  const runId = Deno.env.get("RUN_ID") ?? "";
  const runAttempt = Deno.env.get("RUN_ATTEMPT") ?? "";
  const workflow = Deno.env.get("WORKFLOW_SHA") ?? "";
  const candidate = Deno.env.get("CANDIDATE_SHA") ?? "";
  const base = Deno.env.get("BASE_SHA") ?? "";
  const failures: string[] = [];
  try {
    const policyPath = Deno.env.get("REQUIRED_CHECKS_POLICY");
    if (!policyPath) throw new Error("release evidence: missing lane policy");
    const policy = parsePolicy(await Deno.readTextFile(policyPath));
    if (Deno.env.get("PUBLISH_EVIDENCE") === "false") {
      await processRunLanes(api, {
        evidenceDir: Deno.env.get("EVIDENCE_DIR") ?? "evidence",
        artifactDir: Deno.env.get("ARTIFACT_DIR") ?? "candidate-artifacts",
        scratchPrefix: "backend-evaluation-",
      });
    } else {
      await publishRunLanes(api);
    }
    const successful = policy.lanes.filter((lane) =>
      Deno.env.get(`LANE_${lane.lane.toUpperCase()}`) === "success"
    );
    const event = Deno.env.get("GITHUB_EVENT_NAME");
    for (const lane of policy.lanes) {
      const status = Deno.env.get(`LANE_${lane.lane.toUpperCase()}`);
      const expected = expectedLaneStatus(lane, event);
      if (status !== expected) {
        failures.push(
          `${lane.lane}: expected ${expected} lane result, observed ${
            status ?? "missing"
          }`,
        );
      }
    }
    const successfulNames = successful.map((lane) => lane.lane);
    if (successfulNames.length > 0) {
      failures.push(
        ...await evaluateEvidence(
          Deno.env.get("EVIDENCE_DIR") ?? "evidence",
          successfulNames,
          candidate,
          base,
          workflow,
          runId,
          runAttempt,
          policy.dependencies,
        ),
        ...await evaluateArtifacts(
          Deno.env.get("EVIDENCE_DIR") ?? "evidence",
          Deno.env.get("ARTIFACT_DIR") ?? "candidate-artifacts",
          successful,
        ),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(message.slice(0, 512));
  }
  const verdict: TrustedVerdict = {
    version: 1,
    repository,
    runId,
    runAttempt,
    workflow,
    candidate,
    base,
    status: failures.length === 0 ? "success" : "failure",
    failures,
  };
  const source = JSON.stringify(verdict);
  if (
    new TextEncoder().encode(source).byteLength >
      MAX_TRUSTED_VERDICT_BYTES
  ) {
    throw new Error("release evidence: trusted verdict exceeds byte limit");
  }
  await Deno.writeTextFile(outputPath, `verdict=${source}\n`, { append: true });
}

const parseAssetIdentity = (
  name: string,
): {
  runId: string;
  runAttempt: string;
  lane: string;
  jobId?: string;
} | null => {
  const trustedMatch = name.match(
    /^evidence-(\d+)-(\d+)-job-(\d+)-([A-Za-z0-9_.-]+)\.zip$/,
  );
  if (trustedMatch) {
    return {
      runId: trustedMatch[1],
      runAttempt: trustedMatch[2],
      jobId: trustedMatch[3],
      lane: trustedMatch[4],
    };
  }
  const legacyMatch = name.match(
    /^evidence-(\d+)-(\d+)-([A-Za-z0-9_.-]+)\.zip$/,
  );
  return legacyMatch
    ? {
      runId: legacyMatch[1],
      runAttempt: legacyMatch[2],
      lane: legacyMatch[3],
    }
    : null;
};

const readAssetPage = async (
  api: ReleaseApi,
  path: string,
): Promise<{ assets: Asset[]; next: string | null }> => {
  const response = await api.request(path);
  const assets = await json<Asset[]>(response);
  if (!Array.isArray(assets)) {
    throw new Error("release evidence: malformed asset list");
  }
  return {
    assets,
    next: parseNextLink(response.headers.get("link")),
  };
};

const listAssetsForLookup = async (
  api: ReleaseApi,
  releaseId: number,
): Promise<Asset[]> => {
  const assets: Asset[] = [];
  let path: string | null = `/releases/${releaseId}/assets?per_page=100&page=1`;
  let page = 0;
  while (path) {
    page++;
    if (page > MAX_ASSET_PAGES) {
      throw new Error("release evidence: asset pagination limit exceeded");
    }
    const result = await readAssetPage(api, path);
    assets.push(...result.assets);
    path = result.next;
  }
  return assets;
};

const ACTIVE_WORKFLOW_RUN_STATUSES = [
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
] as const;

type WorkflowRunState = {
  readonly active: boolean;
  readonly conclusion: string | null;
};

const readWorkflowRunState = async (
  api: ReleaseApi,
  runId: string,
): Promise<WorkflowRunState> => {
  const response = await api.request(`/actions/runs/${runId}`);
  if (response.status === 404) {
    return { active: false, conclusion: null };
  }
  if (!response.ok) {
    throw new Error(`release evidence: run lookup ${response.status}`);
  }
  const run = await response.json() as WorkflowRun;
  return {
    active: run.status !== undefined
      ? run.status !== "completed"
      : run.conclusion === null,
    conclusion: run.conclusion,
  };
};

const readActiveWorkflowRunPage = async (
  api: ReleaseApi,
  path: string,
): Promise<{ runs: WorkflowRun[]; next: string | null }> => {
  const response = await api.request(path);
  const result = await json<{ workflow_runs?: unknown }>(response);
  if (!Array.isArray(result.workflow_runs)) {
    throw new Error("release evidence: malformed workflow run list");
  }
  const runs: WorkflowRun[] = [];
  for (const candidate of result.workflow_runs) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("release evidence: malformed workflow run");
    }
    const run = candidate as Partial<WorkflowRun>;
    const runId = run.id;
    if (
      typeof runId !== "number" || !Number.isSafeInteger(runId) ||
      runId <= 0 || typeof run.status !== "string"
    ) {
      throw new Error("release evidence: malformed workflow run");
    }
    runs.push(run as WorkflowRun);
  }
  return {
    runs,
    next: parseNextLink(response.headers.get("link")),
  };
};

const isActiveWorkflowRunStatus = (
  status: string,
): boolean => ACTIVE_WORKFLOW_RUN_STATUSES.some((active) => active === status);

const buildActiveWorkflowRunIndex = async (
  budget: RetentionRequestBudget,
  assetRunIds: ReadonlySet<string>,
): Promise<{
  activeRunIds: Set<string>;
  classificationComplete: boolean;
}> => {
  const activeRunIds = new Set<string>();
  if (assetRunIds.size === 0) {
    return { activeRunIds, classificationComplete: true };
  }

  for (const status of ACTIVE_WORKFLOW_RUN_STATUSES) {
    let path: string | null =
      `/actions/runs?status=${status}&per_page=100&page=1`;
    let page = 0;
    while (path) {
      if (activeRunIds.size === assetRunIds.size) {
        return { activeRunIds, classificationComplete: true };
      }
      if (page >= MAX_ACTIVE_RUN_PAGES || budget.remaining < 1) {
        return { activeRunIds, classificationComplete: false };
      }
      page++;
      const result = await readActiveWorkflowRunPage(budget, path);
      for (const run of result.runs) {
        if (
          isActiveWorkflowRunStatus(run.status ?? "") &&
          assetRunIds.has(String(run.id))
        ) {
          activeRunIds.add(String(run.id));
        }
      }
      path = result.next;
    }
  }
  return { activeRunIds, classificationComplete: true };
};

class RetentionRequestBudget implements ReleaseApi {
  #used = 0;

  constructor(private readonly api: ReleaseApi) {}

  get remaining(): number {
    return MAX_RETENTION_API_REQUESTS - this.#used - 1;
  }

  request(path: string, init?: RequestInit): Promise<Response> {
    if (this.#used + 1 >= MAX_RETENTION_API_REQUESTS) {
      throw new Error("release evidence: retention request budget exhausted");
    }
    this.#used++;
    return this.api.request(path, init);
  }
}

export async function pruneReleaseAssets(
  api: ReleaseApi,
  now = Date.now(),
): Promise<ReleasePruneSummary> {
  const budget = new RetentionRequestBudget(api);
  const release = await getRelease(budget);
  // The platform limit makes this a complete snapshot for every valid release.
  // It also keeps the publication lookup ceiling independent and intact.
  const assets = await listAssetsForLookup(budget, release.id);
  const assetRunIds = new Set<string>();
  const scanAssets: Asset[] = [];
  for (let left = 0, right = assets.length - 1; left <= right; left++) {
    const leftAsset = assets[left];
    scanAssets.push(leftAsset);
    const leftIdentity = parseAssetIdentity(leftAsset.name);
    if (leftIdentity) assetRunIds.add(leftIdentity.runId);
    if (left < right) {
      const rightAsset = assets[right--];
      scanAssets.push(rightAsset);
      const rightIdentity = parseAssetIdentity(rightAsset.name);
      if (rightIdentity) assetRunIds.add(rightIdentity.runId);
    }
  }

  const activeIndex = await buildActiveWorkflowRunIndex(budget, assetRunIds);
  const deletedIds = new Set<number>();
  let protectedActive = 0;
  let unclassified = 0;
  for (const asset of assets) {
    const assetIdentity = parseAssetIdentity(asset.name);
    if (!assetIdentity) continue;
    if (activeIndex.activeRunIds.has(assetIdentity.runId)) {
      protectedActive++;
    } else if (!activeIndex.classificationComplete) {
      unclassified++;
    }
  }

  // Every deletion candidate gets a fresh run lookup immediately before its
  // durable DELETE. The aggregate index only makes the candidate set cheap.
  for (const asset of scanAssets) {
    const assetIdentity = parseAssetIdentity(asset.name);
    if (
      !assetIdentity || !asset.created_at ||
      activeIndex.activeRunIds.has(assetIdentity.runId) ||
      !activeIndex.classificationComplete
    ) continue;
    const created = Date.parse(asset.created_at);
    if (!Number.isFinite(created)) continue;

    const inventoryAfterDeletes = assets.length - deletedIds.size;
    const mayNeedDelete = inventoryAfterDeletes > MAX_RELEASE_ASSETS ||
      now - created >= FAILURE_RETENTION_MS;
    if (budget.remaining < 2) break;
    if (!mayNeedDelete) continue;

    const runState = await readWorkflowRunState(budget, assetIdentity.runId);
    if (runState.active) {
      protectedActive++;
      continue;
    }

    const retention = runState.conclusion === "success"
      ? SUCCESS_RETENTION_MS
      : FAILURE_RETENTION_MS;
    const expired = now - created >= retention;
    const overCap = assets.length - deletedIds.size > MAX_RELEASE_ASSETS;
    if (!expired && !overCap) continue;

    await deletePartialPublication(budget, asset.id);
    deletedIds.add(asset.id);
  }

  return {
    before: assets.length,
    after: assets.length - deletedIds.size,
    deleted: deletedIds.size,
    protectedActive,
    classificationComplete: activeIndex.classificationComplete,
    unclassified,
  };
}

const cli = async (): Promise<void> => {
  const [operation, ...args] = Deno.args;
  if (operation === "emit-log" && args.length === 1) {
    const { manifest, archive } = await createLaneArchive(
      args[0],
      Deno.env.get("EVIDENCE_DIR") ?? "evidence",
      Deno.env.get("ARTIFACT_DIR") ?? "candidate-artifacts",
    );
    console.log(await encodeLaneLog(manifest, archive));
    return;
  }
  const api = githubApiFromEnv();
  if (operation === "verify-run-lanes-output" && args.length === 1) {
    await verifyRunLanesOutput(api, args[0]);
    return;
  }
  if (operation === "publish-run-lanes" && args.length === 0) {
    await publishRunLanes(api);
    return;
  }
  if (operation === "prune" && args.length === 0) {
    const summary = await pruneReleaseAssets(api);
    console.log(JSON.stringify(summary));
    const summaryPath = Deno.env.get("GITHUB_STEP_SUMMARY");
    if (summaryPath) {
      await Deno.writeTextFile(
        summaryPath,
        `## Release evidence prune\n\n- Before: ${summary.before}\n- After: ${summary.after}\n- Deleted: ${summary.deleted}\n- Protected active-run assets: ${summary.protectedActive}${
          summary.classificationComplete
            ? ""
            : " (lower bound; classification incomplete)"
        }\n- Active-run classification complete: ${summary.classificationComplete}\n- Unclassified assets: ${summary.unclassified}\n`,
      );
    }
    return;
  }
  throw new Error(
    "usage: release-evidence.ts emit-log lane | verify-run-lanes-output GITHUB_OUTPUT | publish-run-lanes | prune",
  );
};

if (import.meta.main) await cli();
