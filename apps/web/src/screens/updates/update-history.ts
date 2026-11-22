/**
 * How the Updates page (#59, design-ux revisions 3 and 4) names each update
 * event, the notice for the last one that did not go through, and the facts.
 *
 * Every function here is pure and returns catalogue keys with the values they
 * take, so the rules can be tested without a browser.
 */
import type {
  InstallationUpdateEvent,
  InstallationUpdateStatus,
} from "../../api/client.ts";

/** A release as a person reads it: the first 8 characters of its id. */
export function shortRelease(release: string): string {
  return release.slice(0, 8);
}

export type UpdateBadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "information";

/** Which value of an event fills a slot in its sentence. */
export type UpdateSlots = {
  readonly from: string | null;
  readonly to: string | null;
  readonly by: string | null;
  readonly detail: string | null;
};

export type UpdateRow = {
  readonly event: InstallationUpdateEvent;
  readonly result:
    | "installation.updates.result.installed"
    | "installation.updates.result.updated"
    | "installation.updates.result.notReady"
    | "installation.updates.result.rolledBack"
    | "installation.updates.result.wentBack"
    | "installation.updates.result.refused"
    | "installation.updates.result.decision"
    | "installation.updates.result.interrupted";
  readonly tone: UpdateBadgeTone;
  readonly what:
    | "installation.updates.what.installed"
    | "installation.updates.what.updated"
    | "installation.updates.what.notReady"
    | "installation.updates.what.rolledBack"
    | "installation.updates.what.wentBack"
    | "installation.updates.what.refused"
    | "installation.updates.what.decidedGoBack"
    | "installation.updates.what.decidedStay"
    | "installation.updates.what.decidedStayNobody"
    | "installation.updates.what.interrupted";
  /** The version the event tried to run, or null for a hand-made rollback. */
  readonly newRelease: string | null;
  readonly by:
    | "installation.updates.by.person"
    | "installation.updates.by.bakery";
};

/**
 * One row per event, in the order given (newest first). An `updated` row
 * whose newer neighbour is a `decided_stay` on the same release reads as
 * "Not ready": the update happened, and then the release did not become ready.
 */
export function updateRows(
  events: readonly InstallationUpdateEvent[],
): UpdateRow[] {
  return events.map((event, index) => {
    const above = index > 0 ? events[index - 1] : undefined;
    const by = event.by === null
      ? "installation.updates.by.bakery" as const
      : "installation.updates.by.person" as const;
    switch (event.kind) {
      case "installed":
        return {
          event,
          by,
          result: "installation.updates.result.installed",
          tone: "neutral",
          what: "installation.updates.what.installed",
          newRelease: event.toRelease,
        };
      case "updated":
        return above?.kind === "decided_stay" &&
            above.fromRelease !== null &&
            above.fromRelease === event.toRelease
          ? {
            event,
            by,
            result: "installation.updates.result.notReady",
            tone: "warning",
            what: "installation.updates.what.notReady",
            newRelease: event.toRelease,
          }
          : {
            event,
            by,
            result: "installation.updates.result.updated",
            tone: "success",
            what: "installation.updates.what.updated",
            newRelease: event.toRelease,
          };
      case "rolled_back":
        return {
          event,
          by,
          result: "installation.updates.result.rolledBack",
          tone: "neutral",
          what: "installation.updates.what.rolledBack",
          newRelease: null,
        };
      case "went_back":
        return {
          event,
          by,
          result: "installation.updates.result.wentBack",
          tone: "warning",
          what: "installation.updates.what.wentBack",
          newRelease: event.fromRelease,
        };
      case "refused":
        return {
          event,
          by,
          result: "installation.updates.result.refused",
          tone: "neutral",
          what: "installation.updates.what.refused",
          newRelease: event.toRelease,
        };
      case "decided_go_back":
        return {
          event,
          by,
          result: "installation.updates.result.decision",
          tone: "information",
          what: "installation.updates.what.decidedGoBack",
          newRelease: event.fromRelease,
        };
      case "decided_stay":
        return {
          event,
          by,
          result: "installation.updates.result.decision",
          tone: "information",
          what: event.by === null
            ? "installation.updates.what.decidedStayNobody"
            : "installation.updates.what.decidedStay",
          newRelease: event.fromRelease,
        };
      case "interrupted":
        return {
          event,
          by,
          result: "installation.updates.result.interrupted",
          tone: "danger",
          what: "installation.updates.what.interrupted",
          newRelease: event.fromRelease,
        };
    }
  });
}

