import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { type Person, type StageId, STAGES, type StageWait } from "./model.ts";

export type StageStripProps = Readonly<{
  current: StageId;
  wait: (stage: StageId) => StageWait;
  /** Phone chips with a summary line instead of the stage cards. */
  compact?: boolean;
  people?: readonly Person[];
  planningOnly: boolean;
  planningOnlyDisabled: boolean;
  planningOnlyFailed: boolean;
  onPlanningOnly: (value: boolean) => void;
}>;

/**
 * The fixed build workflow stages with the policy each waits on, and the
 * planning-only switch. Only server state is shown; the strip owns no
 * workflow state of its own.
 */
export function StageStrip(
  {
    compact = false,
    people = [],
    current,
    wait,
    planningOnly,
    planningOnlyDisabled,
    planningOnlyFailed,
    onPlanningOnly,
  }: StageStripProps,
) {
  const { translate: t } = useI18n();
  return (
    <UI.Stack gap="compact" data-ui-region="stage-strip">
      <UI.WorkflowStageStrip
        variant={compact ? "compact" : "cards"}
        summary={compact
          ? (
            <>
              <UI.Text variant="captionInk">
                {`${t(`tasks.conversation.stage.${current}`)} · ${
                  wait(current) === "human_approval"
                    ? t("tasks.conversation.stage.waitsApproval")
                    : t("tasks.conversation.stage.automatic")
                }`}
              </UI.Text>
              <UI.Text variant="caption">
                {t("tasks.conversation.participants.heading", {
                  count: String(people.length),
                })}
              </UI.Text>
              <UI.Inline gap="compact">
                {people.map((person) => (
                  <UI.Avatar
                    key={person.id}
                    alt={person.name}
                    size="small"
                    data-you={person.you ? "true" : undefined}
                  />
                ))}
              </UI.Inline>
            </>
          )
          : undefined}
        label={t("tasks.conversation.stage.label")}
        stages={STAGES.map((stage, index) => {
          const name = t(`tasks.conversation.stage.${stage}`);
          const number = String(index + 1);
          return {
            id: stage,
            title: compact
              ? name
              : stage === current
              ? t("tasks.conversation.stage.titleCurrent", { number, name })
              : t("tasks.conversation.stage.title", { number, name }),
            detail: wait(stage) === "human_approval"
              ? t("tasks.conversation.stage.waitsApproval")
              : t("tasks.conversation.stage.automatic"),
            current: stage === current,
          };
        })}
        trailing={compact ? undefined : (
          <UI.Switch
            aria-describedby="stage-planning-only-hint"
            checked={planningOnly}
            disabled={planningOnlyDisabled}
            onChange={(event) => onPlanningOnly(event.currentTarget.checked)}
          >
            {t("tasks.conversation.stage.planningOnly")}
          </UI.Switch>
        )}
      />
      <UI.Text id="stage-planning-only-hint" variant="hint" hidden>
        {t("tasks.conversation.stage.planningOnlyHint")}
      </UI.Text>
      {planningOnlyFailed && (
        <UI.InlineNotice tone="warning">
          {t("tasks.conversation.stage.planningOnlyFailed")}
        </UI.InlineNotice>
      )}
    </UI.Stack>
  );
}
