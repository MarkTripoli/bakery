import { type JSX, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { ConsentOrganization } from "../../app/connected-clients.ts";
import {
  type OAuthConsentAsync,
  OAuthConsentScreen,
  type OAuthConsentState,
} from "../../screens/OAuthConsentScreen.tsx";
import { useDelayed } from "./security-suite.ts";

const NORTHSTAR: ConsentOrganization = {
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "Northstar",
  role: "developer",
};

const ORGANIZATIONS: readonly ConsentOrganization[] = [
  NORTHSTAR,
  {
    id: "00000000-0000-4000-8000-0000000000a2",
    name: "Harbor Labs",
    role: "admin",
  },
];

const LONG_ORGANIZATIONS: readonly ConsentOrganization[] = [
  {
    ...NORTHSTAR,
    name: "Northstar Platform Engineering Group of the Americas and Pacific",
  },
  ORGANIZATIONS[1],
];

const SCOPES = ["bakery:read", "bakery:operate"] as const;

type ConsentSpecimen = {
  readonly state: OAuthConsentState;
  readonly async: OAuthConsentAsync | null;
  readonly failed: boolean;
  readonly longCopy: boolean;
};

/**
 * Specimen host: Deny and "Allow access" record the choice locally after a
 * short pending state, landing on the `denied` / `success` screens the page
 * shows once `/oauth2/consent` answers.
 */
function ConsentHost({ spec }: { readonly spec: ConsentSpecimen }) {
  const organizations = spec.longCopy ? LONG_ORGANIZATIONS : ORGANIZATIONS;
  const [state, setState] = useState(spec.state);
  const [async, setAsync] = useState(spec.async);
  const [selected, setSelected] = useState(organizations[0].id);
  const [pending, setPending] = useState(false);
  const later = useDelayed();
  const router = useRouter();
  const decide = (next: "denied" | "success") => {
    if (pending) return;
    setPending(true);
    later(() => {
      setPending(false);
      setState(next);
    });
  };
  return (
    <OAuthConsentScreen
      async={async}
      clientName={spec.longCopy
        ? "Alexandria’s local development client for the Northstar monorepo"
        : "Local development client"}
      failed={spec.failed}
      onAllow={() => decide("success")}
      onDeny={() => decide("denied")}
      onRetry={() => setAsync(null)}
      onReturnToAccount={() =>
        router.history.push("/__fixtures__/auth/security-hub-default")}
      onReviewClients={() =>
        router.history.push("/__fixtures__/auth/clients-default")}
      onSelectOrganization={setSelected}
      organizations={organizations}
      pending={pending}
      scopes={SCOPES}
      selectedOrganizationId={selected}
      state={state}
    />
  );
}

const base: ConsentSpecimen = {
  state: "default",
  async: null,
  failed: false,
  longCopy: false,
};

/**
 * V-0 `consent` — the request (`default`) and its dead ends (`denied`,
 * `success`, `expired`), plus the shared async states, a failed save and the
 * worst case (`long-copy`).
 */
export const consentSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => <ConsentHost spec={base} />,
  denied: () => <ConsentHost spec={{ ...base, state: "denied" }} />,
  success: () => <ConsentHost spec={{ ...base, state: "success" }} />,
  expired: () => <ConsentHost spec={{ ...base, state: "expired" }} />,
  failed: () => <ConsentHost spec={{ ...base, failed: true }} />,
  "long-copy": () => <ConsentHost spec={{ ...base, longCopy: true }} />,
  ...Object.fromEntries(
    (["loading", "error", "forbidden", "offline", "reconnecting"] as const).map(
      (token) => [
        token,
        () => <ConsentHost spec={{ ...base, async: token }} />,
      ],
    ),
  ),
};
