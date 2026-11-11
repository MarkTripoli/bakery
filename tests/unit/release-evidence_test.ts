import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assetName,
  downloadJobLog,
  encodeLaneLog,
  FAILURE_RETENTION_MS,
  fetchEvidence,
  findAsset,
  getOrCreateRelease,
  githubApiFromEnv,
  githubRequestUrl,
  MAX_ARCHIVE_BYTES,
  MAX_FILES,
  MAX_JOB_LOG_BYTES,
  MAX_LOG_ARCHIVE_BYTES,
  MAX_LOG_CHUNK_BYTES,
  MAX_RELEASE_ASSETS,
  MAX_RETENTION_API_REQUESTS,
  pruneReleaseAssets,
  publishEvidence,
  publishRunLanes,
  reconstructLaneLog,
  SUCCESS_RETENTION_MS,
  validateArchiveEntries,
  validateLogRedirect,
  validateManifest,
  verifyRunLanesOutput,
} from "../../scripts/ci/release-evidence.ts";
import type { ReleasePruneSummary } from "../../scripts/ci/release-evidence.ts";
import { evaluateEvidence } from "../../scripts/ci/evaluate.ts";
import { writeEvidence } from "../../scripts/ci/write-evidence.ts";

type Manifest = {
  runId: string;
  runAttempt: string;
  workflow: string;
  candidate: string;
  base: string;
  lane: string;
  files: string[];
};

type FakeState = {
  release: boolean;
  assets: Array<{ id: number; name: string; size: number; state: string }>;
  archive: Uint8Array | null;
  calls: string[];
  nextUploadStatus?: number;
  partialUploadId?: number;
};

const manifest: Manifest = {
  runId: "123",
  runAttempt: "2",
  workflow: "w".repeat(40),
  candidate: "a".repeat(40),
  base: "b".repeat(40),
  lane: "fast-unit",
  files: ["evidence/fast-unit.txt"],
};

const release = {
  id: 7,
  tag_name: "ci-evidence",
  upload_url:
    "https://uploads.github.com/repos/owner/repo/releases/7/assets{?name,label}",
};

const fakeApi = (state: FakeState) => ({
  request: async (path: string, init?: RequestInit): Promise<Response> => {
    state.calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/releases/tags/ci-evidence") {
      return state.release
        ? Response.json(release)
        : new Response(null, { status: 404 });
    }
    if (path === "/releases" && init?.method === "POST") {
      state.release = true;
      return Response.json(release, { status: 201 });
    }
    if (path.startsWith("/releases/7/assets?")) {
      return Response.json(state.assets, {
        headers: { link: "" },
      });
    }
    if (path.startsWith("https://uploads.github.com/")) {
      if (state.nextUploadStatus) {
        const id = state.partialUploadId ?? 99;
        state.assets.push({
          id,
          name: "evidence-123-2-fast-unit.zip",
          size: 1,
          state: "uploading",
        });
        return Response.json({ id, name: "evidence-123-2-fast-unit.zip" }, {
          status: state.nextUploadStatus,
        });
      }
      state.archive = new Uint8Array(
        await new Response(init?.body as BodyInit | null).arrayBuffer(),
      );
      const asset = {
        id: 9,
        name: "evidence-123-2-fast-unit.zip",
        size: state.archive.byteLength,
        state: "uploaded",
      };
      state.assets.push(asset);
      return Response.json({
        ...asset,
        browser_download_url: "https://github.example/asset/9",
      }, { status: 201 });
    }
    if (path === "/releases/assets/9" && !init?.method) {
      return state.archive === null
        ? new Response(null, { status: 404 })
        : new Response(state.archive as unknown as BodyInit, {
          headers: { "content-length": String(state.archive.byteLength) },
        });
    }
    if (path === "/releases/assets/99" && init?.method === "DELETE") {
      state.assets = state.assets.filter((asset) => asset.id !== 99);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  },
});

const envValues = {
  GITHUB_REPOSITORY: "owner/repo",
  RUN_ID: manifest.runId,
  RUN_ATTEMPT: manifest.runAttempt,
  WORKFLOW_SHA: manifest.workflow,
  CANDIDATE_SHA: manifest.candidate,
  BASE_SHA: manifest.base,
};
const dependencies = "deno:2.9.1,node:22.22.0,pnpm:10.33.0";

const withEnvironment = async (
  values: Record<string, string | undefined>,
  action: () => Promise<void>,
): Promise<void> => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
};

type LaneArchiveFixture = {
  readonly lane: string;
  readonly job: string;
  readonly manifest: Manifest;
  readonly archive: Uint8Array;
  readonly artifactPaths: readonly string[];
};

const verifyLaneArchiveFixtures = async (
  root: string,
  fixtures: readonly LaneArchiveFixture[],
): Promise<{ status: string; failures: string[] }> => {
  const policyPath = `${root}/required-checks.json`;
  const outputPath = `${root}/github-output`;
  const jobsPath =
    `/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}/jobs?per_page=100&page=1`;
  const locations = fixtures.map((_, index) =>
    `https://productionresultssa17.blob.core.windows.net/actions/fixture-${index}?sig=redacted`
  );
  const jobs = fixtures.map((fixture, index) => ({
    id: 70 + index,
    name: fixture.job,
    conclusion: "success",
  }));
  const api = {
    request: (path: string): Promise<Response> => {
      if (path === jobsPath) {
        return Promise.resolve(Response.json({ jobs }));
      }
      const logIndex = jobs.findIndex((job) =>
        path === `/actions/jobs/${job.id}/logs`
      );
      if (logIndex >= 0) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: locations[logIndex] },
          }),
        );
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  const logs = new Map(
    await Promise.all(
      fixtures.map(async (fixture, index) =>
        [
          locations[index],
          frameGithubJobLog(
            await encodeLaneLog(fixture.manifest, fixture.archive),
          ),
        ] as const
      ),
    ),
  );
  await Deno.writeTextFile(
    policyPath,
    JSON.stringify({
      workflow: "Bakery connected/native",
      workflowPath: ".github/workflows/backend-connected-native.yml",
      aggregateJob: "connected/native preflight",
      dependencies,
      lanes: fixtures.map((fixture) => ({
        lane: fixture.lane,
        job: fixture.job,
        artifacts: fixture.artifactPaths.map((path) => ({
          path,
          verify: "runtime-manifest",
        })),
      })),
    }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const log = logs.get(String(input));
    if (log === undefined) {
      throw new Error(`unexpected ${String(input)}`);
    }
    return Promise.resolve(new Response(log));
  };
  try {
    await withEnvironment(
      {
        ...envValues,
        ...Object.fromEntries(
          fixtures.map((fixture) => [
            `LANE_${fixture.lane.toUpperCase()}`,
            "success",
          ]),
        ),
        REQUIRED_CHECKS_POLICY: policyPath,
        EVIDENCE_DIR: `${root}/evidence`,
        ARTIFACT_DIR: `${root}/candidate-artifacts`,
        SCRATCH_DIR: root,
        PUBLISH_EVIDENCE: "false",
      },
      async () => await verifyRunLanesOutput(api, outputPath),
    );
    return JSON.parse(
      (await Deno.readTextFile(outputPath)).slice("verdict=".length).trim(),
    ) as { status: string; failures: string[] };
  } finally {
    globalThis.fetch = originalFetch;
  }
};
const GITHUB_LOG_TIMESTAMP = "2026-09-22T17:14:36.0497405Z";

