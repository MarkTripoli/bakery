import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  PreviewAccessResponse,
  RunPreviewResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  previewAvailabilityQueryOptions,
  pullRequestsQueryOptions,
  runPreviewQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSession } from "../app/session-context.tsx";
import {
  minutesLeft,
  newerHeadSha,
  type PreviewCardState,
  previewCardState,
  sessionLength,
  shortSha,
} from "../app/run-preview.ts";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { choosePullRequest } from "./task-delivery/model.ts";

/** Where the live task reads stand; anything but `online`/`unknown` is "checking". */
export type PreviewConnectivity =
  | "unknown"
  | "online"
  | "offline"
  | "reconnecting";

/**
 * Opening a preview is two steps, as it is for a file: prepare, then open. The
 * grant secret lives only in this component's memory and one hidden form
 * field, for the 30 seconds the server accepts it.
 */
export type PreviewOpenState =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing" }
  | {
    readonly kind: "ready";
    readonly grant: PreviewAccessResponse;
    readonly secondsLeft: number;
  }
  | { readonly kind: "opened"; readonly sessionSeconds: number }
  | { readonly kind: "linkExpired" }
  | { readonly kind: "failed" };

export type RunPreviewCardViewProps = {
  readonly preview: RunPreviewResponse;
  readonly state: PreviewCardState;
  readonly open: PreviewOpenState;
  /** The live reads dropped: say so, and keep Open off until the state is read again. */
  readonly checking: boolean;
  /** The change's open pull request is at this commit, not the preview's; null when it is not. */
  readonly newerHeadSha: string | null;
  readonly stopping: boolean;
  readonly stopFailed: boolean;
  readonly currentPrincipalId: string | null;
  readonly now: Date;
  readonly onPrepare: () => void;
  readonly onStop: () => void;
  readonly onSubmitted: () => void;
  readonly headingId: string;
};

const FORM_ID = "run-preview-handoff-form";

const BADGE: Record<
  PreviewCardState["kind"],
  { tone: "neutral" | "success" | "warning"; key: MessageKey }
> = {
  unavailable: { tone: "neutral", key: "tasks.preview.badge.unavailable" },
  starting: { tone: "neutral", key: "tasks.preview.badge.starting" },
  running: { tone: "success", key: "tasks.preview.badge.running" },
  stopped: { tone: "neutral", key: "tasks.preview.badge.stopped" },
  ended: { tone: "neutral", key: "tasks.preview.badge.ended" },
  lost: { tone: "warning", key: "tasks.preview.badge.lost" },
};

