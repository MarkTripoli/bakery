import { assertEquals, assertRejects } from "@std/assert";
import {
  createSkillSourceAdapter,
  createSkillSourceAdapterForTest,
  type GitCommandInvocation,
  SkillSourceAdapterError,
  type SkillSourceProof,
  validatePinnedSkillSource,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import {
  MAX_SKILL_ARCHIVE_BYTES,
  MAX_SKILL_ARCHIVE_EXPANDED_BYTES,
  parseGzipUstarArchive,
  TarArchiveError,
  type TarArchiveErrorCode,
} from "../../apps/server/src/modules/catalog/tar-archive.ts";
import {
  createRemoteSkillArchive,
  createRemoteSkillFixture,
  createUstarArchive,
  gzipFixture,
  type RemoteSkillFixture,
  startRemoteSkillSourceFixture,
  stopRemoteSkillSourceFixture,
  type UstarFixtureEntry,
} from "../fixtures/remote-skill-source.ts";

const encoder = new TextEncoder();
const locator = "http://127.0.0.1:43127/source";
const etag = '"fixture-revision-1"';

function response(
  archive: Uint8Array,
  options: Readonly<{
    url?: string;
    etag?: string | null;
    status?: number;
    body?: ReadableStream<Uint8Array> | null;
  }> = {},
) {
  const headers = new Headers();
  if (options.etag !== null) headers.set("etag", options.etag ?? etag);
  return {
    status: options.status ?? 200,
    url: options.url ?? locator,
    headers,
    body: options.body === undefined
      ? new Blob([new Uint8Array(archive)]).stream()
      : options.body,
  };
}

async function expectArchiveError(
  compressed: Uint8Array,
  code: TarArchiveErrorCode,
): Promise<void> {
  const error = await assertRejects(
    () => parseGzipUstarArchive(compressed),
    TarArchiveError,
    code,
  );
  assertEquals(error.code, code);
}

function repairHeaderChecksum(archive: Uint8Array, headerOffset = 0): void {
  archive.fill(0x20, headerOffset + 148, headerOffset + 156);
  let checksum = 0;
  for (let index = headerOffset; index < headerOffset + 512; index++) {
    checksum += archive[index];
  }
  const octal = checksum.toString(8).padStart(6, "0");
  archive.set(encoder.encode(octal), headerOffset + 148);
  archive[headerOffset + 154] = 0;
  archive[headerOffset + 155] = 0x20;
}

function fixtureEntries(fixture: RemoteSkillFixture): UstarFixtureEntry[] {
  return [
    { path: "manifest.json", content: fixture.manifestBytes },
    ...fixture.files.map((file) => ({
      path: file.path,
      content: file.content,
      mode: file.isExecutable ? 0o755 : 0o644,
    })),
  ];
}

async function proofFromArchive(
  compressed: Uint8Array,
): Promise<SkillSourceProof> {
  return {
    sourceType: "url",
    normalizedLocator: "https://source.example/skill.tar.gz",
    requestedRevision: etag,
    sourceRevision: etag,
    sourceProofDigest: "f".repeat(64),
    normalizedPath: "",
    inventory: await parseGzipUstarArchive(compressed),
  };
}

async function expectSourceError(
  work: () => Promise<unknown>,
  code: SkillSourceAdapterError["code"],
): Promise<void> {
  const error = await assertRejects(work, SkillSourceAdapterError, code);
  assertEquals(error.code, code);
}

Deno.test("real loopback HTTP proves strong ETag, mutation, validation, and bounds", async () => {
  const fixture = await startRemoteSkillSourceFixture();
  try {
    // Every ordinary fetch gets a generous deadline: a loaded host can take
    // longer than 100 ms to answer, which is a timeout this test does not mean.
    // Only the one fetch that is meant to time out gets the short one.
    const adapter = createSkillSourceAdapterForTest({
      allowInsecureLoopback: true,
      timeoutMs: 5_000,
    });
    const impatient = createSkillSourceAdapterForTest({
      allowInsecureLoopback: true,
      timeoutMs: 100,
    });
    const first = await adapter.fetchPinnedSource({
      sourceType: "url",
      locator: fixture.archiveUrl,
      requestedRevision: fixture.etag,
    });
    const validated = await validatePinnedSkillSource({
      proof: first,
      skillId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      registeredLicense: "MIT",
    });
    assertEquals(validated.proof.sourceRevision, fixture.etag);
    assertEquals(validated.version.files[0].path, "SKILL.md");

    await fixture.useSecondArchive();
    const mutated = await adapter.fetchPinnedSource({
      sourceType: "url",
      locator: fixture.archiveUrl,
      requestedRevision: fixture.etag,
      expectedSourceRevision: first.sourceRevision,
    });
    assertEquals(mutated.sourceRevision, first.sourceRevision);
    assertEquals(mutated.sourceProofDigest === first.sourceProofDigest, false);

    const invalid = await adapter.fetchPinnedSource({
      sourceType: "url",
      locator: fixture.invalidArchiveUrl,
      requestedRevision: fixture.etag,
    });
    await expectSourceError(
      () =>
        validatePinnedSkillSource({
          proof: invalid,
          skillId: "22222222-2222-4222-8222-222222222222",
          revision: 1,
          registeredLicense: "MIT",
        }),
      "SOURCE_INVALID",
    );
    await expectSourceError(
      () =>
        adapter.fetchPinnedSource({
          sourceType: "url",
          locator: fixture.redirectArchiveUrl,
          requestedRevision: fixture.etag,
        }),
      "SOURCE_UNAVAILABLE",
    );
    await expectSourceError(
      () =>
        impatient.fetchPinnedSource({
          sourceType: "url",
          locator: fixture.timeoutArchiveUrl,
          requestedRevision: fixture.etag,
        }),
      "SOURCE_TIMEOUT",
    );
    await expectSourceError(
      () =>
        adapter.fetchPinnedSource({
          sourceType: "url",
          locator: fixture.oversizedArchiveUrl,
          requestedRevision: fixture.etag,
        }),
      "SOURCE_LIMIT_EXCEEDED",
    );
    const observations = await fixture.observations();
    assertEquals(
      observations.filter((item) => item.path === "/archive").map((item) =>
        item.ifMatch
      ),
      [fixture.etag, fixture.etag],
    );
  } finally {
    await stopRemoteSkillSourceFixture(fixture);
  }
});

Deno.test("real smart HTTP Git pins the first commit across tag mutation", async () => {
  const fixture = await startRemoteSkillSourceFixture();
  try {
    const adapter = createSkillSourceAdapterForTest({
      allowInsecureLoopback: true,
      timeoutMs: 5_000,
    });
    const first = await adapter.fetchPinnedSource({
      sourceType: "git",
      locator: fixture.gitUrl,
      requestedRevision: "v1",
    });
    assertEquals(first.sourceRevision, fixture.initialCommit);
    const validated = await validatePinnedSkillSource({
      proof: first,
      skillId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      registeredLicense: "MIT",
    });
    assertEquals(validated.version.files[0].path, "SKILL.md");

    await fixture.moveTagToSecondCommit();
    const retry = await adapter.fetchPinnedSource({
      sourceType: "git",
      locator: fixture.gitUrl,
      requestedRevision: "v1",
      expectedSourceRevision: first.sourceRevision,
    });
    assertEquals(retry.sourceRevision, fixture.initialCommit);
    assertEquals(retry.sourceProofDigest, first.sourceProofDigest);
    const moved = await adapter.fetchPinnedSource({
      sourceType: "git",
      locator: fixture.gitUrl,
      requestedRevision: "v1",
    });
    assertEquals(moved.sourceRevision, fixture.secondCommit);
    assertEquals(moved.sourceProofDigest === first.sourceProofDigest, false);
    const observations = await fixture.observations();
    assertEquals(
      observations.some((item) =>
        item.path.startsWith(
          "/repository.git/info/refs?service=git-upload-pack",
        )
      ),
      true,
    );
    assertEquals(
      observations.some((item) =>
        item.path === "/repository.git/git-upload-pack"
      ),
      true,
    );
  } finally {
    await stopRemoteSkillSourceFixture(fixture);
  }
});

Deno.test("production source policy rejects credentials, mutable URL parts, and insecure origins", async () => {
  const adapter = createSkillSourceAdapterForTest({
    httpFetch: () => {
      throw new Error("FETCH_MUST_NOT_RUN");
    },
  });
  const rejected = [
    "http://source.example/archive.tar.gz",
    "https://user@source.example/archive.tar.gz",
    "https://user:secret@source.example/archive.tar.gz",
    "https://source.example:444/archive.tar.gz",
    "https://source.example/archive.tar.gz?revision=one",
    "https://source.example/archive.tar.gz#fragment",
    "file:///tmp/archive.tar.gz",
  ];
  for (const rejectedLocator of rejected) {
    await assertRejects(
      () =>
        adapter.fetchPinnedSource({
          sourceType: "url",
          locator: rejectedLocator,
          requestedRevision: etag,
        }),
      SkillSourceAdapterError,
      "SOURCE_ORIGIN_REJECTED",
    );
  }

  const production = createSkillSourceAdapter();
  await assertRejects(
    () =>
      production.fetchPinnedSource({
        sourceType: "url",
        locator,
        requestedRevision: etag,
      }),
    SkillSourceAdapterError,
    "SOURCE_ORIGIN_REJECTED",
  );
});

Deno.test("HTTP proof rejects redirects, weak or changed revisions, and oversized bodies", async () => {
  const fixture = await createRemoteSkillFixture();
  const archive = await createRemoteSkillArchive(fixture);
  for (
    const sourceResponse of [
      response(archive, { url: "http://127.0.0.1:43127/redirected" }),
      response(archive, { etag: 'W/"fixture-revision-1"' }),
      response(archive, { etag: '"fixture-revision-2"' }),
      response(archive, { etag: null }),
      response(archive, { status: 412 }),
    ]
  ) {
    const adapter = createSkillSourceAdapterForTest({
      allowInsecureLoopback: true,
      httpFetch: () => Promise.resolve(sourceResponse),
    });
    await assertRejects(
      () =>
        adapter.fetchPinnedSource({
          sourceType: "url",
          locator,
          requestedRevision: etag,
        }),
      SkillSourceAdapterError,
    );
  }

  const oversized = new Uint8Array(MAX_SKILL_ARCHIVE_BYTES + 1);
  const adapter = createSkillSourceAdapterForTest({
    allowInsecureLoopback: true,
    httpFetch: () => Promise.resolve(response(oversized)),
  });
  await assertRejects(
    () =>
      adapter.fetchPinnedSource({
        sourceType: "url",
        locator,
        requestedRevision: etag,
      }),
    SkillSourceAdapterError,
    "SOURCE_LIMIT_EXCEEDED",
  );
});

Deno.test("HTTP and Git proof time out through injected bounded operations", async () => {
  const waitForAbort = (signal: AbortSignal): Promise<never> =>
    new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("ABORTED_BY_TEST_BUDGET")),
        { once: true },
      );
    });
  const http = createSkillSourceAdapterForTest({
    allowInsecureLoopback: true,
    timeoutMs: 10,
    httpFetch: (_url, init) => waitForAbort(init.signal),
  });
  await assertRejects(
    () =>
      http.fetchPinnedSource({
        sourceType: "url",
        locator,
        requestedRevision: etag,
      }),
    SkillSourceAdapterError,
    "SOURCE_TIMEOUT",
  );

  const git = createSkillSourceAdapterForTest({
    allowInsecureLoopback: true,
    timeoutMs: 10,
    gitRunner: {
      run: (invocation: GitCommandInvocation) =>
        waitForAbort(invocation.signal),
    },
    makeTempDirectory: () => Promise.resolve("/tmp/source-timeout-fixture"),
    removeDirectory: () => Promise.resolve(),
  });
  await assertRejects(
    () =>
      git.fetchPinnedSource({
        sourceType: "git",
        locator: "http://127.0.0.1:43127/repository.git",
        requestedRevision: "v1",
      }),
    SkillSourceAdapterError,
    "SOURCE_TIMEOUT",
  );
});

