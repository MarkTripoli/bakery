import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { AuthImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import type { AuthorizedActionContext } from "../../../application/authority.ts";
import { recordAuthAudit } from "../../../application/audit.ts";
import {
  readScimConnection,
  revokeScimConnection,
} from "../../../adapters/scim-postgres.ts";
import {
  createScimConnection,
  rotateScimConnection,
} from "../../../scim/mod.ts";

function authorized(context: ActionContext): AuthorizedActionContext {
  const value = context as Partial<AuthorizedActionContext>;
  if (!value.transaction || !value.principal || !value.authority) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return value as AuthorizedActionContext;
}

function organizationScope(context: AuthorizedActionContext): string {
  const actor = context.authority as { organizationId?: string };
  if (!actor.organizationId) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return actor.organizationId;
}

export function scimConnectionGet(
  context: ActionContext,
  publicBaseUrl: string | undefined,
) {
  const value = authorized(context);
  return readScimConnection(
    value.transaction,
    organizationScope(value),
    publicBaseUrl,
  );
}

/**
 * Creates the connection and audits the change in the same transaction. The
 * secret is returned once
 * and never reaches the audit row.
 */
export async function scimConnectionCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.ScimConnectionCreate>,
  publicBaseUrl: string | undefined,
) {
  const value = authorized(context);
  const organizationId = organizationScope(value);
  const issued = await createScimConnection(value.transaction, {
    organizationId,
    principalId: value.principal.principalId,
    expiresInDays: input.expiresInDays,
  });
  await recordAuthAudit(value.transaction, value, {
    organizationId,
    principalId: value.principal.principalId,
    operation: Action.ScimConnectionCreate,
    resourceType: "scim_connection",
    resourceId: issued.connectionId,
    details: {
      credentialId: issued.credentialId,
      expiresAt: issued.expiresAt.toISOString(),
    },
  });
  return {
    connection: await readScimConnection(
      value.transaction,
      organizationId,
      publicBaseUrl,
    ),
    token: issued.secret,
  };
}

export async function scimConnectionRotate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.ScimConnectionRotate>,
  publicBaseUrl: string | undefined,
) {
  const value = authorized(context);
  const organizationId = organizationScope(value);
  const previousExpireMinutes = input.previousCredentialsExpireInMinutes ?? 0;
  const issued = await rotateScimConnection(value.transaction, {
    organizationId,
    principalId: value.principal.principalId,
    expiresInDays: input.expiresInDays,
    previousExpireMinutes,
  });
  await recordAuthAudit(value.transaction, value, {
    organizationId,
    principalId: value.principal.principalId,
    operation: Action.ScimConnectionRotate,
    resourceType: "scim_connection",
    resourceId: issued.connectionId,
    details: {
      credentialId: issued.credentialId,
      expiresAt: issued.expiresAt.toISOString(),
      previousExpireMinutes,
    },
  });
  return {
    connection: await readScimConnection(
      value.transaction,
      organizationId,
      publicBaseUrl,
    ),
    token: issued.secret,
  };
}

/** Revokes the connection and every credential it holds. */
export async function scimConnectionRevoke(
  context: ActionContext,
  publicBaseUrl: string | undefined,
) {
  const value = authorized(context);
  const organizationId = organizationScope(value);
  const connectionId = await revokeScimConnection(
    value.transaction,
    organizationId,
  );
  if (connectionId !== null) {
    await recordAuthAudit(value.transaction, value, {
      organizationId,
      principalId: value.principal.principalId,
      operation: Action.ScimConnectionRevoke,
      resourceType: "scim_connection",
      resourceId: connectionId,
    });
  }
  return readScimConnection(value.transaction, organizationId, publicBaseUrl);
}