const frameGithubJobLog = (log: string): string => {
  const lines = log.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return `${
    lines.map((line) => `${GITHUB_LOG_TIMESTAMP} ${line}`).join("\n")
  }\n`;
};

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const zipFixture = async (
  archiveManifest: Manifest,
  options: {
    symlink?: boolean;
    extraFile?: string;
    extraFiles?: readonly string[];
    extraFileText?: string;
    evidenceText?: string;
    directoryCount?: number;
    directoryNameLength?: number;
  } = {},
): Promise<Uint8Array> => {
  const root = await Deno.makeTempDir();
  let outside: string | undefined;
  try {
    const evidenceFile = archiveManifest.files.find((file) =>
      file.startsWith("evidence/")
    );
    if (!evidenceFile) throw new Error("test fixture requires evidence file");
    const evidencePath = `${root}/${evidenceFile}`;
    await Deno.mkdir(evidencePath.slice(0, evidencePath.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${root}/manifest.json`,
      JSON.stringify(archiveManifest),
    );
    if (options.symlink) {
      outside = await Deno.makeTempFile();
      await Deno.writeTextFile(outside, "outside");
      await Deno.symlink(outside, evidencePath);
    } else {
      await Deno.writeTextFile(
        evidencePath,
        options.evidenceText ?? `lane=${archiveManifest.lane}\n`,
      );
    }
    const extraFiles = [
      ...(options.extraFile ? [options.extraFile] : []),
      ...(options.extraFiles ?? []),
    ];
    for (const extraFile of extraFiles) {
      const extraPath = `${root}/${extraFile}`;
      await Deno.mkdir(extraPath.slice(0, extraPath.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(
        extraPath,
        options.extraFileText ?? "undeclared\n",
      );
    }
    for (let index = 0; index < (options.directoryCount ?? 0); index++) {
      await Deno.mkdir(
        `${root}/empty-${index}-${
          "x".repeat(options.directoryNameLength ?? 0)
        }`,
      );
    }
    const output = await new Deno.Command("zip", {
      args: [
        "-q",
        "-r",
        ...(options.symlink ? ["-y"] : []),
        "fixture.zip",
        ".",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success, new TextDecoder().decode(output.stderr));
    return await Deno.readFile(`${root}/fixture.zip`);
  } finally {
    await Deno.remove(root, { recursive: true });
    if (outside) await Deno.remove(outside).catch(() => undefined);
  }
};
const productionEvidenceArchive = async (
  archiveManifest: Manifest,
  status: "success" | "failure" = "success",
): Promise<Uint8Array> => {
  const root = await Deno.makeTempDir();
  try {
    await writeEvidence({
      lane: archiveManifest.lane,
      command: "pnpm test:unit",
      testCases: "production-shaped rerun evidence",
      status,
      candidate: archiveManifest.candidate,
      base: archiveManifest.base,
      workflow: archiveManifest.workflow,
      runId: archiveManifest.runId,
      runAttempt: archiveManifest.runAttempt,
      artifacts: "none",
    }, `${root}/evidence`);
    return await zipFixture(archiveManifest, {
      evidenceText: await Deno.readTextFile(
        `${root}/evidence/${archiveManifest.lane}.txt`,
      ),
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

const forgeCentralDirectorySize = (
  archive: Uint8Array,
  path: string,
  bytes: number,
): Uint8Array => {
  const forged = new Uint8Array(archive);
  const view = new DataView(
    forged.buffer,
    forged.byteOffset,
    forged.byteLength,
  );
  let endOfCentralDirectory = -1;
  for (let offset = forged.length - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) {
    throw new Error("fixture has no ZIP end-of-central-directory record");
  }
  const centralDirectorySize = view.getUint32(
    endOfCentralDirectory + 12,
    true,
  );
  let offset = view.getUint32(endOfCentralDirectory + 16, true);
  const end = offset + centralDirectorySize;
  while (offset < end && view.getUint32(offset, true) === 0x02014b50) {
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(
      forged.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (name === path) {
      view.setUint32(offset + 24, bytes, true);
      return forged;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`fixture has no central-directory entry for ${path}`);
};
const forgeEntryCrc = (
  archive: Uint8Array,
  paths: readonly string[],
): Uint8Array => {
  const forged = new Uint8Array(archive);
  const view = new DataView(
    forged.buffer,
    forged.byteOffset,
    forged.byteLength,
  );
  const pathSet = new Set(paths);
  let endOfCentralDirectory = -1;
  for (let offset = forged.length - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) {
    throw new Error("fixture has no ZIP end-of-central-directory record");
  }
  const centralDirectorySize = view.getUint32(
    endOfCentralDirectory + 12,
    true,
  );
  let offset = view.getUint32(endOfCentralDirectory + 16, true);
  const end = offset + centralDirectorySize;
  while (offset < end && view.getUint32(offset, true) === 0x02014b50) {
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(
      forged.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (pathSet.has(name)) {
      view.setUint32(offset + 16, 0, true);
      const localOffset = view.getUint32(offset + 42, true);
      if (view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error(`fixture has no local entry for ${name}`);
      }
      view.setUint32(localOffset + 14, 0, true);
      pathSet.delete(name);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (pathSet.size > 0) {
    throw new Error(
      `fixture has no central-directory entries for ${[...pathSet].join(", ")}`,
    );
  }
  return forged;
};

Deno.test("Release evidence binds identity and rejects unsafe declarations", async () => {
  assertEquals(
    assetName("123", "2", "fast-unit"),
    "evidence-123-2-fast-unit.zip",
  );
  validateManifest(manifest);
  await assertRejects(() =>
    Promise.resolve().then(() =>
      validateManifest({ ...manifest, runId: "latest" })
    )
  );
  await assertRejects(() =>
    Promise.resolve().then(() =>
      validateManifest({ ...manifest, files: ["../escape"] })
    )
  );
  await assertRejects(() =>
    Promise.resolve().then(() =>
      validateManifest({ ...manifest, files: ["manifest.json"] })
    )
  );
});

Deno.test("archive bounds reject duplicate, oversized, and unsafe entries", async () => {
  await assertRejects(() =>
    Promise.resolve().then(() =>
      validateArchiveEntries([
        { path: "evidence/a", bytes: 1 },
        { path: "evidence/a", bytes: 1 },
      ])
    )
  );
  await assertRejects(() =>
    Promise.resolve().then(() =>
      validateArchiveEntries([
        { path: "evidence/a", bytes: 16 * 1024 * 1024 + 1 },
      ])
    )
  );
  await assertRejects(() =>
    Promise.resolve().then(() =>
      validateArchiveEntries([
        { path: "evidence/../escape", bytes: 1 },
      ])
    )
  );
  assertEquals(MAX_ARCHIVE_BYTES, 64 * 1024 * 1024);
});
Deno.test("bounded lane logs preserve exact identity and digest", async () => {
  const archive = new Uint8Array([1, 2, 3, 4]);
  const log = frameGithubJobLog(await encodeLaneLog(manifest, archive));
  assert(log.startsWith(
    `${GITHUB_LOG_TIMESTAMP} BAKERY_EVIDENCE_BEGIN version=1 `,
  ));
  const reconstructed = await reconstructLaneLog(log, manifest);
  assertEquals([...reconstructed.archive], [...archive]);
  const identityLog = frameGithubJobLog(
    (await encodeLaneLog(manifest, archive)).replace(
      "run_id=123",
      "run_id=124",
    ),
  );
  await assertRejects(
    () => reconstructLaneLog(identityLog, manifest),
    Error,
    "identity mismatch",
  );
  const malformedDigestLog = frameGithubJobLog(
    (await encodeLaneLog(manifest, archive)).replace(
      "sha256=",
      "sha256=0",
    ),
  );
  await assertRejects(
    () => reconstructLaneLog(malformedDigestLog, manifest),
    Error,
    "malformed lane log",
  );
  await assertRejects(
    () =>
      reconstructLaneLog(
        log.replace(GITHUB_LOG_TIMESTAMP, "2026-09-22 17:14:36.0497405Z"),
        manifest,
      ),
    Error,
    "malformed job log framing",
  );
});

Deno.test("lane logs bound each decoded chunk and cumulative archive bytes", async () => {
  const oversizedChunk = new Uint8Array(MAX_LOG_CHUNK_BYTES + 1).fill(1);
  const oversizedDigest = await sha256Hex(oversizedChunk);
  const oversizedLog = frameGithubJobLog([
    `BAKERY_EVIDENCE_BEGIN version=1 run_id=123 run_attempt=2 ` +
    `workflow=${manifest.workflow} candidate=${manifest.candidate} ` +
    `base=${manifest.base} lane=${manifest.lane} ` +
    `archive_bytes=${oversizedChunk.byteLength} chunks=1 sha256=${oversizedDigest}`,
    `BAKERY_EVIDENCE_CHUNK lane=${manifest.lane} index=0 data=${
      base64(oversizedChunk)
    }`,
    `BAKERY_EVIDENCE_END lane=${manifest.lane} chunks=1 sha256=${oversizedDigest}`,
    "",
  ].join("\n"));
  await assertRejects(
    () => reconstructLaneLog(oversizedLog, manifest),
    Error,
    "log archive chunk exceeds byte limit",
  );

  const cumulative = new Uint8Array(
    MAX_LOG_ARCHIVE_BYTES + MAX_LOG_CHUNK_BYTES,
  ).fill(2);
  const cumulativeDigest = await sha256Hex(cumulative);
  const cumulativeChunks = [];
  for (
    let offset = 0, index = 0;
    offset < cumulative.byteLength;
    offset += MAX_LOG_CHUNK_BYTES, index++
  ) {
    cumulativeChunks.push(
      `BAKERY_EVIDENCE_CHUNK lane=${manifest.lane} index=${index} data=${
        base64(cumulative.subarray(offset, offset + MAX_LOG_CHUNK_BYTES))
      }`,
    );
  }
  const cumulativeLog = frameGithubJobLog([
    `BAKERY_EVIDENCE_BEGIN version=1 run_id=123 run_attempt=2 ` +
    `workflow=${manifest.workflow} candidate=${manifest.candidate} ` +
    `base=${manifest.base} lane=${manifest.lane} ` +
    `archive_bytes=${cumulative.byteLength} chunks=${cumulativeChunks.length} ` +
    `sha256=${cumulativeDigest}`,
    ...cumulativeChunks,
    `BAKERY_EVIDENCE_END lane=${manifest.lane} ` +
    `chunks=${cumulativeChunks.length} sha256=${cumulativeDigest}`,
    "",
  ].join("\n"));
  await assertRejects(
    () => reconstructLaneLog(cumulativeLog, manifest),
    Error,
    "log archive exceeds byte limit",
  );

  const maxArchive = new Uint8Array(MAX_LOG_ARCHIVE_BYTES).fill(3);
  const maxReconstructed = await reconstructLaneLog(
    frameGithubJobLog(await encodeLaneLog(manifest, maxArchive)),
    manifest,
  );
  assertEquals(maxReconstructed.archive.byteLength, MAX_LOG_ARCHIVE_BYTES);
  assertEquals(maxReconstructed.archive[0], 3);
  assertEquals(maxReconstructed.archive.at(-1), 3);
});

Deno.test(
  "direct rerun publication reuses matching prior asset and evaluates evidence",
  async () => {
    const root = await Deno.makeTempDir();
    const priorManifest = { ...manifest, runAttempt: "1" };
    const priorArchive = await productionEvidenceArchive(priorManifest);
    const location =
      "https://productionresultssa17.blob.core.windows.net/actions/direct?sig=redacted";
    const priorLog = frameGithubJobLog(
      await encodeLaneLog(priorManifest, priorArchive),
    );
    const policyPath = `${root}/required-checks.json`;
    const jobsPath =
      `/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}/jobs?per_page=100&page=1`;
    await Deno.writeTextFile(
      policyPath,
      JSON.stringify({
        lanes: [{ lane: manifest.lane, job: "fast / focused unit" }],
      }),
    );
    const calls: string[] = [];
    const asset = {
      id: 17,
      name: assetName(
        priorManifest.runId,
        priorManifest.runAttempt,
        priorManifest.lane,
        42,
      ),
      size: priorArchive.byteLength,
      state: "uploaded",
      browser_download_url: "https://github.example/asset/17",
    };
    const api = {
      request: (path: string, init?: RequestInit): Promise<Response> => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === jobsPath) {
          return Promise.resolve(Response.json({
            jobs: [{
              id: 42,
              name: "fast / focused unit",
              conclusion: "success",
            }],
          }));
        }
        if (path === "/actions/jobs/42/logs") {
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location } }),
          );
        }
        if (path === "/releases/tags/ci-evidence") {
          return Promise.resolve(Response.json(release));
        }
        if (path.startsWith("/releases/7/assets?")) {
          return Promise.resolve(Response.json([asset], {
            headers: { link: "" },
          }));
        }
        if (path === "/releases/assets/17") {
          return Promise.resolve(
            new Response(
              priorArchive as unknown as BodyInit,
              {
                headers: { "content-length": String(priorArchive.byteLength) },
              },
            ),
          );
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, _init) => {
      if (String(input) === location) {
        return Promise.resolve(new Response(priorLog));
      }
      throw new Error(`unexpected ${String(input)}`);
    };
    try {
      const completionEnv = {
        GITHUB_REPOSITORY: envValues.GITHUB_REPOSITORY,
        RUN_ID: envValues.RUN_ID,
        RUN_ATTEMPT: envValues.RUN_ATTEMPT,
        WORKFLOW_SHA: envValues.WORKFLOW_SHA,
        CANDIDATE_SHA: undefined,
        BASE_SHA: undefined,
      };
      await withEnvironment(
        {
          CANDIDATE_SHA: "f".repeat(40),
          BASE_SHA: "e".repeat(40),
        },
        async () => {
          await withEnvironment(
            {
              ...completionEnv,
              REQUIRED_CHECKS_POLICY: policyPath,
              EVIDENCE_DIR: `${root}/evidence`,
              ARTIFACT_DIR: `${root}/candidate-artifacts`,
              SCRATCH_DIR: root,
            },
            async () => {
              await publishRunLanes(api);
              assertEquals(
                await evaluateEvidence(
                  `${root}/evidence`,
                  [manifest.lane],
                  manifest.candidate,
                  manifest.base,
                  manifest.workflow,
                  manifest.runId,
                  manifest.runAttempt,
                  dependencies,
                ),
                [],
              );
            },
          );
        },
      );
      assert(calls.includes("GET /releases/assets/17"));
      assert(!calls.some((call) => call.startsWith("POST ")));
      assert(!calls.some((call) => call.startsWith("DELETE ")));
    } finally {
      globalThis.fetch = originalFetch;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "rerun publication ignores a failed prior job asset for a new successful job",
  async () => {
    const root = await Deno.makeTempDir();
    const priorManifest = { ...manifest, runAttempt: "1" };
    const priorArchive = await productionEvidenceArchive(
      priorManifest,
      "failure",
    );
    const currentArchive = await productionEvidenceArchive(manifest);
    const priorLocation =
      "https://productionresultssa17.blob.core.windows.net/actions/prior?sig=redacted";
    const currentLocation =
      "https://productionresultssa17.blob.core.windows.net/actions/current?sig=redacted";
    const currentLog = frameGithubJobLog(
      await encodeLaneLog(manifest, currentArchive),
    );
    const policyPath = `${root}/required-checks.json`;
    const jobsPath =
      `/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}/jobs?per_page=100&page=1`;
    await Deno.writeTextFile(
      policyPath,
      JSON.stringify({
        lanes: [{ lane: manifest.lane, job: "fast / focused unit" }],
      }),
    );
    const calls: string[] = [];
    const priorAsset = {
      id: 17,
      name: assetName(
        priorManifest.runId,
        priorManifest.runAttempt,
        priorManifest.lane,
        41,
      ),
      size: priorArchive.byteLength,
      state: "uploaded",
    };
    const currentAsset = {
      id: 18,
      name: assetName(
        manifest.runId,
        manifest.runAttempt,
        manifest.lane,
        42,
      ),
      size: currentArchive.byteLength,
      state: "uploaded",
      browser_download_url: "https://github.example/asset/18",
    };
    const api = {
      request: (path: string, init?: RequestInit): Promise<Response> => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === jobsPath) {
          return Promise.resolve(Response.json({
            jobs: [{
              id: 42,
              name: "fast / focused unit",
              conclusion: "success",
            }],
          }));
        }
        if (path === "/actions/jobs/42/logs") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: currentLocation },
            }),
          );
        }
        if (path === "/releases/tags/ci-evidence") {
          return Promise.resolve(Response.json(release));
        }
        if (path.startsWith("/releases/7/assets?")) {
          return Promise.resolve(Response.json([priorAsset], {
            headers: { link: "" },
          }));
        }
        if (path.startsWith("https://uploads.github.com/")) {
          return Promise.resolve(Response.json(currentAsset, { status: 201 }));
        }
        if (path === "/releases/assets/18") {
          return Promise.resolve(
            new Response(currentArchive as unknown as BodyInit, {
              headers: { "content-length": String(currentArchive.byteLength) },
            }),
          );
        }
        if (path === "/releases/assets/17") {
          return Promise.resolve(
            new Response(priorArchive as unknown as BodyInit, {
              headers: { "content-length": String(priorArchive.byteLength) },
            }),
          );
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === currentLocation) {
        return Promise.resolve(new Response(currentLog));
      }
      if (String(input) === priorLocation) {
        return Promise.resolve(new Response("failed prior job log"));
      }
      throw new Error(`unexpected ${String(input)}`);
    };
    try {
      await withEnvironment(
        {
          ...envValues,
          REQUIRED_CHECKS_POLICY: policyPath,
          EVIDENCE_DIR: `${root}/evidence`,
          ARTIFACT_DIR: `${root}/candidate-artifacts`,
          SCRATCH_DIR: root,
        },
        async () => {
          await publishRunLanes(api);
          assertEquals(
            await evaluateEvidence(
              `${root}/evidence`,
              [manifest.lane],
              manifest.candidate,
              manifest.base,
              manifest.workflow,
              manifest.runId,
              manifest.runAttempt,
              dependencies,
            ),
            [],
          );
        },
      );
      assert(
        calls.some((call) =>
          call.startsWith("POST https://uploads.github.com/")
        ),
      );
      assert(!calls.includes("GET /releases/assets/17"));
      assert(calls.includes("GET /releases/assets/18"));
    } finally {
      globalThis.fetch = originalFetch;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "immutable publication rejects mismatched existing asset without overwrite",
  async () => {
    const root = await Deno.makeTempDir();
    const storedArchive = new Uint8Array([9, 8, 7]);
    const calls: string[] = [];
    const api = {
      request: (path: string, init?: RequestInit): Promise<Response> => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/releases/tags/ci-evidence") {
          return Promise.resolve(Response.json(release));
        }
        if (path.startsWith("/releases/7/assets?")) {
          return Promise.resolve(Response.json([{
            id: 18,
            name: assetName(manifest.runId, manifest.runAttempt, manifest.lane),
            size: storedArchive.byteLength,
            state: "uploaded",
          }], { headers: { link: "" } }));
        }
        if (path === "/releases/assets/18") {
          return Promise.resolve(
            new Response(
              storedArchive as unknown as BodyInit,
              {
                headers: { "content-length": String(storedArchive.byteLength) },
              },
            ),
          );
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
      },
    };
    try {
      await withEnvironment({ SCRATCH_DIR: root }, async () => {
        await assertRejects(
          () => publishEvidence(api, manifest, new Uint8Array([1, 2, 3])),
          Error,
          "immutable asset content mismatch",
        );
      });
      assert(!calls.some((call) => call.startsWith("POST ")));
      assert(!calls.some((call) => call.startsWith("DELETE ")));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "rerun lane-log validation rejects future and invalid attempts",
  async () => {
    const archive = new Uint8Array([1, 2, 3]);
    const encodedCurrentLog = await encodeLaneLog(manifest, archive);
    const priorManifest = { ...manifest, runAttempt: "1" };
    const priorLog = frameGithubJobLog(
      await encodeLaneLog(priorManifest, archive),
    );
    const prior = await reconstructLaneLog(priorLog, manifest);
    assertEquals(prior.identity.runAttempt, "1");
    const identityMismatch = "release evidence: lane log identity mismatch";
    for (const attempt of ["3", "0", "not-an-attempt"]) {
      const invalidLog = frameGithubJobLog(
        encodedCurrentLog.replace(
          `run_attempt=${manifest.runAttempt}`,
          `run_attempt=${attempt}`,
        ),
      );
      const error = await assertRejects(
        () => reconstructLaneLog(invalidLog, manifest),
        Error,
        identityMismatch,
      );
      assertEquals(error.message, identityMismatch, `run_attempt=${attempt}`);
    }
    const encodedPriorLog = await encodeLaneLog(priorManifest, archive);
    const priorIdentityMutations = [
      {
        field: "runId",
        marker: `run_id=${manifest.runId}`,
        replacement: "run_id=124",
      },
      {
        field: "workflow",
        marker: `workflow=${manifest.workflow}`,
        replacement: `workflow=${"x".repeat(40)}`,
      },
      {
        field: "candidate",
        marker: `candidate=${manifest.candidate}`,
        replacement: `candidate=${"c".repeat(40)}`,
      },
      {
        field: "base",
        marker: `base=${manifest.base}`,
        replacement: `base=${"d".repeat(40)}`,
      },
      {
        field: "lane",
        marker: `lane=${manifest.lane} archive_bytes`,
        replacement: "lane=slow-unit archive_bytes",
      },
    ] as const;
    for (const { field, marker, replacement } of priorIdentityMutations) {
      const invalidLog = frameGithubJobLog(
        encodedPriorLog.replace(marker, replacement),
      );
      const error = await assertRejects(
        () => reconstructLaneLog(invalidLog, manifest),
        Error,
        identityMismatch,
      );
      assertEquals(error.message, identityMismatch, field);
    }
  },
);
Deno.test("trusted verdict preserves identity on acquisition failure", async () => {
  const root = await Deno.makeTempDir();
  const policyPath = `${root}/required-checks.json`;
  const outputPath = `${root}/github-output`;
  await Deno.writeTextFile(
    policyPath,
    JSON.stringify({
      workflow: "Bakery connected/native",
      workflowPath: ".github/workflows/backend-connected-native.yml",
      aggregateJob: "connected/native preflight",
      dependencies,
      lanes: [{
        lane: manifest.lane,
        job: "fast / focused unit",
        artifacts: [],
      }],
    }),
  );
  const api = {
    request: (): Promise<Response> => {
      throw new Error("synthetic acquisition failure");
    },
  };
  try {
    await withEnvironment(
      {
        ...envValues,
        REQUIRED_CHECKS_POLICY: policyPath,
        EVIDENCE_DIR: `${root}/evidence`,
        ARTIFACT_DIR: `${root}/candidate-artifacts`,
        SCRATCH_DIR: root,
        LANE_FAST_UNIT: "success",
        PUBLISH_EVIDENCE: "false",
      },
      async () => await verifyRunLanesOutput(api, outputPath),
    );
    const line = await Deno.readTextFile(outputPath);
    const verdict = JSON.parse(line.slice("verdict=".length).trim());
    assertEquals(verdict.version, 1);
    assertEquals(verdict.status, "failure");
    assertEquals(verdict.repository, envValues.GITHUB_REPOSITORY);
    assertEquals(verdict.runId, envValues.RUN_ID);
    assert(verdict.failures[0].includes("synthetic acquisition failure"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test(
  "verifyRunLanesOutput rejects a cross-lane replacement after a connected failure",
  async () => {
    const root = await Deno.makeTempDir();
    const policyPath = `${root}/required-checks.json`;
    const outputPath = `${root}/github-output`;
    const nativeArchiveManifest: Manifest = {
      ...manifest,
      lane: "native",
      files: ["evidence/connected.txt"],
    };
    const nativeLogManifest: Manifest = {
      ...manifest,
      lane: "native",
      files: ["evidence/native.txt"],
    };
    const nativeArchive = await zipFixture(nativeArchiveManifest, {
      evidenceText: "replacement evidence\n",
    });
    const nativeLocation =
      "https://productionresultssa17.blob.core.windows.net/actions/native?sig=redacted";
    const jobsPath =
      `/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}/jobs?per_page=100&page=1`;
    const api = {
      request: (path: string): Promise<Response> => {
        if (path === jobsPath) {
          return Promise.resolve(Response.json({
            jobs: [
              {
                id: 41,
                name: "connected provider prerequisites",
                conclusion: "failure",
              },
              {
                id: 42,
                name: "native runner prerequisites",
                conclusion: "success",
              },
            ],
          }));
        }
        if (path === "/actions/jobs/42/logs") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: nativeLocation },
            }),
          );
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    await Deno.writeTextFile(
      policyPath,
      JSON.stringify({
        workflow: "Bakery connected/native",
        workflowPath: ".github/workflows/backend-connected-native.yml",
        aggregateJob: "connected/native preflight",
        dependencies,
        lanes: [
          {
            lane: "connected",
            job: "connected provider prerequisites",
            artifacts: [],
          },
          {
            lane: "native",
            job: "native runner prerequisites",
            artifacts: [],
          },
        ],
      }),
    );
    await Deno.mkdir(`${root}/evidence`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/evidence/connected.txt`,
      "pre-existing connected evidence\n",
    );
    const nativeLog = frameGithubJobLog(
      await encodeLaneLog(nativeLogManifest, nativeArchive),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      if (String(input) === nativeLocation) {
        return Promise.resolve(new Response(nativeLog));
      }
      throw new Error(`unexpected ${String(input)}`);
    };
    try {
      await withEnvironment(
        {
          ...envValues,
          REQUIRED_CHECKS_POLICY: policyPath,
          EVIDENCE_DIR: `${root}/evidence`,
          ARTIFACT_DIR: `${root}/candidate-artifacts`,
          SCRATCH_DIR: root,
          LANE_CONNECTED: "failure",
          LANE_NATIVE: "success",
          PUBLISH_EVIDENCE: "false",
        },
        async () => await verifyRunLanesOutput(api, outputPath),
      );
      const verdict = JSON.parse(
        (await Deno.readTextFile(outputPath)).slice("verdict=".length).trim(),
      );
      assertEquals(verdict.status, "failure");
      assert(
        verdict.failures.some((failure: string) =>
          failure.includes("evidence destination is not owned by native")
        ),
      );
      assertEquals(
        await Deno.readTextFile(`${root}/evidence/connected.txt`),
        "pre-existing connected evidence\n",
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "verifyRunLanesOutput rejects duplicate policy destinations before committing",
  async () => {
    const root = await Deno.makeTempDir();
    const policyPath = `${root}/required-checks.json`;
    const outputPath = `${root}/github-output`;
    const connectedManifest: Manifest = {
      ...manifest,
      lane: "connected",
      files: ["evidence/connected.txt", "candidate-artifacts/shared.json"],
    };
    const nativeManifest: Manifest = {
      ...manifest,
      lane: "native",
      files: ["evidence/native.txt", "candidate-artifacts/shared.json"],
    };
    const connectedArchive = await zipFixture(connectedManifest, {
      extraFiles: ["candidate-artifacts/shared.json"],
      extraFileText: "connected artifact\n",
    });
    const nativeArchive = await zipFixture(nativeManifest, {
      extraFiles: ["candidate-artifacts/shared.json"],
      extraFileText: "native artifact\n",
    });
    const locations = {
      connected:
        "https://productionresultssa17.blob.core.windows.net/actions/connected?sig=redacted",
      native:
        "https://productionresultssa17.blob.core.windows.net/actions/native?sig=redacted",
    };
    const jobsPath =
      `/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}/jobs?per_page=100&page=1`;
    const api = {
      request: (path: string): Promise<Response> => {
        if (path === jobsPath) {
          return Promise.resolve(Response.json({
            jobs: [
              {
                id: 51,
                name: "connected provider prerequisites",
                conclusion: "success",
              },
              {
                id: 52,
                name: "native runner prerequisites",
                conclusion: "success",
              },
            ],
          }));
        }
        if (path === "/actions/jobs/51/logs") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: locations.connected },
            }),
          );
        }
        if (path === "/actions/jobs/52/logs") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: locations.native },
            }),
          );
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    await Deno.writeTextFile(
      policyPath,
      JSON.stringify({
        workflow: "Bakery connected/native",
        workflowPath: ".github/workflows/backend-connected-native.yml",
        aggregateJob: "connected/native preflight",
        dependencies,
        lanes: [
          {
            lane: "connected",
            job: "connected provider prerequisites",
            artifacts: [{ path: "shared.json", verify: "runtime-manifest" }],
          },
          {
            lane: "native",
            job: "native runner prerequisites",
            artifacts: [{ path: "shared.json", verify: "runtime-manifest" }],
          },
        ],
      }),
    );
    const connectedLog = frameGithubJobLog(
      await encodeLaneLog(connectedManifest, connectedArchive),
    );
    const nativeLog = frameGithubJobLog(
      await encodeLaneLog(nativeManifest, nativeArchive),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const location = String(input);
      if (location === locations.connected) {
        return Promise.resolve(new Response(connectedLog));
      }
      if (location === locations.native) {
        return Promise.resolve(new Response(nativeLog));
      }
      throw new Error(`unexpected ${location}`);
    };
    try {
      await withEnvironment(
        {
          ...envValues,
          REQUIRED_CHECKS_POLICY: policyPath,
          EVIDENCE_DIR: `${root}/evidence`,
          ARTIFACT_DIR: `${root}/candidate-artifacts`,
          SCRATCH_DIR: root,
          LANE_CONNECTED: "success",
          LANE_NATIVE: "success",
          PUBLISH_EVIDENCE: "false",
        },
        async () => await verifyRunLanesOutput(api, outputPath),
      );
      const verdict = JSON.parse(
        (await Deno.readTextFile(outputPath)).slice("verdict=".length).trim(),
      );
      assertEquals(verdict.status, "failure");
      assert(
        verdict.failures.some((failure: string) =>
          failure.includes("duplicate archive destination")
        ),
      );
      await assertRejects(() => Deno.stat(`${root}/evidence/connected.txt`));
      await assertRejects(() => Deno.stat(`${root}/evidence/native.txt`));
      await assertRejects(
        () => Deno.stat(`${root}/candidate-artifacts/shared.json`),
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "run lanes reject artifact destinations absent from policy",
  async () => {
    const root = await Deno.makeTempDir();
    const archiveManifest: Manifest = {
      ...manifest,
      lane: "native",
      files: [
        "evidence/native.txt",
        "candidate-artifacts/undeclared.json",
      ],
    };
    try {
      const verdict = await verifyLaneArchiveFixtures(root, [{
        lane: "native",
        job: "native runner prerequisites",
        manifest: archiveManifest,
        archive: await zipFixture(archiveManifest, {
          extraFiles: ["candidate-artifacts/undeclared.json"],
        }),
        artifactPaths: [],
      }]);
      assertEquals(verdict.status, "failure");
      assert(
        verdict.failures.some((failure) =>
          failure.includes("manifest destinations are not policy-declared")
        ),
      );
      await assertRejects(() => Deno.stat(`${root}/evidence/native.txt`));
      await assertRejects(
        () => Deno.stat(`${root}/candidate-artifacts/undeclared.json`),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "run lanes reject nested cross-lane destinations before committing",
  async () => {
    const root = await Deno.makeTempDir();
    const connectedManifest: Manifest = {
      ...manifest,
      lane: "connected",
      files: [
        "evidence/connected.txt",
        "candidate-artifacts/shared",
      ],
    };
    const nativeManifest: Manifest = {
      ...manifest,
      lane: "native",
      files: [
        "evidence/native.txt",
        "candidate-artifacts/shared/child.json",
      ],
    };
    try {
      const verdict = await verifyLaneArchiveFixtures(root, [
        {
          lane: "connected",
          job: "connected provider prerequisites",
          manifest: connectedManifest,
          archive: await zipFixture(connectedManifest, {
            extraFiles: ["candidate-artifacts/shared"],
          }),
          artifactPaths: ["shared"],
        },
        {
          lane: "native",
          job: "native runner prerequisites",
          manifest: nativeManifest,
          archive: await zipFixture(nativeManifest, {
            extraFiles: ["candidate-artifacts/shared/child.json"],
          }),
          artifactPaths: ["shared/child.json"],
        },
      ]);
      assertEquals(verdict.status, "failure");
      assert(
        verdict.failures.some((failure) =>
          failure.includes("conflicting archive destinations")
        ),
      );
      await assertRejects(() => Deno.stat(`${root}/evidence/connected.txt`));
      await assertRejects(() => Deno.stat(`${root}/evidence/native.txt`));
      await assertRejects(
        () => Deno.stat(`${root}/candidate-artifacts/shared`),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test("ZIP directory entries are counted before metadata buffering", async () => {
  const archive = await zipFixture(manifest, { directoryCount: MAX_FILES });
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        fetchEvidence(
          {
            request: (): Promise<Response> =>
              Promise.resolve(new Response(archive as unknown as BodyInit)),
          },
          9,
          manifest,
          `${root}/evidence`,
          `${root}/artifacts`,
        ),
      Error,
      "too many archive entries",
    );
    await assertRejects(() => Deno.stat(`${root}/evidence/fast-unit.txt`));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("verbose ZIP metadata is bounded before type inspection", async () => {
  const archive = await zipFixture(manifest, {
    directoryCount: 500,
    directoryNameLength: 240,
  });
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        fetchEvidence(
          {
            request: (): Promise<Response> =>
              Promise.resolve(new Response(archive as unknown as BodyInit)),
          },
          9,
          manifest,
          `${root}/evidence`,
          `${root}/artifacts`,
        ),
      Error,
      "archive metadata exceeds byte limit",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test(
  "candidate archives reject wildcard members before unzip can deadlock",
  async () => {
    const wildcard = "candidate-artifacts/*";
    const artifactNames = Array.from(
      { length: 60 },
      (_, index) => {
        const parts = [
          `${String(index).padStart(2, "0")}-${"x".repeat(235)}`,
          ...Array.from({ length: 4 }, () => "x".repeat(235)),
        ];
        return `candidate-artifacts/${parts.join("/")}`;
      },
    );
    const corruptPaths = [wildcard, ...artifactNames];
    const archive = forgeEntryCrc(
      await zipFixture(manifest, {
        extraFiles: corruptPaths,
        extraFileText: "x".repeat(1520),
      }),
      corruptPaths,
    );
    const root = await Deno.makeTempDir();
    let timeout!: NodeJS.Timeout;
    let extractionOutcome!: {
      kind: "resolved";
    } | {
      kind: "rejected";
      error: unknown;
    };
    try {
      const result = await Promise.race([
        withEnvironment({ SCRATCH_DIR: root }, async () => {
          try {
            await fetchEvidence(
              {
                request: (): Promise<Response> =>
                  Promise.resolve(new Response(archive as unknown as BodyInit)),
              },
              9,
              manifest,
              `${root}/evidence`,
              `${root}/artifacts`,
            );
            extractionOutcome = { kind: "resolved" };
          } catch (error) {
            extractionOutcome = { kind: "rejected", error };
          }
        }).then(() => extractionOutcome),
        new Promise<{ kind: "timed-out" }>((resolve) => {
          timeout = setTimeout(
            () => resolve({ kind: "timed-out" }),
            2_000,
          );
        }),
      ]);
      assertEquals(result.kind, "rejected");
      if (result.kind === "rejected") {
        assert(result.error instanceof Error);
        assert(result.error.message.includes("invalid archive entry"));
      }
    } finally {
      clearTimeout(timeout);
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test("GitHub transport rejects untrusted request origins", async () => {
  assertEquals(
    githubRequestUrl("owner/repo", "/releases/7/assets"),
    "https://api.github.com/repos/owner/repo/releases/7/assets",
  );
  const uploadUrl =
    "https://uploads.github.com/repos/owner/repo/releases/7/assets?name=asset";
  assertEquals(githubRequestUrl("owner/repo", uploadUrl), uploadUrl);
  await assertRejects(() =>
    Promise.resolve().then(() =>
      githubRequestUrl("owner/repo", "https://uploads.example/assets")
    )
  );
  await assertRejects(() =>
    Promise.resolve().then(() =>
      githubRequestUrl(
        "owner/repo",
        "https://user:pass@uploads.github.com/assets",
      )
    )
  );
  assertEquals(
    githubRequestUrl("owner/repo", "https://api.github.com/releases"),
    "https://api.github.com/releases",
  );
});

Deno.test(
  "GitHub job-log redirects allow the Azure host family and reject near matches",
  async () => {
    for (const shard of ["6", "17", "18"]) {
      const location =
        `https://productionresultssa${shard}.blob.core.windows.net/actions/log?sig=redacted`;
      assertEquals(validateLogRedirect(location), location);
    }
    for (
      const unsafe of [
        "http://productionresultssa17.blob.core.windows.net/actions/log",
        "https://productionresultssa17.blob.core.windows.net.evil.example/actions/log",
        "https://productionresultssa.blob.core.windows.net/actions/log",
        "https://productionresultssaX.blob.core.windows.net/actions/log",
        "https://productionresultssa17x.blob.core.windows.net/actions/log",
        "https://productionresultssa17.blob.core.windows.net/actions/log",
        "https://productionresultssa17.blob.core.windows.net/actions/log?sig=",
        "https://productionresultssa17.blob.core.windows.net@evil.example/actions/log",
        "https://user:pass@productionresultssa17.blob.core.windows.net/actions/log",
      ]
    ) {
      await assertRejects(
        () => Promise.resolve().then(() => validateLogRedirect(unsafe)),
        Error,
        "unsafe job log redirect",
      );
    }
  },
);

Deno.test("job-log redirects omit credentials and preserve body bounds", async () => {
  const location =
    "https://productionresultssa17.blob.core.windows.net/actions/log?sig=redacted";
  const originalFetch = globalThis.fetch;
  let redirectedInit: RequestInit | undefined;
  let fetchCount = 0;
  globalThis.fetch = (_input, init) => {
    fetchCount++;
    redirectedInit = init;
    if (fetchCount === 1) {
      return Promise.resolve(
        new Response(
          "unrelated line\n" +
            "2026-01-01T00:00:00.0000000Z BAKERY_EVIDENCE_BEGIN sample\n",
        ),
      );
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_JOB_LOG_BYTES + 1));
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream));
  };
  try {
    assertEquals(
      await downloadJobLog(location),
      "2026-01-01T00:00:00.0000000Z BAKERY_EVIDENCE_BEGIN sample\n",
    );
    assertEquals(redirectedInit, {
      credentials: "omit",
      redirect: "error",
    });
    await assertRejects(
      () => downloadJobLog(location),
      Error,
      "job log exceeds byte limit",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test(
  "production GitHub job-log flow separates API acquisition from Azure download",
  async () => {
    const location =
      "https://productionresultssa18.blob.core.windows.net/actions/log?sig=redacted";
    const originalFetch = globalThis.fetch;
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        calls.length === 1
          ? new Response(null, { status: 302, headers: { location } })
          : new Response("real job log"),
      );
    };
    try {
      await withEnvironment(
        {
          GITHUB_TOKEN: "token",
          GITHUB_REPOSITORY: "owner/repo",
        },
        async () => {
          const api = githubApiFromEnv();
          const acquired = await api.request(
            "/actions/jobs/106883227617/logs",
            { redirect: "manual" },
          );
          assertEquals(acquired.status, 302);
          assertEquals(await downloadJobLog(location), "");
        },
      );
      assertEquals(calls.length, 2);
      assertEquals(
        calls[0].input,
        "https://api.github.com/repos/owner/repo/actions/jobs/106883227617/logs",
      );
      assertEquals(calls[0].init?.redirect, "manual");
      assertEquals(
        new Headers(calls[0].init?.headers).get("authorization"),
        "Bearer token",
      );
      assertEquals(calls[1].input, location);
      assertEquals(calls[1].init, {
        credentials: "omit",
        redirect: "error",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("asset lookup follows pagination and release creation retries a tag race", async () => {
  const calls: string[] = [];
  let tagLookups = 0;
  const api = {
    request: (path: string, init?: RequestInit): Promise<Response> =>
      Promise.resolve().then(() => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/releases/tags/ci-evidence") {
          tagLookups++;
          return tagLookups === 1
            ? new Response(null, { status: 404 })
            : Response.json(release);
        }
        if (path === "/releases" && init?.method === "POST") {
          return new Response(null, { status: 422 });
        }
        const page = new URL(path, "https://api.github.com").searchParams.get(
          "page",
        );
        if (page === "1") {
          return Response.json([{ id: 1, name: "other.zip", size: 1 }], {
            headers: {
              link:
                '<https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=2>; rel="next"',
            },
          });
        }
        if (page === "2") {
          return Response.json([{ id: 11, name: "target.zip", size: 2 }]);
        }
        throw new Error(`unexpected ${path}`);
      }),
  };
  assertEquals((await getOrCreateRelease(api)).id, 7);
  assertEquals((await findAsset(api, 7, "target.zip"))?.id, 11);
  assertEquals(
    calls.filter((call) => call.includes("/releases/tags/ci-evidence")).length,
    2,
  );
  assertEquals(
    calls.filter((call) => call.includes("/releases/7/assets")),
    [
      "GET /releases/7/assets?per_page=100&page=1",
      "GET https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=2",
    ],
  );
});

Deno.test("publication asset lookup keeps its pagination ceiling", async () => {
  const api = {
    request: (path: string): Promise<Response> => {
      const page = Number(
        new URL(path, "https://api.github.com").searchParams.get("page"),
      );
      return Promise.resolve(
        Response.json([], {
          headers: {
            link:
              `<https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=${
                page + 1
              }>; rel="next"`,
          },
        }),
      );
    },
  };
  await assertRejects(
    () => findAsset(api, 7, "missing.zip"),
    Error,
    "asset pagination limit exceeded",
  );
});

Deno.test("failed upload removes the partial Release asset", async () => {
  const state: FakeState = {
    release: true,
    assets: [],
    archive: null,
    calls: [],
    nextUploadStatus: 502,
    partialUploadId: 99,
  };
  await assertRejects(() =>
    publishEvidence(fakeApi(state), manifest, new Uint8Array([1, 2]))
  );
  assert(state.calls.includes("DELETE /releases/assets/99"));
  assertEquals(state.assets, []);
});

Deno.test("ZIP symlinks are rejected before extraction and oversized streams are bounded", async () => {
  const symlinkArchive = await zipFixture(manifest, { symlink: true });
  const symlinkApi = {
    request: (): Promise<Response> =>
      Promise.resolve(new Response(symlinkArchive as unknown as BodyInit)),
  };
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        fetchEvidence(
          symlinkApi,
          9,
          manifest,
          `${root}/evidence`,
          `${root}/artifacts`,
        ),
      Error,
      "regular file",
    );
    const oversizedApi = {
      request: (): Promise<Response> =>
        Promise.resolve(
          new Response(new Uint8Array([1]), {
            headers: { "content-length": String(MAX_ARCHIVE_BYTES + 1) },
          }),
        ),
    };
    await assertRejects(
      () =>
        fetchEvidence(
          oversizedApi,
          9,
          manifest,
          `${root}/evidence-oversized`,
          `${root}/artifacts-oversized`,
        ),
      Error,
      "exceeds byte limit",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("forged central-directory sizes are rejected before extraction writes", async () => {
  const archive = forgeCentralDirectorySize(
    await zipFixture(manifest),
    "evidence/fast-unit.txt",
    1,
  );
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        fetchEvidence(
          {
            request: (): Promise<Response> =>
              Promise.resolve(new Response(archive as unknown as BodyInit)),
          },
          9,
          manifest,
          `${root}/evidence`,
          `${root}/artifacts`,
        ),
      Error,
      "byte count mismatch",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("retention prunes old inactive assets and protects active runs", async () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  let assets = [
    {
      id: 11,
      name: "evidence-11-1-fast-unit.zip",
      size: 1,
      created_at: new Date(now - SUCCESS_RETENTION_MS - 1).toISOString(),
    },
    {
      id: 22,
      name: "evidence-22-1-fast-unit.zip",
      size: 1,
      created_at: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 33,
      name: "evidence-33-1-fast-unit.zip",
      size: 1,
      created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
  const api = {
    request: (path: string, init?: RequestInit): Promise<Response> =>
      Promise.resolve().then(() => {
        if (path === "/releases/tags/ci-evidence") {
          return Response.json(release);
        }
        if (path.startsWith("/releases/7/assets?")) {
          return Response.json(assets);
        }
        if (path.startsWith("/actions/runs?")) {
          const status = new URL(
            path,
            "https://api.github.com",
          ).searchParams.get("status");
          return Response.json({
            workflow_runs: status === "in_progress"
              ? [{ id: 22, status, conclusion: null }]
              : [],
          });
        }
        if (path === "/actions/runs/11") {
          return Response.json({
            id: 11,
            status: "completed",
            conclusion: "success",
          });
        }
        if (init?.method === "DELETE" && path.startsWith("/releases/assets/")) {
          const id = Number(path.split("/").pop());
          assets = assets.filter((asset) => asset.id !== id);
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
      }),
  };
  assertEquals(await pruneReleaseAssets(api, now), {
    before: 3,
    after: 2,
    deleted: 1,
    protectedActive: 1,
    classificationComplete: true,
    unclassified: 0,
  });
  assertEquals(assets.map((asset) => asset.id), [22, 33]);
});

Deno.test(
  "retention continues past a fresh endpoint after protecting an old active asset",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const dayMs = 24 * 60 * 60 * 1000;
    let assets = [
      {
        id: 9101,
        name: "evidence-9101-1-fast-unit.zip",
        size: 1,
        created_at: new Date(now - 9 * dayMs).toISOString(),
      },
      {
        id: 9102,
        name: "evidence-9102-1-fast-unit.zip",
        size: 1,
        created_at: new Date(now - 8 * dayMs).toISOString(),
      },
      {
        id: 9103,
        name: "evidence-9103-1-fast-unit.zip",
        size: 1,
        created_at: new Date(now - dayMs).toISOString(),
      },
    ];
    const requests: string[] = [];
    const api = {
      request: (path: string, init?: RequestInit): Promise<Response> => {
        requests.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/releases/tags/ci-evidence") {
          return Promise.resolve(Response.json(release));
        }
        if (path.startsWith("/releases/7/assets?")) {
          return Promise.resolve(Response.json(assets));
        }
        if (path.startsWith("/actions/runs?")) {
          const status = new URL(
            path,
            "https://api.github.com",
          ).searchParams.get("status");
          return Promise.resolve(Response.json({
            workflow_runs: status === "waiting"
              ? [{ id: 9101, status, conclusion: null }]
              : [],
          }));
        }
        if (path === "/actions/runs/9102") {
          return Promise.resolve(Response.json({
            id: 9102,
            status: "completed",
            conclusion: "failure",
          }));
        }
        if (path === "/actions/runs/9103") {
          return Promise.resolve(Response.json({
            id: 9103,
            status: "completed",
            conclusion: "success",
          }));
        }
        if (init?.method === "DELETE" && path === "/releases/assets/9102") {
          assets = assets.filter((asset) => asset.id !== 9102);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.reject(
          new Error(`unexpected ${init?.method ?? "GET"} ${path}`),
        );
      },
    };

    assertEquals(await pruneReleaseAssets(api, now), {
      before: 3,
      after: 2,
      deleted: 1,
      protectedActive: 1,
      classificationComplete: true,
      unclassified: 0,
    });
    assertEquals(assets.map((asset) => asset.id), [9101, 9103]);
    assert(requests.includes("GET /actions/runs/9102"));
    assert(requests.includes("DELETE /releases/assets/9102"));
    assert(!requests.includes("GET /actions/runs/9103"));
  },
);

Deno.test(
  "retention continues past a fresh endpoint to reach an expired inactive middle asset",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const dayMs = 24 * 60 * 60 * 1000;
    let assets = [
      {
        id: 9201,
        name: "evidence-9201-1-fast-unit.zip",
        size: 1,
        created_at: new Date(now - 60 * dayMs).toISOString(),
      },
      {
        id: 9202,
        name: "evidence-9202-1-fast-unit.zip",
        size: 1,
        created_at: new Date(now - 60 * dayMs).toISOString(),
      },
      {
        id: 9203,
        name: "evidence-9203-1-fast-unit.zip",
        size: 1,
        created_at: new Date(now - dayMs).toISOString(),
      },
    ];
    const requests: string[] = [];
    const api = {
      request: (path: string, init?: RequestInit): Promise<Response> => {
        requests.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/releases/tags/ci-evidence") {
          return Promise.resolve(Response.json(release));
        }
        if (path.startsWith("/releases/7/assets?")) {
          return Promise.resolve(Response.json(assets));
        }
        if (path.startsWith("/actions/runs?")) {
          return Promise.resolve(Response.json({ workflow_runs: [] }));
        }
        if (path === "/actions/runs/9201" || path === "/actions/runs/9202") {
          return Promise.resolve(Response.json({
            id: Number(path.split("/").pop()),
            status: "completed",
            conclusion: "success",
          }));
        }
        if (init?.method === "DELETE" && path.startsWith("/releases/assets/")) {
          const id = Number(path.split("/").pop());
          assets = assets.filter((asset) => asset.id !== id);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.reject(
          new Error(`unexpected ${init?.method ?? "GET"} ${path}`),
        );
      },
    };

    assertEquals(await pruneReleaseAssets(api, now), {
      before: 3,
      after: 1,
      deleted: 2,
      protectedActive: 0,
      classificationComplete: true,
      unclassified: 0,
    });
    assertEquals(assets.map((asset) => asset.id), [9203]);
    assert(requests.includes("DELETE /releases/assets/9202"));
    assert(!requests.includes("GET /actions/runs/9203"));
  },
);

Deno.test(
  "retention converges a platform-max inventory under its request budget",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const freshCreatedAt = new Date(now - 1).toISOString();
    let assets = Array.from(
      { length: MAX_RELEASE_ASSETS * 2 },
      (_, index) => ({
        id: index + 1,
        name: `evidence-${index + 1}-1-fast-unit.zip`,
        size: 1,
        created_at: freshCreatedAt,
      }),
    );
    let calls = 0;
    const requestCounts: number[] = [];
    const api = {
      request: (path: string, init?: RequestInit): Promise<Response> => {
        calls++;
        return Promise.resolve().then(() => {
          if (path === "/releases/tags/ci-evidence") {
            return Response.json(release);
          }
          if (path.includes("/releases/7/assets?")) {
            const page = Number(
              new URL(path, "https://api.github.com").searchParams.get("page"),
            );
            const start = (page - 1) * 100;
            const pageAssets = assets.slice(start, start + 100);
            const headers: Record<string, string> = {};
            if (start + 100 < assets.length) {
              headers.link =
                `<https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=${
                  page + 1
                }>; rel="next"`;
            }
            return Response.json(pageAssets, { headers });
          }
          if (path.startsWith("/actions/runs?")) {
            return Response.json({ workflow_runs: [] });
          }
          if (path.startsWith("/actions/runs/")) {
            return Response.json({
              id: Number(path.split("/").pop()),
              status: "completed",
              conclusion: "success",
            });
          }
          if (
            init?.method === "DELETE" && path.startsWith("/releases/assets/")
          ) {
            const id = Number(path.split("/").pop());
            assets = assets.filter((asset) => asset.id !== id);
            return new Response(null, { status: 204 });
          }
          throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
        });
      },
    };

    while (assets.length > MAX_RELEASE_ASSETS) {
      const callsBefore = calls;
      const summary = await pruneReleaseAssets(api, now);
      const requestCount = calls - callsBefore;
      requestCounts.push(requestCount);
      assert(summary.deleted > 0);
      assert(requestCount < MAX_RETENTION_API_REQUESTS);
    }

    assertEquals(assets.length, MAX_RELEASE_ASSETS);
    assertEquals(
      await pruneReleaseAssets(api, now),
      {
        before: MAX_RELEASE_ASSETS,
        after: MAX_RELEASE_ASSETS,
        deleted: 0,
        protectedActive: 0,
        classificationComplete: true,
        unclassified: 0,
      },
    );
    assert(requestCounts.every((count) => count < MAX_RETENTION_API_REQUESTS));
  },
);
type RetentionAssetFixture = {
  id: number;
  name: string;
  size: number;
  created_at: string;
};

const paginatedRetentionApi = (
  assets: RetentionAssetFixture[],
  activeRunIds: ReadonlySet<number>,
  onRequest?: (path: string, init?: RequestInit) => void,
  activeRunStatuses: ReadonlyMap<number, string> = new Map(),
) => ({
  request: (path: string, init?: RequestInit): Promise<Response> => {
    onRequest?.(path, init);
    return Promise.resolve().then(() => {
      if (path === "/releases/tags/ci-evidence") {
        return Response.json(release);
      }
      if (path.includes("/releases/7/assets?")) {
        const page = Number(
          new URL(path, "https://api.github.com").searchParams.get("page"),
        );
        const start = (page - 1) * 100;
        const pageAssets = assets.slice(start, start + 100);
        const headers: Record<string, string> = {};
        if (start + 100 < assets.length) {
          headers.link =
            `<https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=${
              page + 1
            }>; rel="next"`;
        }
        return Response.json(pageAssets, { headers });
      }
      if (path.includes("/actions/runs?")) {
        const url = new URL(path, "https://api.github.com");
        const status = url.searchParams.get("status");
        const runs = [...activeRunIds]
          .filter((runId) =>
            (activeRunStatuses.get(runId) ?? "in_progress") === status
          )
          .map((runId) => ({
            id: runId,
            status,
            conclusion: null,
          }));
        const page = Number(url.searchParams.get("page"));
        const start = (page - 1) * 100;
        const headers: Record<string, string> = {};
        if (start + 100 < runs.length) {
          headers.link =
            `<https://api.github.com/repos/owner/repo/actions/runs?status=${
              status ?? ""
            }&per_page=100&page=${page + 1}>; rel="next"`;
        }
        return Response.json({
          workflow_runs: runs.slice(start, start + 100),
        }, { headers });
      }
      if (path.startsWith("/actions/runs/")) {
        const runId = Number(path.split("/").pop());
        return activeRunIds.has(runId)
          ? Response.json({
            id: runId,
            status: activeRunStatuses.get(runId) ?? "in_progress",
            conclusion: null,
          })
          : Response.json({
            id: runId,
            status: "completed",
            conclusion: "success",
          });
      }
      if (init?.method === "DELETE" && path.startsWith("/releases/assets/")) {
        const id = Number(path.split("/").pop());
        const index = assets.findIndex((asset) => asset.id === id);
        if (index >= 0) assets.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    });
  },
});

Deno.test(
  "retention preserves active assets in a platform-max mixed inventory",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const freshCreatedAt = new Date(now - 1).toISOString();
    const assets = Array.from(
      { length: MAX_RELEASE_ASSETS * 2 },
      (_, index) => ({
        id: index + 1,
        name: `evidence-${index + 1}-1-fast-unit.zip`,
        size: 1,
        created_at: freshCreatedAt,
      }),
    );
    const activeRunIds = new Set(
      Array.from(
        { length: MAX_RELEASE_ASSETS },
        (_, index) => index + 1,
      ),
    );
    let calls = 0;
    const api = paginatedRetentionApi(assets, activeRunIds, () => calls++);
    const summaries: ReleasePruneSummary[] = [];

    while (assets.length > MAX_RELEASE_ASSETS) {
      const callsBefore = calls;
      const summary = await pruneReleaseAssets(api, now);
      summaries.push(summary);
      assert(summary.deleted > 0);
      assert(calls - callsBefore < MAX_RETENTION_API_REQUESTS);
    }

    assertEquals(assets.length, MAX_RELEASE_ASSETS);
    const lastSummary = summaries.at(-1);
    assert(lastSummary);
    assertEquals(lastSummary.after, MAX_RELEASE_ASSETS);
    assertEquals(lastSummary.classificationComplete, true);
    assertEquals(lastSummary.unclassified, 0);
    assertEquals(lastSummary.protectedActive, MAX_RELEASE_ASSETS);
    assertEquals(
      assets.filter((asset) =>
        activeRunIds.has(Number(asset.name.split("-")[1]))
      ).length,
      MAX_RELEASE_ASSETS,
    );
    const callsBeforeNoOp = calls;
    assertEquals(await pruneReleaseAssets(api, now), {
      before: MAX_RELEASE_ASSETS,
      after: MAX_RELEASE_ASSETS,
      deleted: 0,
      protectedActive: MAX_RELEASE_ASSETS,
      classificationComplete: true,
      unclassified: 0,
    });
    assert(calls - callsBeforeNoOp < MAX_RETENTION_API_REQUESTS);
  },
);
Deno.test(
  "retention reaches inactive middle assets between active endpoint runs",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const freshCreatedAt = new Date(now - 1).toISOString();
    const assets = Array.from(
      { length: MAX_RELEASE_ASSETS * 2 },
      (_, index) => ({
        id: index + 1,
        name: `evidence-${index + 1}-1-fast-unit.zip`,
        size: 1,
        created_at: freshCreatedAt,
      }),
    );
    const activeRunIds = new Set<number>([
      ...Array.from({ length: 469 }, (_, index) => index + 1),
      ...Array.from({ length: 469 }, (_, index) => index + 532),
    ]);
    let calls = 0;
    const api = paginatedRetentionApi(assets, activeRunIds, () => calls++);

    const first = await pruneReleaseAssets(api, now);
    assertEquals(first, {
      before: 1000,
      after: 938,
      deleted: 62,
      protectedActive: 938,
      classificationComplete: true,
      unclassified: 0,
    });
    assertEquals(calls < MAX_RETENTION_API_REQUESTS, true);
    assertEquals(assets.length, 938);
    assertEquals(
      assets.every((asset) =>
        activeRunIds.has(Number(asset.name.split("-")[1]))
      ),
      true,
    );

    const beforeSecond = calls;
    assertEquals(await pruneReleaseAssets(api, now), {
      before: 938,
      after: 938,
      deleted: 0,
      protectedActive: 938,
      classificationComplete: true,
      unclassified: 0,
    });
    assert(calls - beforeSecond < MAX_RETENTION_API_REQUESTS);
  },
);

Deno.test(
  "retention covers every active status filter and paginates the index",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const freshCreatedAt = new Date(now - 1).toISOString();
    const assets = Array.from(
      { length: 105 },
      (_, index) => ({
        id: index + 1,
        name: `evidence-${index + 1}-1-fast-unit.zip`,
        size: 1,
        created_at: freshCreatedAt,
      }),
    );
    const activeRunIds = new Set(assets.map((asset) => asset.id));
    const statuses = new Map<number, string>();
    for (let id = 1; id <= 101; id++) statuses.set(id, "queued");
    statuses.set(102, "in_progress");
    statuses.set(103, "waiting");
    statuses.set(104, "requested");
    statuses.set(105, "pending");
    const requests: string[] = [];
    const api = paginatedRetentionApi(
      assets,
      activeRunIds,
      (path) => requests.push(path),
      statuses,
    );

    assertEquals(await pruneReleaseAssets(api, now), {
      before: 105,
      after: 105,
      deleted: 0,
      protectedActive: 105,
      classificationComplete: true,
      unclassified: 0,
    });
    for (
      const status of [
        "queued",
        "in_progress",
        "waiting",
        "requested",
        "pending",
      ]
    ) {
      assert(
        requests.some((path) =>
          path.includes(`/actions/runs?status=${status}&`)
        ),
      );
    }
    assert(
      requests.some((path) =>
        path.includes("/actions/runs?status=queued") &&
        path.includes("page=2")
      ),
    );
  },
);

Deno.test(
  "retention preserves 1,000 active assets within the request ceiling",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const assets = Array.from(
      { length: MAX_RELEASE_ASSETS * 2 },
      (_, index) => ({
        id: index + 1,
        name: `evidence-${index + 1}-1-fast-unit.zip`,
        size: 1,
        created_at: new Date(now - 1).toISOString(),
      }),
    );
    const activeRunIds = new Set(assets.map((asset) => asset.id));
    let calls = 0;
    const api = paginatedRetentionApi(assets, activeRunIds, () => calls++);

    assertEquals(await pruneReleaseAssets(api, now), {
      before: 1000,
      after: 1000,
      deleted: 0,
      protectedActive: 1000,
      classificationComplete: true,
      unclassified: 0,
    });
    assert(calls < MAX_RETENTION_API_REQUESTS);
  },
);

Deno.test(
  "retention marks a truncated active index as an unclassified lower bound",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const assets = [{
      id: 2001,
      name: "evidence-2001-1-fast-unit.zip",
      size: 1,
      created_at: new Date(now - FAILURE_RETENTION_MS - 1).toISOString(),
    }];
    const activeRunIds = new Set(
      Array.from({ length: 1000 }, (_, index) => index + 1),
    );
    activeRunIds.add(2001);
    const requests: string[] = [];
    const api = paginatedRetentionApi(
      assets,
      activeRunIds,
      (path) => requests.push(path),
    );

    assertEquals(await pruneReleaseAssets(api, now), {
      before: 1,
      after: 1,
      deleted: 0,
      protectedActive: 0,
      classificationComplete: false,
      unclassified: 1,
    });
    assertEquals(
      requests.filter((path) => path.includes("/actions/runs?")).length,
      11,
    );
    assertEquals(assets.length, 1);
  },
);

Deno.test(
  "retention rechecks a candidate that becomes active before deletion",
  async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const assets = [{
      id: 9001,
      name: "evidence-9001-1-fast-unit.zip",
      size: 1,
      created_at: new Date(now - FAILURE_RETENTION_MS - 1).toISOString(),
    }];
    const requests: string[] = [];
    let deleteAttempted = false;
    const api = {
      request: (path: string, init?: RequestInit): Promise<Response> => {
        requests.push(path);
        if (path === "/releases/tags/ci-evidence") {
          return Promise.resolve(Response.json(release));
        }
        if (path.startsWith("/releases/7/assets?")) {
          return Promise.resolve(Response.json(assets));
        }
        if (path.startsWith("/actions/runs?")) {
          return Promise.resolve(Response.json({ workflow_runs: [] }));
        }
        if (path === "/actions/runs/9001") {
          return Promise.resolve(
            Response.json({
              id: 9001,
              status: "in_progress",
              conclusion: null,
            }),
          );
        }
        if (init?.method === "DELETE") {
          deleteAttempted = true;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.reject(
          new Error(`unexpected ${init?.method ?? "GET"} ${path}`),
        );
      },
    };

    assertEquals(await pruneReleaseAssets(api, now), {
      before: 1,
      after: 1,
      deleted: 0,
      protectedActive: 1,
      classificationComplete: true,
      unclassified: 0,
    });
    assertEquals(deleteAttempted, false);
    assertEquals(requests.at(-1), "/actions/runs/9001");
  },
);
