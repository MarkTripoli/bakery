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
] as const;

export type ShellFixtureState = (typeof shellFixtureStates)[number];
