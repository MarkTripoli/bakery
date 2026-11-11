import { assertEquals, assertRejects } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import {
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

const TRUSTED_REPOSITORIES_ENV = "BAKERY_TRUSTED_REPOSITORIES_JSON";
const commitSha = "b".repeat(40);

type PrincipalSeed = {
  providerUserId: string | null;
  principalId: string;
  principalType: "human" | "service";
  role: "admin" | "developer" | null;
  status: "active" | "inactive";
  membership: boolean;
  disabled: boolean;
  grantRevoked: boolean;
};

type TenantSeed = {
  organizationId: string;
  applicationId: string;
  repositoryId: string;
  conversationId: string;
  taskId: string;
  artifactId: string;
};

const fixturePath = "/usr/bin:/bin";
const fixtureContent = "trusted import fixture\n";

async function subprocess(
  program: string,
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  const output = await new Deno.Command(program, {
    args: [...args],
    cwd,
    clearEnv: true,
    env: {
      PATH: fixturePath,
      TMPDIR: "/tmp",
      ...(program === "git"
        ? {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
        }
        : {}),
    },
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
  return await subprocess("git", [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "init.templateDir=/dev/null",
    ...args,
  ], cwd);
}

function assertOwnedGitRoot(root: string): void {
  if (!/^\/tmp\/issue44-security-[A-Za-z0-9]{6}$/.test(root)) {
    throw new Error("INVALID_SECURITY_FIXTURE_ROOT");
  }
}

async function removeOwnedGitRoot(root: string): Promise<void> {
  assertOwnedGitRoot(root);
  await subprocess("rm", ["-rf", "--", root]);
}

type VerifiedBareRepository = {
  root: string;
  bareRepositoryPath: string;
  commitSha: string;
  blobSha: string;
  content: Uint8Array;
};

async function createVerifiedBareRepository(): Promise<
  VerifiedBareRepository
> {
  const root = await subprocess("mktemp", [
    "-d",
    "-t",
    "issue44-security-XXXXXX",
  ]);
  assertOwnedGitRoot(root);
  try {
    const work = `${root}/work`;
    const bare = `${root}/bare.git`;
    const content = new TextEncoder().encode(fixtureContent);
    await subprocess("mkdir", ["-p", `${work}/src`]);
    await git(["init", work]);
    await git(["config", "user.name", "Issue 44 Security Fixture"], work);
    await git(["config", "user.email", "issue44-security@example.test"], work);
    await subprocess("sh", [
      "-c",
      'printf "%s" "$1" > "$2"',
      "sh",
      fixtureContent,
      `${work}/src/readme.txt`,
    ]);
    await git(["add", "src/readme.txt"], work);
    await git(["commit", "-m", "trusted import fixture"], work);
    let actualCommitSha = await git(["rev-parse", "HEAD"], work);
    if (actualCommitSha === commitSha) {
      await git([
        "commit",
        "--allow-empty",
        "-m",
        "trusted import fixture non-sentinel",
      ], work);
      actualCommitSha = await git(["rev-parse", "HEAD"], work);
      if (actualCommitSha === commitSha) {
        throw new Error("INVALID_SOURCE_SENTINEL_COMMIT");
      }
    }
    const treeSha = await git(["rev-parse", "HEAD^{tree}"], work);
    const blobSha = await git(["rev-parse", "HEAD:src/readme.txt"], work);
    await git(["clone", "--bare", work, bare]);
    assertEquals(
      await git(["--git-dir", bare, "cat-file", "-t", actualCommitSha]),
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
    assertEquals(
      await git([
        "--git-dir",
        bare,
        "ls-tree",
        actualCommitSha,
        "--",
        "src/readme.txt",
      ]),
      `100644 blob ${blobSha}\tsrc/readme.txt`,
    );
    assertEquals(
      await git(["--git-dir", bare, "cat-file", "-p", blobSha]),
      "trusted import fixture",
    );
    return {
      root,
      bareRepositoryPath: bare,
      commitSha: actualCommitSha,
      blobSha,
      content,
    };
  } catch (error) {
    try {
      await removeOwnedGitRoot(root);
    } catch (cleanupError) {
      console.error("Security fixture setup cleanup failed:", cleanupError);
    }
    throw error;
  }
}

type PromisorRepository = VerifiedBareRepository & {
  promisorRepositoryPath: string;
  remoteInvocationLogPath: string;
};

async function createPromisorRepository(
  source: VerifiedBareRepository,
): Promise<PromisorRepository> {
  const promisorRepositoryPath = `${source.root}/promisor.git`;
  const remoteInvocationLogPath = `${source.root}/remote-invocations.log`;
  const quotedLogPath = `'${
    remoteInvocationLogPath.replaceAll(
      "'",
      "'\\''",
    )
  }'`;
  const uploadPackCommand =
    `sh -c 'printf contacted >> "$1"; exit 1' sh ${quotedLogPath}`;
  await git([
    "--git-dir",
    source.bareRepositoryPath,
    "config",
    "uploadpack.allowFilter",
    "true",
  ]);
  await git([
    "--git-dir",
    source.bareRepositoryPath,
    "config",
    "uploadpack.allowAnySHA1InWant",
    "true",
  ]);
  await git([
    "clone",
    "--bare",
    "--no-local",
    "--filter=blob:none",
    source.bareRepositoryPath,
    promisorRepositoryPath,
  ]);
  await git([
    "--git-dir",
    promisorRepositoryPath,
    "config",
    "remote.origin.url",
    source.bareRepositoryPath,
  ]);
  await git([
    "--git-dir",
    promisorRepositoryPath,
    "config",
    "remote.origin.uploadpack",
    uploadPackCommand,
  ]);
  assertEquals(
    await git([
      "--git-dir",
      promisorRepositoryPath,
      "config",
      "--get",
      "remote.origin.url",
    ]),
    source.bareRepositoryPath,
  );
  assertEquals(
    await git([
      "--git-dir",
      promisorRepositoryPath,
      "config",
      "--get",
      "remote.origin.promisor",
    ]),
    "true",
  );
  assertEquals(
    await git([
      "--git-dir",
      promisorRepositoryPath,
      "rev-parse",
      "--is-bare-repository",
    ]),
    "true",
  );
  assertEquals(
    await git([
      "--git-dir",
      promisorRepositoryPath,
      "rev-parse",
      "--is-shallow-repository",
    ]),
    "false",
  );
  assertEquals(
    await git(["--git-dir", promisorRepositoryPath, "rev-parse", "HEAD"]),
    source.commitSha,
  );
  await assertRejects(() =>
    git(["--git-dir", promisorRepositoryPath, "cat-file", "-e", source.blobSha])
  );
  return {
    ...source,
    bareRepositoryPath: promisorRepositoryPath,
    promisorRepositoryPath,
    remoteInvocationLogPath,
  };
}

async function trustedConfig(
  tenant: TenantSeed,
  bareRepositoryPath: string,
  snapshotSha: string,
): Promise<string> {
  const material = {
    applicationId: tenant.applicationId,
    bareRepositoryPath,
    mappingRevision: "security-fixture-1",
    organizationId: tenant.organizationId,
    repositoryUuid: tenant.repositoryId,
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

async function seedTenantOrganization(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  tenant: TenantSeed,
): Promise<void> {
  const now = new Date();
  await fixture.pgDatabase.query(
    `insert into public.organization (
       id, name, slug, "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $4)`,
    [
      tenant.organizationId,
      `Issue 44 ${tenant.organizationId}`,
      `issue44-${tenant.organizationId}`,
      now,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organizations (
       id, name, slug, metadata, created_at, updated_at
     ) values ($1, $2, $3, '{}'::jsonb, $4, $4)`,
    [
      tenant.organizationId,
      `Issue 44 ${tenant.organizationId}`,
      `issue44-${tenant.organizationId}`,
      now,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, 'Issue 44 Security Application')`,
    [
      tenant.applicationId,
      tenant.organizationId,
      `security-${tenant.applicationId}`,
    ],
  );
}

async function seedTenantGraph(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  tenant: TenantSeed,
  principalId: string,
): Promise<void> {
  await fixture.pgDatabase.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, title, created_by
     ) values ($1, $2, $3, 'Issue 44 Security Conversation', $4)`,
    [
      tenant.conversationId,
      tenant.organizationId,
      tenant.applicationId,
      principalId,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1, $2, $3, $4, $5, 'issue44', 'security', 'main')`,
    [
      tenant.repositoryId,
      tenant.organizationId,
      tenant.applicationId,
      crypto.randomUUID(),
      `issue44/security/${tenant.repositoryId}`,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, repository_id,
       conversation_id, title, task_type, status, priority, created_by
     ) values ($1, $2, $3, $4, $5, 'Issue 44 Security Task', 'feature', 'queued', 50, $6)`,
    [
      tenant.taskId,
      tenant.organizationId,
      tenant.applicationId,
      tenant.repositoryId,
      tenant.conversationId,
      principalId,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifacts (
       id, organization_id, task_id, artifact_type, name, revision, version
     ) values ($1, $2, $3, 'source', 'security', 1, 1)`,
    [tenant.artifactId, tenant.organizationId, tenant.taskId],
  );
}

async function seedPrincipal(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  tenant: TenantSeed,
  principal: PrincipalSeed,
  grantedByPrincipalId: string,
): Promise<string> {
  const now = new Date();
  const email = `issue44-${principal.principalId}@example.test`;
  const sessionToken = crypto.randomUUID();
  const sessionUserId = principal.providerUserId ?? crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, $2, $3, true, $4, $4)`,
    [
      sessionUserId,
      `Issue 44 ${principal.principalId}`,
      email,
      now,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type, disabled_at
     ) values ($1, $2, $3, $4, $5)`,
    [
      principal.principalId,
      principal.providerUserId,
      `Issue 44 ${principal.principalId}`,
      principal.principalType,
      principal.disabled ? now : null,
    ],
  );
  if (principal.membership) {
    await fixture.pgDatabase.query(
      `insert into public.member (
         id, "organizationId", "userId", role, status,
         "createdAt", "joinedAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $6, $6, $6)`,
      [
        crypto.randomUUID(),
        tenant.organizationId,
        principal.providerUserId,
        principal.role,
        principal.status,
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       ) values ($1, $2, $3, $4, $5, $6, $6, $6, 1)`,
      [
        crypto.randomUUID(),
        tenant.organizationId,
        principal.principalId,
        principal.role,
        principal.status,
        now,
      ],
    );
  }
  await fixture.pgDatabase.query(
    `insert into public.session (
       id, token, "userId", "expiresAt", "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      sessionToken,
      sessionUserId,
      new Date(Date.now() + 60 * 60 * 1000),
      now,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.permission_grants (
       organization_id, principal_id, capability, revoked_at,
       granted_by_principal_id
     ) values ($1, $2, 'artifactVersions.import', $3, $4)`,
    [
      tenant.organizationId,
      principal.principalId,
      principal.grantRevoked ? now : null,
      grantedByPrincipalId,
    ],
  );
  return await signSessionCookie(sessionToken, fixture.config.auth!.secret);
}

function importRequest(
  cookie: string,
  organizationId: string,
  artifactId: string,
  key: string,
  options: { commitSha?: string; ifMatch?: string; path?: string } = {},
): Request {
  return new Request(
    `${authTestOrigin}/v1/artifacts/${artifactId}/versions/import`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: authTestOrigin,
        "Bakery-Organization-Id": organizationId,
        "Idempotency-Key": key,
        "If-Match": options.ifMatch ?? '"v1"',
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: options.path ?? "src/readme.txt",
        commitSha: options.commitSha ?? commitSha,
      }),
    },
  );
}

async function problemCode(response: Response): Promise<string> {
  const body = await response.json() as { code: string };
  return body.code;
}

type ImportFacts = {
  versions: number;
  events: number;
  outbox: number;
  audits: number;
  idempotency: number;
};

async function importFactCounts(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  tenant: TenantSeed,
  principalId?: string,
  idempotencyKey?: string,
): Promise<ImportFacts> {
  const facts = await fixture.pgDatabase.query<ImportFacts>(
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
          and resource_id in (
            select id::text from bakery.artifact_versions
             where organization_id=$1 and artifact_id=$2
          )
          and ($3::uuid is null or principal_id=$3)
          and ($4::text is null or details->>'idempotencyKey'=$4)) as audits,
       (select count(*)::int from bakery.idempotency_records
         where organization_id=$1
           and operation='artifactVersions.import'
           and ($3::uuid is null or principal_id=$3)
           and ($4::text is null or key=$4)) as idempotency`,
    [
      tenant.organizationId,
      tenant.artifactId,
      principalId ?? null,
      idempotencyKey ?? null,
    ],
  );
  return facts.rows[0] ?? {
    versions: 0,
    events: 0,
    outbox: 0,
    audits: 0,
    idempotency: 0,
  };
}

async function assertNoImportFacts(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  tenant: TenantSeed,
): Promise<void> {
  assertEquals(await importFactCounts(fixture, tenant), {
    versions: 0,
    events: 0,
    outbox: 0,
    audits: 0,
    idempotency: 0,
  });
}

Deno.test("import denies unlinked, roleless, inactive, disabled, cross-tenant, stale and unverified requests but admits an active Developer with a revoked exact grant", async () => {
  const tenantA: TenantSeed = {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
  };
  const tenantB: TenantSeed = {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
  };
  const developer: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: "developer",
    status: "active",
    membership: true,
    disabled: false,
    grantRevoked: false,
  };
  const service: PrincipalSeed = {
    providerUserId: null,
    principalId: crypto.randomUUID(),
    principalType: "service",
    role: null,
    status: "active",
    membership: false,
    disabled: false,
    grantRevoked: false,
  };
  const grantOnlyViewer: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: null,
    status: "active",
    membership: false,
    disabled: false,
    grantRevoked: false,
  };
  const revokedMembership: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: "developer",
    status: "inactive",
    membership: true,
    disabled: false,
    grantRevoked: false,
  };
  const missingMembership: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: "developer",
    status: "active",
    membership: false,
    disabled: false,
    grantRevoked: false,
  };
  const disabled: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: "developer",
    status: "active",
    membership: true,
    disabled: true,
    grantRevoked: false,
  };
  const revokedGrant: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: "developer",
    status: "active",
    membership: true,
    disabled: false,
    grantRevoked: true,
  };
  const previousConfig = Deno.env.get(TRUSTED_REPOSITORIES_ENV);
  const gitFixture = await createVerifiedBareRepository();
  let testFailed = false;
  let environmentCleanupError: unknown;
  try {
    const gitConfig = await trustedConfig(
      tenantA,
      gitFixture.bareRepositoryPath,
      gitFixture.commitSha,
    );
    Deno.env.set(TRUSTED_REPOSITORIES_ENV, gitConfig);
    const fixture = await openAuthFixture();
    let databaseCleanupError: unknown;
    try {
      await seedTenantOrganization(fixture, tenantA);
      await seedTenantOrganization(fixture, tenantB);
      const developerCookie = await seedPrincipal(
        fixture,
        tenantA,
        developer,
        developer.principalId,
      );
      await seedTenantGraph(fixture, tenantA, developer.principalId);
      await seedTenantGraph(fixture, tenantB, developer.principalId);
      const serviceCookie = await seedPrincipal(
        fixture,
        tenantA,
        service,
        developer.principalId,
      );
      const grantOnlyViewerCookie = await seedPrincipal(
        fixture,
        tenantA,
        grantOnlyViewer,
        developer.principalId,
      );
      const revokedMembershipCookie = await seedPrincipal(
        fixture,
        tenantA,
        revokedMembership,
        developer.principalId,
      );
      const missingMembershipCookie = await seedPrincipal(
        fixture,
        tenantA,
        missingMembership,
        developer.principalId,
      );
      const disabledCookie = await seedPrincipal(
        fixture,
        tenantA,
        disabled,
        developer.principalId,
      );
      const revokedGrantCookie = await seedPrincipal(
        fixture,
        tenantA,
        revokedGrant,
        developer.principalId,
      );

      // An unlinked browser session is denied by identity resolution, not by
      // the service principal import-authority route; no facts may persist.
      const serviceResponse = await fixture.app.fetch(
        importRequest(
          serviceCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          "security-service-grant",
          { commitSha: gitFixture.commitSha },
        ),
      );
      assertEquals(serviceResponse.status, 403);
      assertEquals(await problemCode(serviceResponse), "AUTH_FORBIDDEN");
      await assertNoImportFacts(fixture, tenantA);
      const grantOnlyViewerResponse = await fixture.app.fetch(
        importRequest(
          grantOnlyViewerCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          "security-grant-only-viewer",
          { commitSha: gitFixture.commitSha },
        ),
      );
      assertEquals(grantOnlyViewerResponse.status, 404);
      assertEquals(
        await problemCode(grantOnlyViewerResponse),
        "RESOURCE_NOT_FOUND",
      );
      await assertNoImportFacts(fixture, tenantA);

      const revokedMembershipResponse = await fixture.app.fetch(
        importRequest(
          revokedMembershipCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          "security-revoked-membership",
          { commitSha: gitFixture.commitSha },
        ),
      );
      assertEquals(revokedMembershipResponse.status, 404);
      assertEquals(
        await problemCode(revokedMembershipResponse),
        "RESOURCE_NOT_FOUND",
      );
      await assertNoImportFacts(fixture, tenantA);

      const missingMembershipResponse = await fixture.app.fetch(
        importRequest(
          missingMembershipCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          "security-missing-membership",
          { commitSha: gitFixture.commitSha },
        ),
      );
      assertEquals(missingMembershipResponse.status, 404);
      assertEquals(
        await problemCode(missingMembershipResponse),
        "RESOURCE_NOT_FOUND",
      );
      await assertNoImportFacts(fixture, tenantA);

      const disabledResponse = await fixture.app.fetch(
        importRequest(
          disabledCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          "security-disabled-principal",
          { commitSha: gitFixture.commitSha },
        ),
      );
      assertEquals(disabledResponse.status, 403);
      assertEquals(await problemCode(disabledResponse), "AUTH_FORBIDDEN");
      await assertNoImportFacts(fixture, tenantA);

      const crossTenantResponse = await fixture.app.fetch(
        importRequest(
          developerCookie,
          tenantA.organizationId,
          tenantB.artifactId,
          "security-cross-tenant",
          { commitSha: gitFixture.commitSha },
        ),
      );
      assertEquals(crossTenantResponse.status, 404);
      assertEquals(
        await problemCode(crossTenantResponse),
        "RESOURCE_NOT_FOUND",
      );
      await assertNoImportFacts(fixture, tenantB);

      const staleParentResponse = await fixture.app.fetch(
        importRequest(
          developerCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          "security-stale-parent",
          { commitSha: gitFixture.commitSha, ifMatch: '"v2"' },
        ),
      );
      assertEquals(staleParentResponse.status, 412);
      assertEquals(
        await problemCode(staleParentResponse),
        "PRECONDITION_FAILED",
      );
      await assertNoImportFacts(fixture, tenantA);

      const unverifiedSourceResponse = await fixture.app.fetch(
        importRequest(
          developerCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          "security-unverified-source",
          { commitSha },
        ),
      );
      assertEquals(unverifiedSourceResponse.status, 422);
      assertEquals(
        await problemCode(unverifiedSourceResponse),
        "UNPROCESSABLE",
      );
      await assertNoImportFacts(fixture, tenantA);
      const overComponentLimitPath = Array.from(
        { length: 65 },
        () => "a",
      ).join("/");
      const overComponentLimitResponse = await fixture.app.fetch(
        importRequest(
          developerCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          "security-over-component-limit",
          { commitSha: gitFixture.commitSha, path: overComponentLimitPath },
        ),
      );
      assertEquals(overComponentLimitResponse.status, 422);
      assertEquals(
        await problemCode(overComponentLimitResponse),
        "UNPROCESSABLE",
      );
      await assertNoImportFacts(fixture, tenantA);
      const revokedGrantKey = `security-revoked-grant-${crypto.randomUUID()}`;
      const revokedGrantResponse = await fixture.app.fetch(
        importRequest(
          revokedGrantCookie,
          tenantA.organizationId,
          tenantA.artifactId,
          revokedGrantKey,
          {
            commitSha: gitFixture.commitSha,
            ifMatch: '"v1"',
            path: "src/readme.txt",
          },
        ),
      );
      assertEquals(
        revokedGrantResponse.status,
        201,
        await revokedGrantResponse.clone().text(),
      );
      const revokedGrantBody = await revokedGrantResponse.json() as Record<
        string,
        unknown
      >;
      assertEquals(revokedGrantBody.authorId, revokedGrant.principalId);
      assertEquals(
        revokedGrantBody.sha256,
        await sha256Bytes(gitFixture.content),
      );
      assertEquals(revokedGrantBody.metadata, {
        sourceRepositoryId: tenantA.repositoryId,
        path: "src/readme.txt",
        commitSha: gitFixture.commitSha,
      });
      assertEquals(
        await importFactCounts(
          fixture,
          tenantA,
          revokedGrant.principalId,
          revokedGrantKey,
        ),
        {
          versions: 1,
          events: 1,
          outbox: 1,
          audits: 1,
          idempotency: 1,
        },
      );
    } catch (error) {
      testFailed = true;
      throw error;
    } finally {
      const organizationIds = [
        tenantA.organizationId,
        tenantB.organizationId,
      ];
      const principalIds = [
        developer.principalId,
        service.principalId,
        revokedMembership.principalId,
        grantOnlyViewer.principalId,
        missingMembership.principalId,
        disabled.principalId,
        revokedGrant.principalId,
      ];
      const emails = [
        developer,
        grantOnlyViewer,
        service,
        revokedMembership,
        missingMembership,
        disabled,
        revokedGrant,
      ].map((principal) => `issue44-${principal.principalId}@example.test`);
      let cleanupError: unknown;
      const attemptCleanup = async (
        operation: () => Promise<unknown>,
      ): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupError ??= error;
        }
      };
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.permission_grants
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.idempotency_records
            where organization_id = any($1::uuid[])
              and operation = 'artifactVersions.import'`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.outbox
            where organization_id = any($1::uuid[])
              and event_id in (
                select id from bakery.domain_events
                 where organization_id = any($1::uuid[])
                   and aggregate_id = $2
                   and event_type = 'artifact.version_created'
              )`,
          [organizationIds, tenantA.artifactId],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.audit_events
            where organization_id = $1
              and operation = 'artifactVersions.import'
              and resource_type = 'artifact_version'
              and resource_id in (
                select id::text from bakery.artifact_versions
                 where organization_id = $1 and artifact_id = $2
              )`,
          [tenantA.organizationId, tenantA.artifactId],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.domain_events
            where organization_id = $1
              and aggregate_id = $2
              and event_type = 'artifact.version_created'`,
          [tenantA.organizationId, tenantA.artifactId],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.artifact_versions
            where organization_id = $1 and artifact_id = $2`,
          [tenantA.organizationId, tenantA.artifactId],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.artifacts
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.tasks
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.conversations
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.repositories
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.applications
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.organization_invitations
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.organization_memberships
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.event_clock
            where organization_id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from public.invitation
            where "organizationId" = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from public.member
            where "organizationId" = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.organizations
            where id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from public.organization
            where id = any($1::uuid[])`,
          [organizationIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from public.session
            where "userId" in (
              select id from public."user"
               where email = any($1::text[])
            )`,
          [emails],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from bakery.principals
            where id = any($1::uuid[])`,
          [principalIds],
        )
      );
      await attemptCleanup(() =>
        fixture.pgDatabase.query(
          `delete from public."user"
            where email = any($1::text[])`,
          [emails],
        )
      );
      await attemptCleanup(() => fixture.close());
      if (cleanupError !== undefined) {
        if (testFailed) {
          console.error(
            "Security fixture database cleanup failed:",
            cleanupError,
          );
        } else {
          databaseCleanupError = cleanupError;
        }
      }
    }
    if (databaseCleanupError !== undefined) {
      throw databaseCleanupError;
    }
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (previousConfig === undefined) {
        Deno.env.delete(TRUSTED_REPOSITORIES_ENV);
      } else {
        Deno.env.set(TRUSTED_REPOSITORIES_ENV, previousConfig);
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await removeOwnedGitRoot(gitFixture.root);
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) {
      if (testFailed) {
        console.error(
          "Security fixture environment or Git cleanup failed:",
          cleanupError,
        );
      } else {
        environmentCleanupError = cleanupError;
      }
    }
  }
  if (environmentCleanupError !== undefined) {
    throw environmentCleanupError;
  }
});

