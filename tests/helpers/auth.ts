import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import type { InstallationSettingsUpdate } from "../../packages/contracts/src/installation-settings.ts";
import { InstallationSettingsUpdateSchema } from "../../packages/contracts/src/installation-settings.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  createReadyAuthProvider,
} from "../../apps/server/src/modules/auth/index.ts";
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import { REMOTE_ADDRESS_HEADER } from "../../apps/server/src/modules/auth/adapters/better-auth.ts";
import type { SkillFileStoreOperations } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
} from "../../apps/server/src/platform/migrate.ts";
import {
  readRuntimeConfig,
  readTestDatabaseConfig,
} from "../../packages/config/src/env.ts";
import { parseTotpSecret, totpCode } from "./totp.ts";

export const authTestOrigin = "http://127.0.0.1:8788";
export const authTestSecret = "phase-6-test-only-secret-value-32-bytes";

const syntheticClientRandom = crypto.getRandomValues(new Uint8Array(2));
const syntheticClientA = 1 + (syntheticClientRandom[0] % 254);
const syntheticClientB = 1 + (syntheticClientRandom[1] % 254);
let syntheticClientCounter = 0;

/**
 * Better Auth's core rate limiter buckets every request with no resolvable
 * client IP into one shared `no-trusted-ip` key, durably (`storage:
 * "database"`), so it must never be cleared on fixture open — a test that
 * asserts the limiter survives a restart depends on that durability. Tests
 * that call `fixture.app.fetch(request)` with no explicit `remoteAddr`
 * would otherwise collide with each other's `/sign-in/*`, `/sign-up/*` and
 * `/two-factor/*` buckets in the same table. Each such call gets a distinct
 * synthetic client instead; callers that need a specific, shared, or
 * repeated client pass their own `remoteAddr` env, which always wins.
 *
 * Reserved address space: synthetic clients live under
 * `10.<1-254, random per process>.<1-254, random per process>.<1-254,
 * wraps>` — two random octets keep two concurrent processes from sharing a
 * bucket in the durable `rateLimit` table. Explicit, hand-picked test
 * literals must use TEST-NET-1 (`192.0.2.<n>`, RFC 5737) instead of any
 * `10.x.x.x` address, so they can never collide with a synthetic client in
 * this process or a concurrent one.
 */
export type SyntheticClientEnv = {
  remoteAddr: { transport: "tcp"; hostname: string; port: number };
};

export function nextClientEnv(): SyntheticClientEnv {
  syntheticClientCounter = (syntheticClientCounter % 254) + 1;
  const hostname =
    `10.${syntheticClientA}.${syntheticClientB}.${syntheticClientCounter}`;
  return { remoteAddr: { transport: "tcp", hostname, port: 1 } };
}

