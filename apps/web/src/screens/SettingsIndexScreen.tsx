import type { MouseEvent } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type SettingsIndexItem = {
  readonly id: string;
  readonly href: string;
  /** Already-translated section name. */
  readonly title: string;
  /** Already-translated one-line summary. */
  readonly description: string;
};

export type SettingsIndexScreenProps = {
  readonly displayName: string;
  readonly email: string;
  readonly items: readonly SettingsIndexItem[];
  readonly onNavigate: (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => void;
  readonly onSignOut: () => void;
};

/**
 * `/settings` on a phone: the person, then one row per personal settings
 * section, then sign out. Wider screens never see it; they land on Profile.
 */
export function SettingsIndexScreen(
  { displayName, email, items, onNavigate, onSignOut }:
    SettingsIndexScreenProps,
) {
  const { translate } = useI18n();
  return (
    <UI.SettingsContent data-testid="settings-index" variant="preferences">
      <UI.AuthHeading
        description={translate("preferences.index.description")}
        title={translate("shell.states.settingsTitle")}
      />
      <UI.Identity
        avatar={{ alt: displayName, size: "large" }}
        detail={email}
        name={displayName}
        showType={false}
        type="person"
      />
      <UI.SettingsSection title={translate("preferences.index.sectionLabel")}>
        {items.map((item) => (
          <UI.SettingsIndexRow
            description={item.description}
            href={item.href}
            key={item.id}
            onClick={(event) => onNavigate(event, item.href)}
            title={item.title}
          />
        ))}
      </UI.SettingsSection>
      <UI.Button onClick={onSignOut} variant="secondary">
        {translate("preferences.index.signOut")}
      </UI.Button>
    </UI.SettingsContent>
  );
}
