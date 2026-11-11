import type { JSX } from "react";
import type { TwoFactorFailure } from "../../app/two-factor-failures.ts";
import {
  BackupCodesScreen,
  type BackupCodesView,
} from "../../screens/BackupCodesScreen.tsx";

/** The eight codes the `backup-codes` artboards print (`auth.js` L103). */
const DESIGN_CODES = [
  "h7mk2-9pvx4",
  "r3nb8-2qfw6",
  "d9tx5-4kma7",
  "w6cp3-8jyh2",
  "m2vz7-5xrd9",
  "k8hs4-3nwp6",
  "t5jq9-7bcv3",
  "p4fr6-2zmk8",
] as const;

/**
 * Static specimens for `/settings/security/two-factor/backup-codes`'s Paper
 * `backup-codes` artboards: the real presenter with inert callbacks, one per
 * design state.
 */
function specimen(
  view: BackupCodesView,
  failure: TwoFactorFailure | null = null,
): () => JSX.Element {
  return () => (
    <BackupCodesScreen
      failure={failure}
      onAcknowledge={() => {}}
      onCodeChange={() => {}}
      onCopy={() => {}}
      onDownload={() => {}}
      onPasswordChange={() => {}}
      onSubmit={() => {}}
      pending={false}
      view={view}
    />
  );
}

const regenerateView: BackupCodesView = {
  code: "",
  kind: "regenerate",
  password: "",
};

export const backupCodesSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen({
    codes: DESIGN_CODES,
    copied: false,
    kind: "codes",
    regenerated: false,
  }),
  copied: specimen({
    codes: DESIGN_CODES,
    copied: true,
    kind: "codes",
    regenerated: false,
  }),
  regenerate: specimen(regenerateView),
  invalid: specimen(regenerateView, { kind: "invalidPassword" }),
  regenerated: specimen({
    codes: DESIGN_CODES,
    copied: false,
    kind: "codes",
    regenerated: true,
  }),
};
