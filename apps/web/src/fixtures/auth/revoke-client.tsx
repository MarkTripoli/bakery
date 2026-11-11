import { type JSX, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { RevokeClientScreen } from "../../screens/RevokeClientScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import { SAMPLE_CLIENT } from "./clients.tsx";
import { asyncKindFor, useAsyncHost, useDelayed } from "./security-suite.ts";

const LONG_NAME =
  "Alexandria’s local development client for the Northstar platform engineering monorepo";
const LONG_ORGANIZATION =
  "Northstar Platform Engineering Group of the Americas and Pacific";

type RevokeSpecimen = {
  readonly failed: boolean;
  readonly longCopy: boolean;
  readonly async: SecurityAsyncKind | null;
};

/**
 * Specimen host: Cancel returns to the list, and confirming runs the pending
 * state then lands on the list's "revoked" state, the way the page does once
 * the revocation succeeds.
 */
function RevokeClientHost({ spec }: { readonly spec: RevokeSpecimen }) {
  const router = useRouter();
  const { async, settle } = useAsyncHost(spec.async);
  const [pending, setPending] = useState(false);
  const later = useDelayed();
  return (
    <RevokeClientScreen
      async={async}
      clientName={spec.longCopy ? LONG_NAME : SAMPLE_CLIENT.clientName}
      failed={spec.failed}
      onCancel={() => router.history.push("/__fixtures__/auth/clients-default")}
      onConfirm={() => {
        if (pending) return;
        setPending(true);
        later(() => router.history.push("/__fixtures__/auth/clients-revoked"));
      }}
      onRefresh={settle}
      onReload={settle}
      onRetry={settle}
      organizationName={spec.longCopy
        ? LONG_ORGANIZATION
        : SAMPLE_CLIENT.organizationName}
      pending={pending}
    />
  );
}

/**
 * V-0 `revoke-client` — the confirmation (`default`) and the failed attempt
 * (`failed`), plus the shared async states and the worst case (`long-copy`).
 */
export const revokeClientSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: () => (
    <RevokeClientHost spec={{ failed: false, longCopy: false, async: null }} />
  ),
  failed: () => (
    <RevokeClientHost spec={{ failed: true, longCopy: false, async: null }} />
  ),
  "long-copy": () => (
    <RevokeClientHost spec={{ failed: false, longCopy: true, async: null }} />
  ),
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
    ].map((token) => [
      token,
      () => (
        <RevokeClientHost
          spec={{
            failed: false,
            longCopy: false,
            async: asyncKindFor(token),
          }}
        />
      ),
    ]),
  ),
};
