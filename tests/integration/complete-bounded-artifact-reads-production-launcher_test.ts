import { assertEquals } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import {
  authTestSecret,
  cleanupAuthFixture,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";

const SERVER_SCRIPT = "scripts/run-main.sh";

type SmokeIds = {
  organizationId: string;
  providerUserId: string;
  principalId: string;
  applicationId: string;
  conversationId: string;
  repositoryId: string;
  taskId: string;
  artifactId: string;
};

type BareGitFixture = {
  root: string;
  bareRepositoryPath: string;
  commitSha: string;
  content: Uint8Array;
};

type ImportFacts = {
  versions: number;
  events: number;
  outbox: number;
  audits: number;
  idempotency: number;
};

type RunningServer = {
  child: Deno.ChildProcess;
  origin: string;
  stdout: Promise<string>;
  stderr: Promise<string>;
  exit: Promise<Deno.CommandStatus>;
  stopped: boolean;
};

async function run(
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

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function createBareGitFixture(): Promise<BareGitFixture> {
  const root = await run("mktemp", ["-d", "-t", "issue44-launcher-XXXXXX"]);
  const work = `${root}/work`;
  const bare = `${root}/bare.git`;
  await run("mkdir", ["-p", `${work}/src`]);
  await run("git", ["init", work]);
  await run("git", ["config", "user.name", "Issue 44 Launcher Fixture"], work);
  await run(
    "git",
    ["config", "user.email", "issue44-launcher@example.test"],
    work,
  );
  const content = new TextEncoder().encode("launcher import fixture\n");
  await run(
    "sh",
    [
      "-c",
      "printf '%s\\n' 'launcher import fixture' > \"$1\"",
      "issue44-launcher-fixture",
      `${work}/src/readme.txt`,
    ],
  );
  await run("git", ["add", "src/readme.txt"], work);
  await run("git", ["commit", "-m", "launcher import fixture"], work);
  const commitSha = await run("git", ["rev-parse", "HEAD"], work);
  await run("git", ["clone", "--bare", work, bare]);
  assertEquals(
    await run("git", ["--git-dir", bare, "cat-file", "-t", commitSha]),
    "commit",
  );
  return { root, bareRepositoryPath: bare, commitSha, content };
}

async function trustedMapping(
  ids: SmokeIds,
  fixture: BareGitFixture,
): Promise<string> {
  const material = {
    applicationId: ids.applicationId,
    bareRepositoryPath: fixture.bareRepositoryPath,
    mappingRevision: "issue44-launcher-1",
    organizationId: ids.organizationId,
    repositoryUuid: ids.repositoryId,
    snapshotSha: fixture.commitSha,
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

async function seedImportGraph(
  database: PgDatabase,
  ids: SmokeIds,
): Promise<string> {
  const now = new Date();
  const sessionToken = crypto.randomUUID();
  await database.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, 'Issue 44 Launcher Developer', $2, true, $3, $3)`,
    [
      ids.providerUserId,
      `issue44-launcher-${ids.providerUserId}@example.test`,
      now,
    ],
  );
  await database.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, 'Issue 44 Launcher Developer', 'human')`,
    [ids.principalId, ids.providerUserId],
  );
  await database.query(
    `insert into public.organization (
       id, name, slug, "createdAt", "updatedAt"
     ) values ($1, 'Issue 44 Launcher Organization', $2, $3, $3)`,
    [ids.organizationId, `issue44-launcher-${ids.organizationId}`, now],
  );
  await database.query(
    `insert into bakery.organizations (
       id, name, slug, metadata, created_at, updated_at
     ) values ($1, 'Issue 44 Launcher Organization', $2, '{}'::jsonb, $3, $3)`,
    [ids.organizationId, `issue44-launcher-${ids.organizationId}`, now],
  );
  await database.query(
    `insert into public.member (
       id, "organizationId", "userId", role, status,
       "createdAt", "joinedAt", "updatedAt"
     ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4)`,
    [crypto.randomUUID(), ids.organizationId, ids.providerUserId, now],
  );
  await database.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at,
       created_at, updated_at, version
     ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), ids.organizationId, ids.principalId, now],
  );
  await database.query(
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
  await database.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, 'issue44-launcher-app', 'Issue 44 Launcher Application')`,
    [ids.applicationId, ids.organizationId],
  );
  await database.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, title, created_by
     ) values ($1, $2, $3, 'Issue 44 Launcher Conversation', $4)`,
    [
      ids.conversationId,
      ids.organizationId,
      ids.applicationId,
      ids.principalId,
    ],
  );
  await database.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1, $2, $3, $4, $5, 'issue44', 'launcher', 'main')`,
    [
      ids.repositoryId,
      ids.organizationId,
      ids.applicationId,
      crypto.randomUUID(),
      `issue44/launcher/${ids.repositoryId}`,
    ],
  );
  await database.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, repository_id,
       conversation_id, title, task_type, status, priority, created_by
     ) values ($1, $2, $3, $4, $5, 'Issue 44 Launcher Task', 'feature', 'queued', 50, $6)`,
    [
      ids.taskId,
      ids.organizationId,
      ids.applicationId,
      ids.repositoryId,
      ids.conversationId,
      ids.principalId,
    ],
  );
  await database.query(
    `insert into bakery.artifacts (
       id, organization_id, task_id, artifact_type, name, revision, version
     ) values ($1, $2, $3, 'source', 'launcher-readme', 1, 1)`,
    [ids.artifactId, ids.organizationId, ids.taskId],
  );
  return await signSessionCookie(sessionToken, authTestSecret);
}

