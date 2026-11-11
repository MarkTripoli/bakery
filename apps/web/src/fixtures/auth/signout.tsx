import type { JSX } from "react";
import {
  SignOutScreen,
  type SignOutScreenProps,
} from "../../screens/SignOutScreen.tsx";

/**
 * Static specimens for `/sign-out`'s Paper `signout` artboards: the real
 * presenter with inert callbacks, one per design state.
 */
function specimen(state: SignOutScreenProps["state"]): () => JSX.Element {
  return () => (
    <SignOutScreen
      onCancel={() => {}}
      onConfirm={() => {}}
      onSignIn={() => {}}
      pending={false}
      state={state}
    />
  );
}

export const signoutSpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: specimen("confirm"),
  success: specimen("success"),
};
