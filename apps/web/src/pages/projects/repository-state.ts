import type {
  RepositoryProfileResponse,
  RepositoryResponse,
} from "../../api/client.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** The most branches a profile may name, and the longest a name or folder may be (the server's limits). */
export const BRANCH_LIMIT = 32;
export const NAME_LIMIT = 255;

/** What a repository's setup looks like at a glance, from what is known without a check. */
export type SetupBadge = "archived" | "notSetUp" | null;

/** Archived and Not set up are known from the repository itself; anything else needs a check to say. */
export function setupBadge(
  repository: Pick<RepositoryResponse, "archivedAt" | "activeProfileId">,
): SetupBadge {
  if (repository.archivedAt !== null) return "archived";
  return repository.activeProfileId === null ? "notSetUp" : null;
}

/** The settings version in use, or null when none is. */
export function activeProfile(
  repository: Pick<RepositoryResponse, "activeProfileId">,
  profiles: readonly RepositoryProfileResponse[],
): RepositoryProfileResponse | null {
  return profiles.find((profile) =>
    profile.id === repository.activeProfileId
  ) ??
    null;
}

/** The versions newest first (highest number). */
export function newestFirst(
  profiles: readonly RepositoryProfileResponse[],
): RepositoryProfileResponse[] {
  return [...profiles].sort((a, b) =>
    b.revision - a.revision || b.id.localeCompare(a.id)
  );
}

/**
 * The number the next saved version takes; the person never types it. The
 * server's `nextProfileRevision` wins when the repository read carries it: the
 * Versions list hides a failed check's candidate, which still holds a
 * revision (#65).
 */
export function nextRevision(
  profiles: readonly RepositoryProfileResponse[],
  serverNext?: number,
): number {
  const listed = Math.max(0, ...profiles.map((profile) => profile.revision)) +
    1;
  return serverNext === undefined ? listed : Math.max(serverNext, listed);
}

/**
 * Whether a version of the settings states rules of its own (the Rules page
 * publishes such versions). A save from this page does not state rules: it
 * asks the server to keep the ones in force, exactly as they are (#461).
 */
export function hasOwnRules(config: unknown): boolean {
  return record(config).repositoryRules !== undefined;
}

/**
 * Whether the rules of a version bind it: it states at least one entry. An
 * explicit empty statement is "no overrides" and binds nothing (the server
 * carries nothing forward for it either).
 */
export function rulesInForce(config: unknown): boolean {
  const rules = record(record(config).repositoryRules).entries;
  return Array.isArray(rules) && rules.length > 0;
}

/** The same JSON whatever the order of an object's keys, so two statements of rules compare. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${
          stable((value as Record<string, unknown>)[key])
        }`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether two versions state exactly the same rules. */
export function sameRules(a: unknown, b: unknown): boolean {
  return stable(record(a).repositoryRules ?? null) ===
    stable(record(b).repositoryRules ?? null);
}

/**
 * Whether the version's fixed policy locks its branches (a policy states the
 * lock for every revision it carries): the branches change only with a new
 * policy revision, never from a save of the working settings.
 */
/**
 * Whether a version's branches differ from the ones a fixed policy pins (design
 * of #65, section 3): the sheet then says "Works from other branches" instead of
 * offering a Use button the server would refuse. A version with the same
 * branches stays usable, and a policy that pins nothing changes nothing.
 */
export function usesOtherBranches(
  activeConfig: unknown,
  candidateConfig: unknown,
): boolean {
  if (!fixesBranches(activeConfig)) return false;
  return canonicalJson(branchesOf(activeConfig)) !==
    canonicalJson(branchesOf(candidateConfig));
}

export function fixesBranches(config: unknown): boolean {
  const policy = record(record(config).fixedPolicy);
  return record(policy.lockedConfiguration).branches === true;
}

