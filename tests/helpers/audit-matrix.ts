import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { startTxtDns } from "./dns-txt.ts";
import { selfSignedCertificate } from "./self-signed-certificate.ts";
import {
  AUDIT_MATRIX_ACTIONS,
  AUDIT_MATRIX_CREDENTIAL_OPERATIONS,
  AUDIT_MATRIX_PLUGIN_OPERATIONS,
} from "./audit-matrix-actions.ts";
import {
  call,
  grant,
  type InstallationFixture,
  readSettings,
  revoke,
  updateSettings,
} from "./installation-settings.ts";
import { orgHeader } from "./account-settings.ts";
import { authRequest, enrollTotp, sessionCookie } from "./auth.ts";
import { signInDesktop } from "./desktop-sign-in.ts";
import { connectClient, registerTestClient } from "./oauth-mcp.ts";
import { createFakeGitHubApp } from "./fake-github-app.ts";
import { seedRigIntegration } from "./external-effects.ts";
import { seedFundedModelJob } from "./funded-model-job.ts";
import { seedEligibleNonmodelJob } from "./worker-execution/nonmodel-job.ts";

/** An exact grant body for the audit matrix (#20). */
function integrationGrantBody(principalId: string) {
  return {
    subjectType: "principal",
    subjectPrincipalId: principalId,
    direction: "out_of_bakery",
    capability: "github.issue.comment.create",
  };
}

/** SCIM bearer secrets the matrix was issued; the no-secret test hunts for them. */
/** A saved email setup with no password, so the matrix needs no secrets key. */
function emailSettingsBody() {
  return {
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    username: "audit-matrix",
    fromAddress: "audit-matrix@example.com",
    fromName: "Bakery",
  };
}

export const matrixScimSecrets: string[] = [];

/** Access-token secrets the matrix minted; no audit row may echo them or their digests. */
export const MATRIX_TOKEN_SECRETS: string[] = [];

export type MatrixRow = {
  id: string;
  organizationId: string | null;
  principalId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  requestId: string;
  traceId: string;
  details: unknown;
};

const COLUMNS = `id, organization_id as "organizationId",
  principal_id as "principalId", operation, resource_type as "resourceType",
  resource_id as "resourceId", outcome, request_id as "requestId",
  trace_id as "traceId", details`;

type Outcome = {
  response: Response;
  organizationId: string | null;
  resourceId?: string;
  principalId?: string;
};

type MatrixCase = {
  operation: string;
  /** A request that must be refused or rejected and leave no audit row. */
  failure: () => Response | Promise<Response>;
  /** The mutation that must succeed and leave exactly one audit row. */
  success: () => Promise<Outcome>;
};

const key = () => crypto.randomUUID();

/**
 * Fake GitHub for the matrix fixture: integrationAppRegistrations.put stores
 * an existing App only after `GET /app` confirms it. No test reaches GitHub.
 */
const matrixGitHub = createFakeGitHubApp();

/**
 * A mounted AES key and the fake GitHub client for the matrix fixture:
 * integrationAppRegistrations.begin and .put refuse to store credentials when
 * no secrets key is configured.
 */
export async function matrixSecretsKey() {
  const directory = await Deno.makeTempDir({ prefix: "bakery-audit-" });
  const secretsKey = { file: `${directory}/key`, keyId: "audit-matrix-v1" };
  await Deno.writeFile(
    secretsKey.file,
    crypto.getRandomValues(new Uint8Array(32)),
    { mode: 0o600 },
  );
  return {
    secretsKey,
    githubAppClient: matrixGitHub.client,
    /** No audit case reaches a storage provider: the probe answers verified. */
    skillStorageProbe: () => Promise.resolve("verified" as const),
    /** Nor does one reach a backup bucket: the destination test answers verified. */
    backupDestinationProbe: () =>
      Promise.resolve({ outcome: "verified" as const, detail: null }),
    remove: () => Deno.remove(directory, { recursive: true }),
  };
}

/**
 * Runs every auth-mutation case against one installation fixture: a failure
 * request leaves no row for its operation, then a success request leaves
 * exactly one, attributed and scoped as declared. Returns every produced row.
 */
/** A telemetry destination that needs no secret, so no secrets key is involved. */
function telemetryDestinationBody() {
  return {
    kind: "otlp",
    name: `Audit matrix ${crypto.randomUUID()}`,
    measurements: ["results"],
    values: { address: "https://collector.example.test" },
  };
}

/** The body that binds the seeded agent version to the seeded tool (#436). */
function capabilityBindingBody(state: Record<string, string>) {
  return {
    agentVersionId: state.bindingAgentVersion,
    mcpConnectionId: state.bindingConnection,
    allowedOperations: ["create_note"],
    required: false,
  };
}

/**
 * What toolGatewayCalls.settle and capabilityBindings.create need (#436): an
 * enabled MCP connection, an agent version, and a write the gateway sent from a
 * live attempt whose outcome never came back, as the server records it.
 */
async function seedToolGatewayCall(f: InstallationFixture) {
  const db = f.pgDatabase;
  const org = f.organizationId;
  await seedFundedModelJob(db, org, f.adminId!);
  const agent = await db.query<{ id: string }>(
    `select id from bakery.agent_versions where organization_id = $1
      order by created_at desc limit 1`,
    [org],
  );
  const seed = await seedEligibleNonmodelJob(db, org, f.adminId!);
  const serverId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  await db.query(
    `insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, version)
     values ($1, $2, $3, 'Audit docs', 'streamable_http', '{}'::jsonb, 'https://mcp.example.com/mcp', '{}'::jsonb, '[]'::jsonb, 'rev', true, 1)`,
    [serverId, org, `audit-${serverId.slice(0, 8)}`],
  );
  await db.query(
    `insert into bakery.mcp_connections (id, organization_id, server_id, label, config, enabled_capabilities, status, version)
     values ($1, $2, $3, 'Audit docs', '{}'::jsonb, '["create_note"]'::jsonb, 'enabled', 1)`,
    [connectionId, org, serverId],
  );
  await db.query(
    `insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
     values ($1, $2, $3, now(), '2026-07-28', $4::jsonb, $5)`,
    [
      crypto.randomUUID(),
      org,
      connectionId,
      JSON.stringify({
        tools: [{
          name: "create_note",
          description: "create a note",
          inputSchema: { type: "object" },
        }],
      }),
      "c".repeat(64),
    ],
  );
  const ids = {
    workerPrincipalId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
  };
  await db.query(
    `insert into bakery.principals (id, display_name, principal_type)
     values ($1, 'Audit matrix worker', 'worker')`,
    [ids.workerPrincipalId],
  );
  await db.query(
    `insert into bakery.worker_hosts (id, organization_id, principal_id, principal_type, name,
       os, architecture, capabilities, slots, credential_hash, worker_session_id,
       worker_session_generation, adapter_capabilities)
     values ($1, $2, $3, 'worker', 'Audit matrix host', 'linux', 'x64', '[]', 1, $4, $5, 0, '[]'::jsonb)`,
    [
      ids.hostId,
      org,
      ids.workerPrincipalId,
      `audit-${ids.hostId}`,
      ids.sessionId,
    ],
  );
  await db.query(
    `update bakery.jobs set status = 'running', current_fence = 1
      where organization_id = $1 and id = $2`,
    [org, seed.jobId],
  );
  await db.query(
    `insert into bakery.job_attempts (id, organization_id, job_id, worker_host_id,
       worker_session_id, worker_session_generation, attempt_no, fence, lease_token_hash,
       lease_expires_at, status, started_at)
     values ($1, $2, $3, $4, $5, 0, 1, 1, $6, clock_timestamp() + interval '30 minutes', 'running', clock_timestamp())`,
    [
      ids.attemptId,
      org,
      seed.jobId,
      ids.hostId,
      ids.sessionId,
      `lease-${ids.attemptId}`,
    ],
  );
  const call = await db.query<{ id: string }>(
    `insert into bakery.tool_gateway_calls (organization_id, attempt_id, idempotency_key, mcp_connection_id, tool_name, snapshot_digest, arguments_digest, read_only, status)
     values ($1, $2, $3, $4, 'create_note', $5, $6, false, 'sent')
     returning id`,
    [
      org,
      ids.attemptId,
      crypto.randomUUID(),
      connectionId,
      "c".repeat(64),
      "a".repeat(64),
    ],
  );
  return {
    connectionId,
    agentVersionId: agent.rows[0]!.id,
    callId: call.rows[0]!.id,
  };
}

