import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { formatNumber } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { FileSearchHit } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  fileKindsQueryOptions,
  filePeopleQueryOptions,
  fileSearchQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { sizeParts } from "./files-state.ts";

export const MEDIA_GROUPS = [
  "text",
  "image",
  "video",
  "audio",
  "data",
  "archive",
  "other",
] as const;
export type MediaGroup = typeof MEDIA_GROUPS[number];

/** What a search asks for, as the address carries it. */
export type SearchState = {
  readonly q: string;
  readonly type: MediaGroup | undefined;
  /** A kind's name as the library lists it (`plan`), or any kind. */
  readonly kind: string | undefined;
  /** The principal who made the file, or anyone. */
  readonly by: string | undefined;
  readonly everywhere: boolean;
};

/** A search runs from two letters, or as soon as a filter is set. */
export function isSearching(state: SearchState): boolean {
  return state.q.trim().length >= 2 || state.type !== undefined ||
    state.kind !== undefined || state.by !== undefined;
}

/** The search field and its filters, one row; typing is settled for 250 ms. */
export function FileSearchControls(
  { state, atTop, onChange }: {
    readonly state: SearchState;
    readonly atTop: boolean;
    readonly onChange: (next: SearchState) => void;
  },
) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const kinds = useQuery(fileKindsQueryOptions(api, scope));
  const people = useQuery(filePeopleQueryOptions(api, scope));
  const kindOptions = [
    { value: "", label: translate("files.search.kind.any") },
    ...(kinds.data?.items ?? [])
      .filter((entry) => entry.type === "item")
      .map((entry) => ({
        value: entry.path.slice(entry.path.lastIndexOf("/") + 1),
        label: entry.name,
      })),
  ];
  if (
    state.kind !== undefined &&
    !kindOptions.some((option) => option.value === state.kind)
  ) {
    kindOptions.push({ value: state.kind, label: state.kind });
  }
  const principals = (people.data?.items ?? []).filter((item) =>
    item.disabledAt === null
  );
  const byOptions = [
    { value: "", label: translate("files.search.by.any") },
    ...[
      ...principals.filter((item) => item.principalType === "human"),
      ...principals.filter((item) => item.principalType !== "human"),
    ].map((item) => ({ value: item.id, label: item.displayName })),
  ];
  if (
    state.by !== undefined &&
    !byOptions.some((option) => option.value === state.by)
  ) {
    byOptions.push({ value: state.by, label: state.by });
  }
  const [text, setText] = useState(state.q);
  useEffect(() => setText(state.q), [state.q]);
  useEffect(() => {
    if (text === state.q) return;
    const timer = globalThis.setTimeout(
      () => onChange({ ...state, q: text }),
      250,
    );
    return () => globalThis.clearTimeout(timer);
  }, [text, state, onChange]);
  const phone = useShellViewport() === "phone";
  const [sheetOpen, setSheetOpen] = useState(false);
  const active =
    [state.type, state.kind, state.by].filter((value) => value !== undefined)
      .length + (state.everywhere && !atTop ? 1 : 0);
  const filterItems = (
    <>
      {atTop ? null : (
        <UI.Combobox
          label={translate("files.search.where")}
          value={state.everywhere ? "all" : "folder"}
          onChange={(event) =>
            onChange({
              ...state,
              everywhere: event.currentTarget.value === "all",
            })}
          options={[
            {
              value: "folder",
              label: translate("files.search.where.folder"),
            },
            { value: "all", label: translate("files.search.where.all") },
          ]}
        />
      )}
      <UI.Combobox
        label={translate("files.search.type")}
        value={state.type ?? ""}
        onChange={(event) => {
          const value = event.currentTarget.value;
          onChange({
            ...state,
            type: (MEDIA_GROUPS as readonly string[]).includes(value)
              ? value as MediaGroup
              : undefined,
          });
        }}
        options={[
          { value: "", label: translate("files.search.type.any") },
          ...MEDIA_GROUPS.map((group) => ({
            value: group,
            label: translate(`files.search.type.${group}` as never),
          })),
        ]}
      />
      <UI.Combobox
        label={translate("files.search.kind")}
        value={state.kind ?? ""}
        onChange={(event) => {
          const value = event.currentTarget.value;
          onChange({ ...state, kind: value === "" ? undefined : value });
        }}
        options={kindOptions}
      />
      <UI.Combobox
        label={translate("files.search.by")}
        value={state.by ?? ""}
        onChange={(event) => {
          const value = event.currentTarget.value;
          onChange({ ...state, by: value === "" ? undefined : value });
        }}
        options={byOptions}
      />
      {state.q !== "" || state.type !== undefined ||
          state.kind !== undefined || state.by !== undefined
        ? (
          <UI.Button
            variant="secondary"
            onClick={() => {
              setText("");
              onChange({
                ...state,
                q: "",
                type: undefined,
                kind: undefined,
                by: undefined,
              });
            }}
          >
            {translate("files.search.clear")}
          </UI.Button>
        )
        : null}
    </>
  );
  return (
    <UI.Stack gap="compact" data-testid="files-search">
      <UI.SearchField
        aria-label={translate("files.search.label")}
        placeholder={translate("files.search.placeholder")}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setText("");
            onChange({ ...state, q: "" });
          }
        }}
      />
      {phone
        ? (
          <>
            <UI.Inline gap="compact">
              <UI.Button
                variant="secondary"
                aria-haspopup="dialog"
                onClick={() => setSheetOpen(true)}
              >
                {active > 0
                  ? translate("files.filters.buttonCount", { count: active })
                  : translate("files.filters.button")}
              </UI.Button>
            </UI.Inline>
            <UI.Sheet
              open={sheetOpen}
              onOpenChange={setSheetOpen}
              title={translate("files.filters.title")}
              dismissLabel={translate("files.filters.close")}
            >
              <UI.Stack gap="standard" data-controls="filters">
                {filterItems}
                <UI.Button
                  variant="primary"
                  onClick={() => setSheetOpen(false)}
                >
                  {translate("files.filters.show")}
                </UI.Button>
              </UI.Stack>
            </UI.Sheet>
          </>
        )
        : (
          <UI.Inline gap="compact" data-controls="filters">
            {filterItems}
          </UI.Inline>
        )}
    </UI.Stack>
  );
}

