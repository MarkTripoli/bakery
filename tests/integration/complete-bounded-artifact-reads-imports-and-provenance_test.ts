import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { createBakeryApiClient } from "../../apps/web/src/api/client.ts";
import {
  createTrustedRepositoryResolver,
  importArtifactVersion,
  prepareArtifactVersionImport,
  proveArtifactVersionImport,
} from "../../apps/server/src/modules/knowledge/import.ts";
import {
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import {
  claimAssignment,
  type RegisteredWorker,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  type JobSeed,
  problemCode,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

import {
  contractSchemas,
  MAX_ARTIFACT_BYTES,
} from "../../packages/contracts/src/contracts.ts";
const TRUSTED_REPOSITORIES_ENV = "BAKERY_TRUSTED_REPOSITORIES_JSON";

async function subprocess(
  program: string,
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  const output = await new Deno.Command(program, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `${program} failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function git(
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  return await subprocess("git", args, cwd);
}
async function gitBytes(
  args: readonly string[],
  cwd?: string,
): Promise<Uint8Array> {
  const output = await new Deno.Command("git", {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `git failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return output.stdout;
}

function indexOfBytes(value: Uint8Array, needle: Uint8Array): number {
  outer:
  for (
    let offset = 0;
    offset <= value.byteLength - needle.byteLength;
    offset++
  ) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (value[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

async function writeLooseGitObject(
  bareRepositoryPath: string,
  objectId: string,
  objectType: "commit" | "tree",
  content: Uint8Array,
): Promise<void> {
  const header = new TextEncoder().encode(
    `${objectType} ${content.byteLength}\0`,
  );
  const payload = new Uint8Array(header.byteLength + content.byteLength);
  payload.set(header);
  payload.set(content, header.byteLength);
  const compressed = await new Response(
    new Blob([payload]).stream().pipeThrough(
      new CompressionStream("deflate"),
    ),
  ).arrayBuffer();
  const objectDirectory = `${bareRepositoryPath}/objects/${
    objectId.slice(0, 2)
  }`;
  await Deno.mkdir(objectDirectory, { recursive: true });
  const objectPath = `${objectDirectory}/${objectId.slice(2)}`;
  // Git can create existing loose objects read-only; replace, not truncate.
  try {
    await Deno.remove(objectPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.writeFile(objectPath, new Uint8Array(compressed));
}

async function assertNoAcceptedImportState(
  fixture: { pgDatabase: PgDatabase },
  ids: { organizationId: string; principalId: string; artifactId: string },
): Promise<void> {
  assertEquals(await importFactCounts(fixture, ids), {
    versions: 0,
    events: 0,
    outbox: 0,
    audits: 0,
    idempotency: 0,
  });
  const artifact = await fixture.pgDatabase.query<{
    currentVersionId: string | null;
  }>(
    `select current_version_id as "currentVersionId"
       from bakery.artifacts
      where organization_id=$1 and id=$2`,
    [ids.organizationId, ids.artifactId],
  );
  assertEquals(artifact.rows[0]?.currentVersionId, null);
}

type RepositoryFixtureOptions = {
  largeRootTree?: boolean;
  largeCommitMessage?: boolean;
  svgFile?: boolean;
};

type ImportScenarioOptions = RepositoryFixtureOptions & {
  repositoryPath?: "bare" | "workGitDir";
  prepareRepository?: (
    gitFixture: VerifiedBareRepository,
  ) => Promise<void>;
};

type VerifiedBareRepository = {
  root: string;
  bareRepositoryPath: string;
  commitSha: string;
  treeSha: string;
  blobSha: string;
  content: Uint8Array;
  rejectedPaths: readonly string[];
};

async function createVerifiedBareRepository(
  contentText = "trusted import fixture\n",
  options: RepositoryFixtureOptions = {},
) {
  const root = await subprocess("mktemp", [
    "-d",
    "-t",
    "issue44-import-XXXXXX",
  ]);
  const work = `${root}/work`;
  const bare = `${root}/bare.git`;
  const gitlinkSha = "0123456789abcdef0123456789abcdef01234567";
  const oversizedPath = `${work}/src/oversized.bin`;
  await subprocess("mkdir", ["-p", `${work}/src`]);
  await git(["init", work]);
  await git(["config", "user.name", "Issue 44 Fixture"], work);
  await git(["config", "user.email", "issue44@example.test"], work);
  const content = new TextEncoder().encode(contentText);
  await subprocess(
    "sh",
    [
      "-c",
      'printf \'%s\' "$1" > "$2"',
      "issue44-import-fixture",
      contentText,
      `${work}/src/readme.txt`,
    ],
  );
  if (options.svgFile) {
    await Deno.writeTextFile(`${work}/src/asset.svg`, contentText);
  }
  await subprocess("ln", ["-s", "readme.txt", `${work}/src/link`]);
  await subprocess("truncate", ["-s", "10485761", oversizedPath]);
  const rootEntries: string[] = [];
  if (options.largeRootTree) {
    for (let index = 0; index < 512; index += 1) {
      const name = `root-sibling-${index.toString().padStart(3, "0")}.txt`;
      rootEntries.push(name);
      await Deno.writeTextFile(`${work}/${name}`, "sibling\n");
    }
  }
  if (rootEntries.length > 0) {
    await git(["add", "--", ...rootEntries], work);
  }
  await git(["add", "src/readme.txt", "src/link", "src/oversized.bin"], work);
  if (options.svgFile) await git(["add", "src/asset.svg"], work);
  await git([
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${gitlinkSha},src/gitlink`,
  ], work);
  await git(["commit", "-m", "trusted import fixture"], work);
  let commitSha = await git(["rev-parse", "HEAD"], work);
  for (
    let attempt = 0;
    !/[a-f]/.test(commitSha) && attempt < 16;
    attempt += 1
  ) {
    await git([
      "commit",
      "--allow-empty",
      "-m",
      `hex-letter seed ${attempt}`,
    ], work);
    commitSha = await git(["rev-parse", "HEAD"], work);
  }
  if (!/[a-f]/.test(commitSha)) {
    throw new Error("HEX_LETTER_COMMIT_NOT_CREATED");
  }
  if (options.largeCommitMessage) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await git([
        "commit",
        "--allow-empty",
        "-m",
        `${"x".repeat(20 * 1024)} ${attempt}`,
      ], work);
      commitSha = await git(["rev-parse", "HEAD"], work);
      if ((commitSha.match(/[a-f]/g)?.length ?? 0) >= 2) break;
    }
    if ((commitSha.match(/[a-f]/g)?.length ?? 0) < 2) {
      throw new Error("MIXED_CASE_COMMIT_NOT_CREATED");
    }
  }
  const treeSha = await git(["rev-parse", "HEAD^{tree}"], work);
  const blobSha = await git(["rev-parse", "HEAD:src/readme.txt"], work);
  await git(["clone", "--bare", work, bare]);

  assertEquals(
    await git(["--git-dir", bare, "cat-file", "-t", commitSha]),
    "commit",
  );
  assertEquals(
    await git(["--git-dir", bare, "cat-file", "-t", treeSha]),
    "tree",
  );
  assertEquals(
    await git(["--git-dir", bare, "cat-file", "-t", blobSha]),
    "blob",
  );
  const treeEntry = await git([
    "--git-dir",
    bare,
    "ls-tree",
    commitSha,
    "--",
    "src/readme.txt",
  ]);
  assert(treeEntry.startsWith(`100644 blob ${blobSha}\tsrc/readme.txt`));
  const symlinkEntry = await git([
    "--git-dir",
    bare,
    "ls-tree",
    commitSha,
    "--",
    "src/link",
  ]);
  assert(
    symlinkEntry.startsWith("120000 blob ") && symlinkEntry.endsWith(
      "\tsrc/link",
    ),
  );
  const gitlinkEntry = await git([
    "--git-dir",
    bare,
    "ls-tree",
    commitSha,
    "--",
    "src/gitlink",
  ]);
  assert(gitlinkEntry.startsWith(`160000 commit ${gitlinkSha}\tsrc/gitlink`));
  const directoryEntry = await git([
    "--git-dir",
    bare,
    "ls-tree",
    commitSha,
    "--",
    "src",
  ]);
  assert(
    directoryEntry.startsWith("040000 tree ") && directoryEntry.endsWith(
      "\tsrc",
    ),
  );
  const oversizedEntry = await git([
    "--git-dir",
    bare,
    "ls-tree",
    commitSha,
    "--",
    "src/oversized.bin",
  ]);
  assert(
    oversizedEntry.startsWith("100644 blob ") && oversizedEntry.endsWith(
      "\tsrc/oversized.bin",
    ),
  );

  return {
    root,
    bareRepositoryPath: bare,
    commitSha,
    treeSha,
    blobSha,
    content,
    rejectedPaths: [
      "src/link",
      "src/gitlink",
      "src",
      "src/oversized.bin",
    ] as const,
  };
}

async function trustedConfig(
  organizationId: string,
  applicationId: string,
  repositoryUuid: string,
  bareRepositoryPath: string,
  snapshotSha: string,
): Promise<string> {
  const material = {
    applicationId,
    bareRepositoryPath,
    mappingRevision: "issue44-fixture-1",
    organizationId,
    repositoryUuid,
    snapshotSha,
    status: "active" as const,
  };
  return JSON.stringify({
    schemaVersion: 1,
    entries: [{
      ...material,
      mappingDigest: await sha256Hex(canonicalJson(material)),
    }],
  });
}

async function seedAuthenticatedImportGraph(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  ids: {
    organizationId: string;
    providerUserId: string;
    principalId: string;
    applicationId: string;
    conversationId: string;
    repositoryId: string;
    taskId: string;
    artifactId: string;
  },
): Promise<string> {
  const now = new Date();
  const email = `issue44-developer-${ids.organizationId}@example.test`;
  const sessionToken = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, 'Issue 44 Developer', $2, true, $3, $3)`,
    [ids.providerUserId, email, now],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, 'Issue 44 Developer', 'human')`,
    [ids.principalId, ids.providerUserId],
  );
  await fixture.pgDatabase.query(
    `insert into public.organization (
       id, name, slug, "createdAt", "updatedAt"
     ) values ($1, 'Issue 44 Organization', $2, $3, $3)`,
    [ids.organizationId, `issue44-${ids.organizationId}`, now],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organizations (
       id, name, slug, metadata, created_at, updated_at
     ) values ($1, 'Issue 44 Organization', $2, '{}'::jsonb, $3, $3)`,
    [ids.organizationId, `issue44-${ids.organizationId}`, now],
  );
  await fixture.pgDatabase.query(
    `insert into public.member (
       id, "organizationId", "userId", role, status,
       "createdAt", "joinedAt", "updatedAt"
     ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4)`,
    [crypto.randomUUID(), ids.organizationId, ids.providerUserId, now],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at,
       created_at, updated_at, version
     ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), ids.organizationId, ids.principalId, now],
  );
  await fixture.pgDatabase.query(
    `insert into public.session (
       id, token, "userId", "expiresAt", "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      sessionToken,
      ids.providerUserId,
      new Date(Date.now() + 60 * 60 * 1000),
      now,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, 'issue44-app', 'Issue 44 Application')`,
    [ids.applicationId, ids.organizationId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, title, created_by
     ) values ($1, $2, $3, 'Issue 44 Conversation', $4)`,
    [
      ids.conversationId,
      ids.organizationId,
      ids.applicationId,
      ids.principalId,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1, $2, $3, $4, $5, 'issue44', 'trusted', 'main')`,
    [
      ids.repositoryId,
      ids.organizationId,
      ids.applicationId,
      crypto.randomUUID(),
      `issue44/${ids.repositoryId}`,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, repository_id,
       conversation_id, title, task_type, status, priority, created_by
     ) values ($1, $2, $3, $4, $5, 'Issue 44 Task', 'feature', 'queued', 50, $6)`,
    [
      ids.taskId,
      ids.organizationId,
      ids.applicationId,
      ids.repositoryId,
      ids.conversationId,
      ids.principalId,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifacts (
       id, organization_id, task_id, artifact_type, name, revision, version
     ) values ($1, $2, $3, 'source', 'readme', 1, 1)`,
    [ids.artifactId, ids.organizationId, ids.taskId],
  );
  return await signSessionCookie(sessionToken, fixture.config.auth!.secret);
}

function importRequest(
  cookie: string,
  organizationId: string,
  artifactId: string,
  idempotencyKey: string,
  body: { path: string; commitSha: string },
  ifMatch = '"v1"',
): Request {
  return new Request(
    `${authTestOrigin}/v1/artifacts/${artifactId}/versions/import`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: authTestOrigin,
        "Bakery-Organization-Id": organizationId,
        "Idempotency-Key": idempotencyKey,
        "If-Match": ifMatch,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function importFactCounts(
  fixture: { pgDatabase: PgDatabase },
  ids: { organizationId: string; principalId: string; artifactId: string },
): Promise<{
  versions: number;
  events: number;
  outbox: number;
  audits: number;
  idempotency: number;
}> {
  const result = await fixture.pgDatabase.query<{
    versions: number;
    events: number;
    outbox: number;
    audits: number;
    idempotency: number;
  }>(
    `select
       (select count(*)::int from bakery.artifact_versions
         where organization_id=$1 and artifact_id=$2) as versions,
       (select count(*)::int from bakery.domain_events
         where organization_id=$1 and aggregate_id=$2
           and event_type='artifact.version_created') as events,
       (select count(*)::int
          from bakery.outbox as o
          join bakery.domain_events as e
            on e.id=o.event_id and e.organization_id=o.organization_id
         where o.organization_id=$1 and e.aggregate_id=$2
           and e.event_type='artifact.version_created') as outbox,
       (select count(*)::int from bakery.audit_events
          where organization_id=$1 and operation='artifactVersions.import'
            and resource_type='artifact_version'
            and resource_id in (
              select id::text from bakery.artifact_versions
               where organization_id=$1 and artifact_id=$2
            )) as audits,
       (select count(*)::int from bakery.idempotency_records
          where organization_id=$1 and principal_id=$3
            and operation='artifactVersions.import') as idempotency`,
    [ids.organizationId, ids.artifactId, ids.principalId],
  );
  return result.rows[0] ?? {
    versions: 0,
    events: 0,
    outbox: 0,
    audits: 0,
    idempotency: 0,
  };
}

async function seedWorkerAdminIdentity(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
): Promise<{ email: string; principalId: string; cookie: string }> {
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  const email = `issue44-worker-admin-${providerUserId}@example.test`;
  const now = new Date();
  await withPgTransaction(
    fixture.pgDatabase,
    async (transaction) => {
      await transaction.query(
        `insert into public."user" (
           id, name, email, "emailVerified", "createdAt", "updatedAt"
         ) values ($1, 'Issue 44 Worker Admin', $2, true, $3, $3)`,
        [providerUserId, email, now],
      );
      await transaction.query(
        `insert into bakery.principals (
           id, provider_user_id, display_name, principal_type
         ) values ($1, $2, 'Issue 44 Worker Admin', 'human')`,
        [principalId, providerUserId],
      );
      await transaction.query(
        `insert into public.session (
           id, token, "userId", "expiresAt", "createdAt", "updatedAt"
         ) values ($1, $2, $3, $4, $5, $5)`,
        [
          crypto.randomUUID(),
          sessionToken,
          providerUserId,
          new Date(Date.now() + 60 * 60 * 1000),
          now,
        ],
      );
    },
  );
  return {
    email,
    principalId,
    cookie: await signSessionCookie(sessionToken, fixture.config.auth!.secret),
  };
}

async function publishWorkerArtifact(
  authFixture: Awaited<ReturnType<typeof openAuthFixture>>,
): Promise<void> {
  const workerAdmin = await seedWorkerAdminIdentity(authFixture);
  try {
    const scope = await createWorkerScope(authFixture, "issue44-worker", {
      email: workerAdmin.email,
      principalId: workerAdmin.principalId,
      adminCookie: workerAdmin.cookie,
    });
    const fixture: WorkerFixture = {
      ...authFixture,
      ...scope,
      releaseFixture: () => {},
      workerHostIds: [],
    };
    try {
      const worker = await registeredWorker(fixture);
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      const key = `issue44-worker-${crypto.randomUUID()}`;
      const form = (
        content: string | Uint8Array = "worker publication",
        duplicateName = false,
        metadata: Record<string, unknown> = {},
      ) => {
        const value = new FormData();
        value.set("leaseToken", assignment.leaseToken);
        value.set("fence", assignment.fence);
        value.set("workerSessionId", worker.registration.workerSessionId);
        value.set(
          "workerSessionGeneration",
          String(worker.registration.workerSessionGeneration),
        );
        value.set("artifactType", "patch");
        value.set("name", "phase2-worker");
        value.set("contentType", "text/plain");
        value.set("metadata", JSON.stringify(metadata));
        value.set("runStepId", job.runStepId);
        value.set("stepKey", "worker");
        const fileContent = typeof content === "string"
          ? content
          : new Uint8Array(content);
        value.set("content", new File([fileContent], "worker.txt"));
        if (duplicateName) value.append("name", "duplicate");
        return value;
      };
      const send = (
        content: string | Uint8Array = "worker publication",
        duplicateName = false,
        metadata: Record<string, unknown> = {},
        idempotencyKey = key,
      ) =>
        fixture.app.fetch(
          new Request(
            `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${worker.credential}`,
                "idempotency-key": idempotencyKey,
                "X-Bakery-Worker-Protocol-Version": "2",
              },
              body: form(content, duplicateName, metadata),
            },
          ),
        );
      const forgedMetadataCases = [
        ["sourceRepositoryId", "forged-repository"],
        ["path", "src/forged.txt"],
        ["commitSha", "f".repeat(40)],
      ] as const;
      const publicationFacts = async () =>
        await fixture.pgDatabase.query<{
          artifacts: number;
          versions: number;
          events: number;
          outbox: number;
          replays: number;
          currentVersionId: string | null;
        }>(
          `select
             (select count(*)::int from bakery.artifacts
                where organization_id=$1 and task_id=$2
                  and artifact_type='patch' and name='phase2-worker') as artifacts,
             (select count(*)::int from bakery.artifact_versions
                where organization_id=$1 and task_id=$2) as versions,
             (select count(*)::int from bakery.domain_events
                where organization_id=$1 and task_id=$2
                  and event_type='artifact.version_created') as events,
             (select count(*)::int
                from bakery.outbox as o
                join bakery.domain_events as e
                  on e.id=o.event_id and e.organization_id=o.organization_id
               where o.organization_id=$1 and e.task_id=$2
                 and e.event_type='artifact.version_created') as outbox,
             (select count(*)::int from bakery.artifact_publication_replays
                where organization_id=$1 and attempt_id=$3) as replays,
             (select current_version_id
                from bakery.artifacts
               where organization_id=$1 and task_id=$2
                 and artifact_type='patch' and name='phase2-worker'
               limit 1) as "currentVersionId"`,
          [fixture.organizationId, job.taskId, assignment.attemptId],
        );
      for (const [field, value] of forgedMetadataCases) {
        const forged = await send(
          "worker publication",
          false,
          { benign: "worker-owned", [field]: value },
          `issue44-worker-forged-${field}-${crypto.randomUUID()}`,
        );
        assertEquals(forged.status, 422, await forged.clone().text());
        assertEquals(
          (await forged.json() as { code?: string }).code,
          "UNPROCESSABLE",
        );
        assertEquals((await publicationFacts()).rows, [{
          artifacts: 0,
          versions: 0,
          events: 0,
          outbox: 0,
          replays: 0,
          currentVersionId: null,
        }]);
      }
      const allForged = Object.create(null) as Record<string, unknown>;
      allForged.sourceRepositoryId = "forged-repository";
      allForged.path = "src/forged.txt";
      allForged.commitSha = "f".repeat(40);
      const allForgedResponse = await send(
        "worker publication",
        false,
        allForged,
        `issue44-worker-forged-all-${crypto.randomUUID()}`,
      );
      assertEquals(
        allForgedResponse.status,
        422,
        await allForgedResponse.clone().text(),
      );
      assertEquals(
        (await allForgedResponse.json() as { code?: string }).code,
        "UNPROCESSABLE",
      );
      for (
        const activeDocument of [
          '<img src=x onerror="alert(1)">',
          '<!-- README -->\n<div title=">"><img src=x onerror="alert(1)"></div>',
          "<div><!--><img src=x onerror=alert(1)></div>",
          '<div><img src="x"onerror="alert(1)"></div>',
          "<!--><img src=x onerror=alert(1)><!-- -->",
          "<img src=x' onerror=alert(1)>",
          "<x-widget_demo onclick=alert(1)>click</x-widget_demo>",
          '<?<x title="><img src=x onerror=alert(1)>">',
          `</div title="<x title='>"><img src=x onerror=alert(1)>'>`,
          '</?<x title="><img src=x onerror=alert(1)>">',
          '<textarea><x title="</textarea><img src=x onerror=alert(1)>">',
          '<xmp><x title="</xmp><img src=x onerror=alert(1)>">',
          '<math><![CDATA[><x title="]]></math><img src=x onerror=alert(1)>">',
          `<p>README</p><!doctype html public "><x title='"><img src=x onerror=alert(1)>'>`,
          '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>run()</s:script></s:svg>',
          '<_s:svg xmlns:_s="http://www.w3.org/2000/svg"><_s:script>run()</_s:script></_s:svg>',
        ]
      ) {
        const activeMarkup = await send(
          activeDocument,
          false,
          {},
          `issue44-worker-active-html-${crypto.randomUUID()}`,
        );
        assertEquals(
          activeMarkup.status,
          422,
          await activeMarkup.clone().text(),
        );
        assertEquals(await problemCode(activeMarkup), "UNPROCESSABLE");
        assertEquals((await publicationFacts()).rows, [{
          artifacts: 0,
          versions: 0,
          events: 0,
          outbox: 0,
          replays: 0,
          currentVersionId: null,
        }]);
      }
      const published = await send();
      assertEquals(published.status, 201, await published.clone().text());
      const replay = await send();
      assertEquals(replay.status, 201, await replay.clone().text());
      assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
      const mismatch = await send("changed worker publication");
      assertEquals(mismatch.status, 422, await mismatch.clone().text());
      assertEquals(
        (await mismatch.json() as { code?: string }).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      const duplicateField = await send("worker publication", true);
      assertEquals(
        duplicateField.status,
        422,
        await duplicateField.clone().text(),
      );
      assertEquals(
        (await duplicateField.json() as { code?: string }).code,
        "UNPROCESSABLE",
      );
      const overLimit = await send(
        new Uint8Array(MAX_ARTIFACT_BYTES + 1).fill(0x61),
      );
      assertEquals(overLimit.status, 413, await overLimit.clone().text());
      assertEquals(
        (await overLimit.json() as { code?: string }).code,
        "BODY_TOO_LARGE",
      );

      const facts = await publicationFacts();
      assertEquals(facts.rows[0]?.artifacts, 1);
      assertEquals(facts.rows[0]?.versions, 1);
      assertEquals(facts.rows[0]?.events, 1);
      assertEquals(facts.rows[0]?.outbox, 1);
      assertEquals(facts.rows[0]?.replays, 1);
      assert(facts.rows[0]?.currentVersionId !== null);
    } finally {
      await closeWorkerScope(fixture, fixture);
    }
  } finally {
    await cleanupAuthFixture(authFixture.pgDatabase, [workerAdmin.email]);
  }
}

type WorkerArtifactScenario = {
  fixture: WorkerFixture;
  worker: RegisteredWorker;
  job: JobSeed;
  assignment: WorkerAssignment;
};

async function withWorkerArtifactScenario(
  callback: (scenario: WorkerArtifactScenario) => Promise<void>,
): Promise<void> {
  const authFixture = await openAuthFixture();
  let workerFixture: WorkerFixture | undefined;
  try {
    const scope = await createWorkerScope(authFixture, "issue44-worker");
    workerFixture = {
      ...authFixture,
      ...scope,
      releaseFixture: () => {},
      workerHostIds: [],
    };
    const worker = await registeredWorker(workerFixture);
    const job = await seedFundedModelJob(
      workerFixture.pgDatabase,
      workerFixture.organizationId,
      workerFixture.principalId,
    );
    const assignment = await claimAssignment(workerFixture, worker);
    await callback({ fixture: workerFixture, worker, job, assignment });
  } finally {
    if (workerFixture) {
      try {
        await closeWorkerScope(workerFixture, workerFixture);
      } finally {
        await authFixture.close();
      }
    } else {
      await authFixture.close();
    }
  }
}

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function multipartArtifactBody(
  boundary: string,
  fields: readonly (readonly [string, string])[],
  content: Uint8Array,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="artifact.txt"\r\nContent-Type: text/plain\r\n\r\n`,
    ),
  );
  chunks.push(content);
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  return concatenateBytes(chunks);
}

type SocketResponse = {
  status: number;
  headers: Headers;
  body: Uint8Array;
};

async function writeSocketBytes(
  connection: Deno.Conn,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await connection.write(bytes.subarray(offset));
  }
}

function decodeChunkedBody(body: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const lineBreak = encoder.encode("\r\n");
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    const lineEnd = indexOfBytes(body.subarray(offset), lineBreak);
    if (lineEnd < 0) throw new Error("SOCKET_RESPONSE_CHUNK_SIZE_MISSING");
    const sizeText = decoder.decode(
      body.subarray(offset, offset + lineEnd),
    ).split(";", 1)[0]!;
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("SOCKET_RESPONSE_CHUNK_SIZE_INVALID");
    }
    offset += lineEnd + lineBreak.byteLength;
    if (size === 0) return concatenateBytes(chunks);
    if (offset + size + lineBreak.byteLength > body.byteLength) {
      throw new Error("SOCKET_RESPONSE_CHUNK_TRUNCATED");
    }
    chunks.push(body.slice(offset, offset + size));
    offset += size + lineBreak.byteLength;
  }
  throw new Error("SOCKET_RESPONSE_CHUNK_TERMINATOR_MISSING");
}

async function readSocketResponse(
  connection: Deno.Conn,
): Promise<SocketResponse> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(64 * 1024);
  while (true) {
    const count = await connection.read(buffer);
    if (count === null) break;
    chunks.push(buffer.slice(0, count));
  }
  const raw = concatenateBytes(chunks);
  const headerBoundary = new TextEncoder().encode("\r\n\r\n");
  const headerEnd = indexOfBytes(raw, headerBoundary);
  if (headerEnd < 0) throw new Error("SOCKET_RESPONSE_HEADERS_MISSING");
  const headerText = new TextDecoder().decode(raw.subarray(0, headerEnd));
  const lines = headerText.split("\r\n");
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(lines.shift() ?? "")?.[1]);
  if (!Number.isSafeInteger(status)) {
    throw new Error("SOCKET_RESPONSE_STATUS_MISSING");
  }
  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
  }
  const rawBody = raw.subarray(headerEnd + headerBoundary.byteLength);
  const body = headers.get("transfer-encoding")?.toLowerCase().includes(
      "chunked",
    )
    ? decodeChunkedBody(rawBody)
    : rawBody.slice(
      0,
      headers.get("content-length") === null
        ? rawBody.byteLength
        : Number(headers.get("content-length")),
    );
  return { status, headers, body };
}

async function sendChunkedSocketRequest(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
): Promise<SocketResponse> {
  const connection = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const encoder = new TextEncoder();
    const requestHeaders = [
      `POST ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Connection: close",
      "Transfer-Encoding: chunked",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n");
    try {
      await writeSocketBytes(connection, encoder.encode(requestHeaders));
      for (let offset = 0; offset < body.byteLength; offset += 64 * 1024) {
        const chunk = body.subarray(offset, offset + 64 * 1024);
        await writeSocketBytes(
          connection,
          encoder.encode(`${chunk.byteLength.toString(16)}\r\n`),
        );
        await writeSocketBytes(connection, chunk);
        await writeSocketBytes(connection, encoder.encode("\r\n"));
      }
      await writeSocketBytes(connection, encoder.encode("0\r\n\r\n"));
    } catch {
      // The bounded server may cancel an oversize stream before its sender ends.
    }
    return await readSocketResponse(connection);
  } finally {
    connection.close();
  }
}

async function serveAppOnSocket(
  fixture: Pick<WorkerFixture, "app">,
): Promise<{ port: number; close(): Promise<void> }> {
  let resolvePort: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => resolvePort(port),
    },
    (request) => fixture.app.fetch(request),
  );
  return {
    port: await listening,
    close: () => server.shutdown(),
  };
}

type ImportScenarioIds = {
  organizationId: string;
  providerUserId: string;
  principalId: string;
  applicationId: string;
  conversationId: string;
  repositoryId: string;
  taskId: string;
  artifactId: string;
};

type ImportFixture = {
  app: { fetch(request: Request): Response | Promise<Response> };
  pgDatabase: PgDatabase;
  runtimePgDatabase: PgDatabase;
  close(): Promise<void>;
};

type ImportScenario = {
  fixture: ImportFixture;
  ids: ImportScenarioIds;
  gitFixture: VerifiedBareRepository;
  cookie: string;
};

async function withImportScenario(
  callback: (scenario: ImportScenario) => Promise<void>,
  contentText = "trusted import fixture\n",
  options: ImportScenarioOptions = {},
): Promise<void> {
  const ids: ImportScenarioIds = {
    organizationId: crypto.randomUUID(),
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
  };
  const gitFixture = await createVerifiedBareRepository(contentText, options);
  const previousConfig = Deno.env.get(TRUSTED_REPOSITORIES_ENV);
  try {
    await options.prepareRepository?.(gitFixture);
    const trustedRepositoriesJson = await trustedConfig(
      ids.organizationId,
      ids.applicationId,
      ids.repositoryId,
      options.repositoryPath === "workGitDir"
        ? `${gitFixture.root}/work/.git`
        : gitFixture.bareRepositoryPath,
      gitFixture.commitSha,
    );
    Deno.env.set(TRUSTED_REPOSITORIES_ENV, trustedRepositoriesJson);
    const fixture = await openAuthFixture();
    try {
      const cookie = await seedAuthenticatedImportGraph(fixture, ids);
      await callback({
        fixture,
        ids,
        gitFixture,
        cookie,
      });
    } finally {
      try {
        await cleanupAuthFixture(fixture.pgDatabase, [
          `issue44-developer-${ids.organizationId}@example.test`,
        ]);
        await fixture.pgDatabase.query(
          `delete from bakery.organizations where id = $1`,
          [ids.organizationId],
        );
        await fixture.pgDatabase.query(
          `delete from public.organization where id = $1`,
          [ids.organizationId],
        );
      } finally {
        await fixture.close();
      }
    }
  } finally {
    if (previousConfig === undefined) {
      Deno.env.delete(TRUSTED_REPOSITORIES_ENV);
    } else {
      Deno.env.set(TRUSTED_REPOSITORIES_ENV, previousConfig);
    }
    await subprocess("rm", ["-rf", gitFixture.root]);
  }
}

async function createReplacementCommit(
  gitFixture: VerifiedBareRepository,
): Promise<{
  commitSha: string;
  blobSha: string;
  content: Uint8Array;
}> {
  const replacementContent = new TextEncoder().encode(
    "replacement import fixture\n",
  );
  const work = `${gitFixture.root}/work`;
  await subprocess(
    "sh",
    [
      "-c",
      "printf '%s\\n' 'replacement import fixture' > \"$1\"",
      "issue44-replacement",
      `${work}/src/readme.txt`,
    ],
  );
  await git(["add", "src/readme.txt"], work);
  await git(["commit", "-m", "replacement import fixture"], work);
  await git([
    "--git-dir",
    gitFixture.bareRepositoryPath,
    "fetch",
    work,
    "HEAD:refs/heads/issue44-replacement",
  ]);
  const commitSha = await git([
    "--git-dir",
    gitFixture.bareRepositoryPath,
    "rev-parse",
    "refs/heads/issue44-replacement",
  ]);
  const blobSha = await git([
    "--git-dir",
    gitFixture.bareRepositoryPath,
    "rev-parse",
    `${commitSha}:src/readme.txt`,
  ]);
  assert(commitSha !== gitFixture.commitSha);
  assert(blobSha !== gitFixture.blobSha);
  return { commitSha, blobSha, content: replacementContent };
}

async function waitForImportRowLockWait(
  database: PgDatabase,
  blockingPid: number,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const waiting = await database.query<{ waitingPid: number }>(
      `select a.pid as "waitingPid"
         from pg_stat_activity as a
        where a.datname = current_database()
          and a.backend_type = 'client backend'
          and a.wait_event_type = 'Lock'
          and $1 = any(pg_blocking_pids(a.pid))
        limit 1`,
      [blockingPid],
    );
    if (waiting.rows[0] !== undefined) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("IMPORT_ROW_LOCK_WAIT_NOT_OBSERVED");
}

Deno.test(
  "worker publication replays raw MIME fingerprints across stale leases",
  async () => {
    await withWorkerArtifactScenario(
      async ({ fixture, worker, job, assignment }) => {
        const content = new TextEncoder().encode(
          "raw MIME worker publication\n",
        );
        const contentType = "text/plain; charset=UTF-8";
        const artifactName = "raw-mime-worker";
        const metadata = {
          source: "issue44-raw-mime",
          immutable: true,
        };
        const idempotencyKey = `issue44-raw-mime-${crypto.randomUUID()}`;
        const form = (
          bytes = content,
          formMetadata: Record<string, unknown> = metadata,
        ): FormData => {
          const value = new FormData();
          value.set("leaseToken", assignment.leaseToken);
          value.set("fence", assignment.fence);
          value.set("workerSessionId", worker.registration.workerSessionId);
          value.set(
            "workerSessionGeneration",
            String(worker.registration.workerSessionGeneration),
          );
          value.set("artifactType", "patch");
          value.set("name", artifactName);
          value.set("contentType", contentType);
          value.set("metadata", JSON.stringify(formMetadata));
          value.set("runStepId", job.runStepId);
          value.set("stepKey", "worker");
          value.set("content", new File([bytes], "raw-mime.txt"));
          return value;
        };
        const send = (
          key = idempotencyKey,
          bytes = content,
          formMetadata: Record<string, unknown> = metadata,
        ) =>
          fixture.app.fetch(
            new Request(
              `${fixture.config.publicBaseUrl}/v1/worker/attempts/${assignment.attemptId}/artifacts`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${worker.credential}`,
                  "idempotency-key": key,
                  "X-Bakery-Worker-Protocol-Version": "2",
                },
                body: form(bytes, formMetadata),
              },
            ),
          );
        const requestDigestFor = async (
          key: string,
          bytes: Uint8Array,
          formMetadata: Record<string, unknown>,
        ): Promise<string> =>
          await sha256Hex(
            canonicalJson({
              idempotencyKey: key,
              leaseTokenHash: await sha256Hex(assignment.leaseToken),
              fence: assignment.fence,
              artifactType: "patch",
              name: artifactName,
              contentType,
              contentDigest: null,
              contentSha256: await sha256Bytes(bytes),
              runStepId: job.runStepId,
              subjectHeadSha: null,
              subjectBaseSha: null,
              stepKey: "worker",
              parentVersionId: null,
              metadata: formMetadata,
            }),
          );
        const publicationFacts = async () =>
          await fixture.pgDatabase.query<{
            artifacts: number;
            versions: number;
            events: number;
            outbox: number;
            replays: number;
          }>(
            `select
               (select count(*)::int from bakery.artifacts
                 where organization_id=$1 and task_id=$2
                   and artifact_type='patch' and name=$3) as artifacts,
               (select count(*)::int from bakery.artifact_versions
                 where organization_id=$1 and task_id=$2) as versions,
               (select count(*)::int from bakery.domain_events
                 where organization_id=$1 and task_id=$2
                   and event_type='artifact.version_created') as events,
               (select count(*)::int
                  from bakery.outbox as o
                  join bakery.domain_events as e
                    on e.id=o.event_id and e.organization_id=o.organization_id
                 where o.organization_id=$1 and e.task_id=$2
                   and e.event_type='artifact.version_created') as outbox,
               (select count(*)::int
                  from bakery.artifact_publication_replays
                 where organization_id=$1 and attempt_id=$4) as replays`,
            [
              fixture.organizationId,
              job.taskId,
              artifactName,
              assignment.attemptId,
            ],
          );

        const first = await send();
        assertEquals(first.status, 201, await first.clone().text());
        const firstRaw = await first.text();
        const firstReceipt = contractSchemas.ArtifactVersion.parse(
          JSON.parse(firstRaw),
        );
        const expectedRequestDigest = await requestDigestFor(
          idempotencyKey,
          content,
          metadata,
        );
        const originalReplay = await fixture.pgDatabase.query<{
          requestDigest: string;
          response: Record<string, unknown>;
        }>(
          `select request_digest as "requestDigest", response
             from bakery.artifact_publication_replays
            where organization_id=$1 and attempt_id=$2 and idempotency_key=$3`,
          [fixture.organizationId, assignment.attemptId, idempotencyKey],
        );
        assertEquals(originalReplay.rows, [{
          requestDigest: expectedRequestDigest,
          response: firstReceipt,
        }]);
        assertEquals((await publicationFacts()).rows, [{
          artifacts: 1,
          versions: 1,
          events: 1,
          outbox: 1,
          replays: 1,
        }]);

        await fixture.pgDatabase.query(
          `update bakery.job_attempts
              set lease_expires_at=clock_timestamp() - interval '1 second'
            where organization_id=$1 and id=$2`,
          [fixture.organizationId, assignment.attemptId],
        );
        const replay = await send();
        assertEquals(replay.status, 201, await replay.clone().text());
        assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
        assertEquals(await replay.json(), firstReceipt);

        const mismatch = await send(
          idempotencyKey,
          new TextEncoder().encode("changed raw MIME worker publication\n"),
        );
        assertEquals(mismatch.status, 422, await mismatch.clone().text());
        assertEquals(
          await problemCode(mismatch),
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
        );

        const forgedMetadata = { ...metadata, path: "src/forged.txt" };
        const forged = await send(
          `issue44-forged-worker-${crypto.randomUUID()}`,
          content,
          forgedMetadata,
        );
        assertEquals(forged.status, 422, await forged.clone().text());
        assertEquals(await problemCode(forged), "UNPROCESSABLE");
        assertEquals((await publicationFacts()).rows, [{
          artifacts: 1,
          versions: 1,
          events: 1,
          outbox: 1,
          replays: 1,
        }]);

        const historicalKey = `issue44-historical-${crypto.randomUUID()}`;
        const historicalMetadata = { path: "src/historical.txt" };
        const historicalReceipt = {
          ...firstReceipt,
          metadata: historicalMetadata,
        };
        await fixture.pgDatabase.query(
          `insert into bakery.artifact_publication_replays (
             organization_id, attempt_id, worker_host_id, idempotency_key,
             request_digest, response
           ) values ($1, $2, $3, $4, $5, $6)`,
          [
            fixture.organizationId,
            assignment.attemptId,
            worker.registration.workerHostId,
            historicalKey,
            await requestDigestFor(
              historicalKey,
              content,
              historicalMetadata,
            ),
            historicalReceipt,
          ],
        );
        const historicalReplay = await send(
          historicalKey,
          content,
          historicalMetadata,
        );
        assertEquals(
          historicalReplay.status,
          201,
          await historicalReplay.clone().text(),
        );
        assertEquals(
          historicalReplay.headers.get("Idempotent-Replayed"),
          "true",
        );
        assertEquals(await historicalReplay.json(), historicalReceipt);
        assertEquals((await publicationFacts()).rows, [{
          artifacts: 1,
          versions: 1,
          events: 1,
          outbox: 1,
          replays: 2,
        }]);
      },
    );
  },
);

Deno.test(
  "Bakery API client accepts authorized weak-list 304 artifact validators",
  async () => {
    await withImportScenario(async ({ fixture, ids, gitFixture, cookie }) => {
      const imported = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          `issue44-client-304-${crypto.randomUUID()}`,
          {
            path: "src/readme.txt",
            commitSha: gitFixture.commitSha,
          },
        ),
      );
      assertEquals(imported.status, 201, await imported.clone().text());
      const version = contractSchemas.ArtifactVersion.parse(
        await imported.json(),
      );
      let observed: Response | undefined;
      const client = createBakeryApiClient({
        baseUrl: authTestOrigin,
        fetchImpl: (async (input, init) => {
          const request = new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set("cookie", cookie);
          headers.set("origin", authTestOrigin);
          const response = await fixture.app.fetch(
            new Request(request, { headers }),
          );
          observed = response;
          return response.clone();
        }) as typeof fetch,
      });
      for (
        const ifNoneMatch of [
          `W/"${version.sha256}"`,
          `"${"0".repeat(64)}", W/"${version.sha256}"`,
        ]
      ) {
        const result = await client.getArtifactContent({
          organizationId: ids.organizationId,
          versionId: version.id,
          ifNoneMatch,
          expectedSha256: version.sha256,
        });
        if (!result.ok) {
          throw new Error(`ARTIFACT_304_CLIENT_FAILED:${result.error.kind}`);
        }
        assertEquals(result.data.status, 304);
        assertEquals(result.data.content, null);
        assertEquals(result.data.contentLength, 0);
        assertEquals(result.data.contentDigest, version.sha256);
        assertExists(observed);
        assertEquals(observed.status, 304);
        assertEquals(
          observed.headers.get("content-length"),
          String(gitFixture.content.byteLength),
        );
        assertEquals((await observed.arrayBuffer()).byteLength, 0);
      }
    });
  },
);

Deno.test(
  "real socket chunked artifact uploads accept bounded bodies and reject overflow",
  async () => {
    await withWorkerArtifactScenario(
      async ({ fixture, worker, job, assignment }) => {
        const listener = await serveAppOnSocket(fixture);
        try {
          const send = async (
            name: string,
            content: Uint8Array,
            idempotencyKey: string,
            metadata = "{}",
          ): Promise<SocketResponse> => {
            const boundary = `issue44-${
              crypto.randomUUID().replaceAll("-", "")
            }`;
            const body = multipartArtifactBody(boundary, [
              ["leaseToken", assignment.leaseToken],
              ["fence", assignment.fence],
              ["workerSessionId", worker.registration.workerSessionId],
              [
                "workerSessionGeneration",
                String(worker.registration.workerSessionGeneration),
              ],
              ["artifactType", "patch"],
              ["name", name],
              ["contentType", "text/plain"],
              ["metadata", metadata],
              ["runStepId", job.runStepId],
              ["stepKey", "worker"],
            ], content);
            return await sendChunkedSocketRequest(
              listener.port,
              `/v1/worker/attempts/${assignment.attemptId}/artifacts`,
              {
                authorization: `Bearer ${worker.credential}`,
                "idempotency-key": idempotencyKey,
                "X-Bakery-Worker-Protocol-Version": "2",
                "content-type": `multipart/form-data; boundary=${boundary}`,
              },
              body,
            );
          };

          const bounded = await send(
            "socket-bounded",
            new TextEncoder().encode("bounded chunked artifact\n"),
            `issue44-socket-bounded-${crypto.randomUUID()}`,
          );
          assertEquals(bounded.status, 201);
          const boundedReceipt = contractSchemas.ArtifactVersion.parse(
            JSON.parse(new TextDecoder().decode(bounded.body)),
          );
          assertEquals(boundedReceipt.mediaType, "text/plain");

          const oversized = await send(
            "socket-oversized",
            new Uint8Array(MAX_ARTIFACT_BYTES + 1_048_577).fill(0x61),
            `issue44-socket-oversized-${crypto.randomUUID()}`,
          );
          assertEquals(oversized.status, 413);
          const oversizedProblem = JSON.parse(
            new TextDecoder().decode(oversized.body),
          );
          assert(
            oversizedProblem !== null &&
              typeof oversizedProblem === "object" &&
              !Array.isArray(oversizedProblem),
          );
          assertEquals(
            "code" in oversizedProblem ? oversizedProblem.code : undefined,
            "BODY_TOO_LARGE",
          );

          const nestedMetadata = `{"x":${"[".repeat(15_000)}0${
            "]".repeat(15_000)
          }}`;
          const invalidDepth = await send(
            "socket-invalid-depth",
            new TextEncoder().encode("no publication"),
            `issue44-socket-invalid-depth-${crypto.randomUUID()}`,
            nestedMetadata,
          );
          assertEquals(invalidDepth.status, 422);
          assertEquals(
            JSON.parse(new TextDecoder().decode(invalidDepth.body)).code,
            "UNPROCESSABLE",
          );

          const state = await fixture.pgDatabase.query<{
            artifacts: number;
            versions: number;
            events: number;
            outbox: number;
            replays: number;
          }>(
            `select
               (select count(*)::int from bakery.artifacts
                 where organization_id=$1 and task_id=$2) as artifacts,
               (select count(*)::int from bakery.artifact_versions
                 where organization_id=$1 and task_id=$2) as versions,
               (select count(*)::int from bakery.domain_events
                 where organization_id=$1 and task_id=$2
                   and event_type='artifact.version_created') as events,
               (select count(*)::int
                  from bakery.outbox as o
                  join bakery.domain_events as e
                    on e.id=o.event_id and e.organization_id=o.organization_id
                 where o.organization_id=$1 and e.task_id=$2
                   and e.event_type='artifact.version_created') as outbox,
               (select count(*)::int
                  from bakery.artifact_publication_replays
                 where organization_id=$1 and attempt_id=$3) as replays`,
            [
              fixture.organizationId,
              job.taskId,
              assignment.attemptId,
            ],
          );
          assertEquals(state.rows, [{
            artifacts: 1,
            versions: 1,
            events: 1,
            outbox: 1,
            replays: 1,
          }]);
        } finally {
          await listener.close();
        }
      },
    );
  },
);

Deno.test("artifact import rejects untrusted Git proof before persistence", async () => {
  const scenarios: Array<{
    name: string;
    options: ImportScenarioOptions;
    corruptObject?: boolean;
  }> = [
    {
      name: "nonbare",
      options: { repositoryPath: "workGitDir" },
    },
    {
      name: "shallow",
      options: {
        prepareRepository: async ({ bareRepositoryPath, commitSha }) => {
          await Deno.writeTextFile(
            `${bareRepositoryPath}/shallow`,
            `${commitSha}\n`,
          );
        },
      },
    },
    {
      name: "altered-commit",
      corruptObject: true,
      options: {
        prepareRepository: async ({ bareRepositoryPath, commitSha }) => {
          const original = await gitBytes([
            "--git-dir",
            bareRepositoryPath,
            "cat-file",
            "commit",
            commitSha,
          ]);
          const suffix = new TextEncoder().encode("\ncorrupt-proof");
          const altered = new Uint8Array(
            original.byteLength + suffix.byteLength,
          );
          altered.set(original);
          altered.set(suffix, original.byteLength);
          await writeLooseGitObject(
            bareRepositoryPath,
            commitSha,
            "commit",
            altered,
          );
        },
      },
    },
    {
      name: "altered-tree",
      corruptObject: true,
      options: {
        prepareRepository: async ({ bareRepositoryPath, treeSha }) => {
          const original = await gitBytes([
            "--git-dir",
            bareRepositoryPath,
            "cat-file",
            "tree",
            treeSha,
          ]);
          const src = new TextEncoder().encode("src");
          const offset = indexOfBytes(original, src);
          assert(offset >= 0);
          const altered = original.slice();
          altered[offset + 2] = 0x61;
          await writeLooseGitObject(
            bareRepositoryPath,
            treeSha,
            "tree",
            altered,
          );
        },
      },
    },
  ];
  for (const scenario of scenarios) {
    await withImportScenario(
      async ({ fixture, ids, gitFixture, cookie }) => {
        const rejected = await fixture.app.fetch(
          importRequest(
            cookie,
            ids.organizationId,
            ids.artifactId,
            `issue44-git-proof-${scenario.name}-${crypto.randomUUID()}`,
            {
              path: "src/readme.txt",
              commitSha: gitFixture.commitSha,
            },
          ),
        );
        const problem = await rejected.json() as { code?: string };
        if (scenario.corruptObject) {
          assert(
            rejected.status === 422 || rejected.status === 503,
            `${scenario.name}: unexpected status ${rejected.status}`,
          );
          assertEquals(
            problem.code,
            rejected.status === 422
              ? "UNPROCESSABLE"
              : "DEPENDENCY_UNAVAILABLE",
            scenario.name,
          );
        } else {
          assertEquals(rejected.status, 422, scenario.name);
          assertEquals(problem.code, "UNPROCESSABLE", scenario.name);
        }
        await assertNoAcceptedImportState(fixture, ids);
      },
      undefined,
      scenario.options,
    );
  }
});

Deno.test("generated client imports uppercase and mixed-case SHA commits larger than 16 KiB", async () => {
  await withImportScenario(
    async ({ fixture, ids, gitFixture, cookie }) => {
      const commitSize = Number(
        await git([
          "--git-dir",
          gitFixture.bareRepositoryPath,
          "cat-file",
          "-s",
          gitFixture.commitSha,
        ]),
      );
      assert(commitSize > 16 * 1024 && commitSize < 1024 * 1024);
      const client = createBakeryApiClient({
        baseUrl: authTestOrigin,
        fetchImpl: (async (input, init) => {
          const request = new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set("cookie", cookie);
          headers.set("origin", authTestOrigin);
          return await fixture.app.fetch(new Request(request, { headers }));
        }) as typeof fetch,
      });
      const uppercaseSha = gitFixture.commitSha.toUpperCase();
      const mixedSha = gitFixture.commitSha.replace(
        /[a-f]/,
        (letter) => letter.toUpperCase(),
      );
      assert(mixedSha !== gitFixture.commitSha && mixedSha !== uppercaseSha);
      for (
        const [index, commitSha] of [uppercaseSha, mixedSha].entries()
      ) {
        const imported = await client.importArtifactVersion({
          organizationId: ids.organizationId,
          artifactId: ids.artifactId,
          input: { path: "src/readme.txt", commitSha },
          ifMatch: `"v${index + 1}"`,
          idempotencyKey: `issue44-client-sha-${index}-${crypto.randomUUID()}`,
        });
        if (!imported.ok) {
          throw new Error(
            `GENERATED_CLIENT_IMPORT_FAILED:${imported.error.kind}`,
          );
        }
        assertEquals(
          imported.data.sha256,
          await sha256Bytes(gitFixture.content),
        );
        assertEquals(imported.data.subjectHeadSha, gitFixture.commitSha);
      }
      assertEquals(await importFactCounts(fixture, ids), {
        versions: 2,
        events: 2,
        outbox: 2,
        audits: 2,
        idempotency: 2,
      });
    },
    "trusted import fixture\n",
    { largeCommitMessage: true },
  );
});

Deno.test("a pinned text artifact beginning with a passive markup fragment remains importable", async () => {
  for (
    const passiveText of [
      '<p align="center">project</p>',
      '<div align="center"><img src="badge.png"></div>',
      "<table><tr><td>status</td></tr></table>",
    ]
  ) {
    await withImportScenario(
      async ({ fixture, ids, gitFixture, cookie }) => {
        const imported = await fixture.app.fetch(
          importRequest(
            cookie,
            ids.organizationId,
            ids.artifactId,
            `issue44-passive-text-${crypto.randomUUID()}`,
            { path: "src/readme.txt", commitSha: gitFixture.commitSha },
          ),
        );
        assertEquals(imported.status, 201, await imported.clone().text());
        const version = contractSchemas.ArtifactVersion.parse(
          await imported.json(),
        );
        assertEquals(version.mediaType, "text/plain");
        assertEquals(version.sha256, await sha256Bytes(gitFixture.content));
        assertEquals(await importFactCounts(fixture, ids), {
          versions: 1,
          events: 1,
          outbox: 1,
          audits: 1,
          idempotency: 1,
        });
      },
      passiveText,
    );
  }
});

Deno.test("active HTML or SVG disguised as safe Git text cannot create import facts", async () => {
  for (
    const activeDocument of [
      '<div onclick="alert(1)">content</div>',
      '<img src=x onerror="alert(1)">',
      '<!-- README -->\n<div title=">"><img src=x onerror="alert(1)"></div>',
      "<div><!--><img src=x onerror=alert(1)></div>",
      '<div><img src="x"onerror="alert(1)"></div>',
      "<!--><img src=x onerror=alert(1)><!-- -->",
      "<img src=x' onerror=alert(1)>",
      "<x-widget_demo onclick=alert(1)>click</x-widget_demo>",
      '<?<x title="><img src=x onerror=alert(1)>">',
      `</div title="<x title='>"><img src=x onerror=alert(1)>'>`,
      '</?<x title="><img src=x onerror=alert(1)>">',
      '<textarea><x title="</textarea><img src=x onerror=alert(1)>">',
      '<xmp><x title="</xmp><img src=x onerror=alert(1)>">',
      '<math><![CDATA[><x title="]]></math><img src=x onerror=alert(1)>">',
      `<p>README</p><!doctype html public "><x title='"><img src=x onerror=alert(1)>'>`,
      '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>run()</s:script></s:svg>',
      '<_s:svg xmlns:_s="http://www.w3.org/2000/svg"><_s:script>run()</_s:script></_s:svg>',
      '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    ]
  ) {
    await withImportScenario(
      async ({ fixture, ids, gitFixture, cookie }) => {
        const rejected = await fixture.app.fetch(
          importRequest(
            cookie,
            ids.organizationId,
            ids.artifactId,
            `issue44-active-polyglot-${crypto.randomUUID()}`,
            { path: "src/readme.txt", commitSha: gitFixture.commitSha },
          ),
        );
        assertEquals(rejected.status, 422, await rejected.clone().text());
        assertEquals(await problemCode(rejected), "UNPROCESSABLE");
        await assertNoAcceptedImportState(fixture, ids);
      },
      activeDocument,
    );
  }
});

Deno.test("archived tasks and applications cannot accept a trusted Git import", async () => {
  await withImportScenario(async ({ fixture, ids, gitFixture, cookie }) => {
    const importAfterArchive = async (scope: string) => {
      const response = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          `issue44-archived-${scope}-${crypto.randomUUID()}`,
          { path: "src/readme.txt", commitSha: gitFixture.commitSha },
        ),
      );
      assertEquals(response.status, 404, await response.clone().text());
      assertEquals(await problemCode(response), "RESOURCE_NOT_FOUND");
      await assertNoAcceptedImportState(fixture, ids);
    };
    await fixture.pgDatabase.query(
      `update bakery.tasks set archived_at = now() where id = $1`,
      [ids.taskId],
    );
    await importAfterArchive("task");
    await fixture.pgDatabase.query(
      `update bakery.tasks set archived_at = null where id = $1`,
      [ids.taskId],
    );
    await fixture.pgDatabase.query(
      `update bakery.applications set archived_at = now() where id = $1`,
      [ids.applicationId],
    );
    await importAfterArchive("application");
  });
});

Deno.test("application archival winning the import scope lock leaves no import facts", async () => {
  await withImportScenario(async ({ fixture, ids, gitFixture, cookie }) => {
    const lockHolder = await fixture.pgDatabase.connect();
    let transactionOpen = false;
    let pendingImport: Promise<Response> | undefined;
    try {
      await lockHolder.query("begin");
      transactionOpen = true;
      const pidResult = await lockHolder.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const blockingPid = pidResult.rows[0]?.pid;
      if (typeof blockingPid !== "number") {
        throw new Error("APPLICATION_LOCK_BACKEND_PID_NOT_OBSERVED");
      }
      await lockHolder.query(
        `select id from bakery.applications
          where organization_id=$1 and id=$2 for update`,
        [ids.organizationId, ids.applicationId],
      );
      pendingImport = Promise.resolve(fixture.app.fetch(
        new Request(
          importRequest(
            cookie,
            ids.organizationId,
            ids.artifactId,
            `issue44-archive-race-${crypto.randomUUID()}`,
            { path: "src/readme.txt", commitSha: gitFixture.commitSha },
          ),
          { signal: AbortSignal.timeout(30_000) },
        ),
      ));
      // Observe the app-role import waiting on the application row before
      // archival commits; preflight's unlocked scope read is not authority.
      await waitForImportRowLockWait(fixture.runtimePgDatabase, blockingPid);
      await lockHolder.query(
        `update bakery.applications set archived_at=current_timestamp
          where organization_id=$1 and id=$2`,
        [ids.organizationId, ids.applicationId],
      );
      await lockHolder.query("commit");
      transactionOpen = false;
      const denied = await pendingImport;
      pendingImport = undefined;
      assertEquals(denied.status, 404, await denied.clone().text());
      assertEquals(await problemCode(denied), "RESOURCE_NOT_FOUND");
      await assertNoAcceptedImportState(fixture, ids);
    } finally {
      if (transactionOpen) {
        await lockHolder.query("rollback").catch(() => undefined);
      }
      if (pendingImport) await pendingImport.catch(() => undefined);
      lockHolder.release();
    }
  });
});

Deno.test("pinned SVG with a doctype imports as attachment-only and cannot be extracted", async () => {
  const svg =
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';
  await withImportScenario(
    async ({ fixture, ids, gitFixture, cookie }) => {
      const imported = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          `issue44-svg-${crypto.randomUUID()}`,
          { path: "src/asset.svg", commitSha: gitFixture.commitSha },
        ),
      );
      assertEquals(imported.status, 201, await imported.clone().text());
      const version = contractSchemas.ArtifactVersion.parse(
        await imported.json(),
      );
      assertEquals(version.mediaType, "image/svg+xml");
      const content = await fixture.app.fetch(
        new Request(
          `${authTestOrigin}/v1/artifact-versions/${version.id}/content`,
          {
            headers: {
              cookie,
              "Bakery-Organization-Id": ids.organizationId,
            },
          },
        ),
      );
      assertEquals(content.status, 200, await content.clone().text());
      assertEquals(content.headers.get("content-type"), "image/svg+xml");
      assertEquals(content.headers.get("x-content-type-options"), "nosniff");
      assertEquals(content.headers.get("content-security-policy"), "sandbox");
      assertEquals(
        content.headers.get("content-disposition"),
        'attachment; filename="artifact.bin"',
      );
      assertEquals(await content.text(), svg);
      const extraction = await fixture.app.fetch(
        new Request(
          `${authTestOrigin}/v1/artifact-versions/${version.id}/extract?maxBytes=65536`,
          {
            headers: {
              cookie,
              "Bakery-Organization-Id": ids.organizationId,
            },
          },
        ),
      );
      assertEquals(extraction.status, 422);
      assertEquals(await problemCode(extraction), "UNPROCESSABLE");
    },
    svg,
    { svgFile: true },
  );
});

Deno.test("human import and worker publication commit real scoped facts", async () => {
  const ids = {
    organizationId: crypto.randomUUID(),
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
  };
  const gitFixture = await createVerifiedBareRepository(
    "trusted import fixture\n",
    { largeRootTree: true },
  );
  assert(
    Number(
      await git([
        "--git-dir",
        gitFixture.bareRepositoryPath,
        "cat-file",
        "-s",
        gitFixture.treeSha,
      ]),
    ) > 16 * 1024,
  );
  const previousConfig = Deno.env.get(TRUSTED_REPOSITORIES_ENV);
  const trustedRepositoriesJson = await trustedConfig(
    ids.organizationId,
    ids.applicationId,
    ids.repositoryId,
    gitFixture.bareRepositoryPath,
    gitFixture.commitSha,
  );
  const trustedRepositories = JSON.parse(trustedRepositoriesJson) as {
    entries: Array<{ mappingDigest: string }>;
  };
  try {
    Deno.env.set(TRUSTED_REPOSITORIES_ENV, trustedRepositoriesJson);
    const fixture = await openAuthFixture();
    try {
      await publishWorkerArtifact(fixture);
      const cookie = await seedAuthenticatedImportGraph(fixture, ids);
      const body = {
        path: "src/readme.txt",
        commitSha: gitFixture.commitSha,
      };
      const zeroFacts = {
        versions: 0,
        events: 0,
        outbox: 0,
        audits: 0,
        idempotency: 0,
      };
      for (const [index, path] of gitFixture.rejectedPaths.entries()) {
        const rejected = await fixture.app.fetch(
          importRequest(
            cookie,
            ids.organizationId,
            ids.artifactId,
            `issue44-rejected-${index}-${crypto.randomUUID()}`,
            { path, commitSha: gitFixture.commitSha },
          ),
        );
        assertEquals(rejected.status, 422, await rejected.clone().text());
        assertEquals(
          (await rejected.json() as { code?: string }).code,
          "UNPROCESSABLE",
        );
        assertEquals(await importFactCounts(fixture, ids), zeroFacts);
      }
      for (
        const [index, ifMatch] of [
          ["weak", 'W/"v1"'],
          ["malformed", "v1"],
        ] as const
      ) {
        const rejected = await fixture.app.fetch(
          importRequest(
            cookie,
            ids.organizationId,
            ids.artifactId,
            `issue44-if-match-${index}-${crypto.randomUUID()}`,
            body,
            ifMatch,
          ),
        );
        assertEquals(rejected.status, 428, await rejected.clone().text());
        assertEquals(
          (await rejected.json() as { code?: string }).code,
          "PRECONDITION_REQUIRED",
        );
        assertEquals(await importFactCounts(fixture, ids), zeroFacts);
      }
      const key = `issue44-import-${crypto.randomUUID()}`;
      const requestId = `issue44-request-${crypto.randomUUID()}`;
      const importedRequest = importRequest(
        cookie,
        ids.organizationId,
        ids.artifactId,
        key,
        body,
        '"v1"',
      );
      importedRequest.headers.set("X-Request-Id", requestId);
      const imported = await fixture.app.fetch(importedRequest);
      assertEquals(imported.status, 201, await imported.clone().text());
      const importedBody = await imported.json() as Record<string, unknown>;
      assertEquals(importedBody.authorId, ids.principalId);
      assertEquals(importedBody.runStepId, null);
      assertEquals(importedBody.sha256, await sha256Bytes(gitFixture.content));
      assertEquals(
        importedBody.metadata,
        {
          sourceRepositoryId: ids.repositoryId,
          path: body.path,
          commitSha: gitFixture.commitSha,
        },
      );

      const unavailableBarePath =
        `${gitFixture.bareRepositoryPath}.replay-unavailable`;
      await subprocess("mv", [
        gitFixture.bareRepositoryPath,
        unavailableBarePath,
      ]);
      let replay: Response;
      try {
        replay = await fixture.app.fetch(
          importRequest(
            cookie,
            ids.organizationId,
            ids.artifactId,
            key,
            body,
            '"v1"',
          ),
        );
      } finally {
        await subprocess("mv", [
          unavailableBarePath,
          gitFixture.bareRepositoryPath,
        ]);
      }
      assertEquals(replay.status, 201, await replay.clone().text());
      assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
      const replayBody = await replay.json() as Record<string, unknown>;
      assertEquals(replayBody, importedBody);
      assertEquals(await importFactCounts(fixture, ids), {
        versions: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      });

      const mismatch = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          key,
          body,
          '"v2"',
        ),
      );
      assertEquals(mismatch.status, 422, await mismatch.clone().text());
      assertEquals(
        (await mismatch.json() as { code?: string }).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      assertEquals(await importFactCounts(fixture, ids), {
        versions: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      });

      const facts = await fixture.pgDatabase.query<{
        versions: number;
        events: number;
        outbox: number;
        audit: number;
        idempotency: number;
        runStepId: string | null;
        authorId: string;
        currentVersionId: string | null;
        auditDetails: Record<string, unknown> | null;
        auditOperation: string | null;
        auditResourceType: string | null;
        auditResourceId: string | null;
        auditRequestId: string | null;
        auditTraceId: string | null;
      }>(
        `select
           (select count(*)::int from bakery.artifact_versions
             where organization_id=$1 and artifact_id=$2) as versions,
           (select count(*)::int from bakery.domain_events
             where organization_id=$1 and aggregate_id=$2
               and event_type='artifact.version_created') as events,
           (select count(*)::int
              from bakery.outbox as o
              join bakery.domain_events as e
                on e.id=o.event_id and e.organization_id=o.organization_id
             where o.organization_id=$1 and e.aggregate_id=$2
               and e.event_type='artifact.version_created') as outbox,
           (select count(*)::int from bakery.audit_events
             where organization_id=$1 and operation='artifactVersions.import'
               and resource_type='artifact_version'
               and resource_id=$5 and request_id=$6) as audit,
           (select count(*)::int from bakery.idempotency_records
             where organization_id=$1 and principal_id=$3
               and operation='artifactVersions.import' and key=$4) as idempotency,
           (select run_step_id from bakery.artifact_versions
             where organization_id=$1 and artifact_id=$2) as "runStepId",
           (select author_id from bakery.artifact_versions
             where organization_id=$1 and artifact_id=$2) as "authorId",
           (select current_version_id from bakery.artifacts
             where organization_id=$1 and id=$2) as "currentVersionId",
           (select operation from bakery.audit_events
             where organization_id=$1 and operation='artifactVersions.import'
               and resource_type='artifact_version'
               and resource_id=$5 and request_id=$6
             order by created_at desc, id desc limit 1) as "auditOperation",
           (select resource_type from bakery.audit_events
             where organization_id=$1 and operation='artifactVersions.import'
               and resource_type='artifact_version'
               and resource_id=$5 and request_id=$6
             order by created_at desc, id desc limit 1) as "auditResourceType",
           (select resource_id from bakery.audit_events
             where organization_id=$1 and operation='artifactVersions.import'
               and resource_type='artifact_version'
               and resource_id=$5 and request_id=$6
             order by created_at desc, id desc limit 1) as "auditResourceId",
           (select request_id from bakery.audit_events
             where organization_id=$1 and operation='artifactVersions.import'
               and resource_type='artifact_version'
               and resource_id=$5 and request_id=$6
             order by created_at desc, id desc limit 1) as "auditRequestId",
           (select trace_id from bakery.audit_events
             where organization_id=$1 and operation='artifactVersions.import'
               and resource_type='artifact_version'
               and resource_id=$5 and request_id=$6
             order by created_at desc, id desc limit 1) as "auditTraceId",
           (select details from bakery.audit_events
             where organization_id=$1 and operation='artifactVersions.import'
               and resource_type='artifact_version'
               and resource_id=$5 and request_id=$6
             order by created_at desc, id desc limit 1) as "auditDetails"`,
        [
          ids.organizationId,
          ids.artifactId,
          ids.principalId,
          key,
          importedBody.id,
          requestId,
        ],
      );
      assertEquals(facts.rows[0]?.versions, 1);
      assertEquals(facts.rows[0]?.events, 1);
      assertEquals(facts.rows[0]?.outbox, 1);
      assertEquals(facts.rows[0]?.audit, 1);
      assertEquals(facts.rows[0]?.idempotency, 1);
      assertEquals(facts.rows[0]?.runStepId, null);
      assertEquals(facts.rows[0]?.authorId, ids.principalId);
      assertExists(facts.rows[0]?.currentVersionId);
      assertEquals(
        facts.rows[0]?.auditOperation,
        "artifactVersions.import",
      );
      assertEquals(facts.rows[0]?.auditResourceType, "artifact_version");
      assertEquals(facts.rows[0]?.auditResourceId, importedBody.id);
      assertEquals(facts.rows[0]?.auditRequestId, requestId);
      assertExists(facts.rows[0]?.auditTraceId);
      assertEquals(
        Object.keys(facts.rows[0]?.auditDetails ?? {}).sort(),
        [
          "blobSha",
          "canonicalSize",
          "idempotencyKey",
          "commitSha",
          "mappingDigest",
          "mappingRevision",
          "path",
          "repoUuid",
          "sha256",
          "snapshotSha",
        ].sort(),
      );
      assertEquals(facts.rows[0]?.auditDetails?.idempotencyKey, key);
      assertEquals(
        facts.rows[0]?.auditDetails?.mappingRevision,
        "issue44-fixture-1",
      );
      assertEquals(
        facts.rows[0]?.auditDetails?.mappingDigest,
        trustedRepositories.entries[0]?.mappingDigest,
      );
      assertEquals(
        facts.rows[0]?.auditDetails?.snapshotSha,
        gitFixture.commitSha,
      );
      assertEquals(facts.rows[0]?.auditDetails?.blobSha, gitFixture.blobSha);
      assertEquals(
        facts.rows[0]?.auditDetails?.canonicalSize,
        gitFixture.content.byteLength,
      );
      assertEquals(facts.rows[0]?.auditDetails?.repoUuid, ids.repositoryId);
      assertEquals(facts.rows[0]?.auditDetails?.path, body.path);
      assertEquals(
        facts.rows[0]?.auditDetails?.commitSha,
        gitFixture.commitSha,
      );
      assertEquals(
        facts.rows[0]?.auditDetails?.sha256,
        importedBody.sha256,
      );
      assertEquals(
        Object.hasOwn(facts.rows[0]?.auditDetails ?? {}, "bareRepositoryPath"),
        false,
      );
      const secondKey = `issue44-import-second-${crypto.randomUUID()}`;
      const second = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          secondKey,
          body,
          '"v2"',
        ),
      );
      assertEquals(second.status, 201, await second.clone().text());
      const secondBody = await second.json() as Record<string, unknown>;
      assertEquals(secondBody.authorId, ids.principalId);
      assertEquals(secondBody.runStepId, null);
      assertEquals(secondBody.sha256, importedBody.sha256);
      assertEquals(secondBody.metadata, importedBody.metadata);
      assert(secondBody.id !== importedBody.id);

      const secondReplay = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          secondKey,
          body,
          '"v2"',
        ),
      );
      assertEquals(secondReplay.status, 201, await secondReplay.clone().text());
      assertEquals(secondReplay.headers.get("Idempotent-Replayed"), "true");
      assertEquals(
        await secondReplay.json() as Record<string, unknown>,
        secondBody,
      );

      const secondFacts = await fixture.pgDatabase.query<{
        versions: number;
        events: number;
        outbox: number;
        audits: number;
        idempotency: number;
        currentVersionId: string | null;
      }>(
        `select
           (select count(*)::int from bakery.artifact_versions
             where organization_id=$1 and artifact_id=$2) as versions,
           (select count(*)::int from bakery.domain_events
             where organization_id=$1 and aggregate_id=$2
               and event_type='artifact.version_created') as events,
           (select count(*)::int
              from bakery.outbox as o
              join bakery.domain_events as e
                on e.id=o.event_id and e.organization_id=o.organization_id
             where o.organization_id=$1 and e.aggregate_id=$2
               and e.event_type='artifact.version_created') as outbox,
           (select count(*)::int from bakery.audit_events
             where organization_id=$1
               and operation='artifactVersions.import'
               and resource_type='artifact_version'
               and resource_id in ($6, $7)) as audits,
           (select count(*)::int from bakery.idempotency_records
             where organization_id=$1
               and principal_id=$5
               and operation='artifactVersions.import'
               and key in ($3, $4)) as idempotency,
           (select current_version_id from bakery.artifacts
             where organization_id=$1 and id=$2) as "currentVersionId"`,
        [
          ids.organizationId,
          ids.artifactId,
          key,
          secondKey,
          ids.principalId,
          importedBody.id,
          secondBody.id,
        ],
      );
      assertEquals(secondFacts.rows[0], {
        versions: 2,
        events: 2,
        outbox: 2,
        audits: 2,
        idempotency: 2,
        currentVersionId: secondBody.id,
      });
      const staleFacts = await importFactCounts(fixture, ids);
      const stale = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          `issue44-stale-parent-${crypto.randomUUID()}`,
          body,
          '"v1"',
        ),
      );
      assertEquals(stale.status, 412, await stale.clone().text());
      assertEquals(
        (await stale.json() as { code?: string }).code,
        "PRECONDITION_FAILED",
      );
      assertEquals(await importFactCounts(fixture, ids), staleFacts);

      await fixture.pgDatabase.query(
        `update public.member
            set status='inactive', "updatedAt"=current_timestamp
          where "organizationId"=$1 and "userId"=$2`,
        [ids.organizationId, ids.providerUserId],
      );
      await fixture.pgDatabase.query(
        `update bakery.organization_memberships
            set status='inactive', version=version + 1, updated_at=current_timestamp
          where organization_id=$1 and principal_id=$2`,
        [ids.organizationId, ids.principalId],
      );
      const deniedReplay = await fixture.app.fetch(
        importRequest(cookie, ids.organizationId, ids.artifactId, key, body),
      );
      assertEquals(deniedReplay.status, 404);
      assertEquals(
        (await deniedReplay.json() as { code?: string }).code,
        "RESOURCE_NOT_FOUND",
      );
      await fixture.pgDatabase.query(
        `update public.member
            set status='active', "updatedAt"=current_timestamp
          where "organizationId"=$1 and "userId"=$2`,
        [ids.organizationId, ids.providerUserId],
      );
      await fixture.pgDatabase.query(
        `update bakery.organization_memberships
            set status='active', version=version + 1, updated_at=current_timestamp
          where organization_id=$1 and principal_id=$2`,
        [ids.organizationId, ids.principalId],
      );
      const rollbackArtifactId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.artifacts (
           id, organization_id, task_id, artifact_type, name, revision, version
         ) values ($1, $2, $3, 'source', 'audit-rollback', 1, 1)`,
        [rollbackArtifactId, ids.organizationId, ids.taskId],
      );
      const rollbackKey = `issue44-audit-rollback-${crypto.randomUUID()}`;
      const rollbackRequestId = `issue44-audit-request-${crypto.randomUUID()}`;
      const importContext = {
        organizationId: ids.organizationId,
        principalId: ids.principalId,
        artifactId: rollbackArtifactId,
        requestId: rollbackRequestId,
      };
      const importHeaders = {
        idempotencyKey: rollbackKey,
        ifMatch: '"v1"',
      };
      const resolver = createTrustedRepositoryResolver(
        JSON.parse(trustedRepositoriesJson),
      );
      const preparation = await withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) =>
          prepareArtifactVersionImport(
            transaction,
            importContext,
            importHeaders,
            resolver,
            body,
          ),
      );
      const canceled = new AbortController();
      canceled.abort();
      const canceledProof = await assertRejects(
        () =>
          proveArtifactVersionImport({
            ...preparation,
            context: { ...preparation.context, signal: canceled.signal },
          }),
        StandardError,
      );
      assertEquals(canceledProof.code, "DEPENDENCY_TIMEOUT");
      const proof = await proveArtifactVersionImport(preparation);
      const directFactsBeforeRevocation = await importFactCounts(fixture, {
        ...ids,
        artifactId: rollbackArtifactId,
      });
      await fixture.pgDatabase.query(
        `update bakery.organization_memberships
            set status='inactive', version=version + 1, updated_at=current_timestamp
          where organization_id=$1 and principal_id=$2`,
        [ids.organizationId, ids.principalId],
      );
      try {
        const revokedDirectImport = await assertRejects(
          () =>
            withPgTransaction(
              fixture.runtimePgDatabase,
              (transaction) =>
                importArtifactVersion(
                  transaction,
                  importContext,
                  importHeaders,
                  resolver,
                  body,
                  proof,
                ),
            ),
          StandardError,
        );
        assertEquals(revokedDirectImport.code, "AUTH_FORBIDDEN");
        assertEquals(
          await importFactCounts(fixture, {
            ...ids,
            artifactId: rollbackArtifactId,
          }),
          directFactsBeforeRevocation,
        );
      } finally {
        await fixture.pgDatabase.query(
          `update bakery.organization_memberships
              set status='active', version=version + 1, updated_at=current_timestamp
            where organization_id=$1 and principal_id=$2`,
          [ids.organizationId, ids.principalId],
        );
      }

      const rollbackError = await assertRejects(
        () =>
          withPgTransaction(
            fixture.runtimePgDatabase,
            async (transaction) => {
              const originalQuery = transaction.query.bind(
                transaction,
              ) as unknown as (
                sql: string,
                values?: readonly unknown[],
              ) => Promise<unknown>;
              const intercepted = {
                query: (sql: string, values?: readonly unknown[]) => {
                  if (
                    sql.toLowerCase().includes(
                      "insert into bakery.audit_events",
                    )
                  ) {
                    throw new Error("AUDIT_INSERT_INJECTED");
                  }
                  return originalQuery(sql, values);
                },
              } as unknown as PgTransactionClient;
              return await importArtifactVersion(
                intercepted,
                importContext,
                importHeaders,
                resolver,
                body,
                proof,
              );
            },
          ),
        Error,
      );
      assertEquals(rollbackError.message, "AUDIT_INSERT_INJECTED");
      // This direct helper transaction bypasses ActionRegistry replay storage.
      // The command runner inserts replay rows only after handler success; the
      // HTTP path above proves idempotency rows and replay deduplication.
      // This rollback assertion stays limited to facts created by the helper.
      const rollbackFacts = await fixture.pgDatabase.query<{
        versions: number;
        events: number;
        outbox: number;
        audits: number;
        currentVersionId: string | null;
      }>(
        `select
           (select count(*)::int from bakery.artifact_versions
             where organization_id=$1 and artifact_id=$2) as versions,
           (select count(*)::int from bakery.domain_events
             where organization_id=$1 and aggregate_id=$2) as events,
           (select count(*)::int
              from bakery.outbox as o
              join bakery.domain_events as e
                on e.id=o.event_id and e.organization_id=o.organization_id
             where o.organization_id=$1 and e.aggregate_id=$2
               and e.event_type='artifact.version_created') as outbox,
           (select count(*)::int from bakery.audit_events
             where organization_id=$1 and operation='artifactVersions.import'
               and resource_type='artifact_version' and request_id=$3) as audits,
           (select current_version_id from bakery.artifacts
             where organization_id=$1 and id=$2) as \"currentVersionId\"`,
        [ids.organizationId, rollbackArtifactId, rollbackRequestId],
      );
      assertEquals(rollbackFacts.rows[0], {
        versions: 0,
        events: 0,
        outbox: 0,
        audits: 0,
        currentVersionId: null,
      });
      const raceArtifactId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.artifacts (
           id, organization_id, task_id, artifact_type, name, revision, version
         ) values ($1, $2, $3, 'source', 'proof-race', 1, 1)`,
        [raceArtifactId, ids.organizationId, ids.taskId],
      );
      const raceContext = {
        organizationId: ids.organizationId,
        principalId: ids.principalId,
        artifactId: raceArtifactId,
        requestId: `issue44-proof-race-${crypto.randomUUID()}`,
      };
      const raceHeaders = {
        idempotencyKey: `issue44-stale-proof-${crypto.randomUUID()}`,
        ifMatch: '"v1"',
      };
      const racePreparation = await withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) =>
          prepareArtifactVersionImport(
            transaction,
            raceContext,
            raceHeaders,
            resolver,
            body,
          ),
      );
      const raceProof = await proveArtifactVersionImport(racePreparation);
      const competingImport = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          raceArtifactId,
          `issue44-competing-${crypto.randomUUID()}`,
          body,
          '"v1"',
        ),
      );
      assertEquals(
        competingImport.status,
        201,
        await competingImport.clone().text(),
      );
      const factsAfterCompetingImport = await importFactCounts(fixture, {
        ...ids,
        artifactId: raceArtifactId,
      });
      assertEquals(factsAfterCompetingImport.versions, 1);
      const staleProofImport = await assertRejects(
        () =>
          withPgTransaction(
            fixture.runtimePgDatabase,
            (transaction) =>
              importArtifactVersion(
                transaction,
                raceContext,
                raceHeaders,
                resolver,
                body,
                raceProof,
              ),
          ),
        StandardError,
      );
      assertEquals(staleProofImport.code, "PRECONDITION_FAILED");
      assertEquals(
        await importFactCounts(fixture, {
          ...ids,
          artifactId: raceArtifactId,
        }),
        factsAfterCompetingImport,
      );
      await subprocess("rm", ["-rf", gitFixture.bareRepositoryPath]);
      Deno.env.set(TRUSTED_REPOSITORIES_ENV, "not-json");
      const noSourceReplay = await fixture.app.fetch(
        importRequest(cookie, ids.organizationId, ids.artifactId, key, body),
      );
      assertEquals(noSourceReplay.status, 201);
      assertEquals(noSourceReplay.headers.get("Idempotent-Replayed"), "true");
      assertEquals(
        await noSourceReplay.json() as Record<string, unknown>,
        importedBody,
      );
      const replayAuditCount = await fixture.pgDatabase.query<
        { count: number }
      >(
        `select count(*)::int as count
           from bakery.audit_events
          where organization_id=$1 and operation='artifactVersions.import'
            and resource_type='artifact_version' and request_id=$2`,
        [ids.organizationId, requestId],
      );
      assertEquals(replayAuditCount.rows[0]?.count, 1);
    } finally {
      await cleanupAuthFixture(fixture.pgDatabase, [
        `issue44-developer-${ids.organizationId}@example.test`,
      ]);
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id = $1`,
        [ids.organizationId],
      );
      await fixture.pgDatabase.query(
        `delete from public.organization where id = $1`,
        [ids.organizationId],
      );
      await fixture.close();
    }
  } finally {
    if (previousConfig === undefined) {
      Deno.env.delete(TRUSTED_REPOSITORIES_ENV);
    } else {
      Deno.env.set(TRUSTED_REPOSITORIES_ENV, previousConfig);
    }
    await subprocess("rm", ["-rf", gitFixture.root]);
  }
});

