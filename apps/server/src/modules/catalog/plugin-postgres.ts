import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { blobKeyLock } from "../../platform/blob-key-lock.ts";
import { StandardError } from "@bakery/contracts/http";
import {
  parseSdkRange,
  SdkRangeSyntaxError,
} from "@bakery/contracts/plugin-sdk";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";
import { blobObjectKey, SkillFileStoreError } from "./storage-port.ts";
import type { ScopedOrganizationBlobStore } from "./blob-store.ts";
import {
  assertVersionPagesInBundle,
  storedManifestPages,
} from "./plugin-pages.ts";

/**
 * Package and version persistence (#15, B14.01, slice 1).
 *
 * The rule that shapes this file: a version's digest is a check, not a claim.
 * Creating a version reads the bundle out of the object store under its own
 * digest, so a row can only exist for bytes the host has actually seen. A
 * digest that is merely stored would say "this content hashes to X" without
 * anyone having asked.
 *
 * Bundle bytes never enter Postgres. Only the object key and the digest do.
 */

const PACKAGE_COLUMNS = `
  p.id, p.name, p.display_name, p.provenance, p.license, p.visibility,
  p.listing_status, p.created_at, p.updated_at, p.version
`;

const VERSION_COLUMNS = `
  v.id, v.plugin_package_id, v.version_name, v.sdk_range, v.manifest,
  v.bundle_digest, v.source_evidence, v.build_evidence, v.published_at,
  v.created_at, v.updated_at, v.version
`;

type PackageRow = {
  id: string;
  name: string;
  display_name: string;
  provenance: unknown;
  license: string;
  visibility: string;
  listing_status: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type VersionRow = {
  id: string;
  plugin_package_id: string;
  version_name: string;
  sdk_range: string;
  manifest: unknown;
  bundle_digest: string;
  source_evidence: unknown;
  build_evidence: unknown;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type PluginPackage = z.output<typeof contractSchemas.PluginPackage>;
type PluginVersion = z.output<typeof contractSchemas.PluginVersion>;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function toPackage(
  row: PackageRow,
  organizationId: string,
): PluginPackage {
  return {
    id: row.id,
    organizationId,
    name: row.name,
    displayName: row.display_name,
    provenance: row.provenance as PluginPackage["provenance"],
    license: row.license,
    visibility: row.visibility as PluginPackage["visibility"],
    listingStatus: row.listing_status as PluginPackage["listingStatus"],
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    version: row.version,
  };
}

function toVersion(row: VersionRow, organizationId: string): PluginVersion {
  return {
    id: row.id,
    organizationId,
    pluginPackageId: row.plugin_package_id,
    versionName: row.version_name,
    sdkRange: row.sdk_range,
    manifest: row.manifest as PluginVersion["manifest"],
    bundleDigest: row.bundle_digest,
    sourceEvidence: row.source_evidence as PluginVersion["sourceEvidence"],
    buildEvidence: row.build_evidence as PluginVersion["buildEvidence"],
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    version: row.version,
    pages: storedManifestPages(row.manifest).map((page) => ({ ...page })),
  };
}

/**
 * The constraint a unique violation names, walking the `.cause` chain.
 *
 * The driver wraps its error, so the SQLSTATE and the constraint name are not on
 * the thrown value itself. Reading only the top level silently turns every
 * duplicate into a 500.
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
 * Orders packages newest first, tie-breaking on id.
 *
 * The shared cursor primitive carries a `createdAt` position and closes the set
 * of orderings it accepts, so a list that ordered by `updated_at` could not use
 * it without widening that set for every caller. Creation order is also the
 * honest answer for a catalog page: when the package was published.
 */
const PACKAGES_ORDERING = "createdAt:desc,id:desc";

/** Orders versions newest first, tie-breaking on id. */
const VERSIONS_ORDERING = "createdAt:desc,id:desc";

/**
 * A page of packages, with a cursor that is opaque and bound to this query.
 *
 * The cursor used to be the last row's bare id. That is both forgeable and
 * unbound: the id of a package in one page could be replayed against a
 * different organization or filter and re-anchor the page somewhere the caller
 * never saw, and a value that is not a uuid reached a `::uuid` cast and became a
 * 500. It is now signed and bound to the action, the caller, the organization
 * and the ordering, so a foreign or tampered cursor is a 400, and the position
 * travels as an encoded timestamp rather than a value the query casts blindly.
 */
export async function listPluginPackages(
  context: ActionContext,
  search: { cursor?: string; limit?: number },
  secret: string,
): Promise<{ items: PluginPackage[]; nextCursor: string | null }> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const limit = search.limit ?? 25;
  const binding: CursorBinding = {
    action: "pluginPackages.list",
    principalId,
    organizationId,
    ordering: PACKAGES_ORDERING,
    // This list takes no filters, so one constant names the whole surface: a
    // cursor issued for a filtered list could never match it.
    filters: "{}",
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, search.cursor, binding);
  const rows = await transaction.query<
    PackageRow & { cursor_created_at: string }
  >(
    `select ${PACKAGE_COLUMNS}, p.organization_id,
            to_char(
              p.created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) as cursor_created_at
       from bakery.plugin_packages p
      where p.organization_id = $1
        and ($2::timestamptz is null or (p.created_at, p.id) < ($2, $3::uuid))
      order by p.created_at desc, p.id desc
      limit $4`,
    [
      organizationId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const visible = rows.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => toPackage(row, organizationId)),
    nextCursor: rows.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}

export async function getPluginPackage(
  context: ActionContext,
  packageId: string,
): Promise<PluginPackage> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const rows = await transaction.query<PackageRow>(
    `select ${PACKAGE_COLUMNS}
       from bakery.plugin_packages p
      where p.organization_id = $1 and p.id = $2`,
    [organizationId, packageId],
  );
  if (rows.rows.length === 0) {
    // Scoped by organization, so another publisher's package is not found
    // rather than forbidden: a 403 would confirm the record exists.
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_package_not_found" },
    });
  }
  return toPackage(rows.rows[0], organizationId);
}

