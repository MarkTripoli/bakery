import type { JSX } from "react";
import { JoinScreen } from "../../screens/JoinScreen.tsx";

/** `/register` with no invitation: the invitation-needed page and the paused one. */
export const joinSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => <JoinScreen onSignIn={() => {}} />,
  disabled: () => <JoinScreen onSignIn={() => {}} registrationPaused />,
};
