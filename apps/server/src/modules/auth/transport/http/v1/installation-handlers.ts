import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas, PrincipalType } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { OrganizationCreationPolicy } from "@bakery/contracts/installation-settings";
import type {
  AuthorizedActionContext,
  InstallationActor,
} from "../../../application/authority.ts";
import type { InstallationSettingsReader } from "../../../application/installation-settings.ts";
import {
  readInstallationSettings,
  requireLiveInstallationAdministrator,
  updateInstallationSettings,
} from "../../../adapters/installation-settings-postgres.ts";
import {
  createInstallationAdministrator,
  listInstallationAdministrators,
  revokeInstallationAdministrator,
} from "../../../adapters/installation-administrators-postgres.ts";
import { listAuditEvents } from "../../../adapters/audit-events-postgres.ts";
import { readAuditRetention } from "../../../adapters/audit-retention-postgres.ts";
import { AuthImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { recordAuthAudit } from "../../../application/audit.ts";
import { exportAuditEvents, updateAuditRetention } from "../../../audit/mod.ts";

function authorized(context: ActionContext): AuthorizedActionContext {
  const value = context as Partial<AuthorizedActionContext>;
  if (!value.transaction || !value.principal || !value.authority) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return value as AuthorizedActionContext;
}

function installationActor(
  context: AuthorizedActionContext,
): InstallationActor {
  const actor = context.authority as Partial<InstallationActor>;
  if (
    actor.installationAdministrator !== true || !actor.subject ||
    actor.subject.principalId !== context.principal.principalId ||
    actor.subject.principalType !== PrincipalType.Human
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return actor as InstallationActor;
}

/** Installation-level audit row: no organization, the acting administrator as principal. */
function audit(
  context: AuthorizedActionContext,
  actor: InstallationActor,
  record: {
    operation: string;
    resourceType: string;
    resourceId: string;
    details?: Readonly<Record<string, unknown>>;
  },
) {
  return recordAuthAudit(context.transaction, context, {
    organizationId: null,
    principalId: actor.subject.principalId,
    ...record,
  });
}

function expectedVersion(context: ActionContext): number {
  const version = requireCommandMetadata(context).expectedVersion;
  if (version === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return version;
}

export async function installationCapabilities(
  reader: InstallationSettingsReader,
) {
  const settings = await reader.current();
  return {
    registration: settings.registrationMode,
    organizationCreation: settings.organizationCreationPolicy,
    ssoAvailable: false,
  };
}

export async function authorizeOrganizationCreation(context: ActionContext) {
  const value = authorized(context);
  if (value.principal.principalType !== PrincipalType.Human) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const settings = await readInstallationSettings(value.transaction);
  if (
    settings.organizationCreationPolicy !== OrganizationCreationPolicy.AnyUser
  ) {
    await requireLiveInstallationAdministrator(
      value.transaction,
      value.principal,
    );
  }
}

export function installationSettingsGet(context: ActionContext) {
  const value = authorized(context);
  installationActor(value);
  return readInstallationSettings(value.transaction);
}

export async function installationSettingsUpdate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.InstallationSettingsUpdate>,
) {
  const value = authorized(context);
  const actor = installationActor(value);
  const updated = await updateInstallationSettings(
    value.transaction,
    input,
    expectedVersion(context),
    actor.subject.principalId,
  );
  await audit(value, actor, {
    operation: Action.InstallationSettingsUpdate,
    resourceType: "installation_settings",
    resourceId: "installation",
    details: {
      registrationMode: updated.registrationMode,
      organizationCreationPolicy: updated.organizationCreationPolicy,
      version: updated.version,
    },
  });
  return updated;
}

export function installationAdministratorsList(
  context: ActionContext,
  input: z.output<typeof contractSchemas.CursorQuery>,
  secret: string,
) {
  const value = authorized(context);
  return listInstallationAdministrators(
    value.transaction,
    installationActor(value),
    input,
    secret,
  );
}

export async function installationAdministratorsCreate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.InstallationAdministratorCreate>,
) {
  const value = authorized(context);
  const actor = installationActor(value);
  const created = await createInstallationAdministrator(
    value.transaction,
    actor,
    input.principalId,
  );
  await audit(value, actor, {
    operation: Action.InstallationAdministratorsCreate,
    resourceType: "installation_administrator",
    resourceId: created.principalId,
  });
  return created;
}

export async function installationAdministratorsRevoke(
  context: ActionContext,
) {
  const value = authorized(context);
  const actor = installationActor(value);
  const revoked = await revokeInstallationAdministrator(
    value.transaction,
    actor,
    value.params.id,
    expectedVersion(context),
  );
  await audit(value, actor, {
    operation: Action.InstallationAdministratorsRevoke,
    resourceType: "installation_administrator",
    resourceId: revoked.principalId,
  });
  return revoked;
}

export function installationAuditEventsList(
  context: ActionContext,
  input: z.output<typeof contractSchemas.AuditQuery>,
  secret: string,
) {
  const value = authorized(context);
  const actor = installationActor(value);
  return listAuditEvents(value.transaction, {
    action: Action.InstallationAuditEventsList,
    principalId: actor.subject.principalId,
    scope: { kind: "installation" },
    query: input,
    secret,
  });
}

/** Organization the registry resolved for this action; refuses a context without one. */
function organizationScope(context: AuthorizedActionContext): string {
  const actor = context.authority as { organizationId?: string };
  if (!actor.organizationId) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return actor.organizationId;
}

export function auditEventsList(
  context: ActionContext,
  input: z.output<typeof contractSchemas.AuditQuery>,
  secret: string,
) {
  const value = authorized(context);
  return listAuditEvents(value.transaction, {
    action: Action.AuditEventsList,
    principalId: value.principal.principalId,
    scope: { kind: "organization", organizationId: organizationScope(value) },
    query: input,
    secret,
  });
}

/** Audit export. Bulk reads of the trail are themselves audited (window and count only). */
export async function auditEventsExport(
  context: ActionContext,
  input: z.output<typeof contractSchemas.AuditExportQuery>,
) {
  const value = authorized(context);
  const organizationId = organizationScope(value);
  const exported = await exportAuditEvents(value.transaction, {
    organizationId,
    query: input,
  });
  await recordAuthAudit(value.transaction, value, {
    organizationId,
    principalId: value.principal.principalId,
    operation: Action.AuditEventsExport,
    resourceType: "audit_events",
    resourceId: organizationId,
    details: {
      since: input.since,
      until: input.until ?? null,
      lineCount: exported.lineCount,
      truncated: exported.truncated,
    },
  });
  return exported;
}

export function auditRetentionGet(context: ActionContext) {
  const value = authorized(context);
  return readAuditRetention(value.transaction, organizationScope(value));
}

/** Retention change, recorded with its audit row in the same transaction. */
export async function auditRetentionUpdate(
  context: ActionContext,
  input: z.output<typeof contractSchemas.AuditRetentionUpdate>,
) {
  const value = authorized(context);
  const organizationId = organizationScope(value);
  const updated = await updateAuditRetention(value.transaction, {
    organizationId,
    principalId: value.principal.principalId,
    retentionDays: input.retentionDays,
  });
  await recordAuthAudit(value.transaction, value, {
    organizationId,
    principalId: value.principal.principalId,
    operation: Action.AuditRetentionUpdate,
    resourceType: "audit_retention",
    resourceId: organizationId,
    details: {
      retentionDays: updated.retentionDays,
      version: updated.version,
    },
  });
  return updated;
}
