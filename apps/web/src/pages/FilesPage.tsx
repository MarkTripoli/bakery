import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { filesHref, rootNoteKey, sizeParts } from "./files/files-state.ts";

/** The files browser (#445): the top folders, or one folder's entries. */
export function FilesPage({ path }: { readonly path: string }) {
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

  const open = (target: string) =>
    void navigate({ to: "/files/$", params: { _splat: target.slice(1) } });
  const goTop = () => void navigate({ to: "/files" });

  const nameOf = (item: StorageFolderItem) =>
    item.policy === "personal"
      ? translate("files.root.yoursName")
      : item.displayName ?? item.name;

  const name = (item: StorageFolderItem) =>
    item.kind === "folder"
      ? (
        <UI.Link
          href={filesHref(item.path)}
          variant="quiet"
          onClick={(event) => {
            event.preventDefault();
            open(item.path);
          }}
        >
          {nameOf(item)}
        </UI.Link>
      )
      : <UI.Text>{nameOf(item)}</UI.Text>;

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

  return (
    <>
      <ShellActiveNavigation id="files" />
      <UI.Stack gap="spacious" data-testid="files-page">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("files.title")}
          subtitle={translate("files.description")}
        />
        {atTop ? null : (
          <UI.Breadcrumbs
            aria-label={translate("files.breadcrumb")}
            items={crumbs}
          />
        )}
        {missing
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
          : rows.length === 0
          ? (
            <UI.EmptyState
              title={translate("files.empty.title")}
              description={translate("files.empty.description")}
            />
          )
          : (
            <UI.Stack gap="standard">
              <UI.DataTable<StorageFolderItem>
                caption={translate("files.table.caption")}
                captionHidden
                variant={phone ? "sheetList" : "ruled"}
                inset="edge"
                rows={[...rows]}
                state="ready"
                getRowKey={(row) => row.id}
                getRowAttributes={(row) => ({ "data-entry-id": row.id })}
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
                          : <UI.Text variant="muted">{translate(key)}</UI.Text>;
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
                      cell: (row) =>
                        row.kind === "folder"
                          ? translate("files.kind.folder")
                          : row.kindName ?? "",
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
