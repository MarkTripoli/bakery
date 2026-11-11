import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function OrganizationFixture() {
  const { translate } = useI18n();
  return (
    <UI.Stack data-testid="synthetic-fixture" gap="spacious">
      <UI.StatusLabel status="queued">
        {translate("shell.states.fixtureLabel")}
      </UI.StatusLabel>
      <UI.Heading level="page" tabIndex={-1}>
        {translate("shell.states.organizationTitle")}
      </UI.Heading>
      <UI.EmptyState
        description={translate("shell.states.emptyDescription")}
        title={translate("shell.states.emptyTitle")}
      />
    </UI.Stack>
  );
}
