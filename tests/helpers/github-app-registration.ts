import { assertEquals } from "@std/assert";
import { deleteGitHubAppRegistrationRows } from "./auth.ts";
import {
  createFakeGitHubApp,
  fakeAppKey,
  type FakeExistingApp,
  type FakeInstallation,
  fakeRepositories,
  type FakeRepository,
} from "./fake-github-app.ts";
import {
  call,
  type InstallationFixture,
  openInstallationFixture,
} from "./installation-settings.ts";
import { createInstallationTokenBroker } from "../../apps/server/src/modules/integrations/token-broker.ts";
import { reconcileInstallation } from "../../apps/server/src/modules/integrations/reconcile.ts";
import { executeDiscovery } from "../../apps/server/src/modules/integrations/discoveries.ts";
import type {
  TicketFactIndex,
  TicketSourceReader,
} from "../../apps/server/src/modules/work/ticket-source-reader.ts";

export const registrationPath = "/v1/integration-app-registrations/github";
export const beginPath = "/v1/integration-app-registrations/github/manifest";
export const callbackPath = "/v1/integration-auth/github/manifest-callback";
export const settingsLocation = (outcome: string) =>
  `/settings/installation/integrations?githubAppRegistration=${outcome}`;

export type ManifestStart = {
  provider: string;
  registrationUrl: string;
  manifest: string;
  state: string;
  expiresAt: string;
};

/** Removes every installation GitHub App registration row and its secrets. */
export async function clearGitHubAppRegistrations(
  fixture: Pick<InstallationFixture, "pgDatabase">,
): Promise<void> {
  await deleteGitHubAppRegistrationRows(
    fixture.pgDatabase,
    "select id from bakery.principals",
    [],
  );
}

/**
 * Installation fixture with a mounted AES key and the fake GitHub API. The
 * registration is installation-wide, so rows are cleared before and after.
 */
export async function openGitHubAppFixture(
  options: {
    requestTimeoutMs?: number;
    /** Ticket reads and fact index the ticket routes use; the live ones by default. */
    ticketReader?: TicketSourceReader;
    ticketFactIndex?: TicketFactIndex;
    /** Extra runtime environment, such as the server budget policy. */
    env?: Record<string, string>;
  } = {},
) {
  const directory = await Deno.makeTempDir({ prefix: "bakery-github-app-" });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const secretsKey = { file, keyId: "github-app-fixture-key-v1" };
  const github = createFakeGitHubApp(options);
  // The API and the tests' reconciles share one broker, as the server
  // process shares it with its background functions.
  const broker = createInstallationTokenBroker({
    github: github.client,
    secretsKey,
  });
  const fixture = await openInstallationFixture(true, {
    secretsKey,
    githubAppClient: github.client,
    installationTokenBroker: broker,
    ticketReader: options.ticketReader,
    ticketFactIndex: options.ticketFactIndex,
    env: options.env,
  });
  await clearGitHubAppRegistrations(fixture);
  return {
    ...fixture,
    github,
    secretsKey,
    broker,
    /** Runs one reconcile of the installation row as the application role. */
    reconcile: (installationId: string) =>
      reconcileInstallation(
        {
          database: fixture.runtimePgDatabase!,
          github: github.client,
          secretsKey,
          broker,
        },
        installationId,
        new AbortController().signal,
      ),
    /** Runs one discovery as the discovery function would, once. */
    discover: (discoveryId: string) =>
      executeDiscovery(
        {
          database: fixture.runtimePgDatabase!,
          github: github.client,
          secretsKey,
          broker,
        },
        discoveryId,
        new AbortController().signal,
      ),
    finish: async () => {
      try {
        await clearGitHubAppRegistrations(fixture);
      } finally {
        try {
          await fixture.finish();
        } finally {
          await Deno.remove(directory, { recursive: true });
        }
      }
    },
  };
}

export type GitHubAppFixture = Awaited<ReturnType<typeof openGitHubAppFixture>>;

export function begin(
  fixture: InstallationFixture,
  cookie = fixture.adminCookie,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return call(fixture, "POST", beginPath, cookie, { body });
}

