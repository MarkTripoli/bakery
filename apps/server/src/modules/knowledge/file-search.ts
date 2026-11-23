import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { decodeCursor, encodeCursor } from "../../platform/cursor.ts";
import type { CursorBinding } from "../../platform/cursor.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  parseStoragePath,
  resolveStoragePath,
  StorageNameError,
  storageQueryOf,
} from "./storage-tree.ts";
import { deniedEntriesCte } from "./folder-access-store.ts";
import { hiddenEntryIds, reviewerIsolationOf } from "./reviewer-isolation.ts";

/**
 * File search and the read-only library mirror (chapter 25 section 17, #453).
 *
 * `files.search` looks across two things with one keyset page: the organization's
 * file tree (entries that point at artifacts) and the library mirror. The mirror
 * is computed on read from the catalog tables and never stored, so it is always
 * current, has no write path and cannot drift: `/library/<section>/<slug>`.
 *
 * What a caller may see is bounded three ways, all applied here:
 * - the organization, in every query;
 * - the route's own permission (reading files), plus `library:read` for library
 *   items, so reading files never reveals the library;
 * - an agent session's scopes: `artifacts.read` for files, `library.read` for
 *   library items, which can only narrow.
 * Nothing is counted or listed that the caller cannot open, so a result never
 * reveals that a hidden item exists.
 */

type FileSearchInput = z.output<typeof contractSchemas.FileSearchQuery>;

const PAGE_ORDERING = "createdAt:desc,id:desc";

/** A friendly group for a media type, as SQL over a column. */
const MEDIA_GROUP_SQL = `case
  when v.media_type is null then null
  when v.media_type in ('application/json', 'text/csv', 'application/x-ndjson',
    'application/yaml', 'application/x-yaml', 'text/yaml', 'application/xml',
    'text/xml') then 'data'
  when v.media_type in ('application/zip', 'application/gzip',
    'application/x-gzip', 'application/x-tar') then 'archive'
  when v.media_type like 'image/%' then 'image'
  when v.media_type like 'video/%' then 'video'
  when v.media_type like 'audio/%' then 'audio'
  when v.media_type like 'text/%' then 'text'
  else 'other' end`;

