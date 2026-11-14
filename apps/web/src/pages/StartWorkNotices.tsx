import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { StartRefusal } from "./StartWorkDialog.tsx";

/**
 * What the person is told after Start work: that work is starting, or why it
 * did not start (not ready, changed since opened, GitHub not answering, or
 * failed). Shared by the list and the issue page.
 */
export function StartWorkNotices(
  { number, onDismiss, refusal, started }: {
    readonly number: number | null;
    /** Reload cleared the refusal. */
    readonly onDismiss: () => void;
    readonly refusal: StartRefusal | null;
    readonly started: boolean;
  },
) {
  const { translate } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  if (started) {
    return (
      <UI.AlertBanner
        tone="success"
        action={
          <UI.Button
            variant="secondary"
            onClick={() => void navigate({ to: "/tasks" })}
          >
            {translate("issues.start.openWork" as never)}
          </UI.Button>
        }
      >
        {translate("issues.start.started" as never, { number: number ?? "" })}
      </UI.AlertBanner>
    );
  }
  if (refusal === null) return null;
  if (refusal === "changed") {
    return (
      <UI.InlineNotice
        tone="warning"
        action={
          <UI.Button
            variant="secondary"
            onClick={() => {
              onDismiss();
              void queryClient.invalidateQueries({ queryKey: ["protected"] });
            }}
          >
            {translate("issues.refused.reload" as never)}
          </UI.Button>
        }
      >
        {translate("issues.refused.changed" as never)}
      </UI.InlineNotice>
    );
  }
  return (
    <UI.InlineNotice tone={refusal === "failed" ? "error" : "warning"}>
      {translate(`issues.refused.${refusal}` as never)}
    </UI.InlineNotice>
  );
}
