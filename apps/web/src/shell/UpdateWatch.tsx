import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { ApiFailure } from "../api/client.ts";
import { installationUpdateQueryOptions } from "../api/query.ts";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  advanceUpdateWatch,
  claimUpdatedToast,
  initialUpdateWatch,
  secondsUntilNextCheck,
  UPDATE_POLL_MS,
  type UpdateOutcome,
  type UpdateWatchEvent,
  type UpdateWatchState,
  UPDATING_POLL_MS,
  updatingTooLong,
} from "./update-watch.ts";

type Watched = Readonly<{
  watch: UpdateWatchState;
  /** How the last update ended, and a count that changes each time one does. */
  outcome: UpdateOutcome;
  ended: number;
}>;

function reduce(current: Watched, event: UpdateWatchEvent): Watched {
  const next = advanceUpdateWatch(current.watch, event);
  if (next.state === current.watch && next.outcome === null) return current;
  return {
    watch: next.state,
    outcome: next.outcome ?? current.outcome,
    ended: next.outcome === null ? current.ended : current.ended + 1,
  };
}

/** No answer at all, or the proxy's answer in place of the server's. */
function unreachable(error: ApiFailure): boolean {
  return error.kind === "network" ||
    (error.kind === "invalid-response" && error.status >= 500);
}

export type UpdateWatch = Readonly<{
  /** The server answers and says an update has paused work. */
  paused: boolean;
  /** The server went away after it said so. */
  updating: boolean;
  watch: UpdateWatchState;
  /** When the status was last read, for the countdown. */
  lastCheck: number;
  outcome: UpdateOutcome;
  ended: number;
}>;

/**
 * Reads the public installation status for the whole shell: every 15 seconds
 * while the server answers, every 5 while Bakery is being updated. When the
 * server answers again after an update every query is read again, so the page
 * under the updating page carries on with what the server has now.
 */
export function useUpdateWatch(): UpdateWatch {
  const api = useBakeryApi();
  const queryClient = useQueryClient();
  const [watched, dispatch] = useReducer(reduce, {
    watch: initialUpdateWatch,
    outcome: null,
    ended: 0,
  });
  const updating = watched.watch.phase === "updating";
  const status = useQuery({
    ...installationUpdateQueryOptions(api),
    refetchInterval: updating ? UPDATING_POLL_MS : UPDATE_POLL_MS,
    refetchIntervalInBackground: updating,
  });
  const { data, dataUpdatedAt, error, errorUpdatedAt } = status;
  useEffect(() => {
    if (data === undefined || dataUpdatedAt === 0) return;
    dispatch({
      type: "answered",
      updatePaused: data.updatePaused === true,
      release: typeof data.release === "string" ? data.release : null,
    });
  }, [data, dataUpdatedAt]);
  useEffect(() => {
    if (error === null || errorUpdatedAt === 0 || !unreachable(error)) return;
    dispatch({ type: "unreachable", at: Date.now() });
  }, [error, errorUpdatedAt]);
  useEffect(() => {
    if (watched.ended === 0) return;
    void queryClient.invalidateQueries();
  }, [queryClient, watched.ended]);
  return {
    paused: watched.watch.phase === "answering" && watched.watch.paused,
    updating,
    watch: watched.watch,
    lastCheck: Math.max(dataUpdatedAt, errorUpdatedAt),
    outcome: watched.outcome,
    ended: watched.ended,
  };
}

/**
 * The whole content area while Bakery is being updated. The page under it
 * stays mounted (the layout only hides it), so text typed before is kept. The
 * countdown is not announced; the page's arrival is, once, by UpdateNotices.
 */
export function UpdatingPage({ update }: { readonly update: UpdateWatch }) {
  const { locale, timeZone, translate } = useI18n();
  const { resolvedTheme } = UI.useTheme();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(tick);
  }, []);
  const art = UI.scene("maintenance", { theme: resolvedTheme, width: 600 });
  const since = update.watch.since ?? now;
  const line = updatingTooLong(update.watch, now)
    ? translate("shell.states.updatingLonger")
    : translate("shell.states.updatingChecking", {
      time: new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone })
        .format(since),
      seconds: secondsUntilNextCheck(update.lastCheck, now),
    });
  return (
    <UI.EmptyState
      data-testid="updating-page"
      description={
        <UI.Stack gap="tight">
          <UI.Text variant="muted">
            {translate("shell.states.updatingDescription")}
          </UI.Text>
          <UI.Text data-testid="updating-check" variant="caption">
            {line}
          </UI.Text>
        </UI.Stack>
      }
      icon={
        <img
          alt=""
          height={Math.round(art.height * ART_WIDTH / art.width)}
          sizes={`${ART_WIDTH}px`}
          src={art.src}
          srcSet={art.srcSet}
          width={ART_WIDTH}
        />
      }
      layout="centered"
      title={translate("shell.states.updatingTitle")}
    />
  );
}

/** The maintenance art is drawn this wide, as in the design. */
const ART_WIDTH = 240;

/**
 * The two announcements and the toast. Arriving on the updating page is said
 * once; coming back is said once, by the toast when there is one. "Bakery was
 * updated." is shown once per person for each release, in any tab.
 */
export function UpdateNotices({ update }: { readonly update: UpdateWatch }) {
  const { translate } = useI18n();
  const session = useSession();
  const person = session.identity?.principalId ?? "anonymous";
  const [toast, setToast] = useState<string | null>(null);
  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    if (update.updating) {
      setToast(null);
      setSpoken(translate("shell.states.updatingTitle"));
    }
  }, [translate, update.updating]);
  const { ended, outcome } = update;
  const release = update.watch.release;
  // Only a new ending speaks; a new person or release alone changes nothing.
  const handled = useRef(0);
  useEffect(() => {
    if (ended === handled.current || outcome === null) return;
    handled.current = ended;
    if (outcome === "notUpdated") {
      setSpoken("");
      setToast(translate("shell.states.updatingNotUpdated"));
      return;
    }
    const message = translate("shell.states.updatingUpdated");
    const memory = typeof localStorage === "undefined" ? null : localStorage;
    if (release !== null && claimUpdatedToast(memory, person, release)) {
      setSpoken("");
      setToast(message);
    } else {
      // Told already: no toast, but coming back is still said once.
      setSpoken(message);
    }
  }, [ended, outcome, person, release, translate]);
  return (
    <>
      <UI.VisuallyHidden
        aria-live="polite"
        as="div"
        data-testid="update-announcement"
        role="status"
      >
        {spoken}
      </UI.VisuallyHidden>
      {toast === null
        ? null
        : (
          <UI.Toast data-testid="update-toast" onDismiss={() => setToast(null)}>
            {toast}
          </UI.Toast>
        )}
    </>
  );
}