type HitRow = {
  source: "files" | "library";
  entry_id: string | null;
  item_id: string | null;
  sort_id: string;
  name: string;
  kind: string;
  media_type: string | null;
  size_bytes: number | null;
  version_id: string | null;
  producer_id: string | null;
  media_group: string | null;
  producer_kind: "person" | "step" | "agent" | null;
  producer_name: string | null;
  producer_task_id: string | null;
  producer_task_title: string | null;
  producer_step_id: string | null;
  producer_run_id: string | null;
  producer_attempt_id: string | null;
  producer_session_id: string | null;
  producer_agent_name: string | null;
  producer_acting_for_id: string | null;
  producer_acting_for_name: string | null;
  library_path: string | null;
  created_at: Date | string;
  cursor_created_at: string;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/** Where the first case-insensitive match of `query` sits in `name`, if exact. */
export function nameMatch(
  name: string,
  query: string | undefined,
): { start: number; length: number } | null {
  if (!query) return null;
  const folded = name.toLowerCase();
  const needle = query.normalize("NFC").toLowerCase();
  // Lowercasing can change a string's length (an eastern European dotted I, for
  // one); then positions in the folded text are not positions in the name.
  if (folded.length !== name.length) return null;
  const start = folded.indexOf(needle);
  return start < 0 ? null : { start, length: needle.length };
}

/**
 * The catalog tables the mirror shows, one per section, in listing order. A row
 * appears only when it is published: enabled, and for a workflow with a version
 * in use, and for a package listed. The section's folder name is `section`; the
 * item's file name is its `slug`.
 */
export const LIBRARY_SOURCES = Object.freeze(
  [
    {
      kind: "skill",
      section: "skills",
      table: "bakery.skills",
      name: "name",
      slug: "slug",
      where: "and x.enabled",
    },
    {
      kind: "agent",
      section: "agents",
      table: "bakery.agent_definitions",
      name: "name",
      slug: "slug",
      where: "and x.enabled",
    },
    {
      kind: "workflow",
      section: "workflows",
      table: "bakery.workflow_definitions",
      name: "name",
      slug: "slug",
      where: "and x.enabled and x.active_version_id is not null",
    },
    {
      kind: "kind",
      section: "kinds",
      table: "bakery.artifact_kinds",
      name: "key",
      slug: "key",
      where: "",
    },
    {
      kind: "package",
      section: "packages",
      table: "bakery.plugin_packages",
      name: "display_name",
      slug: "name",
      where: "and x.listing_status = 'listed'",
    },
  ] as const,
);

/**
 * What of a section the caller may see beyond `where`: a personal skill belongs
 * to one person and is listed to that person only, never to a colleague, so the
 * mirror (and a search through it) cannot reveal that somebody holds one.
 */
export function visibleToCaller(
  source: { readonly kind: string },
  principalRef: () => string,
): string {
  return source.kind === "skill"
    ? ` and (x.scope <> 'personal' or x.owner_principal_id = ${principalRef()})`
    : "";
}

export const LIBRARY_SECTIONS = Object.freeze(
  LIBRARY_SOURCES.map((source) => source.section),
);

export type LibraryChild = Readonly<{
  type: "folder" | "item";
  /** The catalog item's id; null for a section folder. */
  id: string | null;
  name: string;
  path: string;
  kind: string | null;
  createdAt: string | null;
  /** Keyset position of an item (microsecond creation time and id); null for a folder. */
  position: Readonly<{ createdAt: string; id: string }> | null;
}>;

/** Items of one section a page holds when the caller names no limit. */
export const LIBRARY_PAGE_DEFAULT = 100;

/**
 * Lists the read-only `/library` mirror: with no section, the sections that
 * have at least one published item (never an empty placeholder); with a section,
 * its items by name. Computed from the catalog on every call, so it is always
 * current and has no write path. Returns undefined for a section the mirror does
 * not have. The caller has already shown the principal may read the library.
 */
export async function listLibraryFolder(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    /** Who is asking: a personal skill is listed to its owner only. */
    principalId: string;
    section?: string;
    /** Items to return, oldest first; sections are a short fixed list and ignore it. */
    limit?: number;
    /** Keyset position to continue after, from the last item of the prior page. */
    after?: { createdAt: string; id: string } | null;
  },
): Promise<LibraryChild[] | undefined> {
  if (input.section === undefined) {
    const children: LibraryChild[] = [];
    for (const source of LIBRARY_SOURCES) {
      const found = await transaction.query<{ present: boolean }>(
        `select exists (select 1 from ${source.table} x
                         where x.organization_id = $1 ${source.where}
                         ${
          visibleToCaller(source, () => "$2::uuid")
        }) as present`,
        source.kind === "skill"
          ? [input.organizationId, input.principalId]
          : [input.organizationId],
      );
      if (found.rows[0]?.present) {
        children.push({
          type: "folder",
          id: null,
          name: source.section,
          path: `/library/${source.section}`,
          kind: null,
          createdAt: null,
          position: null,
        });
      }
    }
    return children;
  }
  const source = LIBRARY_SOURCES.find((item) => item.section === input.section);
  if (!source) return undefined;
  const items = await transaction.query<
    {
      id: string;
      name: string;
      slug: string;
      created_at: Date | string;
      cursor_created_at: string;
    }
  >(
    `select x.id, x.${source.name} as name, x.${source.slug} as slug,
            x.created_at,
            to_char(x.created_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
       from ${source.table} x
      where x.organization_id = $1 ${source.where}
        ${visibleToCaller(source, () => "$5::uuid")}
        and ($2::timestamptz is null or (x.created_at, x.id) > ($2::timestamptz, $3::uuid))
      order by x.created_at, x.id
      limit $4`,
    [
      input.organizationId,
      input.after?.createdAt ?? null,
      input.after?.id ?? null,
      input.limit ?? LIBRARY_PAGE_DEFAULT,
      ...(source.kind === "skill" ? [input.principalId] : []),
    ],
  );
  return items.rows.map((row) => ({
    type: "item" as const,
    id: row.id,
    name: row.name,
    path: `/library/${source.section}/${row.slug}`,
    kind: source.kind,
    createdAt: toIso(row.created_at),
    position: { createdAt: row.cursor_created_at, id: row.id },
  }));
}