export async function openAuthFixture(options: {
  databaseConfig?: ReturnType<typeof readTestDatabaseConfig>;
  secretsKey?: Parameters<typeof createApp>[0]["config"]["secretsKey"];
  secretsFetch?: typeof fetch;
  /** GitHub App API port; tests pass the fake from fake-github-app.ts. */
  githubAppClient?: Parameters<typeof createApp>[0]["githubAppClient"];
  /** Token broker the app's API and a test's reconcile share. */
  installationTokenBroker?: Parameters<
    typeof createApp
  >[0]["installationTokenBroker"];
  /** Ticket reads and fact index of the ticket routes; tests pass in-memory ones. */
  ticketReader?: Parameters<typeof createApp>[0]["ticketReader"];
  ticketFactIndex?: Parameters<typeof createApp>[0]["ticketFactIndex"];
  publicOrigin?: string;
  secret?: string;
  installationPolicy?: InstallationSettingsUpdate;
  log?: (code: string) => void;
  eventsSocket?: Parameters<typeof createApp>[0]["eventsSocket"];
  collaborationSocket?: Parameters<typeof createApp>[0]["collaborationSocket"];
  draftIsolation?: Parameters<typeof createApp>[0]["draftIsolation"];
  skillFileRoot?: string;
  skillFileStore?: SkillFileStoreOperations;
  /** Skill storage verification probe; tests inject one so none reaches R2. */
  skillStorageProbe?: Parameters<typeof createApp>[0]["skillStorageProbe"];
  /** Extra runtime environment, such as the server budget policy. */
  env?: Record<string, string>;
} = {}) {
  const { databaseUrl: url, appDatabaseUrl: appUrl } = options.databaseConfig ??
    readTestDatabaseConfig();
  const database = openDatabase(url);
  const pgDatabase = openPgDatabase(url);
  let runtimeDatabase: ReturnType<typeof openDatabase> | undefined;
  let runtimePgDatabase: ReturnType<typeof openPgDatabase> | undefined;
  let priorPolicy: {
    registration: string;
    organizations: string;
    version: number;
    updater: string | null;
    updatedAt: Date;
  } | undefined;
  try {
    await migrateProvider(
      pgDatabase,
      await loadMigrations(betterAuthMigrationSource),
    );

    await migrate(database, [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ]);
    await migrateData(database, [
      ...bakeryDataMigrations,
    ]);
    if (options.installationPolicy) {
      const policy = InstallationSettingsUpdateSchema.parse(
        options.installationPolicy,
      );
      priorPolicy = (await pgDatabase.query<
        {
          registration: string;
          organizations: string;
          version: number;
          updater: string | null;
          updatedAt: Date;
        }
      >(
        `select registration_mode as registration, organization_creation_policy as organizations,
          version, updated_by_principal_id as updater, updated_at as "updatedAt"
         from bakery.installation_settings where id = true`,
      )).rows[0];
      await pgDatabase.query(
        `update bakery.installation_settings set registration_mode = $1,
         organization_creation_policy = $2, version = version + 1, updated_at = $3 where id = true`,
        [
          policy.registrationMode,
          policy.organizationCreationPolicy,
          new Date(),
        ],
      );
    }
    runtimeDatabase = openDatabase(appUrl);
    runtimePgDatabase = openPgDatabase(appUrl);
    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: appUrl,
      BAKERY_PUBLIC_BASE_URL: options.publicOrigin ?? authTestOrigin,
      BETTER_AUTH_SECRET: options.secret ?? authTestSecret,
      ...(options.secretsKey
        ? {
          BAKERY_SECRETS_KEY_FILE: options.secretsKey.file,
          BAKERY_SECRETS_KEY_ID: options.secretsKey.keyId,
        }
        : {}),
      ...(options.skillFileRoot
        ? { BAKERY_SKILL_FILE_ROOT: options.skillFileRoot }
        : {}),
      ...options.env,
    });
    const persistence = createPostgresAuthPersistence(runtimePgDatabase);
    const auth = await createReadyAuthProvider({
      pgDatabase: runtimePgDatabase,
      config: config.auth!,
      persistence,
      log: options.log,
    });
    const app = createApp({
      config,
      database: runtimeDatabase,
      pgDatabase: runtimePgDatabase,
      auth,
      authPersistence: persistence,
      eventsSocket: options.eventsSocket,
      collaborationSocket: options.collaborationSocket,
      secretsFetch: options.secretsFetch,
      githubAppClient: options.githubAppClient,
      installationTokenBroker: options.installationTokenBroker,
      ticketReader: options.ticketReader,
      ticketFactIndex: options.ticketFactIndex,
      draftIsolation: options.draftIsolation,
      skillFileStore: options.skillFileStore,
      skillStorageProbe: options.skillStorageProbe,
    });
    const originalFetch = app.fetch.bind(app);
    app.fetch = (
      request: Request,
      env?: Parameters<typeof originalFetch>[1],
      executionContext?: Parameters<typeof originalFetch>[2],
    ) => originalFetch(request, env ?? nextClientEnv(), executionContext);
    // Tests that call `auth.handler` directly bypass the `/api/auth/*`
    // passthrough that injects the connection address, so give those the
    // same per-call synthetic client the `app.fetch` wrapper does.
    const originalHandler = auth.handler;
    auth.handler = (request: Request) => {
      if (request.headers.has(REMOTE_ADDRESS_HEADER)) {
        return originalHandler(request);
      }
      const headers = new Headers(request.headers);
      headers.set(REMOTE_ADDRESS_HEADER, nextClientEnv().remoteAddr.hostname);
      return originalHandler(new Request(request, { headers }));
    };
    return {
      app,
      auth,
      database,
      pgDatabase,
      runtimePgDatabase,
      config,
      close: async () => {
        if (priorPolicy) {
          await pgDatabase.query(
            `update bakery.installation_settings set registration_mode = $1,
           organization_creation_policy = $2, version = $3, updated_by_principal_id = $4, updated_at = $5 where id = true`,
            [
              priorPolicy.registration,
              priorPolicy.organizations,
              priorPolicy.version,
              priorPolicy.updater,
              priorPolicy.updatedAt,
            ],
          );
        }
        await Promise.all([
          closePgDatabase(runtimePgDatabase!),
          closeDatabase(runtimeDatabase!),
          closePgDatabase(pgDatabase),
          closeDatabase(database),
        ]);
      },
    };
  } catch (error) {
    if (runtimePgDatabase) await closePgDatabase(runtimePgDatabase);
    if (runtimeDatabase) await closeDatabase(runtimeDatabase);
    await Promise.all([
      closePgDatabase(pgDatabase),
      closeDatabase(database),
    ]);
    throw error;
  }
}

