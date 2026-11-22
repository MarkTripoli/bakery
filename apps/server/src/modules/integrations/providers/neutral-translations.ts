/**
 * How each provider's own events translate into the neutral vocabulary a
 * workflow start matches (one engine O8). Provider names live here, in the
 * provider folder, and nowhere in the neutral matcher.
 */
import { GITHUB_PROVIDER } from "../registry.ts";

/**
 * Provider event name, then action, to the neutral kind it produces. A closed
 * table: an (event, action) pair that is not listed produces no neutral event.
 */
export const PROVIDER_TRANSLATIONS: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
> = Object.freeze({
  [GITHUB_PROVIDER]: Object.freeze({
    issues: Object.freeze({
      opened: "work_item.opened",
      edited: "work_item.edited",
      closed: "work_item.closed",
      reopened: "work_item.reopened",
      labeled: "work_item.labeled",
      unlabeled: "work_item.unlabeled",
    }),
    pull_request: Object.freeze({
      opened: "change_request.opened",
      synchronize: "change_request.updated",
      closed: "change_request.closed",
      reopened: "change_request.reopened",
      ready_for_review: "change_request.ready",
    }),
    check_run: Object.freeze({ completed: "check.completed" }),
    check_suite: Object.freeze({ completed: "check.completed" }),
  }),
});
