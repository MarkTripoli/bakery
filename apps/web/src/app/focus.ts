import { useEffect, useRef } from "react";

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

/** The rows of a paged list, in order, whatever it is drawn with (a table or a list). */
/** What a row is, most specific first: the first kind present in the list is the one counted. */
const ROW_KINDS = [
  "tbody tr",
  '[role="listitem"]',
  "li",
  '[data-ui-component="descriptionItem"]',
];
const rowsOf = (list: Element | null, selector?: string): HTMLElement[] => {
  if (!list) return [];
  for (const kind of selector ? [selector] : ROW_KINDS) {
    const found = list.querySelectorAll<HTMLElement>(kind);
    if (found.length > 0) return [...found];
  }
  return [];
};

/**
 * Where focus goes after a paged list asked for more, so a keyboard or screen
 * reader user is never left on the page body (design-ux, one rule for every
 * paged list):
 *
 * | After | Focus goes to |
 * |---|---|
 * | Load more succeeds, more pages remain | the Load more button |
 * | Load more succeeds, last page | the first row that load added |
 * | Load more fails | Try again, in the notice that replaced the button |
 * | Try again succeeds | the button if it is back, else the first new row |
 * | A failed first read is retried and succeeds | the list's heading |
 *
 * The page marks what it draws with `data-paged-list`, `data-paged-more`,
 * `data-paged-retry` and `data-paged-heading` (each holding `name`), calls
 * `ask()` from the click handler that loads more or retries, and passes the
 * list's state. Nothing changes on screen except the focus ring.
 */
export function usePagedFocus(
  name: string,
  state: {
    /** A load or retry is in flight. */
    readonly pending: boolean;
    /** The last load or retry failed. */
    readonly failed: boolean;
    /** Rows drawn right now. */
    readonly rowCount: number;
    /** There is another page to load. */
    readonly hasMore: boolean;
    /** What a row is, for a list that is not a table or a list of items. */
    readonly rowSelector?: string;
  },
) {
  const asked = useRef<{ rows: number; kind: "more" | "first" } | null>(null);
  // The rows drawn the last time the list was settled and healthy: a failed
  // load can empty what is drawn, and a retry still adds rows after these.
  const settled = useRef(state.rowCount);
  const { pending, failed, rowCount, hasMore } = state;
  useEffect(() => {
    if (!pending && !failed) settled.current = rowCount;
  }, [pending, failed, rowCount]);
  useEffect(() => {
    const request = asked.current;
    if (!request || pending) return;
    asked.current = null;
    const find = (what: string) =>
      document.querySelector<HTMLElement>(`[data-paged-${what}="${name}"]`);
    if (failed) {
      focusAfterPaint(() => find("retry"));
    } else if (request.kind === "first") {
      focusAfterPaint(() => find("heading"));
    } else {
      focusAfterPaint(() =>
        hasMore
          ? find("more")
          : rowsOf(find("list"), state.rowSelector)[request.rows] ??
            find("more") ?? find("list")
      );
    }
  }, [name, pending, failed, rowCount, hasMore]);
  return {
    /**
     * Call from the click that loads more (`"more"`) or retries a failed first
     * read (`"first"`). `firstNew` is the index of the first row the load adds
     * when that is not just after the rows drawn now: a list that swaps its
     * continuation page for the next one keeps the first page and replaces the rest.
     */
    ask: (kind: "more" | "first" = "more", firstNew?: number) => {
      asked.current = { rows: firstNew ?? settled.current, kind };
    },
  };
}
