import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { IconGlyph, type IconGlyphName } from "../atoms/IconGlyph.tsx";
import { Button } from "../atoms/Button.tsx";
import { DataText } from "../atoms/DataText.tsx";
import { IconButton } from "../atoms/IconButton.tsx";
import { Text } from "../atoms/Text.tsx";
import { Tooltip } from "../molecules/Tooltip.tsx";
import { ActivityLine, type ActivityLineTone } from "./ActivityLine.tsx";
import { ConversationMessage } from "./ConversationMessage.tsx";
import "../collaboration.css";

/** A sentence with one part that is data, not prose: a name, a path or any node. */
export type SessionThreadSentence = {
  before: string;
  after: string;
  value?:
    | { kind: "name" | "path"; text: string }
    | { kind: "node"; node: ReactNode };
};

export type SessionThreadStep = {
  key: string;
  /** Id a deep link names; marks the line so it can be scrolled to. */
  itemId: string;
  icon?: IconGlyphName;
  tone?: ActivityLineTone;
  sentence: string | SessionThreadSentence;
  time?: string;
  timeTitle?: string;
  /** Terminal output the line opens. */
  output?: { text: string; defaultOpen: boolean };
  /** Help shown on hover and focus, for a line the reader may not understand. */
  help?: string;
};

export type SessionThreadMessage = {
  itemId: string;
  author: string;
  kind: "person" | "agent" | "system";
  time: string;
  timeTitle: string;
  body: string;
  receipt?: string;
};

export type SessionThreadTurn = {
  key: string;
  message?: SessionThreadMessage;
  /** The line shown for work that came before any message. */
  startedLabel?: string;
  /** Fold control text: counts only. */
  summary?: string;
  /** Whether the work starts open; the reader's own choice wins afterwards. */
  defaultOpen: boolean;
  steps: readonly SessionThreadStep[];
  /** Fine print that ends the turn's work. */
  usage?: string;
};

export type SessionThreadEnd = {
  outcome: "completed" | "failed" | "cancelled";
  label: string;
  reason?: string;
};

export type SessionThreadProps = {
  turns: readonly SessionThreadTurn[];
  end?: SessionThreadEnd;
  labels: {
    jumpToLatest: string;
    loadEarlier: string;
    shortcuts: string;
    /** The keyboard shortcuts, one sentence each. */
    shortcutHelp: readonly string[];
  };
  /** "Show 42 more", given how many lines are left out. */
  showMore: (hidden: number) => string;
  /** The most step lines a turn draws before the show-more control. */
  maxSteps?: number;
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  /** Deep-linked item: its turn opens, it scrolls into view and is outlined once. */
  highlightedItemId?: string;
  /** Shown in place of the turns when the session has none yet. */
  empty?: ReactNode;
  /** Rendered after the thread, for example the line that says what is happening now. */
  children?: ReactNode;
};

function Sentence({ sentence }: { sentence: string | SessionThreadSentence }) {
  if (typeof sentence === "string") return <>{sentence}</>;
  const { before, after, value } = sentence;
  return (
    <>
      {before}
      {value?.kind === "name"
        ? (
          <DataText variant="code" dir="ltr" translate="no">
            {value.text}
          </DataText>
        )
        : value?.kind === "path"
        ? <PathText path={value.text} />
        : value?.kind === "node"
        ? value.node
        : null}
      {after}
    </>
  );
}

