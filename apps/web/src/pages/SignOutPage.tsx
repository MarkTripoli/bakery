import { useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { SIGN_IN_PATH } from "../app/auth-required.tsx";
import { useSessionController } from "../app/session-context.tsx";
import { SignOutScreen } from "../screens/SignOutScreen.tsx";

/**
 * `/sign-out`: the account menu's "sign-out" action navigates here instead
 * of calling `session.signOut()` directly, so the confirmation and result
 * are both real pages instead of a fire-and-forget click. `Cancel` returns
 * to wherever the menu was opened from (browser history, since this route
 * has no fixed "came from" concept); `Sign out` calls `session.signOut()`
 * and renders the success screen in place rather than navigating away
 * immediately, so "Sign in" is a deliberate next step. There is no
 * "unsynced local draft" concept in this product today — `unsynced` has no
 * real trigger and is reachable only through its fixture; see the plan's
 * risk note.
 */
export function SignOutPage() {
  const router = useRouter();
  const navigate = useNavigate();
  const session = useSessionController();
  const [phase, setPhase] = useState<"confirm" | "signing-out" | "success">(
    "confirm",
  );

  return (
    <SignOutScreen
      onCancel={() => router.history.back()}
      onConfirm={() => {
        setPhase("signing-out");
        void session.signOut().then(() => setPhase("success"));
      }}
      onSignIn={() => void navigate({ to: SIGN_IN_PATH })}
      pending={phase === "signing-out"}
      state={phase === "success" ? "success" : "confirm"}
    />
  );
}
