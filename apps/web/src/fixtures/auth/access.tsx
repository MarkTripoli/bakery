import type { JSX } from "react";
import { AccessScreen } from "../../screens/AccessScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import { asyncKindFor, useAsyncHost } from "./security-suite.ts";

/**
 * Paper O-0 Your access sample (frames KHJ-0 desktop, MZJ-0 phone, dark): the
 * real presenter with the mock's role, groups and one external grant. The
 * external grant exists only here; production has no source for it.
 */
function AccessHost(
  { async: initial, noGrant = false }: {
    readonly async: SecurityAsyncKind | null;
    readonly noGrant?: boolean;
  },
) {
  const { async, settle } = useAsyncHost(initial);
  return (
    <AccessScreen
      async={async}
      displayName="Alex Morgan"
      externalActions={[{
        id: "github",
        title: "GitHub · MarkTripoli/bakery",
        connection: "Connection: Engineering GitHub · Granted to Developer",
        actions: ["Read issues", "Create issue comments"],
        note: "No other actions or repositories are included.",
      }]}
      groups={[
        {
          id: "settings",
          title: "Settings",
          description: "Manage your account, appearance and sessions.",
          level: "Manage",
        },
        {
          id: "work",
          title: "Work & collaboration",
          description:
            "Create tasks, run agents and review work in permitted repositories.",
          level: "Scoped",
        },
        {
          id: "machines",
          title: "Machines",
          description:
            "View status and use permitted capacity. Maintenance needs an admin.",
          level: "View",
        },
      ]}
      integrationsHref="#integrations"
      noGrant={noGrant}
      onReload={settle}
      onRefresh={settle}
      onRetry={settle}
      organizationName="Platform team"
      roleLabel="Developer"
    />
  );
}

export const accessSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => <AccessHost async={null} />,
  ...Object.fromEntries(
    [
      "loading",
      "empty",
      "error",
      "forbidden",
      "stale",
      "offline",
      "reconnecting",
    ]
      .map((
        token,
      ) => [token, () => <AccessHost async={asyncKindFor(token)} />]),
  ),
  "no-access": () => <AccessHost async={null} noGrant />,
};
