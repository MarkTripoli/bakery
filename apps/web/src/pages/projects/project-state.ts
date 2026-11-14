import type {
  ApplicationResponse,
  IntegrationResource,
  RepositoryResponse,
} from "../../api/client.ts";

/**
 * What the Projects list can say about a repository from one read of the
 * repositories: no working settings in use is "Not set up", archived is
 * "Archived". Ready, Checking and Needs attention need the latest readiness
 * check, which the list read does not carry, so every other row has no badge.
 */
export type RepositoryBadge = "notSetUp" | "archived" | null;

export function repositoryBadge(
  repository: Pick<RepositoryResponse, "activeProfileId" | "archivedAt">,
): RepositoryBadge {
  if (repository.archivedAt !== null) return "archived";
  if (repository.activeProfileId === null) return "notSetUp";
  return null;
}

/** The repository as a person writes it: owner/name. */
export function repositoryName(
  repository: Pick<RepositoryResponse, "owner" | "name">,
): string {
  return `${repository.owner}/${repository.name}`;
}

/** An application's short name: lowercase letters and digits, one dash or underscore between. */
export const APPLICATION_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** A repository's short name: letters, digits and dashes, not starting or ending with a dash. */
export const REPOSITORY_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
const OWNER_OR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** A short name from a name: lowercase, anything else becomes one dash, trimmed. */
export function deriveSlug(name: string, max = 100): string {
  return name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

/** `owner/name` split into its two parts, or null when it is anything else. */
export function splitFullName(
  displayName: string,
): { owner: string; name: string } | null {
  const parts = displayName.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  return OWNER_OR_NAME.test(owner) && OWNER_OR_NAME.test(name)
    ? { owner, name }
    : null;
}

/** A repository the GitHub connection offers, and whether Bakery has it already. */
export type Candidate = {
  readonly resource: IntegrationResource;
  readonly owner: string;
  readonly name: string;
  readonly alreadyAdded: boolean;
};

/**
 * What the connection lists as selected and available, each marked "already
 * added" when a repository with the same connection and GitHub id exists
 * (archived ones too: the server refuses a second one). A resource whose name
 * is not owner/name cannot be added and is left out.
 */
export function candidates(
  resources: readonly IntegrationResource[],
  repositories: readonly Pick<
    RepositoryResponse,
    "integrationConnectionId" | "providerRepoId"
  >[],
): Candidate[] {
  const added = new Set(
    repositories.map((repository) =>
      `${repository.integrationConnectionId}\n${repository.providerRepoId}`
    ),
  );
  return resources.flatMap((resource) => {
    if (!resource.selected || !resource.available) return [];
    const parts = splitFullName(resource.displayName);
    if (parts === null) return [];
    return [{
      resource,
      ...parts,
      alreadyAdded: added.has(
        `${resource.connectionId}\n${resource.externalId}`,
      ),
    }];
  });
}

/** The candidates whose name contains the query, ignoring case. */
export function matching(
  list: readonly Candidate[],
  query: string,
): Candidate[] {
  const needle = query.trim().toLowerCase();
  return needle === ""
    ? [...list]
    : list.filter((item) =>
      `${item.owner}/${item.name}`.toLowerCase().includes(needle)
    );
}

/**
 * Whether a typed branch is a name Git accepts (the rules of
 * `git check-ref-format --branch`): no leading dash or slash, no `..` or `//`,
 * no space or control character, none of `~ ^ : ? * [ \`, no `@{`, no part
 * that starts with a dot or ends in `.lock`, no trailing slash or dot, and not
 * `@` or `HEAD`. The value is trimmed first, as it is when sent.
 */
export function branchProblem(branch: string): "empty" | "invalid" | null {
  const name = branch.trim();
  if (name === "") return "empty";
  const bad = name.startsWith("-") || name.startsWith("/") ||
    name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock") ||
    name.includes("..") || name.includes("//") || name.includes("@{") ||
    name === "@" || name === "HEAD" ||
    // deno-lint-ignore no-control-regex
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(name) ||
    name.split("/").some((part) =>
      part.startsWith(".") || part.endsWith(".lock")
    );
  return bad ? "invalid" : null;
}

export type AddRepositoryErrors = {
  readonly slug?: "empty" | "invalid";
  readonly branch?: "empty" | "invalid";
  readonly application?: "empty";
};

/** What is wrong with the second step of Add repository, if anything. */
export function addRepositoryErrors(
  draft: { slug: string; branch: string; applicationId: string },
): AddRepositoryErrors {
  return {
    ...(draft.applicationId === "" ? { application: "empty" as const } : {}),
    ...(draft.slug.trim() === ""
      ? { slug: "empty" as const }
      : !REPOSITORY_SLUG.test(draft.slug)
      ? { slug: "invalid" as const }
      : {}),
    ...(branchProblem(draft.branch) !== null
      ? { branch: branchProblem(draft.branch)! }
      : {}),
  };
}

/** One application with the repositories shown under it. */
export type ProjectSection = {
  readonly application: ApplicationResponse;
  readonly repositories: readonly RepositoryResponse[];
  /** Archived repositories that are hidden under "Show archived". */
  readonly hiddenArchived: number;
};

/**
 * The applications in the order read, each with its repositories. Archived
 * applications and archived repositories are left out unless asked for.
 */
export function sections(
  applications: readonly ApplicationResponse[],
  repositories: readonly RepositoryResponse[],
  showArchived: boolean,
): ProjectSection[] {
  return applications.flatMap((application) => {
    if (application.archivedAt !== null && !showArchived) return [];
    const own = repositories.filter((repository) =>
      repository.applicationId === application.id
    );
    const shown = own.filter((repository) =>
      showArchived || repository.archivedAt === null
    );
    return [{
      application,
      repositories: shown,
      hiddenArchived: own.length - shown.length,
    }];
  });
}

/** Whether anything archived exists to show. */
export function hasArchived(
  applications: readonly ApplicationResponse[],
  repositories: readonly RepositoryResponse[],
): boolean {
  return applications.some((application) => application.archivedAt !== null) ||
    repositories.some((repository) => repository.archivedAt !== null);
}
