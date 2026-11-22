import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { formatDate, formatNumber } from "@bakery/i18n";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { stepTitle } from "../task-timeline.ts";
import { Chooser } from "./Chooser.tsx";
import {
  cardCopy,
  continuedNotice,
  type Offer,
  outcomeUnknown,
  refusalOf,
  type Target,
  whenText,
} from "./model.ts";

type Notice = Readonly<{ tone: "success" | "warning"; text: string }>;

/**
 * The cards for the steps of a run that wait on a model, the chooser that
 * picks another way to run one, and the notice after a choice (#70, slice 2).
 * Bakery never switches by itself: a card only offers the choice, and the
 * choice is sent once against the exact offer the person saw. When the
 * incident closes the offer goes and the card goes with it, without a notice.
 */
export function RouteWaiting(
  { taskId, runId, offers, failed, retrying, onRetry }: {
    readonly taskId: string;
    readonly runId: string;
    /** The offers old enough to show, oldest first. */
    readonly offers: readonly Offer[];
    /** The run waits on a model, but the choices could not be read. */
    readonly failed: boolean;
    readonly retrying: boolean;
    readonly onRetry: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const cache = useQueryClient();
  const phone = useShellViewport() === "phone";
  const { translate: t, locale, timeZone } = useI18n();
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const alive = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const when = (iso: string) =>
    whenText(
      iso,
      Date.now(),
      (value, options) => formatDate(value, locale, { timeZone, ...options }),
    );
  const money = (value: number) =>
    formatNumber(value, locale, { style: "currency", currency: "USD" });

  const open = offers.find((offer) => offer.runStepId === openStep) ?? null;

  const closeChooser = () => {
    setOpenStep(null);
    setProblem(null);
    pending.current = null;
    // The card's button takes focus back once the chooser is gone.
    const button = opener.current;
    requestAnimationFrame(() => {
      if (button?.isConnected) button.focus();
    });
  };

  // The offer went while the chooser was open and nothing was being sent: what
  // the person was choosing is gone, so the page says so and the chooser goes.
  useEffect(() => {
    if (openStep === null || working || open !== null) return;
    setOpenStep(null);
    setProblem(null);
    pending.current = null;
    setNotice({ tone: "warning", text: t("tasks.waiting.refused.changed") });
    requestAnimationFrame(() =>
      document.getElementById("task-run-heading")?.focus()
    );
  }, [openStep, working, open, t]);

  const refresh = async () => {
    try {
      await cache.invalidateQueries({
        predicate: ({ queryKey: key }) => {
          if (
            key[0] !== "protected" || key[1] !== scope.sessionGeneration ||
            key[2] !== scope.organizationId
          ) return false;
          const input = key[4];
          if (typeof input !== "object" || input === null) return false;
          return ("id" in input && input.id === taskId) ||
            ("taskId" in input && input.taskId === taskId) ||
            ("runId" in input && input.runId === runId);
        },
      });
    } catch {
      // The page keeps what it has; the next read says what changed.
    }
  };

  const submit = async (target: Target) => {
    const organizationId = scope.organizationId;
    if (open === null || working || organizationId === null) return;
    const input = {
      runStepId: open.runStepId,
      incidentId: open.incidentId,
      incidentGeneration: open.incidentGeneration,
      targetRouteId: target.routeId,
      runVersion: open.runVersion,
    };
    // The same choice sent again after a lost answer reuses its key, so it can
    // never be admitted twice.
    const signature = JSON.stringify(input);
    const key = pending.current?.signature === signature
      ? pending.current.key
      : crypto.randomUUID();
    pending.current = { signature, key };
    setWorking(true);
    setProblem(null);
    const result = await api.admitRouteContinuation({
      organizationId,
      runId,
      input,
      idempotencyKey: key,
    });
    if (!alive.current) return;
    setWorking(false);
    if (result.ok) {
      closeChooser();
      setNotice({ tone: "success", text: continuedNotice(t, target) });
      await refresh();
      return;
    }
    // Only a definite answer ends the key; a lost one keeps it for the retry.
    if (!outcomeUnknown(result.error)) pending.current = null;
    const refusal = refusalOf(result.error);
    if (refusal.where === "page") {
      closeChooser();
      setNotice({ tone: "warning", text: t(refusal.key) });
    } else {
      setProblem(t(refusal.key));
    }
    if (refusal.reload) void refresh();
  };

  // Nothing to show is nothing drawn: an empty stack still takes a full gap in
  // the run section.
  if (offers.length === 0 && !failed && notice === null) return null;

  return (
    <UI.Stack gap="standard" data-testid="route-waiting">
      {failed && offers.length === 0
        ? (
          // The run says a step waits but the choices did not load: the card
          // stays, and where the chooser would be the page says so.
          <UI.AlertBanner
            action={
              <UI.Button
                data-testid="route-waiting-retry"
                variant="secondary"
                loading={retrying}
                onClick={onRetry}
              >
                {t("tasks.waiting.chooser.retry")}
              </UI.Button>
            }
            data-testid="route-waiting-card"
            tone="warning"
          >
            <UI.Stack gap="tight">
              <UI.Heading level="subsection">
                {t("tasks.waiting.unknownTitle")}
              </UI.Heading>
              <UI.Text variant="muted">{t("tasks.waiting.second")}</UI.Text>
              <UI.Text data-testid="route-waiting-load-failed">
                {t("tasks.waiting.loadFailed")}
              </UI.Text>
            </UI.Stack>
          </UI.AlertBanner>
        )
        : null}
      {offers.map((offer) => {
        const copy = cardCopy(
          offer,
          t,
          when,
          (key) => stepTitle(t, key),
        );
        const isOpen = openStep === offer.runStepId;
        return (
          <UI.Stack gap="standard" key={offer.runStepId}>
            <UI.AlertBanner
              action={copy.button === null ? undefined : (
                <UI.Button
                  aria-expanded={isOpen}
                  data-testid="route-waiting-choose"
                  disabled={working}
                  variant="secondary"
                  onClick={(event) => {
                    if (isOpen) {
                      closeChooser();
                      return;
                    }
                    opener.current = event.currentTarget;
                    setProblem(null);
                    pending.current = null;
                    setOpenStep(offer.runStepId);
                  }}
                >
                  {isOpen ? t("tasks.waiting.chooseClose") : copy.button}
                </UI.Button>
              )}
              data-testid="route-waiting-card"
              data-step-key={offer.stepKey}
              tone="warning"
            >
              <UI.Stack gap="tight">
                <UI.Heading level="subsection">{copy.title}</UI.Heading>
                <UI.Text>{copy.text}</UI.Text>
                <UI.Text variant="muted">{copy.second}</UI.Text>
              </UI.Stack>
            </UI.AlertBanner>
            {isOpen && open !== null
              ? (
                <Chooser
                  key={`${open.runStepId}:${open.incidentGeneration}:${open.runVersion}`}
                  money={money}
                  offer={open}
                  onContinue={(target) => void submit(target)}
                  onKeep={closeChooser}
                  phone={phone}
                  problem={problem}
                  t={t}
                  working={working}
                />
              )
              : null}
          </UI.Stack>
        );
      })}
      {notice === null ? null : (
        <UI.InlineNotice
          data-testid="route-waiting-notice"
          onDismiss={() => setNotice(null)}
          tone={notice.tone}
        >
          {notice.text}
        </UI.InlineNotice>
      )}
    </UI.Stack>
  );
}
