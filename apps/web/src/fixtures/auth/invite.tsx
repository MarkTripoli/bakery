import type { JSX } from "react";
import {
  InvitationScreen,
  type InvitationScreenProps,
} from "../../screens/InvitationScreen.tsx";

/**
 * `/invitations/$invitationId`'s Paper `invite` states, each rendering the
 * real `InvitationScreen` with static props — no hand-composed markup, so a
 * specimen cannot drift from the page.
 *
 * The organization, inviter, role and address are the design's own
 * illustrative sample data ("Northstar"/"Jordan Lee"/"Developer"/
 * "alex@example.com"; `auth-copy-map.md`'s "Illustrative fixture/sample
 * data" section) — in production they come from
 * `organizationInvitations.preview`.
 */
const ACTIONS = {
  onAccept: () => {},
  onBackToSignIn: () => {},
  onCreateAccount: () => {},
  onDecline: () => {},
  onOpenOrganization: () => {},
  onSignIn: () => {},
  signInHref: "/sign-in?invitation=00000000-0000-4000-8000-000000000001",
  onSwitchAccount: () => {},
} as const;

const SUBJECT = {
  email: "alex@example.com",
  inviterDisplayName: "Jordan Lee",
  organizationName: "Northstar",
  role: "developer",
} as const;

function specimen(props: InvitationScreenProps): () => JSX.Element {
  return function Specimen() {
    return <InvitationScreen {...props} />;
  };
}

export const inviteSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: specimen({ ...ACTIONS, ...SUBJECT, state: "default" }),
  authenticated: specimen({
    ...ACTIONS,
    ...SUBJECT,
    signedInName: "Alex Morgan",
    state: "authenticated",
  }),
  "wrong-account": specimen({
    ...ACTIONS,
    ...SUBJECT,
    state: "wrong-account",
  }),
  accepted: specimen({ ...ACTIONS, ...SUBJECT, state: "accepted" }),
  declined: specimen({
    ...ACTIONS,
    organizationName: SUBJECT.organizationName,
    state: "declined",
  }),
  revoked: specimen({ ...ACTIONS, state: "revoked" }),
};
