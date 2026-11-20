import * as UI from "@bakery/ui";
import type { Translator } from "@bakery/i18n";
import {
  choiceDetail,
  choiceLabel,
  continueLabel,
  costLine,
  eligibleTargets,
  healthBadge,
  type Offer,
  paymentNotice,
  type Target,
  unavailableChoices,
} from "./model.ts";

/**
 * The dialog where a person picks another way to run a waiting step (#70,
 * slice 2). Nothing is chosen when it opens and "Continue" waits for a choice;
 * "Keep waiting" closes it and changes nothing.
 */
export function ChooseDialog(
  { offer, chosen, onChoose, working, problem, onKeep, onContinue, t, money }: {
    readonly offer: Offer;
    /** The chosen route's id, or null when nothing is chosen yet. */
    readonly chosen: string | null;
    readonly onChoose: (routeId: string) => void;
    readonly working: boolean;
    /** The sentence for a refused choice, or null. */
    readonly problem: string | null;
    readonly onKeep: () => void;
    readonly onContinue: () => void;
    readonly t: Translator;
    readonly money: (value: number) => string;
  },
) {
  const choices = eligibleTargets(offer);
  const picked: Target | null =
    choices.find((target) => target.routeId === chosen) ?? null;
  const notice = picked === null
    ? null
    : paymentNotice(t, offer.source, picked);
  const unavailable = unavailableChoices(t, offer);
  const title = t("tasks.waiting.dialog.title", { step: offer.stepKey });
  const group = `route-waiting-${offer.runStepId}`;
  return (
    <UI.Dialog
      open
      onOpenChange={(open) => {
        if (!open && !working) onKeep();
      }}
      state={working ? "submitting" : problem === null ? "open" : "error"}
      title={title}
      variant="form"
      data-testid="route-waiting-dialog"
    >
      <UI.Stack gap="standard">
        <UI.Stack gap="tight" role="radiogroup" aria-label={title}>
          {choices.map((target) => {
            const badge = healthBadge(t, target);
            const detailId = `${group}-${target.routeId}`;
            return (
              <UI.Stack gap="none" key={target.routeId}>
                <UI.Radio
                  aria-describedby={detailId}
                  checked={picked?.routeId === target.routeId}
                  disabled={working}
                  name={group}
                  onChange={() => onChoose(target.routeId)}
                  value={target.routeId}
                >
                  {choiceLabel(t, target)}
                  {badge === null ? null : (
                    <>
                      {" "}
                      <UI.Badge tone={badge.tone}>{badge.text}</UI.Badge>
                    </>
                  )}
                </UI.Radio>
                <UI.Text id={detailId} variant="hint">
                  {choiceDetail(t, target)}
                </UI.Text>
              </UI.Stack>
            );
          })}
        </UI.Stack>
        {notice === null ? null : (
          <UI.InlineNotice
            tone="information"
            data-testid="route-waiting-payment"
          >
            {notice}
          </UI.InlineNotice>
        )}
        {unavailable === null
          ? null
          : (
            <UI.Disclosure summary={unavailable.summary}>
              <UI.Stack gap="tight" role="list">
                {unavailable.lines.map((line) => (
                  <UI.Text key={line} role="listitem" variant="muted">
                    {line}
                  </UI.Text>
                ))}
              </UI.Stack>
            </UI.Disclosure>
          )}
        <UI.Text variant="hint">{costLine(t, offer, money)}</UI.Text>
        {problem === null
          ? null
          : (
            <UI.InlineNotice tone="error" data-testid="route-waiting-problem">
              {problem}
            </UI.InlineNotice>
          )}
        <UI.Inline gap="compact">
          <UI.Button variant="secondary" disabled={working} onClick={onKeep}>
            {t("tasks.waiting.dialog.keep")}
          </UI.Button>
          <UI.Button
            variant="primary"
            disabled={picked === null || working}
            loading={working}
            onClick={onContinue}
          >
            {picked === null
              ? t("tasks.waiting.dialog.continueNone")
              : continueLabel(t, picked)}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    </UI.Dialog>
  );
}
