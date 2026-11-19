import { assertEquals } from "@std/assert";
import { openRepositoryRulesFixture } from "./repository-rules-fixture.ts";

/**
 * Memory source state fixtures (#72), shared by the integration and security
 * lanes.
 *
 * A suite is one fixture for a whole file: opening the repository-rules fixture
 * drops the bakery schema and re-runs every migration, and closing it does that
 * again. Doing that per case is what bloated the system catalogs enough for
 * autovacuum to truncate pg_class and pg_type mid-run, and the exclusive lock
 * that truncation takes stalled every connection and migration behind it (a
 * later file's tests then timed out). Each case instead seeds its own
 * repository, task, artifact and version inside the one suite, so no case can
 * see another's rows.
 */

export type Fixture = Awaited<ReturnType<typeof openRepositoryRulesFixture>>;

export type Seeded = {
  fixture: Fixture;
  organizationId: string;
  repositoryId: string;
  artifactId: string;
  taskId: string;
  artifactVersionId: string;
};

export type Suite = {
  fixture: Fixture;
  organizationId: string;
  close: () => Promise<void>;
};

/**
 * Open the one fixture a file shares. guestA becomes a member who may read
 * memory but not artifact versions: a custom role is exactly how an
 * organization grants one without the other.
 */
export async function openSuite(): Promise<Suite> {
  const fixture = await openRepositoryRulesFixture();
  const { owner, organizationAId } = fixture;
  try {
    const roleId = crypto.randomUUID();
    await owner`insert into bakery.organization_roles (id, organization_id, key, name, permissions, created_by_principal_id)
      values (${roleId}, ${organizationAId}, 'memory-readers', 'Memory readers',
        ${[
      "memory:read",
      "memoryRevision:read",
    ]}, ${fixture.adminA.principalId})`;
    await owner`update bakery.organization_memberships set custom_role_id = ${roleId}
      where organization_id = ${organizationAId} and principal_id = ${fixture.guestA.principalId}`;
  } catch (error) {
    await fixture.close();
    throw error;
  }
  return {
    fixture,
    organizationId: organizationAId,
    async close() {
      try {
        await owner`update bakery.organization_memberships set custom_role_id = null
          where organization_id = ${organizationAId}`;
        await owner`delete from bakery.organization_roles
          where organization_id = ${organizationAId}`;
      } finally {
        await fixture.close();
      }
    },
  };
}

/** A fresh repository and cited artifact version for one case. */
export async function seedSource(suite: Suite): Promise<Seeded> {
  const { fixture } = suite;
  const { owner, organizationAId } = fixture;
  const { repositoryId } = await fixture.seedRepository(organizationAId);
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const artifactVersionId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await owner`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
    values (${principalId}, null, 'seed worker', 'worker')`;
  await owner`insert into bakery.applications (id, organization_id, slug, name)
    values (${applicationId}, ${organizationAId}, ${`app-${applicationId}`}, 'Memory application')`;
  await owner`insert into bakery.conversations (id, organization_id, application_id, title, created_by)
    values (${conversationId}, ${organizationAId}, ${applicationId}, 'Memory seed', ${principalId})`;
  await owner`insert into bakery.tasks (id, organization_id, application_id, conversation_id, title, task_type, status, priority, created_by)
    values (${taskId}, ${organizationAId}, ${applicationId}, ${conversationId}, 'Memory seed', 'feature', 'active', 50, ${principalId})`;
  await owner`insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
    values (${artifactId}, ${organizationAId}, ${taskId}, 'research', 'secret-evidence-title')`;
  await owner`insert into bakery.artifact_versions (id, organization_id, artifact_id, task_id, author_id, revision, metadata, content, sha256, size_bytes, media_type)
    values (${artifactVersionId}, ${organizationAId}, ${artifactId}, ${taskId}, ${principalId}, 1, '{}'::jsonb, ${new Uint8Array(
    [1],
  )}, ${"a".repeat(64)}, 1, 'text/plain')`;

  return {
    fixture,
    organizationId: organizationAId,
    repositoryId,
    artifactId,
    taskId,
    artifactVersionId,
  };
}

/** One suite and one case, for a file with a single test. */
export async function seed(): Promise<Seeded & { suite: Suite }> {
  const suite = await openSuite();
  try {
    return { ...await seedSource(suite), suite };
  } catch (error) {
    await suite.close();
    throw error;
  }
}

export async function close(seeded: { suite: Suite }) {
  await seeded.suite.close();
}

export function as(
  seeded: Seeded,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return seeded.fixture.send(method, path, {
    cookie,
    organizationId: seeded.organizationId,
    body,
    idempotencyKey: body === undefined ? undefined : crypto.randomUUID(),
    headers,
  });
}

export const admin = (seeded: Seeded) => seeded.fixture.cookies.adminA;
export const memoryOnlyReader = (seeded: Seeded) =>
  seeded.fixture.cookies.guestA;

export async function promote(seeded: Seeded, subject: string) {
  const response = await as(seeded, admin(seeded), "POST", "/v1/memories", {
    repositoryId: seeded.repositoryId,
    subject,
    content: "Deploys run from main.",
    provenance: {
      sourceArtifactVersionId: seeded.artifactVersionId,
      repositoryId: seeded.repositoryId,
      conflictScan: { verdict: "clean", conflictingMemoryIds: [] },
      confidence: 0.9,
      reviewPolicy: "on_source_change",
    },
  });
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json() as {
    id: string;
    version: number;
    sourceState: string;
    currentRevisionId: string;
  };
}

export async function readBoth(
  seeded: Seeded,
  cookie: string,
  memoryId: string,
) {
  const entry = await as(seeded, cookie, "GET", `/v1/memories/${memoryId}`);
  assertEquals(entry.status, 200, await entry.clone().text());
  const revisions = await as(
    seeded,
    cookie,
    "GET",
    `/v1/memories/${memoryId}/revisions`,
  );
  assertEquals(revisions.status, 200, await revisions.clone().text());
  const listed = await as(seeded, cookie, "GET", "/v1/memories");
  assertEquals(listed.status, 200, await listed.clone().text());
  // The suite holds every case's memories, so the list is narrowed to this
  // memory's own row: the state under test, not a neighbour's.
  const page = await listed.json() as { items: { id: string }[] };
  const own = page.items.filter((item) => item.id === memoryId);
  assertEquals(own.length, 1, "the memory is on the first list page");
  return {
    entry: await entry.json(),
    revisions: await revisions.json(),
    list: { items: own as Record<string, unknown>[] },
  };
}
