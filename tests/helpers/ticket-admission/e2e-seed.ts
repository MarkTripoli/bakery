/**
 * Seeds and HTTP helpers for the issue 82 real-stack lane. This is not a test
 * module: it only exports. The stack holds no GitHub App credentials and the
 * server's GitHub origin is a constant, so every row the ticket operations
 * need is written here as the database owner, and calls go through the
 * shipped server process over HTTP with a real session.
 */
import { createSuperuser } from "../../../apps/server/src/modules/auth/index.ts";
import {
  encryptInstallationSecret,
  loadSecretKey,
} from "../../../apps/server/src/modules/secrets/crypto.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../../packages/config/src/env.ts";
import { FIXED_CODING_PRESET } from "../../../packages/contracts/src/workflow-presets.ts";
import { authRequest, sessionCookie, signSessionCookie } from "../auth.ts";
import {
  type PresetRepository,
  seedPresetRepository,
} from "../fixed-coding-preset.ts";
import type { Stack } from "../../e2e/helpers/stack.ts";

/** A signed-in person: their principal, the organization they act in and the session cookie. */
export type Session = {
  principalId: string;
  organizationId: string;
  cookie: string;
};

/** Every row a ticket source needs to be judged live, and the ids the cases name. */
export type Authority = {
  organizationId: string;
  principalId: string;
  connectionId: string;
  resourceId: string;
  /** GitHub's numeric installation id, as webhook payloads carry it. */
  installationExternalId: string;
  /** GitHub's numeric repository id, which the resource row and the source name. */
  repositoryExternalId: string;
  repositoryFullName: string;
  /** The webhook secret row the registration points at; it holds no version until sealed. */
  webhookSecretId: string;
  repository: PresetRepository;
};

/** The only test key the lane mounts; the fixture is 32 raw bytes under the compose mount. */
export const KEY_FILE_IN_CONTAINER =
  "/workspace/tests/fixtures/secret-identity-key.bin";
export const KEY_FILE_ON_HOST = "tests/fixtures/secret-identity-key.bin";
export const KEY_ID = "ticket-e2e-key-v1";

/** Digest every seeded ticket carries; the cases pass it back as the caller's observed digest. */
export const REQUIREMENTS_DIGEST = "a".repeat(64);

const DEFAULT_PRESET_PIN = JSON.stringify({
  id: "fixed-coding",
  revision: FIXED_CODING_PRESET.revision,
  digest: FIXED_CODING_PRESET.digest,
});

export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** A Better Auth superuser, signed in over HTTP; the organization is the one `createSuperuser` made. */
export async function signedInAdmin(stack: Stack): Promise<Session> {
  const email = `e2e-tickets-${crypto.randomUUID()}@example.test`;
  const password = `Tickets-${crypto.randomUUID()}`;
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: stack.ownerDatabaseUrl,
      BAKERY_PUBLIC_BASE_URL: stack.origin,
      BETTER_AUTH_SECRET: stack.authSecret,
    }).auth!;
    await createSuperuser({ pgDatabase: database, config }, {
      email,
      displayName: "Ticket real-stack proof",
      password,
    });
  } finally {
    await closePgDatabase(database);
  }
  const signIn = await stack.fetch(
    authRequest("/api/auth/sign-in/email", { email, password }),
  );
  if (signIn.status !== 200) {
    throw new Error(`E2E_SIGN_IN_FAILED:${signIn.status}`);
  }
  const scopes = await stack.psql<
    { principalId: string; organizationId: string }
  >(
    `select principal.id as "principalId",
            membership.organization_id as "organizationId"
       from bakery.principals principal
       join public."user" provider_user
         on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships membership
         on membership.principal_id = principal.id
      where provider_user.email = $1 and membership.role = 'admin'
        and membership.status = 'active'`,
    [email],
  );
  if (scopes.length !== 1) throw new Error("E2E_ADMIN_SCOPE_REQUIRED");
  return { ...scopes[0], cookie: sessionCookie(signIn) };
}

