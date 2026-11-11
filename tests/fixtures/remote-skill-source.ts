import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";

export type RemoteSkillFixtureFile = Readonly<{
  path: string;
  content: Uint8Array;
  mediaType?: string;
  isExecutable?: boolean;
}>;

export type RemoteSkillFixture = Readonly<{
  manifest: Readonly<Record<string, unknown>>;
  manifestBytes: Uint8Array;
  files: readonly RemoteSkillFixtureFile[];
}>;

export type UstarFixtureEntry = Readonly<{
  path: string;
  content: Uint8Array;
  mode?: number;
  type?: number;
  linkName?: string;
}>;

const encoder = new TextEncoder();

export async function fixtureSha256(
  value: string | Uint8Array,
): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function createRemoteSkillFixture(
  files: readonly RemoteSkillFixtureFile[] = [{
    path: "SKILL.md",
    content: encoder.encode("# Remote skill\n"),
    mediaType: "text/markdown",
  }],
  options: Readonly<{
    license?: string;
    entryPath?: string;
    manifestExtra?: Readonly<Record<string, unknown>>;
  }> = {},
): Promise<RemoteSkillFixture> {
  const manifestFiles = await Promise.all(files.map(async (file) => ({
    path: file.path,
    mediaType: file.mediaType ?? "text/plain",
    sizeBytes: file.content.byteLength,
    sha256: await fixtureSha256(file.content),
    isExecutable: file.isExecutable ?? false,
  })));
  manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
  const unsignedManifest = {
    schemaVersion: 1,
    license: options.license ?? "MIT",
    entryPath: options.entryPath ?? files[0]?.path ?? "SKILL.md",
    files: manifestFiles,
    ...(options.manifestExtra ?? {}),
  };
  const manifest = Object.freeze({
    ...unsignedManifest,
    digest: await fixtureSha256(canonicalJson(unsignedManifest)),
  });
  return Object.freeze({
    manifest,
    manifestBytes: encoder.encode(JSON.stringify(manifest)),
    files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
  });
}

