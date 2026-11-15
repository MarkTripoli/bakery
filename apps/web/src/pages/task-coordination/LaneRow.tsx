import * as UI from "@bakery/ui";
import { RouterLink } from "../../app/router-link.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  type CommitCandidate,
  committed,
  type HandoffState,
  type LaneStatus,
  type PlanLane,
} from "./model.ts";

const TONES: Record<LaneStatus, UI.StatusDotTone> = {
  planned: "neutral",
  ready: "information",
  waiting: "warning",
  running: "information",
  completed: "success",
  stale: "warning",
  failed: "destructive",
  stopped: "neutral",
  canceled: "neutral",
};

/**
 * The link to a lane's child task: the task's title, "Open {title}" to
 * assistive technology; "Open task" while the title is not loaded. No id.
 */
function ChildTaskLink(
  { childTaskId, title }: Readonly<{
    childTaskId: string;
    title: string | undefined;
  }>,
) {
  const { translate: t } = useI18n();
  return (
    <RouterLink
      to="/tasks/$taskId"
      params={{ taskId: childTaskId }}
      aria-label={title
        ? t("tasks.coordination.lane.openTitled", { title })
        : t("tasks.coordination.lane.openTask")}
    >
      {title ?? t("tasks.coordination.lane.openTask")}
    </RouterLink>
  );
}

export type LaneColumnsOptions = Readonly<{
  /** Lane titles by key, to name prerequisites. */
  titles: ReadonlyMap<string, string>;
  /** Artifacts of a lane's child task; undefined while unread. */
  artifacts: (lane: PlanLane) => readonly CommitCandidate[] | undefined;
  /** The child task's title, the link text; undefined while it is not loaded. */
  childTitle: (childTaskId: string) => string | undefined;
  /** Whether the upstream output an input names is committed yet. */
  handoff: (input: PlanLane["inputs"][number]) => HandoffState;
}>;

/**
 * Typed handoffs a lane receives: which lane and output each input comes from,
 * and whether that output is committed or still awaited. The state is text,
 * never colour alone.
 */
function Handoffs(
  { lane, name, handoff }: {
    lane: PlanLane;
    name: (key: string) => string;
    handoff: LaneColumnsOptions["handoff"];
  },
) {
  const { translate: t } = useI18n();
  if (lane.inputs.length === 0) return null;
  return (
    <UI.Stack
      gap="tight"
      role="list"
      aria-label={t("tasks.coordination.lane.inputs")}
      data-ui-region="lane-handoffs"
    >
      {lane.inputs.map((input) => {
        const state = handoff(input);
        return (
          <UI.Inline
            gap="compact"
            key={`${input.fromLane}/${input.outputKey}`}
            role="listitem"
            data-handoff-state={state}
          >
            <UI.Text variant="caption">
              {t("tasks.coordination.lane.handoff", {
                lane: name(input.fromLane),
                outputKey: input.outputKey,
              })}
            </UI.Text>
            <UI.Text variant={state === "committed" ? "positive" : "caption"}>
              {state === "committed"
                ? t("tasks.coordination.lane.handoffCommitted")
                : t("tasks.coordination.lane.handoffWaiting")}
            </UI.Text>
          </UI.Inline>
        );
      })}
    </UI.Stack>
  );
}

/**
 * Columns of the coordination lane table: where each lane works, how far it
 * got, what it waits for, and which declared outputs are committed handoffs.
 * Status comes from the server projection; nothing is derived here.
 */