Deno.test("artifact import ignores Git replacement refs for pinned provenance", async () => {
  await withImportScenario(async ({ fixture, ids, gitFixture, cookie }) => {
    const replacement = await createReplacementCommit(gitFixture);
    const replacementRef = `refs/replace/${gitFixture.commitSha}`;
    await git([
      "--git-dir",
      gitFixture.bareRepositoryPath,
      "update-ref",
      replacementRef,
      replacement.commitSha,
    ]);
    try {
      assertEquals(
        await git([
          "--git-dir",
          gitFixture.bareRepositoryPath,
          "rev-parse",
          replacementRef,
        ]),
        replacement.commitSha,
      );
      const body = {
        path: "src/readme.txt",
        commitSha: gitFixture.commitSha,
      };
      const imported = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          `issue44-replace-ref-${crypto.randomUUID()}`,
          body,
        ),
      );
      assertEquals(imported.status, 201, await imported.clone().text());
      const importedBody = await imported.json() as Record<string, unknown>;
      const originalDigest = await sha256Bytes(gitFixture.content);
      assertEquals(importedBody.sha256, originalDigest);
      assertEquals(importedBody.subjectHeadSha, gitFixture.commitSha);
      assertEquals(importedBody.metadata, {
        sourceRepositoryId: ids.repositoryId,
        path: body.path,
        commitSha: gitFixture.commitSha,
      });
      assert(
        (await sha256Bytes(replacement.content)) !== originalDigest,
      );
      const originalContentHex = Array.from(
        gitFixture.content,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const replacementContentHex = Array.from(
        replacement.content,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      assert(originalContentHex !== replacementContentHex);
      const persisted = await fixture.pgDatabase.query<{
        sha256: string;
        contentHex: string;
        subjectHeadSha: string;
        metadataCommitSha: string;
        auditBlobSha: string;
      }>(
        `select version.sha256,
                encode(version.content, 'hex') as "contentHex",
                version.subject_head_sha as "subjectHeadSha",
                version.metadata->>'commitSha' as "metadataCommitSha",
                audit.details->>'blobSha' as "auditBlobSha"
           from bakery.artifact_versions as version
           join bakery.audit_events as audit
             on audit.organization_id=version.organization_id
            and audit.resource_id=version.id::text
          where version.organization_id=$1 and version.artifact_id=$2`,
        [ids.organizationId, ids.artifactId],
      );
      assertEquals(persisted.rows, [{
        sha256: originalDigest,
        contentHex: originalContentHex,
        subjectHeadSha: gitFixture.commitSha,
        metadataCommitSha: gitFixture.commitSha,
        auditBlobSha: gitFixture.blobSha,
      }]);
      assertEquals(await importFactCounts(fixture, ids), {
        versions: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      });
    } finally {
      await git([
        "--git-dir",
        gitFixture.bareRepositoryPath,
        "update-ref",
        "-d",
        replacementRef,
      ]);
    }
  });
});

