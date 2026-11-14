import type { ReactNode } from "react";
import "../run.css";

export type RunIdentityProps = {
  title: string;
  notice?: { title: string; description: string; action?: ReactNode };
  worker: string | null;
  attempt: string | null;
  lease: string | null;
  /** `warning` when the machine stopped answering or the task was taken back. */
  leaseTone?: "warning";
  detail: ReactNode;
  unknownLabel: string;
};

export function RunIdentity(
  { title, notice, worker, attempt, lease, leaseTone, detail, unknownLabel }:
    RunIdentityProps,
) {
  return (
    <>
      {notice && (
        <section className="ui-run-card" role="status">
          <h2>{notice.title}</h2>
          <p className="ui-run-card__description">{notice.description}</p>
          {notice.action && (
            <div className="ui-run-card__actions">{notice.action}</div>
          )}
        </section>
      )}
      <section
        aria-label={title}
        className="ui-run-card"
        data-ui-component="runIdentity"
        data-variant="default"
        data-state={worker && attempt && lease ? "known" : "unknown"}
      >
        <h2>{title}</h2>
        <div className="ui-run-card__row">
          <span className="ui-run-card__badge">{worker ?? unknownLabel}</span>
          <span className="ui-run-card__badge">{attempt ?? unknownLabel}</span>
          <span className="ui-run-card__badge" data-tone={leaseTone}>
            {lease ?? unknownLabel}
          </span>
        </div>
        <p className="ui-run-card__meta">{detail}</p>
      </section>
    </>
  );
}
