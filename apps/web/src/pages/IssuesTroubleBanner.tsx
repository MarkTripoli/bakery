import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { GitHubTrouble } from "./issue-state.ts";

/**
 * What the Issues pages say when GitHub cannot be read as usual, from the
 * health of the repository's connection: degraded and not-yet-read offer
 * Refresh, an access GitHub no longer accepts offers Reconnect GitHub. Both
 * actions are administrators'; everyone else is told what is wrong.
 */
export function IssuesTroubleBanner(
  { admin, onRefresh, refreshing, subject = "list", trouble }: {
    readonly admin: boolean;
    readonly onRefresh: () => void;
    readonly refreshing: boolean;
    /** What the page shows: the list says "This list", an issue says "This issue". */
    readonly subject?: "list" | "issue";
    readonly trouble: GitHubTrouble;
  },
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const action = !admin ? undefined : trouble === "authRequired"
    ? (
      <UI.Button
        variant="secondary"
        onClick={() =>
          void navigate({ to: "/settings/organization/integrations" })}
      >
        {translate("issues.trouble.reconnect" as never)}
      </UI.Button>
    )
    : (
      <UI.Button
        variant="secondary"
        disabled={refreshing}
        onClick={onRefresh}
      >
        {translate("issues.refresh" as never)}
      </UI.Button>
    );
  return (
    <UI.AlertBanner
      tone={trouble === "authRequired"
        ? "error"
        : trouble === "degraded"
        ? "warning"
        : "information"}
      action={action}
    >
      {translate(
        (trouble === "degraded" && subject === "issue"
          ? "issues.trouble.degradedIssue"
          : `issues.trouble.${trouble}`) as never,
      )}
    </UI.AlertBanner>
  );
}
