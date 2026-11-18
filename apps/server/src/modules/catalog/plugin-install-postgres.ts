import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  assertPluginNamespace,
  assertPluginStateKey,
  parsePluginManifest,
  PluginManifestError,
  satisfiesSdkRange,
} from "@bakery/contracts/plugin-sdk";
import { OrganizationRole } from "../auth/domain/authorization.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";

/**
 * Install, grant and state persistence (#15, B14.01, slice 2).
 *
 * The rule that shapes this file: an install confers exactly the authority its
 * pinned version's manifest declared, and disabling or uninstalling it takes
 * that authority away in the same transaction. Everything else here follows
 * from that.
 *
 * Three consequences worth naming, because each is a place a plausible
 * shortcut would be a security bug:
 *
 * 1. A personal install's owner is the authenticated principal, never a body
 *    field. Accepting an owner id would let one member create an install that
 *    another member's state reads through.
 * 2. An organization install requires Admin, because it affects everybody. A
 *    personal install is a member's own business and requires only membership.
 * 3. State reads are scoped by the install's own scope: a private install's
 *    rows are visible to their owner, a shared install's rows to the
 *    organization. A caller cannot widen that by supplying a namespace.
 */

const INSTALL_COLUMNS = `
  i.id, i.plugin_package_id, i.plugin_version_id, i.scope,
  i.owner_principal_id, i.status, i.state_schema_version, i.activated_at,
  i.disabled_at, i.created_at, i.updated_at, i.version
`;

const STATE_COLUMNS = `
  s.id, s.plugin_install_id, s.owner_principal_id, s.namespace, s.key,
  s.schema_version, s.cas_version, s.value, s.created_at, s.updated_at,
  s.version
`;

