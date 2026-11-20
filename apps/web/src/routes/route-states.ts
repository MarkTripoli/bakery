/**
 * Shell fixture state vocabulary. Route coverage in `router.tsx` must list the
 * same literal names; `apps/web/tests/shell.spec.ts` asserts the two agree.
 */
export const shellFixtureStates = [
  "loading",
  "empty",
  "error",
  "forbidden",
  "conflict",
  "stale",
  "offline",
  "reconnecting",
  "busy",
  "long-copy",
  // A page that throws while rendering: the router's error boundary, which no
  // answer from the server can reach.
  "crash",
] as const;

export type ShellFixtureState = (typeof shellFixtureStates)[number];