Deno.test("artifact import normalizes uppercase pinned commit replay metadata", async () => {
  await withImportScenario(async ({ fixture, ids, gitFixture, cookie }) => {
    const uppercaseCommitSha = gitFixture.commitSha.replace(
      /[a-f]/g,
      (character) => character.toUpperCase(),
    );
    assert(uppercaseCommitSha !== gitFixture.commitSha);
    const body = {
      path: "src/readme.txt",
      commitSha: uppercaseCommitSha,
    };
    const key = `issue44-uppercase-${crypto.randomUUID()}`;
    const imported = await fixture.app.fetch(
      importRequest(
        cookie,
        ids.organizationId,
        ids.artifactId,
        key,
        body,
      ),
    );
    assertEquals(imported.status, 201, await imported.clone().text());
    const importedBody = await imported.json() as Record<string, unknown>;
    assertEquals(importedBody.subjectHeadSha, gitFixture.commitSha);
    assertEquals(
      (importedBody.metadata as Record<string, unknown>).commitSha,
      gitFixture.commitSha,
    );
    const persisted = await fixture.pgDatabase.query<{
      subjectHeadSha: string;
      metadataCommitSha: string;
    }>(
      `select version.subject_head_sha as "subjectHeadSha",
              version.metadata->>'commitSha' as "metadataCommitSha"
         from bakery.artifact_versions as version
        where version.organization_id=$1 and version.artifact_id=$2`,
      [ids.organizationId, ids.artifactId],
    );
    assertEquals(persisted.rows, [{
      subjectHeadSha: gitFixture.commitSha,
      metadataCommitSha: gitFixture.commitSha,
    }]);

    const unavailableBarePath =
      `${gitFixture.bareRepositoryPath}.uppercase-replay-unavailable`;
    await subprocess("mv", [
      gitFixture.bareRepositoryPath,
      unavailableBarePath,
    ]);
    let replay: Response;
    try {
      replay = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          key,
          body,
        ),
      );
    } finally {
      await subprocess("mv", [
        unavailableBarePath,
        gitFixture.bareRepositoryPath,
      ]);
    }
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(await replay.json() as Record<string, unknown>, importedBody);
    assertEquals(await importFactCounts(fixture, ids), {
      versions: 1,
      events: 1,
      outbox: 1,
      audits: 1,
      idempotency: 1,
    });
  });
});

