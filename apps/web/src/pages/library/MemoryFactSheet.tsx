import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { MemoryEntryResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { memoryRevisionsQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { ShellSlot } from "../../shell/shell-slots.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { MemoryFactActions } from "./MemoryFactActions.tsx";
import {
  confidenceBand,
  type MemoryBadge,
  memoryBadge,
  sourceLine,
} from "./memory-state.ts";

/** The badge's tone: a fact in use is success; amber is only for a suggestion waiting on a person. */
export function memoryBadgeTone(
  badge: MemoryBadge,
): "neutral" | "success" | "warning" {
  return badge === "inUse"
    ? "success"
    : badge === "suggested"
    ? "warning"
    : "neutral";
}

/**
 * One remembered fact (design-ux, #72): the wording, where it came from, how
 * sure Bakery was, when it expires and every wording it has had. Read-only in
 * this slice; the entry already carries its current revision, so only the
 * history is read here.
 */
export function MemoryFactSheet(
  { canManage, entry, onClose, onOpenSource, phone, repositoryName }: {
    readonly canManage: boolean;
    readonly entry: MemoryEntryResponse;
    readonly onClose: () => void;
    /** Opens the source document at its cited version (a path in this app). */
    readonly onOpenSource: (href: string) => void;
    readonly phone: boolean;
    readonly repositoryName: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { locale, timeZone, translate } = useI18n();
  const revisions = useQuery(memoryRevisionsQueryOptions(api, scope, entry.id));
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  // The source box reads the fact from the list, so a retry reads the list again
  // (and the history with it), not only the history.
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["protected"] });
  const current = entry.currentRevision;
  const badge = memoryBadge(entry);
  // The current wording carries the fact's own state, not always "In use".
  const stateBadge = entry.status === "proposed"
    ? "suggested"
    : entry.status === "retired"
    ? "noLongerUsed"
    : "inUse";
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!phone) panelRef.current?.focus();
  }, [phone]);
  const title = translate("library.memory.fact.title" as never);
  const close = translate("library.memory.fact.close" as never);
  const source = sourceLine(entry);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(iso),
    );

  // The cited version opens in the files browser; only an available source has
  // a version this reader may open (the id is null for no access).
  const sourceVersionId = current?.sourceArtifactVersionId ?? null;
  const sourceHref = source.kind === "available" && sourceVersionId !== null
    ? `/files/versions/${sourceVersionId}`
    : null;
  const sourceText = source.kind === "available"
    ? translate("library.memory.source.boxAvailable" as never, {
      name: source.name,
      version: source.revision,
    })
    : "";
  const sourceBox = source.kind === "available"
    ? (
      <UI.Stack gap="tight" data-testid="memory-source">
        {sourceHref === null ? <UI.Text>{sourceText}</UI.Text> : (
          <>
            <UI.Text>
              <UI.Link
                variant="sentence"
                href={sourceHref}
                onClick={(event) => {
                  // Let a modified click (new tab) go to the browser.
                  if (
                    event.metaKey || event.ctrlKey || event.shiftKey ||
                    event.button !== 0
                  ) return;
                  event.preventDefault();
                  onOpenSource(sourceHref);
                }}
              >
                {sourceText}
              </UI.Link>
            </UI.Text>
            <UI.Text variant="muted">
              {translate("library.memory.source.exactVersion" as never)}
            </UI.Text>
          </>
        )}
      </UI.Stack>
    )
    : (
      <UI.InlineNotice
        tone="neutral"
        data-testid="memory-source"
        action={source.kind === "unknown"
          ? (
            <UI.Button
              variant="secondary"
              disabled={checking}
              onClick={() => {
                setChecking(true);
                void refresh().finally(() => setChecking(false));
              }}
            >
              {translate(
                (checking
                  ? "library.memory.source.checking"
                  : "library.memory.source.retry") as never,
              )}
            </UI.Button>
          )
          : undefined}
      >
        <UI.Stack gap="tight">
          <UI.Text>
            <strong>
              {translate(
                `library.memory.source.${source.kind}.title` as never,
              )}
            </strong>
          </UI.Text>
          <UI.Text>
            {translate(`library.memory.source.${source.kind}.body` as never)}
          </UI.Text>
        </UI.Stack>
      </UI.InlineNotice>
    );

  const history = [...(revisions.data ?? [])].sort((a, b) =>
    b.revision - a.revision
  );
  const content = (
    <UI.Stack gap="standard">
      <UI.Inline gap="compact">
        <UI.Badge tone={memoryBadgeTone(badge)}>
          {translate(`library.memory.badge.${badge}` as never)}
        </UI.Badge>
        {repositoryName === null ? null : (
          <UI.Text variant="muted">
            {translate("library.memory.repository" as never, {
              name: repositoryName,
            })}
          </UI.Text>
        )}
      </UI.Inline>
      <UI.Text data-testid="memory-fact-body">
        {current?.body ?? ""}
      </UI.Text>
      <UI.Heading level="section">
        {translate("library.memory.fact.source" as never)}
      </UI.Heading>
      {sourceBox}
      {current === null ? null : (
        <UI.Stack gap="tight">
          <UI.Text>
            <strong>
              {translate("library.memory.fact.howSure" as never)}
            </strong>{" "}
            {translate(
              `library.memory.confidence.${
                confidenceBand(current.confidence)
              }` as never,
            )}
          </UI.Text>
          <UI.Text variant="muted">
            {translate("library.memory.fact.howSureHelp" as never)}
          </UI.Text>
          <UI.Text>
            <strong>
              {translate("library.memory.fact.expires" as never)}
            </strong>{" "}
            {current.expiresAt === null
              ? translate("library.memory.fact.never" as never)
              : date(current.expiresAt)}
          </UI.Text>
        </UI.Stack>
      )}
      <MemoryFactActions canManage={canManage} entry={entry} phone={phone} />
      <UI.Heading level="section">
        {translate("library.memory.fact.history" as never)}
      </UI.Heading>
      {revisions.isPending
        ? (
          <UI.Text variant="muted" role="status">
            {translate("library.memory.fact.historyLoading" as never)}
          </UI.Text>
        )
        : revisions.isError
        ? (
          <UI.InlineNotice tone="error">
            {translate("library.memory.fact.historyError" as never)}
          </UI.InlineNotice>
        )
        : (
          <UI.Stack gap="standard" role="list" data-testid="memory-history">
            {history.map((revision) => (
              <UI.Stack gap="tight" role="listitem" key={revision.id}>
                <UI.Text
                  variant={revision.id === current?.id ? undefined : "muted"}
                >
                  {revision.body}
                </UI.Text>
                <UI.Text variant="caption">
                  {[
                    revision.id === current?.id
                      ? translate(
                        `library.memory.badge.${stateBadge}` as never,
                      )
                      : translate("library.memory.fact.earlier" as never),
                    revision.createdByName === null ||
                      revision.createdByName === undefined
                      ? null
                      : translate("library.memory.fact.by" as never, {
                        name: revision.createdByName,
                      }),
                    date(revision.createdAt),
                    revision.reason === null ||
                      revision.reason === undefined
                      ? null
                      : translate("library.memory.fact.reason" as never, {
                        reason: revision.reason,
                      }),
                  ].filter((part) =>
                    part !== null
                  ).join(" · ")}
                </UI.Text>
              </UI.Stack>
            ))}
          </UI.Stack>
        )}
    </UI.Stack>
  );
  // A phone gets a bottom sheet; a wider screen keeps the list in view beside
  // the fact, in the shell's inspector column with no backdrop.
  if (phone) {
    return (
      <UI.Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={title}
        dismissLabel={close}
        variant="bottom"
        data-testid="memory-fact"
      >
        {content}
      </UI.Sheet>
    );
  }
  return (
    <ShellSlot name="inspector" size="medium">
      <UI.InspectorPanel label={title} variant="column">
        <div
          ref={panelRef}
          tabIndex={-1}
          data-testid="memory-fact"
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
          }}
        >
          <UI.Stack gap="standard">
            <UI.Inline gap="compact">
              <UI.Heading level="section">{title}</UI.Heading>
              <UI.Button variant="quiet" onClick={onClose}>{close}</UI.Button>
            </UI.Inline>
            {content}
          </UI.Stack>
        </div>
      </UI.InspectorPanel>
    </ShellSlot>
  );
}

