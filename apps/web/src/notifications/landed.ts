import { isEditing } from "../app/focus.ts";

/** How long the one-time outline stays on what a notification opened. */
export const LANDED_MS = 2_500;

/**
 * Brings what a notification was about into view: the page jumps (it does not
 * glide), the part is outlined once, and focus goes to `focusTarget` (the
 * heading of what opened) or the part itself, never into a field or onto a
 * button. False when the element is not on the page.
 */
export function landOn(
  element: HTMLElement | null | undefined,
  focusTarget?: HTMLElement | null,
): boolean {
  if (!element) return false;
  element.scrollIntoView({ block: "center" });
  element.setAttribute("data-landed", "true");
  globalThis.setTimeout(
    () => element.removeAttribute("data-landed"),
    LANDED_MS,
  );
  if (isEditing(document.activeElement)) return true;
  const focus = focusTarget ?? element;
  if (!focus.hasAttribute("tabindex")) focus.setAttribute("tabindex", "-1");
  // The shell moves focus to the page title after a route change; a landing's
  // own focus must not be taken back (see AppLayout).
  focus.setAttribute("data-landing-focus", "true");
  focus.focus({ preventScroll: true });
  return true;
}
