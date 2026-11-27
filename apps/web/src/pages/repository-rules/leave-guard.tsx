import { useBlocker } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/** The rules list and every rule's editor live under this path. */
export const RULES_PATH = "/settings/organization/repository-rules";

/** The four strings the leave question needs, so a page can say it in its own words. */
export type LeaveCopy = {
  readonly title: string;
  readonly body: string;
  readonly stay: string;
  readonly confirm: string;
};

const RULES_COPY: LeaveCopy = {
  title: "settings.repositoryRules.draft.leaveTitle",
  body: "settings.repositoryRules.draft.leaveBody",
  stay: "settings.repositoryRules.draft.stay",
  confirm: "settings.repositoryRules.draft.leaveConfirm",
};

/**
 * Asks before a person leaves pages with unsaved edits. Moving between the
 * pages that share the draft's `path` never asks: the draft is kept for that.
 * Leaving throws the draft away, because it is stored nowhere else, and a
 * reload or a closed tab gets the browser's own prompt.
 */
export function LeaveGuard(
  { count, discard, path = RULES_PATH, copy = RULES_COPY, safest = false }: {
    count: number;
    discard: () => void;
    /** The prefix whose pages share this draft; `/settings/organization/repository-rules` by default. */
    path?: string;
    copy?: LeaveCopy;
    safest?: boolean;
  },
) {
  const { translate } = useI18n();
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => count > 0 && !next.pathname.startsWith(path),
    enableBeforeUnload: () => count > 0,
    withResolver: true,
  });
  return (
    <UI.AlertDialog
      cancelAction={
        <UI.Button
          onClick={() => blocker.reset?.()}
          type="button"
          variant={safest ? "primary" : "secondary"}
        >
          {translate(copy.stay as never)}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          onClick={() => {
            discard();
            blocker.proceed?.();
          }}
          type="button"
          variant={safest ? "secondary" : "destructive"}
        >
          {translate(copy.confirm as never)}
        </UI.Button>
      }
      onOpenChange={(open) => !open && blocker.reset?.()}
      open={blocker.status === "blocked"}
      title={translate(copy.title as never)}
      variant="destructive"
    >
      <UI.Text>
        {translate(copy.body as never, { count })}
      </UI.Text>
    </UI.AlertDialog>
  );
}