/** Begins as the cookie's session and returns the parsed manifest start. */
export async function started(
  fixture: InstallationFixture,
  cookie = fixture.adminCookie,
  body: Record<string, unknown> = {},
): Promise<ManifestStart> {
  const response = await begin(fixture, cookie, body);
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json() as ManifestStart;
}

export function callback(
  fixture: InstallationFixture,
  query: Record<string, string>,
  cookie = fixture.adminCookie,
): Promise<Response> {
  return call(
    fixture,
    "GET",
    `${callbackPath}?${new URLSearchParams(query)}`,
    cookie,
  );
}

/** Body integrationAppRegistrations.put takes for one fake existing App. */
export function existingAppBody(
  app: FakeExistingApp,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    appId: app.id,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    privateKey: app.pkcs1Pem,
    ...(app.webhookSecret === null ? {} : { webhookSecret: app.webhookSecret }),
    ...overrides,
  };
}

/** PUT with a fresh Idempotency-Key unless given; If-Match only when a version is. */
export function put(
  fixture: InstallationFixture,
  body: Record<string, unknown>,
  options: { version?: number; key?: string; cookie?: string } = {},
): Promise<Response> {
  return call(
    fixture,
    "PUT",
    registrationPath,
    options.cookie ?? fixture.adminCookie,
    {
      body,
      headers: {
        "Idempotency-Key": options.key ?? crypto.randomUUID(),
        ...(options.version === undefined
          ? {}
          : { "If-Match": `"v${options.version}"` }),
      },
    },
  );
}

export async function readRegistration(
  fixture: InstallationFixture,
  cookie = fixture.adminCookie,
): Promise<Record<string, unknown>> {
  const response = await call(fixture, "GET", registrationPath, cookie);
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}

