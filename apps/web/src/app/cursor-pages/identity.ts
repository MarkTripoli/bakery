export type Identified = Readonly<{ id: string }>;

export type ProjectsOnboardingSelection = Readonly<{
  application?: string;
  repository?: string;
  profile?: string;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validatedProjectsOnboardingSelection(
  value: Readonly<Record<string, unknown>>,
): ProjectsOnboardingSelection {
  const application = typeof value.application === "string" &&
      UUID_PATTERN.test(value.application)
    ? value.application
    : undefined;
  const repository = typeof value.repository === "string" &&
      UUID_PATTERN.test(value.repository)
    ? value.repository
    : undefined;
  const profile = typeof value.profile === "string" &&
      UUID_PATTERN.test(value.profile)
    ? value.profile
    : undefined;
  return {
    ...(application === undefined ? {} : { application }),
    ...(repository === undefined ? {} : { repository }),
    ...(profile === undefined ? {} : { profile }),
  };
}

export function mergeCursorItems<Item extends Identified>(
  pages: readonly (readonly Item[])[],
): readonly Item[] {
  const seen = new Set<string>();
  const merged: Item[] = [];
  for (const page of pages) {
    for (const item of page) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

export function findExactById<Item extends Identified>(
  items: readonly Item[],
  id: string | null,
): Item | null {
  if (id === null) return null;
  return items.find((item) => item.id === id) ?? null;
}

export type ProfileRevisionState =
  | "legacy-v1"
  | "v2-observation-unavailable";

export function profileRevisionState(
  profile: Readonly<{ config: unknown }>,
): ProfileRevisionState {
  if (
    typeof profile.config === "object" &&
    profile.config !== null &&
    !Array.isArray(profile.config) &&
    "schemaVersion" in profile.config &&
    profile.config.schemaVersion === 1
  ) {
    return "legacy-v1";
  }
  return "v2-observation-unavailable";
}

export type ReadOnlyProfileHistoryRow<
  Profile extends Readonly<
    { id: string; repositoryId: string; config: unknown }
  >,
> = Readonly<{
  profile: Profile;
  active: boolean;
  action: "read-only";
  state: ProfileRevisionState;
}>;

export function readOnlyProfileHistoryRows<
  Profile extends Readonly<
    { id: string; repositoryId: string; config: unknown }
  >,
>(
  repositoryId: string,
  activeProfileId: string | null,
  profiles: readonly Profile[],
): readonly ReadOnlyProfileHistoryRow<Profile>[] {
  return profiles
    .filter((profile) => profile.repositoryId === repositoryId)
    .map((profile) => ({
      action: "read-only" as const,
      active: profile.id === activeProfileId,
      profile,
      state: profileRevisionState(profile),
    }));
}
