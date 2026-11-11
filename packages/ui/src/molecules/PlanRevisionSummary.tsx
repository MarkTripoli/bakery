import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type PlanRevisionStep = {
  id: string;
  title: string;
  /** Supporting line; a step without one renders as a single plain line. */
  detail?: string;
};

export type PlanRevisionSummaryProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    /** Accessible name of the step list. */
    stepsLabel: string;
    steps: readonly PlanRevisionStep[];
    /** Translated revision label, for example "Revision 2". */
    revision: string;
    /** Translated lifecycle label and its tone. */
    status: {
      label: string;
      tone: "warning" | "neutral" | "success" | "destructive";
    };
    title: ReactNode;
    /** `muted` quiets an obsolete revision's steps. */
    state?: "current" | "muted";
  };

/**
 * One plan revision: title, revision and status line, and its numbered
 * steps. Decisions and notices are composed around it by the page.
 */
export function PlanRevisionSummary(
  { revision, state = "current", status, steps, stepsLabel, title, ...props }:
    PlanRevisionSummaryProps,
) {
  return (
    <section
      className="ui-plan-revision"
      {...props}
      data-state={state}
      data-ui-component="planRevisionSummary"
      data-variant="default"
    >
      <header className="ui-plan-revision__header">
        <h3>{title}</h3>
        <div className="ui-plan-revision__meta">
          <span>{revision}</span>
          <span
            className={`ui-plan-revision__status ui-plan-revision__status--${status.tone}`}
          >
            <span aria-hidden="true" className="ui-plan-revision__dot" />
            {status.label}
          </span>
        </div>
      </header>
      <ol aria-label={stepsLabel} className="ui-plan-revision__steps">
        {steps.map((step, index) => (
          <li
            className="ui-plan-revision__step"
            data-detailed={step.detail ? "true" : undefined}
            key={step.id}
          >
            <span className="ui-plan-revision__step-title">
              {`${index + 1}. ${step.title}`}
            </span>
            {step.detail
              ? (
                <span className="ui-plan-revision__step-detail">
                  {step.detail}
                </span>
              )
              : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
