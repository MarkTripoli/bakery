import type { ReactNode } from "react";
import { Heading } from "../atoms/Heading.tsx";
import "../navigation.css";

export type PageHeaderProps = {
  /** The page's single `h1`. */
  title: ReactNode;
  /** Count or scope beside the title, e.g. "8 open tasks". */
  meta?: ReactNode;
  /** Route or view `Tabs` under the title row. */
  tabs?: ReactNode;
  actions?: ReactNode;
  /**
   * `titled` shows the title row (desktop, pane). `tabsOnly` keeps the `h1`
   * for assistive technology and focus but hides it visually, because the
   * phone `TopBar` already shows the same large title (Paper E8-0). `list`
   * is the p-18-0 list-page head: title and muted line, with `actions`
   * stacked beneath on phones.
   */
  variant?: "titled" | "tabsOnly" | "split" | "list";
  /** `split` and `list`: one muted line under the title. */
  subtitle?: ReactNode;
  /** `split` only: right-aligned summary, such as a status and counts. */
  summary?: ReactNode;
};

/** Title, count and tabs block that opens every product page (Paper 5J-0). */
export function PageHeader(
  { actions, meta, subtitle, summary, tabs, title, variant = "titled" }:
    PageHeaderProps,
) {
  if (variant === "split" || variant === "list") {
    return (
      <div
        className={`bakery-page-header bakery-page-header--${variant}`}
        data-state="default"
        data-ui-component="pageHeader"
        data-variant={variant}
      >
        <div className="bakery-page-header__lead">
          <Heading level="page">{title}</Heading>
          {subtitle
            ? variant === "list"
              ? <div className="bakery-page-header__subtitle">{subtitle}</div>
              : <p className="bakery-page-header__subtitle">{subtitle}</p>
            : null}
        </div>
        {summary
          ? <div className="bakery-page-header__summary">{summary}</div>
          : null}
        {variant === "list" && actions
          ? <div className="bakery-page-header__actions">{actions}</div>
          : null}
      </div>
    );
  }
  return (
    <div
      className={`bakery-page-header bakery-page-header--${variant}`}
      data-state="default"
      data-ui-component="pageHeader"
      data-variant={variant}
    >
      <div className="bakery-page-header__row">
        <Heading level="page">{title}</Heading>
        {meta ? <p className="bakery-page-header__meta">{meta}</p> : null}
        {actions
          ? <div className="bakery-page-header__actions">{actions}</div>
          : null}
      </div>
      {tabs ? <div className="bakery-page-header__tabs">{tabs}</div> : null}
    </div>
  );
}
