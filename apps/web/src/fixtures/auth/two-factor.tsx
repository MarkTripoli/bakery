import type { JSX } from "react";
import { TwoFactorSettingsScreen } from "../../screens/TwoFactorSettingsScreen.tsx";

/** The count the `two-factor/enabled` artboard prints (`auth.js` L113). */
const DESIGN_CODES_REMAINING = 8;

/**
 * Static specimens for `/settings/security/two-factor`'s Paper `two-factor`
 * artboards: the real presenter with inert callbacks, one per design state.
 */
function specimen(
  enabled: boolean,
  backupCodesRemaining: number | null,
): () => JSX.Element {
  return () => (
    <TwoFactorSettingsScreen
      backupCodesRemaining={backupCodesRemaining}
      enabled={enabled}
      onSetUp={() => {}}
    />
  );
}

export const twoFactorSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen(false, null),
  enabled: specimen(true, DESIGN_CODES_REMAINING),
  "no-codes": specimen(true, 0),
};
