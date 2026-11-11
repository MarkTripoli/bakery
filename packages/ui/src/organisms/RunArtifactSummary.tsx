import { type ReactNode, useId } from "react";
import "../run.css";

export type RunArtifactSummaryProps = {
  title: string;
  name: string;
  revision: string;
  size: string;
  detail: string;
  actions: ReactNode;
  state?: "ready" | "unknown";
};

export function RunArtifactSummary(
  { title, name, revision, size, detail, actions, state = "ready" }:
    RunArtifactSummaryProps,
) {
  const titleId = useId();
  const nameId = useId();
  return (
    <section
      className="ui-run-card"
      aria-labelledby={`${titleId} ${nameId}`}
      data-ui-component="runArtifactSummary"
      data-variant="default"
      data-state={state}
    >
      <h2 id={titleId}>{title}</h2>
      <div className="ui-run-card__row ui-run-artifact__summary">
        <h2 id={nameId}>{name}</h2>
        <span className="ui-run-card__badge">{revision}</span>
        <span className="ui-run-card__meta">{size}</span>
      </div>
      <span className="ui-run-card__meta">{detail}</span>
      <div className="ui-run-card__actions">{actions}</div>
    </section>
  );
}