type InstallRow = {
  id: string;
  plugin_package_id: string;
  plugin_version_id: string;
  scope: string;
  owner_principal_id: string | null;
  status: string;
  state_schema_version: number;
  activated_at: Date | string | null;
  disabled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type StateRow = {
  id: string;
  plugin_install_id: string;
  owner_principal_id: string | null;
  namespace: string;
  key: string;
  schema_version: number;
  cas_version: number;
  value: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type PluginInstall = z.output<typeof contractSchemas.PluginInstall>;
type PluginState = z.output<typeof contractSchemas.PluginState>;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function toInstall(row: InstallRow, organizationId: string): PluginInstall {
  return {
    id: row.id,
    organizationId,
    pluginPackageId: row.plugin_package_id,
    pluginVersionId: row.plugin_version_id,
    scope: row.scope as PluginInstall["scope"],
    ownerPrincipalId: row.owner_principal_id,
    status: row.status as PluginInstall["status"],
    stateSchemaVersion: row.state_schema_version,
    activatedAt: iso(row.activated_at),
    disabledAt: iso(row.disabled_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    version: row.version,
  };
}

function toState(row: StateRow, organizationId: string): PluginState {
  return {
    id: row.id,
    organizationId,
    pluginInstallId: row.plugin_install_id,
    ownerPrincipalId: row.owner_principal_id,
    namespace: row.namespace,
    key: row.key,
    schemaVersion: row.schema_version,
    casVersion: row.cas_version,
    value: row.value as PluginState["value"],
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    version: row.version,
  };
}

/**
 * The constraint a unique violation names, walking the `.cause` chain.
 *
 * The driver wraps its error, so the SQLSTATE and constraint name are not on the
 * thrown value. Reading only the top level turns every duplicate into a 500.
 */
function violatedConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Object; depth++) {
    if (postgresErrorCode(current) === POSTGRES_UNIQUE_VIOLATION) {
      const { constraint } = current as { constraint?: unknown };
      return typeof constraint === "string" ? constraint : null;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The caller's live role in this organization, read in the transaction.
 *
 * Not taken from the token or the context: a role claim is what the caller had
 * when the request began, and this decides whether an install changes something
 * for everybody.
 */
async function liveRole(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<string> {
  const rows = await transaction.query<{ role: string | null; status: string }>(
    `select role, status
       from bakery.organization_memberships
      where organization_id = $1 and principal_id = $2`,
    [organizationId, principalId],
  );
  const row = rows.rows[0];
  if (row === undefined || row.status !== "active" || row.role === null) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return row.role;
}

/** Refuse unless the caller may act on an install of this scope. */
async function assertMayManageInstall(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  scope: string,
  ownerPrincipalId: string | null,
): Promise<void> {
  if (scope === "personal") {
    // A personal install is its owner's. Somebody else may not disable it, read
    // its state or upgrade it, even with Admin: it is that person's own
    // customization, and an admin acting on it would be acting as its owner.
    if (ownerPrincipalId !== principalId) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    return;
  }
  // An organization install changes what everybody in the organization can use,
  // so it is Admin authority. Developer would let any member widen the surface
  // for the whole organization.
  const role = await liveRole(transaction, organizationId, principalId);
  if (role !== OrganizationRole.Admin) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

async function loadInstall(
  transaction: PgTransactionClient,
  organizationId: string,
  installId: string,
): Promise<InstallRow> {
  const rows = await transaction.query<InstallRow>(
    `select ${INSTALL_COLUMNS}
       from bakery.plugin_installs i
      where i.organization_id = $1 and i.id = $2`,
    [organizationId, installId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    // Scoped by organization, so another organization's install is not found
    // rather than forbidden: a 403 would confirm the record exists.
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_install_not_found" },
    });
  }
  return row;
}

export async function listPluginInstalls(
  context: ActionContext,
  search: { scope?: string; status?: string; cursor?: string; limit?: number },
): Promise<{ items: PluginInstall[]; nextCursor: string | null }> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const limit = search.limit ?? 25;
  // A personal install is only listed to its owner. The predicate is in the
  // query rather than applied afterwards, so a page size cannot be used to
  // count somebody else's installs.
  const rows = await transaction.query<InstallRow>(
    `select ${INSTALL_COLUMNS}
       from bakery.plugin_installs i
      where i.organization_id = $1
        and (i.scope = 'organization' or i.owner_principal_id = $2)
        and ($3::text is null or i.scope = $3)
        and ($4::text is null or i.status = $4)
        and ($5::uuid is null or (i.updated_at, i.id) < (
          select b.updated_at, b.id from bakery.plugin_installs b
           where b.organization_id = $1 and b.id = $5
        ))
      order by i.updated_at desc, i.id desc
      limit $6`,
    [
      organizationId,
      principalId,
      search.scope ?? null,
      search.status ?? null,
      search.cursor ?? null,
      limit + 1,
    ],
  );
  const visible = rows.rows.slice(0, limit);
  return {
    items: visible.map((row) => toInstall(row, organizationId)),
    nextCursor: rows.rows.length > limit && visible.length > 0
      ? visible[visible.length - 1].id
      : null,
  };
}

export async function getPluginInstall(
  context: ActionContext,
  installId: string,
): Promise<PluginInstall> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const row = await loadInstall(transaction, organizationId, installId);
  if (row.scope === "personal" && row.owner_principal_id !== principalId) {
    // Same refusal as a missing row: the caller learns nothing about whether a
    // colleague has this plugin installed.
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_install_not_found" },
    });
  }
  return toInstall(row, organizationId);
}

/**
 * Install one version of one package.
 *
 * The order of refusals is the point. The version is read first, because the
 * manifest decides what may be granted; the SDK range is checked before any row
 * is written, because an install that cannot be activated should not exist in a
 * staged state a reader might mistake for progress.
 */
export async function createPluginInstall(
  context: ActionContext,
  rawInput: unknown,
): Promise<PluginInstall> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as z.output<
    typeof contractSchemas.PluginInstallCreate
  >;

  // The owner comes from the session for a personal install and must be absent
  // for an organization one. A body field naming an owner is refused rather
  // than ignored: accepting it silently would create an install whose owner the
  // caller did not choose.
  if (input.scope === "personal") {
    if (
      input.ownerPrincipalId !== undefined &&
      input.ownerPrincipalId !== principalId
    ) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: "plugin_install_owner_not_self" },
      });
    }
  } else if (input.ownerPrincipalId !== undefined) {
    throw new StandardError({
      code: "VALIDATION_FAILED",
      params: { reason: "plugin_install_organization_has_no_owner" },
    });
  }
  const ownerPrincipalId = input.scope === "personal" ? principalId : null;
  await assertMayManageInstall(
    transaction,
    organizationId,
    principalId,
    input.scope,
    ownerPrincipalId,
  );

  // The version must belong to this package and this organization. The
  // composite key on the row is the real guarantee; this read is what produces
  // a named refusal instead of a foreign-key error.
  const version = await transaction.query<{
    id: string;
    manifest: unknown;
    sdk_range: string;
  }>(
    `select v.id, v.manifest, v.sdk_range
       from bakery.plugin_versions v
      where v.organization_id = $1 and v.plugin_package_id = $2
        and v.id = $3`,
    [organizationId, input.packageId, input.versionId],
  );
  const versionRow = version.rows[0];
  if (versionRow === undefined) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_version_not_found" },
    });
  }

  // AC2: an incompatible SDK fails activation here, before a row exists.
  if (!satisfiesSdkRange(versionRow.sdk_range)) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "plugin_sdk_incompatible" },
    });
  }

  // AC2: a manifest that asks for more than the host grants, or that ships a
  // locale the host owns, fails activation. The manifest was validated when the
  // version was published, and it is validated again here because a version row
  // is not a promise that this reader trusts it.
  let manifest;
  try {
    manifest = parsePluginManifest(versionRow.manifest);
  } catch (error) {
    if (error instanceof PluginManifestError) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: `plugin_manifest_${error.code.toLowerCase()}` },
      });
    }
    throw error;
  }

  let installed: InstallRow;
  try {
    const rows = await transaction.query<InstallRow>(
      `insert into bakery.plugin_installs
         (organization_id, plugin_package_id, plugin_version_id, scope,
          owner_principal_id, status, state_schema_version, activated_at)
       values ($1, $2, $3, $4, $5, 'enabled', $6, now())
       returning ${INSTALL_COLUMNS.replaceAll("i.", "")}`,
      [
        organizationId,
        input.packageId,
        input.versionId,
        input.scope,
        ownerPrincipalId,
        manifest.stateSchemaVersion,
      ],
    );
    installed = rows.rows[0];
  } catch (error) {
    const constraint = violatedConstraint(error);
    if (
      constraint === "plugin_installs_one_organization_per_package_idx" ||
      constraint === "plugin_installs_one_personal_per_package_idx"
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "plugin_install_exists" },
      });
    }
    throw error;
  }

  // The grants are the manifest's, written in the same transaction as the
  // install. A second writer could otherwise leave an enabled install with no
  // grants, which is an install that silently does nothing.
  for (const capability of manifest.requestedCapabilities) {
    await transaction.query(
      `insert into bakery.plugin_install_grants
         (organization_id, plugin_install_id, capability)
       values ($1, $2, $3)
       on conflict (organization_id, plugin_install_id, capability) do nothing`,
      [organizationId, installed.id, capability],
    );
  }

  return toInstall(installed, organizationId);
}

