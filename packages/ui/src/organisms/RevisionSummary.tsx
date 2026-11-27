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
  /** Said instead of the badges when no commit and no change count is known. */
  noneRecorded?: string;
  diffLink?: { href: string; label: string };
  action?: ReactNode;
  children?: ReactNode;
  variant?: "default" | "row";
};

export function RevisionSummary(
  {
    title,
    baseRevision,
    candidateRevision,
    summary,
    disclaimer,
    unknownLabel,
    noneRecorded,
    diffLink,
    action,
    children,
    variant = "default",
  }: RevisionSummaryProps,
) {
  if (variant === "row") {
    return (
      <section
        aria-label={title}
        className="ui-run-card ui-run-card--row"
        data-ui-component="revisionSummary"
        data-variant="row"
        data-state={candidateRevision ? "candidate" : "unknown"}
      >
        <div className="ui-run-card__row">
          <h2>{title}</h2>
          {summary
            ? <span className="ui-run-card__meta">{summary}</span>
            : null}
          <div className="ui-run-card__actions">{action}</div>
        </div>
        {children}
      </section>
    );
  }
  // With no commit and no change count known there is nothing to show but that.
  const nothingKnown = noneRecorded !== undefined && !baseRevision &&
    !candidateRevision && !summary;
  return (
    <section
      aria-label={title}
      className="ui-run-card"
      data-ui-component="revisionSummary"
      data-variant="default"
      data-state={candidateRevision ? "candidate" : "unknown"}
    >
      <h2>{title}</h2>
      {nothingKnown
        ? <p className="ui-run-card__meta">{noneRecorded}</p>
        : (
          <div className="ui-run-card__row">
            {baseRevision || candidateRevision
              ? (
                <span className="ui-run-card__badge">
                  <bdi>{baseRevision ?? unknownLabel}</bdi>
                  {" → "}
                  <bdi>{candidateRevision ?? unknownLabel}</bdi>
                </span>
              )
              : null}
            {summary
              ? <span className="ui-run-card__badge">{summary}</span>
              : null}
          </div>
        )}
      {nothingKnown ? null : <p className="ui-run-card__meta">{disclaimer}</p>}
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