/** The card, with every state reachable from props. */
export function RunPreviewCardView(props: RunPreviewCardViewProps) {
  const { locale, timeZone, translate } = useI18n();
  const { preview, state, open, checking } = props;
  const dayOf = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(value);
  // A time on today's date reads as the time alone; another day adds the date.
  const time = (value: string | null) => {
    if (value === null) return "";
    const at = new Date(value);
    return new Intl.DateTimeFormat(
      locale,
      dayOf(at) === dayOf(props.now)
        ? { timeStyle: "short", timeZone }
        : { dateStyle: "medium", timeStyle: "short", timeZone },
    ).format(at);
  };
  const older = state.kind === "running" ? props.newerHeadSha : null;
  const badge = older === null
    ? BADGE[state.kind]
    : { tone: "warning" as const, key: "tasks.preview.badge.older" as const };

  const stopped = (): string => {
    if (state.kind !== "stopped") return "";
    if (state.reason === "person") {
      return state.byName === null && state.by !== props.currentPrincipalId
        ? translate("tasks.preview.stopped.unnamed", { time: time(state.at) })
        : translate("tasks.preview.stopped.person", {
          name: state.by !== null && state.by === props.currentPrincipalId
            ? translate("tasks.preview.name.you")
            : state.byName,
          time: time(state.at),
        });
    }
    return state.reason === "run_cancelled"
      ? translate("tasks.preview.stopped.cancelled", { time: time(state.at) })
      : translate("tasks.preview.stopped.replaced");
  };

  // The one sentence of the card: what the state means for the person.
  const sentence = (): string => {
    const again = translate("tasks.preview.again");
    switch (state.kind) {
      case "unavailable":
        // The badge says "Not set up"; the sentence says only what to do.
        return translate("tasks.preview.unavailable.admin");
      case "starting":
        return translate("tasks.preview.body.starting");
      case "running":
        // A stop is out: the face says so and offers nothing until it answers.
        if (props.stopping) return translate("tasks.preview.caption.stopping");
        if (checking) return translate("tasks.preview.caption.checking");
        if (open.kind === "opened") {
          const length = sessionLength(open.sessionSeconds);
          return translate("tasks.preview.opened", {
            duration: translate(
              length.unit === "hour"
                ? "tasks.preview.duration.hours"
                : "tasks.preview.duration.minutes",
              { count: length.count },
            ),
          });
        }
        return older === null
          ? translate("tasks.preview.body.running")
          : translate("tasks.preview.older.body");
      case "stopped":
        return `${stopped()} ${again}`;
      case "ended":
        return `${
          translate(
            state.reason === "time_limit"
              ? "tasks.preview.ended.timeLimit"
              : "tasks.preview.ended.runEnded",
            { time: time(state.at) },
          )
        } ${again}`;
      case "lost":
        return `${
          translate("tasks.preview.lost.lead", { time: time(state.at) })
        } ${translate("tasks.preview.lost.rest")}`;
    }
  };

  // One error at a time: the newest. The card clears the older one.
  const error: MessageKey | null = props.stopFailed
    ? "tasks.preview.stopFailed"
    : open.kind === "failed"
    ? "tasks.preview.openFailed"
    : open.kind === "linkExpired"
    ? "artifact.handoff.expired"
    : null;
  // Only a running preview that has been checked can be opened; every other
  // state shows no button at all, and its sentence says why.
  const canOpen = state.kind === "running" && !checking && !props.stopping;
  const running = state.kind === "running";
  const hasDetails = state.kind !== "starting" && state.kind !== "unavailable";

  return (
    <UI.PaneSection
      ruled
      heading="strong"
      title={translate("tasks.preview.heading")}
      trailing={<UI.Badge tone={badge.tone}>{translate(badge.key)}</UI.Badge>}
      // Focus returns to the card after Stop: the section, named by its heading.
      id={props.headingId}
      tabIndex={-1}
      aria-label={translate("tasks.preview.heading")}
      data-testid="run-preview"
      data-preview-state={state.kind}
    >
      <UI.Stack gap="compact">
        <UI.Text data-testid="run-preview-body">{sentence()}</UI.Text>
        {error === null
          ? null
          : (
            <UI.InlineNotice tone="error" data-testid="run-preview-error">
              {translate(error)}
            </UI.InlineNotice>
          )}

        {canOpen && open.kind === "ready"
          ? (
            <>
              <UI.HandoffForm
                action={open.grant.exchangeUrl}
                data-testid="run-preview-form"
                fields={{ grant: open.grant.grant }}
                id={FORM_ID}
                onSubmit={props.onSubmitted}
                target="_blank"
              />
              <UI.Inline gap="compact">
                <UI.Button
                  type="submit"
                  form={FORM_ID}
                  data-testid="run-preview-open"
                >
                  {translate(
                    older === null
                      ? "artifact.handoff.open"
                      : "tasks.preview.openAnyway",
                  )}
                </UI.Button>
              </UI.Inline>
              <UI.Text variant="caption" role="timer" aria-live="off">
                {translate("tasks.preview.linkExpires", {
                  seconds: open.secondsLeft,
                })}
              </UI.Text>
            </>
          )
          : canOpen
          ? (
            <UI.Inline gap="compact">
              <UI.Button
                variant={open.kind === "opened" || older !== null
                  ? "outline"
                  : "primary"}
                data-testid="run-preview-prepare"
                state={open.kind === "preparing" ? "loading" : "default"}
                onClick={props.onPrepare}
              >
                {translate(
                  open.kind === "preparing"
                    ? "artifact.handoff.preparing"
                    : open.kind === "opened"
                    ? "tasks.preview.openAgain"
                    : "artifact.handoff.prepare",
                )}
              </UI.Button>
            </UI.Inline>
          )
          : null}

        {hasDetails
          ? (
            <UI.Disclosure
              summary={translate("tasks.preview.details.summary")}
              data-testid="run-preview-details"
            >
              <UI.Stack gap="compact">
                <UI.DetailRow
                  label={translate("tasks.preview.details.preview")}
                >
                  <UI.DataText fit>{shortSha(preview.headSha)}</UI.DataText>
                  {", "}
                  {translate("tasks.preview.details.notReleased")}
                </UI.DetailRow>
                {older === null ? null : (
                  <UI.DetailRow
                    label={translate("tasks.preview.details.change")}
                  >
                    <UI.DataText fit>{shortSha(older)}</UI.DataText>
                  </UI.DetailRow>
                )}
                {state.kind === "running"
                  ? (
                    <>
                      <UI.DetailRow
                        label={translate("tasks.preview.details.stops")}
                      >
                        {translate("tasks.preview.details.stopsValue", {
                          time: time(state.expiresAt),
                          minutes: minutesLeft(state.expiresAt, props.now),
                        })}
                      </UI.DetailRow>
                      <UI.DetailRow
                        label={translate("tasks.preview.details.address")}
                      >
                        {translate("tasks.preview.details.addressValue")}
                      </UI.DetailRow>
                    </>
                  )
                  : null}
                {state.kind === "stopped" || state.kind === "ended"
                  ? (
                    <UI.Text variant="hint">
                      {translate("tasks.preview.stopped.tabs")}
                    </UI.Text>
                  )
                  : null}
                {running
                  ? (
                    <UI.Inline gap="compact">
                      <UI.Button
                        variant="outline"
                        data-testid="run-preview-stop"
                        state={props.stopping ? "loading" : "default"}
                        onClick={props.onStop}
                      >
                        {translate(
                          props.stopping
                            ? "tasks.preview.stopping"
                            : "tasks.preview.stop",
                        )}
                      </UI.Button>
                    </UI.Inline>
                  )
                  : null}
              </UI.Stack>
            </UI.Disclosure>
          )
          : null}
        {/* One status region announces every change of state. */}
        <UI.VisuallyHidden as="div" role="status" aria-live="polite">
          {`${translate(badge.key)}. ${sentence()}`}
        </UI.VisuallyHidden>
      </UI.Stack>
    </UI.PaneSection>
  );
}