export function authRequest(
  path: string,
  body: unknown,
  options: {
    cookie?: string;
    origin?: string | null;
    headers?: HeadersInit;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? authTestOrigin);
  }
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${authTestOrigin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) =>
    value.startsWith("better-auth.session_token=")
  );
  if (!cookie) throw new Error("SESSION_COOKIE_REQUIRED");
  return cookie.split(";", 1)[0];
}

/** The slice of `openAuthFixture()` request-driving helpers need. */
export type AppFixture = {
  app: { fetch(request: Request): Response | Promise<Response> };
};

/** A `GET` against the test origin, with the session cookie when given. */
export function get(path: string, cookie?: string): Request {
  return new Request(
    `${authTestOrigin}${path}`,
    cookie ? { headers: { cookie } } : undefined,
  );
}

export async function userIdFor(
  pgDatabase: PgDatabase,
  email: string,
): Promise<string> {
  const users = await pgDatabase.query<{ id: string }>(
    'select id from public."user" where email = $1',
    [email],
  );
  return users.rows[0].id;
}

export async function cleanupAuthFixture(
  pgDatabase: Awaited<ReturnType<typeof openAuthFixture>>["pgDatabase"],
  emails: readonly string[],
): Promise<void> {
  if (emails.length === 0) return;
  const users = await pgDatabase.query<{ id: string }>(
    'select id from public."user" where email = any($1::text[])',
    [emails],
  );
  const userIds = users.rows.map(({ id }) => id);
  if (userIds.length === 0) return;
  await pgDatabase.query(
    `update bakery.installation_settings
     set bootstrap_principal_id = null, bootstrap_repair_version = null
     where bootstrap_principal_id in (
       select id from bakery.principals where provider_user_id = any($1::uuid[])
     )`,
    [userIds],
  );
  await pgDatabase.query(
    `update bakery.installation_settings set updated_by_principal_id = null
     where updated_by_principal_id in (
       select id from bakery.principals where provider_user_id = any($1::uuid[])
     )`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.installation_administrators
     where principal_id = any(
       select id from bakery.principals
       where provider_user_id = any($1::uuid[])
     )
        or granted_by_principal_id = any(
          select id from bakery.principals
          where provider_user_id = any($1::uuid[])
        )`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.permission_grants
     where principal_id = any(
       select id from bakery.principals
       where provider_user_id = any($1::uuid[])
     )
        or granted_by_principal_id = any(
          select id from bakery.principals
          where provider_user_id = any($1::uuid[])
        )`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.idempotency_records
     where principal_id = any(
       select id from bakery.principals
       where provider_user_id = any($1::uuid[])
     )`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.organizations
     where id in (
       select membership.organization_id
       from bakery.organization_memberships as membership
       join bakery.principals as principal
         on principal.id = membership.principal_id
       where principal.provider_user_id = any($1::uuid[])
       union
       select invitation.organization_id
       from bakery.organization_invitations as invitation
       join bakery.principals as principal
         on principal.id = invitation.inviter_principal_id
       where principal.provider_user_id = any($1::uuid[])
     )`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from public.organization
     where id in (
       select "organizationId" from public.member
       where "userId" = any($1::uuid[])
       union
       select "organizationId" from public.invitation
       where "inviterId" = any($1::uuid[])
     )`,
    [userIds],
  );
  // Membership and organization deletes cascade to these; explicit so the
  // principal delete below never depends on cleanup order.
  await pgDatabase.query(
    `delete from bakery.integration_auth_attempts
     where initiating_principal_id in (
       select id from bakery.principals where provider_user_id = any($1::uuid[]))`,
    [userIds],
  );
  await deleteGitHubAppRegistrationRows(
    pgDatabase,
    `select id from bakery.principals where provider_user_id = any($1::uuid[])`,
    [userIds],
  );
  await deleteSkillStorageRows(
    pgDatabase,
    `select id from bakery.principals where provider_user_id = any($1::uuid[])`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.principals
     where provider_user_id = any($1::uuid[])`,
    [userIds],
  );
  await pgDatabase.query(
    'delete from public."user" where id = any($1::uuid[])',
    [userIds],
  );
}

