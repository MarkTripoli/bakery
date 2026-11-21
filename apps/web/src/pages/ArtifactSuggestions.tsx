import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

type Action = "accept" | "reject";
type Range = { readonly from: number; readonly to: number };

/** The result line after Accept all / Reject all. */
type Result = Readonly<{
  action: Action;
  done: number;
  total: number;
  /** Skipped because they no longer fit: not a failure, the run went on. */
  skipped: number;
  /** The run stopped at a failure and left the rest unchanged. */
  stopped: boolean;
}>;

export type SuggestionsState = ReturnType<typeof useSuggestions>;

/**
 * What agents suggested on this draft (#71): read on open, on focus, after a
 * decision and every 30 seconds (not while a bulk run is going), and decided
 * one at a time or all together. Nothing is applied until a person accepts it.
 */
export function useSuggestions(
  { document, documentTick, draftId, onSelectRange }: {
    readonly document: LoroDoc;
    /** Changes whenever the text does, so the order follows it. */
    readonly documentTick: number;
    readonly draftId: string;
    /** The range the chosen card points at, or null when none is chosen. */
    readonly onSelectRange: (range: Range | null) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const organizationId = scope.organizationId;
  const [items, setItems] = useState<readonly DraftSuggestionResponse[]>([]);
  // loading until the first answer; failed when the latest read did not work.
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [retrying, setRetrying] = useState(false);
  // Access removed: the editor says so; nothing is listed.
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, Action>>(
    new Map(),
  );
  const [denied, setDenied] = useState(false);
  const [bulk, setBulk] = useState<Action | null>(null);
  const [bulkRunning, setBulkRunning] = useState<Action | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef<Set<string> | null>(null);
  const running = useRef(false);

  const read = useCallback(async () => {
    if (organizationId === null || running.current) return;
    const all: DraftSuggestionResponse[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await api.listDraftSuggestions({
        organizationId,
        draftId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!answer.ok) {
        if (
          answer.error.kind === "problem" && answer.error.problem.status === 403
        ) setHidden(true);
        else setPhase("failed");
        return;
      }
      all.push(...answer.data.items);
      cursor = answer.data.nextCursor ?? undefined;
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
    setHidden(false);
    setPhase("ready");
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

  const retry = async () => {
    setRetrying(true);
    await read();
    setRetrying(false);
  };

  const choose = (item: DraftSuggestionResponse): boolean => {
    setResult(null);
    const next = selected === item.id ? null : item.id;
    setSelected(next);
    onSelectRange(next === null ? null : suggestionRange(document, item));
    return next !== null;
  };

  /** One decision. Returns the suggestion's state after it, or null when it failed. */
  const decide = async (
    item: DraftSuggestionResponse,
    action: Action,
  ): Promise<DraftSuggestionResponse["state"] | null> => {
    if (organizationId === null) return null;
    setWorking((current) => new Set(current).add(item.id));
    setFailures((current) => {
      const next = new Map(current);
      next.delete(item.id);
      return next;
    });
    const options = { organizationId, draftId, suggestionId: item.id };
    const answer = action === "accept"
      ? await api.acceptDraftSuggestion(options)
      : await api.rejectDraftSuggestion(options);
    setWorking((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
    if (answer.ok) {
      if (selected === item.id) {
        setSelected(null);
        onSelectRange(null);
      }
      return answer.data.state;
    }
    if (
      answer.error.kind === "problem" && answer.error.problem.status === 403
    ) setDenied(true);
    else setFailures((current) => new Map(current).set(item.id, action));
    return null;
  };

  const decideOne = async (item: DraftSuggestionResponse, action: Action) => {
    setResult(null);
    await decide(item, action);
    await read();
  };

  /** Every waiting suggestion in order; stops at the first failure. */
  const decideAll = async (action: Action) => {
    setBulk(null);
    setResult(null);
    const waiting = listed.filter((entry) => entry.state === "waiting");
    running.current = true;
    setBulkRunning(action);
    let done = 0;
    let skipped = 0;
    let stopped = false;
    for (const item of waiting) {
      const after = await decide(item, action);
      if (after === null) {
        stopped = true;
        break;
      }
      if (after === "no_longer_fits") skipped += 1;
      else done += 1;
    }
    running.current = false;
    setBulkRunning(null);
    const summary: Result = {
      action,
      done,
      total: waiting.length,
      skipped,
      stopped,
    };
    setResult(summary);
    // The result line announces itself; a second live region would read it twice.
    await read();
  };

  return {
    listed,
    phase,
    retrying,
    hidden,
    selected,
    working,
    failures,
    denied,
    bulk,
    bulkRunning,
    result,
    announcement,
    waiting: listed.filter((item) => item.state === "waiting").length,
    choose,
    retry,
    check: read,
    decideOne,
    decideAll,
    askBulk: setBulk,
    dismissResult: () => setResult(null),
  };
}

type Translate = ReturnType<typeof useI18n>["translate"];

/** The sentence for the end of Accept all / Reject all. */
function resultText(result: Result, t: Translate): string {
  const verb = result.action === "accept" ? "accepted" : "rejected";
  if (!result.stopped && result.skipped === 0) {
    return t(`artifact.edit.suggestions.bulk.${verb}All`, {
      count: result.total,
    });
  }
  if (result.stopped) {
    return t(`artifact.edit.suggestions.bulk.${verb}Stopped`, {
      done: result.done,
      total: result.total,
    });
  }
  return t(`artifact.edit.suggestions.bulk.${verb}Skipped`, {
    done: result.done,
    total: result.total,
    skipped: result.skipped,
  });
}

/** The cards, their notices and the questions of Accept all / Reject all. */
export function SuggestionsPanel(
  { afterChoose, hideTitle = false, state }: {
    readonly state: SuggestionsState;
    /** The sheet already names the list, so its own heading is left out there. */
    readonly hideTitle?: boolean;
    /** Called when a card is chosen, so a sheet can close. */
    readonly afterChoose?: () => void;
  },
) {
  const { translate: t, locale } = useI18n();
  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );
  const {
    listed,
    phase,
    retrying,
    hidden,
    selected,
    working,
    failures,
    denied,
    bulkRunning,
    result,
    announcement,
    waiting,
  } = state;

  if (hidden) return null;
  const firstFailed = phase === "failed" && listed.length === 0;
  const stale = phase === "failed" && listed.length > 0;
  const busy = bulkRunning !== null;
  // Nothing to show: the first read is under way, or the list is empty.
  if (listed.length === 0 && !firstFailed && result === null && !denied) {
    return announcement
      ? (
        <UI.VisuallyHidden aria-live="polite" as="div" role="status">
          {announcement}
        </UI.VisuallyHidden>
      )
      : null;
  }

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
  const tryAgain = (): ReactNode => (
    <UI.Button
      disabled={retrying}
      onClick={() => void state.retry()}
      variant="outline"
    >
      {retrying
        ? t("artifact.edit.suggestions.loading")
        : t("artifact.edit.retry")}
    </UI.Button>
  );

  return (
    <UI.Stack data-testid="draft-suggestions" gap="compact">
      <UI.Inline gap="compact" variant="between">
        {hideTitle ? null : (
          <UI.Heading level="subsection" rank={2}>
            {firstFailed
              ? t("artifact.edit.suggestions.titleNoCount")
              : t("artifact.edit.suggestions.title", { count: listed.length })}
          </UI.Heading>
        )}
        {waiting >= BULK_FROM && !denied && (
          <UI.Inline gap="compact">
            <UI.Button
              disabled={busy}
              onClick={() => state.askBulk("accept")}
              variant="outline"
            >
              {bulkRunning === "accept"
                ? t("artifact.edit.suggestions.accepting")
                : t("artifact.edit.suggestions.acceptAll")}
            </UI.Button>
            <UI.Button
              disabled={busy}
              onClick={() => state.askBulk("reject")}
              variant="outline"
            >
              {bulkRunning === "reject"
                ? t("artifact.edit.suggestions.rejecting")
                : t("artifact.edit.suggestions.rejectAll")}
            </UI.Button>
          </UI.Inline>
        )}
      </UI.Inline>
      <UI.VisuallyHidden aria-live="polite" as="div" role="status">
        {announcement}
      </UI.VisuallyHidden>
      {firstFailed && (
        <UI.InlineNotice action={tryAgain()} tone="error">
          {t("artifact.edit.suggestions.loadFailed")}
        </UI.InlineNotice>
      )}
      {stale && (
        <UI.InlineNotice action={tryAgain()} tone="warning">
          {t("artifact.edit.suggestions.stale")}
        </UI.InlineNotice>
      )}
      {result && (
        <UI.InlineNotice
          onDismiss={state.dismissResult}
          tone={result.stopped || result.skipped > 0
            ? "warning"
            : "information"}
        >
          {resultText(result, t)}
        </UI.InlineNotice>
      )}
      {denied && (
        <UI.InlineNotice tone="information">
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
            <UI.SuggestionCard
              acceptLabel={t("artifact.edit.suggestions.accept")}
              checkAgainLabel={t("core.actions.checkAgain")}
              data-testid={`suggestion-${item.id}`}
              error={failure
                ? t(
                  failure === "accept"
                    ? "artifact.edit.suggestions.acceptFailed"
                    : "artifact.edit.suggestions.rejectFailed",
                )
                : undefined}
              heading={headingOf(item)}
              key={item.id}
              message={kind === "outdated"
                ? t(
                  item.refusalReason === "draft_moved_on"
                    ? "artifact.edit.suggestions.outdatedPublished"
                    : "artifact.edit.suggestions.outdated",
                )
                : kind === "unknown"
                ? t("artifact.edit.suggestions.unknown")
                : undefined}
              onAccept={() => void state.decideOne(item, "accept")}
              onCheckAgain={() => void state.check()}
              onReject={() => void state.decideOne(item, "reject")}
              onSelect={() => {
                if (state.choose(item)) afterChoose?.();
                else afterChoose?.();
              }}
              origin={originOf(item)}
              rejectLabel={t("artifact.edit.suggestions.reject")}
              selected={selected === item.id}
              state={working.has(item.id) || busy ? "working" : kind}
              summary={
                <UI.ExpandableText
                  hideLabel={t("core.actions.showLess")}
                  showLabel={t("core.actions.showAll")}
                  lines={3}
                  variant="body"
                >
                  {summaryOf(item)}
                </UI.ExpandableText>
              }
            />
          );
      })}
    </UI.Stack>
  );
}

/**
 * The questions of Accept all and Reject all. It stands apart from the cards,
 * not inside the phone sheet, so closing it does not close the sheet.
 */
export function SuggestionsConfirm(
  { state }: { readonly state: SuggestionsState },
) {
  const { translate: t } = useI18n();
  const { bulk, waiting } = state;
  return (
    <UI.AlertDialog
      cancelAction={
        <UI.Button onClick={() => state.askBulk(null)} variant="outline">
          {t("core.actions.cancel")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          onClick={() => bulk && void state.decideAll(bulk)}
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
      onOpenChange={(open) => !open && state.askBulk(null)}
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
  );
}
