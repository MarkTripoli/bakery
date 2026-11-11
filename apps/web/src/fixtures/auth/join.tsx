import type { JSX } from "react";
import { JoinScreen } from "../../screens/JoinScreen.tsx";

/** Paper `join` — `/register` with no invitation, single `default` state. */
export const joinSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => <JoinScreen onSignIn={() => {}} />,
};
