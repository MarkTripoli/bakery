import type { MouseEvent, ReactNode } from "react";
import "../navigation.css";

export type ApplicationRailItem = {
  id: string;
  label: ReactNode;
  href: string;
  /**
   * Path prefix that selects this item when it differs from `href`, e.g.
   * Settings links to `/settings/appearance` but owns all of `/settings`.
   */
  matchPath?: string;
  icon?: ReactNode;
  /**
   * A destination the product names but does not ship yet. It renders as
   * inert text with `disabledHint` ("Coming soon") instead of a link, so the
   * rail never offers a dead route.
   */
  disabled?: boolean;
  disabledHint?: ReactNode;
};

export type ApplicationRailProps = {
  items: readonly ApplicationRailItem[];
  currentPath: string;
  /**
   * Route-provided override: select exactly this item instead of matching
   * `currentPath`, e.g. Sessions on a session view under `/tasks/:id`.
   */
  selectedId?: string;
  label: string;
  state?: "default" | "selected" | "expanded";
  variant?: "labelled" | "compact" | "drawer";
  onNavigate?: (
    event: MouseEvent<HTMLAnchorElement>,
    item: ApplicationRailItem,
  ) => void;
};

export function isApplicationRailItemSelected(
  href: string,
  currentPath: string,
) {
  return currentPath === href ||
    (href !== "/" && currentPath.startsWith(`${href}/`));
}

/** Primary navigation for authenticated product destinations. */
export function ApplicationRail({
  items,
  currentPath,
  label,
  onNavigate,
  selectedId,
  state = "default",
  variant = "labelled",
}: ApplicationRailProps) {
  return (
    <nav
      aria-label={label}
      className={`bakery-application-rail bakery-application-rail--${variant}`}
      data-state={state}
      data-variant={variant}
      data-ui-component="applicationRail"
    >
      <ul className="bakery-application-rail__list">
        {items.map((item) => {
          const iconOnly = variant === "compact" && item.icon
            ? "true"
            : undefined;
          if (item.disabled) {
            return (
              <li key={item.id}>
                <span
                  aria-disabled="true"
                  className="bakery-application-rail__link"
                  data-icon-only={iconOnly}
                >
                  {item.icon}
                  <span className="bakery-application-rail__label">
                    {item.label}
                  </span>
                  {item.disabledHint
                    ? (
                      <span className="bakery-application-rail__hint">
                        {item.disabledHint}
                      </span>
                    )
                    : null}
                </span>
              </li>
            );
          }
          const selected = selectedId === undefined
            ? isApplicationRailItemSelected(
              item.matchPath ?? item.href,
              currentPath,
            )
            : item.id === selectedId;
          return (
            <li key={item.id}>
              <a
                aria-current={selected ? "page" : undefined}
                className="bakery-application-rail__link"
                data-icon-only={iconOnly}
                href={item.href}
                onClick={(event) => onNavigate?.(event, item)}
              >
                {item.icon}
                <span className="bakery-application-rail__label">
                  {item.label}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