export function useLaneColumns(
  { titles, artifacts, childTitle, handoff }: LaneColumnsOptions,
): UI.DataTableColumn<PlanLane>[] {
  const { translate: t } = useI18n();
  const name = (key: string) => titles.get(key) ?? key;
  return [
    {
      id: "lane",
      header: t("tasks.coordination.lanes"),
      width: "260px",
      cell: (lane) => (
        <UI.Stack gap="tight">
          <UI.Text variant="strong">
            {lane.repository ?? t("tasks.coordination.lane.repositoryUnknown")}
          </UI.Text>
          {lane.alias && (
            <UI.DataText variant="timestamp">
              {t("tasks.coordination.lane.alias", { alias: lane.alias })}
            </UI.DataText>
          )}
          {lane.title !== lane.key && lane.title !== lane.alias && (
            <UI.Text variant="caption">{lane.title}</UI.Text>
          )}
        </UI.Stack>
      ),
    },
    {
      id: "status",
      header: t("tasks.coordination.status.column"),
      width: "128px",
      cell: (lane) => (
        <UI.StatusDot size="small" tone={TONES[lane.status]}>
          {t(`tasks.coordination.lane.status.${lane.status}`)}
        </UI.StatusDot>
      ),
    },
    {
      id: "prerequisites",
      header: t("tasks.coordination.prerequisites.column"),
      cell: (lane) => (
        <UI.Stack gap="tight">
          <UI.Text
            variant={lane.prerequisites.length === 0 ? "hint" : "hintInk"}
          >
            {lane.prerequisites.length === 0
              ? t("tasks.coordination.lane.noPrerequisites")
              : t("tasks.coordination.lane.prerequisites", {
                lanes: lane.prerequisites.map(name).join(", "),
              })}
          </UI.Text>
          {lane.status === "waiting" && (
            <UI.Text variant="caption">
              {t("tasks.coordination.lane.waitingHint")}
            </UI.Text>
          )}
          {lane.status === "stopped" && (
            <UI.Text variant="caption">
              {t("tasks.coordination.lane.stoppedHint")}
            </UI.Text>
          )}
          {lane.status === "stale" && (
            <UI.Text variant="caption">
              {t("tasks.coordination.lane.staleHint")}
            </UI.Text>
          )}
          <Handoffs lane={lane} name={name} handoff={handoff} />
        </UI.Stack>
      ),
    },
    {
      id: "outputs",
      header: t("tasks.coordination.lane.outputs"),
      width: "252px",
      cell: (lane) => (
        <UI.Stack
          gap="tight"
          role="list"
          aria-label={t("tasks.coordination.lane.outputs")}
        >
          {lane.outputs.map((output) => {
            const done = committed(output, artifacts(lane));
            return (
              <UI.Inline gap="compact" key={output.key} role="listitem">
                <UI.DataText variant="code">{output.key}</UI.DataText>
                <UI.Text variant={done ? "positive" : "caption"}>
                  {done
                    ? t("tasks.coordination.lane.committed")
                    : t("tasks.coordination.lane.declared")}
                </UI.Text>
              </UI.Inline>
            );
          })}
        </UI.Stack>
      ),
    },
    {
      id: "child",
      header: t("tasks.coordination.child.column"),
      width: "140px",
      align: "end",
      cell: (lane) =>
        lane.childTaskId
          ? (
            <ChildTaskLink
              childTaskId={lane.childTaskId}
              title={childTitle(lane.childTaskId)}
            />
          )
          : (
            <UI.Text variant="hint">
              {t("tasks.coordination.lane.noTask")}
            </UI.Text>
          ),
    },
  ];
}

/** Phone form of the lane table: one stacked row per lane (frame 2JQJ-0). */
export function LaneCards(
  { lanes, titles, artifacts, childTitle, handoff }: LaneColumnsOptions & {
    lanes: readonly PlanLane[];
  },
) {
  const { translate: t } = useI18n();
  const name = (key: string) => titles.get(key) ?? key;
  return (
    <UI.Stack
      gap="none"
      role="list"
      aria-label={t("tasks.coordination.lanes")}
    >
      {lanes.map((lane) => {
        const done = lane.outputs.filter((output) =>
          committed(output, artifacts(lane))
        );
        return (
          <div
            key={lane.key}
            role="listitem"
            data-lane-key={lane.key}
            data-lane-status={lane.status}
          >
            <UI.StackedRow
              title={lane.repository ??
                t("tasks.coordination.lane.repositoryUnknown")}
              status={
                <UI.StatusDot size="small" tone={TONES[lane.status]}>
                  {t(`tasks.coordination.lane.status.${lane.status}`)}
                </UI.StatusDot>
              }
            >
              {done.length > 0 && (
                <UI.DataText variant="timestamp">
                  {[
                    lane.alias
                      ? t("tasks.coordination.lane.alias", {
                        alias: lane.alias,
                      })
                      : null,
                    ...done.map((output) =>
                      `${output.key} ${
                        t("tasks.coordination.lane.committed").toLowerCase()
                      }`
                    ),
                  ].filter((part) => part !== null).join(" · ")}
                </UI.DataText>
              )}
              {lane.title !== lane.key && lane.title !== lane.alias && (
                <UI.Text variant="caption">{lane.title}</UI.Text>
              )}
              {(lane.prerequisites.length > 0 || done.length === 0) && (
                <UI.Text
                  variant={lane.prerequisites.length === 0 ? "hint" : "hintInk"}
                >
                  {lane.prerequisites.length === 0
                    ? t("tasks.coordination.lane.noPrerequisites")
                    : t("tasks.coordination.lane.prerequisites", {
                      lanes: lane.prerequisites.map(name).join(", "),
                    })}
                </UI.Text>
              )}
              {lane.status === "waiting" && (
                <UI.Text variant="caption">
                  {t("tasks.coordination.lane.waitingHint")}
                </UI.Text>
              )}
              {lane.status === "stopped" && (
                <UI.Text variant="caption">
                  {t("tasks.coordination.lane.stoppedHint")}
                </UI.Text>
              )}
              {lane.status === "stale" && (
                <UI.Text variant="caption">
                  {t("tasks.coordination.lane.staleHint")}
                </UI.Text>
              )}
              <Handoffs lane={lane} name={name} handoff={handoff} />
              {lane.childTaskId && (
                <ChildTaskLink
                  childTaskId={lane.childTaskId}
                  title={childTitle(lane.childTaskId)}
                />
              )}
            </UI.StackedRow>
          </div>
        );
      })}
    </UI.Stack>
  );
}