Deno.test("gzip USTAR rejects compressed, expanded, header, and trailer violations", async () => {
  await expectArchiveError(
    new Uint8Array(MAX_SKILL_ARCHIVE_BYTES + 1),
    "ARCHIVE_COMPRESSED_LIMIT",
  );
  await expectArchiveError(
    await gzipFixture(new Uint8Array(MAX_SKILL_ARCHIVE_EXPANDED_BYTES + 1)),
    "ARCHIVE_EXPANDED_LIMIT",
  );

  const fixture = await createRemoteSkillFixture();
  const badChecksum = createUstarArchive(fixtureEntries(fixture));
  badChecksum[0] ^= 1;
  await expectArchiveError(
    await gzipFixture(badChecksum),
    "ARCHIVE_TAR_HEADER",
  );

  const base256Size = createUstarArchive(fixtureEntries(fixture));
  base256Size[124] = 0x80;
  repairHeaderChecksum(base256Size);
  await expectArchiveError(
    await gzipFixture(base256Size),
    "ARCHIVE_TAR_HEADER",
  );

  const valid = await createRemoteSkillArchive(fixture);
  const badTrailer = valid.slice();
  badTrailer[badTrailer.length - 8] ^= 1;
  await expectArchiveError(badTrailer, "ARCHIVE_GZIP_TRAILER");

  const concatenated = new Uint8Array(valid.byteLength * 2);
  concatenated.set(valid);
  concatenated.set(valid, valid.byteLength);
  await expectArchiveError(concatenated, "ARCHIVE_GZIP_STREAM");
});