/**
 * `files.library`: one folder of the read-only `/library` mirror as a keyset
 * page. The route's permission is `library:read`; an agent session also needs
 * the `library.read` scope, and no scope narrows nothing. Only `/library` and
 * `/library/<section>` exist; any other path is not found.
 */
export function createLibraryFolderHandler(secret: string) {
  return async function listLibrary(
    context: ActionContext,
    input: { path?: string; cursor?: string; limit?: number },
  ) {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const scopes = context.sessionScopes;
    if (scopes !== undefined && !scopes.includes("library.read")) {
      throw new StandardError({ code: "SCOPE_REQUIRED" });
    }
    const path = (input.path ?? "/library").replace(/\/+$/, "");
    const match = /^\/library(?:\/([^/]+))?$/.exec(path);
    if (!match) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const section = match[1];
    const binding: CursorBinding = {
      action: "files.library",
      principalId,
      organizationId,
      ordering: "createdAt:asc,id:asc",
      filters: JSON.stringify({ path }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const children = await listLibraryFolder(transaction, {
      organizationId,
      principalId,
      ...(section === undefined ? {} : { section }),
      limit: limit + 1,
      after: position?.createdAt === undefined
        ? null
        : { createdAt: position.createdAt, id: position.id },
    });
    if (children === undefined) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    // The sections are a fixed list of at most five with nothing to continue
    // from, so they come whole whatever the limit.
    const visible = section === undefined ? children : children.slice(0, limit);
    const last = visible.at(-1)?.position;
    const strip = ({ position: _position, ...entry }: LibraryChild) => entry;
    return {
      items: visible.map(strip),
      nextCursor: section !== undefined && children.length > limit && last
        ? await encodeCursor(secret, binding, last)
        : null,
    };
  };
}

export function createFileSearchHandler(
  secret: string,
  authorizeLibraryRead: (context: ActionContext) => boolean,
  /** Whether the caller is an organization Admin: /system is theirs alone. */
  isAdmin: (context: ActionContext) => boolean,
) {
  return async function searchFiles(
    context: ActionContext,
    input: FileSearchInput,
  ) {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const admin = isAdmin(context);
    const hasFilter = input.query !== undefined || input.path !== undefined ||
      input.kind !== undefined || input.mediaType !== undefined ||
      input.mediaGroup !== undefined || input.producerId !== undefined ||
      input.factKey !== undefined;
    if (!hasFilter) {
      throw unprocessable(["query"], "file_search_needs_a_filter");
    }
    if ((input.factKey === undefined) !== (input.factValue === undefined)) {
      throw unprocessable(["factKey"], "file_search_fact_incomplete");
    }

    const scopes = context.sessionScopes;
    const includeFiles = scopes === undefined ||
      scopes.includes("artifacts.read");
    // The route proves the caller may read files; the library needs its own
    // permission, and an agent session its own scope.
    const includeLibrary = (scopes === undefined ||
      scopes.includes("library.read")) && authorizeLibraryRead(context);

    // Files-only filters exclude library items, which have none of them.
    const filesOnlyFilter = input.mediaType !== undefined ||
      input.mediaGroup !== undefined || input.producerId !== undefined ||
      input.factKey !== undefined;

    // A path names a folder in the tree, or a place in the library mirror.
    let folderId: string | null = null;
    let libraryPrefix: string | null = null;
    let wantFiles = includeFiles;
    let wantLibrary = includeLibrary && !filesOnlyFilter;
    if (input.path !== undefined) {
      let segments;
      try {
        segments = parseStoragePath(input.path);
      } catch (error) {
        if (error instanceof StorageNameError) {
          throw unprocessable(["path"], "file_search_path_invalid");
        }
        throw error;
      }
      if (segments[0]?.nameKey === "library") {
        wantFiles = false;
        const section = segments[1]?.nameKey;
        libraryPrefix = section === undefined
          ? "/library/"
          : `/library/${section}/`;
        if (segments.length > 2) wantLibrary = false;
      } else {
        wantLibrary = false;
        if (segments.length > 0) {
          const folder = await resolveStoragePath(storageQueryOf(transaction), {
            organizationId,
            path: input.path,
          });
          // Not a folder, or not there: nothing, the same as an empty folder.
          if (!folder || folder.kind !== "folder") wantFiles = false;
          else folderId = folder.id;
        }
      }
    }

    const binding: CursorBinding = {
      action: "files.search",
      principalId,
      organizationId,
      ordering: PAGE_ORDERING,
      filters: await sha256Hex(canonicalJson({
        query: input.query ?? null,
        path: input.path ?? null,
        kind: input.kind ?? null,
        mediaType: input.mediaType ?? null,
        mediaGroup: input.mediaGroup ?? null,
        producerId: input.producerId ?? null,
        factKey: input.factKey ?? null,
        factValue: input.factValue ?? null,
        files: wantFiles,
        library: wantLibrary,
      })),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    if (!wantFiles && !wantLibrary) return { items: [], nextCursor: null };

    const params: unknown[] = [];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const org = p(organizationId);
    const needle = input.query === undefined
      ? null
      : input.query.normalize("NFC").toLowerCase();
    const needleParam = p(needle);
    const kindParam = p(input.kind ?? null);

    const branches: string[] = [];
    if (wantFiles) {
      const folder = p(folderId);
      branches.push(`
        select 'files'::text as source, entry.id as entry_id,
               null::uuid as item_id, entry.id as sort_id,
               entry.name, a.artifact_type as kind, v.media_type,
               v.size_bytes::integer as size_bytes, v.id as version_id,
               v.author_id as producer_id, ${MEDIA_GROUP_SQL} as media_group,
               case when v.id is null then null
                    when v.run_step_id is not null then 'step'
                    else 'person' end as producer_kind,
               case when v.id is null then null
                    when v.run_step_id is not null then step.step_key
                    else person.display_name end as producer_name,
               case when v.run_step_id is not null then task.id end
                 as producer_task_id,
               case when v.run_step_id is not null then task.title end
                 as producer_task_title,
               v.run_step_id as producer_step_id,
               coalesce(v.run_id, step.run_id) as producer_run_id,
               v.attempt_id as producer_attempt_id,
               v.agent_session_id as producer_session_id,
               def.name as producer_agent_name,
               v.acting_for_principal_id as producer_acting_for_id,
               actor.display_name as producer_acting_for_name,
               null::text as library_path, entry.created_at
          from bakery.storage_entries entry
          join bakery.artifacts a
            on a.organization_id = entry.organization_id
           and a.id = entry.artifact_id
          left join bakery.artifact_versions v
            on v.organization_id = a.organization_id
           and v.id = a.current_version_id
          left join bakery.principals person on person.id = v.author_id
          left join bakery.run_steps step
            on step.organization_id = v.organization_id
           and step.id = v.run_step_id
          left join bakery.workflow_runs run
            on run.organization_id = step.organization_id
           and run.id = step.run_id
          left join bakery.tasks task
            on task.organization_id = run.organization_id
           and task.id = run.task_id
          left join bakery.principals actor
            on actor.id = v.acting_for_principal_id
          left join bakery.agent_sessions s
            on s.organization_id = v.organization_id
           and s.id = v.agent_session_id
          left join bakery.agent_versions av
            on av.organization_id = s.organization_id
           and av.id = s.agent_version_id
          left join bakery.agent_definitions def
            on def.organization_id = av.organization_id
           and def.id = av.agent_id
         where entry.organization_id = ${org} and entry.kind = 'file'
           and entry.id not in (select id from hidden)
           and (${p(admin)}::boolean or entry.id not in (
                select id from denied where in_restricted and not granted))
           and (${folder}::uuid is null or entry.id in (select id from scope))
           and (${needleParam}::text is null
                or strpos(entry.name_key, ${needleParam}) > 0)
           and (${kindParam}::text is null or a.artifact_type = ${kindParam})
           and (${p(input.mediaType ?? null)}::text is null
                or v.media_type = ${p(input.mediaType ?? null)})
           and (${p(input.producerId ?? null)}::uuid is null
                or v.author_id = ${p(input.producerId ?? null)})
           and (${p(input.factKey ?? null)}::text is null
                or v.metadata ->> ${p(input.factKey ?? null)}
                   = ${p(input.factValue ?? null)})`);
      // Files people and steps write into working, personal and scratch areas
      // have no artifact: their current version is a storage file version. They
      // carry no metadata, so a fact filter leaves them out. The same rule as
      // the storage reads decides who sees one: a personal or scratch entry is
      // its owner's alone, /system is an Admin's, and a trashed or purged file
      // is not a search result.
      if (input.factKey === undefined) {
        branches.push(`
        select 'files'::text as source, entry.id as entry_id,
               null::uuid as item_id, entry.id as sort_id,
               entry.name, 'file'::text as kind, v.media_type,
               v.size_bytes::integer as size_bytes, v.id as version_id,
               v.author_id as producer_id, ${MEDIA_GROUP_SQL} as media_group,
               -- An agent's write (#448 S8a): what the version recorded at
               -- the write, or for one written before that, its step write
               -- set row.
               case when v.attempt_id is not null or agent.id is not null
                    then 'agent' else 'person' end as producer_kind,
               person.display_name as producer_name,
               task.id as producer_task_id,
               task.title as producer_task_title,
               v.run_step_id as producer_step_id, v.run_id as producer_run_id,
               coalesce(v.attempt_id, agent.attempt_id) as producer_attempt_id,
               coalesce(v.agent_session_id, agent.agent_session_id) as producer_session_id,
               def.name as producer_agent_name,
               v.acting_for_principal_id as producer_acting_for_id,
               actor.display_name as producer_acting_for_name,
               null::text as library_path, entry.created_at
          from bakery.storage_entries entry
          join bakery.storage_file_versions v
            on v.organization_id = entry.organization_id
           and v.id = entry.current_version_id
          left join bakery.principals person on person.id = v.author_id
          left join bakery.workflow_runs run
            on run.organization_id = v.organization_id
           and run.id = v.run_id
          left join bakery.tasks task
            on task.organization_id = run.organization_id
           and task.id = run.task_id
          left join lateral (select w.id, w.agent_session_id, w.attempt_id
                               from bakery.step_write_set w
                              where v.attempt_id is null
                                and w.organization_id = v.organization_id
                                and w.new_version_id = v.id
                                and w.op in ('put', 'copy')
                              order by w.created_at, w.id limit 1) agent on true
          left join bakery.principals actor
            on actor.id = v.acting_for_principal_id
          left join bakery.agent_sessions s
            on s.organization_id = v.organization_id
           and s.id = coalesce(v.agent_session_id, agent.agent_session_id)
          left join bakery.agent_versions av
            on av.organization_id = s.organization_id
           and av.id = s.agent_version_id
          left join bakery.agent_definitions def
            on def.organization_id = av.organization_id
           and def.id = av.agent_id
         where entry.organization_id = ${org} and entry.kind = 'file'
           and entry.artifact_id is null
           and entry.trashed_at is null and entry.purged_at is null
           and (entry.policy not in ('personal', 'scratch')
                or entry.owner_id is null
                or entry.owner_id = ${p(principalId)}::uuid)
           and entry.id not in (select id from hidden)
           and (${p(admin)}::boolean or entry.id not in (
                select id from denied where in_restricted and not granted))
           and (${folder}::uuid is null or entry.id in (select id from scope))
           and (${needleParam}::text is null
                or strpos(entry.name_key, ${needleParam}) > 0)
           and (${kindParam}::text is null or ${kindParam} = 'file')
           and (${p(input.mediaType ?? null)}::text is null
                or v.media_type = ${p(input.mediaType ?? null)})
           and (${p(input.producerId ?? null)}::uuid is null
                or v.author_id = ${p(input.producerId ?? null)})`);
      }
    }
    if (wantLibrary) {
      for (const source of LIBRARY_SOURCES) {
        branches.push(
          `select 'library'::text as source, null::uuid as entry_id,
                  x.id as item_id, x.id as sort_id,
                  x.${source.name} as name, '${source.kind}'::text as kind,
                  null::text as media_type, null::integer as size_bytes,
                  null::uuid as version_id, null::uuid as producer_id,
                  null::text as media_group, null::text as producer_kind,
                  null::text as producer_name, null::uuid as producer_task_id,
                  null::text as producer_task_title,
                  null::uuid as producer_step_id, null::uuid as producer_run_id,
                  null::uuid as producer_attempt_id,
                  null::uuid as producer_session_id,
                  null::text as producer_agent_name,
                  null::uuid as producer_acting_for_id,
                  null::text as producer_acting_for_name,
                  '/library/${source.section}/' || x.${source.slug} as library_path,
                  x.created_at
             from ${source.table} x
            where x.organization_id = ${org} ${source.where}
              ${visibleToCaller(source, () => `${p(principalId)}::uuid`)}
              and (${needleParam}::text is null
                   or strpos(lower(x.${source.name}), ${needleParam}) > 0)
              and (${kindParam}::text is null or ${kindParam} = '${source.kind}')`,
        );
      }
    }
    const prefixParam = p(libraryPrefix);
    const groupParam = p(input.mediaGroup ?? null);
    const sql = `
      with recursive scope(id) as (
        select entry.id from bakery.storage_entries entry
         where entry.organization_id = ${org} and entry.id = ${
      p(folderId)
    }::uuid
        union all
        select child.id from bakery.storage_entries child
          join scope on child.parent_id = scope.id
         where child.organization_id = ${org}
      ),
      -- What this caller never searches: /system unless an Admin.
      hidden(id) as (
        select entry.id from bakery.storage_entries entry
         where entry.organization_id = ${org}
           and entry.system_key = any(${p(admin ? [] : ["system"])}::text[])
        union all
        select child.id from bakery.storage_entries child
          join hidden on child.parent_id = hidden.id
         where child.organization_id = ${org}
      ),
      ${deniedEntriesCte(org, p(principalId))}
      select *, to_char(created_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
        from (${branches.join("\n union all\n")}) hits
       where (${prefixParam}::text is null
              or (library_path is not null and starts_with(library_path, ${prefixParam})))
         and (${groupParam}::text is null or media_group = ${groupParam})
         and (${p(position?.createdAt ?? null)}::timestamptz is null
              or (created_at, sort_id) < (${
      p(position?.createdAt ?? null)
    }::timestamptz,
                                          ${p(position?.id ?? null)}::uuid))
       order by created_at desc, sort_id desc
       limit ${p(limit + 1)}`;
    const result = await transaction.query<HitRow>(sql, params);
    const page = result.rows.slice(0, limit);
    // A reviewer's search leaves out the files it may not read (O47); the
    // cursor follows the unfiltered page.
    const hidden = await hiddenEntryIds(
      transaction,
      await reviewerIsolationOf(transaction, context, organizationId),
      organizationId,
      page.filter((row) => row.source === "files").map((row) => row.sort_id),
    );
    const visible = page.filter((row) =>
      row.source !== "files" || !hidden.has(row.sort_id)
    );

    // Paths of the tree hits, in one query: each entry's ancestors, joined.
    const treeIds = visible.filter((row) => row.source === "files").map((row) =>
      row.sort_id
    );
    const paths = new Map<string, string>();
    if (treeIds.length > 0) {
      const found = await transaction.query<{ leaf: string; path: string }>(
        `with recursive up as (
           select e.id as leaf, e.id, e.parent_id, e.name, 0 as depth
             from bakery.storage_entries e
            where e.organization_id = $1 and e.id = any($2::uuid[])
           union all
           select up.leaf, e.id, e.parent_id, e.name, up.depth + 1
             from bakery.storage_entries e
             join up on e.id = up.parent_id
            where e.organization_id = $1
         )
         select leaf, '/' || string_agg(name, '/' order by depth desc) as path
           from up group by leaf`,
        [organizationId, treeIds],
      );
      for (const row of found.rows) paths.set(row.leaf, row.path);
    }

    const last = page.at(-1);
    return {
      items: visible.map((row) => {
        const match = nameMatch(row.name, input.query);
        return {
          source: row.source,
          entryId: row.entry_id,
          itemId: row.item_id,
          path: row.source === "files"
            ? paths.get(row.sort_id) ?? `/${row.name}`
            : row.library_path!,
          name: row.name,
          kind: row.kind,
          mediaType: row.media_type,
          mediaGroup: row.media_group as
            | "text"
            | "image"
            | "video"
            | "audio"
            | "data"
            | "archive"
            | "other"
            | null,
          sizeBytes: row.size_bytes,
          versionId: row.version_id,
          producerId: row.producer_id,
          producerKind: row.producer_kind,
          producerName: row.producer_name,
          producerTaskId: row.producer_task_id,
          producerTaskTitle: row.producer_task_title,
          producerStepId: row.producer_step_id,
          producerRunId: row.producer_run_id,
          producerAttemptId: row.producer_attempt_id,
          producerSessionId: row.producer_session_id,
          producerAgentName: row.producer_agent_name,
          producerActingForId: row.producer_acting_for_id,
          producerActingForName: row.producer_acting_for_name,
          nameMatchStart: match?.start ?? null,
          nameMatchLength: match?.length ?? null,
          createdAt: toIso(row.created_at),
        };
      }),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.sort_id,
        })
        : null,
    };
  };
}

type FileFactInput = z.output<typeof contractSchemas.FileFactQuery>;

type FactRow = { kind: string; key: string; value: string; files: number };

/** The most a kind lists: keys, values per key, and rows in all. */
const MAX_FACT_KEYS = 50;
const MAX_FACT_VALUES = 50;
const MAX_FACT_ROWS = 500;

/**
 * The facts files carry, by kind (the source for the search's fact filter):
 * every metadata key and string value on the current version of a file the
 * caller may read, with how many files hold it. The same rules as the search:
 * organization isolation, the route's own read permission, an agent session's
 * `artifacts.read` scope, and /system an Admin's alone. Working-area files
 * carry no metadata, so only artifact-backed files appear.
 */
export function createFileFactsHandler(
  isAdmin: (context: ActionContext) => boolean,
) {
  return async function listFileFacts(
    context: ActionContext,
    input: FileFactInput,
  ) {
    const { transaction, organizationId } = requireWorkTransaction(context);
    const scopes = context.sessionScopes;
    if (scopes !== undefined && !scopes.includes("artifacts.read")) {
      return { items: [], nextCursor: null };
    }
    const result = await transaction.query<FactRow>(
      `with recursive hidden(id) as (
         select entry.id from bakery.storage_entries entry
          where entry.organization_id = $1
            and entry.system_key = any($2::text[])
         union all
         select child.id from bakery.storage_entries child
           join hidden on child.parent_id = hidden.id
          where child.organization_id = $1
       ),
       facts as (
         select a.artifact_type as kind, m.key, m.value, count(*)::integer as files
           from bakery.storage_entries entry
           join bakery.artifacts a
             on a.organization_id = entry.organization_id
            and a.id = entry.artifact_id
           join bakery.artifact_versions v
             on v.organization_id = a.organization_id
            and v.id = a.current_version_id
          cross join lateral jsonb_each_text(
            case when jsonb_typeof(v.metadata) = 'object'
                 then v.metadata else '{}'::jsonb end
          ) as m(key, value)
          where entry.organization_id = $1 and entry.kind = 'file'
            and entry.id not in (select id from hidden)
            and ($3::text is null or a.artifact_type = $3)
            and length(m.key) between 1 and 100
            and length(m.value) between 1 and 500
          group by a.artifact_type, m.key, m.value
       ),
       ranked as (
         select facts.*,
                row_number() over (
                  partition by kind, key order by files desc, value
                ) as value_rank,
                dense_rank() over (partition by kind order by key) as key_rank
           from facts
       )
       select kind, key, value, files
         from ranked
        where value_rank <= $4 and key_rank <= $5
        order by kind, key, value
        limit $6`,
      [
        organizationId,
        isAdmin(context) ? [] : ["system"],
        input.kind ?? null,
        MAX_FACT_VALUES,
        MAX_FACT_KEYS,
        MAX_FACT_ROWS,
      ],
    );
    return { items: result.rows, nextCursor: null };
  };
}
