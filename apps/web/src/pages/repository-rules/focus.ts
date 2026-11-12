/**
 * Focus after an action replaced the control that triggered it. A control that
 * is gone takes focus with it, and focus then falls to the page body, which
 * leaves a keyboard or screen reader user at the top with no idea what
 * happened. The rule: move focus to the replacement's primary action, or to
 * the first new content, and do it once the screen has settled.
 */
export function focusAfterPaint(
  find: () => HTMLElement | null | undefined,
  /** How many more frames to wait for a target that is missing or still disabled. */
  patience = 30,
): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(function settle() {
      const target = find();
      // A target that is not there yet, or is disabled until the render this
      // waits for, is retried; focusing it now would only be undone.
      if ((!target || target.matches(":disabled")) && patience-- > 0) {
        requestAnimationFrame(settle);
        return;
      }
      if (!target || target.matches(":disabled")) return;
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

/**
 * The first thing to act on once a conflict has been decided: the next
 * conflict's control, else Review and publish, else the page heading. The card
 * just decided can still be on screen when this runs, so it is skipped by its
 * key rather than found first.
 */
export const nextAfterConflict = (decided: string) =>
  document.querySelector<HTMLElement>(
    `[data-testid="org-rules-conflicts"] [data-conflict-key]:not([data-conflict-key="${decided}"]) button`,
  ) ??
    document.querySelector<HTMLElement>('[data-testid="org-rules-review"]') ??
    pageHeading();
