import type { JSX } from "react";
import { REGISTER_PATH } from "../../app/auth-required.tsx";
import { SignInScreen } from "../../screens/SignInScreen.tsx";

/**
 * `/sign-in?reason=expired`'s single Paper artboard, rendered through the
 * same `SignInScreen` the page uses.
 */
function Default() {
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
      state="expired"
      variant="brand"
    />
  );
}

export const expiredSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: Default,
};
