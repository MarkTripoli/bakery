import { useBlocker } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/** The rules list and every rule's editor live under this path. */
export const RULES_PATH = "/settings/organization/repository-rules";

/**
 * Asks before a person leaves the repository rules pages with unpublished
 * edits. Moving between the list and a rule's editor never asks: the draft
 * is kept for that. Leaving throws the draft away, because it is stored
 * nowhere else, and a reload or a closed tab gets the browser's own prompt.
 */
export function LeaveGuard(
  { count, discard }: { count: number; discard: () => void },
) {
  const { translate } = useI18n();
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) =>
      count > 0 && !next.pathname.startsWith(RULES_PATH),
    enableBeforeUnload: () => count > 0,
    withResolver: true,
  });
  return (
    <UI.AlertDialog
      cancelAction={
        <UI.Button
          onClick={() => blocker.reset?.()}
          type="button"
          variant="secondary"
        >
          {translate("settings.repositoryRules.draft.stay")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          onClick={() => {
            discard();
            blocker.proceed?.();
          }}
          type="button"
          variant="destructive"
        >
          {translate("settings.repositoryRules.draft.leaveConfirm")}
        </UI.Button>
      }
      onOpenChange={(open) => !open && blocker.reset?.()}
      open={blocker.status === "blocked"}
      title={translate("settings.repositoryRules.draft.leaveTitle")}
      variant="destructive"
    >
      <UI.Text>
        {translate("settings.repositoryRules.draft.leaveBody", { count })}
      </UI.Text>
    </UI.AlertDialog>
  );
}
