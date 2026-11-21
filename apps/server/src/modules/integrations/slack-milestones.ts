/**
 * The five milestone posts, and the rewrite of a decision post once it is no
 * longer open.
 *
 * Two properties are structural rather than asserted:
 *
 * - **No raw stream.** A composer takes a named fact set — a title, a step name,
 *   a duration, links — and never a free-form body. There is no argument a
 *   caller could pass an agent's output through, so "the raw stream is not
 *   posted to Slack" (owner decision O21) is not a rule to remember, it is the
 *   shape of the function.
 * - **Escaped, cut, one name.** Every value that came from a person is escaped
 *   for Slack's mrkdwn before it is composed, a long title is cut with an
 *   ellipsis, and the link that opens Bakery is always called the same thing.
 *
 * The words themselves are catalog messages, so a missing translation is a
 * compile error and not a blank post.
 */
import type { MessageKey, Translator } from "@bakery/i18n";
import type { SlackBlock, SlackButton, SlackPost } from "./slack-delivery.ts";

/** What every post needs. Everything here is required: a caller that lacks one
 * of these facts has the wrong milestone, not a post with a hole in it. */
export type SlackMilestoneFacts = {
  /** The work item's title, or the task's title when there is no work item. */
  readonly title: string;
  /** The run's live view, the one link every post carries. */
  readonly liveViewUrl: string;
  /** The workflow's name, when the run came from one. */
  readonly workflowName?: string;
  /** Who started the run, as a person reads it. */
  readonly startedBy?: string;
};

export type SlackWaitingFacts = SlackMilestoneFacts & {
  /** The step the run is waiting at, as a person reads it. */
  readonly stepName?: string;
  /** The value the Approve and Reject buttons carry. */
  readonly decisionId: string;
};

export type SlackStuckFacts = SlackMilestoneFacts & {
  readonly stepName?: string;
  /** How long nothing has moved, already human ("20 minutes"). */
  readonly duration?: string;
};

export type SlackFailedFacts = SlackMilestoneFacts & {
  readonly stepName?: string;
};

export type SlackDoneFacts = SlackMilestoneFacts & {
  /** Where the result is, when there is one: a pull request, a document. */
  readonly result?: {
    readonly kind: "pull_request" | "other";
    readonly url: string;
    /** For a pull request: the repository name and number, for the body line. */
    readonly repository?: string;
    readonly number?: number;
  };
};

/** A post, plus the two facts delivery needs that are not Slack's business. */
export type ComposedMilestone = {
  readonly post: SlackPost;
  /** Which milestone this is, recorded beside the message timestamp. */
  readonly milestone:
    | "started"
    | "waiting"
    | "stuck"
    | "failed"
    | "done";
  /** True while a decision post carries live buttons. */
  readonly decisionOpen: boolean;
};

/** Slack's documented limits: 120 characters reads as a title, 3000 as a section. */
const TITLE_LIMIT = 120;

/**
 * Escapes the three characters Slack's mrkdwn treats as markup. `&` first,
 * because the others are introduced with it.
 */
export function escapeSlackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A title, escaped and cut, so a long work item name cannot swallow the post. */
export function slackTitle(title: string): string {
  const escaped = escapeSlackText(title.trim());
  const characters = [...escaped];
  if (characters.length <= TITLE_LIMIT) return escaped;
  return `${characters.slice(0, TITLE_LIMIT - 1).join("")}…`;
}

/**
 * Slack's date token, so every reader sees their own time zone. The fallback is
 * the ISO instant, which is what a client without date support shows.
 */
export function slackDateToken(at: Date): string {
  const unix = Math.floor(at.getTime() / 1000);
  return `<!date^${unix}^{date_short_pretty} at {time}|${at.toISOString()}>`;
}

type Compose = (facts: never, translate: Translator) => ComposedMilestone;

