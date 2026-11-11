import type { ReactNode } from "react";
import { Button } from "../atoms/Button.tsx";
import "../run-view.css";
import {
  RunArtifactSummary,
  type RunArtifactSummaryProps,
} from "../organisms/RunArtifactSummary.tsx";

export type RunOutputPageProps = {
  variant?: "default";
  brand: string;
  workspace: string;
  navigationLabel: string;
  navigation: { label: string; selected?: boolean }[];
  footer: string;
  menuLabel: string;
  onMenu?: () => void;
  breadcrumbs: string[];
  reference: string;
  status: string;
  title: string;
  description: string;
  notice?: { title: string; description: string; action?: ReactNode };
  identity: ReactNode;
  output: ReactNode;
  revision: ReactNode;
  artifacts?: ReactNode;
  artifactSummary?: RunArtifactSummaryProps;
};

export type RunOutputViewProps = RunOutputPageProps | {
  variant: "section";
  state?: "ready" | "notice";
  title: string;
  children: ReactNode;
};

export function RunOutputView(props: RunOutputViewProps) {
  if (props.variant === "section") {
    return (
      <section
        aria-label={props.title}
        className="ui-run-content"
        data-ui-component="runOutputView"
        data-variant="section"
        data-state={props.state ?? "ready"}
      >
        {props.children}
      </section>
    );
  }
  return <RunOutputPage {...props} />;
}

function RunOutputPage({
  brand,
  workspace,
  navigationLabel,
  navigation,
  footer,
  menuLabel,
  onMenu,
  breadcrumbs,
  reference,
  status,
  title,
  description,
  notice,
  identity,
  output,
  revision,
  artifacts,
  artifactSummary,
}: RunOutputPageProps) {
  return (
    <div
      className="ui-run-view"
      data-ui-component="runOutputView"
      data-variant="default"
      data-state={notice ? "notice" : "ready"}
    >
      <aside className="ui-run-view__rail" aria-label={navigationLabel}>
        <strong className="ui-run-view__brand">{brand}</strong>
        <span className="ui-run-view__workspace">{workspace}</span>
        {navigation.map((item) => (
          <div
            className="ui-run-view__nav"
            data-selected={item.selected}
            key={item.label}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            {item.label}
          </div>
        ))}
        <span className="ui-run-view__footer">{footer}</span>
      </aside>
      <div className="ui-run-view__phone">
        <Button variant="outline" onClick={onMenu}>{menuLabel}</Button>
        <strong>{brand}</strong>
        <span className="ui-run-card__meta">{workspace}</span>
      </div>
      <div className="ui-run-view__body">
        <header className="ui-run-view__breadcrumb">
          {breadcrumbs.map((item) => <span key={item}>{item}</span>)}
        </header>
        <main className="ui-run-view__main">
          <header className="ui-run-view__heading">
            <div className="ui-run-card__row">
              <span className="ui-run-view__reference">{reference}</span>
              <span className="ui-run-card__badge">{status}</span>
            </div>
            <h1>{title}</h1>
            <span className="ui-run-view__description">{description}</span>
          </header>
          {notice
            ? (
              <section className="ui-run-card" role="status">
                <h2>{notice.title}</h2>
                <span className="ui-run-view__description">
                  {notice.description}
                </span>
                {notice.action
                  ? <div className="ui-run-card__actions">{notice.action}</div>
                  : null}
              </section>
            )
            : null}
          {identity}
          {output}
          {revision}
          {artifacts}
          {artifactSummary ? <RunArtifactSummary {...artifactSummary} /> : null}
        </main>
      </div>
    </div>
  );
}
