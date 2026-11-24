/**
 * What the shell knows about an update of the Bakery server (#59 slice 5).
 *
 * The launcher pauses work before it switches releases, and the public
 * installation status says so (`updatePaused`). A server that stops answering
 * after that pause was seen is being updated; one that stops answering with no
 * pause seen is only unreachable, and the shell keeps its usual wording for
 * that. When the server answers again, the release it reports tells an update
 * that went through from one that did not.
 */

/** How often the status is read while the server answers. */
export const UPDATE_POLL_MS = 15_000;
/** How often the status is read while Bakery is being updated. */
export const UPDATING_POLL_MS = 5_000;
/** After this long the updating page says it is taking longer than usual. */
export const UPDATING_LONGER_MS = 10 * 60_000;

export type UpdateWatchPhase =
  /** The server answers. */
  | "answering"
  /** The server stopped answering after it said an update paused work. */
  | "updating"
  /** The server stopped answering with no pause seen first. */
  | "unreachable";

export type UpdateWatchState = Readonly<{
  phase: UpdateWatchPhase;
  /** The last answer said the launcher has paused work for an update. */
  paused: boolean;
  /** The release the server last answered with; null until one is known. */
  release: string | null;
  /** When the server stopped answering during an update; null otherwise. */
  since: number | null;
}>;

export type UpdateWatchEvent =
  | Readonly<{
    type: "answered";
    updatePaused: boolean;
    release: string | null;
  }>
  | Readonly<{ type: "unreachable"; at: number }>;

/**
 * How an update ended, said once when the server answers again: `updated`
 * when it reports another release, `notUpdated` when it reports the same one.
 * Null when nothing ended, or when either release is unknown and so the two
 * cannot be told apart.
 */
export type UpdateOutcome = "updated" | "notUpdated" | null;

export const initialUpdateWatch: UpdateWatchState = Object.freeze({
  phase: "answering",
  paused: false,
  release: null,
  since: null,
});

/** The next state after a status read, and how an update ended, if one did. */
export function advanceUpdateWatch(
  state: UpdateWatchState,
  event: UpdateWatchEvent,
): { readonly state: UpdateWatchState; readonly outcome: UpdateOutcome } {
  if (event.type === "unreachable") {
    if (state.phase === "updating") return { state, outcome: null };
    return {
      state: state.paused
        ? { ...state, phase: "updating", since: event.at }
        : { ...state, phase: "unreachable", since: null },
      outcome: null,
    };
  }
  const outcome: UpdateOutcome =
    state.phase !== "updating" || state.release === null ||
      event.release === null
      ? null
      : event.release === state.release
      ? "notUpdated"
      : "updated";
  return {
    state: {
      phase: "answering",
      paused: event.updatePaused,
      release: event.release ?? state.release,
      since: null,
    },
    outcome,
  };
}

/** Whether the updating page should say the update takes longer than usual. */
export function updatingTooLong(state: UpdateWatchState, now: number): boolean {
  return state.phase === "updating" && state.since !== null &&
    now - state.since >= UPDATING_LONGER_MS;
}

/** Whole seconds until the next read, from 1 to the poll interval. */
export function secondsUntilNextCheck(lastCheck: number, now: number): number {
  const most = UPDATING_POLL_MS / 1000;
  const left = Math.ceil((lastCheck + UPDATING_POLL_MS - now) / 1000);
  return Math.min(most, Math.max(1, left));
}

/** The part of `Storage` the once-per-person toast needs. */
export type ToastMemory = Pick<Storage, "getItem" | "setItem">;

/**
 * Whether this person should be told "Bakery was updated." for `release`:
 * true the first time, false after that, in every tab. A browser that keeps
 * nothing (private mode, storage full) tells them each time rather than never.
 */
export function claimUpdatedToast(
  memory: ToastMemory | null,
  person: string,
  release: string,
): boolean {
  const key = `bakery.updated.${person}`;
  try {
    if (memory === null) return true;
    if (memory.getItem(key) === release) return false;
    memory.setItem(key, release);
    return true;
  } catch {
    return true;
  }
}
