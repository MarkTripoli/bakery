import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { Icon } from "../atoms/Icon.tsx";
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

/**
 * Every mark is drawn at the tick's size (a 16px icon in the 20px circle), so a
 * cross, three dots, an exclamation or a question mark is never smaller than
 * the tick. The shared glyph table has only the tick, so the rest are drawn
 * here with `Icon`, as the catalogue says for a glyph outside the table.
 */
const MARKS = {
  failed: <path d="M6 6l12 12M18 6 6 18" />,
  running: (
    <>
      <circle cx="5" cy="12" fill="currentColor" r="1.75" stroke="none" />
      <circle cx="12" cy="12" fill="currentColor" r="1.75" stroke="none" />
      <circle cx="19" cy="12" fill="currentColor" r="1.75" stroke="none" />
    </>
  ),
  waiting: (
    <>
      <path d="M12 5v9" />
      <circle cx="12" cy="18.5" fill="currentColor" r="1.5" stroke="none" />
    </>
  ),
  unknown: (
    <>
      <path d="M8.5 9a3.5 3.5 0 1 1 5 3.2c-1 .5-1.5 1.1-1.5 2.3" />
      <circle cx="12" cy="18.5" fill="currentColor" r="1.5" stroke="none" />
    </>
  ),
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
            : status === "upcoming"
            ? null
            : <Icon size="small">{MARKS[status]}</Icon>}
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
