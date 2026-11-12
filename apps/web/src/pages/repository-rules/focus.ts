/**
 * Focus after an action replaced the control that triggered it. A control that
 * is gone takes focus with it, and focus then falls to the page body, which
 * leaves a keyboard or screen reader user at the top with no idea what
 * happened. The rule: move focus to the replacement's primary action, or to
 * the first new content, and do it once the screen has settled.
 */
export function focusAfterPaint(
  find: () => HTMLElement | null | undefined,
): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const target = find();
      if (!target) return;
      if (
        !target.matches("button, a[href], input, select, textarea, [tabindex]")
      ) target.tabIndex = -1;
      target.focus();
    })
  );
}

/** The page's own heading, the stand-in for "the start of what is new". */
export const pageHeading = () =>
  document.querySelector<HTMLElement>(
    '[data-testid="org-repository-rules"] h1',
  );

/** The first thing to act on once a conflict has been decided. */
export const nextAfterConflict = () =>
  document.querySelector<HTMLElement>(
    '[data-testid="org-rules-conflicts"] button',
  ) ??
    document.querySelector<HTMLElement>('[data-testid="org-rules-review"]') ??
    pageHeading();
