import { type MouseEvent, type ReactNode, useId, useRef } from "react";
import "../navigation.css";

export type SectionNavigationItem = {
  id: string;
  label: ReactNode;
  href: string;
  /** Detail and action routes that retain this item's selected parent. */
  matches?: readonly string[];
};

/** A labelled run of links; the heading names the group for every reader. */
export type SectionNavigationGroup = {
  id: string;
  heading: ReactNode;
  items: readonly SectionNavigationItem[];
};

export type SectionNavigationProps = {
  /** The links when the section has no groups. */
  items?: readonly SectionNavigationItem[];
  /**
   * Links under non-interactive headings, in order. Each group is its own
   * labelled list; a narrow menu keeps the same groups in one sheet.
   */
  groups?: readonly SectionNavigationGroup[];
  currentPath: string;
  label: string;
  heading?: ReactNode;
  narrowMode: "index" | "menu";
  state?: "default" | "selected" | "returning";
  variant?: "sidebar" | "index" | "menu";
  onNavigate?: (
    event: MouseEvent<HTMLAnchorElement>,
    item: SectionNavigationItem,
  ) => void;
};

type SectionLinkClick = (
  event: MouseEvent<HTMLAnchorElement>,
  item: SectionNavigationItem,
) => void;

function comparablePath(path: string) {
  if (!path.startsWith("/")) return path;
  return path.split(/[?#]/, 1)[0] || "/";
}

function isSelected(item: SectionNavigationItem, currentPath: string) {
  const paths = [item.href, ...(item.matches ?? [])].map(comparablePath);
  const normalizedCurrentPath = comparablePath(currentPath);
  return paths.some((path) =>
    path === normalizedCurrentPath ||
    (path !== "/" && normalizedCurrentPath.startsWith(`${path}/`))
  );
}

function SectionLinks(
  {
    currentPath,
    items = [],
    groups,
    onClick,
  }: Pick<SectionNavigationProps, "items" | "groups" | "currentPath"> & {
    onClick?: SectionLinkClick;
  },
) {
  const headingPrefix = useId();
  if (groups) {
    return (
      <>
        {groups.map((group) => {
          const headingId = `${headingPrefix}-${group.id}`;
          return (
            <div className="bakery-section-navigation__group" key={group.id}>
              <div
                className="bakery-section-navigation__heading"
                id={headingId}
              >
                {group.heading}
              </div>
              <ul
                aria-labelledby={headingId}
                className="bakery-section-navigation__list"
              >
                {linkItems(group.items, currentPath, onClick)}
              </ul>
            </div>
          );
        })}
      </>
    );
  }
  return (
    <ul className="bakery-section-navigation__list">
      {linkItems(items, currentPath, onClick)}
    </ul>
  );
}

function linkItems(
  items: readonly SectionNavigationItem[],
  currentPath: string,
  onClick?: SectionLinkClick,
) {
  return (
    <>
      {items.map((item) => {
        const selected = isSelected(item, currentPath);
        return (
          <li key={item.id}>
            <a
              aria-current={selected ? "page" : undefined}
              className="bakery-section-navigation__link"
              href={item.href}
              onClick={onClick ? (event) => onClick(event, item) : undefined}
            >
              {item.label}
            </a>
          </li>
        );
      })}
    </>
  );
}

/** One ordered section model, rendered as a rail or compact native disclosure. */
export function SectionNavigation(
  {
    currentPath,
    items,
    groups,
    label,
    heading,
    narrowMode,
    onNavigate,
    state = "default",
    variant,
  }: SectionNavigationProps,
) {
  const resolvedMode = variant === "index" || variant === "menu"
    ? variant
    : narrowMode;
  const resolvedVariant = variant ?? "sidebar";
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const handleMenuNavigate: SectionLinkClick = (event, item) => {
    const target = new URL(event.currentTarget.href, document.baseURI);
    const remainsOnCurrentDocument =
      target.origin === globalThis.location.origin &&
      target.pathname === globalThis.location.pathname &&
      target.search === globalThis.location.search;
    onNavigate?.(event, item);
    detailsRef.current?.removeAttribute("open");
    if (event.defaultPrevented) {
      summaryRef.current?.focus();
    } else if (remainsOnCurrentDocument) {
      globalThis.requestAnimationFrame(() => summaryRef.current?.focus());
    }
  };
  return (
    <>
      <nav
        aria-label={label}
        className="bakery-section-navigation"
        data-state={state}
        data-variant={resolvedVariant}
        data-ui-component="sectionNavigation"
      >
        {heading
          ? <div className="bakery-section-navigation__heading">{heading}</div>
          : null}
        <SectionLinks
          currentPath={currentPath}
          groups={groups}
          items={items}
          onClick={onNavigate}
        />
      </nav>
      {resolvedMode === "index"
        ? (
          <nav
            aria-label={label}
            className="bakery-section-navigation__narrow-index"
            data-state={state}
            data-variant="index"
            data-ui-component="sectionNavigation"
          >
            <SectionLinks
              currentPath={currentPath}
              groups={groups}
              items={items}
              onClick={onNavigate}
            />
          </nav>
        )
        : (
          <details
            className="bakery-section-navigation__mobile"
            data-state={state}
            data-variant="menu"
            data-ui-component="sectionNavigation"
            ref={detailsRef}
          >
            <summary
              aria-label={label}
              className="bakery-section-navigation__summary"
              ref={summaryRef}
            >
              {label}
            </summary>
            <nav aria-label={label}>
              <SectionLinks
                currentPath={currentPath}
                groups={groups}
                items={items}
                onClick={handleMenuNavigate}
              />
            </nav>
          </details>
        )}
    </>
  );
}
