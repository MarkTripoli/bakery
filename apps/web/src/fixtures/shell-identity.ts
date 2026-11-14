/**
 * Paper's synthetic sidebar identity (enterprise frame 5J-0). Only design
 * fixture routes (`/__fixtures__/work/*`) render it, and only in development
 * builds, so the screens they show can be scored against the mock without
 * production ever presenting invented people or sessions.
 */
export const SHELL_FIXTURE_IDENTITY = {
  workspace: "Alex’s workspace",
  person: "Alex Morgan",
  note: "Design v1 · Synthetic data",
  phoneNote: "Synthetic example data",
  recentSessions: [
    { id: "repository-onboarding", label: "Repository onboarding" },
    { id: "activity-filters", label: "Activity filters" },
    { id: "ios-notifications", label: "iOS notifications" },
  ],
} as const;

export const WORK_FIXTURE_PREFIX = "/__fixtures__/work/";

export function isWorkFixturePath(pathname: string): boolean {
  return import.meta.env.DEV && pathname.startsWith(WORK_FIXTURE_PREFIX);
}

export function artifactFixturePerson(pathname: string): string | undefined {
  return import.meta.env.DEV && pathname.startsWith("/__fixtures__/artifacts/")
    ? "Fixture Admin"
    : undefined;
}

/**
 * E06 design fixtures (conversation, coordination, onboarding) present
 * Paper's Northwind sample: its own workspace and person, a plain rail with
 * every destination enabled, and no recent sessions or footnote.
 */
export const NORTHWIND_FIXTURE_PROFILE = {
  workspace: "Northwind",
  person: "Priya Raman",
} as const;

const NORTHWIND_FIXTURE_PREFIXES = [
  "/__fixtures__/work/conversation/",
  "/__fixtures__/work/coordination/",
  "/__fixtures__/work/onboarding/",
] as const;

export function isNorthwindFixturePath(pathname: string): boolean {
  return import.meta.env.DEV &&
    NORTHWIND_FIXTURE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * The onboarding phone frame (Paper 2K4U-0) is drawn without a top bar or
 * tab bar; only its design fixture hides them.
 */
export function isOnboardingFixturePath(pathname: string): boolean {
  return import.meta.env.DEV &&
    pathname.startsWith("/__fixtures__/work/onboarding/");
}
