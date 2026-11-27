import * as UI from "@bakery/ui";
import { useI18n } from "../../../../i18n/I18nProvider.tsx";
import { slackAbilities } from "./abilities.ts";

export function SlackAbilities({ granted }: { readonly granted: unknown }) {
  const { translate, locale } = useI18n();
  const { available, missing } = slackAbilities(granted);
  return (
    <UI.Stack gap="compact">
      <UI.Stack gap="tight">
        {available.map((ability) => (
          <UI.Text key={ability.sentence}>
            {translate(ability.sentence)}
          </UI.Text>
        ))}
      </UI.Stack>
      {missing.length === 0
        ? null
        : (
          <UI.Stack data-testid="abilities-not-available" gap="tight">
            <UI.Text variant="strong">
              {translate("integrations.slack.can.notAvailable")}
            </UI.Text>
            {missing.map((ability) => (
              <UI.Text key={ability.sentence} variant="muted">
                {translate("integrations.slack.can.notGranted", {
                  ability: translate(ability.sentence),
                })}
              </UI.Text>
            ))}
          </UI.Stack>
        )}
      <UI.Disclosure summary={translate("integrations.slack.can.scopeNames")}>
        <UI.Stack gap="tight">
          {[...available, ...missing].map((ability) => (
            <UI.Text key={ability.sentence} variant="caption">
              {translate("integrations.slack.can.scopeLine", {
                ability: translate(ability.sentence),
                scopes: new Intl.ListFormat(locale, { type: "unit" }).format(
                  ability.scopes,
                ),
              })}
            </UI.Text>
          ))}
        </UI.Stack>
      </UI.Disclosure>
    </UI.Stack>
  );
}
