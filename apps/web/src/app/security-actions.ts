import { useRouter } from "@tanstack/react-router";
import { asyncKindForError } from "./async-state.ts";
import { SIGN_IN_PATH } from "./auth-paths.ts";
import { rememberReturnTo, safeSessionStorage } from "./auth-return.ts";
import { useSessionController } from "./session-context.tsx";
import type { SecurityAsyncKind } from "../screens/security-async.tsx";

/**
 * Returns the handler for accounts with no password to re-prove: it records
 * `returnTo` as the post-sign-in destination, ends the session, and opens
 * sign-in. No session is created from a signed-in page.
 */
export function useSignOutThenSignIn(returnTo: string): () => void {
  const session = useSessionController();
  const router = useRouter();
  return () => {
    const target = new URL(returnTo, "https://return-path.invalid");
    rememberReturnTo(
      { pathname: target.pathname, search: target.search, hash: target.hash },
      safeSessionStorage(),
    );
    void session.signOut().then(() => router.history.push(SIGN_IN_PATH));
  };
}

/**
 * The shared async state a failed load renders: a 403 is `forbidden`
 * (protected content must be cleared), a transport failure is `offline`
 * (the draft stays), anything else is a retryable `error`.
 */
export function asyncKindForFailure(error: unknown): SecurityAsyncKind {
  return asyncKindForError(error);
}
