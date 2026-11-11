import * as UI from "@bakery/ui";
import type { ConversationTurnResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

export type TurnStatusProps = Readonly<{
  turn: ConversationTurnResponse;
  /** Whether a cancel request is in flight. */
  canceling: boolean;
  cancelConflict: boolean;
  offline: boolean;
  onCancel: () => void;
}>;

/** Queued or active agent turn with a cancel control bound to its version. */
export function TurnStatus(
  { turn, canceling, cancelConflict, offline, onCancel }: TurnStatusProps,
) {
  const { translate: t } = useI18n();
  const cancelable = turn.status === "queued" || turn.status === "active";
  const text = turn.status === "queued"
    ? t("tasks.conversation.turn.queued")
    : turn.status === "active"
    ? t("tasks.conversation.turn.active")
    : t("tasks.conversation.turn.cancelRequested");
  return (
    <UI.Stack
      gap="compact"
      data-ui-region="turn-status"
      data-turn={turn.status}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={t("tasks.conversation.turn.status")}
      >
        <UI.InlineNotice
          layout="bar"
          icon="clock"
          role="none"
          tone="neutral"
          action={cancelable
            ? (
              <UI.Button
                variant="quiet"
                disabled={canceling || offline}
                loading={canceling}
                onClick={onCancel}
              >
                {t("tasks.conversation.turn.cancel")}
              </UI.Button>
            )
            : undefined}
        >
          {text}
        </UI.InlineNotice>
      </div>
      {cancelConflict && (
        <UI.InlineNotice layout="bar" tone="warning">
          {t("tasks.conversation.turn.cancelFailed")}
        </UI.InlineNotice>
      )}
    </UI.Stack>
  );
}