Deno.test("gzip USTAR rejects manifest, entry, count, type, collision, and end violations", async () => {
  const manifestTooLarge = await gzipFixture(createUstarArchive([
    {
      path: "manifest.json",
      content: new Uint8Array(262_145),
    },
  ]));
  await expectArchiveError(manifestTooLarge, "ARCHIVE_MANIFEST_LIMIT");

  const entryTooLarge = await gzipFixture(createUstarArchive([
    { path: "manifest.json", content: encoder.encode("{}") },
    { path: "SKILL.md", content: new Uint8Array(10 * 1024 * 1024 + 1) },
  ]));
  await expectArchiveError(entryTooLarge, "ARCHIVE_ENTRY_LIMIT");

  const manyEntries: UstarFixtureEntry[] = [
    { path: "manifest.json", content: encoder.encode("{}") },
  ];
  for (let index = 0; index < 257; index++) {
    manyEntries.push({ path: `files/${index}`, content: new Uint8Array() });
  }
  await expectArchiveError(
    await gzipFixture(createUstarArchive(manyEntries)),
    "ARCHIVE_ENTRY_COUNT",
  );

  await expectArchiveError(
    await gzipFixture(createUstarArchive([
      { path: "manifest.json", content: encoder.encode("{}") },
      {
        path: "link",
        content: new Uint8Array(),
        type: 0x32,
        linkName: "SKILL.md",
      },
    ])),
    "ARCHIVE_ENTRY_TYPE",
  );

  await expectArchiveError(
    await gzipFixture(createUstarArchive([
      { path: "manifest.json", content: encoder.encode("{}") },
      { path: "Straße.md", content: new Uint8Array() },
      { path: "STRASSE.md", content: new Uint8Array() },
    ])),
    "ARCHIVE_PATH_COLLISION",
  );

  const fixture = await createRemoteSkillFixture();
  const truncated = createUstarArchive(fixtureEntries(fixture)).slice(
    0,
    512 + Math.floor(fixture.manifestBytes.byteLength / 2),
  );
  await expectArchiveError(
    await gzipFixture(truncated),
    "ARCHIVE_TRUNCATED",
  );

  const badPadding = createUstarArchive(fixtureEntries(fixture));
  const paddingOffset = 512 + fixture.manifestBytes.byteLength;
  badPadding[paddingOffset] = 1;
  await expectArchiveError(
    await gzipFixture(badPadding),
    "ARCHIVE_TAR_HEADER",
  );

  await expectArchiveError(
    await gzipFixture(createUstarArchive([
      { path: "manifest.json", content: encoder.encode("{}") },
      { path: "../escape", content: new Uint8Array() },
    ])),
    "ARCHIVE_PATH",
  );

  await expectArchiveError(
    await createRemoteSkillArchive(fixture, { endBlocks: 1 }),
    "ARCHIVE_END",
  );
  await expectArchiveError(
    await createRemoteSkillArchive(fixture, {
      trailingTarBytes: new Uint8Array([1]),
    }),
    "ARCHIVE_END",
  );
});

