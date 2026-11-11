import { resolveRepositoryRules } from "../../packages/contracts/src/repository-rules.ts";
import { classifyRepositoryRuleImpact } from "../../packages/contracts/src/repository-rule-preview.ts";
import type {
  OrganizationRepositoryRules,
  RepositoryRuleOverrides,
} from "../../packages/contracts/src/repository-rules.ts";
import {
  baseProfileConfig,
  openRepositoryRulesFixture,
} from "./repository-rules-fixture.ts";

export type RulesFixture = Awaited<
  ReturnType<typeof openRepositoryRulesFixture>
>;

export const previewOrganizationPath = (organizationId: string) =>
  `/v1/organizations/${organizationId}/repository-rule-previews`;
export const previewRepositoryPath = (repositoryId: string) =>
  `/v1/repositories/${repositoryId}/rule-previews`;

/** Tables the previews could conceivably touch; all must stay unchanged. */
export const NO_WRITE_TABLES = [
  "organization_repository_rule_versions",
  "repositories",
  "repository_profiles",
  "applications",
  "audit_events",
  "domain_events",
  "outbox",
  "idempotency_records",
] as const;

/** Row counts of every base table in the bakery schema, via the owner role. */
export async function allTableCounts(
  f: RulesFixture,
): Promise<Record<string, number>> {
  const tables = await f.owner.unsafe(
    `select table_name from information_schema.tables
      where table_schema = 'bakery' and table_type = 'BASE TABLE'
      order by table_name`,
  ) as unknown as Array<{ table_name: string }>;
  const counts: Record<string, number> = {};
  for (const { table_name: name } of tables) {
    const rows = await f.owner.unsafe(
      `select count(*)::int as n from bakery."${name}"`,
    ) as unknown as Array<{ n: number }>;
    counts[name] = rows[0].n;
  }
  return counts;
}

/** Inserts an active profile row (raw config) and activates it. */
export async function seedProfile(
  f: RulesFixture,
  organizationId: string,
  repositoryId: string,
  config: Record<string, unknown>,
  revision = 1,
): Promise<string> {
  const profileId = crypto.randomUUID();
  await f.owner`
    insert into bakery.repository_profiles (
      id, organization_id, repository_id, revision, config, digest, created_by
    ) values (
      ${profileId}, ${organizationId}, ${repositoryId}, ${revision},
      ${f.owner.json(config as never)}, ${"a".repeat(64)},
      ${f.adminA.principalId}
    )`;
  await f.owner`
    update bakery.repositories set active_profile_id = ${profileId}
     where organization_id = ${organizationId} and id = ${repositoryId}`;
  return profileId;
}

/** Inserts a profile revision that is NOT activated. */
export async function seedInactiveProfile(
  f: RulesFixture,
  organizationId: string,
  repositoryId: string,
  config: Record<string, unknown>,
  revision: number,
): Promise<string> {
  const profileId = crypto.randomUUID();
  await f.owner`
    insert into bakery.repository_profiles (
      id, organization_id, repository_id, revision, config, digest, created_by
    ) values (
      ${profileId}, ${organizationId}, ${repositoryId}, ${revision},
      ${f.owner.json(config as never)}, ${"c".repeat(64)},
      ${f.adminA.principalId}
    )`;
  return profileId;
}

/**
 * Gives every repository of the organization that has no active profile the
 * same profile config (one statement), and activates it.
 */
export async function seedBulkProfiles(
  f: RulesFixture,
  organizationId: string,
  config: Record<string, unknown>,
) {
  await f.owner`
    with picked as (
      select id from bakery.repositories
       where organization_id = ${organizationId} and active_profile_id is null
    ), made as (
      insert into bakery.repository_profiles (
        id, organization_id, repository_id, revision, config, digest, created_by
      )
      select gen_random_uuid(), ${organizationId}::uuid, id, 1,
             ${f.owner.json(config as never)}, ${"d".repeat(64)},
             ${f.adminA.principalId}::uuid
        from picked
      returning id, repository_id
    )
    update bakery.repositories r set active_profile_id = made.id
      from made
     where r.organization_id = ${organizationId} and r.id = made.repository_id`;
}

export const policyCommands = (...ids: string[]) => ({
  schemaVersion: 1,
  commands: ids.map((id) => ({ id, argv: ["check", id] })),
});

export const profileWith = (
  overrides?: unknown[],
  commandIds?: string[],
) => ({
  ...baseProfileConfig,
  ...(overrides === undefined
    ? {}
    : { repositoryRules: { entries: overrides } }),
  ...(commandIds === undefined
    ? {}
    : { fixedPolicy: policyCommands(...commandIds) }),
});

export async function archiveRepository(
  f: RulesFixture,
  organizationId: string,
  repositoryId: string,
) {
  await f.owner`
    update bakery.repositories set archived_at = now()
     where organization_id = ${organizationId} and id = ${repositoryId}`;
}

