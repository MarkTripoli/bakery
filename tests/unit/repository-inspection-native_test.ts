import { assertEquals, assertRejects } from "@std/assert";
import { REPOSITORY_INSPECTION_LIMITS as LIMITS } from "../../packages/config/src/env.ts";
import {
  deriveRepositoryInspectionConfig,
  inspectTrustedRepositorySource,
  RepositoryInspectionError,
  repositoryInspectionSourceMetadata,
} from "../../apps/server/src/modules/projects/repository-inspect.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import {
  inspectionDigest,
  loadRepositoryInspectionSource,
  removeRepositoryInspectionDirectory,
} from "../../apps/worker/src/repository-inspection-source.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import {
  RepositoryInspectionJobInputSchema,
  RepositoryInspectionReceiptSchema,
  RepositoryInspectionSourceChunkSchema,
  RepositoryInspectionSourceEnvelopeSchema,
} from "../../packages/contracts/src/repository-inspection.ts";
import type {
  RepositoryInspectionJobInput,
  RepositoryInspectionReceipt,
  RepositoryInspectionSourceChunk,
  RepositoryInspectionSourceEnvelope,
} from "../../packages/contracts/src/repository-inspection.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  applicationId: "00000000-0000-4000-8000-000000000002",
  repositoryId: "00000000-0000-4000-8000-000000000003",
};
const baseline = {
  schemaVersion: 1 as const,
  workflow: { kind: "fixed" as const },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
};

