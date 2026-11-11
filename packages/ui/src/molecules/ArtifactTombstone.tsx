import type { ReactNode } from "react";
import "../artifacts.css";

export type ArtifactTombstoneProps = {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly metadata?: ReactNode;
  readonly actions?: ReactNode;
  readonly state: "expired" | "deleted";
  readonly variant?: "provenance" | "embedded";
};
export function ArtifactTombstone(
  { title, description, metadata, actions, state, variant = "provenance" }:
    ArtifactTombstoneProps,
) {
  return (
    <section
      className={`ui-artifact-tombstone ui-artifact-tombstone--${variant}`}
      role="status"
      data-ui-component="artifactTombstone"
      data-variant={variant}
      data-state={state}
    >
      <h2>{title}</h2>
      <p>{description}</p>
      {metadata ? <div className="ui-artifact-caption">{metadata}</div> : null}
      {actions ? <div className="ui-artifact-actions">{actions}</div> : null}
    </section>
  );
}
