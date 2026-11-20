import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { MemoryEntryResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { memoryRevisionsQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { MemoryFactActions } from "./MemoryFactActions.tsx";
import {
  confidenceBand,
  type MemoryBadge,
  memoryBadge,
  sourceLine,
} from "./memory-state.ts";

/** The badge's tone: only a fact in use is success; one with a missing source needs a look. */
export function memoryBadgeTone(
  badge: MemoryBadge,
): "neutral" | "success" | "warning" {
  return badge === "inUse"
    ? "success"
    : badge === "noLongerUsed"
    ? "neutral"
    : "warning";
}

/**
 * One remembered fact (design-ux, #72): the wording, where it came from, how
 * sure Bakery was, when it expires and every wording it has had. Read-only in
 * this slice; the entry already carries its current revision, so only the
 * history is read here.
 */
export function MemoryFactSheet(
  { canManage, entry, onClose, phone, repositoryName }: {
    readonly canManage: boolean;
    readonly entry: MemoryEntryResponse;
    readonly onClose: () => void;
    readonly phone: boolean;
    readonly repositoryName: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { locale, timeZone, translate } = useI18n();
  const revisions = useQuery(memoryRevisionsQueryOptions(api, scope, entry.id));
  const current = entry.currentRevision;
  const badge = memoryBadge(entry);
  const source = sourceLine(entry);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(iso),
    );

  const sourceBox = source.kind === "available"
    ? (
      <UI.InlineNotice tone="neutral" data-testid="memory-source">
        <UI.Stack gap="tight">
          <UI.Text>
            {translate("library.memory.source.available" as never, {
              name: source.name,
              version: source.revision,
            })}
          </UI.Text>
        </UI.Stack>
      </UI.InlineNotice>
    )
    : (
      <UI.InlineNotice
        tone={source.kind === "deleted" ? "warning" : "neutral"}
        data-testid="memory-source"
        action={source.kind === "unknown"
          ? (
            <UI.Button
              variant="secondary"
              onClick={() => void revisions.refetch()}
            >
              {translate("library.memory.source.retry" as never)}
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
  return (
    <UI.Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={translate("library.memory.fact.title" as never)}
      dismissLabel={translate("library.memory.fact.close" as never)}
      variant={phone ? "bottom" : "side"}
      data-testid="memory-fact"
    >
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
                        ? translate("library.memory.badge.inUse" as never)
                        : translate("library.memory.fact.earlier" as never),
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
    </UI.Sheet>
  );
}
