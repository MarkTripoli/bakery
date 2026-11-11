import type { ReactNode } from "react";
import "../navigation.css";

export type TopBarProps = {
  /** Menu (phone, pane) or back control placed before the title. */
  leading?: ReactNode;
  /** `Breadcrumbs` naming the page within its workspace (`bar` variant). */
  breadcrumbs?: ReactNode;
  /** Large page title for the phone header (`title` variant). */
  title?: ReactNode;
  /** One line under the phone title, e.g. session participants. */
  subtitle?: ReactNode;
  /** Search, theme and the page's primary action, in reading order. */
  actions?: ReactNode;
  variant?: "bar" | "title" | "compact";
};

/**
 * Header row of the work column. `bar` is the 64px desktop/pane row of
 * Paper 5J-0 (breadcrumb, search, primary action); `title` is the phone
 * large-title row of E8-0 (menu or back, title, primary action).
 */
export function TopBar(
  {
    actions,
    breadcrumbs,
    leading,
    subtitle,
    title,
    variant = "bar",
  }: TopBarProps,
) {
  return (
    <div
      className={`bakery-top-bar bakery-top-bar--${variant}`}
      data-state="default"
      data-ui-component="topBar"
      data-variant={variant}
    >
      {leading
        ? <div className="bakery-top-bar__leading">{leading}</div>
        : null}
      <div className="bakery-top-bar__context">
        {variant === "title"
          ? (
            <>
              <p className="bakery-top-bar__title">{title}</p>
              {subtitle
                ? <p className="bakery-top-bar__subtitle">{subtitle}</p>
                : null}
            </>
          )
          : breadcrumbs}
      </div>
      {actions
        ? <div className="bakery-top-bar__actions">{actions}</div>
        : null}
    </div>
  );
}
