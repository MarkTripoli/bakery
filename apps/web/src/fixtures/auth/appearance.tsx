import type { JSX } from "react";
import * as UI from "@bakery/ui";
import { AppearanceScreen } from "../../screens/AppearanceScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import { asyncKindFor, useAsyncHost } from "./security-suite.ts";

function AppearanceSpecimen(
  { async: initial, long = false }: {
    readonly async: SecurityAsyncKind | null;
    readonly long?: boolean;
  },
) {
  const { resolvedTheme } = UI.useTheme();
  const { async, settle } = useAsyncHost(initial);
  return (
    <AppearanceScreen
      async={async}
      dirty
      language=""
      languageHint="Currently using English. Available languages depend on this installation."
      languageHintShort="Currently using English."
      languageOptions={[
        { value: "", label: "System default" },
        { value: "en", label: "English" },
      ]}
      onCancel={() => {}}
      onLanguage={() => {}}
      onRefresh={settle}
      onReload={settle}
      onRetry={settle}
      onSave={() => {}}
      onTheme={() => {}}
      onTimeZone={() => {}}
      organizationName={long
        ? "Northstar Platform Engineering Group, Developer Experience and Reliability Organization"
        : "Platform team"}
      pending={false}
      resolvedTheme={resolvedTheme}
      saveFailed={false}
      saved={false}
      theme="system"
      themeSaveFailed={false}
      timeZone="America/New_York"
      timeZoneHint="Dates use Eastern Time. Scheduled work keeps its own time zone."
      timeZoneHintShort="Scheduled work keeps its own time zone."
      timeZoneOptions={[
        { value: "America/New_York", label: "America / New York" },
      ]}
    />
  );
}

/**
 * Paper O-0 Appearance sample (frames N1T-0/N6E-0 light, SGB-0/SLW-0 dark):
 * the real presenter with inert callbacks and the mock's sample values.
 */
export const appearanceSpecimens: Readonly<Record<string, () => JSX.Element>> =
  {
    default: () => <AppearanceSpecimen async={null} />,
    ...Object.fromEntries(
      [
        "loading",
        "empty",
        "error",
        "forbidden",
        "conflict",
        "stale",
        "offline",
        "reconnecting",
      ]
        .map((
          token,
        ) => [token, () => <AppearanceSpecimen async={asyncKindFor(token)} />]),
    ),
    "long-copy": () => <AppearanceSpecimen async={null} long />,
  };
