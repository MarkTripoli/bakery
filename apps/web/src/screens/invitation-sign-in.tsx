import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { SignInScreenProps } from "./SignInScreen.tsx";

/**
 * Paper's `invite-login` artboard (`auth.js` L160) as the deltas it applies
 * to `SignInScreen`: signing in toward a pending invitation is the same
 * password form on the `contextShell`, with the invitation's own heading,
 * submit label, locked address and "Need an account?" footer.
 *
 * `SignInPage` and the `invite-login` fixture spread this, so neither can
 * drift from the other. The invitation summary itself is a separate slot —
 * `context={<InvitationContextCard … />}` — because only the page can
 * resolve the organization, inviter and role.
 */
export function useInvitationSignInProps(
  { context, registerHref }: {
    readonly context: ReactNode;
    readonly registerHref: string;
  },
): Pick<
  SignInScreenProps,
  | "context"
  | "description"
  | "emailReadOnly"
  | "footer"
  | "submitLabel"
  | "title"
  | "variant"
> {
  const { translate } = useI18n();
  return {
    context,
    description: "auth.invitation.signInToView",
    emailReadOnly: true,
    footer: (
      <UI.Link href={registerHref}>
        {translate("auth.invitationSignIn.needAccount")}
      </UI.Link>
    ),
    submitLabel: "auth.invitationSignIn.submit",
    title: "auth.invitation.signInTitle",
    variant: "context",
  };
}
