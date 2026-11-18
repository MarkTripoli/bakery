import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  buildSessionThread,
  formatUsage,
  MAX_STEP_LINES,
  opensByDefault,
  type SessionFeedItem,
  type SessionStep,
  type SessionTurn,
  splitPath,
} from "./session-thread-model.ts";

export type { SessionFeedItem } from "./session-thread-model.ts";
export type SessionThreadItem = SessionFeedItem;

/** An invisible marker that lets a translated sentence carry a monospace part. */
const SLOT = "\u2063";

type Translate = ReturnType<typeof useI18n>["translate"];

/** A translated sentence with `node` set where its one placeholder was. */
function embed(sentence: string, node: ReactNode): ReactNode {
  const [before, after] = sentence.split(SLOT);
  return after === undefined ? sentence : (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

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

export type SessionThreadProps = {
  items: readonly SessionThreadItem[];
  /** The session is running: its newest turn opens its work. */
  running?: boolean;
  /** Present when earlier history exists. */
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  /** Rendered after the thread: what is happening now. */
  now?: ReactNode;
  /** Deep-linked item, opened and outlined once so a shared link lands somewhere visible. */
  highlightedItemId?: string;
  /** How an artifact line links to the artifact; the name alone when absent. */
  renderArtifact?: (
    artifact: { artifactId: string; name: string },
  ) => ReactNode;
};

const keyOf = (turn: SessionTurn, index: number) =>
  turn.message?.id ?? `lead-${index}`;

/** One chronological column of messages, each owning the work it caused. */
export function SessionThread(
  {
    items,
    running = false,
    onLoadEarlier,
    loadingEarlier,
    now,
    highlightedItemId,
    renderArtifact,
  }: SessionThreadProps,
) {
  const { locale, translate } = useI18n();
  const model = useMemo(() => buildSessionThread(items), [items]);
  // One clock for the whole render, so two rows a second apart cannot disagree
  // about how long ago they were.
  const clock = useMemo(() => new Date(), [items]);
  const [folds, setFolds] = useState<Readonly<Record<string, boolean>>>({});
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>(
    {},
  );
  const [outlined, setOutlined] = useState<string | undefined>(
    highlightedItemId,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const seen = useRef(items.length);
  const [unseen, setUnseen] = useState(0);

  // The turn a deep-linked item belongs to opens, scrolls into view and is
  // outlined once.
  useEffect(() => {
    if (!highlightedItemId) return;
    const at = model.turns.findIndex((turn) =>
      turn.message?.id === highlightedItemId ||
      turn.steps.some((step) => step.id === highlightedItemId)
    );
    if (at < 0) return;
    setFolds((current) => ({ ...current, [keyOf(model.turns[at], at)]: true }));
    setOutlined(highlightedItemId);
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(highlightedItemId)}"]`,
    ) ?? rootRef.current?.querySelectorAll<HTMLElement>("[data-turn]")[at];
    target?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => setOutlined(undefined), 2_500);
    return () => clearTimeout(timer);
  }, [highlightedItemId, model.turns]);

  // Reading position: new items follow the reader only while they are at the
  // bottom; a reader who scrolled up is offered "Jump to latest", never moved.
  useEffect(() => {
    const target = bottomRef.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setAtBottom(visible);
        if (visible) {
          seen.current = items.length;
          setUnseen(0);
        }
      },
      { threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [items.length]);
  useEffect(() => {
    if (items.length === seen.current) return;
    if (atBottom) {
      bottomRef.current?.scrollIntoView({ block: "end" });
      seen.current = items.length;
    } else if (items.length > seen.current) {
      setUnseen(items.length - seen.current);
    }
  }, [items.length, atBottom]);
  const jumpToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
    seen.current = items.length;
    setUnseen(0);
  }, [items.length]);

  // J and K move between messages, Enter opens or folds a message's work and
  // End jumps to the latest, but only from inside the thread and never while
  // someone is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey
      ) return;
      const root = rootRef.current;
      const target = event.target as HTMLElement | null;
      if (!root || !target || !root.contains(target)) return;
      if (target.closest("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      const turns = [...root.querySelectorAll<HTMLElement>("[data-turn]")];
      const at = turns.findIndex((turn) => turn.contains(target));
      if (event.key === "j" || event.key === "J") {
        event.preventDefault();
        turns[Math.min(turns.length - 1, at + 1)]?.focus();
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        turns[Math.max(0, at - 1)]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        jumpToLatest();
        turns.at(-1)?.focus({ preventScroll: true });
      } else if (event.key === "Enter" && at >= 0 && target === turns[at]) {
        event.preventDefault();
        const turn = model.turns[at];
        const key = keyOf(turn, at);
        const isNewest = at === model.turns.length - 1;
        setFolds((current) => ({
          ...current,
          [key]: !(current[key] ?? opensByDefault(turn, isNewest, running)),
        }));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [jumpToLatest, model.turns, running]);

  return (
    <div
      className="ui-session-thread"
      data-ui-component="sessionThread"
      ref={rootRef}
    >
      <div className="ui-session-thread__bar">
        {onLoadEarlier
          ? (
            <UI.Button
              variant="quiet"
              loading={loadingEarlier}
              onClick={onLoadEarlier}
            >
              {translate("session.feed.loadEarlier")}
            </UI.Button>
          )
          : <span />}
        <UI.Tooltip
          variant="description"
          content={(["next", "previous", "open", "end"] as const)
            .map((name) => translate(`session.thread.shortcut.${name}`))
            .join(" · ")}
        >
          <UI.IconButton
            label={translate("session.thread.shortcuts")}
            variant="compact"
          >
            <UI.IconGlyph name="question" />
          </UI.IconButton>
        </UI.Tooltip>
      </div>
      <ol className="ui-session-thread__turns">
        {model.turns.map((turn, index) => {
          const key = keyOf(turn, index);
          const isNewest = index === model.turns.length - 1;
          return (
            <SessionTurnView
              key={key}
              turnKey={key}
              turn={turn}
              position={index}
              open={folds[key] ?? opensByDefault(turn, isNewest, running)}
              onToggle={() =>
                setFolds((current) => ({
                  ...current,
                  [key]: !(current[key] ??
                    opensByDefault(turn, isNewest, running)),
                }))}
              showAll={expanded[key] === true}
              onShowAll={() =>
                setExpanded((current) => ({ ...current, [key]: true }))}
              outlined={outlined !== undefined && (
                turn.message?.id === outlined ||
                turn.steps.some((step) => step.id === outlined)
              )}
              locale={locale}
              clock={clock}
              renderArtifact={renderArtifact}
            />
          );
        })}
      </ol>
      {model.end ? <SessionEndRow end={model.end} /> : null}
      <div ref={bottomRef} className="ui-session-thread__bottom" />
      {unseen > 0
        ? (
          <div className="ui-session-thread__jump">
            <UI.Button variant="quiet" onClick={jumpToLatest}>
              {translate("session.thread.jumpToLatest")}
            </UI.Button>
          </div>
        )
        : null}
      {now}
    </div>
  );
}

function SessionEndRow(
  { end }: { end: NonNullable<ReturnType<typeof buildSessionThread>["end"]> },
) {
  const { translate } = useI18n();
  const icon: UI.IconGlyphName = end.outcome === "completed"
    ? "check"
    : end.outcome === "failed"
    ? "close"
    : "caution";
  return (
    <div className="ui-session-thread__end" data-outcome={end.outcome}>
      <UI.IconGlyph name={icon} />
      <span>{translate(`session.thread.end.${end.outcome}`)}</span>
      {end.reason
        ? <span className="ui-session-thread__reason">{end.reason}</span>
        : null}
    </div>
  );
}

function SessionTurnView(
  {
    clock,
    locale,
    onShowAll,
    onToggle,
    open,
    outlined,
    position,
    renderArtifact,
    showAll,
    turn,
    turnKey,
  }: {
    clock: Date;
    locale: string | undefined;
    onShowAll: () => void;
    onToggle: () => void;
    open: boolean;
    outlined: boolean;
    position: number;
    renderArtifact: SessionThreadProps["renderArtifact"];
    showAll: boolean;
    turn: SessionTurn;
    turnKey: string;
  },
) {
  const { translate } = useI18n();
  const workId = useId();
  const message = turn.message;
  const authorKind = message?.message?.authorKind ?? "agent";
  const author = authorKind === "person"
    ? translate("session.thread.you")
    : authorKind === "system"
    ? translate("session.thread.system")
    : translate("session.thread.agent");
  const hasWork = turn.steps.length > 0 || turn.usage !== null;
  return (
    <li
      className="ui-session-thread__turn"
      /* Long sessions stay fast: turns past the 50th skip layout until scrolled
         near, which is the cheap form of virtualizing a transcript that must
         stay in the document for find-in-page and deep links. */
      data-position={position < 50 ? "near" : "far"}
      data-turn={turnKey}
      data-highlighted={outlined ? "true" : undefined}
      data-item-id={message?.id}
      id={message ? `feed-${message.id}` : undefined}
      tabIndex={-1}
    >
      {message
        ? (
          <UI.ConversationMessage
            author={author}
            appearance={authorKind === "person" ? "card" : "plain"}
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
        : (
          <p className="ui-session-thread__started">
            {translate("session.thread.started")}
          </p>
        )}
      {hasWork
        ? (
          <div className="ui-session-thread__work">
            {message
              ? (
                <SessionSummary
                  turn={turn}
                  open={open}
                  controls={workId}
                  onToggle={onToggle}
                />
              )
              : null}
            {open || !message
              ? (
                <div id={workId}>
                  <ul className="ui-session-thread__steps">
                    {(showAll
                      ? turn.steps
                      : turn.steps.slice(0, MAX_STEP_LINES))
                      .map((step) => (
                        <SessionStepLine
                          key={step.id}
                          step={step}
                          locale={locale}
                          clock={clock}
                          renderArtifact={renderArtifact}
                        />
                      ))}
                  </ul>
                  {!showAll && turn.steps.length > MAX_STEP_LINES
                    ? (
                      <UI.Button variant="quiet" onClick={onShowAll}>
                        {translate("session.thread.showMore", {
                          n: turn.steps.length - MAX_STEP_LINES,
                        })}
                      </UI.Button>
                    )
                    : null}
                  {turn.usage
                    ? (
                      <p className="ui-session-thread__usage">
                        {translate(
                          "session.thread.usage",
                          formatUsageArgs(locale, turn),
                        )}
                      </p>
                    )
                    : null}
                </div>
              )
              : null}
          </div>
        )
        : null}
    </li>
  );
}

function formatUsageArgs(locale: string | undefined, turn: SessionTurn) {
  const usage = formatUsage(locale, turn.usage!);
  return { in: usage.inputTokens, out: usage.outputTokens, cost: usage.cost };
}

/** The fold control for a turn's work: counts only, never an invented sentence. */
function SessionSummary(
  { controls, onToggle, open, turn }: {
    controls: string;
    onToggle: () => void;
    open: boolean;
    turn: SessionTurn;
  },
) {
  const { translate } = useI18n();
  const parts: string[] = [];
  if (turn.counts.steps > 0) {
    parts.push(
      translate("session.thread.summary.steps", { n: turn.counts.steps }),
    );
  }
  if (turn.counts.files > 0) {
    parts.push(
      translate("session.thread.summary.files", { n: turn.counts.files }),
    );
  }
  if (turn.counts.failed > 0) {
    parts.push(
      translate("session.thread.summary.failed", { n: turn.counts.failed }),
    );
  }
  const joined = new Intl.ListFormat(undefined, {
    style: "short",
    type: "unit",
  })
    .format(parts);
  return (
    <button
      type="button"
      className="ui-session-thread__summary"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span
        className="ui-session-thread__chevron"
        data-expanded={open ? "true" : "false"}
      >
        <UI.IconGlyph name="chevron-down" />
      </span>
      <span>{joined || translate("session.thread.expand")}</span>
    </button>
  );
}

const STATUS_WORDS = {
  starting: "session.thread.statusName.starting",
  active: "session.thread.statusName.active",
  waiting: "session.thread.statusName.waiting",
} as const;

/** Names, paths and tool names are data, not prose: monospace, left to right, never translated. */
function Data({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <UI.DataText variant="code" dir="ltr" translate="no" title={title}>
      {children}
    </UI.DataText>
  );
}

function PathText({ path }: { path: string }) {
  const { folder, name } = splitPath(path);
  return (
    <span className="ui-session-path" dir="ltr" translate="no" title={path}>
      {folder
        ? <span className="ui-session-path__folder">{folder}</span>
        : null}
      <span className="ui-session-path__name">{name}</span>
    </span>
  );
}

function SessionStepLine(
  { clock, locale, renderArtifact, step }: {
    clock: Date;
    locale: string | undefined;
    renderArtifact: SessionThreadProps["renderArtifact"];
    step: SessionStep;
  },
) {
  const { translate } = useI18n();
  // Hooks run before any early return so their order stays fixed, and output
  // with errors opens itself: why a run stopped is what a reader should not
  // have to ask for.
  const [open, setOpen] = useState(
    step.kind === "output" && step.errors,
  );
  const time = relativeTime(step.occurredAt, locale, clock);
  const common = {
    time: time.label,
    timeTitle: time.exact,
    "data-item-id": step.id,
  };
  switch (step.kind) {
    case "tool": {
      const failed = step.phase === "failed";
      const key = failed
        ? "session.thread.tool.failed"
        : step.phase === "started"
        ? "session.thread.tool.running"
        : "session.thread.tool.ran";
      return (
        <UI.ActivityLine
          icon={failed ? "close" : "terminal"}
          tone={failed ? "danger" : "neutral"}
          {...common}
        >
          {embed(translate(key, { name: SLOT }), <Data>{step.name}</Data>)}
        </UI.ActivityLine>
      );
    }
    case "file": {
      const key = step.change === "created"
        ? "session.thread.file.created"
        : step.change === "deleted"
        ? "session.thread.file.deleted"
        : step.change === "renamed"
        ? "session.thread.file.renamed"
        : "session.thread.file.edited";
      return (
        <UI.ActivityLine icon="file" {...common}>
          {embed(translate(key, { path: SLOT }), <PathText path={step.path} />)}
        </UI.ActivityLine>
      );
    }
    case "output":
      return (
        <UI.ActivityLine
          icon={step.errors ? "close" : "terminal"}
          tone={step.errors ? "danger" : "neutral"}
          detail={{
            expanded: open,
            onToggle: () => setOpen((value) => !value),
            content: (
              <pre
                className="ui-session-thread__terminal"
                dir="ltr"
                translate="no"
                tabIndex={0}
              >
                {step.text}
              </pre>
            ),
          }}
          {...common}
        >
          {translate(
            step.errors
              ? "session.thread.outputErrors"
              : "session.thread.output",
            { n: step.lines },
          )}
        </UI.ActivityLine>
      );
    case "artifact": {
      const link = renderArtifact
        ? renderArtifact({ artifactId: step.artifactId, name: step.name })
        : <Data>{step.name}</Data>;
      return (
        <UI.ActivityLine icon="document" {...common}>
          {embed(
            translate("session.thread.artifact", {
              name: SLOT,
              version: String(step.version ?? ""),
            }),
            link,
          )}
        </UI.ActivityLine>
      );
    }
    case "status":
      return (
        <UI.ActivityLine icon="info" {...common}>
          {translate("session.thread.status.changed", {
            status: translate(STATUS_WORDS[step.status]),
          })}
        </UI.ActivityLine>
      );
    case "redacted":
      return (
        <UI.ActivityLine icon="lock" {...common}>
          <UI.Tooltip content={translate("session.thread.redactedHelp")}>
            <span tabIndex={0}>{translate("session.thread.redacted")}</span>
          </UI.Tooltip>
        </UI.ActivityLine>
      );
  }
}

export type { Translate };
