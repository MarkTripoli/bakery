import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../../../../api/context.tsx";
import { mySlackLinkQueryOptions } from "../../../../api/query.ts";
import { useProtectedScope } from "../../../../app/query-scope-context.tsx";
import { useI18n } from "../../../../i18n/I18nProvider.tsx";
import { RouterLink } from "../../../../app/router-link.tsx";

export function SlackOwnLinkNotice() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const link = useQuery(mySlackLinkQueryOptions(api, scope));
  if (
    link.data === undefined || link.data.connection !== "working" ||
    link.data.state === "linked"
  ) return null;
  return (
    <UI.InlineNotice data-testid="own-slack-link" tone="information">
      {translate("integrations.slack.ownLink.text")}{" "}
      <RouterLink hash="slack" to="/settings/security">
        {translate("integrations.slack.ownLink.action")}
      </RouterLink>
    </UI.InlineNotice>
  );
}