async function importFactCounts(
  database: PgDatabase,
  ids: SmokeIds,
): Promise<ImportFacts> {
  const result = await database.query<ImportFacts>(
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

async function importOverHttp(
  origin: string,
  cookie: string,
  ids: SmokeIds,
  key: string,
  body: { path: string; commitSha: string },
  ifMatch: string,
): Promise<Response> {
  return await fetch(
    new Request(`${origin}/v1/artifacts/${ids.artifactId}/versions/import`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "Bakery-Organization-Id": ids.organizationId,
        "Idempotency-Key": key,
        "If-Match": ifMatch,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function freeLoopbackPort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const address = listener.addr;
    if (address.transport !== "tcp") throw new Error("TCP_PORT_REQUIRED");
    return address.port;
  } finally {
    listener.close();
  }
}

async function waitForServer(
  origin: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/v1/me`, {
        signal: AbortSignal.timeout(250),
      });
      await response.body?.cancel();
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`SERVER_START_TIMEOUT_${origin}`);
}

async function launchServer(
  databaseUrl: string,
  trustedRepositoriesJson: string,
  path = Deno.env.get("PATH") ?? "/usr/bin:/bin",
): Promise<RunningServer> {
  const port = freeLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = new Deno.Command("bash", {
    args: [SERVER_SCRIPT],
    cwd: "apps/server",
    env: {
      PATH: path,
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: databaseUrl,
      BAKERY_PUBLIC_BASE_URL: origin,
      BAKERY_SERVER_HOST: "127.0.0.1",
      BAKERY_SERVER_PORT: String(port),
      BAKERY_TRUSTED_REPOSITORIES_JSON: trustedRepositoriesJson,
      BETTER_AUTH_SECRET: authTestSecret,
      BETTER_AUTH_TRUSTED_ORIGINS: origin,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const running: RunningServer = {
    child,
    origin,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
    exit: child.status,
    stopped: false,
  };
  try {
    await waitForServer(origin);
  } catch (error) {
    const output = await stopServer(running);
    throw new Error(`${error}\n${output}`);
  }
  return running;
}

async function stopServer(server: RunningServer): Promise<string> {
  if (server.stopped) return "";
  try {
    server.child.kill("SIGTERM");
  } catch {
    // The process may already have exited.
  }
  const shutdownTimeout = Promise.withResolvers<false>();
  const shutdownTimer = setTimeout(() => shutdownTimeout.resolve(false), 3_000);
  const exited = await Promise.race([
    server.exit.then(() => true),
    shutdownTimeout.promise,
  ]);
  clearTimeout(shutdownTimer);
  if (!exited) {
    try {
      server.child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
  await server.exit;
  server.stopped = true;
  const [stdout, stderr] = await Promise.all([server.stdout, server.stderr]);
  return `stdout:\n${stdout}\nstderr:\n${stderr}`;
}

Deno.test("run-main launches a real authenticated import and fails closed without mapping", async () => {
  const ids: SmokeIds = {
    organizationId: crypto.randomUUID(),
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
  };
  const gitFixture = await createBareGitFixture();
  const spoofedGitDir = await Deno.makeTempDir({ prefix: "issue44-git-path-" });
  const databaseUrl = readTestDatabaseConfig().appDatabaseUrl;
  const fixture = await openAuthFixture();
  let server: RunningServer | undefined;
  try {
    const cookie = await seedImportGraph(fixture.pgDatabase, ids);
    const trustedRepositoriesJson = await trustedMapping(ids, gitFixture);
    const spoofedGit = `${spoofedGitDir}/git`;
    await Deno.writeTextFile(spoofedGit, "#!/bin/sh\nexit 79\n");
    await Deno.chmod(spoofedGit, 0o755);
    const pinnedGitVersion = await run("/usr/bin/git", ["--version"]);
    console.info(`ISSUE44_PINNED_GIT /usr/bin/git ${pinnedGitVersion}`);
    const body = { path: "src/readme.txt", commitSha: gitFixture.commitSha };

    server = await launchServer(
      databaseUrl,
      trustedRepositoriesJson,
      `${spoofedGitDir}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
    );
    const imported = await importOverHttp(
      server.origin,
      cookie,
      ids,
      `issue44-launcher-${crypto.randomUUID()}`,
      body,
      '"v1"',
    );
    assertEquals(imported.status, 201, await imported.clone().text());
    const importedBody = await imported.json() as Record<string, unknown>;
    assertEquals(
      importedBody.sha256,
      await sha256Bytes(gitFixture.content),
    );
    assertEquals(await importFactCounts(fixture.pgDatabase, ids), {
      versions: 1,
      events: 1,
      outbox: 1,
      audits: 1,
      idempotency: 1,
    });
    await stopServer(server);
    server = undefined;

    server = await launchServer(
      databaseUrl,
      JSON.stringify({ schemaVersion: 1, entries: [] }),
    );
    const missingMapping = await importOverHttp(
      server.origin,
      cookie,
      ids,
      `issue44-launcher-missing-${crypto.randomUUID()}`,
      body,
      '"v2"',
    );
    assertEquals(
      missingMapping.status,
      503,
      await missingMapping.clone().text(),
    );
    assertEquals(
      (await missingMapping.json() as { code?: string }).code,
      "DEPENDENCY_UNAVAILABLE",
    );
    assertEquals(await importFactCounts(fixture.pgDatabase, ids), {
      versions: 1,
      events: 1,
      outbox: 1,
      audits: 1,
      idempotency: 1,
    });
  } finally {
    if (server) await stopServer(server);
    await cleanupAuthFixture(fixture.pgDatabase, [
      `issue44-launcher-${ids.providerUserId}@example.test`,
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
    await run("rm", ["-rf", gitFixture.root]);
    await Deno.remove(spoofedGitDir, { recursive: true });
  }
});
