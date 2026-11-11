import { type JSX, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  type ConnectedClientRow,
  ConnectedClientsScreen,
} from "../../screens/ConnectedClientsScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import { asyncKindFor, useAsyncHost } from "./security-suite.ts";

const LONG_NAME =
  "Alexandria’s local development client for the Northstar platform engineering monorepo";

/** The V-0 sample grant, with the scopes the consent screen words. */
export const SAMPLE_CLIENT = {
  id: "00000000-0000-4000-8000-0000000000c1",
  clientName: "Local development client",
  organizationName: "Northstar",
} as const;

type ClientsSpecimen = {
  readonly longCopy: boolean;
  readonly revoked: boolean;
  readonly async: SecurityAsyncKind | null;
};

/**
 * Specimen host: Revoke access removes the row locally and shows the
 * "revoked" notice, the way the page does after the confirmation returns.
 */
function ClientsHost({ spec }: { readonly spec: ClientsSpecimen }) {
  const { translate } = useI18n();
  const router = useRouter();
  const { async, settle } = useAsyncHost(spec.async);
  const rows: readonly ConnectedClientRow[] = spec.longCopy
    ? Array.from({ length: 5 }, (_, index) => ({
      id: `${SAMPLE_CLIENT.id}-${index}`,
      clientName: `${LONG_NAME} (${index + 1})`,
      organizationName:
        "Northstar Platform Engineering Group of the Americas and Pacific",
      scopes: [
        translate("auth.consent.scope.read.title"),
        translate("auth.consent.scope.operate.title"),
      ],
    }))
    : [{
      id: SAMPLE_CLIENT.id,
      clientName: SAMPLE_CLIENT.clientName,
      organizationName: SAMPLE_CLIENT.organizationName,
      scopes: [
        translate("auth.consent.scope.read.title"),
        translate("auth.consent.scope.operate.title"),
      ],
    }];
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [revoked, setRevoked] = useState(spec.revoked);
  const visible = spec.revoked || async === "empty"
    ? []
    : rows.filter((row) => !removed.includes(row.id));
  return (
    <ConnectedClientsScreen
      async={async ??
        (visible.length === 0 && (revoked || spec.revoked) ? "empty" : null)}
      clients={visible}
      onRefresh={settle}
      onReload={settle}
      onRetry={settle}
      onRevoke={(grantId) => {
        if (spec.longCopy) {
          setRemoved((current) => [...current, grantId]);
          setRevoked(true);
          return;
        }
        router.history.push("/__fixtures__/auth/revoke-client-default");
      }}
      revoked={revoked}
    />
  );
}

/**
 * V-0 `clients` — the list with one grant (`default`), after it was revoked
 * (`revoked`) and with no grants (`empty`), plus the shared async states and
 * the worst case (`long-copy`).
 */
export const clientsSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => (
    <ClientsHost spec={{ longCopy: false, revoked: false, async: null }} />
  ),
  revoked: () => (
    <ClientsHost spec={{ longCopy: false, revoked: true, async: null }} />
  ),
  empty: () => (
    <ClientsHost
      spec={{ longCopy: false, revoked: false, async: asyncKindFor("empty") }}
    />
  ),
  "long-copy": () => (
    <ClientsHost spec={{ longCopy: true, revoked: false, async: null }} />
  ),
  ...Object.fromEntries(
    [
      "loading",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "reconnecting",
    ].map((token) => [
      token,
      () => (
        <ClientsHost
          spec={{ longCopy: false, revoked: false, async: asyncKindFor(token) }}
        />
      ),
    ]),
  ),
};