/**
 * A second Better Auth user with an active Viewer membership in the admin's
 * organization and a live session. `createSuperuser` makes superusers only, so
 * the user, principal, membership and session rows are written directly.
 */
export async function addViewer(
  stack: Stack,
  admin: Session,
): Promise<Session> {
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `viewer-${crypto.randomUUID()}`;
  const now = new Date();
  await stack.psql(
    `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, 'ticket-viewer', $2, true, $3, $3)`,
    [userId, `viewer-${userId}@example.test`, now],
  );
  await stack.psql(
    `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
     values ($1, $2, 'ticket-viewer', 'human')`,
    [principalId, userId],
  );
  await stack.psql(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
     ) values ($1, $2, $3, 'viewer', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), admin.organizationId, principalId, now],
  );
  await stack.psql(
    `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
     values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      token,
      userId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  return {
    principalId,
    organizationId: admin.organizationId,
    cookie: await signSessionCookie(token, stack.authSecret),
  };
}

/** One request through the shipped server as `session`, with the headers a browser client sends. */
export function stackCall(
  stack: Stack,
  session: Pick<Session, "cookie" | "organizationId">,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({
    cookie: session.cookie,
    "Bakery-Organization-Id": session.organizationId,
  });
  if (method !== "GET") {
    headers.set("origin", stack.origin);
    headers.set("content-type", "application/json");
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  return stack.fetch(
    new Request(`${stack.origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/**
 * Registration, secrets, installation, connection and selected resource, all
 * live, plus an application, repository and profile bound to the resource.
 * The registration needs its three secret rows (client secret, private key,
 * webhook secret) and the secrets carry no version, so the stack holds no
 * usable App credentials: `readAppCredentials` joins through the active
 * version and answers null. The webhook secret is sealed later by
 * `sealWebhookSecret` when a case needs it.
 */
export async function seedAuthority(
  stack: Stack,
  owner: PgDatabase,
  session: Session,
): Promise<Authority> {
  const clientSecretId = crypto.randomUUID();
  const privateKeySecretId = crypto.randomUUID();
  const webhookSecretId = crypto.randomUUID();
  const registrationId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const installationExternalId = "98765432";
  const accountId = "4242";
  const repositoryExternalId = "123456789";
  const repositoryFullName = "bakery-e2e/tickets";
  for (
    const [id, name] of [
      [clientSecretId, "GitHub App client secret"],
      [privateKeySecretId, "GitHub App private key"],
      [webhookSecretId, "GitHub App webhook secret"],
    ]
  ) {
    await stack.psql(
      `insert into bakery.secrets (id, name, provider, allowed_principals, allowed_actions)
       values ($1, $2, 'github', '[]'::jsonb, '[]'::jsonb)`,
      [id, name],
    );
  }
  await stack.psql(
    `insert into bakery.integration_app_registrations (
       id, provider, external_app_id, slug, name, client_id, owner_login,
       owner_id, owner_type, html_url, permissions, events, client_secret_id,
       private_key_secret_id, webhook_secret_id, status, registered_by
     ) values ($1, 'github', 1, 'bakery-ticket-e2e', 'Bakery ticket e2e',
       'Iv1.tickete2e', 'bakery-e2e', 1, 'Organization',
       'https://github.com/apps/bakery-ticket-e2e', '{}'::jsonb,
       '["issues"]'::jsonb, $2, $3, $4, 'registered', $5)`,
    [
      registrationId,
      clientSecretId,
      privateKeySecretId,
      webhookSecretId,
      session.principalId,
    ],
  );
  await stack.psql(
    `insert into bakery.integration_installations (
       id, provider, registration_id, external_authorization_id,
       external_account_id, account_login, account_type, repository_selection,
       granted_permissions, status
     ) values ($1, 'github', $2, $3, $4, 'bakery-e2e', 'Organization',
       'selected', '{"issues":"read"}'::jsonb, 'enabled')`,
    [installationId, registrationId, installationExternalId, accountId],
  );
  await stack.psql(
    `insert into bakery.integration_connections (
       id, organization_id, provider, installation_id,
       external_authorization_id, external_account_id, label, adapter_version,
       granted_permissions, status, health, created_by
     ) values ($1, $2, 'github', $3, $4, $5, 'bakery-e2e', 'github@ticket-e2e',
       '{"issues":"read"}'::jsonb, 'enabled', 'healthy', $6)`,
    [
      connectionId,
      session.organizationId,
      installationId,
      installationExternalId,
      accountId,
      session.principalId,
    ],
  );
  await stack.psql(
    `insert into bakery.integration_resources (
       id, organization_id, connection_id, installation_id, kind, external_id,
       display_name, selected, enabled, last_discovery_generation
     ) values ($1, $2, $3, $4, 'repository', $5, $6, true, true, 1)`,
    [
      resourceId,
      session.organizationId,
      connectionId,
      installationId,
      repositoryExternalId,
      repositoryFullName,
    ],
  );
  const repository = await seedPresetRepository(owner, {
    organizationId: session.organizationId,
    principalId: session.principalId,
    adminCookie: session.cookie,
  });
  // `ticketSources.create` accepts the repository its resource maps to: the
  // same connection and the provider's repository id.
  await stack.psql(
    `update bakery.repositories
        set integration_connection_id = $3, provider_repo_id = $4
      where organization_id = $1 and id = $2`,
    [
      session.organizationId,
      repository.repositoryId,
      connectionId,
      repositoryExternalId,
    ],
  );
  return {
    organizationId: session.organizationId,
    principalId: session.principalId,
    connectionId,
    resourceId,
    installationExternalId,
    repositoryExternalId,
    repositoryFullName,
    webhookSecretId,
    repository,
  };
}

/** The body `ticketSources.create` takes for the seeded repository. */
export function sourceBody(
  authority: Authority,
  policy: unknown,
): Record<string, unknown> {
  return {
    connectionId: authority.connectionId,
    resourceId: authority.resourceId,
    applicationId: authority.repository.applicationId,
    repositoryId: authority.repository.repositoryId,
    externalContainerId: authority.repositoryExternalId,
    policy,
  };
}

/** A recorded ticket of `sourceId` with a valid bounded snapshot, as a sync would leave it. */
export async function seedTicket(
  stack: Stack,
  authority: Authority,
  sourceId: string,
  number: number,
): Promise<string> {
  const id = crypto.randomUUID();
  const snapshot = {
    title: "Retry uploads",
    body: "Make the upload retry.",
    bodyTruncated: false,
    labels: [],
    state: "open",
    stateReason: null,
    locked: false,
    repositoryFullName: authority.repositoryFullName,
    links: { parent: null, subIssuesTotal: 0, blockedBy: [], blockingTotal: 0 },
  };
  await stack.psql(
    `insert into bakery.external_tickets (
       id, organization_id, ticket_source_id, external_ticket_id, key, number,
       safe_url, snapshot, requirements_digest, provider_update_marker,
       visibility, state, last_observed_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'private',
       'open', now())`,
    [
      id,
      authority.organizationId,
      sourceId,
      String(9000 + number),
      `${authority.repositoryFullName}#${number}`,
      String(number),
      `https://github.com/${authority.repositoryFullName}/issues/${number}`,
      JSON.stringify(snapshot),
      REQUIREMENTS_DIGEST,
      "2026-11-01T00:00:00.000Z",
    ],
  );
  return id;
}

/** A draft task of the seeded repository, created through the API so its profile pin is real. */
export async function createTask(
  stack: Stack,
  session: Session,
  authority: Authority,
): Promise<string> {
  const response = await stackCall(stack, session, "POST", "/v1/tasks", {
    applicationId: authority.repository.applicationId,
    repositoryId: authority.repository.repositoryId,
    repositoryProfileId: authority.repository.profileId,
    taskType: "feature",
    title: "Add upload retry",
    description: "Retry failed uploads twice.",
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`E2E_TASK_CREATE_FAILED:${response.status}:${text}`);
  }
  return (JSON.parse(text) as { id: string }).id;
}

/** A primary link of `ticketId` to `taskId`; returns the link id. */
export async function seedPrimaryLink(
  stack: Stack,
  authority: Authority,
  ticketId: string,
  taskId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await stack.psql(
    `insert into bakery.ticket_task_links (
       id, organization_id, external_ticket_id, task_id, role
     ) values ($1, $2, $3, $4, 'primary')`,
    [id, authority.organizationId, ticketId, taskId],
  );
  return id;
}

/** A request of a ticket in the given disposition, written the way the store would; rejects when the database refuses it. */
export async function seedRequest(
  stack: Stack,
  authority: Authority,
  request: {
    ticketId: string;
    linkId: string;
    generation: number;
    disposition: string;
    reason?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await stack.psql(
    `insert into bakery.ticket_requests (
       id, organization_id, ticket_task_link_id, external_ticket_id, intent,
       generation, origin, authority_principal_id, authority_evidence,
       source_policy_revision, requirements_digest, pinned_preset, disposition,
       disposition_reason
     ) values ($1, $2, $3, $4, 'start', $5, 'poll', $6, '{}'::jsonb, 1, $7,
       $8::jsonb, $9, $10)`,
    [
      id,
      authority.organizationId,
      request.linkId,
      request.ticketId,
      request.generation,
      authority.principalId,
      REQUIREMENTS_DIGEST,
      DEFAULT_PRESET_PIN,
      request.disposition,
      request.reason ?? null,
    ],
  );
  return id;
}

/** What admission would have written for the organization: nothing else may change these. */
export type WriteCounts = {
  tasks: number;
  conversations: number;
  links: number;
  requests: number;
  reports: number;
  runs: number;
};

export async function writeCounts(
  stack: Stack,
  organizationId: string,
): Promise<WriteCounts> {
  const rows = await stack.psql<WriteCounts>(
    `select
       (select count(*) from bakery.tasks where organization_id = $1)::int as tasks,
       (select count(*) from bakery.conversations where organization_id = $1)::int as conversations,
       (select count(*) from bakery.ticket_task_links where organization_id = $1)::int as links,
       (select count(*) from bakery.ticket_requests where organization_id = $1)::int as requests,
       (select count(*) from bakery.ticket_readiness_reports where organization_id = $1)::int as reports,
       (select count(*) from bakery.workflow_runs where organization_id = $1)::int as runs`,
    [organizationId],
  );
  return rows[0];
}

/**
 * Stores `secret` as the active version of the registration's webhook secret,
 * encrypted with the fixture key under the binding `readWebhookSecret` opens:
 * the secret id, the revision and the key id. The server must mount the same
 * key to open it.
 */
export async function sealWebhookSecret(
  stack: Stack,
  authority: Authority,
  secret: string,
): Promise<void> {
  const key = await loadSecretKey({
    file: await Deno.realPath(KEY_FILE_ON_HOST),
    keyId: KEY_ID,
  });
  const cipher = await encryptInstallationSecret(
    key,
    { secretId: authority.webhookSecretId, revision: 1, keyId: KEY_ID },
    secret,
  );
  const versionId = crypto.randomUUID();
  await stack.psql(
    `insert into bakery.secret_versions (
       id, organization_id, application_id, secret_id, revision, ciphertext,
       nonce, key_id, created_by
     ) values ($1, null, null, $2, 1, $3, $4, $5, $6)`,
    [
      versionId,
      authority.webhookSecretId,
      cipher.ciphertext,
      cipher.nonce,
      KEY_ID,
      authority.principalId,
    ],
  );
  await stack.psql(
    `update bakery.secrets set active_version_id = $2
      where id = $1 and organization_id is null and application_id is null`,
    [authority.webhookSecretId, versionId],
  );
}
