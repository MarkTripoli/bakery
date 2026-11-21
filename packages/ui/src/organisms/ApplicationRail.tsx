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
  /**
   * Names a run of items that belong to someone else, such as the pages a
   * plugin adds: consecutive items with the same `group` sit under one small
   * heading (a divider on the compact rail, where each keeps its name as a
   * tooltip) and are announced as a group of that name.
   */
  group?: string;
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
  const renderItem = (item: ApplicationRailItem) => {
    const iconOnly = variant === "compact" && item.icon ? "true" : undefined;
    const tooltip = variant === "compact" && item.group !== undefined &&
        typeof item.label === "string"
      ? item.label
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
      ? isApplicationRailItemSelected(item.matchPath ?? item.href, currentPath)
      : item.id === selectedId;
    return (
      <li key={item.id}>
        <a
          aria-current={selected ? "page" : undefined}
          className="bakery-application-rail__link"
          data-icon-only={iconOnly}
          href={item.href}
          onClick={(event) => onNavigate?.(event, item)}
          title={tooltip}
        >
          {item.icon}
          <span className="bakery-application-rail__label">{item.label}</span>
        </a>
      </li>
    );
  };
  // Consecutive items of one group are drawn together under its heading.
  const rows: ReactNode[] = [];
  for (let index = 0; index < items.length;) {
    const group = items[index].group;
    if (group === undefined) {
      rows.push(renderItem(items[index]));
      index += 1;
      continue;
    }
    const run: ApplicationRailItem[] = [];
    while (index < items.length && items[index].group === group) {
      run.push(items[index]);
      index += 1;
    }
    rows.push(
      <li className="bakery-application-rail__group" key={`group-${group}`}>
        {variant === "compact"
          ? (
            <span
              aria-hidden="true"
              className="bakery-application-rail__divider"
            />
          )
          : (
            <span
              aria-hidden="true"
              className="bakery-application-rail__heading"
            >
              {group}
            </span>
          )}
        <ul
          aria-label={group}
          className="bakery-application-rail__list"
          role="group"
        >
          {run.map(renderItem)}
        </ul>
      </li>,
    );
  }
  return (
    <nav
      aria-label={label}
      className={`bakery-application-rail bakery-application-rail--${variant}`}
      data-state={state}
      data-variant={variant}
      data-ui-component="applicationRail"
    >
      <ul className="bakery-application-rail__list">
        {rows}
      </ul>
    </nav>
  );
}
