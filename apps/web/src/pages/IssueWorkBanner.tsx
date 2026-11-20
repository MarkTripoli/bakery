import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import { ticketRequestsQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { currentRequest, pausedBanner } from "./issues/work-model.ts";

/**
 * Above the readiness card: why work on this issue is paused, when it is. A
 * paused issue never disappears; the banner says what happened and the one
 * step that follows (none, when the work resumes by itself).
 */
export function IssueWorkBanner(
  { issueId, issueUrl, isAdmin, onStartAgain }: {
    readonly issueId: string;
    readonly issueUrl: string;
    readonly isAdmin: boolean;
    readonly onStartAgain: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const requests = useQuery(ticketRequestsQueryOptions(api, scope, issueId));
  const request = currentRequest(requests.data?.items ?? []);
  const banner = request === null ? null : pausedBanner(request);
  if (request === null || banner === null) return null;

  if (banner === "editedAfterSetup") {
    return (
      <UI.AlertBanner
        tone="warning"
        action={
          <UI.Inline gap="compact">
            <UI.Link
              href={issueUrl}
              variant="quiet"
              target="_blank"
              rel="noreferrer"
            >
              {translate("issues.work.banner.review" as never)}
              <span aria-hidden="true">↗</span>
            </UI.Link>
            <UI.Button variant="secondary" onClick={onStartAgain}>
              {translate("issues.work.banner.startAgain" as never)}
            </UI.Button>
          </UI.Inline>
        }
      >
        {translate("issues.work.banner.editedAfterSetup" as never)}
      </UI.AlertBanner>
    );
  }
  if (banner === "dependencyUnreadable") {
    return (
      <UI.AlertBanner
        tone="warning"
        action={isAdmin
          ? (
            <UI.Button
              variant="secondary"
              onClick={() =>
                void navigate({ to: "/settings/organization/integrations" })}
            >
              {translate("issues.next.openIntegrations" as never)}
            </UI.Button>
          )
          : undefined}
      >
        {translate("issues.work.banner.dependencyUnreadable" as never)}
      </UI.AlertBanner>
    );
  }
  return (
    <UI.AlertBanner tone="information">
      {banner === "onHold"
        ? translate("issues.work.banner.onHold" as never)
        : request.triggerLabelName === null
        ? translate("issues.work.banner.labelRemovedPlain" as never)
        : translate("issues.work.banner.labelRemoved" as never, {
          label: request.triggerLabelName,
        })}
    </UI.AlertBanner>
  );
}
