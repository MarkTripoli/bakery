import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  openDatabase,
  type openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { resetTestDatabase } from "../../apps/server/src/platform/migrate.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { RepositoryProfileConfigSchema } from "../../packages/contracts/src/repository-profile-config.ts";
import { authTestOrigin, openAuthFixture, signSessionCookie } from "./auth.ts";

export {
  allRuleEntries,
  ballastRules,
  baseProfileConfig,
  commitsEntry,
  configBytesWithRules,
  maxFillerChars,
  titleEntry,
} from "./repository-rule-entries.ts";

export const databaseConfig = readTestDatabaseConfig();

export type SendOptions = {
  cookie?: string;
  organizationId?: string;
  body?: unknown;
  idempotencyKey?: string;
  authorization?: string;
  headers?: Record<string, string>;
};

export type Identity = {
  userId: string;
  principalId: string;
  token: string;
  email: string;
  name: string;
  organizationId: string;
  role: "admin" | "developer" | "viewer" | "guest";
};

export async function ruleDigest(
  revision: number,
  entries: unknown,
): Promise<string> {
  return await sha256Hex(canonicalJson({ revision, entries }));
}

export async function databaseCount(
  database: ReturnType<typeof openPgDatabase>,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const result = await database.query<{ count: string }>(sql, [...values]);
  return Number(result.rows[0]?.count ?? 0);
}

export async function ruleFactCounts(
  database: ReturnType<typeof openPgDatabase>,
  organizationId: string,
) {
  const values = [organizationId];
  return {
    versions: await databaseCount(
      database,
      "select count(*) from bakery.organization_repository_rule_versions where organization_id = $1",
      values,
    ),
    audit: await databaseCount(
      database,
      "select count(*) from bakery.audit_events where organization_id = $1 and operation = 'repositoryRuleVersions.create'",
      values,
    ),
    events: await databaseCount(
      database,
      "select count(*) from bakery.domain_events where organization_id = $1 and event_type = 'repositoryRules.published'",
      values,
    ),
    outbox: await databaseCount(
      database,
      "select count(*) from bakery.outbox where organization_id = $1",
      values,
    ),
  };
}

/** A repository override entry: the organization entry without its lock flag. */
export function overrideOf(entry: Record<string, unknown>) {
  const { locked: _locked, ...rest } = entry;
  return rest;
}

/**
 * Request body for `repositoryProfiles.create`. The digest is computed the way
 * the server does: SHA-256 of the canonical JSON of the parsed config.
 */
export async function profileBody(
  revision: number,
  config: Record<string, unknown>,
  expectedOrganizationRulesRevision?: number,
) {
  const parsed = RepositoryProfileConfigSchema.parse(config);
  return {
    revision,
    config,
    digest: await sha256Hex(canonicalJson(parsed)),
    ...(expectedOrganizationRulesRevision === undefined
      ? {}
      : { expectedOrganizationRulesRevision }),
  };
}

export async function profileFactCounts(
  database: ReturnType<typeof openPgDatabase>,
  organizationId: string,
  repositoryId: string,
) {
  const values = [organizationId];
  const profiles = await database.query<
    { count: string; version: number | null; active: string | null }
  >(
    `select (select count(*) from bakery.repository_profiles
              where organization_id = $1 and repository_id = $2) as count,
            r.version, r.active_profile_id as active
       from bakery.repositories r
      where r.organization_id = $1 and r.id = $2`,
    [organizationId, repositoryId],
  );
  return {
    profiles: Number(profiles.rows[0]?.count ?? 0),
    repositoryVersion: profiles.rows[0]?.version ?? null,
    activeProfileId: profiles.rows[0]?.active ?? null,
    audit: await databaseCount(
      database,
      "select count(*) from bakery.audit_events where organization_id = $1 and operation = 'repositoryProfiles.create'",
      values,
    ),
    events: await databaseCount(
      database,
      "select count(*) from bakery.domain_events where organization_id = $1 and event_type = 'repository.profile_created'",
      values,
    ),
  };
}