/** A path always fits one line: the folder truncates, the file name never. */
function PathText({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  const folder = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = slash < 0 ? path : path.slice(slash + 1);
  return (
    <span className="ui-session-path" dir="ltr" translate="no" title={path}>
      {folder
        ? (
          <span
            className="ui-session-path__folder"
            data-rail="truncation-allowed"
          >
            {folder}
          </span>
        )
        : null}
      <span className="ui-session-path__name">{name}</span>
    </span>
  );
}

function StepLine({ step }: { step: SessionThreadStep }) {
  const [open, setOpen] = useState(step.output?.defaultOpen ?? false);
  const output = step.output;
  return (
    <ActivityLine
      icon={step.icon}
      tone={step.tone}
      time={step.time}
      timeTitle={step.timeTitle}
      data-item-id={step.itemId}
      detail={output
        ? {
          expanded: open,
          onToggle: () => setOpen((value) => !value),
          content: (
            <pre
              className="ui-session-thread__terminal"
              dir="ltr"
              translate="no"
              tabIndex={0}
            >
              {output.text}
            </pre>
          ),
        }
        : undefined}
    >
      {step.help
        ? (
          <Tooltip content={step.help}>
            <span tabIndex={0}>
              <Sentence sentence={step.sentence} />
            </span>
          </Tooltip>
        )
        : <Sentence sentence={step.sentence} />}
    </ActivityLine>
  );
}

function TurnView(
  {
    maxSteps,
    onShowAll,
    onToggle,
    open,
    outlined,
    position,
    showAll,
    showMore,
    turn,
  }: {
    maxSteps: number;
    onShowAll: () => void;
    onToggle: () => void;
    open: boolean;
    outlined: boolean;
    position: number;
    showAll: boolean;
    showMore: (hidden: number) => string;
    turn: SessionThreadTurn;
  },
) {
  const workId = useId();
  const message = turn.message;
  const hasWork = turn.steps.length > 0 || turn.usage !== undefined;
  const visible = showAll ? turn.steps : turn.steps.slice(0, maxSteps);
  return (
    <li
      className="ui-session-thread__turn"
      /* Long sessions stay fast: turns past the 50th skip layout until scrolled
         near, which is the cheap form of virtualizing a transcript that must
         stay in the document for find-in-page and deep links. */
      data-position={position < 50 ? "near" : "far"}
      data-turn={turn.key}
      data-highlighted={outlined ? "true" : undefined}
      data-item-id={message?.itemId}
      id={message ? `feed-${message.itemId}` : undefined}
      tabIndex={-1}
    >
      {message
        ? (
          <ConversationMessage
            author={message.author}
            appearance={message.kind === "person" ? "card" : "plain"}
            variant={message.kind}
            timestamp={message.time}
            timestampTitle={message.timeTitle}
          >
            <Text dir="auto">{message.body}</Text>
            {message.receipt
              ? <p className="ui-session-thread__receipt">{message.receipt}</p>
              : null}
          </ConversationMessage>
        )
        : turn.startedLabel
        ? <p className="ui-session-thread__started">{turn.startedLabel}</p>
        : null}
      {hasWork
        ? (
          <div className="ui-session-thread__work">
            {message && turn.summary
              ? (
                <button
                  type="button"
                  className="ui-session-thread__summary"
                  aria-expanded={open}
                  aria-controls={workId}
                  onClick={onToggle}
                >
                  <span
                    className="ui-session-thread__chevron"
                    data-expanded={open ? "true" : "false"}
                  >
                    <IconGlyph name="chevron-down" />
                  </span>
                  <span>{turn.summary}</span>
                </button>
              )
              : null}
            {open || !message
              ? (
                <div id={workId}>
                  <ul className="ui-session-thread__steps">
                    {visible.map((step) => (
                      <StepLine key={step.key} step={step} />
                    ))}
                  </ul>
                  {!showAll && turn.steps.length > maxSteps
                    ? (
                      <Button variant="quiet" onClick={onShowAll}>
                        {showMore(turn.steps.length - maxSteps)}
                      </Button>
                    )
                    : null}
                  {turn.usage
                    ? <p className="ui-session-thread__usage">{turn.usage}</p>
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

/**
 * A session as one column of messages, each owning the work it caused.
 *
 * The reader's account is the spine: a person's message is the only boxed thing,
 * the agent speaks in plain text, and the steps behind each message fold under a
 * counts-only summary. Reading position is never taken from the reader: new
 * items follow them only while they are at the bottom, and otherwise a quiet
 * "Jump to latest" appears. J and K move between messages, Enter opens or folds
 * a message's work and End jumps to the latest, from inside the thread only and
 * never while someone is typing.
 */
export function SessionThread(
  {
    children,
    empty,
    end,
    highlightedItemId,
    labels,
    loadingEarlier,
    maxSteps = 30,
    onLoadEarlier,
    showMore,
    turns,
  }: SessionThreadProps,
) {
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
  const count = turns.reduce((total, turn) => total + 1 + turn.steps.length, 0);
  const seen = useRef(count);
  const [unseen, setUnseen] = useState(0);

  const openOf = useCallback(
    (turn: SessionThreadTurn) => folds[turn.key] ?? turn.defaultOpen,
    [folds],
  );
  const contains = (turn: SessionThreadTurn, itemId: string) =>
    turn.message?.itemId === itemId ||
    turn.steps.some((step) => step.itemId === itemId);

  useEffect(() => {
    if (!highlightedItemId) return;
    const turn = turns.find((candidate) =>
      contains(candidate, highlightedItemId)
    );
    if (!turn) return;
    setFolds((current) => ({ ...current, [turn.key]: true }));
    setOutlined(highlightedItemId);
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(highlightedItemId)}"]`,
    );
    target?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => setOutlined(undefined), 2_500);
    return () => clearTimeout(timer);
  }, [highlightedItemId, turns]);

  useEffect(() => {
    const target = bottomRef.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      setAtBottom(visible);
      if (visible) {
        seen.current = count;
        setUnseen(0);
      }
    }, { threshold: 0 });
    observer.observe(target);
    return () => observer.disconnect();
  }, [count]);
  useEffect(() => {
    if (count === seen.current) return;
    if (atBottom) {
      bottomRef.current?.scrollIntoView({ block: "end" });
      seen.current = count;
    } else if (count > seen.current) {
      setUnseen(count - seen.current);
    }
  }, [count, atBottom]);
  const jumpToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
    seen.current = count;
    setUnseen(0);
  }, [count]);

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
      const nodes = [...root.querySelectorAll<HTMLElement>("[data-turn]")];
      const at = nodes.findIndex((node) => node.contains(target));
      if (event.key === "j" || event.key === "J") {
        event.preventDefault();
        nodes[Math.min(nodes.length - 1, at + 1)]?.focus();
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        nodes[Math.max(0, at - 1)]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        jumpToLatest();
        nodes.at(-1)?.focus({ preventScroll: true });
      } else if (event.key === "Enter" && at >= 0 && target === nodes[at]) {
        event.preventDefault();
        const turn = turns[at];
        if (turn) {
          setFolds((current) => ({
            ...current,
            [turn.key]: !(current[turn.key] ?? turn.defaultOpen),
          }));
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [jumpToLatest, turns]);

  // What a reader of the page can tell at a glance: working, ended well, ended
  // badly, or nothing yet.
  const state = turns.length === 0
    ? "empty"
    : end
    ? (end.outcome === "failed" ? "failed" : "finished")
    : "running";
  if (turns.length === 0 && empty) {
    return (
      <div
        className="ui-session-thread"
        data-ui-component="sessionThread"
        data-variant="default"
        data-state={state}
        data-empty="true"
        ref={rootRef}
      >
        {empty}
        <div ref={bottomRef} className="ui-session-thread__bottom" />
        {children}
      </div>
    );
  }

  return (
    <div
      className="ui-session-thread"
      data-ui-component="sessionThread"
      data-variant="default"
      data-state={state}
      ref={rootRef}
    >
      {onLoadEarlier
        ? (
          <div className="ui-session-thread__bar">
            <Button
              variant="quiet"
              loading={loadingEarlier}
              onClick={onLoadEarlier}
            >
              {labels.loadEarlier}
            </Button>
          </div>
        )
        : null}
      {
        /* Over the thread's top end corner, so it takes no height of its own,
          and gone on a touch screen, where there are no keys and a tooltip
          cannot be opened. */
      }
      <div className="ui-session-thread__help">
        <Tooltip
          variant="description"
          content={labels.shortcutHelp.join(" · ")}
        >
          <IconButton label={labels.shortcuts} variant="compact">
            <IconGlyph name="question" />
          </IconButton>
        </Tooltip>
      </div>
      <ol className="ui-session-thread__turns">
        {turns.map((turn, index) => (
          <TurnView
            key={turn.key}
            turn={turn}
            position={index}
            maxSteps={maxSteps}
            showMore={showMore}
            open={openOf(turn)}
            onToggle={() =>
              setFolds((current) => ({
                ...current,
                [turn.key]: !(current[turn.key] ?? turn.defaultOpen),
              }))}
            showAll={expanded[turn.key] === true}
            onShowAll={() =>
              setExpanded((current) => ({ ...current, [turn.key]: true }))}
            outlined={outlined !== undefined && contains(turn, outlined)}
          />
        ))}
      </ol>
      {end
        ? (
          <div className="ui-session-thread__end" data-outcome={end.outcome}>
            <IconGlyph
              name={end.outcome === "completed"
                ? "check"
                : end.outcome === "failed"
                ? "close"
                : "caution"}
            />
            <span>{end.label}</span>
            {end.reason
              ? <span className="ui-session-thread__reason">{end.reason}</span>
              : null}
          </div>
        )
        : null}
      <div ref={bottomRef} className="ui-session-thread__bottom" />
      {unseen > 0
        ? (
          <div className="ui-session-thread__jump">
            <Button variant="quiet" onClick={jumpToLatest}>
              {labels.jumpToLatest}
            </Button>
          </div>
        )
        : null}
      {children}
    </div>
  );
}