export async function createPluginPackage(
  context: ActionContext,
  rawInput: unknown,
): Promise<PluginPackage> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const input = rawInput as z.output<
    typeof contractSchemas.PluginPackageCreate
  >;

  try {
    const rows = await transaction.query<PackageRow>(
      `insert into bakery.plugin_packages
         (organization_id, name, display_name, license, provenance)
       values ($1, $2, $3, $4, $5::jsonb)
       returning ${PACKAGE_COLUMNS.replaceAll("p.", "")}`,
      [
        organizationId,
        input.name,
        input.displayName,
        input.license,
        JSON.stringify(input.provenance),
      ],
    );
    return toPackage(rows.rows[0], organizationId);
  } catch (error) {
    if (
      violatedConstraint(error) === "plugin_packages_organization_name_unique"
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "plugin_package_name_taken" },
      });
    }
    throw error;
  }
}

/**
 * A page of one package's versions, with a cursor bound to that package.
 *
 * The package is part of the cursor's binding, not just the query: a cursor
 * issued while paging one package must not be accepted by another, which is the
 * re-anchoring a bare id allowed across packages as well as organizations.
 */
export async function listPluginVersions(
  context: ActionContext,
  search: { cursor?: string; limit?: number },
  packageId: string,
  secret: string,
): Promise<{ items: PluginVersion[]; nextCursor: string | null }> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const limit = search.limit ?? 25;
  // The package is read first so a version list for an unknown or foreign
  // package is a 404 rather than an empty page, which would read as "this
  // package has no versions" to a caller who cannot see it at all.
  await assertPackageHeld(transaction, organizationId, packageId);
  const binding: CursorBinding = {
    action: "pluginPackages.listVersions",
    principalId,
    organizationId,
    ordering: VERSIONS_ORDERING,
    filters: JSON.stringify({ packageId }),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, search.cursor, binding);

  const rows = await transaction.query<
    VersionRow & { cursor_created_at: string }
  >(
    `select ${VERSION_COLUMNS},
            to_char(
              v.created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) as cursor_created_at
       from bakery.plugin_versions v
      where v.organization_id = $1 and v.plugin_package_id = $2
        and ($3::timestamptz is null or (v.created_at, v.id) < ($3, $4::uuid))
      order by v.created_at desc, v.id desc
      limit $5`,
    [
      organizationId,
      packageId,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const visible = rows.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => toVersion(row, organizationId)),
    nextCursor: rows.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}

async function assertPackageHeld(
  transaction: PgTransactionClient,
  organizationId: string,
  packageId: string,
): Promise<void> {
  const rows = await transaction.query<{ id: string }>(
    `select p.id from bakery.plugin_packages p
      where p.organization_id = $1 and p.id = $2`,
    [organizationId, packageId],
  );
  if (rows.rows.length === 0) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_package_not_found" },
    });
  }
}

export type PluginVersionDependencies = {
  /**
   * The object store the bundle was uploaded to. Absent when the deployment
   * configures no object store, in which case publishing fails closed: a
   * version whose bytes exist nowhere would be a digest nobody could verify.
   */
  bundles?: Pick<ScopedOrganizationBlobStore, "stat" | "read">;
};

