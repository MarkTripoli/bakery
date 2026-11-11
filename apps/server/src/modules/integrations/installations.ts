import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { GITHUB_PROVIDER_ID, installationActor } from "./postgres.ts";

type Installation = z.output<typeof contractSchemas.IntegrationInstallation>;
type InstallationQuery = z.output<
  typeof contractSchemas.IntegrationInstallationQuery
>;

const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const ORDERING = "createdAt:desc,id:desc";
const DEFAULT_LIMIT = 25;

/**
 * Explicit projection: safe identity, lifecycle and aggregate counts over
 * the live connections of every organization. The account login, the
 * repository selection, any credential and every organization id or
 * resource stay out.
 */
const installationProjection = `select installation.id,
    installation.registration_id as "providerRegistrationId",
    installation.external_authorization_id as "externalAuthorizationId",
    installation.external_account_id as "externalAccountId",
    installation.granted_permissions as "grantedPermissions",
    installation.authorization_revision as "authorizationRevision",
    installation.status,
    to_char(installation.last_checked_at at time zone 'UTC', ${TIMESTAMP})
      as "lastCheckedAt",
    to_char(installation.created_at at time zone 'UTC', ${TIMESTAMP})
      as "createdAt",
    to_char(installation.updated_at at time zone 'UTC', ${TIMESTAMP})
      as "updatedAt",
    installation.version,
    to_char(installation.created_at at time zone 'UTC', ${TIMESTAMP})
      as "cursorCreatedAt",
    coalesce(impact.connections, 0)::integer as "connectionCount",
    coalesce(impact.enabled, 0)::integer as "enabledConnectionCount",
    coalesce(impact.organizations, 0)::integer as "organizationCount"
  from bakery.integration_installations as installation
  left join lateral (
    select count(*) as connections,
      count(*) filter (where connection.status = 'enabled') as enabled,
      count(distinct connection.organization_id) as organizations
      from bakery.integration_connections as connection
     where connection.installation_id = installation.id
       and connection.archived_at is null
  ) as impact on true`;

type InstallationRow = Omit<Installation, "providerId"> & {
  cursorCreatedAt: string;
};

function toInstallation(
  { cursorCreatedAt: _, ...row }: InstallationRow,
): Installation {
  return contractSchemas.IntegrationInstallation.parse({
    ...row,
    providerId: GITHUB_PROVIDER_ID,
  });
}

/**
 * integrationInstallations.get: one host-owned installation, for an
 * installation administrator.
 */
export async function getInstallation(
  context: ActionContext,
  input: z.output<typeof contractSchemas.IdPath>,
): Promise<Installation> {
  const { context: value } = installationActor(context);
  const result = await value.transaction.query<InstallationRow>(
    `${installationProjection} where installation.id = $1`,
    [input.id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return toInstallation(row);
}

/**
 * integrationInstallations.list factory: keyset pages of host-owned
 * installations, newest first, filtered by provider and status, for an
 * installation administrator. Cursors are bound to the caller and filters.
 */
export function createInstallationListHandler(cursorSecret: string) {
  return async (
    context: ActionContext,
    input: InstallationQuery,
  ): Promise<{ items: Installation[]; nextCursor: string | null }> => {
    const { context: value, actor } = installationActor(context);
    const filters = {
      providerId: input.providerId ?? null,
      status: input.status ?? null,
    };
    const binding: CursorBinding = {
      action: Action.IntegrationInstallationsList,
      principalId: actor.subject.principalId,
      ordering: ORDERING,
      filters: await sha256Hex(canonicalJson(filters)),
      schemaVersion: 1,
    };
    const position = await decodeCursor(cursorSecret, input.cursor, binding);
    // Every installation belongs to the one GitHub provider.
    if (
      filters.providerId !== null && filters.providerId !== GITHUB_PROVIDER_ID
    ) {
      return { items: [], nextCursor: null };
    }
    const size = input.limit ?? DEFAULT_LIMIT;
    const result = await value.transaction.query<InstallationRow>(
      `${installationProjection}
        where ($1::text is null or installation.status = $1)
          and ($2::timestamptz is null
            or (installation.created_at, installation.id) < ($2, $3::uuid))
        order by installation.created_at desc, installation.id desc
        limit $4`,
      [
        filters.status,
        position?.createdAt ?? null,
        position?.id ?? null,
        size + 1,
      ],
    );
    const visible = result.rows.slice(0, size);
    const last = visible.at(-1);
    return {
      items: visible.map(toInstallation),
      nextCursor: result.rows.length > size && last !== undefined
        ? await encodeCursor(cursorSecret, binding, {
          createdAt: last.cursorCreatedAt,
          id: last.id,
        })
        : null,
    };
  };
}
