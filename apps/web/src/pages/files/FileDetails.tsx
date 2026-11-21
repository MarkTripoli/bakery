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
import { FilePreview, previewKind } from "./FilePreview.tsx";
import { mismatchSubject } from "./mismatch-selection.ts";
import { refusedDownload } from "./media-failure.ts";
import { offersDownload } from "../preview-actions.ts";
import { type ReactNode, useState } from "react";

export type FileTab = "details" | "versions" | "uses";

/** One file's details: what it is, its versions, and the runs that used it. */
export function FileDetails(
  {
    file,
    tab,
    onTab,
    onClose,
    revision,
    onRevision,
    phone,
    backLabel,
    opened,
    onOpenView,
    onCloseView,
  }: {
    readonly file: StorageFolderItem;
    /** On a phone the file is a page of its own, with a back link. */
    readonly phone: boolean;
    readonly backLabel: string;
    readonly tab: FileTab;
    readonly onTab: (tab: FileTab) => void;
    readonly onClose: () => void;
    /** The version number being shown; undefined for the current version. */
    readonly revision: number | undefined;
    readonly onRevision: (revision: number | undefined) => void;
    /** The file is opened full size: in the page column, or on a phone in this page. */
    readonly opened: boolean;
    readonly onOpenView: () => void;
    readonly onCloseView: () => void;
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
  const navigate = useNavigate();
  const [downloadFailed, setDownloadFailed] = useState(false);
  // Whether the file has anything to open, as its preview reports it.
  const [openable, setOpenable] = useState(true);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [moreOpen, setMoreOpen] = useState(false);
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    setMoreOpen(false);
  };
  const download = async () => {
    setDownloadFailed(false);
    if (scope.organizationId === null) return;
    const result = await api.files.content(
      scope.organizationId,
      file.id,
      shown?.revision,
    );
    if (!result.ok) {
      // A refused read is not a download that failed: the bytes and the record
      // disagree, and that is the same refusal the preview shows. Keeping it here
      // means the panel says one thing, and stops offering to save the bytes.
      if (refusedDownload(result.error) === "mismatch") {
        setBytesMismatch(true);
        return;
      }
      setDownloadFailed(true);
      return;
    }
    if (result.data.status !== 200 || result.data.content === null) {
      setDownloadFailed(true);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(result.data.content)], {
        type: shown?.mediaType ?? file.mediaType ?? "application/octet-stream",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  };
  const versionRows = versions.data?.pages.flatMap((page) => page.items) ?? [];
  const useRows = uses.data?.pages.flatMap((page) => page.items) ?? [];
  const current = versionRows.find((version) => version.isCurrent) ?? null;
  // An older version being looked at; the current one is the plain file.
  // The preview says when the bytes and the record disagree; this panel must not
  // offer to save them, since the design promises exactly that (#437).
  const [bytesMismatch, setBytesMismatch] = useState(false);
  // A refusal belongs to the file and version that was refused. Selecting
  // another one starts clean, or one refusal would blame every file opened in
  // this panel until it closes (#437 review).
  const subject = mismatchSubject(file.id, revision);
  const [mismatchFor, setMismatchFor] = useState(subject);
  if (mismatchFor !== subject) {
    setMismatchFor(subject);
    setBytesMismatch(false);
    setDownloadFailed(false);
    setMoreOpen(false);
  }

  const shown = revision === undefined || revision === current?.revision
    ? null
    : versionRows.find((version) => version.revision === revision) ?? null;
  // With Download gone, "More" would open a menu with one item in it: on a phone
  // the path itself becomes the button (#437, UX review).
  const downloadWithheld = !offersDownload({
    mismatch: bytesMismatch,
    contentRemoved: shown?.contentRemoved ?? file.contentRemoved,
  });

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
  const madeBy = (version: StorageFileVersion | null): ReactNode => {
    if (version === null) return translate("files.madeBy.unknown");
    if (version.makerKind === "step" && version.stepName !== null) {
      const item = version.workItemTitle ?? "";
      const taskId = version.workItemId;
      const parts = translate("files.madeBy.step", {
        step: version.stepName,
        item: "\u0000",
      }).split("\u0000");
      return (
        <>
          {parts[0]}
          {taskId === null ? item : (
            <UI.Link
              href={`/tasks/${taskId}`}
              variant="quiet"
              aria-label={translate("files.madeBy.openItem", { item })}
              onClick={(event) => {
                event.preventDefault();
                void navigate({ to: "/tasks/$taskId", params: { taskId } });
              }}
            >
              {item}
            </UI.Link>
          )}
          {parts[1] ?? ""}
        </>
      );
    }
    if (version.makerKind === "agent") {
      return (
        <UI.Stack gap="none">
          {madeByText(version)}
          <UI.Text variant="muted">
            {version.makerName === null
              ? translate("files.madeBy.agentAccessUnknown")
              : translate("files.madeBy.agentAccess", {
                person: version.makerName,
              })}
          </UI.Text>
        </UI.Stack>
      );
    }
    return version.makerName ?? translate("files.madeBy.unknown");
  };
  // A run step or an agent's session wrote it: the Agent badge and row name.
  const byAgent = (version: StorageFileVersion): boolean =>
    version.makerKind === "agent" || version.makerKind === "step";
  // The "who or what" line as text, for a row whose description is a string.
  const madeByText = (version: StorageFileVersion | null): string => {
    if (version === null) return translate("files.madeBy.unknown");
    if (version.makerKind === "step" && version.stepName !== null) {
      return translate("files.madeBy.step", {
        step: version.stepName,
        item: version.workItemTitle ?? "",
      });
    }
    if (version.makerKind === "agent") {
      // An agent's version never reads as the person's own (#448).
      // With no person recorded, the sentence never names "Not recorded".
      const person = version.makerName;
      if (person === null) {
        return version.agentName === null
          ? translate("files.madeBy.agentAlone")
          : translate("files.madeBy.agentOnly", { agent: version.agentName });
      }
      return version.agentName === null
        ? translate("files.madeBy.agentUnnamed", { person })
        : translate("files.madeBy.agent", {
          agent: version.agentName,
          person,
        });
    }
    return version.makerName ?? translate("files.madeBy.unknown");
  };
  // A work item's document opens on its artifact page, where comments live.
  const artifactTarget = file.artifactId !== null && current?.workItemId
    ? { taskId: current.workItemId, artifactId: file.artifactId }
    : null;
  // Open is offered only where there is something to open: not for a file with
  // no preview, one too large or unreadable, or a video that cannot be played.
  // A phone's file page already shows a picture or a player at full width, so
  // only text, which it cuts to its first lines, has more to open there.
  const showOpen = !(shown?.contentRemoved ?? file.contentRemoved) &&
    openable &&
    (phone
      ? previewKind(shown?.mediaType ?? file.mediaType) === "text"
      : !opened);

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
          <UI.InlineNotice tone="neutral">
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
              onSelect={() =>
                onRevision(version.isCurrent ? undefined : version.revision)}
              aria-label={translate(
                byAgent(version)
                  ? "files.version.chooseAgent"
                  : "files.version.choose",
                { number: version.revision },
              )}
              title={
                <UI.Inline gap="compact">
                  {translate("files.version.title", {
                    number: version.revision,
                  })}
                  {version.isCurrent
                    ? (
                      <UI.Badge tone="information">
                        {translate("files.version.current")}
                      </UI.Badge>
                    )
                    : null}
                  {!byAgent(version) ? null : (
                    <UI.Inline gap="compact">
                      <UI.Badge tone="neutral">
                        {translate("files.version.agentBadge")}
                      </UI.Badge>
                      <UI.HelpTip
                        label={translate("files.version.agentHelpLabel")}
                        placement="above"
                      >
                        {translate("files.version.agentHelp")}
                      </UI.HelpTip>
                    </UI.Inline>
                  )}
                  {shown?.revision === version.revision
                    ? (
                      <UI.Badge tone="neutral">
                        {translate("files.version.viewing")}
                      </UI.Badge>
                    )
                    : null}
                </UI.Inline>
              }
              description={version.contentRemoved && version.removedAt !== null
                ? translate("files.version.removed", {
                  date: day(version.removedAt),
                })
                : translate("files.version.line", {
                  when: when(version.createdAt),
                  who: madeByText(version),
                  size: size(version.sizeBytes),
                })}
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
      {phone
        ? (
          <UI.Link
            href="#back"
            variant="back"
            onClick={(event) => {
              event.preventDefault();
              onClose();
            }}
          >
            {backLabel}
          </UI.Link>
        )
        : null}
      <UI.Inline variant="between" gap="compact" data-header="named">
        <UI.Stack gap="none">
          <UI.Heading level="section">
            {file.displayName ?? file.name}
          </UI.Heading>
          <UI.Text variant="caption">{file.path}</UI.Text>
        </UI.Stack>
        {phone ? null : (
          <UI.Button variant="secondary" onClick={onClose}>
            {translate("files.details.close")}
          </UI.Button>
        )}
      </UI.Inline>
      {shown !== null
        ? (
          <UI.Stack gap="compact">
            <UI.InlineNotice tone="information">
              {translate("files.version.notice", {
                number: shown.revision,
                total: current?.revision ?? versionRows.length,
                when: when(shown.createdAt),
              })}
            </UI.InlineNotice>
            <UI.Inline>
              <UI.Button
                variant="secondary"
                onClick={() => onRevision(undefined)}
              >
                {translate("files.version.backToCurrent")}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        )
        : null}
      {opened && !phone ? null : (
        <FilePreview
          file={file}
          version={shown}
          full={opened && phone}
          onOpenable={setOpenable}
          onMismatch={setBytesMismatch}
          downloadRefused={bytesMismatch}
        />
      )}
      <UI.Inline gap="compact">
        {artifactTarget !== null
          ? (
            <UI.Button
              variant="primary"
              onClick={() =>
                void navigate({
                  to: "/tasks/$taskId/artifacts/$artifactId",
                  params: artifactTarget,
                })}
            >
              {translate("files.action.open")}
            </UI.Button>
          )
          : showOpen
          ? (
            <UI.Button
              variant="primary"
              aria-pressed={phone ? opened : undefined}
              onClick={phone && opened ? onCloseView : onOpenView}
            >
              {phone && opened
                ? translate("files.action.showLess")
                : translate("files.action.open")}
            </UI.Button>
          )
          : null}
        {(shown?.contentRemoved ?? file.contentRemoved) || downloadWithheld
          ? null
          : (
            <UI.Button
              // The first button in the row is the primary one: Download, when
              // there is nothing to open (or the file is already open).
              variant={artifactTarget !== null || showOpen
                ? "secondary"
                : "primary"}
              onClick={() => void download()}
            >
              {shown === null
                ? translate("files.action.download")
                : translate("files.action.downloadVersion")}
            </UI.Button>
          )}
        {phone && !downloadWithheld
          ? (
            <UI.Button
              variant="secondary"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(!moreOpen)}
            >
              {translate("files.action.more")}
            </UI.Button>
          )
          : (
            <UI.Button
              variant="secondary"
              aria-label={translate("files.action.copyPathLabel", {
                name: file.name,
              })}
              onClick={() => void copyPath()}
            >
              {copy === "copied"
                ? translate("files.action.copied")
                : translate("files.action.copyPath")}
            </UI.Button>
          )}
      </UI.Inline>
      {phone && moreOpen && !downloadWithheld
        ? (
          <UI.Menu
            aria-label={translate("files.action.moreLabel")}
            items={[{
              id: "copy",
              label: translate("files.action.copyPath"),
            }]}
            onSelect={() => void copyPath()}
          />
        )
        : null}
      {copy === "failed"
        ? (
          <UI.Text variant="muted" role="status">
            {translate("files.action.copyFailed")}
          </UI.Text>
        )
        : null}
      {copy === "copied" && phone
        ? (
          <UI.Text variant="muted" role="status">
            {translate("files.action.copied")}
          </UI.Text>
        )
        : null}
      {downloadFailed
        ? (
          <UI.InlineNotice tone="error">
            {translate("files.action.downloadFailed")}
          </UI.InlineNotice>
        )
        : null}
      <UI.Tabs
        variant="route"
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