async function reset(): Promise<void> {
  const database = openDatabase(databaseConfig.databaseUrl);
  try {
    await resetTestDatabase(database, {
      targetUrl: databaseConfig.databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
  } finally {
    await closeDatabase(database);
  }
}

/**
 * Seeds adminA and developerA in organization A and adminB in organization B
 * on a freshly reset database and returns a request helper plus teardown.
 */
export async function openRepositoryRulesFixture() {
  await reset();
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  const now = new Date("2026-10-25T12:00:00.000Z");
  const sessionExpiresAt = new Date(Date.now() + 86_400_000);
  const organizationAId = crypto.randomUUID();
  const organizationBId = crypto.randomUUID();
  const identity = (
    label: string,
    organizationId: string,
    role: Identity["role"],
  ): Identity => ({
    userId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    token: `${label}-${crypto.randomUUID()}`,
    email: `${label}-${crypto.randomUUID()}@example.test`,
    name: label,
    organizationId,
    role,
  });
  const adminA = identity("admin-a", organizationAId, "admin");
  const developerA = identity("developer-a", organizationAId, "developer");
  const adminB = identity("admin-b", organizationBId, "admin");
  const viewerA = identity("viewer-a", organizationAId, "viewer");
  const guestA = identity("guest-a", organizationAId, "guest");
  const inactiveA = identity("inactive-a", organizationAId, "admin");
  const demotableA = identity("demotable-a", organizationAId, "admin");
  const replayA = identity("replay-a", organizationAId, "admin");
  // One person who administers both organizations (same principal).
  const adminAB = identity("admin-ab", organizationAId, "admin");
  for (
    const [organizationId, name] of [
      [organizationAId, "Organization A"],
      [organizationBId, "Organization B"],
    ] as const
  ) {
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationId}, ${name}, ${`org-${organizationId}`}, '{}'::jsonb,
        ${now}, ${now}, 1
      )`;
  }
  const memberships: Array<[Identity, string, string]> = [
    [adminA, organizationAId, "active"],
    [developerA, organizationAId, "active"],
    [adminB, organizationBId, "active"],
    [viewerA, organizationAId, "active"],
    [guestA, organizationAId, "active"],
    [inactiveA, organizationAId, "inactive"],
    [demotableA, organizationAId, "active"],
    [replayA, organizationAId, "active"],
    [adminAB, organizationAId, "active"],
    [adminAB, organizationBId, "active"],
  ];
  for (
    const who of [
      adminA,
      developerA,
      adminB,
      viewerA,
      guestA,
      inactiveA,
      demotableA,
      replayA,
      adminAB,
    ]
  ) {
    await owner`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (${who.userId}, ${who.name}, ${who.email}, true, ${now}, ${now})`;
    await owner`
      insert into public.session (
        id, token, "userId", "expiresAt", "createdAt", "updatedAt"
      ) values (
        ${crypto.randomUUID()}, ${who.token}, ${who.userId},
        ${sessionExpiresAt}, ${now}, ${now}
      )`;
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${who.principalId}, ${who.userId}, ${who.name}, 'human')`;
  }
  for (const [who, organizationId, status] of memberships) {
    await owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${organizationId}, ${who.principalId},
        ${who.role}, ${status}, ${now}, ${now}, ${now}, 1
      )`;
  }
  const secret = fixture.config.auth!.secret;
  const cookies = {
    adminA: await signSessionCookie(adminA.token, secret),
    developerA: await signSessionCookie(developerA.token, secret),
    adminB: await signSessionCookie(adminB.token, secret),
    viewerA: await signSessionCookie(viewerA.token, secret),
    guestA: await signSessionCookie(guestA.token, secret),
    inactiveA: await signSessionCookie(inactiveA.token, secret),
    demotableA: await signSessionCookie(demotableA.token, secret),
    replayA: await signSessionCookie(replayA.token, secret),
    adminAB: await signSessionCookie(adminAB.token, secret),
  };
  const send = (
    method: string,
    path: string,
    options: SendOptions = {},
  ): Promise<Response> | Response => {
    const headers = new Headers();
    if (options.cookie) headers.set("cookie", options.cookie);
    if (options.organizationId) {
      headers.set("Bakery-Organization-Id", options.organizationId);
    }
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      headers.set("origin", authTestOrigin);
    }
    if (options.idempotencyKey) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    if (options.authorization) {
      headers.set("authorization", options.authorization);
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }
    return fixture.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers,
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
      }),
    );
  };
  return {
    fixture,
    runtime: fixture.runtimePgDatabase,
    organizationAId,
    organizationBId,
    adminA,
    developerA,
    adminB,
    viewerA,
    guestA,
    inactiveA,
    demotableA,
    replayA,
    adminAB,
    owner,
    cookies,
    send,
    /** Inserts an application and a repository (default branch main) directly. */
    async seedRepository(organizationId: string) {
      const applicationId = crypto.randomUUID();
      const repositoryId = crypto.randomUUID();
      await owner`
        insert into bakery.applications (id, organization_id, slug, name)
        values (${applicationId}, ${organizationId}, ${`app-${applicationId}`}, 'Rules application')`;
      await owner`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch
        ) values (
          ${repositoryId}, ${organizationId}, ${applicationId},
          ${crypto.randomUUID()}, ${`repo-${repositoryId}`}, 'rules-owner',
          ${`repo-${repositoryId}`}, 'main'
        )`;
      return { applicationId, repositoryId };
    },
    /**
     * A service account that holds only the `repositoryProfiles.create`
     * grant (developer role) with an admin-scoped token; returns its bearer
     * authorization header value.
     */
    botPrincipalIds: new Map<string, string>(),
    async createGrantOnlyBot(
      extraCapabilities: string[] = [],
    ): Promise<string> {
      const adminAuth = {
        cookie: cookies.adminA,
        organizationId: organizationAId,
      };
      const principal = await send("POST", "/v1/principals", {
        ...adminAuth,
        idempotencyKey: crypto.randomUUID(),
        body: { displayName: "Rules bot", role: "developer" },
      });
      if (principal.status !== 201) throw new Error("BOT_PRINCIPAL_FAILED");
      const principalId = (await principal.json() as { id: string }).id;
      const grant = await send("POST", "/v1/permission-grants", {
        ...adminAuth,
        idempotencyKey: crypto.randomUUID(),
        body: { principalId, capability: "repositoryProfiles.create" },
      });
      if (grant.status !== 201) throw new Error("BOT_GRANT_FAILED");
      for (const capability of extraCapabilities) {
        const extra = await send("POST", "/v1/permission-grants", {
          ...adminAuth,
          idempotencyKey: crypto.randomUUID(),
          body: { principalId, capability },
        });
        if (extra.status !== 201) throw new Error("BOT_EXTRA_GRANT_FAILED");
      }
      const token = await send("POST", "/v1/access-tokens", {
        ...adminAuth,
        idempotencyKey: crypto.randomUUID(),
        body: {
          principalId,
          name: "Rules bot token",
          scopes: ["bakery:admin"],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      if (token.status !== 201) throw new Error("BOT_TOKEN_FAILED");
      const authorization = `Bearer ${
        (await token.json() as { secret: string }).secret
      }`;
      this.botPrincipalIds.set(authorization, principalId);
      return authorization;
    },
    profilesPath: (repositoryId: string) =>
      `/v1/repositories/${repositoryId}/profiles`,
    effectivePath: (repositoryId: string) =>
      `/v1/repositories/${repositoryId}/rules`,
    repositoryPath: (repositoryId: string) =>
      `/v1/repositories/${repositoryId}`,
    rulesPath: (organizationId: string) =>
      `/v1/organizations/${organizationId}/repository-rules`,
    versionsPath: (organizationId: string) =>
      `/v1/organizations/${organizationId}/repository-rule-versions`,
    async close() {
      try {
        await fixture.close();
      } finally {
        await reset();
      }
    },
  };
}
