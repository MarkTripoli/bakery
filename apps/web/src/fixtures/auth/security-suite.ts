import { useCallback, useEffect, useRef, useState } from "react";
import type { SecurityAsyncKind } from "../../screens/security-async.tsx";

/** The identity every security-suite specimen shows (Paper V-0 sample data). */
export const SUITE_IDENTITY = {
  displayName: "Alex Morgan",
  email: "alex@example.com",
} as const;

/** The sample passkey name V-0 prints on every passkey artboard. */
export const SAMPLE_PASSKEY_NAME = "Personal laptop";
/** The V-0 passkey row caption. */
export const SAMPLE_PASSKEY_CAPTION = "Added recently · sample passkey";

/** A deliberately long display name and email for the worst-case specimens. */
export const LONG_COPY_IDENTITY = {
  displayName:
    "Alexandria Montgomery-Featherstonehaugh of the Northstar Platform Engineering Group",
  email:
    "alexandria.montgomery-featherstonehaugh@platform-engineering.northstar.example.com",
} as const;

/** Route-state tokens that map straight onto a shared async state. */
const ASYNC_TOKENS: Readonly<Record<string, SecurityAsyncKind>> = {
  loading: "loading",
  empty: "empty",
  error: "error",
  forbidden: "forbidden",
  conflict: "conflict",
  stale: "stale",
  offline: "offline",
  reconnecting: "reconnecting",
};

/** The shared async state a specimen token asks for, or `null`. */
export function asyncKindFor(token: string): SecurityAsyncKind | null {
  return ASYNC_TOKENS[token] ?? null;
}

/**
 * Local async-state host for a specimen: Retry, Reload and Refresh settle the
 * page the way the real data layer would once the request succeeds, so the
 * recovery actions are exercisable in the fixture.
 */
export function useAsyncHost(initial: SecurityAsyncKind | null) {
  const [async, setAsync] = useState(initial);
  const settle = useCallback(() => setAsync(null), []);
  return { async, settle };
}

/** A one-shot timer that is cleared when the specimen unmounts. */
export function useDelayed() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  return useCallback((run: () => void, delayMs = 120) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(run, delayMs);
  }, []);
}
