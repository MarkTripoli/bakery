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

/**
 * The bar while an update has paused work and the server still answers
 * (#59 slice 5): nothing to do, nothing to dismiss; it goes when the pause does.
 */
function UpdatePausedBar() {
  const { translate } = useI18n();
  return (
    <>
      <UI.InlineNotice
        data-ui-region="update-paused"
        layout="bar"
        role="status"
        tone="information"
      >
        <UI.Stack gap="tight">
          <UI.Text variant="strong">
            {translate("shell.states.updatePausedTitle")}
          </UI.Text>
          <UI.Text variant="muted">
            {translate("shell.states.updatePausedDescription")}
          </UI.Text>
        </UI.Stack>
      </UI.InlineNotice>
      {/* Room between the bar and the page under it. */}
      <UI.Spacer />
    </>
  );
}

/** The page where an installation administrator finishes the restore. */
const RESTORE_PATH = "/installation/restore";

/**
 * The banner on every page while an unfinished restore holds Bakery (#64 E4,
 * design-ux): everyone can read, nobody can start or change work. An
 * installation administrator gets the way to finish it; anyone else is told
 * who can. It cannot be dismissed, and it is not drawn on the page where the
 * restore is finished, which says the same in full.
 */
export function HeldBanner(
  { pathname, updatePaused = false }: {
    readonly pathname: string;
    /** The server answers and says an update has paused work (#59). */
    readonly updatePaused?: boolean;
  },
) {
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
  // A held installation wins the slot: finishing the restore comes first.
  if (!held) return updatePaused ? <UpdatePausedBar /> : null;
  if (pathname === RESTORE_PATH) return null;
  return (
    <>
      <UI.InlineNotice
        action={administrator
          ? (
            <UI.Link
              href={RESTORE_PATH}
              onClick={(event) => {
                event.preventDefault();
                void navigate({ to: RESTORE_PATH });
              }}
            >
              {translate("shell.states.heldAction")}
            </UI.Link>
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
      {/* Room between the banner and the page under it. */}
      <UI.Spacer />
    </>
  );
}
