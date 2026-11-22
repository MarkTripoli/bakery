import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  parsePluginPages,
  PLUGIN_PAGE_LIMITS,
  PluginManifestError,
  type PluginPage,
} from "@bakery/contracts/plugin-sdk";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { sha256Bytes } from "../knowledge/bytes.ts";
import type { ScopedOrganizationBlobStore } from "./blob-store.ts";
import { blobObjectKey, SkillFileStoreError } from "./storage-port.ts";
import { parseGzipUstarArchive, TarArchiveError } from "./tar-archive.ts";

/**
 * A plugin's own pages (#76, FS24): which pages a person has, whether one can
 * be shown, and the document its sealed frame loads.
 *
 * The frame decision. The document is served by its own route, on the
 * application origin, under `Content-Security-Policy: sandbox allow-scripts`.
 * The browser gives a document under that policy an opaque origin however it
 * is reached: framed with or without a `sandbox` attribute, or opened directly
 * in a tab. An opaque origin has no cookies (`document.cookie` throws), no
 * storage, and no access to the Bakery page around it, so the session cookie
 * is unreachable even if the web forgets its own `sandbox` attribute. The
 * `srcdoc` alternative was rejected because a srcdoc frame takes its origin
 * and policy from the embedding page: its isolation would rest entirely on the
 * web adding the attribute, and the plugin's bytes would travel through the
 * application's own memory and JSON.
 *
 * `default-src 'none'` with no `connect-src` closes the network (fetch, XHR,
 * WebSocket, EventSource, beacons, external scripts, images, fonts, frames);
 * inline script and style are the only code a page runs, so a page is one
 * self-contained HTML file. No `allow-forms`, `allow-popups` or
 * `allow-top-navigation` means it cannot submit, open windows or move the
 * Bakery tab. Even if a request did leave, an opaque origin is cross-site to
 * Bakery, so SameSite cookies would not ride on it.
 */

export const PLUGIN_PAGE_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Browser features a plugin page never gets, whatever its frame allows. */
export const PLUGIN_PAGE_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "bluetooth=()",
  "display-capture=()",
  "clipboard-read=()",
  "publickey-credentials-get=()",
].join(", ");

export const PluginPageRefusal = Object.freeze(
  {
    Off: "off",
    Removed: "removed",
    NoSuchPage: "no_such_page",
    NoAccess: "no_access",
    NotGranted: "not_granted",
  } as const,
);
export type PluginPageRefusal =
  typeof PluginPageRefusal[keyof typeof PluginPageRefusal];

type PluginPageAccess = z.output<typeof contractSchemas.PluginPageAccess>;
type PluginPageEntry = z.output<typeof contractSchemas.PluginPageEntry>;
type DocumentQuery = z.output<typeof contractSchemas.PluginPageDocumentQuery>;

export type PluginPageDependencies = {
  /**
   * The store the version bundles live in. Absent when the deployment has no
   * object store, in which case a document read fails closed.
   */
  bundles?: Pick<ScopedOrganizationBlobStore, "stat" | "read">;
};

/** The document read for one page, before the host adds its render inputs. */
export function pluginPageDocumentPath(installId: string, pageId: string) {
  return `/v1/plugin-installs/${installId}/pages/${pageId}/document`;
}

/**
 * The pages a stored manifest declares, or none when it declares them badly.
 *
 * Publishing validates pages, but a version stored before pages existed was
 * never asked; reading one as "no pages" is the fail-closed answer for a
 * sidebar or a version read, which must not 500 on someone else's old row.
 */
export function storedManifestPages(manifest: unknown): readonly PluginPage[] {
  if (manifest === null || typeof manifest !== "object") return [];
  const record = manifest as Record<string, unknown>;
  const capabilities = Array.isArray(record.requestedCapabilities)
    ? record.requestedCapabilities.filter((value): value is string =>
      typeof value === "string"
    )
    : [];
  try {
    return parsePluginPages(record.pages, capabilities);
  } catch (error) {
    if (error instanceof PluginManifestError) return [];
    throw error;
  }
}

