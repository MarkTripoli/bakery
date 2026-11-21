import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  installationHeldQueryOptions,
  installationRestoreQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** The page where an installation administrator finishes the restore. */
const RESTORE_PATH = "/installation/restore";

/**
 * The banner on every page while an unfinished restore holds Bakery (#64 E4,
 * design-ux): everyone can read, nobody can start or change work. An
 * installation administrator gets the way to finish it; anyone else is told
 * who can. It cannot be dismissed, and it is not drawn on the page where the
 * restore is finished, which says the same in full.
 */
export function HeldBanner({ pathname }: { readonly pathname: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const held = useQuery(installationHeldQueryOptions(api)).data === true;
  // Only an installation administrator can read the restore, so a record here
  // is how the banner knows to offer the way to finish it.
  const administrator = useQuery(
    installationRestoreQueryOptions(api, scope, held),
  ).data != null;
  if (!held || pathname === RESTORE_PATH) return null;
  return (
    <UI.InlineNotice
      action={administrator
        ? (
          <UI.Button
            onClick={() => void navigate({ to: RESTORE_PATH })}
            variant="secondary"
          >
            {translate("shell.states.heldAction")}
          </UI.Button>
        )
        : undefined}
      data-ui-region="restore-held"
      layout="bar"
      role="status"
      tone="warning"
    >
      <UI.Stack gap="tight">
        <UI.Text>{translate("shell.states.heldTitle")}</UI.Text>
        <UI.Text variant="muted">
          {translate(
            administrator
              ? "shell.states.heldAdministrator"
              : "shell.states.heldMember",
          )}
        </UI.Text>
      </UI.Stack>
    </UI.InlineNotice>
  );
}
