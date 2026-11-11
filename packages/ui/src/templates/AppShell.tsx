import type { ReactNode } from "react";
import { Sheet } from "../molecules/Sheet.tsx";
import "../navigation.css";

export type AppShellProps = {
  /**
   * Visible-on-focus link that jumps past navigation to `<main>`; pass the
   * translated label.
   */
  skipLinkLabel: string;
  /**
   * `SidebarNav`. Persistent on `rail` (labelled) and `pane` (compact);
   * on `sheet` it is shown in the navigation drawer instead.
   */
  sidebar: ReactNode;
  /** `TopBar` for the work column. */
  topBar: ReactNode;
  children: ReactNode;
  /** `InspectorPanel`: a right column on `rail`, below the work elsewhere. */
  inspector?: ReactNode;
  /**
   * Rail inspector width: `standard` is the 320px column (Paper 5J-0),
   * `medium` the 400px plan and detail inspector (Paper p-18-0), `wide` the
   * 496px session pane (Paper HU-0).
   */
  inspectorSize?: "standard" | "medium" | "wide";
  /**
   * `flush` drops the main padding for pages whose own header and rows
   * carry the Paper inset (work queue 5J-0, session HU-0). `page` also
   * narrows the header inset to 24px (p-18-0 conversation, coordination).
   */
  mainInset?: "padded" | "flush" | "page" | "pageWide";
  /** In-page section navigation, e.g. the Settings sections. */
  sectionNavigation?: ReactNode;
  /** `StatusStrip` footer of the work column. */
  statusStrip?: ReactNode;
  /** `BottomNav`, rendered on `sheet` only. */
  bottomNavigation?: ReactNode;
  /**
   * Accessible name of the sidebar region on `rail` and `pane`, and the
   * title of the phone navigation drawer on `sheet`.
   */
  navigationLabel: string;
  /** Phone navigation drawer visibility, owned by the caller. */
  navigationOpen?: boolean;
  onNavigationOpenChange?: (open: boolean) => void;
  /** Dismiss label of the phone navigation drawer. */
  navigationDismissLabel?: string;
  state?: "default" | "loading" | "error";
  variant?: "sheet" | "pane" | "rail";
  /**
   * Installation policy routes use canvas in dark mode and white in light;
   * organization routes (single sign-on) share the white section chrome.
   */
  appearance?: "installation" | "organization";
};

export const APP_SHELL_MAIN_ID = "bakery-main";

/**
 * Route-independent frame for authenticated product pages, after the Paper
 * enterprise frames 5J-0 (desktop) and E8-0 (phone): sidebar, top bar, work
 * surface, optional inspector and status strip, and the phone tab bar.
 */
export function AppShell(
  {
    bottomNavigation,
    children,
    inspector,
    inspectorSize = "standard",
    mainInset = "padded",
    navigationDismissLabel,
    navigationLabel,
    navigationOpen = false,
    onNavigationOpenChange,
    sectionNavigation,
    sidebar,
    skipLinkLabel,
    state = "default",
    statusStrip,
    topBar,
    variant = "rail",
    appearance,
  }: AppShellProps,
) {
  const skipLink = (
    <a className="bakery-app-shell__skip-link" href={`#${APP_SHELL_MAIN_ID}`}>
      {skipLinkLabel}
    </a>
  );
  return (
    <div
      aria-busy={state === "loading" || undefined}
      className={`bakery-app-shell bakery-app-shell--${variant}`}
      data-inspector={inspector ? "true" : undefined}
      data-inspector-size={inspector ? inspectorSize : undefined}
      data-main-inset={mainInset}
      data-appearance={appearance}
      data-state={state}
      data-variant={variant}
      data-ui-component="appShell"
    >
      <div className="bakery-app-shell__frame">
        {variant === "sheet"
          ? (
            <div className="bakery-app-shell__drawer">
              <Sheet
                dismissLabel={navigationDismissLabel}
                onOpenChange={onNavigationOpenChange}
                open={navigationOpen}
                title={navigationLabel}
                variant="side"
              >
                {sidebar}
              </Sheet>
            </div>
          )
          : (
            <aside
              aria-label={navigationLabel}
              className="bakery-app-shell__sidebar"
            >
              {skipLink}
              {sidebar}
            </aside>
          )}
        <div className="bakery-app-shell__column">
          <header className="bakery-app-shell__header">
            {variant === "sheet" ? skipLink : null}
            {topBar}
          </header>
          <div className="bakery-app-shell__body">
            {sectionNavigation}
            <main
              className="bakery-app-shell__main"
              id={APP_SHELL_MAIN_ID}
              tabIndex={-1}
            >
              {children}
            </main>
          </div>
          {statusStrip
            ? <div className="bakery-app-shell__status">{statusStrip}</div>
            : null}
        </div>
        {inspector
          ? <div className="bakery-app-shell__inspector">{inspector}</div>
          : null}
        {variant === "sheet" && bottomNavigation
          ? <div className="bakery-app-shell__bottom">{bottomNavigation}</div>
          : null}
      </div>
    </div>
  );
}
