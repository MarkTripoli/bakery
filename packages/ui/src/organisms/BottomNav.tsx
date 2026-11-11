import type { MouseEvent, ReactNode } from "react";
import {
  type ApplicationRailItem,
  isApplicationRailItemSelected,
} from "./ApplicationRail.tsx";
import "../navigation.css";

export type BottomNavProps = {
  /** Up to five destinations; each needs an `icon`. */
  items: readonly ApplicationRailItem[];
  currentPath: string;
  /** Route-provided override, as on `ApplicationRail`. */
  selectedId?: string;
  label: string;
  onNavigate?: (
    event: MouseEvent<HTMLAnchorElement>,
    item: ApplicationRailItem,
  ) => void;
  /**
   * Trailing "More" tab that opens the navigation drawer instead of routing
   * (Paper E8-0 fourth tab).
   */
  more?: {
    label: ReactNode;
    icon: ReactNode;
    expanded: boolean;
    onSelect: () => void;
  };
  state?: "default" | "selected";
  /** One short line under the tabs, e.g. a design fixture's data notice (E8-0). */
  note?: ReactNode;
};

/**
 * Phone tab bar (Paper E8-0): icon over an 11px label, 52px rows, the
 * bottom safe area kept clear. Unshipped destinations stay visible but
 * inert, like the rail.
 */
export function BottomNav(
  {
    currentPath,
    items,
    label,
    more,
    note,
    onNavigate,
    selectedId,
    state = "default",
  }: BottomNavProps,
) {
  return (
    <nav
      aria-label={label}
      className="bakery-bottom-nav"
      data-state={state}
      data-ui-component="bottomNav"
      data-variant="labelled"
    >
      <ul className="bakery-bottom-nav__list">
        {items.map((item) => (
          <li key={item.id}>
            {item.disabled
              ? (
                <span aria-disabled="true" className="bakery-bottom-nav__link">
                  {item.icon}
                  <span
                    className="bakery-bottom-nav__label"
                    data-rail="truncation-allowed"
                  >
                    {item.label}
                  </span>
                  {item.disabledHint
                    ? (
                      <span className="bakery-visually-hidden">
                        {item.disabledHint}
                      </span>
                    )
                    : null}
                </span>
              )
              : (
                <a
                  aria-current={(selectedId === undefined
                      ? isApplicationRailItemSelected(
                        item.matchPath ?? item.href,
                        currentPath,
                      )
                      : item.id === selectedId)
                    ? "page"
                    : undefined}
                  className="bakery-bottom-nav__link"
                  href={item.href}
                  onClick={(event) => onNavigate?.(event, item)}
                >
                  {item.icon}
                  <span
                    className="bakery-bottom-nav__label"
                    data-rail="truncation-allowed"
                  >
                    {item.label}
                  </span>
                </a>
              )}
          </li>
        ))}
        {more
          ? (
            <li>
              <button
                aria-expanded={more.expanded}
                aria-haspopup="dialog"
                className="bakery-bottom-nav__link"
                onClick={more.onSelect}
                type="button"
              >
                {more.icon}
                <span
                  className="bakery-bottom-nav__label"
                  data-rail="truncation-allowed"
                >
                  {more.label}
                </span>
              </button>
            </li>
          )
          : null}
      </ul>
      {note ? <p className="bakery-bottom-nav__note">{note}</p> : null}
    </nav>
  );
}
