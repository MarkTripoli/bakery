import type { JSX } from "react";
import type { TwoFactorFailure } from "../../app/two-factor-failures.ts";
import {
  TotpSetupScreen,
  type TotpSetupStep,
} from "../../screens/TotpSetupScreen.tsx";

/**
 * The enrolment URI the `totp-setup/scan` artboard's QR encodes (its raster
 * `totp-demo.png` is a version 7 / level M / mask 5 symbol of exactly this
 * string), so a specimen renders the same modules the reference shows.
 */
const DESIGN_TOTP_URI =
  "otpauth://totp/Bakery%20Demo:alex%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Bakery%20Demo&digits=6&period=30";

/**
 * Static specimens for `/settings/security/two-factor/setup`'s Paper
 * `totp-setup` artboards: the real presenter with inert callbacks, one per
 * design state.
 */
function specimen(
  step: TotpSetupStep,
  failure: TwoFactorFailure | null = null,
  pending = false,
): () => JSX.Element {
  return () => (
    <TotpSetupScreen
      failure={failure}
      onCodeChange={() => {}}
      onCopySetupKey={() => {}}
      onPasswordChange={() => {}}
      onRestart={() => {}}
      onSubmit={() => {}}
      pending={pending}
      step={step}
    />
  );
}

const scanStep: TotpSetupStep = {
  code: "",
  kind: "scan",
  setupKeyCopied: false,
  totpUri: DESIGN_TOTP_URI,
};

export const totpSetupSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen({ kind: "password", password: "" }),
  scan: specimen(scanStep),
  invalid: specimen(scanStep, { kind: "invalidCode" }),
  expired: specimen({ kind: "expired" }),
  loading: specimen(scanStep, null, true),
};