/**
 * Refuse a version whose pages are malformed or whose bundle lacks a page file.
 *
 * Runs at publication, so a page that cannot load is caught by the person who
 * built it rather than by everyone who later opens it. Only a manifest that
 * names pages is held to this: a bundle without pages is still opaque bytes.
 */
export async function assertVersionPagesInBundle(
  manifest: unknown,
  bundle: Uint8Array,
): Promise<void> {
  if (
    manifest === null || typeof manifest !== "object" ||
    !("pages" in manifest)
  ) return;
  const record = manifest as Record<string, unknown>;
  const capabilities = Array.isArray(record.requestedCapabilities)
    ? record.requestedCapabilities.filter((value): value is string =>
      typeof value === "string"
    )
    : [];
  let pages: readonly PluginPage[];
  try {
    pages = parsePluginPages(record.pages, capabilities);
  } catch (error) {
    if (error instanceof PluginManifestError) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: `plugin_manifest_${error.code.toLowerCase()}` },
      });
    }
    throw error;
  }
  if (pages.length === 0) return;
  const files = await bundleFiles(bundle).catch((error) => {
    if (error instanceof TarArchiveError) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: "plugin_bundle_not_an_archive" },
      });
    }
    throw error;
  });
  for (const page of pages) {
    const content = files.get(page.file);
    if (content === undefined) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: "plugin_page_file_missing" },
      });
    }
    if (content.byteLength > PLUGIN_PAGE_LIMITS.documentMaxBytes) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: "plugin_page_file_too_large" },
      });
    }
  }
}

/** Every file in a bundle archive by its normalized path. */
async function bundleFiles(bundle: Uint8Array) {
  const inventory = await parseGzipUstarArchive(bundle, undefined, {
    manifestRequired: false,
  });
  return new Map(inventory.files.map((entry) => [entry.path, entry.content]));
}

type PageRow = {
  id: string;
  scope: "organization" | "personal";
  owner_principal_id: string | null;
  status: string;
  plugin_package_id: string;
  plugin_version_id: string;
  version_name: string;
  manifest: unknown;
  bundle_object_ref: string;
  bundle_digest: string;
  display_name: string;
  page_granted: boolean;
};

type Resolved =
  | Readonly<{ kind: "available"; row: PageRow; page: PluginPage }>
  | Readonly<{
    kind: "refused";
    reason: PluginPageRefusal;
    row: PageRow | null;
    page: PluginPage | null;
  }>;

/**
 * The one decision both page reads make, in one order.
 *
 * Not in the caller's organization, absent or uninstalled: removed, the same
 * answer for all three so an id from another tenant reveals nothing. Another
 * person's personal install: no_access, because the address of a private page
 * is shareable and "no longer here" would be false; it confirms only that the
 * id the sharer already gave is real. Then off, then the grant, then the page,
 * so that turning a plugin off always reads as off.
 */
async function resolvePage(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  installId: string,
  pageId: string,
): Promise<Resolved> {
  const rows = await transaction.query<PageRow>(
    `select i.id, i.scope, i.owner_principal_id, i.status,
            i.plugin_package_id, i.plugin_version_id,
            v.version_name, v.manifest, v.bundle_object_ref, v.bundle_digest,
            p.display_name,
            exists (
              select 1 from bakery.plugin_install_grants g
               where g.organization_id = i.organization_id
                 and g.plugin_install_id = i.id
                 and g.capability = 'ui.page'
            ) as page_granted
       from bakery.plugin_installs i
       join bakery.plugin_versions v
         on v.organization_id = i.organization_id
        and v.id = i.plugin_version_id
       join bakery.plugin_packages p
         on p.organization_id = i.organization_id
        and p.id = i.plugin_package_id
      where i.organization_id = $1 and i.id = $2`,
    [organizationId, installId],
  );
  const row = rows.rows[0];
  if (row === undefined || row.status === "uninstalled") {
    return { kind: "refused", reason: "removed", row: null, page: null };
  }
  if (row.scope === "personal" && row.owner_principal_id !== principalId) {
    return { kind: "refused", reason: "no_access", row: null, page: null };
  }
  const page =
    storedManifestPages(row.manifest).find((candidate) =>
      candidate.id === pageId
    ) ?? null;
  if (row.status !== "enabled") {
    return { kind: "refused", reason: "off", row, page };
  }
  if (!row.page_granted) {
    return { kind: "refused", reason: "not_granted", row, page };
  }
  if (page === null) {
    return { kind: "refused", reason: "no_such_page", row, page };
  }
  return { kind: "available", row, page };
}

