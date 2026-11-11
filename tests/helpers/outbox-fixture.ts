import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  type OrganizationId,
  organizationId as asOrganizationId,
  principalId as asPrincipalId,
} from "../../packages/contracts/src/contracts.ts";
import {
  closeDatabase,
  closePgDatabase,
  type Database,
  openDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
  resetTestDatabase,
} from "../../apps/server/src/platform/migrate.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  preserveProviderInvitationState,
} from "../../apps/server/src/modules/auth/migrations.ts";
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import {
  newOutboxDeliveryKey,
  type OutboxDestination,
  type OutboxId,
  outboxId,
} from "../../apps/server/src/platform/outbox-types.ts";

export type OutboxTestFixture = {
  readonly owner: Database;
  readonly appPg: PgDatabase;
  readonly organizationId: OrganizationId;
  close(): Promise<void>;
};

export type OutboxTestFixtureOptions = {
  readonly databaseUrl?: string;
  readonly appDatabaseUrl?: string;
  readonly resetConfirmation?: string;
  readonly allowRemoteReset?: boolean;
};

type OutboxPayload = Parameters<Database["json"]>[0];

export async function openOutboxTestFixture(
  options: OutboxTestFixtureOptions = {},
): Promise<OutboxTestFixture> {
  const configured = options.databaseUrl && options.appDatabaseUrl
    ? {
      databaseUrl: options.databaseUrl,
      appDatabaseUrl: options.appDatabaseUrl,
    }
    : readTestDatabaseConfig();
  const databaseUrl = options.databaseUrl ?? configured.databaseUrl;
  const appDatabaseUrl = options.appDatabaseUrl ?? configured.appDatabaseUrl;
  const owner = openDatabase(databaseUrl);
  const ownerPg = openPgDatabase(databaseUrl);
  const appPg = openPgDatabase(appDatabaseUrl);
  await resetTestDatabase(owner, {
    targetUrl: databaseUrl,
    confirmation: options.resetConfirmation ??
      readTestDatabaseResetOptions().confirmation,
    allowRemote: options.allowRemoteReset ??
      readTestDatabaseResetOptions().allowRemote,
  });
  await migrateProvider(
    ownerPg,
    await loadMigrations(betterAuthMigrationSource),
    { beforeApply: preserveProviderInvitationState },
  );
  await migrate(owner, [
    ...await loadMigrations(bakeryPlatformMigrationSource),
    ...await loadMigrations(authBakeryMigrationSource),
    ...await loadMigrations(workBakeryMigrationSource),
    ...await loadMigrations(projectsBakeryMigrationSource),
    ...await loadMigrations(agentsBakeryMigrationSource),
    ...await loadMigrations(repositoryRulesBakeryMigrationSource),
    ...await loadMigrations(integrationsBakeryMigrationSource),
    ...await loadMigrations(deliveryBakeryMigrationSource),
  ]);
  await migrateData(owner, bakeryDataMigrations);
  const organizationId = asOrganizationId(crypto.randomUUID());
  const providerUserId = crypto.randomUUID();
  const principalId = asPrincipalId(crypto.randomUUID());
  const now = new Date("2026-09-12T00:00:00.000Z");
  await owner`
    insert into public."user" (
      id, name, email, "emailVerified", "createdAt", "updatedAt"
    ) values (
      ${providerUserId}, 'Outbox Tester',
      ${`outbox-${providerUserId}@example.test`}, true, ${now}, ${now}
    )`;
  await owner`
    insert into bakery.principals (
      id, provider_user_id, display_name, principal_type
    ) values (${principalId}, ${providerUserId}, 'Outbox Tester', 'human')`;
  await owner`
    insert into bakery.organizations (
      id, name, slug, metadata, created_at, updated_at, version
    ) values (
      ${organizationId}, 'Outbox Org', ${`outbox-${organizationId}`},
      '{}'::jsonb, ${now}, ${now}, 1
    )`;
  return {
    owner,
    appPg,
    organizationId,
    async close() {
      await owner`
        delete from bakery.organizations where id = ${organizationId}`;
      await owner`
        delete from bakery.principals where id = ${principalId}`;
      await owner`
        delete from public."user" where id = ${providerUserId}`;
      await Promise.all([
        closePgDatabase(appPg),
        closePgDatabase(ownerPg),
        closeDatabase(owner),
      ]);
    },
  };
}

export async function enqueueOutboxEvent(
  database: Database,
  organizationId: OrganizationId,
  destination: OutboxDestination,
  options: { readonly payload?: OutboxPayload; readonly eventType?: string } =
    {},
): Promise<OutboxId> {
  const aggregateId = crypto.randomUUID();
  return await database.begin(async (transaction) => {
    const clock = await transaction`
      insert into bakery.event_clock (organization_id, stream, next_seq)
      select ${organizationId}, 'domain_events',
        coalesce(max(organization_sequence), 0) + 2
      from bakery.domain_events
      where organization_id = ${organizationId}
      on conflict (organization_id, stream) do update
        set next_seq = bakery.event_clock.next_seq + 1
      returning next_seq - 1 as sequence`;
    const sequence = clock[0]?.sequence;
    if (sequence === undefined) throw new Error("EVENT_CLOCK_UNAVAILABLE");
    const events = await transaction`
      insert into bakery.domain_events (
        organization_id, organization_sequence, event_type, aggregate_id,
        aggregate_version, payload
      ) values (
        ${organizationId}, ${sequence}, ${
      options.eventType ?? "run.requested"
    }, ${aggregateId}, 1,
        ${
      transaction.json(
        options.payload ?? { runId: aggregateId },
      )
    }
      ) returning id`;
    const rows = await transaction`
      insert into bakery.outbox (
        organization_id, event_id, destination, delivery_key
      ) values (
        ${organizationId}, ${events[0].id}, ${destination},
        ${newOutboxDeliveryKey()}
      ) returning id`;
    return outboxId(rows[0]?.id);
  });
}