/**
 * A link to a fact that cannot be shown: gone or not yours to see (both read
 * the same, so the page says nothing about which), or not loaded. It opens in
 * the same place a fact would, with Close.
 */
export function MemoryFactProblem(
  { kind, onClose, onRetry, phone }: {
    readonly kind: "missing" | "failed";
    readonly onClose: () => void;
    readonly onRetry: () => void;
    readonly phone: boolean;
  },
) {
  const { translate } = useI18n();
  const title = translate(
    (kind === "missing"
      ? "library.memory.fact.notFoundTitle"
      : "library.memory.fact.loadErrorTitle") as never,
  );
  const close = translate("library.memory.fact.close" as never);
  const body = (
    <UI.Stack gap="standard" data-testid="memory-fact-missing">
      {phone ? null : <UI.Heading level="section">{title}</UI.Heading>}
      <UI.Text>
        {translate(
          (kind === "missing"
            ? "library.memory.fact.notFoundBody"
            : "library.memory.fact.loadErrorBody") as never,
        )}
      </UI.Text>
      <UI.Inline gap="compact">
        {kind === "failed"
          ? (
            <UI.Button variant="secondary" onClick={onRetry}>
              {translate("library.memory.source.retry" as never)}
            </UI.Button>
          )
          : null}
        <UI.Button variant="secondary" onClick={onClose}>{close}</UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
  if (phone) {
    return (
      <UI.Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={title}
        dismissLabel={close}
        variant="bottom"
      >
        {body}
      </UI.Sheet>
    );
  }
  return (
    <ShellSlot name="inspector" size="medium">
      <UI.InspectorPanel label={title} variant="column">
        {body}
      </UI.InspectorPanel>
    </ShellSlot>
  );
}