export async function count(
  fixture: InstallationFixture,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ count: string }>(
    sql,
    values,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Row counts that a refused request must leave unchanged. */
export async function registrationFacts(fixture: InstallationFixture) {
  return {
    attempts: await count(
      fixture,
      "select count(*) from bakery.integration_app_registration_attempts",
    ),
    consumed: await count(
      fixture,
      "select count(*) from bakery.integration_app_registration_attempts where consumed_at is not null",
    ),
    registrations: await count(
      fixture,
      "select count(*) from bakery.integration_app_registrations",
    ),
    installationSecrets: await count(
      fixture,
      "select count(*) from bakery.secrets where organization_id is null and provider = 'github'",
    ),
    installationSecretVersions: await count(
      fixture,
      "select count(*) from bakery.secret_versions v join bakery.secrets s on s.id = v.secret_id where s.organization_id is null and s.provider = 'github'",
    ),
  };
}

export const authAttemptsPath = "/v1/integration-auth-attempts";

/**
 * Registers a fake GitHub App through the manifest flow; returns its
 * identity. Its private key is real so App JWTs verify.
 */
export async function registerApp(fixture: GitHubAppFixture) {
  const start = await started(fixture);
  const { code, app } = fixture.github.issueCode({ pem: fakeAppKey.pem });
  const response = await callback(fixture, { code, state: start.state });
  assertEquals(response.status, 303, await response.clone().text());
  assertEquals(
    response.headers.get("location"),
    settingsLocation("registered"),
  );
  return app;
}

/** POSTs integrationAuthAttempts.create in the fixture organization. */
export function createAttempt(
  fixture: InstallationFixture,
  options: {
    cookie?: string;
    body?: Record<string, unknown>;
    key?: string | null;
    organizationId?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  return call(
    fixture,
    "POST",
    authAttemptsPath,
    options.cookie ?? fixture.adminCookie,
    {
      body: options.body ?? { provider: "github" },
      headers: {
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        ...(key === null ? {} : { "Idempotency-Key": key }),
        ...options.headers,
      },
    },
  );
}

export type AttemptCreated = {
  id: string;
  authorizationUrl: string;
  installationUrl: string;
  expiresAt: string;
};

/** Creates an attempt as the Admin and returns the parsed 201 body. */
export async function createdAttempt(
  fixture: InstallationFixture,
  options: Parameters<typeof createAttempt>[1] = {},
): Promise<AttemptCreated> {
  const response = await createAttempt(fixture, options);
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json() as AttemptCreated;
}

/** GETs integrationAuthAttempts.get in the fixture organization. */
export function readAttempt(
  fixture: InstallationFixture,
  id: string,
  cookie = fixture.adminCookie,
  organizationId = fixture.organizationId,
): Promise<Response> {
  return call(fixture, "GET", `${authAttemptsPath}/${id}`, cookie, {
    headers: { "Bakery-Organization-Id": organizationId },
  });
}

export type AttemptRow = {
  id: string;
  organization_id: string;
  initiating_principal_id: string;
  session_id: string;
  provider: string;
  return_path: string | null;
  reconnect_connection_id: string | null;
  state_hash: string;
  pkce_verifier_ciphertext: Uint8Array;
  pkce_verifier_nonce: Uint8Array;
  pkce_key_id: string;
  idempotency_key_hash: string;
  request_digest: string;
  status: string;
  version: number;
  expires_at: Date;
};

export async function attemptRows(
  fixture: InstallationFixture,
): Promise<AttemptRow[]> {
  const result = await fixture.pgDatabase.query<AttemptRow>(
    `select * from bakery.integration_auth_attempts
      where organization_id = $1 order by created_at`,
    [fixture.organizationId],
  );
  return result.rows;
}

export const setupPath = "/v1/integration-auth/github/setup";
export const oauthCallbackPath = "/v1/integration-auth/github/callback";
export const connectionsPath = "/v1/integration-connections";
export const connectionSetupPath = "/settings/organization/integrations";

/** Expected 303 target for a GitHub connection callback outcome. */
export function connectionLocation(
  outcome: string,
  connectionId?: string,
  path = connectionSetupPath,
): string {
  const query = new URLSearchParams({ githubConnection: outcome });
  if (connectionId !== undefined) query.set("connectionId", connectionId);
  return `${path}?${query}`;
}

/** The state an attempt's authorization URL carries. */
export function attemptState(created: AttemptCreated): string {
  return new URL(created.authorizationUrl).searchParams.get("state")!;
}

/** GitHub's setup redirect, with GitHub's own snake_case parameter names. */
export function githubSetup(
  fixture: InstallationFixture,
  query: Record<string, string>,
  cookie = fixture.adminCookie,
): Promise<Response> {
  return call(
    fixture,
    "GET",
    `${setupPath}?${new URLSearchParams(query)}`,
    cookie,
  );
}

/** GitHub's OAuth redirect to the fixed callback. */
export function githubCallback(
  fixture: InstallationFixture,
  query: Record<string, string>,
  cookie = fixture.adminCookie,
): Promise<Response> {
  return call(
    fixture,
    "GET",
    `${oauthCallbackPath}?${new URLSearchParams(query)}`,
    cookie,
  );
}

/**
 * A registered App, an Admin attempt and a GitHub user who approved it and
 * can access `installations` of the App (one by default), each holding the
 * repositories `repositories(index)` returns (none by default). Returns what
 * the setup and OAuth redirects will carry.
 */
export async function connectionFlow(
  fixture: GitHubAppFixture,
  options: {
    installations?: number;
    /** Installations the user can access instead of new ones. */
    existing?: FakeInstallation[];
    attempt?: Parameters<typeof createAttempt>[1];
    app?: Awaited<ReturnType<typeof registerApp>>;
    repositories?: (index: number) => FakeRepository[];
  } = {},
) {
  const app = options.app ?? await registerApp(fixture);
  const installations = options.existing ?? Array.from(
    { length: options.installations ?? 1 },
    (_, index) =>
      fixture.github.addInstallation(app, {
        repositories: options.repositories?.(index) ?? [],
      }),
  );
  const created = await createdAttempt(fixture, options.attempt);
  const state = attemptState(created);
  const code = fixture.github.authorize({
    authorizationUrl: created.authorizationUrl,
    installationIds: installations.map((installation) => installation.id),
  });
  fixture.github.calls.length = 0;
  return { app, installations, created, state, code };
}

export async function connectionRows(fixture: InstallationFixture) {
  const result = await fixture.pgDatabase.query<{
    id: string;
    organization_id: string;
    provider: string;
    installation_id: string;
    external_authorization_id: string;
    external_account_id: string;
    label: string;
    status: string;
    health: string;
    created_by: string;
    version: number;
  }>(
    `select * from bakery.integration_connections
      where organization_id = $1 order by created_at`,
    [fixture.organizationId],
  );
  return result.rows;
}

export async function installationRows(fixture: InstallationFixture) {
  const result = await fixture.pgDatabase.query<{
    id: string;
    external_authorization_id: string;
    external_account_id: string;
    account_login: string;
    status: string;
  }>(
    `select installation.* from bakery.integration_installations installation
      join bakery.integration_app_registrations registration
        on registration.id = installation.registration_id
      order by installation.created_at`,
  );
  return result.rows;
}

export type ResourceRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  installation_id: string;
  kind: string;
  external_id: string;
  display_name: string;
  safe_url: string | null;
  selected: boolean;
  available: boolean;
  enabled: boolean;
  capability_snapshot: Record<string, unknown>;
  last_discovery_generation: number;
  archived_at: Date | null;
  version: number;
};

/** Every resource row of one connection, by provider id. */
export async function resourceRows(
  fixture: InstallationFixture,
  connectionId: string,
): Promise<ResourceRow[]> {
  const result = await fixture.pgDatabase.query<ResourceRow>(
    `select * from bakery.integration_resources
      where connection_id = $1 order by external_id::bigint`,
    [connectionId],
  );
  return result.rows;
}

/** GETs integrationConnections.get in an organization. */
export function readConnection(
  fixture: InstallationFixture,
  id: string,
  cookie = fixture.adminCookie,
  organizationId = fixture.organizationId,
): Promise<Response> {
  return call(fixture, "GET", `${connectionsPath}/${id}`, cookie, {
    headers: { "Bakery-Organization-Id": organizationId },
  });
}

/**
 * Every row a refused callback must leave untouched: attempts, connections,
 * installations, resources, and the audit and domain events of the organization.
 */
export async function connectionSnapshot(fixture: InstallationFixture) {
  const result = await fixture.pgDatabase.query<{ snapshot: string }>(
    `select concat_ws('|',
       (select coalesce(string_agg(t::text, ',' order by t.id), '')
          from bakery.integration_auth_attempts t),
       (select coalesce(string_agg(c::text, ',' order by c.id), '')
          from bakery.integration_connections c),
       (select coalesce(string_agg(i::text, ',' order by i.id), '')
          from bakery.integration_installations i),
       (select coalesce(string_agg(r::text, ',' order by r.id), '')
          from bakery.integration_resources r),
       (select count(*)::text from bakery.audit_events
          where organization_id = $1),
       (select count(*)::text from bakery.domain_events
          where organization_id = $1)) as snapshot`,
    [fixture.organizationId],
  );
  return result.rows[0].snapshot;
}

/** POSTs integrationConnections.create in the fixture organization. */
export function postConnection(
  fixture: InstallationFixture,
  body: Record<string, unknown>,
  options: { cookie?: string; key?: string | null } = {},
): Promise<Response> {
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  return call(
    fixture,
    "POST",
    connectionsPath,
    options.cookie ?? fixture.adminCookie,
    {
      body,
      headers: {
        "Bakery-Organization-Id": fixture.organizationId,
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
    },
  );
}

/**
 * Completes setup then the OAuth callback of a connection flow for its first
 * installation; returns the redirect outcome and connection id.
 */
export async function completeFlow(
  fixture: GitHubAppFixture,
  flow: Awaited<ReturnType<typeof connectionFlow>>,
): Promise<{ outcome: string | null; connectionId: string | null }> {
  const setup = await githubSetup(fixture, {
    installation_id: String(flow.installations[0].id),
    setup_action: "install",
    state: flow.state,
  });
  await setup.body?.cancel();
  const response = await githubCallback(fixture, {
    code: flow.code,
    state: flow.state,
  });
  assertEquals(response.status, 303, await response.clone().text());
  const location = new URL(
    response.headers.get("location")!,
    "https://x.invalid",
  );
  return {
    outcome: location.searchParams.get("githubConnection"),
    connectionId: location.searchParams.get("connectionId"),
  };
}

/** One connection row as text, to prove a write left it byte-identical. */
export async function connectionText(
  fixture: InstallationFixture,
  id: string,
): Promise<string> {
  const result = await fixture.pgDatabase.query<{ row: string }>(
    "select c::text as row from bakery.integration_connections c where id = $1",
    [id],
  );
  return result.rows[0].row;
}

/**
 * A pending connection bound through setup then OAuth callback, holding the
 * administered repositories of `repositories` (three administered ones by
 * default) as available, unselected resources.
 */
export async function pendingConnection(
  fixture: GitHubAppFixture,
  options: {
    repositories?: FakeRepository[];
    app?: Awaited<ReturnType<typeof registerApp>>;
    attempt?: Parameters<typeof createAttempt>[1];
    /** An installation another organization already connected. */
    existing?: FakeInstallation;
  } = {},
) {
  const repositories = options.repositories ??
    fakeRepositories(3, ["admin"]);
  const flow = await connectionFlow(fixture, {
    repositories: () => repositories,
    app: options.app,
    attempt: options.attempt,
    existing: options.existing && [options.existing],
  });
  const installation = flow.installations[0];
  const setup = await githubSetup(fixture, {
    installation_id: String(installation.id),
    setup_action: "install",
    state: flow.state,
  });
  await setup.body?.cancel();
  const bound = await githubCallback(fixture, {
    code: flow.code,
    state: flow.state,
  });
  assertEquals(bound.status, 303, await bound.clone().text());
  const connectionId = new URL(bound.headers.get("location")!, "http://x")
    .searchParams.get("connectionId");
  assertEquals(typeof connectionId, "string", "a pending connection bound");
  const resources = await resourceRows(fixture, connectionId!);
  fixture.github.calls.length = 0;
  return { ...flow, installation, connectionId: connectionId!, resources };
}

/** A second organization the fixture Admin creates and administers. */
export async function secondOrganization(
  fixture: InstallationFixture,
): Promise<string> {
  const response = await call(
    fixture,
    "POST",
    "/v1/organizations",
    fixture.adminCookie,
    {
      body: {
        name: "Second",
        slug: `second-${crypto.randomUUID().slice(0, 8)}`,
      },
      headers: {
        "Bakery-Organization-Id": fixture.organizationId,
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );
  assertEquals(response.status, 201, await response.clone().text());
  return (await response.json()).id as string;
}

/** The strong ETag naming a connection version, as If-Match carries it. */
export const versionTag = (version: number) => `"${version}"`;

/** The stored connection version, read directly. */
export async function connectionVersion(
  fixture: InstallationFixture,
  connectionId: string,
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ version: number }>(
    "select version from bakery.integration_connections where id = $1",
    [connectionId],
  );
  return result.rows[0].version;
}

/**
 * PATCHes integrationConnections.update. `ifMatch` defaults to the stored
 * version; null omits the header, as does a null `key` for Idempotency-Key.
 */
export async function patchConnection(
  fixture: InstallationFixture,
  connectionId: string,
  body: Record<string, unknown>,
  options: {
    cookie?: string;
    ifMatch?: string | null;
    key?: string | null;
    organizationId?: string;
  } = {},
): Promise<Response> {
  const ifMatch = options.ifMatch === undefined
    ? versionTag(await connectionVersion(fixture, connectionId))
    : options.ifMatch;
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  return await call(
    fixture,
    "PATCH",
    `${connectionsPath}/${connectionId}`,
    options.cookie ?? fixture.adminCookie,
    {
      body,
      headers: {
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        ...(ifMatch === null ? {} : { "If-Match": ifMatch }),
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
    },
  );
}

/**
 * POSTs integrationConnections.remove (#68), with patchConnection's header
 * defaults: If-Match is the stored version unless given, null omits it.
 */
export async function removeConnection(
  fixture: InstallationFixture,
  connectionId: string,
  options: { cookie?: string; ifMatch?: string | null } = {},
): Promise<Response> {
  const ifMatch = options.ifMatch === undefined
    ? versionTag(await connectionVersion(fixture, connectionId))
    : options.ifMatch;
  return await call(
    fixture,
    "POST",
    `${connectionsPath}/${connectionId}/removal`,
    options.cookie ?? fixture.adminCookie,
    {
      body: {},
      headers: {
        "Bakery-Organization-Id": fixture.organizationId,
        ...(ifMatch === null ? {} : { "If-Match": ifMatch }),
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );
}

/** PATCHes integrationResources.update, with the same header defaults. */
export async function patchResource(
  fixture: InstallationFixture,
  connectionId: string,
  resourceId: string,
  body: Record<string, unknown>,
  options: Parameters<typeof patchConnection>[3] = {},
): Promise<Response> {
  const ifMatch = options.ifMatch === undefined
    ? versionTag(await connectionVersion(fixture, connectionId))
    : options.ifMatch;
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  return await call(
    fixture,
    "PATCH",
    `${connectionsPath}/${connectionId}/resources/${resourceId}`,
    options.cookie ?? fixture.adminCookie,
    {
      body,
      headers: {
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        ...(ifMatch === null ? {} : { "If-Match": ifMatch }),
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
    },
  );
}

/**
 * An enabled connection: bound like `pendingConnection`, the first
 * `selected` (default one) of its repositories selected through the live
 * recheck, then enabled. The fake GitHub call log is cleared afterwards.
 */
export async function enabledConnection(
  fixture: GitHubAppFixture,
  options: Parameters<typeof pendingConnection>[1] & { selected?: number } = {},
) {
  const pending = await pendingConnection(fixture, options);
  const selected = pending.resources.slice(0, options.selected ?? 1);
  for (const resource of selected) {
    const response = await patchResource(
      fixture,
      pending.connectionId,
      resource.id,
      { selected: true },
    );
    assertEquals(response.status, 200, await response.text());
  }
  const enabled = await patchConnection(fixture, pending.connectionId, {
    enabled: true,
  });
  assertEquals(enabled.status, 200, await enabled.text());
  fixture.github.calls.length = 0;
  fixture.github.tokenRequests.length = 0;
  fixture.github.tokenJwts.length = 0;
  return { ...pending, selected };
}

/**
 * POSTs integrationConnections.check. A null `key` omits Idempotency-Key.
 */
export async function postCheck(
  fixture: InstallationFixture,
  connectionId: string,
  options: { cookie?: string; key?: string | null; organizationId?: string } =
    {},
): Promise<Response> {
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  return await call(
    fixture,
    "POST",
    `${connectionsPath}/${connectionId}/checks`,
    options.cookie ?? fixture.adminCookie,
    {
      body: {},
      headers: {
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
    },
  );
}

/**
 * POSTs integrationDiscoveries.create. A null `key` omits Idempotency-Key.
 */
export async function postDiscovery(
  fixture: InstallationFixture,
  connectionId: string,
  options: { cookie?: string; key?: string | null; organizationId?: string } =
    {},
): Promise<Response> {
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  return await call(
    fixture,
    "POST",
    `${connectionsPath}/${connectionId}/discoveries`,
    options.cookie ?? fixture.adminCookie,
    {
      body: {},
      headers: {
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
    },
  );
}

export const installationsPath = "/v1/integration-installations";

/** GETs integrationInstallations.list or .get (with `id`) as `cookie`. */
export function readInstallations(
  fixture: InstallationFixture,
  options: { id?: string; query?: string; cookie?: string } = {},
): Promise<Response> {
  const path = options.id === undefined
    ? `${installationsPath}${options.query ?? ""}`
    : `${installationsPath}/${options.id}`;
  return call(fixture, "GET", path, options.cookie ?? fixture.adminCookie);
}