Deno.test("import contention on a principal row fails retryably without writes", async () => {
  await withImportScenario(async ({ fixture, ids, gitFixture, cookie }) => {
    const lockHolder = await fixture.pgDatabase.connect();
    let transactionOpen = false;
    const key = `issue44-principal-lock-${crypto.randomUUID()}`;
    const body = {
      path: "src/readme.txt",
      commitSha: gitFixture.commitSha,
    };
    try {
      await lockHolder.query("begin");
      transactionOpen = true;
      await lockHolder.query(
        `select id from bakery.principals where id=$1 for update`,
        [ids.principalId],
      );
      const contended = await fixture.app.fetch(
        new Request(
          importRequest(cookie, ids.organizationId, ids.artifactId, key, body),
          { signal: AbortSignal.timeout(10_000) },
        ),
      );
      assertEquals(contended.status, 503, await contended.clone().text());
      assertEquals(await problemCode(contended), "DEPENDENCY_UNAVAILABLE");
      await assertNoAcceptedImportState(fixture, ids);
      await lockHolder.query("rollback");
      transactionOpen = false;
      const imported = await fixture.app.fetch(
        importRequest(cookie, ids.organizationId, ids.artifactId, key, body),
      );
      assertEquals(imported.status, 201, await imported.clone().text());
      assertEquals(await importFactCounts(fixture, ids), {
        versions: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      });
    } finally {
      if (transactionOpen) await lockHolder.query("rollback");
      lockHolder.release();
    }
  });
});

