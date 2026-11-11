import type { JSX } from "react";
import { REGISTER_PATH } from "../../app/auth-required.tsx";
import {
  SignInScreen,
  type SignInScreenProps,
} from "../../screens/SignInScreen.tsx";

/**
 * `/sign-in`'s `login` design states, each rendering the real
 * `SignInScreen` with static props — no hand-composed markup, so a
 * specimen cannot drift from the page.
 *
 * GitHub sign-in and password reset are out of scope for #127, so the
 * presenter has no "Continue with GitHub" button and no "Forgot password?"
 * link; `github-disabled` is therefore the only reachable login artboard and
 * `invalid`/`loading` are the same form with a failure notice and a pending
 * submit.
 */
function specimen(
  overrides: Partial<SignInScreenProps>,
): () => JSX.Element {
  return function Specimen() {
    return (
      <SignInScreen
        email=""
        onBackToSignIn={() => {}}
        onReturnToSignIn={() => {}}
        onEmailChange={() => {}}
        onPasswordChange={() => {}}
        onRetry={() => {}}
        onSignInAgain={() => {}}
        onSubmit={() => {}}
        onUseDifferentAccount={() => {}}
        password=""
        registerHref={REGISTER_PATH}
        state="form"
        variant="brand"
        {...overrides}
      />
    );
  };
}

export const loginSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  "github-disabled": specimen({}),
  // The artboard marks only the notice: `auth.js` L151 builds `invalid`'s
  // fields with no `error` option, so they keep the default border. The
  // presenter's `aria-invalid` path belongs to empty-field validation, which
  // Paper does not draw.
  invalid: specimen({ failure: "auth.signIn.genericFailure" }),
  loading: specimen({ pending: true }),
  offline: specimen({ state: "offline" }),
  unavailable: specimen({ state: "unavailable" }),
  throttled: specimen({ state: "throttled" }),
};
