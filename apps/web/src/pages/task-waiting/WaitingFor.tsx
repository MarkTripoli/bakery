import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import { useBakeryApi } from "../../api/context.tsx";
import { runRequestsQueryOptions } from "../../api/query.ts";
import { failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { stepName } from "../task-step-approval/model.ts";
import {
  expiryOutcome,
  fallbackLines,
  type StepProgress,
  type WaitingLine,
  waitingLines,
} from "./waiting-for-model.ts";

export function WaitingFor(
  { runId, steps, runFailed }: Readonly<{
    runId: string;
    steps: readonly StepProgress[];
    runFailed: boolean;
  }>,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  const read = useQuery(runRequestsQueryOptions(api, scope, runId));
  if (read.isError) {
    return failureStatus(read.error) === 403
      ? null
      : (
        <UI.InlineNotice tone="warning">
          <UI.Stack gap="compact">
            <UI.Text>{translate("tasks.waitingFor.loadFailed")}</UI.Text>
            <UI.Inline gap="compact">
              <UI.Button onClick={() => void read.refetch()} variant="outline">
                {translate("tasks.waitingFor.retry")}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        </UI.InlineNotice>
      );
  }
  const requests = read.data?.requests ?? [];
  const lines = waitingLines(requests).filter((line) =>
    !runFailed || line.kind === "expired"
  );
  const fallbacks = runFailed ? [] : fallbackLines(requests);
  if (lines.length === 0 && fallbacks.length === 0) return null;
  const list = new Intl.ListFormat(locale);
  const date = (iso: string) =>
    formatDate(new Date(iso), locale, { timeZone, dateStyle: "medium" });
  const moment = (iso: string) =>
    formatDate(new Date(iso), locale, {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  const words = (line: WaitingLine) => {
    switch (line.kind) {
      case "waiting":
        return translate("tasks.waitingFor.waiting", {
          who: list.format(line.who),
        });
      case "next":
        return line.next === null
          ? translate("tasks.waitingFor.nextUnknown", {
            who: list.format(line.who),
            time: moment(line.dueAt),
          })
          : translate("tasks.waitingFor.next", {
            who: list.format(line.who),
            time: moment(line.dueAt),
            next: line.next,
          });
      case "passedOn":
        return translate("tasks.waitingFor.passedOn", {
          first: list.format(line.first),
          next: list.format(line.next),
          time: moment(line.askedAt),
        });
      case "expired":
        return translate(
          `tasks.waitingFor.${expiryOutcome(steps, line.stepKey)}`,
          { date: date(line.expiresAt) },
        );
    }
  };
  return (
    <UI.Stack data-ui-region="waiting-for" gap="tight">
      {lines.map((line) => (
        <UI.Stack data-step-key={line.stepKey} gap="tight" key={line.stepKey}>
          {lines.length > 1
            ? <UI.Text variant="caption">{stepName(line.stepKey)}</UI.Text>
            : null}
          <UI.Inline gap="compact">
            <UI.Text>{words(line)}</UI.Text>
            {line.kind === "expired" ? null : (
              <UI.Inline gap="compact">
                <UI.Text>
                  {translate("tasks.waitingFor.expires", {
                    date: date(line.expiresAt),
                  })}
                </UI.Text>
                <UI.HelpTip
                  closeLabel={translate("core.actions.close")}
                  label={translate("tasks.waitingFor.expiryHelpLabel")}
                >
                  {translate("tasks.waitingFor.expiryHelp")}
                </UI.HelpTip>
              </UI.Inline>
            )}
          </UI.Inline>
        </UI.Stack>
      ))}
      {fallbacks.map((line) => (
        <UI.Text key={line.name + line.owner} variant="hint">
          {translate("tasks.waitingFor.fallback", line)}
        </UI.Text>
      ))}
    </UI.Stack>
  );
}
