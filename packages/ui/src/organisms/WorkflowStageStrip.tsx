import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type WorkflowStage = {
  /** Stable stage id, exposed as `data-stage`. */
  id: string;
  /** Translated stage title, for example "2 · Plan · Current stage". */
  title: string;
  /** Translated policy line, for example "Waits for your approval". */
  detail: string;
  current?: boolean;
};

export type WorkflowStageStripProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    /** Accessible name of the stage list. */
    label: string;
    stages: readonly WorkflowStage[];
    /** `compact` only: a line under the chips, such as stage and people. */
    summary?: ReactNode;
    /** Trailing control, such as the planning-only switch. */
    trailing?: ReactNode;
    /** `compact` is the phone chip row. */
    variant?: "cards" | "compact";
  };

/**
 * The fixed workflow stages as a row of cards: where the task is now and
 * what each stage waits on. Only server state is shown; the strip owns none.
 */
export function WorkflowStageStrip(
  { label, stages, summary, trailing, variant = "cards", ...props }:
    WorkflowStageStripProps,
) {
  return (
    <div
      className={`ui-stage-strip ui-stage-strip--${variant}`}
      {...props}
      data-state="default"
      data-ui-component="workflowStageStrip"
      data-variant={variant}
    >
      <ol aria-label={label} className="ui-stage-strip__stages">
        {stages.map((stage) => (
          <li
            aria-current={stage.current ? "step" : undefined}
            className="ui-stage-strip__stage"
            data-current={stage.current ? "true" : undefined}
            data-stage={stage.id}
            key={stage.id}
          >
            <span className="ui-stage-strip__title">{stage.title}</span>
            <span className="ui-stage-strip__detail">{stage.detail}</span>
          </li>
        ))}
      </ol>
      {summary
        ? <div className="ui-stage-strip__summary">{summary}</div>
        : null}
      {trailing
        ? <div className="ui-stage-strip__trailing">{trailing}</div>
        : null}
    </div>
  );
}
