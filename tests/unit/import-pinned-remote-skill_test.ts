import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  createSkillSourceAdapterForTest,
  type GitCommandInvocation,
  SKILL_SOURCE_GIT_LOOPBACK_ENVIRONMENT,
  SkillSourceAdapterError,
  validatePinnedSkillSource,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import {
  createRemoteSkillArchive,
  createRemoteSkillFixture,
  fixtureSha256,
} from "../fixtures/remote-skill-source.ts";
import { toRun } from "../../apps/server/src/modules/work/run-command.ts";
import {
  SkillImportReservationPersistenceSchema,
  SkillImportSourceProofPersistenceSchema,
} from "../../apps/server/src/modules/catalog/import-persistence.ts";

const encoder = new TextEncoder();
const locator = "http://127.0.0.1:43127/source";
const etag = '"fixture-revision-1"';
const commit = "1".repeat(40);
const changedCommit = "2".repeat(40);
const manifestObjectId = "a".repeat(40);
const skillObjectId = "b".repeat(40);

function sourceResponse(
  archive: Uint8Array,
  responseEtag = etag,
  responseUrl = locator,
) {
  return {
    status: 200,
    url: responseUrl,
    headers: new Headers({ etag: responseEtag }),
    body: new Blob([new Uint8Array(archive)]).stream(),
  };
}

Deno.test("strong-ETag HTTP proof uses exact request policy and shared validation", async () => {
  const fixture = await createRemoteSkillFixture();
  const archive = await createRemoteSkillArchive(fixture);
  const requests: Array<{ url: string; init: Record<string, unknown> }> = [];
  const adapter = createSkillSourceAdapterForTest({
    allowInsecureLoopback: true,
    httpFetch: (url, init) => {
      requests.push({ url, init: { ...init, headers: init.headers } });
      return Promise.resolve(sourceResponse(archive));
    },
  });

  const proof = await adapter.fetchPinnedSource({
    sourceType: "url",
    locator,
    requestedRevision: etag,
  });
  const accepted = await validatePinnedSkillSource({
    proof,
    skillId: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    registeredLicense: "MIT",
  });

  assertEquals(proof.sourceRevision, etag);
  assertEquals(proof.requestedRevision, etag);
  assertEquals(proof.inventory.files.length, 1);
  assertNotEquals(proof.sourceProofDigest, accepted.version.digest);
  assertEquals(accepted.version.digest, fixture.manifest.digest);
  assertEquals(requests.length, 1);
  assertEquals(requests[0].url, locator);
  const init = requests[0].init as {
    method: string;
    headers: Headers;
    redirect: string;
    credentials: string;
    cache: string;
    referrerPolicy: string;
  };
  assertEquals(init.method, "GET");
  assertEquals(init.headers.get("if-match"), etag);
  assertEquals(init.redirect, "error");
  assertEquals(init.credentials, "omit");
  assertEquals(init.cache, "no-store");
  assertEquals(init.referrerPolicy, "no-referrer");
});

Deno.test("Git proof fixes argv and environment then retries the persisted commit", async () => {
  const fixture = await createRemoteSkillFixture();
  const invocations: GitCommandInvocation[] = [];
  let resolvedCommit = commit;
  const runner = {
    run(invocation: GitCommandInvocation): Promise<Uint8Array> {
      invocations.push(invocation);
      const args = invocation.args;
      if (args[0] === "init" || args.includes("fetch")) {
        return Promise.resolve(new Uint8Array());
      }
      if (args[0] === "rev-parse") {
        return Promise.resolve(encoder.encode(`${resolvedCommit}\n`));
      }
      if (args[0] === "ls-tree") {
        return Promise.resolve(encoder.encode(
          `100644 blob ${manifestObjectId}\tskills/demo/manifest.json\0` +
            `100644 blob ${skillObjectId}\tskills/demo/SKILL.md\0`,
        ));
      }
      if (args[0] === "cat-file" && args[1] === "-s") {
        const bytes = args[2] === manifestObjectId
          ? fixture.manifestBytes
          : fixture.files[0].content;
        return Promise.resolve(encoder.encode(`${bytes.byteLength}\n`));
      }
      if (args[0] === "cat-file" && args[1] === "blob") {
        return Promise.resolve(
          args[2] === manifestObjectId
            ? fixture.manifestBytes
            : fixture.files[0].content,
        );
      }
      throw new Error("UNEXPECTED_GIT_COMMAND");
    },
  };
  const adapter = createSkillSourceAdapterForTest({
    allowInsecureLoopback: true,
    gitRunner: runner,
    makeTempDirectory: () => Promise.resolve("/tmp/source-proof-fixture"),
    removeDirectory: () => Promise.resolve(),
  });

  const first = await adapter.fetchPinnedSource({
    sourceType: "git",
    locator: "http://127.0.0.1:43127/repository.git",
    requestedRevision: "v1.2.3",
    path: "skills/demo",
  });
  assertEquals(first.sourceRevision, commit);
  assertEquals(first.normalizedPath, "skills/demo");
  assertEquals(first.inventory.files[0].path, "SKILL.md");

  const fetch = invocations.find((invocation) =>
    invocation.args.includes("fetch")
  );
  if (!fetch) throw new Error("FETCH_INVOCATION_MISSING");
  assertEquals(fetch.executable, "/usr/bin/git");
  assertEquals(fetch.clearEnv, true);
  assertEquals(fetch.env, SKILL_SOURCE_GIT_LOOPBACK_ENVIRONMENT);
  assertEquals(fetch.stderr, "null");
  assertEquals(fetch.args, [
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
    "http://127.0.0.1:43127/repository.git",
    "v1.2.3",
  ]);

  invocations.length = 0;
  const retry = await adapter.fetchPinnedSource({
    sourceType: "git",
    locator: "http://127.0.0.1:43127/repository.git",
    requestedRevision: "v1.2.3",
    expectedSourceRevision: first.sourceRevision,
    path: "skills/demo",
  });
  assertEquals(retry.sourceRevision, first.sourceRevision);
  const retryFetch = invocations.find((invocation) =>
    invocation.args.includes("fetch")
  );
  assertEquals(retryFetch?.args.at(-1), commit);

  resolvedCommit = changedCommit;
  await assertRejects(
    () =>
      adapter.fetchPinnedSource({
        sourceType: "git",
        locator: "http://127.0.0.1:43127/repository.git",
        requestedRevision: "v1.2.3",
        expectedSourceRevision: commit,
        path: "skills/demo",
      }),
    SkillSourceAdapterError,
    "SOURCE_REVISION_MISMATCH",
  );
});