export type FailureNotice = {
  readonly title:
    | "installation.updates.notice.didNotGoThrough"
    | "installation.updates.notice.stayed"
    | "installation.updates.notice.interrupted";
  readonly body:
    | "installation.updates.notice.wentBack"
    | "installation.updates.notice.decidedGoBack"
    | "installation.updates.notice.decidedStay"
    | "installation.updates.notice.decidedStayNobody"
    | "installation.updates.notice.interruptedBody";
  readonly tone: "warning" | "error";
};

/**
 * The notice at the top for the last update that did not go through, or null
 * when there is none. A choice to stay on a release that is not ready is the
 * danger tone: Bakery runs it now.
 */
export function failureNotice(
  failure: InstallationUpdateEvent | null,
): FailureNotice | null {
  if (failure === null) return null;
  switch (failure.kind) {
    case "went_back":
      return {
        title: "installation.updates.notice.didNotGoThrough",
        body: "installation.updates.notice.wentBack",
        tone: "warning",
      };
    case "decided_go_back":
      return {
        title: "installation.updates.notice.didNotGoThrough",
        // Bakery waited only for a person; without one it went back by itself.
        body: failure.by === null
          ? "installation.updates.notice.wentBack"
          : "installation.updates.notice.decidedGoBack",
        tone: "warning",
      };
    case "decided_stay":
      return {
        title: "installation.updates.notice.stayed",
        body: failure.by === null
          ? "installation.updates.notice.decidedStayNobody"
          : "installation.updates.notice.decidedStay",
        tone: "error",
      };
    case "interrupted":
      return {
        title: "installation.updates.notice.interrupted",
        body: "installation.updates.notice.interruptedBody",
        tone: "warning",
      };
    default:
      return null;
  }
}

export type RunningFact = {
  readonly key:
    | "installation.updates.facts.runningValue"
    | "installation.updates.facts.runningValueUndated";
  readonly release: string;
  readonly since: string | null;
};

export type PreviousFact =
  | { readonly key: "installation.updates.facts.previousNone" }
  | {
    readonly key: "installation.updates.facts.previousValue";
    readonly release: string;
    readonly from: string;
    readonly to: string;
  }
  | {
    readonly key: "installation.updates.facts.previousUntil";
    readonly release: string;
    readonly to: string;
  };

/** "Running now", with no date when the history does not say since when. */
export function runningFact(status: InstallationUpdateStatus): RunningFact {
  return status.runningSince === null
    ? {
      key: "installation.updates.facts.runningValueUndated",
      release: status.runningRelease,
      since: null,
    }
    : {
      key: "installation.updates.facts.runningValue",
      release: status.runningRelease,
      since: status.runningSince,
    };
}

/** "Can go back to", with only the end date when the start is not known. */
export function previousFact(status: InstallationUpdateStatus): PreviousFact {
  if (status.previousRelease === null || status.previousRanUntil === null) {
    return { key: "installation.updates.facts.previousNone" };
  }
  return status.previousRanFrom === null
    ? {
      key: "installation.updates.facts.previousUntil",
      release: status.previousRelease,
      to: status.previousRanUntil,
    }
    : {
      key: "installation.updates.facts.previousValue",
      release: status.previousRelease,
      from: status.previousRanFrom,
      to: status.previousRanUntil,
    };
}

/** Why the policy cannot be changed right now, or null when it can. */
export function policyLock(
  status: { readonly restoreHeld?: boolean; readonly updatePaused?: boolean },
): "held" | "paused" | null {
  return status.restoreHeld === true
    ? "held"
    : status.updatePaused === true
    ? "paused"
    : null;
}

/** Marks a slot in a translated sentence so a node can take its place. */
export const SLOT = "\u0001";

/** The pieces of a sentence translated with `slot(name)` values, in order. */
export type SentencePart = { readonly text: string } | {
  readonly slot: string;
};

export function splitSlots(text: string): SentencePart[] {
  const parts = text.split(SLOT);
  // Odd positions are slot names: "a \u0001from\u0001 b" splits in three.
  return parts.flatMap((part, index): SentencePart[] =>
    index % 2 === 1 ? [{ slot: part }] : part === "" ? [] : [{ text: part }]
  );
}

/** The value to translate with, so splitSlots finds the slot again. */
export function slot(name: string): string {
  return `${SLOT}${name}${SLOT}`;
}