/**
 * Change an install: upgrade it, disable it, or uninstall it.
 *
 * Disabling and uninstalling revoke the grants in the same transaction, which is
 * AC3: authority stops with the lifecycle change rather than at the next sweep.
 * Retained state is untouched, because uninstall retains data under policy and
 * deletion is a separate decision.
 */
export async function updatePluginInstall(
  context: ActionContext,
  rawInput: unknown,
  installId: string,
): Promise<PluginInstall> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as z.output<
    typeof contractSchemas.PluginInstallUpdate
  >;
  const row = await loadInstall(transaction, organizationId, installId);
  await assertMayManageInstall(
    transaction,
    organizationId,
    principalId,
    row.scope,
    row.owner_principal_id,
  );

  const nextStatus = input.status ?? row.status;
  const nextVersionId = input.versionId ?? row.plugin_version_id;

  if (
    input.versionId !== undefined && input.versionId !== row.plugin_version_id
  ) {
    // An upgrade pins a different version of the same package and re-checks it.
    // Carrying the old grants forward would let a new version inherit authority
    // its manifest never asked for.
    const version = await transaction.query<{
      manifest: unknown;
      sdk_range: string;
    }>(
      `select v.manifest, v.sdk_range
         from bakery.plugin_versions v
        where v.organization_id = $1 and v.plugin_package_id = $2
          and v.id = $3`,
      [organizationId, row.plugin_package_id, input.versionId],
    );
    const versionRow = version.rows[0];
    if (versionRow === undefined) {
      throw new StandardError({
        code: "RESOURCE_NOT_FOUND",
        params: { reason: "plugin_version_not_found" },
      });
    }
    if (!satisfiesSdkRange(versionRow.sdk_range)) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "plugin_sdk_incompatible" },
      });
    }
    let manifest;
    try {
      manifest = parsePluginManifest(versionRow.manifest);
    } catch (error) {
      if (error instanceof PluginManifestError) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: `plugin_manifest_${error.code.toLowerCase()}` },
        });
      }
      throw error;
    }

    // Replace the grant set rather than adding to it: the install's authority
    // is the new version's manifest, not the union with the old one.
    await transaction.query(
      `delete from bakery.plugin_install_grants
        where organization_id = $1 and plugin_install_id = $2`,
      [organizationId, installId],
    );
    for (const capability of manifest.requestedCapabilities) {
      await transaction.query(
        `insert into bakery.plugin_install_grants
           (organization_id, plugin_install_id, capability)
         values ($1, $2, $3)`,
        [organizationId, installId, capability],
      );
    }
    await transaction.query(
      `update bakery.plugin_installs
          set state_schema_version = $3
        where organization_id = $1 and id = $2`,
      [organizationId, installId, manifest.stateSchemaVersion],
    );
  }

  const revoked = nextStatus === "disabled" || nextStatus === "uninstalled";
  if (revoked) {
    // AC3: revocation happens with the lifecycle change, in this transaction.
    // Waiting for a sweep would leave authority live after the caller was told
    // it was gone.
    await transaction.query(
      `delete from bakery.plugin_install_grants
        where organization_id = $1 and plugin_install_id = $2`,
      [organizationId, installId],
    );
  }

  const rows = await transaction.query<InstallRow>(
    `update bakery.plugin_installs i
        set plugin_version_id = $3,
            status = $4,
            activated_at = case when $4 = 'enabled' then now() else i.activated_at end,
            disabled_at = case when $4 in ('disabled', 'uninstalled') then now() else i.disabled_at end,
            updated_at = now(),
            version = i.version + 1
      where i.organization_id = $1 and i.id = $2
      returning ${INSTALL_COLUMNS.replaceAll("i.", "")}`,
    [organizationId, installId, nextVersionId, nextStatus],
  );
  return toInstall(rows.rows[0], organizationId);
}

