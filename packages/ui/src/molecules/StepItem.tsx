import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { VisuallyHidden } from "../atoms/VisuallyHidden.tsx";
import "../steps.css";

/**
 * `done` passed, `failed` did not, `running` is in progress, `waiting` needs a
 * person, `upcoming` has not started and `unknown` was not reported: it is never
 * drawn as passed or failed.
 */
export type StepItemStatus =
  | "done"
  | "failed"
  | "running"
  | "waiting"
  | "upcoming"
  | "unknown";

export type StepItemProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLLIElement>, "title">>
  & {
    status: StepItemStatus;
    /**
     * The status in words ("Passed", "Failed", "Waiting for you", "Not
     * started"), translated by the caller. Screen readers read it first; the
     * mark itself is hidden from them, so a status is never colour alone.
     */
    statusLabel: string;
    /** The step's name, with at most one `HelpTip` after it. */
    title: ReactNode;
    /** One line of result under the name. */
    summary?: ReactNode;
    /** At most one text action at the end of the step, such as "View changes". */
    action?: ReactNode;
    /** The open detail of a step that failed, is running or waits. */
    children?: ReactNode;
  };

const MARKS = {
  failed: "×",
  running: "…",
  waiting: "!",
  upcoming: "",
  unknown: "?",
} as const;

/** One gate of a `StepList`: a status, a name, a result and an open detail. */
export function StepItem(
  { action, children, status, statusLabel, summary, title, ...props }:
    StepItemProps,
) {
  return (
    <li
      className="ui-step-item"
      {...props}
      data-state={status}
      data-ui-component="stepItem"
      data-variant="default"
    >
      <span className="ui-step-item__mark">
        <span aria-hidden="true">
          {status === "done"
            ? <IconGlyph name="check" size="small" />
            : MARKS[status]}
        </span>
        <VisuallyHidden>{statusLabel}</VisuallyHidden>
      </span>
      <div className="ui-step-item__body">
        <div className="ui-step-item__title">{title}</div>
        {summary
          ? <div className="ui-step-item__summary">{summary}</div>
          : null}
        {children
          ? <div className="ui-step-item__detail">{children}</div>
          : null}
      </div>
      {action ? <div className="ui-step-item__action">{action}</div> : null}
    </li>
  );
}
