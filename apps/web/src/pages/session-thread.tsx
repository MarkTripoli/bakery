import { type ReactNode, useMemo } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  buildSessionThread,
  formatUsage,
  MAX_STEP_LINES,
  opensByDefault,
  relativeTime,
  type SessionFeedItem,
  type SessionStep,
  type SessionTurn,
} from "./session-thread-model.ts";

export type { SessionFeedItem } from "./session-thread-model.ts";
export type SessionThreadItem = SessionFeedItem;

/** An invisible marker that lets a translated sentence carry a data part. */
const SLOT = "\u2063";

type Translate = ReturnType<typeof useI18n>["translate"];

/** A translated sentence split around its one placeholder. */
function around(sentence: string): { before: string; after: string } {
  const [before, after] = sentence.split(SLOT);
  return { before, after: after ?? "" };
}

const STATUS_WORDS = {
  starting: "session.thread.statusName.starting",
  active: "session.thread.statusName.active",
  waiting: "session.thread.statusName.waiting",
} as const;

function stepView(
  step: SessionStep,
  context: {
    clock: Date;
    locale: string | undefined;
    translate: Translate;
    renderArtifact: SessionThreadProps["renderArtifact"];
  },
): UI.SessionThreadStep {
  const { clock, locale, renderArtifact, translate } = context;
  const time = relativeTime(step.occurredAt, locale, clock);
  const common = {
    key: step.id,
    itemId: step.id,
    time: time.label,
    timeTitle: time.exact,
  };
  switch (step.kind) {
    case "tool": {
      const failed = step.phase === "failed";
      const key = failed
        ? "session.thread.tool.failed"
        : step.phase === "started"
        ? "session.thread.tool.running"
        : "session.thread.tool.ran";
      return {
        ...common,
        icon: failed ? "close" : "terminal",
        tone: failed ? "danger" : "neutral",
        sentence: {
          ...around(translate(key, { name: SLOT })),
          value: { kind: "name", text: step.name },
        },
      };
    }
    case "file": {
      const key = step.change === "created"
        ? "session.thread.file.created"
        : step.change === "deleted"
        ? "session.thread.file.deleted"
        : step.change === "renamed"
        ? "session.thread.file.renamed"
        : "session.thread.file.edited";
      return {
        ...common,
        icon: "file",
        sentence: {
          ...around(translate(key, { path: SLOT })),
          value: { kind: "path", text: step.path },
        },
      };
    }
    case "output":
      return {
        ...common,
        icon: step.errors ? "close" : "terminal",
        tone: step.errors ? "danger" : "neutral",
        sentence: translate(
          step.errors ? "session.thread.outputErrors" : "session.thread.output",
          { n: step.lines },
        ),
        // Output with errors opens itself: why a run stopped is what a reader
        // should not have to ask for.
        output: { text: step.text, defaultOpen: step.errors },
      };
    case "artifact": {
      const link = renderArtifact
        ? renderArtifact({ artifactId: step.artifactId, name: step.name })
        : null;
      return {
        ...common,
        icon: "document",
        sentence: {
          ...around(
            translate("session.thread.artifact", {
              name: SLOT,
              version: String(step.version ?? ""),
            }),
          ),
          value: link
            ? { kind: "node", node: link }
            : { kind: "name", text: step.name },
        },
      };
    }
    case "status":
      return {
        ...common,
        icon: "info",
        sentence: translate("session.thread.status.changed", {
          status: translate(STATUS_WORDS[step.status]),
        }),
      };
    case "redacted":
      return {
        ...common,
        icon: "lock",
        sentence: translate("session.thread.redacted"),
        help: translate("session.thread.redactedHelp"),
      };
  }
}

function summaryOf(turn: SessionTurn, translate: Translate): string {
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
  return new Intl.ListFormat(undefined, { style: "short", type: "unit" })
    .format(parts);
}

export type SessionThreadProps = {
  items: readonly SessionThreadItem[];
  /** The session is running: its newest turn opens its work. */
  running?: boolean;
  /** The session's own status; a failed one is said by the now line, not twice. */
  sessionStatus?: string;
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

function usageArgs(locale: string | undefined, turn: SessionTurn) {
  const usage = formatUsage(locale, turn.usage!);
  return { in: usage.inputTokens, out: usage.outputTokens, cost: usage.cost };
}

/**
 * The agent thread for one session's feed: the feed grouped the way a reader
 * thinks about it (see `session-thread-model.ts`), translated, and handed to the
 * catalogued `UI.SessionThread`, which owns the markup, folding and keyboard.
 */
export function SessionThread(
  {
    highlightedItemId,
    items,
    loadingEarlier,
    now,
    onLoadEarlier,
    renderArtifact,
    running = false,
    sessionStatus,
  }: SessionThreadProps,
) {
  const { locale, translate } = useI18n();
  const model = useMemo(() => buildSessionThread(items), [items]);
  // One clock for the whole render, so two rows a second apart cannot disagree
  // about how long ago they were.
  const clock = useMemo(() => new Date(), [items]);
  const turns = useMemo<UI.SessionThreadTurn[]>(
    () =>
      model.turns.map((turn, index) => {
        const message = turn.message;
        const authorKind = message?.message?.authorKind ?? "agent";
        const time = message
          ? relativeTime(message.occurredAt, locale, clock)
          : null;
        return {
          key: message?.id ?? `lead-${index}`,
          message: message && time
            ? {
              itemId: message.id,
              author: authorKind === "person"
                ? translate("session.thread.you")
                : authorKind === "system"
                ? translate("session.thread.system")
                : translate("session.thread.agent"),
              kind: authorKind,
              time: time.label,
              timeTitle: time.exact,
              body: message.message?.body ?? "",
              receipt: turn.receipt
                ? translate("session.thread.delivered")
                : undefined,
            }
            : undefined,
          startedLabel: message
            ? undefined
            : translate("session.thread.started"),
          summary: summaryOf(turn, translate) || undefined,
          defaultOpen: opensByDefault(
            turn,
            index === model.turns.length - 1,
            running,
          ),
          steps: turn.steps.map((step) =>
            stepView(step, { clock, locale, translate, renderArtifact })
          ),
          usage: turn.usage
            ? translate("session.thread.usage", usageArgs(locale, turn))
            : undefined,
        };
      }),
    [model, locale, clock, translate, running, renderArtifact],
  );
  const end = model.end &&
      !(model.end.outcome === "failed" && sessionStatus === "failed")
    ? {
      outcome: model.end.outcome,
      label: translate(`session.thread.end.${model.end.outcome}`),
      reason: model.end.reason ?? undefined,
    }
    : undefined;
  return (
    <UI.SessionThread
      turns={turns}
      end={end}
      empty={
        <UI.EmptyState
          title={translate("session.thread.empty.title")}
          description={translate("session.thread.empty.body")}
        />
      }
      maxSteps={MAX_STEP_LINES}
      showMore={(hidden) => translate("session.thread.showMore", { n: hidden })}
      labels={{
        jumpToLatest: translate("session.thread.jumpToLatest"),
        loadEarlier: translate("session.feed.loadEarlier"),
        shortcuts: translate("session.thread.shortcuts"),
        shortcutHelp: (["next", "previous", "open", "end"] as const).map((
          name,
        ) => translate(`session.thread.shortcut.${name}`)),
      }}
      onLoadEarlier={onLoadEarlier}
      loadingEarlier={loadingEarlier}
      highlightedItemId={highlightedItemId}
    >
      {now}
    </UI.SessionThread>
  );
}
