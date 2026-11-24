import { useQueries } from "@tanstack/react-query";
import type * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import { useBakeryApi } from "../../api/context.tsx";
import { handoffManifestQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { stepTitle } from "../task-timeline.ts";
import { reasonKey, recordedHandover } from "./model.ts";
import type { HandOverStep } from "./HandOver.tsx";

export function useHandoverEvents(
  steps: readonly HandOverStep[],
  enabled: boolean,
): UI.RunTimelineEvent[] {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t, locale, timeZone } = useI18n();
  const continued = steps.filter((step) =>
    step.handoffManifest?.status === "continued"
  );
  const reads = useQueries({
    queries: continued.map((step) => ({
      ...handoffManifestQueryOptions(api, scope, step.handoffManifest!.id),
      enabled: enabled && scope.organizationId !== null,
    })),
  });
  const events: UI.RunTimelineEvent[] = [];
  reads.forEach((read, index) => {
    if (!read.data) return;
    const recorded = recordedHandover(read.data);
    if (recorded === null) return;
    const name = recorded.byName ?? t("tasks.run.handover.someone");
    const description = recorded.outcome === "exact"
      ? t("tasks.run.handover.done.exact", { name })
      : recorded.outcome === "freshChosen"
      ? t("tasks.run.handover.done.freshChosen", { name })
      : recorded.outcome === "fresh"
      ? t("tasks.run.handover.done.fresh", {
        name,
        reason: t(reasonKey(recorded.reason) as never, {
          count: recorded.unconfirmedEffects,
        }),
      })
      : t("tasks.run.handover.done.waiting", {
        count: recorded.unconfirmedEffects,
      });
    events.push({
      id: `handover:${read.data.id}`,
      scope: "control",
      time: recorded.at,
      timeLabel: formatDate(new Date(recorded.at), locale, {
        timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      }),
      title: stepTitle(t, continued[index]!.stepKey),
      description,
    });
  });
  return events.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
}
