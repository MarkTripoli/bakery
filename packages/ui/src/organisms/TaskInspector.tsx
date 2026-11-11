import { type HTMLAttributes, type ReactNode, useId } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type TaskInspectorProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    actions?: ReactNode;
    activity?: ReactNode;
    children?: ReactNode;
    participants?: ReactNode;
    participantsLabel?: string;
    reference?: ReactNode;
    state?: "default" | "loading" | "empty";
    status?: ReactNode;
    title: ReactNode;
  };

/**
 * Selected-task summary for the Work inspector region: identity, people,
 * caller-owned body (such as a pending question), activity and actions.
 */
export function TaskInspector(
  {
    actions,
    activity,
    children,
    participants,
    participantsLabel,
    reference,
    state = "default",
    status,
    title,
    ...props
  }: TaskInspectorProps,
) {
  const headingId = useId();
  return (
    <section
      aria-busy={state === "loading" || undefined}
      aria-labelledby={headingId}
      className="ui-task-inspector"
      {...props}
      data-state={state}
      data-ui-component="taskInspector"
      data-variant="pane"
    >
      <header className="ui-task-inspector__header">
        <h2 id={headingId}>{title}</h2>
        {reference || status
          ? (
            <div className="ui-task-inspector__identity">
              <span className="ui-task-inspector__reference">{reference}</span>
              {status}
            </div>
          )
          : null}
      </header>
      {participants
        ? (
          <div className="ui-task-inspector__participants">
            <span>{participantsLabel}</span>
            {participants}
          </div>
        )
        : null}
      {children}
      {activity}
      {actions
        ? (
          <>
            <div aria-hidden="true" className="ui-task-inspector__spacer" />
            <div className="ui-task-inspector__actions">{actions}</div>
          </>
        )
        : null}
    </section>
  );
}
