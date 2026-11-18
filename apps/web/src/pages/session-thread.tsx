import { type ReactNode, useMemo, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { ContractOutput } from "@bakery/contracts/contracts";

export type SessionFeedItem = ContractOutput<"SessionFeedItem">;
export type SessionThreadItem = SessionFeedItem;

export type SessionThreadTurn = {
  readonly message: SessionThreadItem | null;
  readonly receipt: boolean;
  readonly work: readonly SessionThreadItem[];
};

const WORK_KINDS = new Set([
  "terminal",
  "status",
  "tool",
  "file_change",
  "artifact",
  "usage",
]);

/**
 * Group the feed the way a reader thinks about it: every message owns the work
 * that happened after it, up to the next message.
 *
 * Work is attributed to the message that caused it, which is what makes a long
 * session readable - the agent's account is the spine and the steps hang under
 * the sentence that announced them. A session that opens with work (a resumed
 * session, or history that starts mid-run) keeps that work in a leading turn
 * with no message rather than dropping it.
 */
export function groupSessionTurns(
  items: readonly SessionThreadItem[],
): readonly SessionThreadTurn[] {
  const turns: {
    message: SessionThreadItem | null;
    receipt: boolean;
    work: SessionThreadItem[];
  }[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      turns.push({ message: item, receipt: false, work: [] });
      continue;
    }
    const current = turns.at(-1);
    if (item.kind === "delivered_input") {
      // A delivery receipt annotates the person message it was delivered after
      // instead of becoming a line of its own.
      if (current?.message) {
        current.receipt = true;
        continue;
      }
      turns.push({ message: null, receipt: false, work: [item] });
      continue;
    }
    if (current && WORK_KINDS.has(item.kind)) {
      current.work.push(item);
      continue;
    }
    turns.push({ message: null, receipt: false, work: [item] });
  }
  return turns;
}

export type SessionThreadProps = {
  items: readonly SessionThreadItem[];
  /** Present when earlier history exists. */
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  /** Rendered above the composer: what is happening now. */
  now?: ReactNode;
  /** Deep-linked item, outlined once so a shared link lands somewhere visible. */
  highlightedItemId?: string;
};

/**
 * A quiet relative time, in the locale's own short form: "15m", "2h", "3d".
 * The exact instant travels beside it as the element's `datetime` and title, so
 * a shortened label never hides when something happened.
 */
function relativeTime(iso: string, locale: string | undefined, now: Date) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return { exact: iso, label: iso };
  const minutes = Math.round((now.getTime() - then) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "narrow",
  });
  const label = Math.abs(minutes) < 60
    ? format.format(-minutes, "minute")
    : Math.abs(minutes) < 60 * 24
    ? format.format(-Math.round(minutes / 60), "hour")
    : format.format(-Math.round(minutes / (60 * 24)), "day");
  return { exact: iso, label };
}

/** One chronological column of messages, each owning the work it caused. */
export function SessionThread(
  {
    items,
    onLoadEarlier,
    loadingEarlier,
    now,
    highlightedItemId,
  }: SessionThreadProps,
) {
  const { locale, translate } = useI18n();
  const turns = useMemo(() => groupSessionTurns(items), [items]);
  // One clock for the whole render, so two rows a second apart cannot disagree
  // about how long ago they were.
  const clock = useMemo(() => new Date(), [items]);
  return (
    <div className="ui-session-thread" data-ui-component="sessionThread">
      {onLoadEarlier
        ? (
          <div className="ui-session-thread__earlier">
            <UI.Button
              variant="quiet"
              loading={loadingEarlier}
              onClick={onLoadEarlier}
            >
              {translate("session.feed.loadEarlier")}
            </UI.Button>
          </div>
        )
        : null}
      <ol className="ui-session-thread__turns">
        {turns.map((turn, index) => (
          <SessionTurn
            key={turn.message?.id ?? turn.work[0]?.id ?? `turn-${index}`}
            turn={turn}
            highlighted={turn.message?.id === highlightedItemId}
            locale={locale}
            clock={clock}
            position={index}
          />
        ))}
      </ol>
      {now}
    </div>
  );
}

function SessionTurn(
  { clock, turn, highlighted, locale, position }: {
    clock: Date;
    turn: SessionThreadTurn;
    highlighted: boolean;
    locale: string | undefined;
    position: number;
  },
) {
  const { translate } = useI18n();
  const message = turn.message;
  const authorKind = message?.message?.authorKind ?? "agent";
  const author = authorKind === "person"
    ? translate("session.thread.you")
    : authorKind === "system"
    ? translate("session.thread.system")
    : translate("session.thread.agent");
  return (
    <li
      className="ui-session-thread__turn"
      /* Long sessions stay fast: turns past the 50th skip layout until scrolled
         near, which is the cheap form of virtualizing a transcript that must
         stay in the document for find-in-page and deep links. */
      data-position={position < 50 ? "near" : "far"}
      data-highlighted={highlighted ? "true" : undefined}
      id={message ? `feed-${message.id}` : undefined}
    >
      {message
        ? (
          <UI.ConversationMessage
            author={author}
            variant={authorKind}
            timestamp={relativeTime(message.occurredAt, locale, clock).label}
            timestampTitle={message.occurredAt}
          >
            <UI.Text dir="auto">{message.message?.body ?? ""}</UI.Text>
            {turn.receipt
              ? (
                <p className="ui-session-thread__receipt">
                  {translate("session.thread.delivered")}
                </p>
              )
              : null}
          </UI.ConversationMessage>
        )
        : null}
      {turn.work.length > 0
        ? (
          <SessionWork
            items={turn.work}
            locale={locale}
            clock={clock}
            showSummary={message !== null}
          />
        )
        : null}
    </li>
  );
}

