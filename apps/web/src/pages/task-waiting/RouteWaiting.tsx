import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { formatDate } from "@bakery/i18n";
import { stepTitle } from "../task-timeline.ts";
import { cardCopy, type Offer, whenText } from "./model.ts";

/**
 * The cards for the steps of a run that wait on a model (#70, slice 2). Bakery
 * never switches by itself, and this slice ships no way to choose another, so
 * a card only says what waits, why, and when Bakery tries again. When the
 * incident closes the offer goes and the card goes with it, without a notice.
 */
export function RouteWaiting(
  { offers }: {
    /** The offers old enough to show, oldest first. */
    readonly offers: readonly Offer[];
  },
) {
  const { translate: t, locale, timeZone } = useI18n();
  const when = (iso: string) =>
    whenText(
      iso,
      Date.now(),
      (value, options) => formatDate(value, locale, { timeZone, ...options }),
    );

  return (
    <UI.Stack gap="standard" data-testid="route-waiting">
      {offers.map((offer) => {
        const copy = cardCopy(
          offer,
          t,
          when,
          (key) => stepTitle(t, key),
        );
        return (
          <UI.AlertBanner
            data-testid="route-waiting-card"
            data-step-key={offer.stepKey}
            key={offer.runStepId}
            tone="warning"
          >
            <UI.Stack gap="tight">
              <UI.Heading level="subsection">{copy.title}</UI.Heading>
              <UI.Text>{copy.text}</UI.Text>
              <UI.Text variant="muted">{copy.second}</UI.Text>
            </UI.Stack>
          </UI.AlertBanner>
        );
      })}
    </UI.Stack>
  );
}