/** The hits of one search as a list; a file opens in its folder, a library item by its path. */
export function FileSearchResults(
  { state, folderPath, onOpen }: {
    readonly state: SearchState;
    /** The folder being browsed ("" at the top). */
    readonly folderPath: string;
    readonly onOpen: (hit: FileSearchHit) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale } = useI18n();
  const phone = useShellViewport() === "phone";
  const search = useInfiniteQuery({
    ...fileSearchQueryOptions(api, scope, {
      ...(state.q.trim() !== "" ? { query: state.q.trim() } : {}),
      ...(state.type !== undefined ? { mediaGroup: state.type } : {}),
      ...(state.kind !== undefined ? { kind: state.kind } : {}),
      ...(state.by !== undefined ? { producerId: state.by } : {}),
      ...(!state.everywhere && folderPath !== "" ? { path: folderPath } : {}),
    }),
    enabled: scope.organizationId !== null,
  });
  const hits = search.data?.pages.flatMap((page) => page.items) ?? [];
  if (search.isError) {
    return (
      <UI.AlertBanner tone="error">
        {translate("files.search.error")}{" "}
        <UI.Button variant="secondary" onClick={() => void search.refetch()}>
          {translate("files.retry")}
        </UI.Button>
      </UI.AlertBanner>
    );
  }
  if (search.isPending) {
    return <UI.Text role="status">{translate("files.loading")}</UI.Text>;
  }
  if (hits.length === 0) {
    return (
      <UI.EmptyState
        title={translate("files.search.none.title")}
        description={translate("files.search.none.description")}
      />
    );
  }
  const size = (hit: FileSearchHit) => {
    if (hit.sizeBytes === null) return "";
    const { value, unit } = sizeParts(hit.sizeBytes);
    return translate(`files.size.${unit}` as never, {
      value: formatNumber(value, locale, {
        maximumFractionDigits: unit === "bytes" ? 0 : 1,
      }),
    });
  };
  const where = (hit: FileSearchHit) =>
    hit.source === "library"
      ? translate("files.search.library")
      : hit.path.slice(0, hit.path.lastIndexOf("/")) || "/";
  const link = (hit: FileSearchHit) => (
    <UI.Link
      href={hit.path}
      variant="quiet"
      data-name="true"
      onClick={(event) => {
        event.preventDefault();
        onOpen(hit);
      }}
    >
      {hit.name}
    </UI.Link>
  );
  if (phone) {
    return (
      <UI.Stack gap="standard" data-testid="files-results">
        <UI.Stack
          gap="none"
          role="list"
          aria-label={translate("files.search.results")}
        >
          {hits.map((hit) => (
            <div
              key={`${hit.source}:${hit.path}`}
              role="listitem"
              data-hit-path={hit.path}
            >
              <UI.StackedRow title={link(hit)}>
                <UI.Text variant="caption">
                  {translate("files.search.column.where")}: {where(hit)}
                </UI.Text>
                <UI.Text variant="caption">
                  {translate("files.table.kind")}: {hit.kind}
                </UI.Text>
                {hit.producerName === null ? null : (
                  <UI.Text variant="caption">
                    {translate("files.search.column.madeBy")}:{" "}
                    {hit.producerName}
                  </UI.Text>
                )}
                {hit.sizeBytes === null ? null : (
                  <UI.Text variant="caption">
                    {translate("files.table.size")}: {size(hit)}
                  </UI.Text>
                )}
              </UI.StackedRow>
            </div>
          ))}
        </UI.Stack>
        {search.hasNextPage
          ? (
            <UI.Button
              variant="secondary"
              disabled={search.isFetchingNextPage}
              onClick={() => void search.fetchNextPage()}
            >
              {search.isFetchingNextPage
                ? translate("files.loadingMore")
                : translate("files.loadMore")}
            </UI.Button>
          )
          : null}
      </UI.Stack>
    );
  }
  return (
    <UI.Stack gap="standard" data-testid="files-results">
      <UI.DataTable<FileSearchHit>
        caption={translate("files.search.results")}
        captionHidden
        variant="ruled"
        inset="edge"
        rows={[...hits]}
        state="ready"
        getRowKey={(hit) => `${hit.source}:${hit.path}`}
        getRowAttributes={(hit) => ({ "data-hit-path": hit.path })}
        columns={[
          {
            id: "name",
            width: "30%",
            header: translate("files.search.column.name"),
            cell: (hit) => (
              <UI.Link
                href={hit.path}
                variant="quiet"
                data-name="true"
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(hit);
                }}
              >
                {hit.name}
              </UI.Link>
            ),
          },
          {
            id: "where",
            header: translate("files.search.column.where"),
            cell: (hit) => (
              <UI.Text variant="muted">
                {hit.source === "library"
                  ? translate("files.search.library")
                  : hit.path.slice(0, hit.path.lastIndexOf("/")) || "/"}
              </UI.Text>
            ),
          },
          {
            id: "kind",
            header: translate("files.table.kind"),
            cell: (hit) => hit.kind,
          },
          {
            id: "madeBy",
            header: translate("files.search.column.madeBy"),
            cell: (hit) => hit.producerName ?? "",
          },
          {
            id: "size",
            align: "end",
            header: translate("files.table.size"),
            cell: size,
          },
        ]}
      />
      {search.hasNextPage
        ? (
          <UI.Button
            variant="secondary"
            disabled={search.isFetchingNextPage}
            onClick={() => void search.fetchNextPage()}
          >
            {search.isFetchingNextPage
              ? translate("files.loadingMore")
              : translate("files.loadMore")}
          </UI.Button>
        )
        : null}
    </UI.Stack>
  );
}