/** The work under one message, summarised then listed. */
export function SessionWork(
  { clock, items, locale, showSummary }: {
    clock: Date;
    items: readonly SessionThreadItem[];
    locale: string | undefined;
    showSummary: boolean;
  },
) {
  const { translate } = useI18n();
  const summary = summarize(items);
  const parts: string[] = [];
  if (summary.steps > 0) {
    parts.push(translate("session.thread.summary.steps", {
      n: summary.steps,
    }));
  }
  if (summary.files > 0) {
    parts.push(translate("session.thread.summary.files", {
      n: summary.files,
    }));
  }
  if (summary.failed > 0) {
    parts.push(translate("session.thread.summary.failed", {
      n: summary.failed,
    }));
  }
  const joined = new Intl.ListFormat(undefined, {
    style: "short",
    type: "unit",
  }).format(parts);
  return (
    <div className="ui-session-thread__work">
      {showSummary && joined
        ? <p className="ui-session-thread__summary">{joined}</p>
        : null}
      <ul className="ui-session-thread__steps">
        {items.map((item) => (
          <SessionStep
            item={item}
            key={item.id}
            clock={clock}
            locale={locale}
          />
        ))}
      </ul>
    </div>
  );
}

function SessionStep(
  { clock, item, locale }: {
    clock: Date;
    item: SessionThreadItem;
    locale: string | undefined;
  },
) {
  const { translate } = useI18n();
  const line = activityFor(item, translate);
  // The hook runs before the early return so the order stays fixed, and a failed
  // step opens itself: the reason a run stopped is the one thing a reader should
  // not have to ask for.
  const [open, setOpen] = useState(line?.tone === "danger");
  if (!line) return null;
  const time = relativeTime(item.occurredAt, locale, clock);
  const text = item.terminal?.text;
  return (
    <UI.ActivityLine
      icon={line.icon}
      tone={line.tone}
      time={time.label}
      timeTitle={time.exact}
      detail={text === undefined ? undefined : {
        expanded: open,
        onToggle: () => setOpen((value) => !value),
        content: (
          <pre className="ui-session-thread__terminal" dir="ltr" tabIndex={0}>
            {text}
          </pre>
        ),
      }}
    >
      {line.sentence}
    </UI.ActivityLine>
  );
}

/** Counts the summary line states, in the order the design lists them. */
export function summarize(items: readonly SessionThreadItem[]) {
  const steps = items.length;
  const files = items.filter((item) => item.kind === "file_change").length;
  const failed =
    items.filter((item) =>
      item.kind === "tool" && item.tool?.phase === "failed"
    ).length;
  return { failed, files, steps };
}

type StepLine = {
  readonly icon: UI.IconGlyphName;
  readonly sentence: string;
  readonly tone: UI.ActivityLineTone;
};

function activityFor(
  item: SessionThreadItem,
  translate: ReturnType<typeof useI18n>["translate"],
): StepLine | null {
  switch (item.kind) {
    case "tool": {
      const name = item.tool?.name ?? "";
      const phase = item.tool?.phase ?? "started";
      const key = phase === "failed"
        ? "session.thread.tool.failed"
        : phase === "started"
        ? "session.thread.tool.running"
        : "session.thread.tool.ran";
      return {
        icon: "terminal",
        tone: phase === "failed" ? "danger" : "neutral",
        sentence: translate(key, { name }),
      };
    }
    case "file_change": {
      const path = item.fileChange?.path ?? "";
      const change = item.fileChange?.change ?? "modified";
      const key = change === "created"
        ? "session.thread.file.created"
        : change === "deleted"
        ? "session.thread.file.deleted"
        : change === "renamed"
        ? "session.thread.file.renamed"
        : "session.thread.file.edited";
      return {
        icon: "file",
        tone: "neutral",
        sentence: translate(key, { path }),
      };
    }
    case "status":
      return {
        icon: "info",
        tone: "neutral",
        sentence: translate("session.thread.status.changed", {
          status: item.status?.toStatus ?? "",
        }),
      };
    case "artifact":
      return {
        icon: "file",
        tone: "neutral",
        sentence: translate("session.thread.artifact", {
          name: item.artifact?.name ?? "",
          version: String(item.artifact?.version ?? ""),
        }),
      };
    case "usage":
      return {
        icon: "work-list",
        tone: "neutral",
        sentence: translate("session.thread.usage", {
          cost: String(item.usage?.costUsd ?? ""),
          in: String(item.usage?.inputTokens ?? ""),
          out: String(item.usage?.outputTokens ?? ""),
        }),
      };
    case "terminal": {
      const text = item.terminal?.text ?? "";
      const errors = item.terminal?.stream === "stderr";
      return {
        icon: "terminal",
        tone: errors ? "danger" : "neutral",
        sentence: translate(
          errors ? "session.thread.outputErrors" : "session.thread.output",
          { n: text.split("\n").length },
        ),
      };
    }
    default:
      return null;
  }
}
