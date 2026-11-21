import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { formatDate, formatNumber } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { StorageFolderItem } from "../api/client.ts";
import {
  storageFolderChainQueryOptions,
  storageFolderEntriesQueryOptions,
  storageRootsQueryOptions,
} from "../api/query.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { FileDetails, type FileTab } from "./files/FileDetails.tsx";
import { FileOpened } from "./files/FileOpened.tsx";
import { isLibraryPath, LibraryFilesPage } from "./files/LibraryFilesPage.tsx";
import {
  FileSearchControls,
  FileSearchResults,
  isSearching,
  libraryItemTarget,
  MEDIA_GROUPS,
  type MediaGroup,
  type SearchState,
} from "./files/FileSearch.tsx";
import {
  filesHref,
  rootNameKey,
  rootNoteKey,
  sizeParts,
} from "./files/files-state.ts";

/** The files browser (#445): the top folders, one folder's entries, or the Library copy. */
export function FilesPage({ path }: { readonly path: string }) {
  return isLibraryPath(path)
    ? <LibraryFilesPage path={path} />
    : <StorageFilesPage path={path} />;
}

function StorageFilesPage({ path }: { readonly path: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const phone = useShellViewport() === "phone";
  const { translate, locale, timeZone } = useI18n();
  const ready = scope.organizationId !== null;
  const atTop = path === "";

  const roots = useQuery({
    ...storageRootsQueryOptions(api, scope),
    enabled: ready && atTop,
  });
  const chain = useQuery({
    ...storageFolderChainQueryOptions(api, scope, path),
    enabled: ready && !atTop,
  });
  const folder = chain.data?.at(-1) ?? null;
  const entries = useInfiniteQuery({
    ...storageFolderEntriesQueryOptions(api, scope, folder?.id ?? ""),
    enabled: ready && folder !== null,
  });

  const search = useSearch({ strict: false }) as {
    file?: string;
    tab?: FileTab;
    version?: number;
    q?: string;
    type?: MediaGroup;
    kind?: string;
    by?: string;
    fact?: string;
    view?: "open";
    in?: "all";
  };
  const searchState: SearchState = {
    q: search.q ?? "",
    kind: search.kind,
    by: search.by,
    // A fact belongs to a kind: without one the control is disabled and empty,
    // so a fact left in the address must not narrow a search the page does not show.
    fact: search.kind === undefined ? undefined : search.fact,
    type: search.type !== undefined &&
        (MEDIA_GROUPS as readonly string[]).includes(search.type)
      ? search.type
      : undefined,
    everywhere: atTop || search.in === "all",
  };
  const searching = isSearching(searchState);
  const tab: FileTab = search.tab === "versions" || search.tab === "uses"
    ? search.tab
    : "details";
  const setSearch = (
    next: {
      file?: string | undefined;
      tab?: "versions" | "uses" | undefined;
      version?: number | undefined;
      q?: string | undefined;
      type?: MediaGroup | undefined;
      kind?: string | undefined;
      by?: string | undefined;
      fact?: string | undefined;
      view?: "open" | undefined;
      in?: "all" | undefined;
    },
  ) => {
    const merged = {
      file: search.file,
      tab: search.tab === "details" ? undefined : search.tab,
      version: search.version,
      q: search.q,
      type: search.type,
      kind: search.kind,
      by: search.by,
      fact: search.fact,
      view: search.view,
      in: search.in,
      ...next,
    };
    const query: {
      file?: string;
      tab?: "versions" | "uses";
      version?: number;
      q?: string;
      type?: MediaGroup;
      kind?: string;
      by?: string;
      fact?: string;
      view?: "open";
      in?: "all";
    } = {};
    if (merged.q !== undefined && merged.q !== "") query.q = merged.q;
    if (merged.type !== undefined) query.type = merged.type;
    if (merged.kind !== undefined) query.kind = merged.kind;
    if (merged.by !== undefined) query.by = merged.by;
    if (merged.fact !== undefined && merged.kind !== undefined) {
      query.fact = merged.fact;
    }
    if (merged.view !== undefined) query.view = merged.view;
    if (merged.in !== undefined) query.in = merged.in;
    if (merged.file !== undefined) query.file = merged.file;
    if (merged.tab !== undefined) query.tab = merged.tab;
    if (merged.version !== undefined) query.version = merged.version;
    if (atTop) {
      void navigate({ to: "/files", search: query, replace: true });
    } else {
      void navigate({
        to: "/files/$",
        params: { _splat: path.slice(1) },
        search: query,
        replace: true,
      });
    }
  };

  const open = (target: string) =>
    void navigate({ to: "/files/$", params: { _splat: target.slice(1) } });
  const goTop = () => void navigate({ to: "/files" });

  const nameOf = (item: StorageFolderItem) => {
    if (item.policy === "personal") return translate("files.root.yoursName");
    const designed = item.parentId === null ? rootNameKey(item) : null;
    return designed !== null
      ? translate(designed)
      : item.displayName ?? item.name;
  };

  const name = (item: StorageFolderItem) =>
    item.kind === "folder"
      ? (
        <UI.Link
          href={filesHref(item.path)}
          variant="quiet"
          data-name="true"
          onClick={(event) => {
            event.preventDefault();
            open(item.path);
          }}
        >
          {nameOf(item)}
        </UI.Link>
      )
      : (
        <UI.Link
          href={`?file=${item.id}`}
          variant="quiet"
          data-name="true"
          onClick={(event) => {
            event.preventDefault();
            setSearch({
              file: item.id,
              tab: undefined,
              version: undefined,
              view: undefined,
            });
          }}
        >
          {nameOf(item)}
        </UI.Link>
      );

  const size = (item: StorageFolderItem) => {
    if (item.kind === "folder" || item.sizeBytes === null) {
      return translate("files.size.none");
    }
    const { value, unit } = sizeParts(item.sizeBytes);
    return translate(`files.size.${unit}` as never, {
      value: formatNumber(value, locale, {
        maximumFractionDigits: unit === "bytes" ? 0 : 1,
      }),
    });
  };

  const crumbs = [
    { label: translate("files.breadcrumb.root"), href: "/files" },
    ...(chain.data ?? []).map((item) => ({
      label: nameOf(item),
      href: filesHref(item.path),
    })),
  ];

  const failed = atTop ? roots.isError : chain.isError || entries.isError;
  const retry = () => {
    if (atTop) void roots.refetch();
    else if (chain.isError) void chain.refetch();
    else void entries.refetch();
  };
  const loading = atTop
    ? roots.isPending
    : chain.isPending || (folder !== null && entries.isPending);
  const missing = !atTop && chain.isSuccess && chain.data === null;
  const rows = atTop
    ? roots.data?.items ?? []
    : entries.data?.pages.flatMap((page) => page.items) ?? [];
  const selected = search.file === undefined
    ? null
    : rows.find((row) => row.id === search.file && row.kind === "file") ??
      null;
  // A link to a file past the first page: page the folder until it turns up.
  const wanted = search.file !== undefined && selected === null && !atTop;
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = entries;
  useEffect(() => {
    if (wanted && hasNextPage && !isFetchingNextPage && !isError) {
      void fetchNextPage();
    }
  }, [wanted, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const fileMissing = search.file !== undefined && selected === null &&
    !searching && !loading &&
    (atTop || (entries.isSuccess && !entries.hasNextPage));
  const fileFinding = wanted && !fileMissing && !searching && !loading &&
    !entries.isError;
  const filePage = selected !== null && phone && !searching;
  const detailsPanel = selected === null ? null : (
    <FileDetails
      file={selected}
      phone={phone}
      backLabel={translate("files.back", {
        name: (chain.data?.at(-1) ? nameOf(chain.data.at(-1)!) : "") ||
          translate("files.breadcrumb.root"),
      })}
      tab={tab}
      revision={search.version}
      onRevision={(next) => setSearch({ version: next })}
      onTab={(next) =>
        setSearch({ tab: next === "details" ? undefined : next })}
      opened={search.view === "open"}
      onOpenView={() => setSearch({ view: "open" })}
      onCloseView={() => setSearch({ view: undefined })}
      onClose={() =>
        setSearch({
          file: undefined,
          tab: undefined,
          version: undefined,
          view: undefined,
        })}
    />
  );

  return (
    <>
      <ShellActiveNavigation id="files" />
      {detailsPanel !== null && !phone
        ? (
          <ShellSlot name="inspector">
            <UI.InspectorPanel
              label={translate("files.details.label")}
              variant="column"
            >
              {detailsPanel}
            </UI.InspectorPanel>
          </ShellSlot>
        )
        : null}
      <UI.Stack gap="spacious" data-testid="files-page">
        {filePage ? null : (
          <UI.PageHeader
            variant="list"
            flush
            title={translate("files.title")}
            subtitle={translate("files.description")}
          />
        )}
        {atTop || filePage ? null : phone
          ? (
            <UI.Link
              href={crumbs.at(-2)?.href ?? "/files"}
              variant="back"
              onClick={(event) => {
                event.preventDefault();
                if (crumbs.length > 2) {
                  void navigate({
                    to: "/files/$",
                    params: {
                      _splat: (crumbs.at(-2)?.href ?? "").slice(
                        "/files/".length,
                      ),
                    },
                  });
                } else {
                  void navigate({ to: "/files" });
                }
              }}
            >
              {translate("files.back", {
                name: crumbs.at(-2)?.label ??
                  translate("files.breadcrumb.root"),
              })}
            </UI.Link>
          )
          : (
            <UI.Breadcrumbs
              aria-label={translate("files.breadcrumb")}
              items={crumbs}
            />
          )}
        {filePage ? null : (
          <FileSearchControls
            state={searchState}
            atTop={atTop}
            onChange={(next) =>
              setSearch({
                q: next.q,
                type: next.type,
                kind: next.kind,
                by: next.by,
                fact: next.fact,
                in: next.everywhere && !atTop ? "all" : undefined,
                file: undefined,
                tab: undefined,
                version: undefined,
              })}
          />
        )}
        {fileMissing
          ? (
            <UI.InlineNotice tone="information">
              {translate("files.file.missing")}
            </UI.InlineNotice>
          )
          : fileFinding
          ? (
            <UI.Text variant="muted" role="status">
              {translate("files.file.finding")}
            </UI.Text>
          )
          : null}
        {searching
          ? (
            <FileSearchResults
              state={searchState}
              folderPath={path}
              onOpen={(hit) => {
                const target = libraryItemTarget(hit);
                if (target !== null) {
                  void navigate(target);
                  return;
                }
                const parent = hit.path.slice(0, hit.path.lastIndexOf("/"));
                void navigate({
                  to: "/files/$",
                  params: { _splat: parent.slice(1) },
                  search: hit.entryId !== null && hit.source === "files"
                    ? { file: hit.entryId }
                    : {},
                });
              }}
            />
          )
          : missing
          ? (
            <UI.EmptyState
              title={translate("files.notFound.title")}
              description={translate("files.notFound.description")}
              action={
                <UI.Button variant="secondary" onClick={goTop}>
                  {translate("files.notFound.action")}
                </UI.Button>
              }
            />
          )
          : failed
          ? (
            <UI.AlertBanner tone="error">
              {translate("files.error")}{" "}
              <UI.Button variant="secondary" onClick={retry}>
                {translate("files.retry")}
              </UI.Button>
            </UI.AlertBanner>
          )
          : loading
          ? <UI.Text role="status">{translate("files.loading")}</UI.Text>
          : detailsPanel !== null && phone
          ? detailsPanel
          : search.view === "open" && selected !== null
          ? (
            <FileOpened
              file={selected}
              revision={search.version}
              onBack={() => setSearch({ view: undefined })}
            />
          )
          : rows.length === 0
          ? (
            <UI.EmptyState
              title={translate("files.empty.title")}
              description={translate("files.empty.description")}
            />
          )
          : (
            <UI.Stack gap="standard">
              {phone
                ? (
                  <UI.Stack
                    gap="none"
                    role="list"
                    aria-label={translate("files.table.caption")}
                  >
                    {rows.map((row) => (
                      <div
                        key={row.id}
                        role="listitem"
                        data-entry-id={row.id}
                      >
                        <UI.StackedRow title={name(row)}>
                          <UI.Text variant="caption">
                            {atTop
                              ? (() => {
                                const key = rootNoteKey(row);
                                return key === null ? "" : translate(key);
                              })()
                              : [
                                row.kind === "folder"
                                  ? translate("files.kind.folder")
                                  : row.kindName ??
                                    translate("files.kind.none"),
                                row.kind === "file" ? size(row) : "",
                                formatDate(new Date(row.updatedAt), locale, {
                                  dateStyle: "medium",
                                  timeZone,
                                }),
                              ].filter((part) => part !== "").join(" · ")}
                          </UI.Text>
                        </UI.StackedRow>
                      </div>
                    ))}
                  </UI.Stack>
                )
                : (
                  <UI.DataTable<StorageFolderItem>
                    caption={translate("files.table.caption")}
                    captionHidden
                    variant="ruled"
                    inset="edge"
                    rows={[...rows]}
                    state="ready"
                    getRowKey={(row) => row.id}
                    getRowAttributes={(row) => ({
                      "data-entry-id": row.id,
                      ...(row.id === selected?.id
                        ? { "data-selected": "true" }
                        : {}),
                    })}
                    columns={atTop
                      ? [
                        {
                          id: "name",
                          width: "34%",
                          header: translate("files.table.name"),
                          cell: name,
                        },
                        {
                          id: "what",
                          header: translate("files.table.whatIsHere"),
                          cell: (row) => {
                            const key = rootNoteKey(row);
                            return key === null
                              ? null
                              : (
                                <UI.Text variant="muted">
                                  {translate(key)}
                                </UI.Text>
                              );
                          },
                        },
                      ]
                      : [
                        {
                          id: "name",
                          width: "46%",
                          header: translate("files.table.name"),
                          cell: name,
                        },
                        {
                          id: "kind",
                          header: translate("files.table.kind"),
                          cell: (row) => row.kind === "folder"
                            ? translate("files.kind.folder")
                            : row.kindName ?? translate("files.kind.none"),
                        },
                        {
                          id: "size",
                          align: "end",
                          header: translate("files.table.size"),
                          cell: size,
                        },
                        {
                          id: "changed",
                          header: translate("files.table.changed"),
                          cell: (row) =>
                            formatDate(new Date(row.updatedAt), locale, {
                              dateStyle: "medium",
                              timeZone,
                            }),
                        },
                      ]}
                  />
                )}
              {!atTop && entries.isFetchNextPageError
                ? (
                  <UI.AlertBanner tone="error">
                    {translate("files.loadMoreError")}
                  </UI.AlertBanner>
                )
                : null}
              {!atTop && entries.hasNextPage
                ? (
                  <UI.Button
                    variant="secondary"
                    disabled={entries.isFetchingNextPage}
                    onClick={() => void entries.fetchNextPage()}
                  >
                    {entries.isFetchingNextPage
                      ? translate("files.loadingMore")
                      : entries.isFetchNextPageError
                      ? translate("files.retry")
                      : translate("files.loadMore")}
                  </UI.Button>
                )
                : null}
            </UI.Stack>
          )}
      </UI.Stack>
    </>
  );
}
