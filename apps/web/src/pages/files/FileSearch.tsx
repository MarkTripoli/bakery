import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { formatNumber } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { FileSearchHit } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  fileFactsQueryOptions,
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
  /** One fact of the chosen kind, as `key:value`; only meaningful with a kind. */
  readonly fact: string | undefined;
  readonly everywhere: boolean;
};

/** A search runs from two letters, or as soon as a filter is set. */
export function isSearching(state: SearchState): boolean {
  return state.q.trim().length >= 2 || state.type !== undefined ||
    state.kind !== undefined || state.by !== undefined ||
    state.fact !== undefined;
}

/** A `key:value` fact split at its first colon, so a value may hold one. */
export function splitFact(
  fact: string | undefined,
): { factKey: string; factValue: string } | null {
  if (fact === undefined) return null;
  const at = fact.indexOf(":");
  if (at <= 0) return null;
  return { factKey: fact.slice(0, at), factValue: fact.slice(at + 1) };
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
  // Facts belong to a kind, so they are only read once a kind is chosen.
  const facts = useQuery({
    ...fileFactsQueryOptions(api, scope, state.kind ?? ""),
    enabled: state.kind !== undefined,
  });
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
  const factName = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
  const factOptions: { value: string; label: string }[] = [
    { value: "", label: translate("files.search.fact.any") },
  ];
  for (const fact of facts.data?.items ?? []) {
    const value = `${fact.key}:${fact.value}`;
    if (factOptions.some((option) => option.value === value)) continue;
    factOptions.push({
      value,
      label: translate("files.search.fact.is", {
        name: factName(fact.key),
        value: fact.value,
      }),
    });
  }
  if (
    state.fact !== undefined &&
    !factOptions.some((option) => option.value === state.fact)
  ) {
    factOptions.push({ value: state.fact, label: state.fact });
  }
  // Everyone who can have made a file, disabled accounts included: their files
  // are still there to find, so they are listed and marked, not hidden.
  const principals = people.data?.items ?? [];
  const byOptions = [
    { value: "", label: translate("files.search.by.any") },
    ...[
      ...principals.filter((item) => item.principalType === "human"),
      ...principals.filter((item) => item.principalType !== "human"),
    ].map((item) => ({
      value: item.id,
      label: item.disabledAt === null
        ? item.displayName
        : translate("files.search.by.disabled", { name: item.displayName }),
    })),
  ];
  if (
    state.by !== undefined &&
    !byOptions.some((option) => option.value === state.by)
  ) {
    // An id nobody lists (an account that is gone): a plain word, never the id.
    byOptions.push({
      value: state.by,
      label: translate("files.search.by.unknown"),
    });
  }
  const [text, setText] = useState(state.q);
  useEffect(() => setText(state.q), [state.q]);
  // One writer for the address. Typed text is committed after a short pause;
  // any other change (a filter, Clear filters) commits the text itself and
  // cancels that pause. A timer left running would fire with the filters it saw
  // when it was armed and write them back over a change made after it, which is
  // how "Clear filters" could be undone a quarter of a second later.
  const pending = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(
    undefined,
  );
  const cancelPending = () => {
    if (pending.current === undefined) return;
    globalThis.clearTimeout(pending.current);
    pending.current = undefined;
  };
  useEffect(() => {
    if (text === state.q) return;
    pending.current = globalThis.setTimeout(() => {
      pending.current = undefined;
      onChange({ ...state, q: text });
    }, 250);
    return cancelPending;
  }, [text, state, onChange]);
  const change = (patch: Partial<SearchState>) => {
    cancelPending();
    onChange({ ...state, q: text, ...patch });
  };
  const phone = useShellViewport() === "phone";
  const [sheetOpen, setSheetOpen] = useState(false);
  const active =
    [state.type, state.kind, state.by, state.fact].filter((value) =>
      value !== undefined
    )
      .length + (state.everywhere && !atTop ? 1 : 0);
  const anySet = state.q !== "" || state.type !== undefined ||
    state.kind !== undefined || state.by !== undefined ||
    state.fact !== undefined;
  // The button says what it clears: the text, the filters, or both.
  const textSet = state.q !== "";
  const filterSet = state.type !== undefined || state.kind !== undefined ||
    state.by !== undefined || state.fact !== undefined;
  const clearLabel = textSet && filterSet
    ? translate("files.search.clearBoth")
    : textSet
    ? translate("files.search.clear")
    : translate("files.filters.clear");
  const clearSearch = anySet
    ? (
      <UI.Button
        variant="secondary"
        onClick={() => {
          setText("");
          change({
            q: "",
            type: undefined,
            kind: undefined,
            by: undefined,
            fact: undefined,
          });
        }}
      >
        {clearLabel}
      </UI.Button>
    )
    : null;
  const filtersSet = state.type !== undefined || state.kind !== undefined ||
    state.by !== undefined || state.fact !== undefined ||
    (state.everywhere && !atTop);
  const filterItems = (
    <>
      {atTop ? null : (
        <UI.Combobox
          label={translate("files.search.where")}
          value={state.everywhere ? "all" : "folder"}
          onChange={(event) =>
            change({ everywhere: event.currentTarget.value === "all" })}
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
          change({
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
          // A fact belongs to a kind, so changing the kind drops it.
          change({ kind: value === "" ? undefined : value, fact: undefined });
        }}
        options={kindOptions}
      />
      <UI.Combobox
        label={translate("files.search.fact")}
        help={
          <UI.HelpTip label={translate("files.search.fact.helpLabel")}>
            {translate("files.search.fact.help")}
          </UI.HelpTip>
        }
        value={state.kind === undefined ? "" : state.fact ?? ""}
        disabled={state.kind === undefined}
        onChange={(event) => {
          const value = event.currentTarget.value;
          change({ fact: value === "" ? undefined : value });
        }}
        options={state.kind === undefined
          ? [{ value: "", label: translate("files.search.fact.chooseKind") }]
          : factOptions}
      />
      <UI.Combobox
        label={translate("files.search.by")}
        value={state.by ?? ""}
        onChange={(event) => {
          const value = event.currentTarget.value;
          change({ by: value === "" ? undefined : value });
        }}
        options={byOptions}
      />
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
            change({ q: "" });
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
              {clearSearch}
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
                  variant="secondary"
                  disabled={!filtersSet}
                  onClick={() =>
                    change({
                      type: undefined,
                      kind: undefined,
                      by: undefined,
                      fact: undefined,
                      everywhere: false,
                    })}
                >
                  {translate("files.filters.clear")}
                </UI.Button>
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
            {clearSearch}
          </UI.Inline>
        )}
    </UI.Stack>
  );
}

