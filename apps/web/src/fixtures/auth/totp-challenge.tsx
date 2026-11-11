import type { JSX } from "react";
import {
  type TwoFactorChallengeFailure,
  TwoFactorChallengeScreen,
} from "../../screens/TwoFactorChallengeScreen.tsx";

/**
 * Static specimens for `/sign-in/two-factor`'s Paper `totp-challenge`
 * artboards: the real presenter with inert callbacks, one per design state.
 */
function specimen(
  failure: TwoFactorChallengeFailure | null,
  pending = false,
): () => JSX.Element {
  return () => (
    <TwoFactorChallengeScreen
      code=""
      failure={failure}
      onBackToSignIn={() => {}}
      onCodeChange={() => {}}
      onSubmit={() => {}}
      pending={pending}
    />
  );
}

export const totpChallengeSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen(null),
  invalid: specimen("invalid"),
  loading: specimen(null, true),
  "rate-limited": specimen("rate-limited"),
  expired: specimen("expired"),
};