/** An alert channel pointed at a closed local port, so a test send reaches nothing. */
function alertChannelBody() {
  return {
    kind: "webhook",
    name: `Audit matrix ${crypto.randomUUID()}`,
    values: { address: "http://127.0.0.1:1" },
  };
}

export async function runAuditMatrix(
  f: InstallationFixture,
  matrixActions: readonly string[] = AUDIT_MATRIX_ACTIONS,
): Promise<MatrixRow[]> {
  const produced: MatrixRow[] = [];
  const org = orgHeader(f.organizationId);
  const developer = f.developerCookie;
  let telemetryDestination: { id: string; version: number } | undefined;
  let alertChannel: { id: string; version: number } | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const state: Record<string, string> = {};
  const rowsFor = async (operation: string) =>
    (await f.pgDatabase.query<MatrixRow>(
      `select ${COLUMNS} from bakery.audit_events where operation = $1
       order by created_at, id`,
      [operation],
    )).rows;
  const adminCall = (
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    call(f, method, path, f.adminCookie, {
      ...options,
      headers: { ...org, "Idempotency-Key": key(), ...options.headers },
    });
  const developerCall = (
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    call(f, method, path, developer, {
      ...options,
      headers: { ...org, "Idempotency-Key": key(), ...options.headers },
    });
  const json = async (response: Response) => {
    const text = await response.clone().text();
    assert(response.ok, `${response.status} ${text}`);
    return await response.json() as Record<string, unknown>;
  };
  const organizationPath = `/v1/organizations/${f.organizationId}`;

  async function invitedUser(email: string) {
    const created = await json(
      await adminCall("POST", `${organizationPath}/invitations`, {
        body: { email, role: "developer" },
      }),
    );
    const signUp = await f.app.fetch(authRequest("/api/auth/sign-up/email", {
      email,
      password: f.password,
      name: "Audit Invitee",
    }));
    assertEquals(signUp.status, 200, await signUp.clone().text());
    const signedIn = await f.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password: f.password }),
    );
    assertEquals(signedIn.status, 200);
    return {
      invitationId: String(created.id),
      cookie: sessionCookie(signedIn),
    };
  }

  const cases: MatrixCase[] = [
    // First: the OAuth consent needs the caller to have exactly one organization.
    {
      operation: "connectedClients.revoke",
      failure: () =>
        adminCall("DELETE", `/v1/me/connected-clients/${crypto.randomUUID()}`),
      success: async () => {
        const clientId = await registerTestClient(f, { name: "Audit matrix" });
        state.oauthClient = clientId;
        await connectClient(f, { cookie: f.adminCookie, clientId });
        const grants = await json(
          await adminCall("GET", "/v1/me/connected-clients"),
        );
        const grantId = (grants.items as { id: string; clientId: string }[])
          .find((item) => item.clientId === clientId)!.id;
        return {
          response: await adminCall(
            "DELETE",
            `/v1/me/connected-clients/${grantId}`,
          ),
          organizationId: f.organizationId,
          resourceId: grantId,
        };
      },
    },
    {
      operation: "organizations.create",
      failure: () =>
        developerCall("POST", "/v1/organizations", {
          body: { name: "Denied", slug: `denied-${suffix}` },
        }),
      success: async () => {
        const created = await json(
          await adminCall("POST", "/v1/organizations", {
            body: { name: "Matrix", slug: `matrix-${suffix}` },
          }),
        );
        state.createdOrganization = String(created.id);
        return {
          response: new Response(null, { status: 200 }),
          organizationId: String(created.id),
          resourceId: String(created.id),
        };
      },
    },
    {
      operation: "organizations.update",
      failure: () =>
        adminCall("PATCH", organizationPath, {
          body: { defaultLocale: "en" },
          headers: { "If-Match": '"v0"' },
        }),
      success: async () => {
        const current = await json(await adminCall("GET", organizationPath));
        const response = await adminCall("PATCH", organizationPath, {
          body: { defaultLocale: "en" },
          headers: { "If-Match": `"v${current.version}"` },
        });
        return {
          response,
          organizationId: f.organizationId,
          resourceId: f.organizationId,
        };
      },
    },
    {
      operation: "organizationMemberships.create",
      failure: () =>
        developerCall("POST", `${organizationPath}/memberships`, {
          body: { principalId: crypto.randomUUID(), role: null },
        }),
      success: async () => {
        const principal = await f.pgDatabase.query<{ id: string }>(
          `insert into bakery.principals (display_name, principal_type)
           values ('Audit Service', 'service') returning id`,
        );
        state.servicePrincipal = principal.rows[0].id;
        const response = await adminCall(
          "POST",
          `${organizationPath}/memberships`,
          { body: { principalId: state.servicePrincipal, role: null } },
        );
        const created = await json(response.clone());
        state.membership = String(created.id);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.membership,
        };
      },
    },
    {
      operation: "organizationMemberships.update",
      failure: () =>
        developerCall(
          "PATCH",
          `${organizationPath}/memberships/${state.membership}`,
          { body: { role: "developer" } },
        ),
      success: async () => ({
        response: await adminCall(
          "PATCH",
          `${organizationPath}/memberships/${state.membership}`,
          { body: { role: "developer" } },
        ),
        organizationId: f.organizationId,
        resourceId: state.membership,
      }),
    },
    {
      operation: "organizationMemberships.delete",
      failure: () =>
        developerCall(
          "DELETE",
          `${organizationPath}/memberships/${state.membership}`,
        ),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `${organizationPath}/memberships/${state.membership}`,
        ),
        organizationId: f.organizationId,
        resourceId: state.membership,
      }),
    },
    {
      operation: "organizationInvitations.create",
      failure: () =>
        developerCall("POST", `${organizationPath}/invitations`, {
          body: { email: `denied-${suffix}@example.test`, role: "developer" },
        }),
      success: async () => {
        const response = await adminCall(
          "POST",
          `${organizationPath}/invitations`,
          {
            body: {
              email: `matrix-create-${suffix}@example.test`,
              role: "developer",
            },
          },
        );
        state.invitation = String((await json(response.clone())).id);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.invitation,
        };
      },
    },
    {
      operation: "organizationInvitations.cancel",
      failure: () =>
        developerCall(
          "DELETE",
          `${organizationPath}/invitations/${state.invitation}`,
          { headers: { "If-Match": '"v1"' } },
        ),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `${organizationPath}/invitations/${state.invitation}`,
          { headers: { "If-Match": '"v1"' } },
        ),
        organizationId: f.organizationId,
        resourceId: state.invitation,
      }),
    },
    {
      operation: "organizationInvitations.recipientAccept",
      failure: async () => {
        const other = await invitedUser(`matrix-wrong-${suffix}@example.test`);
        state.wrongInvitation = other.invitationId;
        return await f.app.fetch(authRequest(
          "/api/auth/organization/accept-invitation",
          { invitationId: other.invitationId },
          { cookie: developer },
        ));
      },
      success: async () => {
        const invited = await invitedUser(
          `matrix-accept-${suffix}@example.test`,
        );
        const response = await f.app.fetch(authRequest(
          "/api/auth/organization/accept-invitation",
          { invitationId: invited.invitationId },
          { cookie: invited.cookie },
        ));
        return {
          response,
          organizationId: f.organizationId,
          resourceId: invited.invitationId,
        };
      },
    },
    {
      operation: "organizationInvitations.recipientReject",
      failure: () =>
        f.app.fetch(authRequest(
          "/api/auth/organization/reject-invitation",
          { invitationId: state.wrongInvitation },
          { cookie: developer },
        )),
      success: async () => {
        const invited = await invitedUser(
          `matrix-reject-${suffix}@example.test`,
        );
        const response = await f.app.fetch(authRequest(
          "/api/auth/organization/reject-invitation",
          { invitationId: invited.invitationId },
          { cookie: invited.cookie },
        ));
        return {
          response,
          organizationId: f.organizationId,
          resourceId: invited.invitationId,
        };
      },
    },
    {
      operation: "browserSessions.revoke",
      failure: () =>
        adminCall("DELETE", `/v1/me/sessions/${crypto.randomUUID()}`),
      success: async () => {
        const second = await f.app.fetch(
          authRequest("/api/auth/sign-in/email", {
            email: f.adminEmail,
            password: f.password,
          }),
        );
        assertEquals(second.status, 200);
        const sessions = await json(await adminCall("GET", "/v1/me/sessions"));
        const other = (sessions.items as { id: string; current: boolean }[])
          .find((item) => !item.current)!;
        return {
          response: await adminCall("DELETE", `/v1/me/sessions/${other.id}`),
          organizationId: null,
          resourceId: other.id,
        };
      },
    },
    {
      operation: "browserSessions.revokeOthers",
      failure: () =>
        f.app.fetch(
          new Request(
            `${
              new URL(f.config.auth!.publicOrigin).origin
            }/v1/me/sessions/revoke-others`,
            {
              method: "POST",
              headers: { origin: f.config.auth!.publicOrigin },
            },
          ),
        ),
      success: async () => ({
        response: await adminCall("POST", "/v1/me/sessions/revoke-others", {
          body: {},
        }),
        organizationId: null,
      }),
    },
    {
      operation: "browserSessions.revokeCurrent",
      failure: () =>
        f.app.fetch(
          new Request(
            `${
              new URL(f.config.auth!.publicOrigin).origin
            }/v1/me/sessions/revoke-current`,
            {
              method: "POST",
              headers: { origin: f.config.auth!.publicOrigin },
            },
          ),
        ),
      success: async () => {
        // A second sign-in of its own, so ending it leaves the matrix's admin session alone.
        const second = await f.app.fetch(
          authRequest("/api/auth/sign-in/email", {
            email: f.adminEmail,
            password: f.password,
          }),
        );
        assertEquals(second.status, 200);
        const sessions = await json(
          await call(f, "GET", "/v1/me/sessions", sessionCookie(second), {
            headers: org,
          }),
        );
        const current = (sessions.items as { id: string; current: boolean }[])
          .find((item) => item.current)!;
        return {
          response: await call(
            f,
            "POST",
            "/v1/me/sessions/revoke-current",
            sessionCookie(second),
            { body: {}, headers: { ...org, "Idempotency-Key": key() } },
          ),
          organizationId: null,
          resourceId: current.id,
        };
      },
    },
    {
      operation: "desktopHandoffs.create",
      // A browser cookie session may not ask for a code: refused, no row.
      failure: () =>
        call(f, "POST", "/v1/desktop-handoffs", f.adminCookie, {
          body: { returnTo: "/projects" },
          headers: org,
        }),
      success: async () => {
        const desktop = await signInDesktop(f, f.adminCookie);
        const response = await f.app.fetch(
          new Request(
            `${
              new URL(f.config.auth!.publicOrigin).origin
            }/v1/desktop-handoffs`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${desktop.credential}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ returnTo: "/projects" }),
            },
          ),
        );
        const row = await f.pgDatabase.query<{ id: string }>(
          `select id from bakery.desktop_handoffs
            where desktop_session_id = $1`,
          [desktop.sessionId],
        );
        return {
          response,
          organizationId: null,
          resourceId: row.rows[0]?.id,
        };
      },
    },
    {
      operation: "userPreferences.update",
      failure: () =>
        adminCall("PATCH", "/v1/user-preferences", {
          body: { theme: "dark", expectedCasVersion: 999 },
        }),
      success: async () => {
        const current = await json(
          await adminCall("GET", "/v1/user-preferences"),
        );
        return {
          response: await adminCall("PATCH", "/v1/user-preferences", {
            body: { theme: "dark", expectedCasVersion: current.casVersion },
          }),
          organizationId: f.organizationId,
        };
      },
    },
    {
      operation: "installationSettings.update",
      failure: async () =>
        await updateSettings(f, 0, {
          registrationMode: "invitation",
          organizationCreationPolicy: "installation_admins",
        }),
      success: async () => {
        const settings = await readSettings(f);
        return {
          response: await updateSettings(f, settings.version, {
            registrationMode: "invitation",
            organizationCreationPolicy: "installation_admins",
          }),
          organizationId: null,
          resourceId: "installation",
        };
      },
    },
    {
      operation: "auditRetention.update",
      failure: async () =>
        await adminCall("PATCH", "/v1/audit-retention", {
          body: { retentionDays: 5 },
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await adminCall("PATCH", "/v1/audit-retention", {
          body: { retentionDays: 90 },
          headers: { "Idempotency-Key": key() },
        }),
        organizationId: f.organizationId,
        resourceId: f.organizationId,
      }),
    },
    {
      operation: "scimConnection.create",
      failure: () =>
        developerCall("POST", "/v1/scim-connection", {
          body: { expiresInDays: 30 },
        }),
      success: async () => {
        const response = await adminCall("POST", "/v1/scim-connection", {
          body: { expiresInDays: 30 },
        });
        const body = await response.clone().json() as {
          connection: { id: string };
          token?: string;
        };
        if (body.token) matrixScimSecrets.push(body.token);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: body.connection.id,
        };
      },
    },
    {
      operation: "scimConnection.rotate",
      failure: () =>
        developerCall("POST", "/v1/scim-connection/rotate", {
          body: { expiresInDays: 30 },
        }),
      success: async () => {
        const response = await adminCall("POST", "/v1/scim-connection/rotate", {
          body: { expiresInDays: 30 },
        });
        const body = await response.clone().json() as {
          connection: { id: string };
          token?: string;
        };
        if (body.token) matrixScimSecrets.push(body.token);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: body.connection.id,
        };
      },
    },
    {
      operation: "scimConnection.revoke",
      failure: () =>
        developerCall("POST", "/v1/scim-connection/revoke", { body: {} }),
      success: async () => {
        const response = await adminCall("POST", "/v1/scim-connection/revoke", {
          body: {},
        });
        const body = await response.clone().json() as { id: string };
        return {
          response,
          organizationId: f.organizationId,
          resourceId: body.id,
        };
      },
    },
    {
      operation: "installationAdministrators.create",
      failure: () => grant(f, f.developerId!, developer),
      success: async () => ({
        response: await grant(f),
        organizationId: null,
        resourceId: f.developerId,
      }),
    },
    {
      operation: "installationAdministrators.revoke",
      failure: () => revoke(f, f.adminId, 1),
      success: async () => ({
        response: await revoke(f, f.developerId!, 1),
        organizationId: null,
        resourceId: f.developerId,
      }),
    },
    {
      // Runs after the developer's installation administrator grant is
      // revoked, so only installation authority can refuse the developer.
      operation: "passwordResetLinks.create",
      failure: () =>
        call(f, "POST", "/v1/installation/password-resets", developer, {
          body: { principalId: f.adminId },
        }),
      success: async () => {
        const response = await call(
          f,
          "POST",
          "/v1/installation/password-resets",
          f.adminCookie,
          { body: { principalId: f.developerId } },
        );
        return {
          response,
          organizationId: null,
          resourceId: String((await response.clone().json()).id),
        };
      },
    },
    {
      // Needs the fixture's mounted secrets key; runs after the developer's
      // installation administrator grant is revoked.
      operation: "integrationAppRegistrations.begin",
      failure: () =>
        call(
          f,
          "POST",
          "/v1/integration-app-registrations/github/manifest",
          developer,
          { body: {} },
        ),
      success: async () => ({
        response: await call(
          f,
          "POST",
          "/v1/integration-app-registrations/github/manifest",
          f.adminCookie,
          { body: {} },
        ),
        organizationId: null,
      }),
    },
    {
      // Runs after begin, which refuses once an App is registered.
      operation: "integrationAppRegistrations.put",
      failure: () =>
        call(
          f,
          "PUT",
          "/v1/integration-app-registrations/github",
          developer,
          {
            body: { appId: 1, clientId: "Iv23li", privateKey: "x" },
            headers: { "Idempotency-Key": key() },
          },
        ),
      success: async () => {
        const app = await matrixGitHub.createExistingApp();
        return {
          response: await call(
            f,
            "PUT",
            "/v1/integration-app-registrations/github",
            f.adminCookie,
            {
              body: {
                appId: app.id,
                clientId: app.clientId,
                clientSecret: app.clientSecret,
                privateKey: app.pkcs1Pem,
              },
              headers: { "Idempotency-Key": key() },
            },
          ),
          organizationId: null,
        };
      },
    },
    {
      // A client secret is write-only: the audit row records the provider and a
      // revision, never the secret itself.
      operation: "integrationClientCredentials.put",
      failure: () =>
        call(f, "PUT", "/v1/integration-client-credentials/linear", developer, {
          body: {
            clientId: "audit-matrix-client",
            clientSecret: "audit-matrix-client-secret",
          },
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "PUT",
          "/v1/integration-client-credentials/linear",
          f.adminCookie,
          {
            body: {
              clientId: "audit-matrix-client",
              clientSecret: "audit-matrix-client-secret",
            },
            headers: { "Idempotency-Key": key() },
          },
        ),
        organizationId: null,
      }),
    },
    {
      // Saves first so the verification below probes the injected result.
      operation: "skillStorageSettings.put",
      failure: () =>
        call(f, "PUT", "/v1/installation/skill-storage", developer, {
          body: {
            accountId: "a".repeat(32),
            bucket: "audit-matrix-bucket",
            accessKeyId: "audit-matrix-access",
            secretAccessKey: "audit-matrix-secret",
          },
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "PUT",
          "/v1/installation/skill-storage",
          f.adminCookie,
          {
            body: {
              accountId: "a".repeat(32),
              bucket: "audit-matrix-bucket",
              accessKeyId: "audit-matrix-access",
              secretAccessKey: "audit-matrix-secret",
            },
            headers: { "Idempotency-Key": key() },
          },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "skillStorageSettings.verify",
      failure: () =>
        call(
          f,
          "POST",
          "/v1/installation/skill-storage/verification",
          developer,
          { body: {}, headers: { "Idempotency-Key": key() } },
        ),
      success: async () => ({
        response: await call(
          f,
          "POST",
          "/v1/installation/skill-storage/verification",
          f.adminCookie,
          { body: {}, headers: { "Idempotency-Key": key() } },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "telemetryDestinations.create",
      failure: () =>
        call(f, "POST", "/v1/installation/telemetry-destinations", developer, {
          body: telemetryDestinationBody(),
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => {
        const response = await call(
          f,
          "POST",
          "/v1/installation/telemetry-destinations",
          f.adminCookie,
          {
            body: telemetryDestinationBody(),
            headers: { "Idempotency-Key": key() },
          },
        );
        if (response.status === 201) {
          telemetryDestination = await response.clone().json() as {
            id: string;
            version: number;
          };
        }
        return { response, organizationId: null };
      },
    },
    {
      operation: "telemetryDestinations.update",
      failure: () =>
        call(
          f,
          "PATCH",
          `/v1/installation/telemetry-destinations/${
            telemetryDestination?.id ?? crypto.randomUUID()
          }`,
          developer,
          {
            body: { enabled: false },
            headers: { "Idempotency-Key": key(), "If-Match": '"1"' },
          },
        ),
      success: async () => {
        const response = await call(
          f,
          "PATCH",
          `/v1/installation/telemetry-destinations/${telemetryDestination!.id}`,
          f.adminCookie,
          {
            body: { enabled: false },
            headers: {
              "Idempotency-Key": key(),
              "If-Match": `"${telemetryDestination!.version}"`,
            },
          },
        );
        if (response.status === 200) {
          telemetryDestination = await response.clone().json() as {
            id: string;
            version: number;
          };
        }
        return { response, organizationId: null };
      },
    },
    {
      // Points at a closed local port, so it answers not accepted and reaches nothing.
      operation: "telemetryDestinations.test",
      failure: () =>
        call(
          f,
          "POST",
          "/v1/installation/telemetry-destination-tests",
          developer,
          {
            body: { kind: "otlp", values: { address: "http://127.0.0.1:1" } },
            headers: { "Idempotency-Key": key() },
          },
        ),
      success: async () => ({
        response: await call(
          f,
          "POST",
          "/v1/installation/telemetry-destination-tests",
          f.adminCookie,
          {
            body: { kind: "otlp", values: { address: "http://127.0.0.1:1" } },
            headers: { "Idempotency-Key": key() },
          },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "telemetryDestinations.delete",
      failure: () =>
        call(
          f,
          "DELETE",
          `/v1/installation/telemetry-destinations/${
            telemetryDestination?.id ?? crypto.randomUUID()
          }`,
          developer,
          { headers: { "Idempotency-Key": key(), "If-Match": '"1"' } },
        ),
      success: async () => ({
        response: await call(
          f,
          "DELETE",
          `/v1/installation/telemetry-destinations/${telemetryDestination!.id}`,
          f.adminCookie,
          {
            headers: {
              "Idempotency-Key": key(),
              "If-Match": `"${telemetryDestination!.version}"`,
            },
          },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "backups.start",
      failure: () =>
        call(f, "POST", "/v1/installation/backups", developer, {
          body: {},
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "POST",
          "/v1/installation/backups",
          f.adminCookie,
          { body: {}, headers: { "Idempotency-Key": key() } },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "backupRunnerCredential.issue",
      failure: () =>
        call(
          f,
          "POST",
          "/v1/installation/backup-runner/credential",
          developer,
          { body: {} },
        ),
      success: async () => ({
        response: await call(
          f,
          "POST",
          "/v1/installation/backup-runner/credential",
          f.adminCookie,
          { body: {} },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "backupSchedule.put",
      failure: () =>
        call(f, "PUT", "/v1/installation/backup-schedule", developer, {
          body: {
            enabled: true,
            interval: "daily",
            timeOfDayUtc: "03:00",
            daysToKeep: 30,
          },
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "PUT",
          "/v1/installation/backup-schedule",
          f.adminCookie,
          {
            body: {
              enabled: true,
              interval: "daily",
              timeOfDayUtc: "03:00",
              daysToKeep: 30,
            },
            headers: { "Idempotency-Key": key() },
          },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "backupPointInTime.put",
      failure: () =>
        call(f, "PUT", "/v1/installation/backup-point-in-time", developer, {
          body: { enabled: true },
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "PUT",
          "/v1/installation/backup-point-in-time",
          f.adminCookie,
          {
            body: { enabled: true },
            headers: { "Idempotency-Key": key() },
          },
        ),
        organizationId: null,
      }),
    },
    {
      // Saves first so the test below has a destination to send to.
      operation: "backupOffsite.put",
      failure: () =>
        call(f, "PUT", "/v1/installation/backup-offsite", developer, {
          body: {
            endpoint: "http://127.0.0.1:9000",
            region: "us-east-1",
            bucket: "audit-matrix-bucket",
            accessKeyId: "audit-matrix-access",
            secretAccessKey: "audit-matrix-secret",
          },
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "PUT",
          "/v1/installation/backup-offsite",
          f.adminCookie,
          {
            body: {
              endpoint: "http://127.0.0.1:9000",
              region: "us-east-1",
              bucket: "audit-matrix-bucket",
              accessKeyId: "audit-matrix-access",
              secretAccessKey: "audit-matrix-secret",
            },
            headers: { "Idempotency-Key": key() },
          },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "backupOffsite.verify",
      failure: () =>
        call(
          f,
          "POST",
          "/v1/installation/backup-offsite/verification",
          developer,
          { body: {}, headers: { "Idempotency-Key": key() } },
        ),
      success: async () => ({
        response: await call(
          f,
          "POST",
          "/v1/installation/backup-offsite/verification",
          f.adminCookie,
          { body: {}, headers: { "Idempotency-Key": key() } },
        ),
        organizationId: null,
      }),
    },
    {
      // Runs while email is off, so it answers not_configured and sends nothing.
      operation: "emailSettings.test",
      failure: () =>
        call(f, "POST", "/v1/installation/email/test", developer, {
          body: {},
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "POST",
          "/v1/installation/email/test",
          f.adminCookie,
          { body: {}, headers: { "Idempotency-Key": key() } },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "alertChannels.create",
      failure: () =>
        call(f, "POST", "/v1/installation/alert-channels", developer, {
          body: alertChannelBody(),
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => {
        const response = await call(
          f,
          "POST",
          "/v1/installation/alert-channels",
          f.adminCookie,
          {
            body: alertChannelBody(),
            headers: { "Idempotency-Key": key() },
          },
        );
        if (response.status === 201) {
          alertChannel = (await response.clone().json() as {
            channel: { id: string; version: number };
          }).channel;
        }
        return { response, organizationId: null };
      },
    },
    {
      operation: "alertChannels.update",
      failure: () =>
        call(
          f,
          "PATCH",
          `/v1/installation/alert-channels/${
            alertChannel?.id ?? crypto.randomUUID()
          }`,
          developer,
          {
            body: { enabled: false },
            headers: { "Idempotency-Key": key(), "If-Match": '"1"' },
          },
        ),
      success: async () => {
        const response = await call(
          f,
          "PATCH",
          `/v1/installation/alert-channels/${alertChannel!.id}`,
          f.adminCookie,
          {
            body: { enabled: false },
            headers: {
              "Idempotency-Key": key(),
              "If-Match": `"${alertChannel!.version}"`,
            },
          },
        );
        if (response.status === 200) {
          alertChannel = await response.clone().json() as {
            id: string;
            version: number;
          };
        }
        return { response, organizationId: null };
      },
    },
    {
      // Points at a closed local port, so it answers not accepted and reaches nothing.
      operation: "alertChannels.test",
      failure: () =>
        call(
          f,
          "POST",
          `/v1/installation/alert-channels/${
            alertChannel?.id ?? crypto.randomUUID()
          }/tests`,
          developer,
          { headers: { "Idempotency-Key": key() } },
        ),
      success: async () => ({
        response: await call(
          f,
          "POST",
          `/v1/installation/alert-channels/${alertChannel!.id}/tests`,
          f.adminCookie,
          { headers: { "Idempotency-Key": key() } },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "alertRules.update",
      failure: () =>
        call(f, "PATCH", "/v1/installation/alert-rules", developer, {
          body: { rule: "queue_age", enabled: true },
          headers: { "Idempotency-Key": key(), "If-Match": '"1"' },
        }),
      success: async () => {
        // Write the rule's own value back, so the matrix leaves it as it found it.
        const read = await call(
          f,
          "GET",
          "/v1/installation/alert-rules",
          f.adminCookie,
          {},
        );
        const rule = ((await read.json()) as {
          rules: { rule: string; version: number; enabled: boolean }[];
        }).rules.find((r) => r.rule === "queue_age")!;
        return {
          response: await call(
            f,
            "PATCH",
            "/v1/installation/alert-rules",
            f.adminCookie,
            {
              body: { rule: "queue_age", enabled: rule.enabled },
              headers: {
                "Idempotency-Key": key(),
                "If-Match": `"${rule.version}"`,
              },
            },
          ),
          organizationId: null,
        };
      },
    },
    {
      // With no channel to send to it reaches nothing, and is still recorded.
      operation: "alerts.sendTest",
      failure: () =>
        call(f, "POST", "/v1/installation/alert-tests", developer, {
          body: {},
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "POST",
          "/v1/installation/alert-tests",
          f.adminCookie,
          { body: {}, headers: { "Idempotency-Key": key() } },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "alertChannels.rotateSecret",
      failure: () =>
        call(
          f,
          "POST",
          `/v1/installation/alert-channels/${
            alertChannel?.id ?? crypto.randomUUID()
          }/secret-rotations`,
          developer,
          { headers: { "Idempotency-Key": key(), "If-Match": '"1"' } },
        ),
      success: async () => {
        const response = await call(
          f,
          "POST",
          `/v1/installation/alert-channels/${
            alertChannel!.id
          }/secret-rotations`,
          f.adminCookie,
          {
            headers: {
              "Idempotency-Key": key(),
              "If-Match": `"${alertChannel!.version}"`,
            },
          },
        );
        if (response.status === 200) {
          alertChannel = (await response.clone().json() as {
            channel: { id: string; version: number };
          }).channel;
        }
        return { response, organizationId: null };
      },
    },
    {
      operation: "alertChannels.delete",
      failure: () =>
        call(
          f,
          "DELETE",
          `/v1/installation/alert-channels/${
            alertChannel?.id ?? crypto.randomUUID()
          }`,
          developer,
          { headers: { "Idempotency-Key": key(), "If-Match": '"1"' } },
        ),
      success: async () => ({
        response: await call(
          f,
          "DELETE",
          `/v1/installation/alert-channels/${alertChannel!.id}`,
          f.adminCookie,
          {
            headers: {
              "Idempotency-Key": key(),
              "If-Match": `"${alertChannel!.version}"`,
            },
          },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "emailSettings.put",
      failure: () =>
        call(f, "PUT", "/v1/installation/email", developer, {
          body: emailSettingsBody(),
          headers: { "Idempotency-Key": key() },
        }),
      success: async () => ({
        response: await call(
          f,
          "PUT",
          "/v1/installation/email",
          f.adminCookie,
          {
            body: emailSettingsBody(),
            headers: { "Idempotency-Key": key() },
          },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "emailSettings.delete",
      failure: () =>
        call(f, "DELETE", "/v1/installation/email", developer, {
          body: {},
          headers: { "Idempotency-Key": key(), "If-Match": '"v1"' },
        }),
      success: async () => ({
        response: await call(
          f,
          "DELETE",
          "/v1/installation/email",
          f.adminCookie,
          {
            body: {},
            headers: { "Idempotency-Key": key(), "If-Match": '"v1"' },
          },
        ),
        organizationId: null,
      }),
    },
    {
      operation: "principals.create",
      failure: () =>
        developerCall("POST", "/v1/principals", {
          // A member may create a service account no stronger than
          // themselves (#534), so the refusal is an Admin-role account.
          body: { displayName: "Denied", role: "admin" },
        }),
      success: async () => {
        const response = await adminCall("POST", "/v1/principals", {
          body: { displayName: `Matrix bot ${suffix}`, role: "developer" },
        });
        const created = await json(response.clone());
        state.serviceAccount = String(created.id);
        state.serviceAccountVersion = String(created.version);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.serviceAccount,
        };
      },
    },
    {
      operation: "principals.update",
      failure: () =>
        developerCall("PATCH", `/v1/principals/${state.serviceAccount}`, {
          body: { displayName: "Denied" },
          headers: { "If-Match": `"v${state.serviceAccountVersion}"` },
        }),
      success: async () => ({
        response: await adminCall(
          "PATCH",
          `/v1/principals/${state.serviceAccount}`,
          {
            body: { displayName: `Matrix bot renamed ${suffix}` },
            headers: { "If-Match": `"v${state.serviceAccountVersion}"` },
          },
        ),
        organizationId: f.organizationId,
        resourceId: state.serviceAccount,
      }),
    },
    {
      operation: "permissionGrants.create",
      failure: () =>
        developerCall("POST", "/v1/permission-grants", {
          body: {
            principalId: state.serviceAccount,
            capability: "applications.list",
          },
        }),
      success: async () => {
        const response = await adminCall("POST", "/v1/permission-grants", {
          body: {
            principalId: state.serviceAccount,
            capability: "applications.list",
          },
        });
        const created = await json(response.clone());
        state.permissionGrant = String(created.id);
        state.permissionGrantVersion = String(created.version);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.permissionGrant,
        };
      },
    },
    {
      operation: "permissionGrants.delete",
      failure: () =>
        developerCall(
          "DELETE",
          `/v1/permission-grants/${state.permissionGrant}`,
          { headers: { "If-Match": `"v${state.permissionGrantVersion}"` } },
        ),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/permission-grants/${state.permissionGrant}`,
          { headers: { "If-Match": `"v${state.permissionGrantVersion}"` } },
        ),
        organizationId: f.organizationId,
        resourceId: state.permissionGrant,
      }),
    },
    {
      // #436: an Admin binds an agent version to one exact MCP tool.
      operation: "capabilityBindings.create",
      failure: async () => {
        const seeded = await seedToolGatewayCall(f);
        state.bindingConnection = seeded.connectionId;
        state.bindingAgentVersion = seeded.agentVersionId;
        state.gatewayCall = seeded.callId;
        return await developerCall("POST", "/v1/capability-bindings", {
          body: capabilityBindingBody(state),
        });
      },
      success: async () => {
        const response = await adminCall("POST", "/v1/capability-bindings", {
          body: capabilityBindingBody(state),
        });
        const created = await json(response.clone());
        state.capabilityBinding = String(created.id);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.capabilityBinding,
        };
      },
    },
    {
      operation: "capabilityBindings.delete",
      failure: () =>
        developerCall(
          "DELETE",
          `/v1/capability-bindings/${state.capabilityBinding}`,
        ),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/capability-bindings/${state.capabilityBinding}`,
        ),
        organizationId: f.organizationId,
        resourceId: state.capabilityBinding,
      }),
    },
    {
      // #436: an Admin records the outcome of a write the gateway sent.
      operation: "toolGatewayCalls.settle",
      failure: () =>
        developerCall(
          "POST",
          `/v1/tool-gateway-calls/${state.gatewayCall}/settlement`,
          { body: { status: "completed" } },
        ),
      success: async () => ({
        response: await adminCall(
          "POST",
          `/v1/tool-gateway-calls/${state.gatewayCall}/settlement`,
          { body: { status: "completed" } },
        ),
        organizationId: f.organizationId,
        resourceId: state.gatewayCall,
      }),
    },
    {
      // #20: a grant on a seeded integration connection.
      operation: "integrationGrants.create",
      failure: async () => {
        state.grantConnection = crypto.randomUUID();
        await seedRigIntegration(f.pgDatabase, {
          organizationId: f.organizationId,
          principalId: f.adminId!,
          connectionId: state.grantConnection,
          resourceId: crypto.randomUUID(),
        });
        return await developerCall(
          "POST",
          `/v1/integration-connections/${state.grantConnection}/grants`,
          { body: integrationGrantBody(f.adminId!) },
        );
      },
      success: async () => {
        const response = await adminCall(
          "POST",
          `/v1/integration-connections/${state.grantConnection}/grants`,
          { body: integrationGrantBody(f.adminId!) },
        );
        const created = await json(response.clone());
        state.integrationGrant = String(created.id);
        state.integrationGrantVersion = String(created.version);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.integrationGrant,
        };
      },
    },
    {
      operation: "integrationGrants.delete",
      failure: () =>
        developerCall(
          "DELETE",
          `/v1/integration-connections/${state.grantConnection}/grants/${state.integrationGrant}`,
          { headers: { "If-Match": `"${state.integrationGrantVersion}"` } },
        ),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/integration-connections/${state.grantConnection}/grants/${state.integrationGrant}`,
          { headers: { "If-Match": `"${state.integrationGrantVersion}"` } },
        ),
        organizationId: f.organizationId,
        resourceId: state.integrationGrant,
      }),
    },
    {
      operation: "accessTokens.create",
      failure: () =>
        // A member may mint their own tokens (#534), never one for the
        // Admin above them.
        developerCall("POST", "/v1/access-tokens", {
          body: {
            principalId: f.adminId,
            name: "Denied",
            scopes: ["bakery:read"],
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        }),
      success: async () => {
        const response = await adminCall("POST", "/v1/access-tokens", {
          body: {
            principalId: state.serviceAccount,
            name: "Matrix token",
            scopes: ["bakery:read"],
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        });
        const created = await json(response.clone());
        MATRIX_TOKEN_SECRETS.push(String(created.secret));
        state.accessToken = String(created.id);
        state.accessTokenVersion = String(created.version);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.accessToken,
        };
      },
    },
    {
      operation: "accessTokens.revoke",
      failure: () =>
        developerCall("DELETE", `/v1/access-tokens/${state.accessToken}`, {
          headers: { "If-Match": `"v${state.accessTokenVersion}"` },
        }),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/access-tokens/${state.accessToken}`,
          { headers: { "If-Match": `"v${state.accessTokenVersion}"` } },
        ),
        organizationId: f.organizationId,
        resourceId: state.accessToken,
      }),
    },
    {
      operation: "accessBindings.create",
      failure: async () => {
        // A real target, so only authorization can refuse the developer.
        const application = await adminCall("POST", "/v1/applications", {
          body: {
            slug: `matrix-app-${suffix}`,
            name: `Matrix app ${suffix}`,
            description: "Audit matrix binding target",
          },
        });
        state.bindingApplication = String((await json(application)).id);
        return developerCall("POST", "/v1/access-bindings", {
          body: {
            principalId: state.serviceAccount,
            roleKey: "viewer",
            scopeType: "application",
            scopeId: state.bindingApplication,
          },
        });
      },
      success: async () => {
        const response = await adminCall("POST", "/v1/access-bindings", {
          body: {
            principalId: state.serviceAccount,
            roleKey: "viewer",
            scopeType: "application",
            scopeId: state.bindingApplication,
          },
        });
        const created = await json(response.clone());
        state.accessBinding = String(created.id);
        state.accessBindingVersion = String(created.version);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.accessBinding,
        };
      },
    },
    {
      operation: "accessBindings.delete",
      failure: () =>
        developerCall("DELETE", `/v1/access-bindings/${state.accessBinding}`, {
          headers: { "If-Match": `"v${state.accessBindingVersion}"` },
        }),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/access-bindings/${state.accessBinding}`,
          { headers: { "If-Match": `"v${state.accessBindingVersion}"` } },
        ),
        organizationId: f.organizationId,
        resourceId: state.accessBinding,
      }),
    },
    {
      operation: "definitionPublishGrants.create",
      failure: async () => {
        // A real workflow, so only authorization can refuse the developer.
        const workflow = await adminCall("POST", "/v1/workflows", {
          body: {
            slug: `matrix-flow-${suffix}`,
            name: `Matrix flow ${suffix}`,
            description: "",
          },
        });
        state.grantWorkflow = String((await json(workflow)).id);
        return developerCall("POST", "/v1/definition-publish-grants", {
          body: {
            definitionKind: "workflow",
            definitionId: state.grantWorkflow,
          },
        });
      },
      success: async () => {
        const response = await adminCall(
          "POST",
          "/v1/definition-publish-grants",
          {
            body: {
              definitionKind: "workflow",
              definitionId: state.grantWorkflow,
            },
          },
        );
        const created = await json(response.clone());
        state.publishGrant = String(created.id);
        state.publishGrantVersion = String(created.version);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.publishGrant,
        };
      },
    },
    {
      operation: "definitionPublishGrants.delete",
      failure: () =>
        developerCall(
          "DELETE",
          `/v1/definition-publish-grants/${state.publishGrant}`,
          { headers: { "If-Match": `"${state.publishGrantVersion}"` } },
        ),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/definition-publish-grants/${state.publishGrant}`,
          { headers: { "If-Match": `"${state.publishGrantVersion}"` } },
        ),
        organizationId: f.organizationId,
        resourceId: state.publishGrant,
      }),
    },
    {
      operation: "agentPowerGrants.create",
      failure: async () => {
        // A real workflow, so only authorization can refuse the developer.
        const workflow = await adminCall("POST", "/v1/workflows", {
          body: {
            slug: `matrix-power-${suffix}`,
            name: `Matrix power ${suffix}`,
            description: "",
          },
        });
        state.powerWorkflow = String((await json(workflow)).id);
        return developerCall("POST", "/v1/agent-power-grants", {
          body: { power: "decide", workflowId: state.powerWorkflow },
        });
      },
      success: async () => {
        const response = await adminCall("POST", "/v1/agent-power-grants", {
          body: { power: "decide", workflowId: state.powerWorkflow },
        });
        const created = await json(response.clone());
        state.powerGrant = String(created.id);
        state.powerGrantVersion = String(created.version);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.powerGrant,
        };
      },
    },
    {
      operation: "agentPowerGrants.delete",
      failure: () =>
        developerCall(
          "DELETE",
          `/v1/agent-power-grants/${state.powerGrant}`,
          { headers: { "If-Match": `"${state.powerGrantVersion}"` } },
        ),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/agent-power-grants/${state.powerGrant}`,
          { headers: { "If-Match": `"${state.powerGrantVersion}"` } },
        ),
        organizationId: f.organizationId,
        resourceId: state.powerGrant,
      }),
    },
    {
      operation: "applicationRepositoryRoles.set",
      failure: async () => {
        state.roleRepository = crypto.randomUUID();
        await f.pgDatabase.query(
          `insert into bakery.repositories (
             id, organization_id, application_id, integration_connection_id,
             provider_repo_id, owner, name, default_branch, version
           ) values ($1, $2, $3, $4, $5, 'matrix-owner', $6, 'main', 1)`,
          [
            state.roleRepository,
            f.organizationId,
            state.bindingApplication,
            crypto.randomUUID(),
            `matrix/${suffix}`,
            `matrix-${suffix}`,
          ],
        );
        return developerCall(
          "PUT",
          `/v1/applications/${state.bindingApplication}/repository-roles`,
          {
            body: {
              alias: "matrix",
              role: "backend",
              repositoryId: state.roleRepository,
            },
          },
        );
      },
      success: async () => {
        const response = await adminCall(
          "PUT",
          `/v1/applications/${state.bindingApplication}/repository-roles`,
          {
            body: {
              alias: "matrix",
              role: "backend",
              repositoryId: state.roleRepository,
            },
          },
        );
        const created = await json(response.clone());
        return {
          response,
          organizationId: f.organizationId,
          resourceId: String(created.id),
        };
      },
    },
    {
      operation: "organizationRoles.create",
      failure: () =>
        developerCall("POST", "/v1/organization-roles", {
          body: {
            key: `denied-${suffix}`,
            name: "Denied",
            permissions: ["principal:read"],
          },
        }),
      success: async () => {
        const response = await adminCall("POST", "/v1/organization-roles", {
          body: {
            key: `matrix-${suffix}`,
            name: "Matrix role",
            permissions: ["principal:read"],
          },
        });
        const created = await json(response.clone());
        state.customRole = String(created.id);
        state.customRoleVersion = String(created.version);
        return {
          response,
          organizationId: f.organizationId,
          resourceId: state.customRole,
        };
      },
    },
    {
      operation: "organizationRoles.update",
      failure: () =>
        developerCall("PATCH", `/v1/organization-roles/${state.customRole}`, {
          body: { name: "Denied" },
          headers: { "If-Match": `"v${state.customRoleVersion}"` },
        }),
      success: async () => ({
        response: await adminCall(
          "PATCH",
          `/v1/organization-roles/${state.customRole}`,
          {
            body: { name: "Matrix role renamed" },
            headers: { "If-Match": `"v${state.customRoleVersion}"` },
          },
        ),
        organizationId: f.organizationId,
        resourceId: state.customRole,
      }),
    },
    {
      operation: "organizationRoles.assign",
      failure: () =>
        developerCall(
          "POST",
          `/v1/organization-roles/${state.customRole}/members`,
          { body: { principalId: f.developerId } },
        ),
      success: async () => ({
        response: await adminCall(
          "POST",
          `/v1/organization-roles/${state.customRole}/members`,
          { body: { principalId: f.developerId } },
        ),
        organizationId: f.organizationId,
        resourceId: state.customRole,
      }),
    },
    {
      operation: "organizationRoles.unassign",
      failure: () =>
        developerCall(
          "DELETE",
          `/v1/organization-roles/${state.customRole}/members/${f.developerId}`,
        ),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/organization-roles/${state.customRole}/members/${f.developerId}`,
        ),
        organizationId: f.organizationId,
        resourceId: state.customRole,
      }),
    },
    {
      operation: "organizationRoles.delete",
      failure: () =>
        developerCall("DELETE", `/v1/organization-roles/${state.customRole}`, {
          headers: { "If-Match": `"v${Number(state.customRoleVersion) + 1}"` },
        }),
      success: async () => ({
        response: await adminCall(
          "DELETE",
          `/v1/organization-roles/${state.customRole}`,
          {
            headers: {
              "If-Match": `"v${Number(state.customRoleVersion) + 1}"`,
            },
          },
        ),
        organizationId: f.organizationId,
        resourceId: state.customRole,
      }),
    },
  ];

  assertEquals(
    cases.map((item) => item.operation).sort(),
    [...matrixActions].sort(),
    "matrix cases must equal the declared audit matrix action list",
  );
  for (const matrixCase of cases) {
    const before = await rowsFor(matrixCase.operation);
    const failed = await matrixCase.failure();
    assert(
      failed.status >= 400,
      `${matrixCase.operation} failure case returned ${failed.status}`,
    );
    await failed.body?.cancel();
    assertEquals(
      (await rowsFor(matrixCase.operation)).length,
      before.length,
      `${matrixCase.operation} failure wrote an audit row`,
    );
    const outcome = await matrixCase.success();
    assert(
      outcome.response.status < 300,
      `${matrixCase.operation} success case returned ${outcome.response.status}: ${await outcome
        .response
        .clone().text()}`,
    );
    const after = await rowsFor(matrixCase.operation);
    assertEquals(
      after.length,
      before.length + 1,
      `${matrixCase.operation} must write exactly one row`,
    );
    const row = after.find((item) =>
      !before.some((old) => old.id === item.id)
    )!;
    assertEquals(row.outcome, "succeeded");
    assertEquals(row.organizationId, outcome.organizationId);
    assertNotEquals(row.principalId, null, matrixCase.operation);
    assert(row.requestId.length > 0 && row.traceId.length > 0);
    if (outcome.resourceId !== undefined) {
      assertEquals(row.resourceId, outcome.resourceId, matrixCase.operation);
    }
    produced.push(row);
  }
  produced.push(...await runCredentialMatrix(f, rowsFor));
  return produced;
}

async function runCredentialMatrix(
  f: InstallationFixture,
  rowsFor: (operation: string) => Promise<MatrixRow[]>,
): Promise<MatrixRow[]> {
  const produced: MatrixRow[] = [];
  let cookie = f.developerCookie;
  const post = (path: string, body: unknown) =>
    f.app.fetch(authRequest(path, body, { cookie }));
  const step = async (
    operation: string,
    failure: () => Response | Promise<Response>,
    success: () => Response | Promise<Response>,
  ) => {
    const before = await rowsFor(operation);
    const failed = await failure();
    assert(failed.status >= 400, `${operation} failure ${failed.status}`);
    await failed.body?.cancel();
    assertEquals((await rowsFor(operation)).length, before.length, operation);
    const ok = await success();
    assert(ok.ok, `${operation} success ${ok.status}`);
    await ok.body?.cancel();
    const after = await rowsFor(operation);
    assertEquals(after.length, before.length + 1, operation);
    const row = after.find((item) =>
      !before.some((old) => old.id === item.id)
    )!;
    assertEquals(row.organizationId, null);
    assertNotEquals(row.principalId, null, operation);
    produced.push(row);
  };
  const newPassword = `${f.password}-changed`;
  await step(
    "auth.password.change",
    () =>
      post("/api/auth/change-password", {
        currentPassword: "wrong-password",
        newPassword,
      }),
    () =>
      post("/api/auth/change-password", {
        currentPassword: f.password,
        newPassword,
      }),
  );
  const password = newPassword;
  await step(
    "auth.twoFactor.enable",
    () => post("/api/auth/two-factor/enable", { password: "wrong-password" }),
    async () => {
      const enrolled = await enrollTotp(f, cookie, password);
      cookie = enrolled.cookie;
      return new Response(null, { status: 200 });
    },
  );
  await step(
    "auth.twoFactor.regenerateBackupCodes",
    () =>
      post("/api/auth/two-factor/generate-backup-codes", {
        password: "wrong-password",
      }),
    () => post("/api/auth/two-factor/generate-backup-codes", { password }),
  );
  await step(
    "auth.twoFactor.disable",
    () => post("/api/auth/two-factor/disable", { password: "wrong-password" }),
    () => post("/api/auth/two-factor/disable", { password }),
  );
  for (const operation of AUDIT_MATRIX_CREDENTIAL_OPERATIONS) {
    void operation;
  }
  return produced;
}

/** SSO client secrets and SAML private keys the matrix submitted; no audit row may echo them. */
export const MATRIX_SSO_SECRETS: string[] = [];

/**
 * Plugin-endpoint auth mutations: SSO provider create, update, delete, domain
 * verification and enforcement. Each failure leaves no row; each success leaves
 * exactly one for its operation, attributed to the acting admin and scoped to
 * the organization.
 */
export async function runSsoAuditMatrix(
  f: InstallationFixture,
): Promise<MatrixRow[]> {
  const origin = "http://127.0.0.1:8788";
  const clientSecret = `sso-client-secret-${crypto.randomUUID()}`;
  const rotatedSecret = `sso-rotated-secret-${crypto.randomUUID()}`;
  const privateKey =
    `-----BEGIN PRIVATE KEY-----\n${crypto.randomUUID()}\n-----END PRIVATE KEY-----`;
  MATRIX_SSO_SECRETS.push(clientSecret, rotatedSecret, privateKey);
  const produced: MatrixRow[] = [];
  const rows = async (operation: string) =>
    (await f.pgDatabase.query<MatrixRow>(
      `select ${COLUMNS} from bakery.audit_events where operation = $1
       order by created_at, id`,
      [operation],
    )).rows;
  const post = (path: string, body: unknown, cookie = f.adminCookie) =>
    f.app.fetch(authRequest(path, body, { cookie }));
  const providerId = `matrix-${crypto.randomUUID().slice(0, 8)}`;
  const register = (cookie: string, id = providerId) =>
    post("/api/auth/sso/register", {
      providerId: id,
      issuer: `${origin}/idp/${id}`,
      domain: "example.test",
      organizationId: f.organizationId,
      oidcConfig: {
        clientId: "matrix-client",
        clientSecret,
        skipDiscovery: true,
        authorizationEndpoint: `${origin}/idp/authorize`,
        tokenEndpoint: `${origin}/idp/token`,
        jwksEndpoint: `${origin}/idp/jwks`,
      },
    }, cookie);

  async function step(
    operation: string,
    failure: () => Response | Promise<Response>,
    success: () => Response | Promise<Response>,
    resourceId: string,
    details?: unknown,
  ) {
    const before = (await rows(operation)).length;
    const refused = await failure();
    assert(!refused.ok, `${operation} failure case succeeded`);
    assertEquals(
      (await rows(operation)).length,
      before,
      `${operation} wrote on failure`,
    );
    const done = await success();
    assert(done.ok, `${operation} ${done.status} ${await done.clone().text()}`);
    const after = await rows(operation);
    assertEquals(after.length, before + 1, `${operation} must write one row`);
    const row = after.at(-1)!;
    assertEquals(row.organizationId, f.organizationId);
    assertEquals(row.principalId, f.adminId);
    assertEquals(row.resourceId, resourceId);
    assertEquals(row.outcome, "succeeded");
    if (details !== undefined) assertEquals(row.details, details);
    produced.push(row);
  }

  await step(
    "auth.sso.provider.create",
    () => register(f.developerCookie),
    () => register(f.adminCookie),
    providerId,
    {},
  );
  // A SAML provider carrying a private key: audited, never echoed.
  const samlId = `${providerId}-saml`;
  const samlRegistered = await post("/api/auth/sso/register", {
    providerId: samlId,
    issuer: `${origin}/sp/${samlId}`,
    domain: "saml.example.test",
    organizationId: f.organizationId,
    samlConfig: {
      entryPoint: `${origin}/idp/sso`,
      callbackUrl: `${origin}/`,
      cert: (await selfSignedCertificate("matrix-idp")).certificate,
      privateKey,
      idpMetadata: { entityID: `${origin}/idp/${samlId}` },
    },
  });
  assert(samlRegistered.ok, await samlRegistered.clone().text());
  assert(
    !(await samlRegistered.text()).includes(privateKey),
    "SAML register response echoed the private key",
  );
  produced.push((await rows("auth.sso.provider.create")).at(-1)!);
  await post("/api/auth/sso/delete-provider", { providerId: samlId });
  produced.push((await rows("auth.sso.provider.delete")).at(-1)!);
  await step(
    "auth.sso.provider.update",
    () =>
      post(
        "/api/auth/sso/update-provider",
        { providerId, domain: "x.test" },
        f.developerCookie,
      ),
    () =>
      post("/api/auth/sso/update-provider", {
        providerId,
        oidcConfig: { clientSecret: rotatedSecret },
      }),
    providerId,
    { changedFields: ["oidcConfig"] },
  );
  const token = await post("/api/auth/sso/request-domain-verification", {
    providerId,
  });
  assertEquals(token.status, 201);
  const { domainVerificationToken } = await token.json() as {
    domainVerificationToken: string;
  };
  MATRIX_SSO_SECRETS.push(domainVerificationToken);
  const dns = await startTxtDns();
  try {
    await step(
      "auth.sso.domain.verify",
      () => post("/api/auth/sso/verify-domain", { providerId }),
      () => {
        dns.publish(
          `_bakery-verify-${providerId}.example.test`,
          domainVerificationToken,
        );
        return post("/api/auth/sso/verify-domain", { providerId });
      },
      providerId,
      {},
    );
  } finally {
    dns.close();
  }
  await step(
    "auth.sso.enforcement.update",
    () =>
      post("/api/auth/bakery-sso/enforcement", {
        organizationId: f.organizationId,
        enforce: true,
      }, f.developerCookie),
    () =>
      post("/api/auth/bakery-sso/enforcement", {
        organizationId: f.organizationId,
        enforce: true,
      }),
    f.organizationId,
    { enforce: true },
  );
  await post("/api/auth/bakery-sso/enforcement", {
    organizationId: f.organizationId,
    enforce: false,
  });
  produced.push(...(await rows("auth.sso.enforcement.update")).slice(1));
  await step(
    "auth.sso.provider.delete",
    () =>
      post("/api/auth/sso/delete-provider", { providerId: "missing-provider" }),
    () => post("/api/auth/sso/delete-provider", { providerId }),
    providerId,
    {},
  );
  const covered = new Set(produced.map((row) => row.operation));
  for (const operation of AUDIT_MATRIX_PLUGIN_OPERATIONS) {
    assert(
      covered.has(operation),
      `${operation} is not covered by the SSO matrix`,
    );
  }
  return produced;
}