/** The catalog kinds the Library copy names, which have words of their own. */
const LIBRARY_KINDS: readonly string[] = [
  "skill",
  "agent",
  "workflow",
  "kind",
  "package",
];

/**
 * Where a Library hit opens: its own page for a workflow or an agent, which is
 * what the folder table opens too. Any other hit has no page of its own and
 * opens the folder it sits in, as does a hit with no id.
 */
export function libraryItemTarget(hit: FileSearchHit):
  | {
    readonly to: "/library/workflows/$workflowId";
    readonly params: { readonly workflowId: string };
  }
  | {
    readonly to: "/library/agents/$agentId";
    readonly params: { readonly agentId: string };
  }
  | null {
  if (hit.source !== "library" || hit.itemId === null) return null;
  if (hit.kind === "workflow") {
    return {
      to: "/library/workflows/$workflowId",
      params: { workflowId: hit.itemId },
    };
  }
  if (hit.kind === "agent") {
    return {
      to: "/library/agents/$agentId",
      params: { agentId: hit.itemId },
    };
  }
  return null;
}

/** The address of that page, for the link's own href. */
export function libraryItemHref(hit: FileSearchHit): string | null {
  const target = libraryItemTarget(hit);
  if (target === null) return null;
  return target.to === "/library/workflows/$workflowId"
    ? `/library/workflows/${target.params.workflowId}`
    : `/library/agents/${target.params.agentId}`;
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
      ...(splitFact(state.fact) ?? {}),
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
    // The hint names what is set: letters, filters, or both, and offers
    // All files only while the search is still limited to a folder.
    const textSet = state.q.trim() !== "";
    const filterSet = state.type !== undefined || state.kind !== undefined ||
      state.by !== undefined || state.fact !== undefined;
    const set = textSet && filterSet ? "both" : filterSet ? "filters" : "text";
    const where = !state.everywhere && folderPath !== "" ? "folder" : "all";
    return (
      <UI.EmptyState
        title={translate("files.search.none.title")}
        description={translate(`files.search.none.${set}.${where}` as never)}
      />
    );
  }
  const size = (hit: FileSearchHit) => {
    if (hit.sizeBytes === null) return translate("files.size.none");
    const { value, unit } = sizeParts(hit.sizeBytes);
    return translate(`files.size.${unit}` as never, {
      value: formatNumber(value, locale, {
        maximumFractionDigits: unit === "bytes" ? 0 : 1,
      }),
    });
  };
  // A Library hit's kind is the catalog's word for it ("workflow"), which the
  // folder table one click away writes as "Workflow"; the two must agree.
  const kindName = (hit: FileSearchHit) =>
    hit.source === "library" && LIBRARY_KINDS.includes(hit.kind)
      ? translate(`files.library.kind.${hit.kind}` as never)
      : hit.kind;
  const where = (hit: FileSearchHit) =>
    hit.source === "library"
      ? translate("files.search.library")
      : hit.path.slice(0, hit.path.lastIndexOf("/")) || "/";
  const link = (hit: FileSearchHit) => (
    <UI.Link
      href={libraryItemHref(hit) ?? hit.path}
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
                  {translate("files.table.kind")}: {kindName(hit)}
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
                href={libraryItemHref(hit) ?? hit.path}
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
            cell: kindName,
          },
          {
            id: "madeBy",
            header: translate("files.search.column.madeBy"),
            cell: (hit) => hit.producerName ?? translate("files.kind.none"),
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
