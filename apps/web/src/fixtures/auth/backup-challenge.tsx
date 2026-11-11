import type { JSX } from "react";
import {
  type RecoveryCodeFailure,
  RecoveryCodeScreen,
} from "../../screens/RecoveryCodeScreen.tsx";

/**
 * Static specimens for `/sign-in/recovery-code`'s Paper `backup-challenge`
 * artboards: the real presenter with inert callbacks, one per design state.
 */
function specimen(
  failure: RecoveryCodeFailure | null,
  pending = false,
): () => JSX.Element {
  return () => (
    <RecoveryCodeScreen
      code=""
      failure={failure}
      onCodeChange={() => {}}
      onNoBackupCode={() => {}}
      onBackToSignIn={() => {}}
      onSubmit={() => {}}
      pending={pending}
    />
  );
}

export const backupChallengeSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen(null),
  invalid: specimen("invalid"),
  loading: specimen(null, true),
  "no-access": specimen("no-access"),
};