async function cleanupTenantGraph(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  tenant: TenantSeed,
): Promise<void> {
  // Remove scoped artifact and task rows before cleanupAuthFixture removes
  // their creator principal; the database must keep those foreign keys intact.
  for (
    const table of [
      "bakery.outbox",
      "bakery.audit_events",
      "bakery.domain_events",
      "bakery.idempotency_records",
      "bakery.artifact_versions",
      "bakery.artifacts",
      "bakery.tasks",
      "bakery.conversations",
      "bakery.repositories",
      "bakery.applications",
      "bakery.event_clock",
    ] as const
  ) {
    await fixture.pgDatabase.query(
      `delete from ${table} where organization_id = $1`,
      [tenant.organizationId],
    );
  }
}

Deno.test("live validators and extraction enforce authority before bytes and unsafe media stays attached", async () => {
  const tenant: TenantSeed = {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
  };
  const developer: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: "developer",
    status: "active",
    membership: true,
    disabled: false,
    grantRevoked: false,
  };
  // Human memberships require a role; an exact grant without membership
  // must not expose extraction bytes.
  const grantOnlyViewer: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: null,
    status: "active",
    membership: false,
    disabled: false,
    grantRevoked: false,
  };
  const previousConfig = Deno.env.get(TRUSTED_REPOSITORIES_ENV);
  const gitFixture = await createVerifiedBareRepository();
  let fixture;
  try {
    Deno.env.set(
      TRUSTED_REPOSITORIES_ENV,
      await trustedConfig(
        tenant,
        gitFixture.bareRepositoryPath,
        gitFixture.commitSha,
      ),
    );
    fixture = await openAuthFixture();
    await seedTenantOrganization(fixture, tenant);
    const developerCookie = await seedPrincipal(
      fixture,
      tenant,
      developer,
      developer.principalId,
    );
    await seedTenantGraph(fixture, tenant, developer.principalId);
    const viewerCookie = await seedPrincipal(
      fixture,
      tenant,
      grantOnlyViewer,
      developer.principalId,
    );
    await fixture.pgDatabase.query(
      `insert into bakery.permission_grants (
         organization_id, principal_id, capability, revoked_at,
         granted_by_principal_id
       ) values ($1, $2, 'artifactVersions.extract', null, $3)`,
      [
        tenant.organizationId,
        grantOnlyViewer.principalId,
        developer.principalId,
      ],
    );

    const imported = await fixture.app.fetch(
      importRequest(
        developerCookie,
        tenant.organizationId,
        tenant.artifactId,
        "security-read-authority",
        { commitSha: gitFixture.commitSha },
      ),
    );
    assertEquals(imported.status, 201, await imported.clone().text());
    const importedBody = await imported.json() as {
      id: string;
      sha256: string;
    };
    const contentRequest = (
      cookie: string,
      versionId: string,
      headers: Record<string, string> = {},
    ) =>
      new Request(
        `${authTestOrigin}/v1/artifact-versions/${versionId}/content`,
        {
          headers: {
            cookie,
            origin: authTestOrigin,
            "Bakery-Organization-Id": tenant.organizationId,
            ...headers,
          },
        },
      );
    const deniedValidator = await fixture.app.fetch(
      contentRequest(viewerCookie, importedBody.id, {
        "if-none-match": `"${importedBody.sha256}"`,
      }),
    );
    assertEquals(deniedValidator.status, 404);
    assertEquals(
      await problemCode(deniedValidator),
      "RESOURCE_NOT_FOUND",
    );

    const unsafeArtifactId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.artifacts (
         id, organization_id, task_id, artifact_type, name, revision, version
       ) values ($1, $2, $3, 'source', 'unsafe', 1, 1)`,
      [unsafeArtifactId, tenant.organizationId, tenant.taskId],
    );
    const unsafeContent = new TextEncoder().encode("<script>alert(1)</script>");
    const unsafeVersion = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.artifact_versions (
         organization_id, artifact_id, task_id, run_step_id, revision,
         author_id, subject_head_sha, subject_base_sha, step_key, metadata,
         content, sha256, size_bytes, media_type
       ) values ($1, $2, $3, null, 1, $4, null, null, null, $5, $6, $7, $8, $9)
       returning id`,
      [
        tenant.organizationId,
        unsafeArtifactId,
        tenant.taskId,
        developer.principalId,
        {},
        unsafeContent,
        await sha256Bytes(unsafeContent),
        unsafeContent.byteLength,
        "text/html",
      ],
    );
    const unsafeVersionId = unsafeVersion.rows[0]!.id;
    const unsafeRead = await fixture.app.fetch(
      contentRequest(developerCookie, unsafeVersionId),
    );
    assertEquals(unsafeRead.status, 200);
    assertEquals(
      Array.from(new Uint8Array(await unsafeRead.arrayBuffer())),
      Array.from(unsafeContent),
    );
    assertEquals(
      unsafeRead.headers.get("content-disposition"),
      'attachment; filename="artifact.bin"',
    );
    assertEquals(unsafeRead.headers.get("x-content-type-options"), "nosniff");
    assertEquals(unsafeRead.headers.get("content-security-policy"), "sandbox");

    const grantOnlyExtraction = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/artifact-versions/${importedBody.id}/extract?maxBytes=1`,
        {
          headers: {
            cookie: viewerCookie,
            origin: authTestOrigin,
            "Bakery-Organization-Id": tenant.organizationId,
          },
        },
      ),
    );
    assertEquals(grantOnlyExtraction.status, 404);
    assertEquals(
      await problemCode(grantOnlyExtraction),
      "RESOURCE_NOT_FOUND",
    );

    const unsafeExtraction = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/artifact-versions/${unsafeVersionId}/extract`,
        {
          headers: {
            cookie: developerCookie,
            origin: authTestOrigin,
            "Bakery-Organization-Id": tenant.organizationId,
          },
        },
      ),
    );
    assertEquals(unsafeExtraction.status, 422);
    assertEquals(await problemCode(unsafeExtraction), "UNPROCESSABLE");
  } finally {
    if (fixture) {
      await cleanupTenantGraph(fixture, tenant);
      await cleanupAuthFixture(fixture.pgDatabase, [
        `issue44-${developer.principalId}@example.test`,
        `issue44-${grantOnlyViewer.principalId}@example.test`,
      ]);
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id = $1`,
        [tenant.organizationId],
      );
      await fixture.pgDatabase.query(
        `delete from public.organization where id = $1`,
        [tenant.organizationId],
      );
      await fixture.close();
    }
    if (previousConfig === undefined) {
      Deno.env.delete(TRUSTED_REPOSITORIES_ENV);
    } else {
      Deno.env.set(TRUSTED_REPOSITORIES_ENV, previousConfig);
    }
    await removeOwnedGitRoot(gitFixture.root);
  }
});

Deno.test("exact import grant without active Developer membership is denied before repository probe", async () => {
  const tenant: TenantSeed = {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
  };
  const grantOnlyViewer: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: "developer",
    status: "inactive",
    membership: true,
    disabled: false,
    grantRevoked: false,
  };
  const previousConfig = Deno.env.get(TRUSTED_REPOSITORIES_ENV);
  const gitFixture = await createVerifiedBareRepository();
  let fixture;
  try {
    Deno.env.set(
      TRUSTED_REPOSITORIES_ENV,
      await trustedConfig(
        tenant,
        `${gitFixture.root}/work`,
        gitFixture.commitSha,
      ),
    );
    fixture = await openAuthFixture();
    await seedTenantOrganization(fixture, tenant);
    const cookie = await seedPrincipal(
      fixture,
      tenant,
      grantOnlyViewer,
      grantOnlyViewer.principalId,
    );
    await seedTenantGraph(fixture, tenant, grantOnlyViewer.principalId);

    const denied = await fixture.app.fetch(
      importRequest(
        cookie,
        tenant.organizationId,
        tenant.artifactId,
        "security-capability-without-developer-role",
        { commitSha: gitFixture.commitSha },
      ),
    );
    assertEquals(denied.status, 404, await denied.clone().text());
    assertEquals(await problemCode(denied), "RESOURCE_NOT_FOUND");
    await assertNoImportFacts(fixture, tenant);
  } finally {
    if (fixture) {
      await cleanupTenantGraph(fixture, tenant);
      await cleanupAuthFixture(fixture.pgDatabase, [
        `issue44-${grantOnlyViewer.principalId}@example.test`,
      ]);
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id = $1`,
        [tenant.organizationId],
      );
      await fixture.pgDatabase.query(
        `delete from public.organization where id = $1`,
        [tenant.organizationId],
      );
      await fixture.close();
    }
    if (previousConfig === undefined) {
      Deno.env.delete(TRUSTED_REPOSITORIES_ENV);
    } else {
      Deno.env.set(TRUSTED_REPOSITORIES_ENV, previousConfig);
    }
    await removeOwnedGitRoot(gitFixture.root);
  }
});

