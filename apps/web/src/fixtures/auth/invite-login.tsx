import type { JSX } from "react";
import { REGISTER_PATH } from "../../app/auth-required.tsx";
import { InvitationContextCard } from "../../screens/InvitationContextCard.tsx";
import { useInvitationSignInProps } from "../../screens/invitation-sign-in.tsx";
import {
  SignInScreen,
  type SignInScreenProps,
} from "../../screens/SignInScreen.tsx";

/**
 * `/sign-in?invitation=<uuid>`'s Paper `invite-login` states. Signing in
 * toward a pending invitation is the same `SignInScreen` the bare route
 * renders, switched to the `context` variant by
 * `useInvitationSignInProps` — so these specimens render that presenter
 * through that same hook, not a second copy of the form. The organization,
 * inviter, role and address are the design's illustrative sample data.
 *
 * Password reset is out of scope for #127, so the presenter has no "Forgot
 * password?" link; the `?caps=core` references omit it too.
 */
function specimen(
  overrides: Partial<SignInScreenProps>,
): () => JSX.Element {
  return function Specimen() {
    const invitation = useInvitationSignInProps({
      context: (
        <InvitationContextCard
          inviterDisplayName="Jordan Lee"
          organizationName="Northstar"
          role="developer"
        />
      ),
      registerHref: REGISTER_PATH,
    });
    return (
      <SignInScreen
        {...invitation}
        email="alex@example.com"
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
        {...overrides}
      />
    );
  };
}

export const inviteLoginSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen({}),
  // `auth.js` L160 builds `invalid`'s fields with no `error` option, so they
  // keep the default border: only the notice marks the failure.
  invalid: specimen({ failure: "auth.signIn.genericFailure" }),
  loading: specimen({ pending: true }),
};
