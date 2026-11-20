import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { formatDate } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { LibraryEntry } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { fileLibraryEntriesQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../../shell/shell-slots.tsx";
import {
  FileSearchControls,
  FileSearchResults,
  isSearching,
  libraryItemTarget,
  MEDIA_GROUPS,
  type MediaGroup,
  type SearchState,
} from "./FileSearch.tsx";
import { filesHref } from "./files-state.ts";

/** Whether a folder path is the read-only mirror of the Library, or inside it. */
export function isLibraryPath(path: string): boolean {
  return path === "/library" || path.startsWith("/library/");
}

const SECTIONS = [
  "workflows",
  "agents",
  "skills",
  "kinds",
  "packages",
] as const;
type Section = typeof SECTIONS[number];
const isSection = (value: string | undefined): value is Section =>
  (SECTIONS as readonly string[]).includes(value ?? "");

/** One folder of the Library copy under Files: read only, a table of what the Library holds. */
export function LibraryFilesPage({ path }: { readonly path: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const phone = useShellViewport() === "phone";
  const { translate, locale, timeZone } = useI18n();
  const list = useInfiniteQuery(
    fileLibraryEntriesQueryOptions(api, scope, path),
  );
  const search = useSearch({ strict: false }) as {
    q?: string;
    type?: MediaGroup;
    kind?: string;
    by?: string;
    fact?: string;
    in?: "all";
  };
  const searchState: SearchState = {
    q: search.q ?? "",
    type: search.type !== undefined &&
        (MEDIA_GROUPS as readonly string[]).includes(search.type)
      ? search.type
      : undefined,
    kind: search.kind,
    by: search.by,
    fact: search.fact,
    everywhere: search.in === "all",
  };
  const searching = isSearching(searchState);
  const setSearch = (next: SearchState) => {
    const query: {
      q?: string;
      type?: MediaGroup;
      kind?: string;
      by?: string;
      fact?: string;
      in?: "all";
    } = {};
    if (next.q !== "") query.q = next.q;
    if (next.type !== undefined) query.type = next.type;
    if (next.kind !== undefined) query.kind = next.kind;
    if (next.by !== undefined) query.by = next.by;
    if (next.fact !== undefined) query.fact = next.fact;
    if (next.everywhere) query.in = "all";
    void navigate({
      to: "/files/$",
      params: { _splat: path.slice(1) },
      search: query,
      replace: true,
    });
  };
  const rows: readonly LibraryEntry[] =
    list.data?.pages.flatMap((page) => page.items) ?? [];
  const section = path.split("/")[2];
  const sectionName = (value: string) =>
    isSection(value)
      ? translate(`files.library.section.${value}` as never)
      : value;
  const what = section === "agents"
    ? translate("files.library.what.agent")
    : section === "workflows"
    ? translate("files.library.what.workflow")
    : translate("files.library.what.item");
  const crumbs = [
    { label: translate("files.breadcrumb.root"), href: "/files" },
    section === undefined
      ? { label: translate("files.library.name") }
      : { label: translate("files.library.name"), href: "/files/library" },
    ...(section === undefined ? [] : [{ label: sectionName(section) }]),
  ];
  // The phone shows one link back instead of the whole path, as a project
  // folder does: one step up, to Library from a section and to Files from the
  // Library itself.
  const back = crumbs.at(-2) ?? crumbs[0]!;
  const goTo = (href: string) => {
    if (href === "/files") {
      void navigate({ to: "/files" });
      return;
    }
    void navigate({
      to: "/files/$",
      params: { _splat: href.slice("/files/".length) },
    });
  };
  const kindName = (entry: LibraryEntry) =>
    entry.type === "folder"
      ? translate("files.kind.folder")
      : entry.kind === null
      ? translate("files.kind.none")
      : isSection(`${entry.kind}s`)
      ? translate(`files.library.kind.${entry.kind}` as never)
      : entry.kind;
  const added = (entry: LibraryEntry) =>
    entry.createdAt === null
      ? translate("files.size.none")
      : formatDate(new Date(entry.createdAt), locale, {
        dateStyle: "medium",
        timeZone,
      });
  const name = (entry: LibraryEntry) =>
    entry.type === "folder"
      ? (
        <UI.Link
          href={filesHref(entry.path)}
          variant="quiet"
          data-name="true"
          onClick={(event) => {
            event.preventDefault();
            void navigate({
              to: "/files/$",
              params: { _splat: entry.path.slice(1) },
            });
          }}
        >
          {sectionName(entry.path.split("/").at(-1) ?? entry.name)}
        </UI.Link>
      )
      : entry.id !== null && entry.kind === "workflow"
      ? (
        <UI.Link
          href={`/library/workflows/${entry.id}`}
          variant="quiet"
          data-name="true"
          onClick={(event) => {
            event.preventDefault();
            void navigate({
              to: "/library/workflows/$workflowId",
              params: { workflowId: entry.id! },
            });
          }}
        >
          {entry.name}
        </UI.Link>
      )
      : entry.id !== null && entry.kind === "agent"
      ? (
        <UI.Link
          href={`/library/agents/${entry.id}`}
          variant="quiet"
          data-name="true"
          onClick={(event) => {
            event.preventDefault();
            void navigate({
              to: "/library/agents/$agentId",
              params: { agentId: entry.id! },
            });
          }}
        >
          {entry.name}
        </UI.Link>
      )
      : <UI.Text variant="body">{entry.name}</UI.Text>;
  const missing = list.isError && list.error.kind === "problem" &&
    list.error.problem.status === 404;

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
        <UI.Inline gap="compact">
          {phone
            ? (
              <UI.Link
                href={back.href ?? "/files"}
                variant="back"
                onClick={(event) => {
                  event.preventDefault();
                  goTo(back.href ?? "/files");
                }}
              >
                {translate("files.back", { name: back.label })}
              </UI.Link>
            )
            : (
              <UI.Breadcrumbs
                aria-label={translate("files.breadcrumb")}
                items={crumbs}
              />
            )}
          <UI.Badge tone="neutral">
            {translate("files.library.readOnly")}
          </UI.Badge>
        </UI.Inline>
        <FileSearchControls
          state={searchState}
          atTop={false}
          onChange={setSearch}
        />
        <UI.InlineNotice tone="information">
          <UI.Stack gap="compact">
            <UI.Text variant="body">
              <strong>{translate("files.library.notice.title")}</strong>{" "}
              {section === "workflows" || section === "agents"
                ? translate("files.library.notice.open", { what })
                : translate("files.library.notice.other")}
            </UI.Text>
            <UI.Inline gap="compact">
              <UI.Button
                variant="secondary"
                onClick={() => void navigate({ to: "/library" })}
              >
                {translate("files.library.open")}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        </UI.InlineNotice>
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
                <UI.Button
                  variant="secondary"
                  onClick={() => void navigate({ to: "/files" })}
                >
                  {translate("files.notFound.action")}
                </UI.Button>
              }
            />
          )
          : list.isError
          ? (
            <UI.AlertBanner tone="error">
              {translate("files.error")}{" "}
              <UI.Button
                variant="secondary"
                onClick={() => void list.refetch()}
              >
                {translate("files.retry")}
              </UI.Button>
            </UI.AlertBanner>
          )
          : list.isPending
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
              {phone
                ? (
                  <UI.Stack
                    gap="none"
                    role="list"
                    aria-label={translate("files.table.caption")}
                  >
                    {rows.map((entry) => (
                      <div key={entry.path} role="listitem">
                        <UI.StackedRow title={name(entry)}>
                          <UI.Text variant="caption">
                            {[
                              kindName(entry),
                              entry.createdAt === null
                                ? ""
                                : translate("files.library.addedOn", {
                                  date: added(entry),
                                }),
                            ].filter((part) => part !== "").join(" · ")}
                          </UI.Text>
                        </UI.StackedRow>
                      </div>
                    ))}
                  </UI.Stack>
                )
                : (
                  <UI.DataTable<LibraryEntry>
                    caption={translate("files.table.caption")}
                    captionHidden
                    variant="ruled"
                    inset="edge"
                    rows={[...rows]}
                    state="ready"
                    getRowKey={(entry) => entry.path}
                    columns={[
                      {
                        id: "name",
                        width: "46%",
                        header: translate("files.table.name"),
                        cell: name,
                      },
                      {
                        id: "kind",
                        header: translate("files.table.kind"),
                        cell: kindName,
                      },
                      {
                        id: "changed",
                        header: translate("files.library.added"),
                        cell: added,
                      },
                    ]}
                  />
                )}
              {list.hasNextPage
                ? (
                  <UI.Button
                    variant="secondary"
                    disabled={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                  >
                    {list.isFetchingNextPage
                      ? translate("files.loadingMore")
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
