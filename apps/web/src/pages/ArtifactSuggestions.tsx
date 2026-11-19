import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoroDoc } from "loro-crdt/base64";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { DraftSuggestionResponse } from "../api/client.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  cardKind,
  inDocumentOrder,
  listedSuggestions,
  suggestionChange,
  suggestionRange,
} from "../collaboration/suggestions.ts";

/** How often the list is read again while editing, besides focus and decisions. */
const REFRESH_MS = 30_000;
/** Pages of the list read in one go; decided suggestions are in it too. */
const MAX_PAGES = 3;
/** Accept all and Reject all are offered from this many suggestions. */
const BULK_FROM = 3;

type Failure = "accept" | "reject";
type Bulk = null | "accept" | "reject";

/**
 * What agents suggested on this draft, beside the text they point at (#71):
 * a card for each suggestion still waiting, no longer fitting or of unknown
 * outcome, in document order. Nothing is applied until a person accepts it.
 */
export function ArtifactSuggestions(
  { document, documentTick, draftId, onSelectRange }: {
    readonly document: LoroDoc;
    /** Changes whenever the text does, so the order follows it. */
    readonly documentTick: number;
    readonly draftId: string;
    /** The range the chosen card points at, or null when none is chosen. */
    readonly onSelectRange: (
      range: { readonly from: number; readonly to: number } | null,
    ) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t, locale } = useI18n();
  const organizationId = scope.organizationId;
  const [items, setItems] = useState<readonly DraftSuggestionResponse[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, Failure>>(
    new Map(),
  );
  const [denied, setDenied] = useState(false);
  const [bulk, setBulk] = useState<Bulk>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef<Set<string> | null>(null);

  const read = useCallback(async () => {
    if (organizationId === null) return;
    const all: DraftSuggestionResponse[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await api.listDraftSuggestions({
        organizationId,
        draftId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) return;
      all.push(...result.data.items);
      cursor = result.data.nextCursor ?? undefined;
      if (!cursor) break;
    }
    const listed = listedSuggestions(all);
    // The first read tells nothing new; later ones announce what arrived.
    if (seen.current !== null) {
      const arrived = listed.filter((item) => !seen.current!.has(item.id))
        .length;
      if (arrived > 0) {
        setAnnouncement(
          arrived === 1
            ? t("artifact.edit.suggestions.newOne")
            : t("artifact.edit.suggestions.new", { count: arrived }),
        );
      }
    }
    seen.current = new Set(listed.map((item) => item.id));
    setItems(all);
  }, [api, draftId, organizationId, t]);

  // Read on open, when the tab is back in view, and now and then.
  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    const onFocus = () => void read();
    globalThis.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      globalThis.removeEventListener("focus", onFocus);
    };
  }, [read]);

  const listed = useMemo(
    () => inDocumentOrder(document, listedSuggestions(items)),
    // The text moving is the reason to order again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document, documentTick, items],
  );

  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  const choose = (item: DraftSuggestionResponse) => {
    const next = selected === item.id ? null : item.id;
    setSelected(next);
    onSelectRange(next === null ? null : suggestionRange(document, item));
  };

  const decide = async (
    item: DraftSuggestionResponse,
    action: Failure,
  ): Promise<boolean> => {
    if (organizationId === null) return false;
    setWorking((current) => new Set(current).add(item.id));
    setFailures((current) => {
      const next = new Map(current);
      next.delete(item.id);
      return next;
    });
    const options = { organizationId, draftId, suggestionId: item.id };
    const result = action === "accept"
      ? await api.acceptDraftSuggestion(options)
      : await api.rejectDraftSuggestion(options);
    setWorking((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
    if (result.ok) {
      if (selected === item.id) {
        setSelected(null);
        onSelectRange(null);
      }
      return true;
    }
    if (
      result.error.kind === "problem" && result.error.problem.status === 403
    ) {
      setDenied(true);
    } else {
      setFailures((current) => new Map(current).set(item.id, action));
    }
    return false;
  };

  const decideOne = async (
    item: DraftSuggestionResponse,
    action: Failure,
  ) => {
    await decide(item, action);
    await read();
  };

  const decideAll = async (action: Failure) => {
    setBulk(null);
    setBulkBusy(true);
    // Only the ones still waiting can be decided; the others have their own words.
    for (const item of listed.filter((entry) => entry.state === "waiting")) {
      if (!(await decide(item, action))) break;
    }
    setBulkBusy(false);
    await read();
  };

  if (listed.length === 0 && !denied) {
    return announcement
      ? (
        <UI.VisuallyHidden aria-live="polite" as="div" role="status">
          {announcement}
        </UI.VisuallyHidden>
      )
      : null;
  }

  const waiting = listed.filter((item) => item.state === "waiting").length;
  const summaryOf = (item: DraftSuggestionResponse): string => {
    const change = suggestionChange(item);
    return change === "add"
      ? t("artifact.edit.suggestions.add", { new: item.replacement })
      : change === "remove"
      ? t("artifact.edit.suggestions.remove", { old: item.expectedText })
      : t("artifact.edit.suggestions.replace", {
        old: item.expectedText,
        new: item.replacement,
      });
  };
  const headingOf = (item: DraftSuggestionResponse) =>
    item.agentName
      ? t("artifact.edit.suggestions.heading", { agent: item.agentName })
      : t("artifact.edit.suggestions.headingNoName");
  const originOf = (item: DraftSuggestionResponse) => {
    const when = time.format(new Date(item.createdAt));
    return item.requestedByName
      ? t("artifact.edit.suggestions.origin", {
        name: item.requestedByName,
        time: when,
      })
      : t("artifact.edit.suggestions.originNoName", { time: when });
  };

  return (
    <UI.Stack data-testid="draft-suggestions" gap="compact">
      <UI.Inline gap="compact" variant="between">
        <UI.Heading level="subsection" rank={2}>
          {t("artifact.edit.suggestions.title", { count: listed.length })}
        </UI.Heading>
        {waiting >= BULK_FROM && !denied && (
          <UI.Inline gap="compact">
            <UI.Button
              disabled={bulkBusy}
              onClick={() => setBulk("accept")}
              variant="outline"
            >
              {t("artifact.edit.suggestions.acceptAll")}
            </UI.Button>
            <UI.Button
              disabled={bulkBusy}
              onClick={() => setBulk("reject")}
              variant="outline"
            >
              {t("artifact.edit.suggestions.rejectAll")}
            </UI.Button>
          </UI.Inline>
        )}
      </UI.Inline>
      <UI.VisuallyHidden aria-live="polite" as="div" role="status">
        {announcement}
      </UI.VisuallyHidden>
      {denied && (
        <UI.InlineNotice tone="error">
          {t("artifact.edit.suggestions.noRight")}
        </UI.InlineNotice>
      )}
      {listed.map((item) => {
        const kind = cardKind(item);
        const failure = failures.get(item.id);
        return denied
          ? (
            <UI.Stack gap="tight" key={item.id}>
              <UI.Text variant="strong">{headingOf(item)}</UI.Text>
              <UI.Text>{summaryOf(item)}</UI.Text>
              <UI.Text variant="caption">{originOf(item)}</UI.Text>
            </UI.Stack>
          )
          : (
            <UI.Stack gap="tight" key={item.id}>
              <UI.SuggestionCard
                acceptLabel={t("artifact.edit.suggestions.accept")}
                checkAgainLabel={t("core.actions.checkAgain")}
                data-testid={`suggestion-${item.id}`}
                heading={headingOf(item)}
                message={kind === "outdated"
                  ? t(
                    item.refusalReason === "draft_moved_on"
                      ? "artifact.edit.suggestions.outdatedPublished"
                      : "artifact.edit.suggestions.outdated",
                  )
                  : kind === "unknown"
                  ? t("artifact.edit.suggestions.unknown")
                  : undefined}
                onAccept={() => void decideOne(item, "accept")}
                onCheckAgain={() => void read()}
                onReject={() => void decideOne(item, "reject")}
                onSelect={() => choose(item)}
                origin={originOf(item)}
                rejectLabel={t("artifact.edit.suggestions.reject")}
                selected={selected === item.id}
                state={working.has(item.id) ? "working" : kind}
                summary={
                  <UI.ExpandableText
                    hideLabel={t("core.actions.showLess")}
                    showLabel={t("core.actions.showAll")}
                    variant="body"
                  >
                    {summaryOf(item)}
                  </UI.ExpandableText>
                }
              />
              {failure && (
                <UI.InlineNotice tone="error">
                  {t(
                    failure === "accept"
                      ? "artifact.edit.suggestions.acceptFailed"
                      : "artifact.edit.suggestions.rejectFailed",
                  )}
                </UI.InlineNotice>
              )}
            </UI.Stack>
          );
      })}
      <UI.AlertDialog
        cancelAction={
          <UI.Button onClick={() => setBulk(null)} variant="outline">
            {t("core.actions.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            onClick={() => bulk && void decideAll(bulk)}
            variant="primary"
          >
            {t(
              bulk === "reject"
                ? "artifact.edit.suggestions.rejectAll.confirm"
                : "artifact.edit.suggestions.acceptAll.confirm",
              { count: waiting },
            )}
          </UI.Button>
        }
        onOpenChange={(open) => !open && setBulk(null)}
        open={bulk !== null}
        title={t(
          bulk === "reject"
            ? "artifact.edit.suggestions.rejectAll.title"
            : "artifact.edit.suggestions.acceptAll.title",
          { count: waiting },
        )}
      >
        {t(
          bulk === "reject"
            ? "artifact.edit.suggestions.rejectAll.body"
            : "artifact.edit.suggestions.acceptAll.body",
        )}
      </UI.AlertDialog>
    </UI.Stack>
  );
}