/**
 * The Preview card of a run's pane. It appears only when the run has a
 * preview, and shows exactly what the server read: the run's task reads
 * refresh it, and it re-reads when its own time limit passes.
 */
export function RunPreviewCard(
  { runId, taskId, connectivity = "online" }: {
    readonly runId: string;
    readonly taskId: string;
    readonly connectivity?: PreviewConnectivity;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const session = useSession();
  const headingId = useId();
  const [open, setOpen] = useState<PreviewOpenState>({ kind: "idle" });
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());
  // One controller per action: stopping must never cancel opening, nor the
  // other way round, or the cancelled one never clears its own state.
  const prepareController = useRef<AbortController | null>(null);
  const stopController = useRef<AbortController | null>(null);
  const preview = useQuery(runPreviewQueryOptions(api, scope, runId));
  const record = preview.data ?? null;
  const availability = useQuery({
    ...previewAvailabilityQueryOptions(api, scope),
    enabled: scope.organizationId !== null && record !== null,
  });
  const state = previewCardState(record, availability.data?.available);
  // Only a live preview is compared, and only with the change's open pull
  // request. A read that fails says nothing: no comparison, no notice.
  const pullRequests = useQuery({
    ...pullRequestsQueryOptions(api, scope, taskId),
    enabled: scope.organizationId !== null && state?.kind === "running",
    // No task event says that a pull request moved, so the card asks. A slow
    // cadence is enough: "Behind" only has to appear within the minute, and a
    // hidden tab does not poll at all.
    refetchInterval: 30_000,
  });
  const newer = record === null ? null : newerHeadSha(
    state,
    record.headSha,
    choosePullRequest(pullRequests.data?.items ?? [], runId),
  );

  useEffect(() => () => {
    prepareController.current?.abort();
    stopController.current?.abort();
  }, []);

  // The 30 second grant window is the only countdown; it drops the secret when
  // the server would refuse it.
  const readyGrant = open.kind === "ready" ? open.grant : null;
  useEffect(() => {
    if (!readyGrant) return;
    const tick = () => {
      const remaining = Math.ceil(
        (new Date(readyGrant.expiresAt).getTime() - Date.now()) / 1000,
      );
      if (remaining <= 0) {
        setOpen({ kind: "linkExpired" });
        return;
      }
      setOpen((current) =>
        current.kind === "ready" && current.secondsLeft !== remaining
          ? { ...current, secondsLeft: remaining }
          : current
      );
    };
    const timer = globalThis.setInterval(tick, 500);
    return () => globalThis.clearInterval(timer);
  }, [readyGrant]);

  // A preview that reaches its time limit changes with nothing sent to the
  // page: re-read the moment it is due, and keep the clock the caption uses.
  const expiresAt = state?.kind === "running" ? state.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const wait = new Date(expiresAt).getTime() - Date.now();
    const timer = globalThis.setTimeout(
      () => void preview.refetch(),
      Math.min(Math.max(wait, 0) + 500, 2 ** 31 - 1),
    );
    const clock = globalThis.setInterval(() => setNow(new Date()), 30_000);
    return () => {
      globalThis.clearTimeout(timer);
      globalThis.clearInterval(clock);
    };
  }, [expiresAt, preview.refetch]);

  // A preview that stopped while the grant was in hand offers nothing to open.
  useEffect(() => {
    if (
      state !== null && state.kind !== "running" && state.kind !== "starting"
    ) {
      setOpen((current) =>
        current.kind === "idle" ? current : { kind: "idle" }
      );
    }
  }, [state?.kind]);

  if (record === null || state === null || scope.organizationId === null) {
    return null;
  }
  const organizationId = scope.organizationId;

  const prepare = async () => {
    if (open.kind === "preparing") return;
    prepareController.current?.abort();
    const abort = new AbortController();
    prepareController.current = abort;
    setStopFailed(false);
    setOpen({ kind: "preparing" });
    const result = await api.previews.access({
      organizationId,
      previewId: record.id,
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    if (!result.ok) {
      setOpen({ kind: "failed" });
      // The preview may have stopped meanwhile: read the truth.
      void preview.refetch();
      return;
    }
    const grant = result.data;
    setOpen({
      kind: "ready",
      grant,
      secondsLeft: Math.max(
        1,
        Math.ceil((new Date(grant.expiresAt).getTime() - Date.now()) / 1000),
      ),
    });
  };

  const stop = async () => {
    if (stopping) return;
    // A preview that is being stopped is not opened: drop an open in flight.
    prepareController.current?.abort();
    const abort = new AbortController();
    stopController.current = abort;
    setStopping(true);
    setStopFailed(false);
    // One error at a time: a new stop clears an older open error, and an open
    // that was just dropped must not stay "preparing".
    setOpen((current) =>
      current.kind === "failed" || current.kind === "linkExpired" ||
        current.kind === "preparing"
        ? { kind: "idle" }
        : current
    );
    const result = await api.previews.stop({
      organizationId,
      previewId: record.id,
      idempotencyKey: crypto.randomUUID(),
      signal: abort.signal,
    });
    // Only leaving the page cancels a stop.
    if (abort.signal.aborted) return;
    setStopping(false);
    if (!result.ok) {
      setStopFailed(true);
      return;
    }
    setOpen({ kind: "idle" });
    await preview.refetch();
    // Focus goes to the card's heading, where the new state starts.
    globalThis.requestAnimationFrame(() =>
      document.getElementById(headingId)?.focus()
    );
  };

  return (
    <RunPreviewCardView
      preview={record}
      state={state}
      open={open}
      checking={connectivity === "offline" || connectivity === "reconnecting"}
      newerHeadSha={newer}
      stopping={stopping}
      stopFailed={stopFailed}
      currentPrincipalId={session.identity?.principalId ?? null}
      now={now}
      headingId={headingId}
      onPrepare={() => void prepare()}
      onStop={() => void stop()}
      onSubmitted={() => {
        // After the browser has taken the form data for its own submit, drop the
        // secret from this page.
        globalThis.setTimeout(() =>
          setOpen((current) =>
            current.kind === "ready"
              ? { kind: "opened", sessionSeconds: current.grant.sessionSeconds }
              : current
          ), 0);
      }}
    />
  );
}