/**
 * Publish one immutable version.
 *
 * Three refusals happen before the insert:
 *
 * 1. The bundle object key must be exactly the one this organization's store
 *    derives from the digest. A caller that could name its own key could name
 *    another tenant's, so the key is recomputed here and compared rather than
 *    trusted.
 * 2. The object must exist and its bytes must hash to the declared digest.
 * 3. The SDK range must parse. An unreadable range is refused now because a
 *    range nobody can evaluate is indistinguishable from one that never fits,
 *    and storing it would defer that to activation with worse evidence.
 */
export async function createPluginVersion(
  context: ActionContext,
  rawInput: unknown,
  packageId: string,
  dependencies: PluginVersionDependencies,
): Promise<PluginVersion> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const input = rawInput as z.output<
    typeof contractSchemas.PluginVersionCreate
  >;

  await assertPackageHeld(transaction, organizationId, packageId);
  assertSdkRangeReadable(input.sdkRange);
  // Verifies the object exists and hashes to the declared digest. Its size is
  // deliberately not stored: it is derivable from the object, and a stored copy
  // would be one more number to keep in agreement with the bytes.
  const bundle = await assertBundleHeld(dependencies.bundles, {
    organizationId,
    bundleObjectRef: input.bundleObjectRef,
    bundleDigest: input.bundleDigest,
  });
  // A page is checked against the very bytes just verified, so a version
  // cannot name a page its bundle does not carry.
  await assertVersionPagesInBundle(input.manifest, bundle);

  // The bundle collector deletes bytes while holding this same lock, so a
  // version cannot be published into the window between the collector deciding
  // an object is unshared and the object being deleted.
  await transaction.query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [blobKeyLock(organizationId, input.bundleObjectRef)],
  );

  try {
    const rows = await transaction.query<VersionRow>(
      `insert into bakery.plugin_versions
         (organization_id, plugin_package_id, version_name, sdk_range, manifest,
          bundle_object_ref, bundle_digest, source_evidence, build_evidence,
          published_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, now())
       returning ${VERSION_COLUMNS.replaceAll("v.", "")}`,
      [
        organizationId,
        packageId,
        input.versionName,
        input.sdkRange,
        JSON.stringify(input.manifest),
        input.bundleObjectRef,
        input.bundleDigest,
        JSON.stringify(input.sourceEvidence),
        JSON.stringify(input.buildEvidence),
      ],
    );
    return toVersion(rows.rows[0], organizationId);
  } catch (error) {
    if (
      violatedConstraint(error) ===
        "plugin_versions_package_version_name_unique"
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "plugin_version_name_taken" },
      });
    }
    if (violatedConstraint(error) === "plugin_versions_package_digest_unique") {
      // Two labels for identical bytes would make the digest stop identifying
      // the content, so the second label is refused rather than stored.
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "plugin_version_digest_already_published" },
      });
    }
    throw error;
  }
}

/** Refuse a range the host cannot evaluate, before it is stored. */
function assertSdkRangeReadable(range: string): void {
  try {
    parseSdkRange(range);
  } catch (error) {
    if (error instanceof SdkRangeSyntaxError) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: "plugin_sdk_range_unreadable" },
      });
    }
    throw error;
  }
}

/**
 * Prove the organization holds bytes hashing to `bundleDigest`, and that the
 * ref names those bytes and no others.
 */
async function assertBundleHeld(
  bundles: Pick<ScopedOrganizationBlobStore, "stat" | "read"> | undefined,
  input: {
    organizationId: string;
    bundleObjectRef: string;
    bundleDigest: string;
  },
): Promise<Uint8Array> {
  if (bundles === undefined) {
    throw new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { reason: "plugin_bundle_storage_unavailable" },
    });
  }
  const expectedKey = blobObjectKey(input.organizationId, input.bundleDigest);
  if (input.bundleObjectRef !== expectedKey) {
    // One refusal for "wrong shape" and "someone else's key" alike: the caller
    // supplied a key this organization's store would never produce.
    throw new StandardError({
      code: "VALIDATION_FAILED",
      params: { reason: "plugin_bundle_ref_not_in_scope" },
    });
  }
  const stat = await bundles.stat(input.organizationId, input.bundleDigest);
  if (stat === null) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_bundle_missing" },
    });
  }
  // `read` hashes the bytes and compares both the digest and the size, so a
  // truncated or swapped object is refused here rather than at first use.
  try {
    return await bundles.read(
      input.organizationId,
      input.bundleDigest,
      stat.sizeBytes,
    );
  } catch (error) {
    // A mismatch is the caller's own content disagreeing with the digest it
    // declared, so it is a refusal rather than a server fault. Left unmapped it
    // would surface as a 500, which tells the caller to retry a request that can
    // never succeed.
    if (error instanceof SkillFileStoreError) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: "plugin_bundle_digest_mismatch" },
      });
    }
    throw error;
  }
}