Deno.test("same HTTP ETag with mutated bytes changes the source proof", async () => {
  const firstFixture = await createRemoteSkillFixture();
  const secondFixture = await createRemoteSkillFixture([
    {
      path: "SKILL.md",
      content: encoder.encode("# Mutated under the same ETag\n"),
      mediaType: "text/markdown",
    },
  ]);
  let archive = await createRemoteSkillArchive(firstFixture);
  const adapter = createSkillSourceAdapterForTest({
    allowInsecureLoopback: true,
    httpFetch: () => Promise.resolve(sourceResponse(archive)),
  });
  const first = await adapter.fetchPinnedSource({
    sourceType: "url",
    locator,
    requestedRevision: etag,
  });
  archive = await createRemoteSkillArchive(secondFixture);
  const mutated = await adapter.fetchPinnedSource({
    sourceType: "url",
    locator,
    requestedRevision: etag,
    expectedSourceRevision: etag,
  });
  assertEquals(mutated.sourceRevision, first.sourceRevision);
  assertNotEquals(mutated.sourceProofDigest, first.sourceProofDigest);
});

Deno.test("Run projection preserves workflow compatibility and import null owners", () => {
  const common = {
    id: "00000000-0000-4000-8000-000000000001",
    repository_profile_id: null,
    repository_profile_revision: null,
    repository_profile_digest: null,
    observation_id: null,
    observation_digest: null,
    base_sha: null,
    workspace_base_sha: null,
    requested_by: "00000000-0000-4000-8000-000000000004",
    inngest_run_id: null,
    status: "queued" as const,
    budget_limit_usd: "0",
    started_at: null,
    finished_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
  const imported = toRun({
    ...common,
    kind: "skill_import",
    task_id: null,
    workflow_version_id: null,
    skill_source_id: "00000000-0000-4000-8000-000000000002",
  });
  assertEquals(imported.kind, "skill_import");
  assertEquals(imported.taskId, null);
  assertEquals(imported.workflowVersionId, null);
  assertEquals(imported.skillSourceId, "00000000-0000-4000-8000-000000000002");
  const legacy = toRun({
    ...common,
    task_id: "00000000-0000-4000-8000-000000000003",
    workflow_version_id: "00000000-0000-4000-8000-000000000005",
  });
  assertEquals(legacy.kind, "workflow");
  assertEquals(legacy.skillSourceId, null);
});

Deno.test("import checkpoints reject changed upstream and reservation pins", () => {
  assertEquals(
    SkillImportSourceProofPersistenceSchema.parse({
      resolvedRevision: "a".repeat(40),
      sourceProofDigest: "b".repeat(64),
    }).sourceProofDigest,
    "b".repeat(64),
  );
  assertEquals(
    SkillImportReservationPersistenceSchema.parse({
      skillId: "00000000-0000-4000-8000-000000000001",
      ordinal: 1,
      skillVersionId: "00000000-0000-4000-8000-000000000002",
      manifestDigest: "a".repeat(64),
      entryPath: "SKILL.md",
      fileInventory: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: 1,
        sha256: "b".repeat(64),
        isExecutable: false,
        objectKey: "organizations/o/skill-versions/v/sha256/b",
      }],
    }).ordinal,
    1,
  );
});

Deno.test("source proof and manifest digest bind different material", async () => {
  const fixture = await createRemoteSkillFixture([
    {
      path: "SKILL.md",
      content: encoder.encode("# Exact revision\n"),
      mediaType: "text/markdown",
    },
  ]);
  const archive = await createRemoteSkillArchive(fixture);
  const expectedArchiveDigest = await fixtureSha256(archive);
  const adapter = createSkillSourceAdapterForTest({
    allowInsecureLoopback: true,
    httpFetch: () => Promise.resolve(sourceResponse(archive)),
  });
  const proof = await adapter.fetchPinnedSource({
    sourceType: "url",
    locator,
    requestedRevision: etag,
    expectedSourceRevision: etag,
  });
  assertEquals(proof.sourceProofDigest, expectedArchiveDigest);
  assertNotEquals(proof.sourceProofDigest, fixture.manifest.digest);
});