/**
 * The owner a state row belongs to, or null for shared state.
 *
 * A personal install's state is always private to its owner. A shared install's
 * state is shared: it belongs to the organization, not to whoever wrote it, so
 * the owner column stays null and every member reads the same row.
 */
function stateOwnerFor(install: InstallRow): string | null {
  return install.scope === "personal" ? install.owner_principal_id : null;
}

export async function listPluginState(
  context: ActionContext,
  search: { cursor?: string; limit?: number },
  installId: string,
): Promise<{ items: PluginState[]; nextCursor: string | null }> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const limit = search.limit ?? 25;
  const install = await loadInstall(transaction, organizationId, installId);
  // Reading state requires the same authority as seeing the install at all.
  if (
    install.scope === "personal" && install.owner_principal_id !== principalId
  ) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_install_not_found" },
    });
  }
  const owner = stateOwnerFor(install);
  const rows = await transaction.query<StateRow>(
    `select ${STATE_COLUMNS}
       from bakery.plugin_state s
      where s.organization_id = $1 and s.plugin_install_id = $2
        and s.owner_principal_id is not distinct from $3
        and ($4::uuid is null or (s.updated_at, s.id) < (
          select b.updated_at, b.id from bakery.plugin_state b
           where b.organization_id = $1 and b.id = $4
        ))
      order by s.updated_at desc, s.id desc
      limit $5`,
    [organizationId, installId, owner, search.cursor ?? null, limit + 1],
  );
  const visible = rows.rows.slice(0, limit);
  return {
    items: visible.map((row) => toState(row, organizationId)),
    nextCursor: rows.rows.length > limit && visible.length > 0
      ? visible[visible.length - 1].id
      : null,
  };
}