Deno.test("import rejects a missing promised Git blob without lazy fetch or persistence", async () => {
  const tenant: TenantSeed = {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
  };
  const developer: PrincipalSeed = {
    providerUserId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    principalType: "human",
    role: "developer",
    status: "active",
    membership: true,
    disabled: false,
    grantRevoked: false,
  };
  const previousConfig = Deno.env.get(TRUSTED_REPOSITORIES_ENV);
  let gitFixture: VerifiedBareRepository | undefined;
  let fixture;
  let testFailed = false;
  let environmentCleanupError: unknown;
  try {
    const sourceFixture = await createVerifiedBareRepository();
    gitFixture = sourceFixture;
    const promisorFixture = await createPromisorRepository(sourceFixture);
    Deno.env.set(
      TRUSTED_REPOSITORIES_ENV,
      await trustedConfig(
        tenant,
        promisorFixture.bareRepositoryPath,
        promisorFixture.commitSha,
      ),
    );
    fixture = await openAuthFixture();
    await seedTenantOrganization(fixture, tenant);
    const cookie = await seedPrincipal(
      fixture,
      tenant,
      developer,
      developer.principalId,
    );
    await seedTenantGraph(fixture, tenant, developer.principalId);

    const rejected = await fixture.app.fetch(
      importRequest(
        cookie,
        tenant.organizationId,
        tenant.artifactId,
        "security-promised-blob-no-lazy-fetch",
        { commitSha: promisorFixture.commitSha },
      ),
    );
    assertEquals(rejected.status, 503, await rejected.clone().text());
    assertEquals(await problemCode(rejected), "DEPENDENCY_UNAVAILABLE");
    await assertNoImportFacts(fixture, tenant);
    await assertRejects(() =>
      git([
        "--git-dir",
        promisorFixture.bareRepositoryPath,
        "cat-file",
        "-e",
        promisorFixture.blobSha,
      ])
    );
    let remoteInvocations = "";
    try {
      remoteInvocations = await Deno.readTextFile(
        promisorFixture.remoteInvocationLogPath,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    assertEquals(remoteInvocations, "");
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    let cleanupError: unknown;
    const attemptCleanup = async (
      operation: () => Promise<unknown> | void,
    ): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupError ??= error;
      }
    };
    if (fixture) {
      await attemptCleanup(() => cleanupTenantGraph(fixture!, tenant));
      await attemptCleanup(() =>
        cleanupAuthFixture(fixture!.pgDatabase, [
          `issue44-${developer.principalId}@example.test`,
        ])
      );
      await attemptCleanup(() =>
        fixture!.pgDatabase.query(
          `delete from bakery.organizations where id = $1`,
          [tenant.organizationId],
        )
      );
      await attemptCleanup(() =>
        fixture!.pgDatabase.query(
          `delete from public.organization where id = $1`,
          [tenant.organizationId],
        )
      );
      await attemptCleanup(() => fixture!.close());
    }
    await attemptCleanup(() => {
      if (previousConfig === undefined) {
        Deno.env.delete(TRUSTED_REPOSITORIES_ENV);
      } else {
        Deno.env.set(TRUSTED_REPOSITORIES_ENV, previousConfig);
      }
    });
    if (gitFixture) {
      await attemptCleanup(() => removeOwnedGitRoot(gitFixture!.root));
    }
    if (cleanupError !== undefined) {
      if (testFailed) {
        console.error(
          "Security fixture environment or Git cleanup failed:",
          cleanupError,
        );
      } else {
        environmentCleanupError = cleanupError;
      }
    }
  }
  if (environmentCleanupError !== undefined) {
    throw environmentCleanupError;
  }
});