function writeText(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error("USTAR_FIXTURE_FIELD_OVERFLOW");
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = value.toString(8);
  if (octal.length > length - 1) {
    throw new Error("USTAR_FIXTURE_OCTAL_OVERFLOW");
  }
  writeText(target, offset, length - 1, octal.padStart(length - 1, "0"));
  target[offset + length - 1] = 0;
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
  for (
    let index = path.lastIndexOf("/");
    index > 0;
    index = path.lastIndexOf("/", index - 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new Error("USTAR_FIXTURE_PATH_OVERFLOW");
}

function createHeader(entry: UstarFixtureEntry): Uint8Array {
  const header = new Uint8Array(512);
  const { name, prefix } = splitUstarPath(entry.path);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode ?? 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type ?? 0x30;
  if (entry.linkName) writeText(header, 157, 100, entry.linkName);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 265, 32, "bakery");
  writeText(header, 297, 32, "bakery");
  writeText(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encodedChecksum = checksum.toString(8).padStart(6, "0");
  writeText(header, 148, 6, encodedChecksum);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function createUstarArchive(
  entries: readonly UstarFixtureEntry[],
  options: Readonly<{
    endBlocks?: number;
    trailingBytes?: Uint8Array;
  }> = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const header = createHeader(entry);
    const padding = new Uint8Array(
      (512 - entry.content.byteLength % 512) % 512,
    );
    chunks.push(header, entry.content, padding);
    total += header.byteLength + entry.content.byteLength + padding.byteLength;
  }
  const end = new Uint8Array((options.endBlocks ?? 2) * 512);
  chunks.push(end);
  total += end.byteLength;
  if (options.trailingBytes) {
    chunks.push(options.trailingBytes);
    total += options.trailingBytes.byteLength;
  }
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

export async function gzipFixture(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes);
  const stream = new Blob([input]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return compressed;
}

export async function createRemoteSkillArchive(
  fixture: RemoteSkillFixture,
  options: Readonly<{
    prefix?: string;
    endBlocks?: number;
    trailingTarBytes?: Uint8Array;
    extraEntries?: readonly UstarFixtureEntry[];
  }> = {},
): Promise<Uint8Array> {
  const prefix = options.prefix ? `${options.prefix}/` : "";
  const entries: UstarFixtureEntry[] = [
    {
      path: `${prefix}manifest.json`,
      content: fixture.manifestBytes,
      mode: 0o644,
    },
    ...fixture.files.map((file) => ({
      path: `${prefix}${file.path}`,
      content: file.content,
      mode: file.isExecutable ? 0o755 : 0o644,
    })),
    ...(options.extraEntries ?? []),
  ];
  return await gzipFixture(createUstarArchive(entries, {
    endBlocks: options.endBlocks,
    trailingBytes: options.trailingTarBytes,
  }));
}

export function byteStream(
  bytes: Uint8Array,
  chunkSize = bytes.byteLength || 1,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

export type RemoteSkillSourceObservation = Readonly<{
  path: string;
  ifMatch: string | null;
}>;

export type RunningRemoteSkillSourceFixture = Readonly<{
  authority: string;
  nonce: string;
  pid: number;
  archiveUrl: string;
  archiveVariantUrl: (name: string) => string;
  invalidArchiveUrl: string;
  oversizedArchiveUrl: string;
  redirectArchiveUrl: string;
  timeoutArchiveUrl: string;
  gitUrl: string;
  etag: string;
  initialCommit: string;
  secondCommit: string;
  useSecondArchive: () => Promise<void>;
  moveTagToSecondCommit: () => Promise<void>;
  observations: () => Promise<readonly RemoteSkillSourceObservation[]>;
  stop: () => Promise<void>;
}>;

const gitFixtureEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  XDG_CONFIG_HOME: "/nonexistent",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

async function runFixtureGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const output = await new Deno.Command("/usr/bin/git", {
    args: [...args],
    cwd,
    clearEnv: true,
    env: gitFixtureEnvironment,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `REMOTE_SOURCE_FIXTURE_GIT_FAILED:${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function writeFixtureTree(
  work: string,
  fixture: RemoteSkillFixture,
): Promise<void> {
  await Deno.writeFile(`${work}/manifest.json`, fixture.manifestBytes);
  for (const file of fixture.files) {
    const target = `${work}/${file.path}`;
    const slash = target.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(target.slice(0, slash), { recursive: true });
    }
    await Deno.writeFile(target, file.content, {
      mode: file.isExecutable ? 0o755 : 0o644,
    });
  }
}

async function fixtureControl(authority: string, path: string): Promise<void> {
  const response = await fetch(`${authority}${path}`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`REMOTE_SOURCE_FIXTURE_CONTROL_${response.status}`);
  }
  await response.body?.cancel();
}

/** Starts an owned loopback archive and Git smart-HTTP fixture process. */
export async function startRemoteSkillSourceFixture(): Promise<
  RunningRemoteSkillSourceFixture
> {
  const root = await Deno.makeTempDir({ prefix: "bakery-remote-source-" });
  const nonce = crypto.randomUUID();
  const work = `${root}/work`;
  await Deno.mkdir(work);
  let child: Deno.ChildProcess | undefined;
  try {
    const first = await createRemoteSkillFixture();
    const second = await createRemoteSkillFixture([{
      path: "SKILL.md",
      content: encoder.encode("# Remote skill second\n"),
      mediaType: "text/markdown",
    }]);
    const invalid = Object.freeze({
      ...first,
      files: Object.freeze([Object.freeze({
        ...first.files[0],
        content: encoder.encode("# Broken skill\n"),
      })]),
    });
    await Promise.all([
      Deno.writeFile(
        `${root}/archive-first.gz`,
        await createRemoteSkillArchive(first),
      ),
      Deno.writeFile(
        `${root}/archive-second.gz`,
        await createRemoteSkillArchive(second),
      ),
      Deno.writeFile(
        `${root}/archive-invalid.gz`,
        await createRemoteSkillArchive(invalid),
      ),
    ]);

    await runFixtureGit(work, ["init", "--initial-branch=main"]);
    await writeFixtureTree(work, first);
    await runFixtureGit(work, ["add", "--", "manifest.json", "SKILL.md"]);
    await runFixtureGit(work, [
      "-c",
      "user.name=Bakery Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-m",
      "first",
    ]);
    const initialCommit = await runFixtureGit(work, ["rev-parse", "HEAD"]);
    await runFixtureGit(work, ["tag", "v1"]);
    await writeFixtureTree(work, second);
    await runFixtureGit(work, ["add", "--", "manifest.json", "SKILL.md"]);
    await runFixtureGit(work, [
      "-c",
      "user.name=Bakery Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-m",
      "second",
    ]);
    const secondCommit = await runFixtureGit(work, ["rev-parse", "HEAD"]);
    await Deno.writeTextFile(`${root}/second-commit`, `${secondCommit}\n`);
    await runFixtureGit(root, ["clone", "--bare", work, "repository.git"]);
    await runFixtureGit(root, [
      "--git-dir",
      `${root}/repository.git`,
      "update-ref",
      "refs/tags/v1",
      initialCommit,
    ]);

    const processPath =
      new URL("./remote-skill-source-process.ts", import.meta.url)
        .pathname;
    child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        `--allow-read=${root},${processPath}`,
        "--allow-net=127.0.0.1",
        "--allow-run=/usr/bin/git,/usr/lib/git-core/git-http-backend",
        processPath,
        root,
        nonce,
      ],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const reader = child.stdout.getReader();
    const deadline = Date.now() + 10_000;
    let text = "";
    let port: number | undefined;
    while (Date.now() < deadline && port === undefined) {
      const timeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), Math.min(250, deadline - Date.now()))
      );
      const result = await Promise.race([reader.read(), timeout]);
      if (result === null) continue;
      if (result.done) break;
      text += new TextDecoder().decode(result.value, { stream: true });
      const match = /FIXTURE_PORT=(\d+)/.exec(text);
      if (match) port = Number(match[1]);
    }
    reader.releaseLock();
    if (port === undefined) {
      const stderr = new TextDecoder().decode((await child.output()).stderr);
      throw new Error(`REMOTE_SOURCE_FIXTURE_START_FAILED:${stderr}`);
    }
    const authority = `http://127.0.0.1:${port}`;
    const identityResponse = await fetch(`${authority}/control/identity`);
    const identity = await identityResponse.json() as {
      nonce?: string;
      origin?: string;
    };
    if (
      !identityResponse.ok || identity.nonce !== nonce ||
      identity.origin !== authority
    ) {
      throw new Error("REMOTE_SOURCE_FIXTURE_IDENTITY_MISMATCH");
    }
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try {
        child?.kill("SIGTERM");
      } catch {
        // The owned process may already have exited.
      }
      const shutdown = Promise.withResolvers<false>();
      const timer = setTimeout(() => shutdown.resolve(false), 3_000);
      const exited = await Promise.race([
        child!.status.then(() => true, () => true),
        shutdown.promise,
      ]);
      clearTimeout(timer);
      if (!exited) {
        try {
          child?.kill("SIGKILL");
        } catch {
          // The owned process may already have exited.
        }
      }
      await child?.status.catch(() => undefined);
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    };
    return Object.freeze({
      authority,
      nonce,
      pid: child.pid,
      archiveUrl: `${authority}/archive`,
      archiveVariantUrl: (name) => {
        if (!/^[a-z][a-z-]{0,40}$/.test(name)) {
          throw new Error("REMOTE_SOURCE_FIXTURE_VARIANT_INVALID");
        }
        return `${authority}/archive-fixture-${name}`;
      },
      invalidArchiveUrl: `${authority}/archive-invalid`,
      oversizedArchiveUrl: `${authority}/archive-oversized`,
      redirectArchiveUrl: `${authority}/archive-redirect`,
      timeoutArchiveUrl: `${authority}/archive-timeout`,
      gitUrl: `${authority}/repository.git`,
      etag: '"fixture-revision-1"',
      initialCommit,
      secondCommit,
      useSecondArchive: () =>
        fixtureControl(authority, "/control/archive/second"),
      moveTagToSecondCommit: () =>
        fixtureControl(authority, "/control/git/second"),
      observations: async () => {
        const response = await fetch(`${authority}/control/observations`);
        if (!response.ok) {
          throw new Error("REMOTE_SOURCE_FIXTURE_OBSERVATIONS_FAILED");
        }
        return await response.json() as readonly RemoteSkillSourceObservation[];
      },
      stop,
    });
  } catch (error) {
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The owned process may already have exited.
      }
      await child.status.catch(() => undefined);
    }
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

/** Stops an owned remote source fixture; safe to call more than once. */
export async function stopRemoteSkillSourceFixture(
  fixture: RunningRemoteSkillSourceFixture,
): Promise<void> {
  await fixture.stop();
}