/**
 * Whether a version of the settings was made by a readiness check: its config
 * is the check's own (schema 2, with the check policy), and a check only puts
 * its version in use when it passed. A person's version is schema 1.
 */
export function isCheckMade(config: unknown): boolean {
  const kept = record(config);
  return kept.schemaVersion === 2 || kept.checkPolicy !== undefined;
}

/**
 * A person's version is in use although a check made an earlier one: the
 * check's evidence no longer applies, so the steps where Bakery runs its own
 * checks stop until the readiness check passes again (tasks still start).
 */
export function needsCheck(
  active: Pick<RepositoryProfileResponse, "config"> | null,
  profiles: readonly Pick<RepositoryProfileResponse, "config">[],
): boolean {
  return active !== null && !isCheckMade(active.config) &&
    profiles.some((profile) => isCheckMade(profile.config));
}

/** The branches a run may work from, as the profile names them. */
export function branchesOf(config: unknown): string[] {
  const patterns = record(record(config).branches).allowedPatterns;
  return Array.isArray(patterns)
    ? patterns.filter((item): item is string => typeof item === "string")
    : [];
}

/** The working folder, empty for the whole repository ("." is the whole repository). */
export function folderOf(config: unknown): string {
  const root = record(record(config).worktree).root;
  return typeof root === "string" && root !== "." ? root : "";
}

/** One branch name or pattern per line, trimmed, without blanks or repeats. */
export function parseBranches(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const branch = line.trim();
    if (branch !== "" && !seen.has(branch)) {
      seen.add(branch);
      out.push(branch);
    }
  }
  return out;
}

/** What is wrong with the working settings the person entered, or null. */
export type SettingsProblem =
  | "branches"
  | "tooMany"
  | "tooLong"
  | "characters"
  | "folder";

/** A control character (a NUL, a newline inside a name) is never part of a branch name or a folder. */
const hasControl = (text: string): boolean =>
  Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

export function settingsProblem(
  branches: readonly string[],
  folder: string,
): SettingsProblem | null {
  if (branches.length === 0) return "branches";
  if (branches.length > BRANCH_LIMIT) return "tooMany";
  if (branches.some((branch) => branch.length > NAME_LIMIT)) return "tooLong";
  if (branches.some(hasControl)) return "characters";
  const trimmed = folder.trim();
  if (
    trimmed.length > NAME_LIMIT || trimmed.startsWith("/") ||
    /(^|\/)\.\.(\/|$)/.test(trimmed) || hasControl(trimmed)
  ) return "folder";
  return null;
}

/**
 * The profile config for new working settings: the earlier version's config
 * with the branches and the folder replaced (anything else it holds, such as
 * agent bindings, stays as it is), or the fixed-workflow default for a first one.
 */
export function settingsConfig(
  previous: unknown,
  input: {
    readonly base: string;
    readonly branches: readonly string[];
    readonly folder: string;
  },
): Record<string, unknown> {
  // A person's save is a schema-1 version. A check-made (schema 2) version
  // carries `checkPolicy`, the check's own evidence; it is dropped, because a
  // person-saved version has no check behind it (#65). The check evidence then
  // no longer applies until the check runs again.
  // Rules of the repository's own are never stated by a save from here: the
  // server carries the ones in force forward (`keepRepositoryRules`), and
  // refuses a save that states them as well.
  const {
    checkPolicy: _checkEvidence,
    repositoryRules: _rulesInForce,
    ...kept
  } = record(previous);
  return {
    ...kept,
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: input.base, allowedPatterns: [...input.branches] },
    worktree: { root: input.folder.trim() === "" ? "." : input.folder.trim() },
  };
}

/** Canonical JSON: object keys sorted at every depth, array order kept (the server's digest input). */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (typeof item === "object" && item !== null) {
      const source = item as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined) out[key] = sort(source[key]);
      }
      return out;
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

/** The SHA-256 of the canonical JSON of a config, as the server verifies a published revision. */
export async function configDigest(config: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson(config)),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
