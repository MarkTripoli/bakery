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
import {
  addedCapabilities,
  approvalMatches,
  type InstallReadExtras,
  installReadExtras,
  issueStateCasVersion,
  liveStateRange,
  loadSnapshot,
  restoreSnapshotState,
  snapshotLiveState,
  stateReadableBy,
  type StateSnapshot,
} from "./plugin-install-upgrade.ts";
import { isOrganizationAdministratorRole } from "../auth/application/authorize.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
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

/** One ordering per list, so a cursor cannot be reused against another order. */
const INSTALLS_ORDERING = "createdAt:desc,id:desc";
const STATE_ORDERING = "createdAt:desc,id:desc";

const INSTALL_COLUMNS = `
  i.id, i.plugin_package_id, i.plugin_version_id, i.scope,
  i.owner_principal_id, i.status, i.state_schema_version, i.activated_at,
  i.disabled_at, i.created_at, i.updated_at, i.version, i.last_update_failure
`;

/** The columns of the values-free read: nothing here can carry a saved value. */
const STATE_ITEM_COLUMNS = `
  s.id, s.plugin_install_id, s.owner_principal_id, s.namespace, s.key,
  s.schema_version, s.cas_version, s.created_at, s.updated_at, s.version,
  octet_length(s.value::text) as size_bytes
`;

