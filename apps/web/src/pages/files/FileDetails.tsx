import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { formatDate, formatNumber } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../../api/context.tsx";
import type {
  StorageFileUse,
  StorageFileVersion,
  StorageFolderItem,
} from "../../api/client.ts";
import {
  storageFileUsesQueryOptions,
  storageFileVersionsQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { sizeParts } from "./files-state.ts";

export type FileTab = "details" | "versions" | "uses";

/** One file's details: what it is, its versions, and the runs that used it. */
export function FileDetails(
  { file, tab, onTab, onClose }: {
    readonly file: StorageFolderItem;
    readonly tab: FileTab;
    readonly onTab: (tab: FileTab) => void;
    readonly onClose: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  const ready = scope.organizationId !== null;
  const versions = useInfiniteQuery({
    ...storageFileVersionsQueryOptions(api, scope, file.id),
    enabled: ready,
  });
  const uses = useInfiniteQuery({
    ...storageFileUsesQueryOptions(api, scope, file.id),
    enabled: ready && tab === "uses",
  });
  const versionRows = versions.data?.pages.flatMap((page) => page.items) ?? [];
  const useRows = uses.data?.pages.flatMap((page) => page.items) ?? [];
  const current = versionRows.find((version) => version.isCurrent) ?? null;

  const day = (value: string) =>
    formatDate(new Date(value), locale, { dateStyle: "medium", timeZone });
  const when = (value: string) =>
    formatDate(new Date(value), locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
  const size = (bytes: number) => {
    const { value, unit } = sizeParts(bytes);
    return translate(`files.size.${unit}` as never, {
      value: formatNumber(value, locale, {
        maximumFractionDigits: unit === "bytes" ? 0 : 1,
      }),
    });
  };
  const madeBy = (version: StorageFileVersion | null) => {
    if (version === null) return translate("files.madeBy.unknown");
    if (version.makerKind === "step" && version.stepName !== null) {
      return translate("files.madeBy.step", {
        step: version.stepName,
        item: version.workItemTitle ?? "",
      });
    }
    return version.makerName ?? translate("files.madeBy.unknown");
  };

  const more = (
    query: {
      hasNextPage: boolean;
      isFetchingNextPage: boolean;
      fetchNextPage: () => unknown;
    },
  ) =>
    query.hasNextPage
      ? (
        <UI.Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage
            ? translate("files.loadingMore")
            : translate("files.loadMore")}
        </UI.Button>
      )
      : null;

  const detailsTab = (
    <UI.Stack gap="standard">
      {current?.contentRemoved === true && current.removedAt !== null
        ? (
          <UI.InlineNotice tone="warning">
            {translate("files.removed", { date: day(current.removedAt) })}
          </UI.InlineNotice>
        )
        : null}
      <UI.DescriptionList>
        <UI.DescriptionItem
          title={translate("files.detail.path")}
          description={file.path}
        />
        <UI.DescriptionItem
          title={translate("files.detail.kind")}
          description={file.kindName ?? "—"}
        />
        <UI.DescriptionItem
          title={translate("files.detail.type")}
          description={file.mediaType ?? "—"}
        />
        <UI.DescriptionItem
          title={translate("files.detail.size")}
          description={file.sizeBytes === null ? "—" : size(file.sizeBytes)}
        />
        <UI.DescriptionItem
          title={translate("files.detail.changed")}
          description={when(file.updatedAt)}
        />
        <UI.DescriptionItem
          title={translate("files.detail.madeBy")}
          description={versions.isPending ? "…" : madeBy(current)}
        />
      </UI.DescriptionList>
    </UI.Stack>
  );

  const note = file.policy === "record"
    ? translate("files.versions.note.record")
    : file.policy === "scratch"
    ? translate("files.versions.note.scratch")
    : translate("files.versions.note.working");

  const versionsTab = versions.isError
    ? (
      <UI.AlertBanner tone="error">
        {translate("files.panel.error")}
      </UI.AlertBanner>
    )
    : versionRows.length === 0 && !versions.isPending
    ? <UI.Text variant="muted">{translate("files.versions.empty")}</UI.Text>
    : (
      <UI.Stack gap="standard">
        <UI.DescriptionList>
          {versionRows.map((version) => (
            <UI.DescriptionItem
              key={version.id}
              title={translate("files.version.title", {
                number: version.revision,
              })}
              description={version.contentRemoved && version.removedAt !== null
                ? translate("files.version.removed", {
                  date: day(version.removedAt),
                })
                : translate("files.version.line", {
                  when: when(version.createdAt),
                  who: madeBy(version),
                  size: size(version.sizeBytes),
                })}
              action={version.isCurrent
                ? (
                  <UI.Badge tone="information">
                    {translate("files.version.current")}
                  </UI.Badge>
                )
                : undefined}
            />
          ))}
        </UI.DescriptionList>
        {more(versions)}
        <UI.Text variant="muted">{note}</UI.Text>
      </UI.Stack>
    );

  const useLine = (use: StorageFileUse) =>
    use.inputName === null
      ? translate("files.use.lineNoInput", {
        number: use.revision,
        when: when(use.usedAt),
      })
      : translate("files.use.line", {
        input: use.inputName,
        number: use.revision,
        when: when(use.usedAt),
      });
  const UseTitle = ({ use }: { readonly use: StorageFileUse }) => {
    const navigate = useNavigate();
    return (
      <UI.Link
        href={`/tasks/${use.workItemId}`}
        variant="quiet"
        onClick={(event) => {
          event.preventDefault();
          void navigate({
            to: "/tasks/$taskId",
            params: { taskId: use.workItemId },
          });
        }}
      >
        {use.workItemTitle}
      </UI.Link>
    );
  };
  const usesTab = uses.isError
    ? (
      <UI.AlertBanner tone="error">
        {translate("files.panel.error")}
      </UI.AlertBanner>
    )
    : useRows.length === 0 && !uses.isPending
    ? (
      <UI.EmptyState
        title={translate("files.uses.empty.title")}
        description={translate("files.uses.empty.description")}
      />
    )
    : (
      <UI.Stack gap="standard">
        <UI.DescriptionList>
          {useRows.map((use) => (
            <UI.DescriptionItem
              key={use.id}
              title={<UseTitle use={use} />}
              description={useLine(use)}
            />
          ))}
        </UI.DescriptionList>
        {more(uses)}
        <UI.Text variant="muted">{translate("files.uses.note")}</UI.Text>
      </UI.Stack>
    );

  return (
    <UI.Stack gap="standard" data-testid="file-details">
      <UI.Inline variant="between" gap="compact">
        <UI.Stack gap="none">
          <UI.Heading level="section">
            {file.displayName ?? file.name}
          </UI.Heading>
          <UI.Text variant="caption">{file.path}</UI.Text>
        </UI.Stack>
        <UI.Button variant="secondary" onClick={onClose}>
          {translate("files.details.close")}
        </UI.Button>
      </UI.Inline>
      <UI.Tabs
        aria-label={translate("files.tab.label")}
        selectedId={tab}
        onSelect={(id) => onTab(id as FileTab)}
        tabs={[
          {
            id: "details",
            label: translate("files.tab.details"),
            content: detailsTab,
          },
          {
            id: "versions",
            label: translate("files.tab.versions"),
            content: versionsTab,
          },
          {
            id: "uses",
            label: translate("files.tab.uses"),
            content: usesTab,
          },
        ]}
      />
    </UI.Stack>
  );
}