/** `GET /v1/plugin-installs/{id}/pages/{pageId}`: can this page show now. */
export async function getPluginPage(
  context: ActionContext,
  input: { id: string; pageId: string },
): Promise<PluginPageAccess> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const resolved = await resolvePage(
    transaction,
    organizationId,
    principalId,
    input.id,
    input.pageId,
  );
  const row = resolved.row;
  return {
    installId: input.id,
    pageId: input.pageId,
    status: resolved.kind,
    reason: resolved.kind === "refused" ? resolved.reason : null,
    title: resolved.page?.title ?? null,
    pluginPackageId: row?.plugin_package_id ?? null,
    pluginDisplayName: row?.display_name ?? null,
    pluginVersionId: row?.plugin_version_id ?? null,
    versionName: row?.version_name ?? null,
    scope: row?.scope ?? null,
    documentPath: resolved.kind === "available"
      ? pluginPageDocumentPath(input.id, input.pageId)
      : null,
  };
}

/** The problem a refused document read answers with. */
function documentRefusal(reason: PluginPageRefusal): StandardError {
  // The frame shows whatever this route answers, so a refusal carries no
  // detail beyond its status: the host learns the reason from pluginPages.get,
  // which it asks before it loads the frame and again on focus.
  if (reason === "off") {
    return new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "plugin_install_off" },
    });
  }
  if (reason === "not_granted") {
    return new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return new StandardError({
    code: "RESOURCE_NOT_FOUND",
    params: { reason: "plugin_page_not_found" },
  });
}

/**
 * `GET /v1/plugin-installs/{id}/pages/{pageId}/document`: the page's HTML,
 * sealed. The bytes are the bundle's, unmodified; the render inputs reach the
 * page in its own query string, which it reads from `location.search`.
 */
export async function readPluginPageDocument(
  context: ActionContext,
  input: DocumentQuery,
  dependencies: PluginPageDependencies,
): Promise<Response> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const resolved = await resolvePage(
    transaction,
    organizationId,
    principalId,
    input.id,
    input.pageId,
  );
  if (resolved.kind === "refused") throw documentRefusal(resolved.reason);
  const { row, page } = resolved;
  const bundles = dependencies.bundles;
  if (bundles === undefined) {
    throw new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { reason: "plugin_bundle_storage_unavailable" },
    });
  }
  // The stored ref is recomputed rather than trusted, as at publication: a
  // row naming any other key would be reading bytes this version never had.
  if (
    row.bundle_object_ref !== blobObjectKey(organizationId, row.bundle_digest)
  ) {
    throw documentRefusal("no_such_page");
  }
  const stat = await bundles.stat(organizationId, row.bundle_digest);
  if (stat === null) throw documentRefusal("no_such_page");
  let content: Uint8Array | undefined;
  try {
    const bundle = await bundles.read(
      organizationId,
      row.bundle_digest,
      stat.sizeBytes,
    );
    content = (await bundleFiles(bundle)).get(page.file);
  } catch (error) {
    if (
      error instanceof SkillFileStoreError || error instanceof TarArchiveError
    ) throw documentRefusal("no_such_page");
    throw error;
  }
  if (
    content === undefined ||
    content.byteLength > PLUGIN_PAGE_LIMITS.documentMaxBytes
  ) throw documentRefusal("no_such_page");
  return new Response(new Uint8Array(content), {
    status: 200,
    headers: pluginPageDocumentHeaders({
      locale: input.locale,
      length: content.byteLength,
      digest: await sha256Bytes(content),
    }),
  });
}