Deno.test("artifact import denies a principal revoked during final row lock wait", async () => {
  await withImportScenario(async ({ fixture, ids, gitFixture, cookie }) => {
    const body = {
      path: "src/readme.txt",
      commitSha: gitFixture.commitSha,
    };
    const zeroFacts = {
      versions: 0,
      events: 0,
      outbox: 0,
      audits: 0,
      idempotency: 0,
    };
    const lockHolder = await fixture.pgDatabase.connect();
    let transactionOpen = false;
    let pendingImport: Promise<Response> | undefined;
    try {
      await lockHolder.query("begin");
      transactionOpen = true;
      const pidResult = await lockHolder.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const blockingPid = pidResult.rows[0]?.pid;
      if (typeof blockingPid !== "number") {
        throw new Error("ARTIFACT_LOCK_BACKEND_PID_NOT_OBSERVED");
      }
      await lockHolder.query(
        `select id
           from bakery.artifacts
          where organization_id=$1 and id=$2
          for update`,
        [ids.organizationId, ids.artifactId],
      );
      pendingImport = Promise.resolve(
        fixture.app.fetch(
          importRequest(
            cookie,
            ids.organizationId,
            ids.artifactId,
            `issue44-principal-revocation-${crypto.randomUUID()}`,
            body,
          ),
        ),
      );
      // pg_stat_activity hides other roles' wait fields from bakery; the
      // import runs as bakery_app, so observe through that same app role.
      await waitForImportRowLockWait(
        fixture.runtimePgDatabase,
        blockingPid,
      );
      await fixture.pgDatabase.query(
        `update bakery.principals
            set disabled_at=current_timestamp
          where id=$1`,
        [ids.principalId],
      );
      try {
        await lockHolder.query("commit");
        transactionOpen = false;
        const denied = await pendingImport;
        pendingImport = undefined;
        assertEquals(denied.status, 403, await denied.clone().text());
        assertEquals(
          (await denied.json() as { code?: string }).code,
          "AUTH_FORBIDDEN",
        );
        assertEquals(await importFactCounts(fixture, ids), zeroFacts);
      } finally {
        await fixture.pgDatabase.query(
          `update bakery.principals
              set disabled_at=null
            where id=$1`,
          [ids.principalId],
        );
      }
    } finally {
      if (transactionOpen) {
        await lockHolder.query("rollback").catch(() => undefined);
      }
      if (pendingImport) await pendingImport.catch(() => undefined);
      lockHolder.release();
    }
  });
});
Deno.test("authenticated content and extraction preserve bytes, validators, ranges, and UTF-8 boundaries", async () => {
  await withImportScenario(
    async ({ fixture, ids, gitFixture, cookie }) => {
      const imported = await fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          `issue44-read-${crypto.randomUUID()}`,
          {
            path: "src/readme.txt",
            commitSha: gitFixture.commitSha,
          },
        ),
      );
      assertEquals(imported.status, 201, await imported.clone().text());
      const version = await imported.json() as {
        id: string;
        sha256: string;
      };
      const content = gitFixture.content;
      const digest = await sha256Bytes(content);
      assertEquals(version.sha256, digest);

      const request = (
        path: string,
        headers: Record<string, string> = {},
      ) =>
        new Request(`${authTestOrigin}${path}`, {
          headers: {
            cookie,
            origin: authTestOrigin,
            "Bakery-Organization-Id": ids.organizationId,
            ...headers,
          },
        });

      const full = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`),
      );
      assertEquals(full.status, 200, await full.clone().text());
      assertEquals(
        Array.from(new Uint8Array(await full.arrayBuffer())),
        Array.from(content),
      );
      assertEquals(full.headers.get("etag"), `"${digest}"`);
      assertEquals(full.headers.get("content-length"), String(content.length));
      assertEquals(
        full.headers.get("content-disposition"),
        'attachment; filename="artifact.bin"',
      );
      assertEquals(full.headers.get("content-security-policy"), "sandbox");
      assertEquals(full.headers.get("x-content-type-options"), "nosniff");

      const ranged = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=0-4",
        }),
      );
      assertEquals(ranged.status, 206, await ranged.clone().text());
      assertEquals(
        Array.from(new Uint8Array(await ranged.arrayBuffer())),
        Array.from(content.slice(0, 5)),
      );
      assertEquals(
        ranged.headers.get("content-range"),
        `bytes 0-4/${content.length}`,
      );
      assertEquals(ranged.headers.get("content-length"), "5");

      const suffix = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=-4",
        }),
      );
      assertEquals(suffix.status, 206);
      assertEquals(
        Array.from(new Uint8Array(await suffix.arrayBuffer())),
        Array.from(content.slice(-4)),
      );
      assertEquals(
        suffix.headers.get("content-range"),
        `bytes ${content.length - 4}-${content.length - 1}/${content.length}`,
      );

      const clipped = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=0-999999",
        }),
      );
      assertEquals(clipped.status, 206);
      assertEquals(
        Array.from(new Uint8Array(await clipped.arrayBuffer())),
        Array.from(content),
      );

      const noIfRange = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=0-1",
        }),
      );
      assertEquals(noIfRange.status, 206);
      assertEquals(
        Array.from(new Uint8Array(await noIfRange.arrayBuffer())),
        Array.from(content.slice(0, 2)),
      );
      assertEquals(
        noIfRange.headers.get("content-range"),
        `bytes 0-1/${content.length}`,
      );

      const matchingIfRange = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=0-1",
          "if-range": `"${digest}"`,
        }),
      );
      assertEquals(matchingIfRange.status, 206);
      assertEquals(
        Array.from(new Uint8Array(await matchingIfRange.arrayBuffer())),
        Array.from(content.slice(0, 2)),
      );

      const mismatchingIfRange = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=0-1",
          "if-range": `"${"0".repeat(64)}"`,
        }),
      );
      assertEquals(mismatchingIfRange.status, 200);
      assertEquals(
        Array.from(new Uint8Array(await mismatchingIfRange.arrayBuffer())),
        Array.from(content),
      );
      assertEquals(mismatchingIfRange.headers.get("content-range"), null);

      const conditional = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=0-1",
          "if-none-match": `"${digest}"`,
        }),
      );
      assertEquals(conditional.status, 304);
      assertEquals((await conditional.arrayBuffer()).byteLength, 0);
      assertEquals(conditional.headers.get("etag"), `"${digest}"`);
      assertEquals(
        conditional.headers.get("content-length"),
        String(content.length),
      );
      assertEquals(conditional.headers.get("content-range"), null);

      const invalid = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=abc",
        }),
      );
      assertEquals(invalid.status, 400);
      const multiple = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: "bytes=0-1,3-4",
        }),
      );
      assertEquals(multiple.status, 400);
      const unsatisfiable = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/content`, {
          range: `bytes=${content.length}-${content.length + 1}`,
        }),
      );
      assertEquals(unsatisfiable.status, 416);
      assertEquals((await unsatisfiable.arrayBuffer()).byteLength, 0);
      assertEquals(
        unsatisfiable.headers.get("content-range"),
        `bytes */${content.length}`,
      );
      assertEquals(unsatisfiable.headers.get("content-length"), "0");

      const extraction = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${version.id}/extract?startByte=0&maxBytes=65536`,
        ),
      );
      assertEquals(extraction.status, 200, await extraction.clone().text());
      assertEquals(await extraction.json(), {
        versionId: version.id,
        sha256: digest,
        mediaType: "text/plain",
        startByte: 0,
        endByteExclusive: 65_536,
        text: "\uFEFFA\uFEFFB" + "é".repeat(32_764),
        hasMore: true,
      });

      const oneByteFirstCodePoint = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${version.id}/extract?startByte=0&maxBytes=1`,
        ),
      );
      assertEquals(oneByteFirstCodePoint.status, 422);

      const leadingBom = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${version.id}/extract?startByte=0&maxBytes=4`,
        ),
      );
      assertEquals(leadingBom.status, 200);
      const leadingBomBody = await leadingBom.json() as {
        versionId: string;
        sha256: string;
        mediaType: string;
        startByte: number;
        endByteExclusive: number;
        text: string;
        hasMore: boolean;
      };
      assertEquals(leadingBomBody, {
        versionId: version.id,
        sha256: digest,
        mediaType: "text/plain",
        startByte: 0,
        endByteExclusive: 4,
        text: "\uFEFFA",
        hasMore: true,
      });
      assertEquals(
        Array.from(new TextEncoder().encode(leadingBomBody.text)),
        Array.from(content.slice(0, 4)),
      );

      const interiorBom = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${version.id}/extract?startByte=4&maxBytes=4`,
        ),
      );
      assertEquals(interiorBom.status, 200);
      const interiorBomBody = await interiorBom.json() as {
        versionId: string;
        sha256: string;
        mediaType: string;
        startByte: number;
        endByteExclusive: number;
        text: string;
        hasMore: boolean;
      };
      assertEquals(interiorBomBody, {
        versionId: version.id,
        sha256: digest,
        mediaType: "text/plain",
        startByte: 4,
        endByteExclusive: 8,
        text: "\uFEFFB",
        hasMore: true,
      });
      assertEquals(
        Array.from(new TextEncoder().encode(interiorBomBody.text)),
        Array.from(content.slice(4, 8)),
      );

      const midCodePoint = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${version.id}/extract?startByte=1&maxBytes=2`,
        ),
      );
      assertEquals(midCodePoint.status, 422);
      const malformedWindow = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${version.id}/extract?startByte=${
            content.length + 1
          }`,
        ),
      );
      assertEquals(malformedWindow.status, 422);
      const malformedArtifactId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.artifacts (
           id, organization_id, task_id, artifact_type, name, revision, version
         ) values ($1, $2, $3, 'source', 'malformed', 1, 1)`,
        [malformedArtifactId, ids.organizationId, ids.taskId],
      );
      const malformedContent = new Uint8Array([
        ...new TextEncoder().encode("a".repeat(65_536)),
        0xc3,
        0x28,
      ]);
      const malformedVersion = await fixture.pgDatabase.query<{ id: string }>(
        `insert into bakery.artifact_versions (
           organization_id, artifact_id, task_id, run_step_id, revision,
           author_id, subject_head_sha, subject_base_sha, step_key, metadata,
           content, sha256, size_bytes, media_type
         ) values ($1, $2, $3, null, 1, $4, null, null, null, $5, $6, $7, $8, $9)
         returning id`,
        [
          ids.organizationId,
          malformedArtifactId,
          ids.taskId,
          ids.principalId,
          {},
          malformedContent,
          await sha256Bytes(malformedContent),
          malformedContent.byteLength,
          "text/plain",
        ],
      );
      const malformedExtraction = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${
            malformedVersion.rows[0]!.id
          }/extract?startByte=0&maxBytes=65536`,
        ),
      );
      assertEquals(
        malformedExtraction.status,
        422,
        await malformedExtraction.clone().text(),
      );

      const digestMismatchArtifactId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.artifacts (
           id, organization_id, task_id, artifact_type, name, revision, version
         ) values ($1, $2, $3, 'source', 'digest-mismatch', 1, 1)`,
        [digestMismatchArtifactId, ids.organizationId, ids.taskId],
      );
      const digestMismatchContent = new TextEncoder().encode(
        "digest mismatch\n",
      );
      const digestMismatchVersion = await fixture.pgDatabase.query<
        { id: string }
      >(
        `insert into bakery.artifact_versions (
           organization_id, artifact_id, task_id, run_step_id, revision,
           author_id, subject_head_sha, subject_base_sha, step_key, metadata,
           content, sha256, size_bytes, media_type
         ) values ($1, $2, $3, null, 1, $4, null, null, null, $5, $6, $7, $8, $9)
         returning id`,
        [
          ids.organizationId,
          digestMismatchArtifactId,
          ids.taskId,
          ids.principalId,
          {},
          digestMismatchContent,
          "0".repeat(64),
          digestMismatchContent.byteLength,
          "text/plain",
        ],
      );
      const corruptRange = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${digestMismatchVersion.rows[0]!.id}/content`,
          { range: "bytes=0-2" },
        ),
      );
      assertEquals(corruptRange.status, 500);
      assertEquals(await problemCode(corruptRange), "INTERNAL");

      const digestMismatchExtraction = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${digestMismatchVersion.rows[0]!.id}/extract`,
        ),
      );
      assertEquals(
        digestMismatchExtraction.status,
        500,
        await digestMismatchExtraction.clone().text(),
      );
      assertEquals(
        await problemCode(digestMismatchExtraction),
        "INTERNAL",
      );

      const overCap = await fixture.app.fetch(
        request(
          `/v1/artifact-versions/${version.id}/extract?maxBytes=65537`,
        ),
      );
      assertEquals(overCap.status, 400);
      // A version persisted by an older classifier must not become extractable.
      const activeBytes = new TextEncoder().encode(
        '<?<x title="><img src=x onerror=alert(1)>">',
      );
      await fixture.pgDatabase.query(
        `update bakery.artifact_versions
            set content=$3, sha256=$4, size_bytes=$5
          where organization_id=$1 and id=$2`,
        [
          ids.organizationId,
          version.id,
          activeBytes,
          await sha256Bytes(activeBytes),
          activeBytes.byteLength,
        ],
      );
      const activeExtraction = await fixture.app.fetch(
        request(`/v1/artifact-versions/${version.id}/extract`),
      );
      assertEquals(activeExtraction.status, 422);
      assertEquals(await problemCode(activeExtraction), "UNPROCESSABLE");
    },
    "\uFEFFA\uFEFFB" + "é".repeat(40_000),
  );
});
Deno.test("human imports resolve one winner for a competing parent CAS", async () => {
  await withImportScenario(async ({ fixture, ids, gitFixture, cookie }) => {
    const body = {
      path: "src/readme.txt",
      commitSha: gitFixture.commitSha,
    };
    const responses = await Promise.all([
      fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          `issue44-race-a-${crypto.randomUUID()}`,
          body,
          '"v1"',
        ),
      ),
      fixture.app.fetch(
        importRequest(
          cookie,
          ids.organizationId,
          ids.artifactId,
          `issue44-race-b-${crypto.randomUUID()}`,
          body,
          '"v1"',
        ),
      ),
    ]);
    assertEquals(responses.map((response) => response.status).sort(), [
      201,
      412,
    ]);
    const facts = await importFactCounts(fixture, ids);
    assertEquals(facts, {
      versions: 1,
      events: 1,
      outbox: 1,
      audits: 1,
      idempotency: 1,
    });
  });
});
