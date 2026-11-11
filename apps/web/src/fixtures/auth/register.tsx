import type { JSX } from "react";
import { SIGN_IN_PATH } from "../../app/auth-required.tsx";
import { InvitationContextCard } from "../../screens/InvitationContextCard.tsx";
import {
  RegisterScreen,
  type RegisterScreenProps,
} from "../../screens/RegisterScreen.tsx";

/**
 * `/register?invitation=<uuid>`'s Paper `register` states, each rendering the
 * real `RegisterScreen` with static props. The context column is the same
 * `InvitationContextCard` the page passes, filled with the design's own
 * illustrative sample data ("Northstar"/"Jordan Lee"/"Developer"); the
 * read-only email is the invited address. GitHub sign-in is out of scope for
 * #127, so the artboard's "or / Continue with GitHub" block is absent here
 * exactly as it is in the page (the references are rendered `?caps=core`).
 */
function specimen(
  overrides: Partial<RegisterScreenProps>,
): () => JSX.Element {
  return function Specimen() {
    return (
      <RegisterScreen
        context={
          <InvitationContextCard
            inviterDisplayName="Jordan Lee"
            organizationName="Northstar"
            role="developer"
          />
        }
        email="alex@example.com"
        name=""
        onNameChange={() => {}}
        onPasswordChange={() => {}}
        onSignIn={() => {}}
        onSubmit={() => {}}
        password=""
        signInHref={SIGN_IN_PATH}
        {...overrides}
      />
    );
  };
}

export const registerSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: specimen({}),
  invalid: specimen({
    failure: "auth.register.invalidNotice",
    passwordError: "auth.register.passwordPolicyError",
  }),
  existing: specimen({ notice: "auth.signUp.accountExists" }),
  loading: specimen({ pending: true }),
};
