import { type ReactNode, useId } from "react";
import "../artifacts.css";

export type ArtifactLayoutNotice = {
  readonly id: string;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly actions?: ReactNode;
  readonly tone?: "information" | "warning" | "error" | "success";
};

export type ArtifactLayoutProps = {
  readonly title: ReactNode;
  readonly variant?: "detail" | "unavailable";
  readonly description?: ReactNode;
  readonly unavailableLabel?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly breadcrumb?: ReactNode;
  readonly versions?: ReactNode;
  readonly actions?: ReactNode;
  readonly banner?: ReactNode;
  readonly notices?: readonly ArtifactLayoutNotice[];
  readonly children: ReactNode;
  readonly comments?: ReactNode;
  readonly evidence?: ReactNode;
  readonly "data-testid"?: string;
  readonly "data-artifact-retrieval-detail"?: string;
};
export function ArtifactLayout({
  title,
  variant = "detail",
  description,
  unavailableLabel,
  eyebrow,
  breadcrumb,
  versions,
  actions,
  banner,
  notices = [],
  children,
  comments,
  evidence,
  "data-testid": testId,
  "data-artifact-retrieval-detail": retrievalDetail,
}: ArtifactLayoutProps) {
  const titleId = useId();
  return (
    <section
      className={`ui-artifact-layout ui-artifact-layout--${variant}`}
      aria-labelledby={titleId}
      data-testid={testId}
      data-artifact-retrieval-detail={retrievalDetail}
      data-ui-component="artifactLayout"
      data-variant={variant}
      data-state="ready"
    >
      {breadcrumb
        ? <div className="ui-artifact-caption">{breadcrumb}</div>
        : null}
      <header className="ui-artifact-layout__header">
        {eyebrow
          ? <div className="ui-artifact-layout__eyebrow">{eyebrow}</div>
          : null}
        <div className="ui-artifact-layout__identity">
          <h1 id={titleId} tabIndex={-1}>{title}</h1>
          {description
            ? (
              <div className="ui-artifact-layout__description">
                {description}
              </div>
            )
            : null}
        </div>
        {versions || actions
          ? <div className="ui-artifact-actions">{versions}{actions}</div>
          : null}
      </header>
      {notices.map((notice) => (
        <section
          key={notice.id}
          className="ui-artifact-layout__notice"
          data-notice={notice.id}
          role={notice.tone === "error" ? "alert" : "status"}
          data-tone={notice.tone ?? "information"}
        >
          <h2>{notice.title}</h2>
          <div className="ui-artifact-layout__description">
            {notice.description}
          </div>
          {notice.actions
            ? <div className="ui-artifact-actions">{notice.actions}</div>
            : null}
        </section>
      ))}
      {banner}
      <div className="ui-artifact-layout__columns">
        <div className="ui-artifact-layout__content">
          {variant === "unavailable" && unavailableLabel
            ? (
              <section className="ui-artifact-unavailable">
                <h2>{unavailableLabel}</h2>
                {children}
              </section>
            )
            : children}
          {evidence
            ? <section className="ui-artifact-evidence">{evidence}</section>
            : null}
        </div>
        {comments}
      </div>
    </section>
  );
}
