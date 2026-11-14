import { focusAfterPaint } from "../../app/focus.ts";

export { focusAfterPaint };

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