/**
 * Write one namespaced key, guarded by compare-and-set.
 *
 * The namespace must be one the manifest declared. Without that check a plugin
 * could use the state table as an unbounded key-value store under names nobody
 * reviewed, and the install's declared namespaces would be decoration.
 */
export async function putPluginState(
  context: ActionContext,
  rawInput: unknown,
  installId: string,
): Promise<PluginState> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as z.output<typeof contractSchemas.PluginStatePut>;

  // The namespace and key arrive as route segments and input fields; the router
  // refuses a disagreement, so reading them here is reading what was validated.
  try {
    assertPluginNamespace(input.namespace);
    assertPluginStateKey(input.key);
  } catch {
    throw new StandardError({
      code: "VALIDATION_FAILED",
      params: { reason: "plugin_state_name_invalid" },
    });
  }

  const install = await loadInstall(transaction, organizationId, installId);
  if (install.status !== "enabled") {
    // A disabled or uninstalled install cannot write. State it kept from before
    // is still readable under policy, which is why this refuses the write and
    // not the read.
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: `plugin_install_${install.status}` },
    });
  }
  if (
    install.scope === "personal" && install.owner_principal_id !== principalId
  ) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_install_not_found" },
    });
  }

  // The declared namespaces come from the pinned version's manifest, so a
  // namespace added in a newer version is not writable until that version is
  // installed.
  const version = await transaction.query<{ manifest: unknown }>(
    `select v.manifest from bakery.plugin_versions v
      where v.organization_id = $1 and v.id = $2`,
    [organizationId, install.plugin_version_id],
  );
  let manifest;
  try {
    manifest = parsePluginManifest(version.rows[0]?.manifest);
  } catch (error) {
    if (error instanceof PluginManifestError) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: `plugin_manifest_${error.code.toLowerCase()}` },
      });
    }
    throw error;
  }
  if (
    manifest.stateNamespaces.length > 0 &&
    !manifest.stateNamespaces.includes(input.namespace)
  ) {
    throw new StandardError({
      code: "VALIDATION_FAILED",
      params: { reason: "plugin_state_namespace_not_declared" },
    });
  }
  if (input.schemaVersion !== manifest.stateSchemaVersion) {
    throw new StandardError({
      code: "VALIDATION_FAILED",
      params: { reason: "plugin_state_schema_version_mismatch" },
    });
  }

  const owner = stateOwnerFor(install);
  const existing = await transaction.query<StateRow>(
    `select ${STATE_COLUMNS}
       from bakery.plugin_state s
      where s.organization_id = $1 and s.plugin_install_id = $2
        and s.owner_principal_id is not distinct from $3
        and s.namespace = $4 and s.key = $5
      for update`,
    [organizationId, installId, owner, input.namespace, input.key],
  );
  const current = existing.rows[0];
  const currentCas = current?.cas_version ?? 0;
  // The CAS is the whole point of the route: two writers who both read version
  // N must not both succeed, or one silently loses its change.
  if (input.expectedCasVersion !== currentCas) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "plugin_state_stale" },
    });
  }

  if (current === undefined) {
    const inserted = await transaction.query<StateRow>(
      `insert into bakery.plugin_state
         (organization_id, plugin_install_id, owner_principal_id, namespace, key,
          schema_version, cas_version, value)
       values ($1, $2, $3, $4, $5, $6, 1, $7::jsonb)
       returning ${STATE_COLUMNS.replaceAll("s.", "")}`,
      [
        organizationId,
        installId,
        owner,
        input.namespace,
        input.key,
        input.schemaVersion,
        JSON.stringify(input.value),
      ],
    );
    return toState(inserted.rows[0], organizationId);
  }

  const updated = await transaction.query<StateRow>(
    `update bakery.plugin_state s
        set value = $3::jsonb, schema_version = $4,
            cas_version = s.cas_version + 1, updated_at = now(),
            version = s.version + 1
      where s.organization_id = $1 and s.id = $2
        and s.cas_version = $5
      returning ${STATE_COLUMNS.replaceAll("s.", "")}`,
    [
      organizationId,
      current.id,
      JSON.stringify(input.value),
      input.schemaVersion,
      input.expectedCasVersion,
    ],
  );
  if (updated.rows.length !== 1) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "plugin_state_stale" },
    });
  }
  return toState(updated.rows[0], organizationId);
}