const STATE_COLUMNS = `
  s.id, s.plugin_install_id, s.owner_principal_id, s.namespace, s.key,
  s.schema_version, s.cas_version, s.value, s.created_at, s.updated_at,
  s.version, octet_length(s.value::text) as size_bytes
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
  last_update_failure: unknown;
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
  size_bytes: number;
};

type PluginInstall = z.output<typeof contractSchemas.PluginInstall>;
type PluginState = z.output<typeof contractSchemas.PluginState>;
type PluginStateItem = z.output<typeof contractSchemas.PluginStateItem>;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function toInstall(
  row: InstallRow,
  organizationId: string,
  extras: InstallReadExtras,
): PluginInstall {
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
    lastUpdateFailure: row.last_update_failure === null ||
        row.last_update_failure === undefined
      ? null
      : row.last_update_failure as PluginInstall["lastUpdateFailure"],
    stateCopy: extras.stateCopy,
    cannotReadVersionIds: extras.cannotReadVersionIds,
  };
}

/** A page of installs as the contract names them, with what each keeps and which versions cannot read it. */
async function toInstalls(
  transaction: PgTransactionClient,
  organizationId: string,
  rows: readonly InstallRow[],
): Promise<PluginInstall[]> {
  const extras = await installReadExtras(transaction, organizationId, rows);
  return rows.map((row) => toInstall(row, organizationId, extras.get(row.id)!));
}

function toStateItem(row: StateRow): PluginStateItem {
  // Built field by field from the row, so a saved value can never ride along.
  return {
    id: row.id,
    pluginInstallId: row.plugin_install_id,
    namespace: row.namespace,
    key: row.key,
    sizeBytes: Number(row.size_bytes),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
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
    sizeBytes: Number(row.size_bytes),
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
/**
 * Restores the grant set a pinned version's manifest declares.
 *
 * Revocation deletes grants, so every path back to `enabled` has to re-derive
 * them from the manifest the install pins. Copying an earlier set would let a
 * grant survive an edit to the version it came from.
 */
async function restoreGrants(
  transaction: PgTransactionClient,
  organizationId: string,
  installId: string,
  versionId: string,
): Promise<void> {
  const version = await transaction.query<{ manifest: unknown }>(
    `select v.manifest
       from bakery.plugin_versions v
      where v.organization_id = $1 and v.id = $2`,
    [organizationId, versionId],
  );
  const versionRow = version.rows[0];
  if (versionRow === undefined) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "plugin_version_not_found" },
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
}

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
      // Not found, not forbidden. A 403 would confirm that a personal install
      // exists and belongs to somebody else, which get and the state routes
      // already refuse to say; answering differently on PATCH would leak it.
      throw new StandardError({
        code: "RESOURCE_NOT_FOUND",
        params: { reason: "plugin_install_not_found" },
      });
    }
    return;
  }
  // An organization install changes what everybody in the organization can use,
  // so it is Admin authority. Developer would let any member widen the surface
  // for the whole organization.
  const role = await liveRole(transaction, organizationId, principalId);
  if (!isOrganizationAdministratorRole(role)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

async function loadInstall(
  transaction: PgTransactionClient,
  organizationId: string,
  installId: string,
  options: { forUpdate?: boolean } = {},
): Promise<InstallRow> {
  // A write takes the row lock, so the state it decides on is the state the
  // previous writer left. Without it a concurrent upgrade reads `enabled`,
  // decides `nextStatus` from that stale value, and silently re-enables an
  // install another request disabled a moment earlier -- losing the grant
  // revocation the disable performed.
  const rows = await transaction.query<InstallRow>(
    `select ${INSTALL_COLUMNS}
       from bakery.plugin_installs i
      where i.organization_id = $1 and i.id = $2
      ${options.forUpdate ? "for update" : ""}`,
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
  secret: string,
): Promise<{ items: PluginInstall[]; nextCursor: string | null }> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const limit = search.limit ?? 25;
  // The cursor is signed and bound to the action, the caller, the organization,
  // the ordering and the filters. A bare id would accept anything uuid-shaped
  // and replay across a different filter, a different caller or another
  // organization, and a non-uuid id would reach Postgres as a 500.
  const binding: CursorBinding = {
    action: "pluginInstalls.list",
    principalId,
    organizationId,
    ordering: INSTALLS_ORDERING,
    // The filters are part of the binding, so a cursor issued for one scope or
    // status can never be replayed against another and skip rows.
    filters: JSON.stringify({
      scope: search.scope ?? null,
      status: search.status ?? null,
    }),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, search.cursor, binding);
  // A personal install is only listed to its owner. The predicate is in the
  // query rather than applied afterwards, so a page size cannot be used to
  // count somebody else's installs.
  const rows = await transaction.query<
    InstallRow & { cursor_created_at: string }
  >(
    `select ${INSTALL_COLUMNS},
            to_char(
              i.created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) as cursor_created_at
       from bakery.plugin_installs i
      where i.organization_id = $1
        and (i.scope = 'organization' or i.owner_principal_id = $2)
        and ($3::text is null or i.scope = $3)
        and ($4::text is null or i.status = $4)
        and ($5::timestamptz is null or (i.created_at, i.id) < ($5, $6::uuid))
      order by i.created_at desc, i.id desc
      limit $7`,
    [
      organizationId,
      principalId,
      search.scope ?? null,
      search.status ?? null,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const visible = rows.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: await toInstalls(transaction, organizationId, visible),
    nextCursor: rows.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
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
  return (await toInstalls(transaction, organizationId, [row]))[0];
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

  // The version must belong to this package and this organization, be
  // published, and belong to a package that is not withdrawn. The composite key
  // on the row is the real guarantee of ownership; these predicates are what
  // stop an install granting the capabilities of a draft nobody released, or of
  // a package the publisher has since withdrawn.
  const version = await transaction.query<{
    id: string;
    manifest: unknown;
    sdk_range: string;
  }>(
    `select v.id, v.manifest, v.sdk_range
       from bakery.plugin_versions v
       join bakery.plugin_packages p
         on p.organization_id = v.organization_id
        and p.id = v.plugin_package_id
      where v.organization_id = $1 and v.plugin_package_id = $2
        and v.id = $3
        and v.published_at is not null
        and p.listing_status <> 'withdrawn'`,
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

  return (await toInstalls(transaction, organizationId, [installed]))[0];
}

/**
 * Change an install: move it to another version, disable it, or uninstall it.
 *
 * Disabling and uninstalling revoke the grants in the same transaction, which is
 * AC3: authority stops with the lifecycle change rather than at the next sweep.
 * Retained state is untouched, because uninstall retains data under policy and
 * deletion is a separate decision.
 *
 * Moving to another version (#34) is staged, then activated in this one
 * transaction, and it happens only when all of these hold; the first that does
 * not is recorded as the reason and the install stays on its version with its
 * state:
 *
 * - the version is published, runs on this host's SDK and has a valid manifest;
 * - every capability it asks for beyond the pinned version's was approved by the
 *   caller in this request, and nothing else was;
 * - it can read the state the install holds, or, for a rollback the caller asked
 *   to restore, the snapshot taken as the install left that version can.
 *
 * The install row is locked for the whole request, and so is every state write,
 * so state cannot change between the check and the move.
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
  const row = await loadInstall(transaction, organizationId, installId, {
    forUpdate: true,
  });
  await assertMayManageInstall(
    transaction,
    organizationId,
    principalId,
    row.scope,
    row.owner_principal_id,
  );

  const nextStatus = input.status ?? row.status;
  const approved = input.approveCapabilities ?? [];
  const restoreState = input.restoreState === true;
  // An approval or a restore is about a move to another version. Sent with none,
  // the caller believes something happened that cannot, and an error says so
  // where a quiet success would not.
  if (
    (approved.length > 0 || restoreState) &&
    (input.versionId === undefined || input.versionId === row.plugin_version_id)
  ) {
    throw new StandardError({
      code: "VALIDATION_FAILED",
      params: { reason: "plugin_update_fields_need_another_version" },
    });
  }
  // A version that does not pass its checks is not switched to: the install
  // keeps running on its prior version and the refusal is noted on it. The rest
  // of the same request (a status change, a dismissal) still applies, so a
  // refused update never swallows a disable and its revocation.
  let refused:
    | {
      versionId: string;
      versionName: string;
      reason: string;
      /** Whether the caller asked for a restore with this try. */
      restoreState: boolean;
      /** Set when the reason is that capabilities were not approved. */
      addedCapabilities?: string[];
    }
    | null = null;
  let nextVersionId = row.plugin_version_id;

  if (
    input.versionId !== undefined && input.versionId !== row.plugin_version_id
  ) {
    // An upgrade pins a different version of the same package and re-checks it.
    // Carrying the old grants forward would let a new version inherit authority
    // its manifest never asked for.
    // Same rule as at install: only a published version of a package that is
    // still available may bring new capabilities, or an upgrade would launder
    // a draft's authority through an existing install.
    const version = await transaction.query<{
      manifest: unknown;
      sdk_range: string;
      version_name: string;
    }>(
      `select v.manifest, v.sdk_range, v.version_name
         from bakery.plugin_versions v
         join bakery.plugin_packages p
           on p.organization_id = v.organization_id
          and p.id = v.plugin_package_id
        where v.organization_id = $1 and v.plugin_package_id = $2
          and v.id = $3
          and v.published_at is not null
          and p.listing_status <> 'withdrawn'`,
      [organizationId, row.plugin_package_id, input.versionId],
    );
    const versionRow = version.rows[0];
    if (versionRow === undefined) {
      throw new StandardError({
        code: "RESOURCE_NOT_FOUND",
        params: { reason: "plugin_version_not_found" },
      });
    }
    // The refusal is recorded on the install and the request is answered as
    // the install itself, not as an error: an error would roll this
    // transaction back and take the record with it.
    let manifest;
    if (!satisfiesSdkRange(versionRow.sdk_range)) {
      refused = {
        versionId: input.versionId,
        versionName: versionRow.version_name,
        reason: "plugin_sdk_incompatible",
        restoreState,
      };
    } else {
      try {
        manifest = parsePluginManifest(versionRow.manifest);
      } catch (error) {
        if (!(error instanceof PluginManifestError)) throw error;
        refused = {
          versionId: input.versionId,
          versionName: versionRow.version_name,
          reason: `plugin_manifest_${error.code.toLowerCase()}`,
          restoreState,
        };
      }
    }

    if (refused === null && manifest !== undefined) {
      const pinned = await pinnedManifest(
        transaction,
        organizationId,
        row.plugin_version_id,
      );
      const added = addedCapabilities(pinned, manifest);
      let restoring: StateSnapshot | null = null;
      const refusal = (
        reason: string,
        extra: { addedCapabilities?: string[] } = {},
      ) => ({
        versionId: input.versionId!,
        versionName: versionRow.version_name,
        reason,
        restoreState,
        ...extra,
      });
      if (!approvalMatches(added, approved)) {
        // A version that asks for more than the pinned one did is a different
        // request for authority, and the answer to it is the caller's, given
        // for exactly the capabilities shown. It is never carried over.
        refused = refusal(
          approved.length === 0
            ? "plugin_capabilities_not_approved"
            : "plugin_capability_approval_mismatch",
          { addedCapabilities: added },
        );
      } else if (restoreState) {
        const snapshot = await loadSnapshot(
          transaction,
          organizationId,
          installId,
        );
        if (snapshot === null || snapshot.fromVersionId !== input.versionId) {
          // The copy is of what one particular version left behind. Applying it
          // under another would be restoring state nobody checked against it.
          refused = refusal("plugin_state_snapshot_not_for_version");
        } else if (!stateReadableBy(snapshot.range, manifest)) {
          refused = refusal("plugin_state_incompatible");
        } else {
          restoring = snapshot;
        }
      } else if (
        !stateReadableBy(
          await liveStateRange(transaction, organizationId, installId),
          manifest,
        )
      ) {
        // The state holds something the version cannot read: a downgrade past a
        // schema change, or an upgrade it never promised to read. Moving anyway
        // would hand it data it would misread and rewrite.
        refused = refusal("plugin_state_incompatible");
      }
      if (refused === null) {
        nextVersionId = input.versionId;
        // The copy of state is taken before anything moves and in this same
        // transaction: if it cannot be made, the move is not made.
        await snapshotLiveState(
          transaction,
          organizationId,
          installId,
          row.plugin_version_id,
          row.state_schema_version,
        );
        if (restoring !== null) {
          await restoreSnapshotState(
            transaction,
            organizationId,
            installId,
            restoring.rows,
          );
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
    }
  }
  const upgraded = nextVersionId !== row.plugin_version_id;

  // An uninstalled row is finished. Reactivating it would resurrect a row the
  // caller was told was gone, and the partial unique index on a live install of
  // the same package and owner would then fire inside this UPDATE as a 500.
  // Any change to an uninstalled row is refused, not just a status change: a
  // version-only PATCH would repoint a finished install at a new version and
  // answer 200, which reads as "this install is live again".
  if (
    row.status === "uninstalled" &&
    (nextStatus !== "uninstalled" || upgraded || refused !== null)
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "plugin_install_uninstalled" },
    });
  }

  // Re-enabling restores exactly the grants the pinned version's manifest
  // declares. Disabling deleted them, so without this an enabled install would
  // sit with no authority at all: the caller asked to turn it back on and every
  // action would silently refuse.
  if (
    row.status !== "enabled" && nextStatus === "enabled" && !upgraded
  ) {
    await restoreGrants(transaction, organizationId, installId, nextVersionId);
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

  // A successful move to another version, or a person dismissing it, clears
  // the note of the last update that did not start.
  // A refusal in this request replaces the older note, and wins over a
  // dismissal of it.
  const clearFailure = upgraded || input.dismissUpdateFailure === true;
  const failureNote = refused === null
    ? null
    : JSON.stringify({ ...refused, at: new Date().toISOString() });
  const rows = await transaction.query<InstallRow>(
    `update bakery.plugin_installs i
        set plugin_version_id = $3,
            status = $4,
            activated_at = case when $4 = 'enabled' then now() else i.activated_at end,
            disabled_at = case when $4 in ('disabled', 'uninstalled') then now() else i.disabled_at end,
            last_update_failure = case
              when $6::jsonb is not null then $6::jsonb
              when $5::boolean then null
              else i.last_update_failure end,
            updated_at = now(),
            version = i.version + 1
      where i.organization_id = $1 and i.id = $2
      returning ${INSTALL_COLUMNS.replaceAll("i.", "")}`,
    [
      organizationId,
      installId,
      nextVersionId,
      nextStatus,
      clearFailure,
      failureNote,
    ],
  );
  return (await toInstalls(transaction, organizationId, [rows.rows[0]]))[0];
}

/** The manifest of the version an install pins now, which the next one is compared with. */
async function pinnedManifest(
  transaction: PgTransactionClient,
  organizationId: string,
  versionId: string,
) {
  const result = await transaction.query<{ manifest: unknown }>(
    `select v.manifest
       from bakery.plugin_versions v
      where v.organization_id = $1 and v.id = $2`,
    [organizationId, versionId],
  );
  try {
    return parsePluginManifest(result.rows[0]?.manifest);
  } catch (error) {
    if (error instanceof PluginManifestError) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: `plugin_manifest_${error.code.toLowerCase()}` },
      });
    }
    throw error;
  }
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
  secret: string,
): Promise<{ items: PluginState[]; nextCursor: string | null }> {
  return await readPluginState(context, search, installId, secret, "values");
}

/**
 * The same read as `listPluginState`, authorized the same way and paged the same
 * way, but selecting no value column at all: what a plugin keeps, how big it is
 * and when it was saved, for a page that never shows the data. The values do not
 * leave the database, so there is nothing for a client to discard.
 */
export async function listPluginStateItems(
  context: ActionContext,
  search: { cursor?: string; limit?: number },
  installId: string,
  secret: string,
): Promise<{ items: PluginStateItem[]; nextCursor: string | null }> {
  return await readPluginState(context, search, installId, secret, "items");
}

async function readPluginState<Mode extends "values" | "items">(
  context: ActionContext,
  search: { cursor?: string; limit?: number },
  installId: string,
  secret: string,
  mode: Mode,
): Promise<
  {
    items: (Mode extends "values" ? PluginState : PluginStateItem)[];
    nextCursor: string | null;
  }
> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const limit = search.limit ?? 25;
  const install = await loadInstall(transaction, organizationId, installId);
  // Reading state requires the same authority as seeing the install at all, and
  // the owner check comes first: a status check before it would answer 409 for
  // a disabled install someone else owns, which confirms both that it exists
  // and how it is configured.
  if (
    install.scope === "personal" && install.owner_principal_id !== principalId
  ) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_install_not_found" },
    });
  }
  const owner = stateOwnerFor(install);
  // Bound to the install as well as the caller: replaying a cursor across two
  // installs would page over another install's rows.
  const binding: CursorBinding = {
    // One binding per read, so a cursor from one cannot page the other.
    action: mode === "values" ? "pluginState.list" : "pluginStateItems.list",
    principalId,
    organizationId,
    ordering: STATE_ORDERING,
    filters: JSON.stringify({ installId, owner: owner ?? null }),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, search.cursor, binding);
  const rows = await transaction.query<
    StateRow & { cursor_created_at: string }
  >(
    `select ${mode === "values" ? STATE_COLUMNS : STATE_ITEM_COLUMNS},
            to_char(
              s.created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) as cursor_created_at
       from bakery.plugin_state s
      where s.organization_id = $1 and s.plugin_install_id = $2
        and s.owner_principal_id is not distinct from $3
        and ($4::timestamptz is null or (s.created_at, s.id) < ($4, $5::uuid))
      order by s.created_at desc, s.id desc
      limit $6`,
    [
      organizationId,
      installId,
      owner,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const visible = rows.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) =>
      mode === "values" ? toState(row, organizationId) : toStateItem(row)
    ) as (Mode extends "values" ? PluginState : PluginStateItem)[],
    nextCursor: rows.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
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
/**
 * How many state keys one install may hold for one owner.
 *
 * The value size is capped by the transport schema, but nothing bounded the
 * number of keys: a plugin could add rows until the table was the problem.
 */
const MAX_STATE_KEYS_PER_INSTALL = 256;

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

  // Locked for the same reason as an update: the status this write is allowed
  // on must be the status a concurrent disable left behind, or a state write
  // lands on an install whose authority was revoked a moment earlier.
  const install = await loadInstall(transaction, organizationId, installId, {
    forUpdate: true,
  });
  // The owner check comes first. Checking status here would answer 409 for a
  // disabled personal install belonging to somebody else, which confirms both
  // that it exists and how it is configured; a colleague must get 404 instead.
  if (
    install.scope === "personal" && install.owner_principal_id !== principalId
  ) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_install_not_found" },
    });
  }
  if (install.status !== "enabled") {
    // A disabled or uninstalled install cannot write. State it kept from before
    // is still readable under policy, which is why this refuses the write and
    // not the read.
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: `plugin_install_${install.status}` },
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
    // A new key is the only write that grows the row count, so the cap belongs
    // here: an install that could add keys without limit would let one plugin
    // fill the table, and the value-size cap does not bound the number of rows.
    const counted = await transaction.query<{ count: string }>(
      `select count(*)::text as count
         from bakery.plugin_state
        where organization_id = $1 and plugin_install_id = $2
          and owner_principal_id is not distinct from $3`,
      [organizationId, installId, owner],
    );
    if (Number(counted.rows[0].count) >= MAX_STATE_KEYS_PER_INSTALL) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "plugin_state_key_limit_reached" },
      });
    }
    // The first number of a new key comes from the install's mark, not 1: a
    // restore may have deleted this key at a number a stale writer still holds.
    const casVersion = await issueStateCasVersion(
      transaction,
      organizationId,
      installId,
    );
    const inserted = await transaction.query<StateRow>(
      `insert into bakery.plugin_state
         (organization_id, plugin_install_id, owner_principal_id, namespace, key,
          schema_version, cas_version, value)
       values ($1, $2, $3, $4, $5, $6, $8, $7::jsonb)
       returning ${STATE_COLUMNS.replaceAll("s.", "")}`,
      [
        organizationId,
        installId,
        owner,
        input.namespace,
        input.key,
        input.schemaVersion,
        JSON.stringify(input.value),
        casVersion,
      ],
    );
    return toState(inserted.rows[0], organizationId);
  }

  const nextCas = await issueStateCasVersion(
    transaction,
    organizationId,
    installId,
  );
  const updated = await transaction.query<StateRow>(
    `update bakery.plugin_state s
        set value = $3::jsonb, schema_version = $4,
            cas_version = $6, updated_at = now(),
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
      nextCas,
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