/**
 * Removes installation GitHub App registration attempts and registrations
 * (with their installation-owned secrets, installations, the connections
 * bound to them and any test effects on those connections) that reference
 * the principals the subquery selects, so those principals can be deleted.
 */
export async function deleteGitHubAppRegistrationRows(
  pgDatabase: Awaited<ReturnType<typeof openAuthFixture>>["pgDatabase"],
  principals: string,
  values: unknown[],
): Promise<void> {
  const registrations = `select id from bakery.integration_app_registrations
    where registered_by in (${principals})`;
  // Installations of these Apps, and every connection and auth attempt that
  // points at them, go first: they reference the registration.
  const installations = `select id from bakery.integration_installations
    where registration_id in (${registrations})`;
  const connections = `select id from bakery.integration_connections
    where installation_id in (${installations})`;
  // Ledger rows are never deleted by the application, and they reference
  // their connection NO ACTION: clear a test's effects on these connections
  // (and the reservation link to them) before the connections go.
  const effects = `select id from bakery.external_effects
    where integration_connection_id in (${connections})`;
  // Ticket rows name their connection, and the principals that acted for a
  // request, without a cascade. Children go first: requests, links, reports,
  // tickets, then sources.
  const sources = `select id from bakery.ticket_sources
    where integration_connection_id in (${connections})`;
  const tickets = `select id from bakery.external_tickets
    where ticket_source_id in (${sources})`;
  await pgDatabase.query(
    `delete from bakery.ticket_requests
     where external_ticket_id in (${tickets})
        or authority_principal_id in (${principals})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.ticket_task_links
     where external_ticket_id in (${tickets})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.ticket_readiness_reports
     where external_ticket_id in (${tickets})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.external_tickets where ticket_source_id in (${sources})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.ticket_sources where id in (${sources})`,
    values,
  );
  await pgDatabase.query(
    `update bakery.budget_reservations set external_effect_id = null
     where external_effect_id in (${effects})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.external_effects where id in (${effects})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.integration_auth_attempts
     where result_connection_id in (${connections})
        or reconnect_connection_id in (${connections})`,
    values,
  );
  // Receipts reference their installation and registration without a cascade;
  // their routes, like the facts and checkpoints of a connection, cascade.
  await pgDatabase.query(
    `delete from bakery.inbound_events
     where installation_id in (${installations})
        or registration_id in (${registrations})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.integration_connections where id in (${connections})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.integration_installations
     where id in (${installations})`,
    values,
  );
  await pgDatabase.query(
    `delete from bakery.integration_app_registration_attempts
     where initiating_principal_id in (${principals})
        or registration_id in (${registrations})`,
    values,
  );
  const deleted = await pgDatabase.query<{ ids: string[] }>(
    `delete from bakery.integration_app_registrations
     where registered_by in (${principals})
     returning array_remove(array[client_secret_id, private_key_secret_id,
       webhook_secret_id], null)::text[] as ids`,
    values,
  );
  const secretIds = deleted.rows.flatMap((row) => row.ids);
  if (secretIds.length === 0) return;
  await pgDatabase.query(
    "update bakery.secrets set active_version_id = null where id = any($1::uuid[])",
    [secretIds],
  );
  await pgDatabase.query(
    "delete from bakery.secret_versions where secret_id = any($1::uuid[])",
    [secretIds],
  );
  await pgDatabase.query(
    "delete from bakery.secrets where id = any($1::uuid[])",
    [secretIds],
  );
}

