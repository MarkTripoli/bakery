import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { scim, type SCIMBearerTokenVerification } from "@better-auth/scim";
import type { ScimHost } from "./host.ts";
import { SCIM_SECRET_PREFIX, sha256Hex } from "./credentials.ts";
import {
  isMappedRole,
  reconcileScimOrganization,
  roleForGroup,
} from "./projection.ts";

/** Seconds between persisted `last_used_at` updates of one credential. */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

const ALL_SCOPES = [
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
] as const;

type Verified = Extract<SCIMBearerTokenVerification, { connection: unknown }>;

/**
 * Resolves a presented bearer secret to its connection by digest. A revoked or
 * expired credential, a revoked connection and an unknown secret all answer
 * null; deprovisioning therefore keeps working for exactly as long as the
 * credential does.
 */
async function verifySecret(
  host: ScimHost,
  token: string,
): Promise<Verified | null> {
  if (!token.startsWith(SCIM_SECRET_PREFIX)) return null;
  const now = (host.clock ?? (() => new Date()))();
  const found = await host.database.query<{
    credentialId: string;
    connectionId: string;
    organizationId: string;
    expiresAt: Date;
    lastUsedAt: Date | null;
  }>(
    `select credential.id as "credentialId",
      credential.connection_id as "connectionId",
      credential.organization_id as "organizationId",
      credential.expires_at as "expiresAt",
      credential.last_used_at as "lastUsedAt"
    from bakery.scim_credentials as credential
    join bakery.scim_connections as connection
      on connection.id = credential.connection_id
    where credential.secret_sha256 = $1
      and credential.revoked_at is null
      and connection.revoked_at is null
      and credential.expires_at > $2`,
    [await sha256Hex(token), now],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (
    row.lastUsedAt === null ||
    now.getTime() - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS
  ) {
    await host.database.query(
      `update bakery.scim_credentials set last_used_at = $2 where id = $1`,
      [row.credentialId, now],
    );
  }
  return {
    connection: {
      id: row.connectionId,
      provisioningDomainId: row.organizationId,
    },
    credentialId: row.credentialId,
    scopes: ALL_SCOPES,
    expiresAt: row.expiresAt,
  };
}

/** Organizations whose last membership projection failed and must be retried. */
const failedProjections = new Set<string>();

/**
 * Projects one organization, retrying once. A failure is logged by code and
 * connection only and remembered, so the next SCIM request repairs it. Access
 * of a deprovisioned person never waits on this: the authority resolution path
 * denies them as soon as the plugin commits.
 */
async function projectWithRetry(
  host: ScimHost,
  organizationId: string,
  connectionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await reconcileScimOrganization(host, organizationId);
      failedProjections.delete(organizationId);
      return;
    } catch {
      // Retry once, then record below.
    }
  }
  failedProjections.add(organizationId);
  console.error(`SCIM_RECONCILE_FAILED connection=${connectionId}`);
}

function bearerToken(headers: Headers | undefined): string | null {
  const header = headers?.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1] : null;
}

/**
 * Better Auth plugins that serve SCIM 2.0 for Bakery organizations.
 *
 * - Authentication: Bakery-owned credentials (`bakery.scim_credentials`).
 * - Projection: after each provisioning request, memberships are reconciled
 *   from the plugin's tables in one audited transaction.
 */
export function createScimAuthPlugins(host: ScimHost): BetterAuthPlugin[] {
  const scimPlugin = scim({
    connections: [],
    authentication: {
      verifyBearerToken: ({ token }) => verifySecret(host, token),
    },
    identity: {
      // Never link by email: an unverified address must not let a directory
      // take over an existing Bakery person.
      resolveUser: () => Promise.resolve({ action: "create" as const }),
    },
    projection: {
      roles: {
        map: ({ source }) => {
          const role = roleForGroup(source.displayName);
          return role ? [role] : [];
        },
        exists: ({ role }) => isMappedRole(role),
      },
      // Memberships are projected after each request (below), not per user.
      reconcileUser: () => {},
    },
  });
  const projection: BetterAuthPlugin = {
    id: "bakery-scim-projection",
    hooks: {
      after: [{
        matcher: (context) =>
          context.path?.startsWith("/scim/v2/Users") === true ||
          context.path?.startsWith("/scim/v2/Groups") === true,
        handler: createAuthMiddleware(async (ctx) => {
          const method = ctx.request?.method ?? "GET";
          const token = bearerToken(ctx.request?.headers);
          let verified: Awaited<ReturnType<typeof verifySecret>> = null;
          try {
            verified = token ? await verifySecret(host, token) : null;
          } catch {
            return;
          }
          if (!verified) return;
          const organizationId = verified.connection.provisioningDomainId;
          const returnedError = ctx.context.returned instanceof Error;
          // A request that changed nothing still retries an organization whose
          // last projection failed, so a missed deprovision repairs itself.
          if (method === "GET" && !failedProjections.has(organizationId)) {
            return;
          }
          if (returnedError && !failedProjections.has(organizationId)) return;
          await projectWithRetry(host, organizationId, verified.connection.id);
        }),
      }],
    },
  };
  return [scimPlugin, projection];
}
