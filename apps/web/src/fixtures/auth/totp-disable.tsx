import type { JSX } from "react";
import type { TwoFactorFailure } from "../../app/two-factor-failures.ts";
import { TotpDisableScreen } from "../../screens/TotpDisableScreen.tsx";

/**
 * Static specimens for `/settings/security/two-factor/disable`'s Paper
 * `totp-disable` artboards: the real presenter with inert callbacks, one per
 * design state.
 */
function specimen(
  state: "confirm" | "disabled",
  failure: TwoFactorFailure | null = null,
): () => JSX.Element {
  return () => (
    <TotpDisableScreen
      code=""
      failure={failure}
      onBackToSecurity={() => {}}
      onCodeChange={() => {}}
      onPasswordChange={() => {}}
      onSubmit={() => {}}
      password=""
      pending={false}
      state={state}
    />
  );
}

export const totpDisableSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen("confirm"),
  invalid: specimen("confirm", { kind: "invalidCode" }),
  disabled: specimen("disabled"),
};