/** The heading section every post shares: bold status, then the body line. */
function heading(
  translate: Translator,
  status: MessageKey,
  title: string,
  body: string,
): SlackBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${translate(status)}* · ${slackTitle(title)}\n${body}`,
    },
  };
}

/** The workflow and who started it, or nothing when neither is known. */
function context(facts: SlackMilestoneFacts, translate: Translator) {
  if (facts.workflowName && facts.startedBy) {
    return {
      type: "context" as const,
      elements: [{
        type: "mrkdwn" as const,
        text: translate("integrations.slack.post.context.workflowAndStarter", {
          workflow: escapeSlackText(facts.workflowName),
          starter: escapeSlackText(facts.startedBy),
        }),
      }],
    };
  }
  if (facts.workflowName) {
    return {
      type: "context" as const,
      elements: [{
        type: "mrkdwn" as const,
        text: translate("integrations.slack.post.context.workflow", {
          workflow: escapeSlackText(facts.workflowName),
        }),
      }],
    };
  }
  if (facts.startedBy) {
    return {
      type: "context" as const,
      elements: [{
        type: "mrkdwn" as const,
        text: translate("integrations.slack.post.context.starter", {
          starter: escapeSlackText(facts.startedBy),
        }),
      }],
    };
  }
  return null;
}

function button(
  translate: Translator,
  action: MessageKey,
  url: string,
  style?: "primary" | "danger",
): SlackButton {
  return {
    type: "button",
    text: {
      type: "plain_text",
      text: translate(action),
    },
    action_id: `bakery_${String(action).split(".").pop() ?? "action"}`,
    ...(style === undefined ? {} : { style }),
    value: url,
  };
}

/** The link to the live view: one name for one thing, on every post. */
function liveViewButton(translate: Translator, url: string): SlackButton {
  return button(translate, "integrations.slack.post.action.liveView", url);
}

/** Slack needs a plain-text fallback: it is the notification and the screen reader. */
function fallback(
  translate: Translator,
  status: MessageKey,
  title: string,
): string {
  return translate("integrations.slack.post.fallback", {
    status: translate(status),
    title: slackTitle(title),
  });
}

/** The decision buttons carry the decision's id, not a URL: a press acts. */
function decisionButtons(
  translate: Translator,
  facts: SlackWaitingFacts,
): readonly SlackButton[] {
  return [
    {
      type: "button",
      text: {
        type: "plain_text",
        text: translate("integrations.slack.post.action.approve"),
      },
      action_id: "bakery_approve",
      style: "primary",
      value: facts.decisionId,
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: translate("integrations.slack.post.action.reject"),
      },
      action_id: "bakery_reject",
      style: "danger",
      value: facts.decisionId,
    },
  ];
}

/**
 * Composes a milestone. Each arm is a separate function so the fact set a
 * milestone needs is the fact set the caller must have: a "done" post cannot be
 * composed without knowing whether there is a result, and a "stuck" post cannot
 * be composed without the step it is stuck at.
 */
export function composeStarted(
  facts: SlackMilestoneFacts,
  translate: Translator,
): ComposedMilestone {
  return {
    milestone: "started",
    decisionOpen: false,
    post: {
      channelId: "",
      fallbackText: fallback(
        translate,
        "integrations.slack.post.status.started",
        facts.title,
      ),
      blocks: [
        heading(
          translate,
          "integrations.slack.post.status.started",
          facts.title,
          translate("integrations.slack.post.body.started"),
        ),
        ...contextBlock(facts, translate),
        {
          type: "actions",
          elements: [liveViewButton(translate, facts.liveViewUrl)],
        },
      ],
    },
  };
}

export function composeWaiting(
  facts: SlackWaitingFacts,
  translate: Translator,
): ComposedMilestone {
  const body = facts.stepName
    ? translate("integrations.slack.post.body.waiting", {
      step: escapeSlackText(facts.stepName),
    })
    : translate("integrations.slack.post.body.waitingNoStep");
  return {
    milestone: "waiting",
    decisionOpen: true,
    post: {
      channelId: "",
      fallbackText: fallback(
        translate,
        "integrations.slack.post.status.waiting",
        facts.title,
      ),
      blocks: [
        heading(
          translate,
          "integrations.slack.post.status.waiting",
          facts.title,
          body,
        ),
        ...contextBlock(facts, translate),
        {
          type: "actions",
          elements: [
            ...decisionButtons(translate, facts),
            liveViewButton(translate, facts.liveViewUrl),
          ],
        },
      ],
    },
  };
}

export function composeStuck(
  facts: SlackStuckFacts,
  translate: Translator,
): ComposedMilestone {
  const step = facts.stepName ? escapeSlackText(facts.stepName) : null;
  const duration = facts.duration ? escapeSlackText(facts.duration) : null;
  // Both, step only, duration only, neither — four sentences, because a
  // sentence with an empty slot reads as a bug to the person seeing it.
  const body = step !== null && duration !== null
    ? translate("integrations.slack.post.body.stuck", { step, duration })
    : step !== null
    ? translate("integrations.slack.post.body.stuckNoDuration", { step })
    : duration !== null
    ? translate("integrations.slack.post.body.stuckNoStep", { duration })
    : translate("integrations.slack.post.body.stuckPlain");
  return {
    milestone: "stuck",
    decisionOpen: false,
    post: {
      channelId: "",
      fallbackText: fallback(
        translate,
        "integrations.slack.post.status.stuck",
        facts.title,
      ),
      blocks: [
        heading(
          translate,
          "integrations.slack.post.status.stuck",
          facts.title,
          body,
        ),
        ...contextBlock(facts, translate),
        {
          type: "actions",
          elements: [liveViewButton(translate, facts.liveViewUrl)],
        },
      ],
    },
  };
}

export function composeFailed(
  facts: SlackFailedFacts,
  translate: Translator,
): ComposedMilestone {
  const body = facts.stepName
    ? translate("integrations.slack.post.body.failed", {
      step: escapeSlackText(facts.stepName),
    })
    : translate("integrations.slack.post.body.failedNoStep");
  return {
    milestone: "failed",
    decisionOpen: false,
    post: {
      channelId: "",
      fallbackText: fallback(
        translate,
        "integrations.slack.post.status.failed",
        facts.title,
      ),
      blocks: [
        heading(
          translate,
          "integrations.slack.post.status.failed",
          facts.title,
          body,
        ),
        ...contextBlock(facts, translate),
        {
          type: "actions",
          elements: [liveViewButton(translate, facts.liveViewUrl)],
        },
      ],
    },
  };
}

/**
 * The done post. A pull request is the primary action and comes first, because
 * reviewing it is the next thing a person does; the copy never says the work is
 * approved or ready to merge.
 */
export function composeDone(
  facts: SlackDoneFacts,
  translate: Translator,
): ComposedMilestone {
  const result = facts.result;
  const body =
    result?.kind === "pull_request" && result.repository !== undefined
      ? translate("integrations.slack.post.body.donePullRequest", {
        repository: escapeSlackText(result.repository),
        number: result.number ?? 0,
      })
      : translate("integrations.slack.post.body.done");
  const actions = result === undefined
    ? [liveViewButton(translate, facts.liveViewUrl)]
    : [
      button(
        translate,
        result.kind === "pull_request"
          ? "integrations.slack.post.action.pullRequest"
          : "integrations.slack.post.action.result",
        result.url,
        "primary",
      ),
      liveViewButton(translate, facts.liveViewUrl),
    ];
  return {
    milestone: "done",
    decisionOpen: false,
    post: {
      channelId: "",
      fallbackText: fallback(
        translate,
        "integrations.slack.post.status.done",
        facts.title,
      ),
      blocks: [
        heading(
          translate,
          "integrations.slack.post.status.done",
          facts.title,
          body,
        ),
        ...contextBlock(facts, translate),
        { type: "actions", elements: actions },
      ],
    },
  };
}

/**
 * The rewrite of a decision post once it is no longer open: the buttons go,
 * however it was decided and wherever it was decided, so a press a day later
 * cannot decide anything twice.
 */
export function composeDecisionSettled(
  outcome:
    | {
      readonly kind: "approved" | "rejected";
      readonly decidedBy: string;
      readonly at: Date;
    }
    | { readonly kind: "closed" },
  facts: SlackMilestoneFacts,
  translate: Translator,
): SlackPost {
  const statusKey: MessageKey = outcome.kind === "approved"
    ? "integrations.slack.post.status.approved"
    : outcome.kind === "rejected"
    ? "integrations.slack.post.status.rejected"
    : "integrations.slack.post.status.closed";
  const body = outcome.kind === "closed"
    ? translate("integrations.slack.post.body.closed")
    : translate(
      outcome.kind === "approved"
        ? "integrations.slack.post.body.approved"
        : "integrations.slack.post.body.rejected",
      {
        name: escapeSlackText(outcome.decidedBy),
        time: slackDateToken(outcome.at),
      },
    );
  return {
    channelId: "",
    fallbackText: translate("integrations.slack.post.fallback", {
      status: translate(statusKey),
      title: slackTitle(facts.title),
    }),
    blocks: [
      heading(translate, statusKey, facts.title, body),
      ...contextBlock(facts, translate),
      {
        type: "actions",
        elements: [liveViewButton(translate, facts.liveViewUrl)],
      },
    ],
  };
}

function contextBlock(
  facts: SlackMilestoneFacts,
  translate: Translator,
): readonly SlackBlock[] {
  const block = context(facts, translate);
  return block === null ? [] : [block];
}

/** Unused-compose guard: every arm above is reachable through this table. */
export const SLACK_COMPOSERS = Object.freeze(
  {
    started: composeStarted,
    waiting: composeWaiting,
    stuck: composeStuck,
    failed: composeFailed,
    done: composeDone,
  } satisfies Record<string, unknown>,
);
