import type { MouseEvent, ReactNode } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { LogoMark } from "../atoms/LogoMark.tsx";
import "../navigation.css";

export type SidebarRecentItem = {
  id: string;
  label: ReactNode;
  href: string;
};

export type SidebarNavProps = {
  /** Visible product name beside the mark (the mark itself is named). */
  productName: ReactNode;
  /** Where the brand row leads, usually the Work home. */
  homeHref: string;
  homeLabel: string;
  /** `WorkspaceSwitcher` for the active organization. */
  workspace?: ReactNode;
  /** Primary destinations, an `ApplicationRail`. */
  navigation: ReactNode;
  /** Recently opened sessions; omit when none are known. */
  recent?: {
    label: string;
    items: readonly SidebarRecentItem[];
  };
  /** `UserMenu` pinned to the bottom of the sidebar. */
  footer?: ReactNode;
  /** Optional build or data provenance line under the footer. */
  note?: ReactNode;
  onNavigate?: (
    event: MouseEvent<HTMLAnchorElement>,
    item: { readonly href: string },
  ) => void;
  variant?: "labelled" | "compact" | "drawer";
};

/**
 * The left column of the Paper app shell (frame 5J-0): brand, workspace
 * switcher, primary navigation, recent sessions, and the account footer.
 * `compact` is the pane-profile icon rail; `drawer` is the same content in
 * the phone navigation sheet.
 */
export function SidebarNav(
  {
    footer,
    homeHref,
    homeLabel,
    navigation,
    note,
    onNavigate,
    productName,
    recent,
    variant = "labelled",
    workspace,
  }: SidebarNavProps,
) {
  const showRecent = variant !== "compact" && recent &&
    recent.items.length > 0;
  return (
    <div
      className={`bakery-sidebar bakery-sidebar--${variant}`}
      data-state="default"
      data-ui-component="sidebarNav"
      data-variant={variant}
    >
      <a
        aria-label={homeLabel}
        className="bakery-sidebar__brand"
        href={homeHref}
        onClick={(event) => onNavigate?.(event, { href: homeHref })}
      >
        <LogoMark aria-hidden="true" variant="compact" />
        <span className="bakery-sidebar__product">{productName}</span>
      </a>
      {workspace
        ? <div className="bakery-sidebar__workspace">{workspace}</div>
        : null}
      {navigation}
      {showRecent
        ? (
          <nav aria-label={recent.label} className="bakery-sidebar__recent">
            <p aria-hidden="true" className="bakery-sidebar__section-label">
              {recent.label}
            </p>
            <ul className="bakery-sidebar__recent-list">
              {recent.items.map((item) => (
                <li key={item.id}>
                  <a
                    className="bakery-sidebar__recent-link"
                    href={item.href}
                    onClick={(event) => onNavigate?.(event, item)}
                  >
                    <IconGlyph name="terminal" size="small" />
                    <span>{item.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )
        : null}
      <div aria-hidden="true" className="bakery-sidebar__spacer" />
      {footer ? <div className="bakery-sidebar__footer">{footer}</div> : null}
      {note && variant !== "compact"
        ? <p className="bakery-sidebar__note">{note}</p>
        : null}
    </div>
  );
}
