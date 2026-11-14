import { useBlocker } from "@tanstack/react-router";
import { useEffect } from "react";
import * as UI from "@bakery/ui";
import { ORGANIZATIONS_PATH } from "../app/auth-paths.ts";
import { useUnsavedChangeCount } from "../app/unsaved-changes.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * Asks before the person leaves for the organization chooser while a form
 * holds unsaved input: a new organization means new data, and the input would
 * be lost. "Stay" keeps the page and the input exactly as they were.
 */
export function OrganizationSwitchGuard(
  { onAsk }: { readonly onAsk?: () => void },
) {
  const { translate } = useI18n();
  const unsaved = useUnsavedChangeCount();
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      unsaved > 0 && next.pathname === ORGANIZATIONS_PATH &&
      current.pathname !== ORGANIZATIONS_PATH,
    withResolver: true,
  });
  // On a phone the account menu lives in the navigation drawer, which would
  // cover the question: close it as the question opens.
  const asking = blocker.status === "blocked";
  useEffect(() => {
    if (asking) onAsk?.();
  }, [asking, onAsk]);
  return (
    <UI.AlertDialog
      cancelAction={
        <UI.Button
          onClick={() => blocker.reset?.()}
          type="button"
          variant="secondary"
        >
          {translate("shell.leave.stay")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          onClick={() => blocker.proceed?.()}
          type="button"
          variant="destructive"
        >
          {translate("shell.leave.confirm")}
        </UI.Button>
      }
      onOpenChange={(open) => !open && blocker.reset?.()}
      open={blocker.status === "blocked"}
      title={translate("shell.leave.title")}
      variant="destructive"
    >
      <UI.Text>{translate("shell.leave.body")}</UI.Text>
    </UI.AlertDialog>
  );
}
