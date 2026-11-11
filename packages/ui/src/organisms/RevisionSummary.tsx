import type { ReactNode } from "react";
import { Link } from "../atoms/Link.tsx";
import "../run.css";

export type RevisionSummaryProps = {
  title: string;
  baseRevision: string | null;
  candidateRevision: string | null;
  summary: string | null;
  disclaimer: string;
  unknownLabel: string;
  diffLink?: { href: string; label: string };
  action?: ReactNode;
  children?: ReactNode;
};

export function RevisionSummary(
  {
    title,
    baseRevision,
    candidateRevision,
    summary,
    disclaimer,
    unknownLabel,
    diffLink,
    action,
    children,
  }: RevisionSummaryProps,
) {
  return (
    <section
      aria-label={title}
      className="ui-run-card"
      data-ui-component="revisionSummary"
      data-variant="default"
      data-state={candidateRevision ? "candidate" : "unknown"}
    >
      <h2>{title}</h2>
      <div className="ui-run-card__row">
        <span className="ui-run-card__badge">
          <bdi>{baseRevision ?? unknownLabel}</bdi>
          {" → "}
          <bdi>{candidateRevision ?? unknownLabel}</bdi>
        </span>
        <span className="ui-run-card__badge">{summary ?? unknownLabel}</span>
      </div>
      <p className="ui-run-card__meta">{disclaimer}</p>
      {action
        ? <div className="ui-run-card__actions">{action}</div>
        : diffLink
        ? (
          <div className="ui-run-card__actions">
            <Link href={diffLink.href} variant="button">{diffLink.label}</Link>
          </div>
        )
        : null}
      {children}
    </section>
  );
}
