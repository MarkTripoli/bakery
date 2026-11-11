import type { MouseEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SIGN_OUT_PATH } from "../app/auth-paths.ts";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  type SettingsIndexItem,
  SettingsIndexScreen,
} from "../screens/SettingsIndexScreen.tsx";

/** `/settings` on a phone: the section index. Wider screens are redirected before this renders. */
export function SettingsIndexPage() {
  const { identity } = useSession();
  const { translate } = useI18n();
  const navigate = useNavigate();
  if (identity === null) return null;
  const items: SettingsIndexItem[] = [
    {
      id: "profile",
      href: "/settings/profile",
      title: translate("shell.navigation.profile"),
      description: translate("preferences.index.profile"),
    },
    {
      id: "security",
      href: "/settings/security",
      title: translate("shell.navigation.security"),
      description: translate("preferences.index.security"),
    },
    {
      id: "sessions",
      href: "/settings/sessions",
      title: translate("shell.navigation.sessions"),
      description: translate("preferences.index.sessions"),
    },
    {
      id: "appearance",
      href: "/settings/appearance",
      title: translate("shell.navigation.appearance"),
      description: translate("preferences.index.appearance"),
    },
    {
      id: "access",
      href: "/settings/access",
      title: translate("shell.navigation.access"),
      description: translate("preferences.index.access"),
    },
  ];
  return (
    <SettingsIndexScreen
      displayName={identity.displayName}
      email={identity.email}
      items={items}
      onNavigate={(event: MouseEvent<HTMLAnchorElement>, href) => {
        if (
          event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey
        ) return;
        event.preventDefault();
        void navigate({ to: href });
      }}
      onSignOut={() => void navigate({ to: SIGN_OUT_PATH })}
    />
  );
}