Deno.test("complete inventory, executable bit, and registered license use shared validation", async () => {
  const fixture = await createRemoteSkillFixture();
  const archiveWithUndeclaredFile = await createRemoteSkillArchive(fixture, {
    extraEntries: [{
      path: "undeclared.txt",
      content: encoder.encode("not declared"),
    }],
  });
  await assertRejects(
    async () =>
      await validatePinnedSkillSource({
        proof: await proofFromArchive(archiveWithUndeclaredFile),
        skillId: "22222222-2222-4222-8222-222222222222",
        revision: 1,
        registeredLicense: "MIT",
      }),
    SkillSourceAdapterError,
    "SOURCE_INVALID",
  );

  const tar = createUstarArchive([
    { path: "manifest.json", content: fixture.manifestBytes },
    { path: "SKILL.md", content: fixture.files[0].content, mode: 0o755 },
  ]);
  await assertRejects(
    async () =>
      await validatePinnedSkillSource({
        proof: await proofFromArchive(await gzipFixture(tar)),
        skillId: "22222222-2222-4222-8222-222222222222",
        revision: 1,
        registeredLicense: "MIT",
      }),
    SkillSourceAdapterError,
    "SOURCE_INVALID",
  );
  await assertRejects(
    async () =>
      await validatePinnedSkillSource({
        proof: await proofFromArchive(await createRemoteSkillArchive(fixture)),
        skillId: "22222222-2222-4222-8222-222222222222",
        revision: 1,
        registeredLicense: "Apache-2.0",
      }),
    SkillSourceAdapterError,
    "SOURCE_INVALID",
  );
});
