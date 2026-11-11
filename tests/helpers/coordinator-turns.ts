import {
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  signSessionCookie,
} from "./auth.ts";

export type Fixture = Awaited<ReturnType<typeof openAuthFixture>>;

/** Minimum surface the seeding and request helpers need; a real HTTP stack can supply it too. */
export type Harness = {
  pgDatabase: { query: Fixture["pgDatabase"]["query"] };
  config: { auth?: { secret: string } };
  app: { fetch: (request: Request) => Response | Promise<Response> };
};

export type Seed = {
  organizationId: string;
  principalId: string;
  cookie: string;
  applicationId: string;
  repositoryId: string;
  conversationId: string;
  agentVersionId: string;
};

const seededEmails = new Set<string>();

/** Records an email created outside `seedOrganization` so cleanup removes it too. */
export function recordSeededEmail(email: string): void {
  seededEmails.add(email);
}

/** Deletes every user, principal and organization `seedOrganization` created, so the shared database stays bootstrap-clean. */
export async function cleanupSeededOrganizations(
  fixture: Pick<Fixture, "pgDatabase">,
): Promise<void> {
  const emails = [...seededEmails];
  seededEmails.clear();
  await cleanupAuthFixture(fixture.pgDatabase, emails);
}

/** Seeds an organization, a developer member with a session, a conversation and a coordinator agent. */
export async function seedOrganization(
  fixture: Harness,
  label: string,
  options: { agent?: boolean; role?: string } = {},
): Promise<Seed> {
  const organizationId = crypto.randomUUID();
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `turns-${crypto.randomUUID()}`;
  const now = new Date();
  const db = fixture.pgDatabase;
  const email = `${label}-${providerUserId}@example.test`;
  seededEmails.add(email);
  await db.query(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, $4, $4)`,
    [providerUserId, label, email, now],
  );
  await db.query(
    `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
     values ($1, $2, $3, 'human')`,
    [principalId, providerUserId, label],
  );
  await db.query(
    `insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
     values ($1, $2, $3, '{}'::jsonb, $4, $4, 1)`,
    [organizationId, label, `${label}-${organizationId}`, now],
  );
  await db.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
     ) values ($1, $2, $3, $5, 'active', $4, $4, $4, 1)`,
    [
      crypto.randomUUID(),
      organizationId,
      principalId,
      now,
      options.role ?? "developer",
    ],
  );
  await db.query(
    `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
     values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      token,
      providerUserId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await db.query(
    `insert into bakery.applications (id, organization_id, slug, name, description)
     values ($1, $2, $3, $4, '')`,
    [applicationId, organizationId, `${label}-${applicationId}`, label],
  );
  await db.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch, version
     ) values ($1, $2, $3, $4, $5, 'bakery', $6, 'main', 1)`,
    [
      repositoryId,
      organizationId,
      applicationId,
      crypto.randomUUID(),
      `${label}/${repositoryId}`,
      label,
    ],
  );
  await db.query(
    `insert into bakery.conversations (id, organization_id, application_id, repository_id, title, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      conversationId,
      organizationId,
      applicationId,
      repositoryId,
      label,
      principalId,
    ],
  );
  let agentVersionId = "";
  if (options.agent !== false) {
    agentVersionId = await publishCoordinatorVersion(
      fixture,
      organizationId,
      principalId,
      1,
    );
  }
  return {
    organizationId,
    principalId,
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
    applicationId,
    repositoryId,
    conversationId,
    agentVersionId,
  };
}

/** Publishes coordinator agent revision `revision` and makes it the active version. */
export async function publishCoordinatorVersion(
  fixture: Harness,
  organizationId: string,
  principalId: string,
  revision: number,
): Promise<string> {
  const db = fixture.pgDatabase;
  const found = await db.query<{ id: string }>(
    `select id from bakery.agent_definitions where organization_id = $1 and slug = 'coordinator'`,
    [organizationId],
  );
  let agentId = found.rows[0]?.id;
  if (!agentId) {
    agentId = crypto.randomUUID();
    await db.query(
      `insert into bakery.agent_definitions (id, organization_id, slug, name)
       values ($1, $2, 'coordinator', 'Coordinator')`,
      [agentId, organizationId],
    );
  }
  const versionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.agent_versions (id, organization_id, agent_id, revision, config, digest, created_by)
     values ($1, $2, $3, $4, '{}'::jsonb, $5, $6)`,
    [
      versionId,
      organizationId,
      agentId,
      revision,
      `digest-${versionId}`,
      principalId,
    ],
  );
  await db.query(
    `update bakery.agent_definitions set active_version_id = $3 where organization_id = $1 and id = $2`,
    [organizationId, agentId, versionId],
  );
  return versionId;
}

export async function call(
  fixture: Harness,
  seed: { cookie: string; organizationId: string },
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH";
    key?: string;
    ifMatch?: number;
    body?: unknown;
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers({
    cookie: seed.cookie,
    "Bakery-Organization-Id": seed.organizationId,
  });
  if (method !== "GET") {
    headers.set("origin", authTestOrigin);
    headers.set("content-type", "application/json");
    headers.set("Idempotency-Key", options.key ?? crypto.randomUUID());
    if (options.ifMatch !== undefined) {
      headers.set("If-Match", `"${options.ifMatch}"`);
    }
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }),
    }),
  );
}

export async function sendMessage(
  fixture: Harness,
  seed: Seed,
  intent: "discussion" | "agent_request",
  body: string,
  clientMessageId: string = crypto.randomUUID(),
): Promise<Response> {
  return await call(
    fixture,
    seed,
    `/v1/conversations/${seed.conversationId}/messages`,
    { method: "POST", body: { body, clientMessageId, intent } },
  );
}