async function git(
  cwd: string,
  args: string[],
  input?: Uint8Array,
): Promise<string> {
  const child = new Deno.Command("/usr/bin/git", {
    args,
    cwd,
    clearEnv: true,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = child.output();
  if (input) {
    const writer = child.stdin.getWriter();
    await writer.write(input);
    await writer.close();
  }
  const result = await output;
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
const object = (cwd: string, type: string, bytes: Uint8Array) =>
  git(cwd, ["hash-object", "-w", "-t", type, "--stdin"], bytes);
const treeEntry = (name: string, id: string): Uint8Array => {
  const header = encoder.encode(`100644 ${name}\0`);
  const result = new Uint8Array(header.length + 20);
  result.set(header);
  result.set(
    Uint8Array.from(id.match(/../g)!, (byte) => parseInt(byte, 16)),
    header.length,
  );
  return result;
};
const commit = (tree: string, message = "fixture\n") =>
  encoder.encode(
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n${message}`,
  );
const mapping = (path: string, snapshotSha: string) => ({
  bareRepositoryPath: path,
  snapshotSha,
  mappingRevision: "native-review-regression-1",
  mappingDigest: "a".repeat(64),
});

Deno.test("inspection rejects oversized commit, tree and blob before content extraction", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "inspection-object-limits-",
  });
  try {
    await git(directory, ["init", "--bare", "--object-format=sha1"]);
    const blob = await object(
      directory,
      "blob",
      encoder.encode("const answer = 42;\n"),
    );
    const tree = await object(directory, "tree", treeEntry("main.js", blob));
    const oversizedCommit = await object(
      directory,
      "commit",
      commit(tree, "x".repeat(2 * LIMITS.fileBytes)),
    );
    const treeEntries = Array.from(
      { length: 2048 },
      (_, index) =>
        treeEntry(`${String(index).padStart(5, "0")}${"x".repeat(400)}`, blob),
    );
    const oversizedTree = new Uint8Array(
      treeEntries.reduce((size, entry) => size + entry.length, 0),
    );
    let treeOffset = 0;
    for (const entry of treeEntries) {
      oversizedTree.set(entry, treeOffset);
      treeOffset += entry.length;
    }
    const treeId = await object(directory, "tree", oversizedTree);
    const treeCommit = await object(directory, "commit", commit(treeId));
    const largeBlob = await object(
      directory,
      "blob",
      new Uint8Array(LIMITS.fileBytes + 1),
    );
    const blobTree = await object(
      directory,
      "tree",
      treeEntry("main.js", largeBlob),
    );
    const blobCommit = await object(directory, "commit", commit(blobTree));
    for (const snapshot of [oversizedCommit, treeCommit, blobCommit]) {
      const error = await assertRejects(
        () =>
          inspectTrustedRepositorySource(scope, mapping(directory, snapshot)),
        RepositoryInspectionError,
        "source_limit",
      );
      assertEquals(error.code, "source_limit");
    }
    const error = await assertRejects(
      () => inspectTrustedRepositorySource(scope, mapping(directory, blob)),
      RepositoryInspectionError,
      "source_invalid",
    );
    assertEquals(error.code, "source_invalid");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function sourceFixture(
  files: Record<string, string>,
  mutation: {
    envelope?: (value: RepositoryInspectionSourceEnvelope) => void;
    transport?: (value: Uint8Array) => void;
    chunk?: (value: RepositoryInspectionSourceChunk) => void;
    chunkBytes?: number;
  } = {},
) {
  const entries = await Promise.all(
    Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(
      async ([path, content]) => ({
        path,
        mode: "100644" as const,
        sha256: await sha256Hex(content),
        contentBase64: encode(encoder.encode(content)),
      }),
    ),
  );
  const envelope: RepositoryInspectionSourceEnvelope = {
    ...scope,
    source: {
      mappingRevision: "package-scope-regression-1",
      mappingDigest: "a".repeat(64),
      baseSha: "b".repeat(40),
      manifestDigest: await sha256Hex(
        canonicalJson(
          entries.map((entry) => ({
            path: entry.path,
            mode: entry.mode,
            sha256: entry.sha256,
            size: atob(entry.contentBase64).length,
          })),
        ),
      ),
    },
    entries,
  };
  mutation.envelope?.(envelope);
  RepositoryInspectionSourceEnvelopeSchema.parse(envelope);
  const config = deriveRepositoryInspectionConfig(baseline, envelope);
  const input: RepositoryInspectionJobInput = RepositoryInspectionJobInputSchema
    .parse({
      ...scope,
      inspectionId: "00000000-0000-4000-8000-000000000004",
      jobId: "00000000-0000-4000-8000-000000000005",
      baseline: {
        profileId: "00000000-0000-4000-8000-000000000006",
        revision: 1,
        digest: "c".repeat(64),
        repositoryVersion: 1,
        defaultBranch: "main",
      },
      profile: {
        id: "00000000-0000-4000-8000-000000000007",
        revision: 2,
        config,
        digest: await sha256Hex(canonicalJson(config)),
      },
      source: await repositoryInspectionSourceMetadata(envelope),
    });
  const authority = {
    workerHostId: "00000000-0000-4000-8000-000000000008",
    workerSessionId: "00000000-0000-4000-8000-000000000009",
    workerSessionGeneration: "1",
  };
  const assignment = {
    jobId: input.jobId,
    input,
    attemptId: "00000000-0000-4000-8000-000000000010",
    leaseToken: "fixture-lease",
    fence: "1",
    action: "repository.inspect",
  } as unknown as JobAssignment;
  const receipt: RepositoryInspectionReceipt = RepositoryInspectionReceiptSchema
    .parse({
      ...scope,
      ...authority,
      inspectionId: input.inspectionId,
      jobId: input.jobId,
      attemptId: assignment.attemptId,
      fence: "1",
      source: input.source,
      inputDigest: await sha256Hex(canonicalJson(input)),
      expiresAt: new Date(Date.now() + LIMITS.durationMs).toISOString(),
    });
  const bytes = encoder.encode(canonicalJson(envelope));
  mutation.transport?.(bytes);
  if (mutation.transport) {
    RepositoryInspectionSourceEnvelopeSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
  }
  const chunks = new Map<number, RepositoryInspectionSourceChunk>();
  const chunkBytes = mutation.chunkBytes ?? LIMITS.chunkBytes;
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const slice = bytes.subarray(offset, offset + chunkBytes);
    const chunk: RepositoryInspectionSourceChunk = {
      receipt: structuredClone(receipt),
      offset,
      totalBytes: bytes.length,
      chunkDigest: await inspectionDigest(slice),
      bytesBase64: encode(slice),
      done: offset + slice.length === bytes.length,
    };
    mutation.chunk?.(chunk);
    chunks.set(offset, RepositoryInspectionSourceChunkSchema.parse(chunk));
  }
  const client = new WorkerApiClient({
    baseUrl: "https://fixture.invalid",
    credential: "fixture-credential",
    fetcher: (url) => {
      const query = new URL(String(url)).searchParams;
      return Promise.resolve(
        Response.json(chunks.get(Number(query.get("offset"))), {
          headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        }),
      );
    },
  });
  return { options: { client, assignment, authority }, envelope };
}

async function load(directory: string, files: Record<string, string>) {
  const { options, envelope } = await sourceFixture(files);
  const loaded = await loadRepositoryInspectionSource({
    ...options,
    directory,
    signal: new AbortController().signal,
  });
  return { loaded, envelope };
}

const sourceRejections: [
  string,
  NonNullable<Parameters<typeof sourceFixture>[1]>,
][] = [
  [
    "source chunk content disagrees with its digest",
    {
      chunk: (chunk: RepositoryInspectionSourceChunk) => {
        const bytes = Uint8Array.from(
          atob(chunk.bytesBase64),
          (character) => character.charCodeAt(0),
        );
        bytes[0] ^= 1;
        chunk.bytesBase64 = encode(bytes);
      },
    },
  ],
  [
    "source transfer skips the requested offset",
    {
      chunk: (chunk: RepositoryInspectionSourceChunk) => {
        chunk.offset += 1;
      },
    },
  ],
  [
    "source receipt changes between individually valid chunks",
    {
      chunkBytes: 128,
      chunk: (chunk: RepositoryInspectionSourceChunk) => {
        if (chunk.offset > 0) {
          chunk.receipt.expiresAt = new Date(
            Date.parse(chunk.receipt.expiresAt) + 1000,
          ).toISOString();
        }
      },
    },
  ],
  [
    "source envelope disagrees with its pin despite valid chunk digests",
    {
      transport: (bytes: Uint8Array) => {
        const text = new TextDecoder().decode(bytes);
        bytes.set(
          encoder.encode(text.replace('"mode":"100644"', '"mode":"100755"')),
        );
      },
    },
  ],
  [
    "source file content disagrees with its hash despite valid transport",
    {
      envelope: (envelope: RepositoryInspectionSourceEnvelope) => {
        const entry = envelope.entries.find((file) =>
          file.path === "check.js"
        )!;
        // Equal decoded length preserves the independently pinned manifest;
        // only this file's content-to-hash integrity becomes invalid.
        entry.contentBase64 = encode(encoder.encode("const other = 1;\n"));
      },
    },
  ],
  [
    "source manifest disagrees with intact files despite valid transport",
    {
      envelope: (envelope: RepositoryInspectionSourceEnvelope) => {
        const digest = envelope.source.manifestDigest;
        envelope.source.manifestDigest = `${digest[0] === "0" ? "1" : "0"}${
          digest.slice(1)
        }`;
      },
    },
  ],
];

for (const [name, mutation] of sourceRejections) {
  Deno.test(`${name} is rejected without admitting private source`, async () => {
    const host = await Deno.makeTempDir({
      prefix: "inspection-source-rejection-",
    });
    try {
      await Deno.mkdir(`${host}/sibling`);
      await Deno.writeTextFile(`${host}/sibling/keep.js`, "const keep = 1;\n");
      await Deno.writeTextFile(`${host}/package.json`, '{"type":"module"}\n');
      const { options } = await sourceFixture({
        "deno.json": '{"tasks":{"syntax":"node --check check.js"}}',
        "check.js": "const valid = 1;\n",
      }, mutation);
      await assertRejects(() =>
        loadRepositoryInspectionSource({
          ...options,
          directory: `${host}/inspection`,
          signal: new AbortController().signal,
        })
      );
      await assertRejects(
        () => Deno.lstat(`${host}/inspection`),
        Deno.errors.NotFound,
      );
      assertEquals(
        await Deno.readTextFile(`${host}/sibling/keep.js`),
        "const keep = 1;\n",
      );
      assertEquals(
        await Deno.readTextFile(`${host}/package.json`),
        '{"type":"module"}\n',
      );
    } finally {
      await removeRepositoryInspectionDirectory(host);
    }
  });
}

Deno.test("materialization path collision removes partial source and neutral package without removing siblings", async () => {
  const host = await Deno.makeTempDir({
    prefix: "inspection-partial-materialization-",
  });
  try {
    await Deno.mkdir(`${host}/sibling`);
    await Deno.writeTextFile(`${host}/sibling/keep.js`, "const keep = 1;\n");
    await Deno.writeTextFile(`${host}/package.json`, '{"type":"module"}\n');
    // All transport/file/manifest identities are intact. Lexical order writes
    // check.js before trying to create that same path as a nested directory.
    const { options } = await sourceFixture({
      "check.js": "const valid = 1;\n",
      "check.js/nested.js": "const nested = 1;\n",
      "deno.json": '{"tasks":{"syntax":"node --check check.js"}}',
    });
    await assertRejects(
      () =>
        loadRepositoryInspectionSource({
          ...options,
          directory: `${host}/inspection`,
          signal: new AbortController().signal,
        }),
      Deno.errors.AlreadyExists,
    );
    await assertRejects(
      () => Deno.lstat(`${host}/inspection`),
      Deno.errors.NotFound,
    );
    assertEquals(
      await Deno.readTextFile(`${host}/sibling/keep.js`),
      "const keep = 1;\n",
    );
    assertEquals(
      await Deno.readTextFile(`${host}/package.json`),
      '{"type":"module"}\n',
    );
  } finally {
    await removeRepositoryInspectionDirectory(host);
  }
});

async function syntax(sourceDirectory: string): Promise<number> {
  const result = await new Deno.Command("node", {
    args: ["--check", "check.js"],
    cwd: sourceDirectory,
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "" },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  return result.code;
}

Deno.test("materialized Node syntax cannot inherit a hostile host package type", async () => {
  const host = await Deno.makeTempDir({ prefix: "inspection-host-package-" });
  try {
    await Deno.writeTextFile(`${host}/package.json`, '{"type":"module"}\n');
    const files = {
      "deno.json": '{"tasks":{"syntax":"node --check check.js"}}',
      "check.js": "const await = 1;\n",
    };
    const hostile = await load(`${host}/owned-hostile`, files);
    const hostileExit = await syntax(hostile.loaded.sourceDirectory);
    await Deno.writeTextFile(`${host}/package.json`, "{}\n");
    const neutral = await load(`${host}/owned-neutral`, files);
    assertEquals(hostileExit, 0);
    assertEquals(await syntax(neutral.loaded.sourceDirectory), 0);
    for (const { loaded, envelope } of [hostile, neutral]) {
      for (const entry of envelope.entries) {
        assertEquals(
          await sha256Hex(
            await Deno.readTextFile(`${loaded.sourceDirectory}/${entry.path}`),
          ),
          entry.sha256,
        );
      }
      await assertRejects(
        () => Deno.stat(`${loaded.sourceDirectory}/package.json`),
        Deno.errors.NotFound,
      );
    }
    await removeRepositoryInspectionDirectory(`${host}/owned-hostile`);
    await removeRepositoryInspectionDirectory(`${host}/owned-neutral`);
    assertEquals(await Deno.readTextFile(`${host}/package.json`), "{}\n");
  } finally {
    await removeRepositoryInspectionDirectory(host);
  }
});

Deno.test("owned neutral scope preserves repository root and nearest nested package types", async () => {
  const host = await Deno.makeTempDir({
    prefix: "inspection-repository-package-",
  });
  try {
    await Deno.writeTextFile(`${host}/package.json`, '{"type":"commonjs"}\n');
    for (
      const [name, files, path, expected] of [
        [
          "module",
          {
            "package.json": '{"type":"module"}\n',
            "check.js": "const await = 1;\n",
          },
          "",
          1,
        ],
        [
          "commonjs",
          {
            "package.json": '{"type":"commonjs"}\n',
            "check.js": "const await = 1;\n",
          },
          "",
          0,
        ],
        [
          "nested",
          {
            "package.json": '{"type":"module"}\n',
            "nested/package.json": '{"type":"commonjs"}\n',
            "nested/check.js": "const await = 1;\n",
          },
          "/nested",
          0,
        ],
      ] as const
    ) {
      const { loaded, envelope } = await load(`${host}/owned-${name}`, files);
      assertEquals(await syntax(`${loaded.sourceDirectory}${path}`), expected);
      for (const entry of envelope.entries) {
        assertEquals(
          await Deno.readTextFile(`${loaded.sourceDirectory}/${entry.path}`),
          files[entry.path as keyof typeof files],
        );
      }
      await removeRepositoryInspectionDirectory(`${host}/owned-${name}`);
    }
  } finally {
    await removeRepositoryInspectionDirectory(host);
  }
});
