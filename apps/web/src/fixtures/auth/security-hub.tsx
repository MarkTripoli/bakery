import type { JSX } from "react";
import { SecurityHubScreen } from "../../screens/SecurityHubScreen.tsx";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";
import {
  asyncKindFor,
  LONG_COPY_IDENTITY,
  SUITE_IDENTITY,
  useAsyncHost,
} from "./security-suite.ts";

type HubSpecimen = {
  readonly protectedAccount: boolean;
  readonly confirmed: boolean;
  readonly longCopy: boolean;
  readonly async: SecurityAsyncKind | null;
};

function HubHost({ spec }: { readonly spec: HubSpecimen }) {
  const { async, settle } = useAsyncHost(spec.async);
  const identity = spec.longCopy ? LONG_COPY_IDENTITY : SUITE_IDENTITY;
  return (
    <SecurityHubScreen
      {...identity}
      async={async}
      backupCodesRemaining={spec.protectedAccount ? 8 : 0}
      confirmed={spec.confirmed}
      onRefresh={settle}
      onReload={settle}
      onRetry={settle}
      passkeyCount={spec.protectedAccount ? 1 : 0}
      twoFactorEnabled={spec.protectedAccount}
    />
  );
}

function specimen(overrides: Partial<HubSpecimen>): () => JSX.Element {
  const spec: HubSpecimen = {
    protectedAccount: false,
    confirmed: false,
    longCopy: false,
    async: null,
    ...overrides,
  };
  return () => <HubHost spec={spec} />;
}

/**
 * Static specimens for the full security hub (`/__fixtures__/auth/
 * security-hub-<state>`): the three V-0 `security` states plus every shared
 * async state and a worst-case content specimen.
 */
export const securityHubSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen({}),
  saved: specimen({ confirmed: true }),
  protected: specimen({ protectedAccount: true }),
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
      specimen({ async: asyncKindFor(token) }),
    ]),
  ),
  "long-copy": specimen({ protectedAccount: true, longCopy: true }),
};
