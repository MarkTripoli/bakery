import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

/**
 * The page each breadcrumb area's first crumb leads to: Work for the
 * workspace, the first personal page for Settings, the installation settings
 * for Installation.
 */
export const WORK_HOME = "/tasks";
export const SETTINGS_HOME = "/settings/profile";
export const INSTALLATION_HOME = "/installation/settings";
export const MACHINES_HOME = "/machines";
export const ISSUES_HOME = "/issues";

/**
 * Makes every breadcrumb link in the shell move within the app, without a page
 * load, the way the rail does. A plain click only: a modified click, a middle
 * click, a new-tab link and an address on another site keep the browser's own
 * behaviour.
 */
export function useBreadcrumbNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented || event.button !== 0 || event.metaKey ||
        event.ctrlKey || event.shiftKey || event.altKey
      ) return;
      const link = event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>(".ui-breadcrumbs a[href]")
        : null;
      if (!link || (link.target && link.target !== "_self")) return;
      const url = new URL(link.href, globalThis.location.href);
      if (url.origin !== globalThis.location.origin) return;
      event.preventDefault();
      void navigate({ to: `${url.pathname}${url.search}${url.hash}` as never });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [navigate]);
}