/** Inserts `count` bare repositories named bulk-N under one application. */
export async function seedBulkRepositories(
  f: RulesFixture,
  organizationId: string,
  count: number,
  prefix = "bulk",
) {
  const applicationId = crypto.randomUUID();
  await f.owner`
    insert into bakery.applications (id, organization_id, slug, name)
    values (${applicationId}, ${organizationId}, ${`app-${applicationId}`}, 'Bulk application')`;
  await f.owner`
    insert into bakery.repositories (
      id, organization_id, application_id, integration_connection_id,
      provider_repo_id, owner, name, default_branch
    )
    select gen_random_uuid(), ${organizationId}::uuid, ${applicationId}::uuid,
           gen_random_uuid(), ${prefix} || '-' || g::text, 'bulk-owner',
           ${prefix} || '-' || g::text, 'main'
      from generate_series(1, ${count}::int) as g`;
  return applicationId;
}

type StoredRepository = {
  id: string;
  application_id: string;
  name: string;
  config: Record<string, unknown> | null;
};

/**
 * Independent reference classification: reads every active repository and
 * profile straight from the database and classifies each with the public
 * resolver (`resolveRepositoryRules`), not with the preview's helper.
 */
export async function referenceImpact(
  f: RulesFixture,
  organizationId: string,
  current: OrganizationRepositoryRules | null,
  draft: OrganizationRepositoryRules,
) {
  const rows = await f.owner`
    select r.id, r.application_id, r.name, p.config
      from bakery.repositories r
      left join bakery.repository_profiles p
        on p.organization_id = r.organization_id and p.id = r.active_profile_id
     where r.organization_id = ${organizationId} and r.archived_at is null
     order by r.id` as unknown as StoredRepository[];
  const items = [];
  for (const row of rows) {
    const overrides = (row.config?.repositoryRules ??
      { entries: [] }) as RepositoryRuleOverrides;
    const commands = ((row.config?.fixedPolicy as
      | { commands: Array<{ id: string }> }
      | undefined)?.commands ?? []).map((command) => command.id);
    const before = await resolveRepositoryRules(current, overrides);
    const after = await resolveRepositoryRules(draft, overrides);
    const supersededBefore = new Set(
      before.supersededOverrides.map((item) => item.ruleKey),
    );
    const supersededAfter = new Set(
      after.supersededOverrides.map((item) => item.ruleKey),
    );
    const newlyLocked = overrides.entries.some((entry) =>
      supersededAfter.has(entry.ruleKey) &&
      !supersededBefore.has(entry.ruleKey)
    );
    const overridden = overrides.entries.some((entry) =>
      !supersededAfter.has(entry.ruleKey)
    );
    const unsupported = after.entries.some((entry) =>
      entry.enabled && entry.mode === "require" &&
      (entry.ruleKey === "code.magicNumbers" ||
        entry.ruleKey === "code.magicStrings") &&
      !commands.includes(entry.options.checkBinding as string)
    );
    // The shared helper must agree with the reference on every repository.
    const helper = classifyRepositoryRuleImpact(
      current,
      draft,
      overrides,
      commands,
    );
    const status = newlyLocked
      ? "newly_locked"
      : overridden
      ? "overridden"
      : "inherited";
    if (helper.status !== status || helper.unsupported !== unsupported) {
      throw new Error(`reference mismatch for ${row.id}`);
    }
    items.push({
      repositoryId: row.id,
      applicationId: row.application_id,
      repositoryName: row.name,
      status,
      unsupported,
      supersededRules: after.supersededOverrides.map((item) => item.ruleKey),
      reactivatedRules: before.supersededOverrides.map((item) => item.ruleKey)
        .filter((key) => !supersededAfter.has(key)),
    });
  }
  const counts = {
    repositories: items.length,
    inherited: items.filter((item) => item.status === "inherited").length,
    overridden: items.filter((item) => item.status === "overridden").length,
    newlyLocked: items.filter((item) => item.status === "newly_locked").length,
    unsupported: items.filter((item) => item.unsupported).length,
  };
  return { items, counts };
}

/** Records every SQL statement a pool's checked-out clients run. */
export function recordStatements(pool: unknown) {
  const statements: string[] = [];
  const target = pool as {
    connect: (...args: unknown[]) => unknown;
  };
  const original = target.connect.bind(target);
  const instrument = (value: unknown) => {
    const client = value as {
      query: (...queryArgs: unknown[]) => unknown;
      __recorded?: boolean;
      __sink?: string[];
    } | undefined;
    if (!client) return;
    // Pooled clients are reused across recorders: only the sink changes.
    client.__sink = statements;
    if (client.__recorded) return;
    client.__recorded = true;
    const query = client.query.bind(client);
    client.query = (...queryArgs: unknown[]) => {
      const first = queryArgs[0];
      client.__sink?.push(
        typeof first === "string"
          ? first
          : String((first as { text?: string })?.text ?? ""),
      );
      return query(...queryArgs);
    };
  };
  target.connect = (...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === "function") as
      | ((...cbArgs: unknown[]) => unknown)
      | undefined;
    if (callback) {
      return original((error: unknown, client: unknown, done: unknown) => {
        instrument(client);
        return callback(error, client, done);
      });
    }
    return (original(...args) as Promise<unknown>).then((client) => {
      instrument(client);
      return client;
    });
  };
  return {
    statements,
    restore() {
      target.connect = original;
    },
  };
}

export { stripSqlNoise, writeStatementsOf } from "./sql-write-detector.ts";
