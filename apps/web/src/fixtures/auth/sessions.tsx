import type { JSX } from "react";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  type OtherSession,
  SessionsSettingsScreen,
} from "../../screens/SessionsSettingsScreen.tsx";

function Specimen(
  { others: withOthers, revoked }: {
    readonly others: boolean;
    readonly revoked: boolean;
  },
) {
  const { translate } = useI18n();
  // The two illustrative other sessions the Paper artboard shows; titles are
  // the product's device-class copy, the times are sample data.
  const others: readonly OtherSession[] = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      device: "phone",
      title: translate("auth.sessions.mobileBrowser"),
      description: translate("auth.sessions.lastActive", { time: "recently" }),
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      device: "desktop",
      title: translate("auth.sessions.otherDesktop"),
      description: translate("auth.sessions.lastActive", {
        time: "yesterday",
      }),
    },
  ];
  return (
    <SessionsSettingsScreen
      onRetry={() => {}}
      onRevokeOthers={() => {}}
      others={withOthers ? others : []}
      revoked={revoked}
      state="ready"
    />
  );
}

/**
 * Paper `sessions` — the list with other devices (`default`), after one was
 * signed out (`revoked`), and with no other sessions (`empty`).
 */
export const sessionsSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => <Specimen others revoked={false} />,
  revoked: () => <Specimen others revoked />,
  empty: () => <Specimen others={false} revoked={false} />,
};