/**
 * Removes the installation skill storage settings row and its installation
 * secret when either references a principal the subquery selects, so those
 * principals can be deleted. Pass `select id from bakery.principals` to clear
 * the row unconditionally.
 */
export async function deleteSkillStorageRows(
  pgDatabase: Awaited<ReturnType<typeof openAuthFixture>>["pgDatabase"],
  principals: string,
  values: unknown[],
): Promise<void> {
  const deleted = await pgDatabase.query<{ secretId: string | null }>(
    `delete from bakery.skill_storage_settings
      where updated_by in (${principals})
         or secret_id in (
           select secret_id from bakery.secret_versions
            where created_by in (${principals}))
      returning secret_id as "secretId"`,
    values,
  );
  const stray = await pgDatabase.query<{ id: string }>(
    `select distinct secret_id as id from bakery.secret_versions
      where created_by in (${principals})
        and secret_id in (select id from bakery.secrets
          where organization_id is null and provider = 'r2')`,
    values,
  );
  const secretIds = [
    ...deleted.rows.flatMap((row) => row.secretId ? [row.secretId] : []),
    ...stray.rows.map((row) => row.id),
  ];
  if (secretIds.length === 0) return;
  await pgDatabase.query(
    "update bakery.secrets set active_version_id = null where id = any($1::uuid[])",
    [secretIds],
  );
  await pgDatabase.query(
    "delete from bakery.secret_versions where secret_id = any($1::uuid[])",
    [secretIds],
  );
  await pgDatabase.query(
    "delete from bakery.secrets where id = any($1::uuid[])",
    [secretIds],
  );
}

/**
 * Signs a raw session token the way `readSignedSessionToken`
 * (`apps/server/src/modules/auth/middleware.ts:32-66`) verifies it, so tests
 * can seed a `public.session` row directly (emulating a non-password
 * sign-in, e.g. GitHub) and hand the resulting cookie to the app.
 */
export async function signSessionCookie(
  token: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `better-auth.session_token=${token}.${btoa(binary)}`;
}

/**
 * Enrolls TOTP for an already signed-in user: enable → parse the setup URI
 * → verify the first code. Enrollment completion rotates the session
 * (Better Auth's native `verify-totp` behavior), so the returned cookie
 * replaces the caller's.
 */
export async function enrollTotp(
  fixture: AppFixture,
  cookie: string,
  password: string,
): Promise<{ secret: string; backupCodes: string[]; cookie: string }> {
  const enableResponse = await fixture.app.fetch(
    authRequest("/api/auth/two-factor/enable", { password }, { cookie }),
  );
  if (!enableResponse.ok) {
    throw new Error(`TOTP_ENABLE_FAILED_${enableResponse.status}`);
  }
  const { totpURI, backupCodes } = await enableResponse.json() as {
    totpURI: string;
    backupCodes: string[];
  };
  const secret = parseTotpSecret(totpURI);
  const verifyResponse = await fixture.app.fetch(
    authRequest(
      "/api/auth/two-factor/verify-totp",
      { code: await totpCode(secret) },
      { cookie },
    ),
  );
  if (!verifyResponse.ok) {
    throw new Error(`TOTP_VERIFY_FAILED_${verifyResponse.status}`);
  }
  return { secret, backupCodes, cookie: sessionCookie(verifyResponse) };
}