/** The headers every plugin page document is served with. */
export function pluginPageDocumentHeaders(options: {
  locale: string;
  length: number;
  digest: string;
}): Headers {
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(options.length),
    "Content-Security-Policy": PLUGIN_PAGE_CONTENT_SECURITY_POLICY,
    "Permissions-Policy": PLUGIN_PAGE_PERMISSIONS_POLICY,
    "Content-Language": options.locale,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "ETag": `"${options.digest}"`,
  });
}

const PAGES_ORDERING = "createdAt:asc,id:asc,position:asc";

type EntryRow = {
  install_id: string;
  scope: "organization" | "personal";
  plugin_package_id: string;
  plugin_version_id: string;
  version_name: string;
  display_name: string;
  manifest: unknown;
  position: number;
  cursor_created_at: string;
};

/**
 * `GET /v1/plugin-pages`: every page the caller has, for the sidebar, in one
 * read. An install counts when it is on, holds ui.page and is visible to the
 * caller; each of its version's pages is one item. The expansion happens in the
 * query so the page size counts pages, and the key is (install created_at,
 * install id, page position) so a page never repeats or vanishes between two
 * cursors.
 */
export async function listPluginPages(
  context: ActionContext,
  search: { cursor?: string; limit?: number },
  secret: string,
): Promise<{ items: PluginPageEntry[]; nextCursor: string | null }> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const limit = search.limit ?? 25;
  const binding: CursorBinding = {
    action: "pluginPages.list",
    principalId,
    organizationId,
    ordering: PAGES_ORDERING,
    filters: JSON.stringify({}),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, search.cursor, binding);
  const rows = await transaction.query<EntryRow>(
    `select i.id as install_id, i.scope, i.plugin_package_id,
            i.plugin_version_id, v.version_name, p.display_name, v.manifest,
            (page.ordinality - 1)::integer as position,
            to_char(
              i.created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) as cursor_created_at
       from bakery.plugin_installs i
       join bakery.plugin_versions v
         on v.organization_id = i.organization_id
        and v.id = i.plugin_version_id
       join bakery.plugin_packages p
         on p.organization_id = i.organization_id
        and p.id = i.plugin_package_id
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(v.manifest -> 'pages') = 'array'
              then v.manifest -> 'pages' else '[]'::jsonb end
       ) with ordinality as page(value, ordinality)
      where i.organization_id = $1
        and i.status = 'enabled'
        and (i.scope = 'organization' or i.owner_principal_id = $2)
        and exists (
          select 1 from bakery.plugin_install_grants g
           where g.organization_id = i.organization_id
             and g.plugin_install_id = i.id
             and g.capability = 'ui.page'
        )
        and (
          $3::timestamptz is null or
          (i.created_at, i.id, page.ordinality - 1) > ($3, $4::uuid, $5::bigint)
        )
      order by i.created_at asc, i.id asc, page.ordinality asc
      limit $6`,
    [
      organizationId,
      principalId,
      position?.createdAt ?? null,
      position?.id ?? null,
      position?.position ?? null,
      limit + 1,
    ],
  );
  const visible = rows.rows.slice(0, limit);
  // Pages are re-validated per version rather than trusted from the JSON: a
  // row whose page list does not validate contributes nothing, as in every
  // other read of stored pages.
  const pagesByVersion = new Map<string, readonly PluginPage[]>();
  const items: PluginPageEntry[] = [];
  for (const row of visible) {
    let pages = pagesByVersion.get(row.plugin_version_id);
    if (pages === undefined) {
      pages = storedManifestPages(row.manifest);
      pagesByVersion.set(row.plugin_version_id, pages);
    }
    const page = pages[row.position];
    if (page === undefined) continue;
    items.push({
      installId: row.install_id,
      pageId: page.id,
      title: page.title,
      pluginPackageId: row.plugin_package_id,
      pluginDisplayName: row.display_name,
      pluginVersionId: row.plugin_version_id,
      versionName: row.version_name,
      scope: row.scope,
      documentPath: pluginPageDocumentPath(row.install_id, page.id),
    });
  }
  const last = visible.at(-1);
  return {
    items,
    nextCursor: rows.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        position: last.position,
        id: last.install_id,
      })
      : null,
  };
}
