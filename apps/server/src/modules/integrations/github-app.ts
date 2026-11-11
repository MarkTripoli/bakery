import { StandardError } from "@bakery/contracts/http";
import {
  importGitHubAppPrivateKey,
  signGitHubAppJwt,
} from "./github-app-key.ts";
import { z } from "zod";
import {
  GITHUB_API_ORIGIN,
  GITHUB_OAUTH_TOKEN_URL,
  GitHubRejected,
  readJson,
  REJECTED_CREDENTIAL_STATUSES,
  REQUEST_TIMEOUT_MS,
  type Transport,
} from "./github-transport.ts";

export {
  DEFAULT_RATE_LIMIT_SECONDS,
  GITHUB_API_VERSION,
  GitHubReadFailure,
  type GitHubReadFailureKind,
  gitHubRetryAfterSeconds,
} from "./github-transport.ts";

/** Fixed Bakery paths a GitHub App manifest points at, relative to the public base URL. */
export const GitHubAppPath = Object.freeze(
  {
    ManifestCallback: "/v1/integration-auth/github/manifest-callback",
    OAuthCallback: "/v1/integration-auth/github/callback",
    Setup: "/v1/integration-auth/github/setup",
    Webhook: "/v1/webhooks/github",
  } as const,
);

/**
 * App permissions per docs/technical-design/09-integrations.md "GitHub
 * endpoint permissions". Workflows stay a separate opt-in.
 */
export const GITHUB_APP_DEFAULT_PERMISSIONS = Object.freeze(
  {
    metadata: "read",
    issues: "write",
    contents: "write",
    pull_requests: "write",
    checks: "write",
  } as const,
);

/**
 * Webhook events a new Bakery GitHub App subscribes to. `installation` and
 * `installation_repositories` arrive without a subscription, so the manifest
 * lists only the five that concern a selected repository. Each one the
 * receiver reads is in `SUPPORTED_EVENTS` (`intake-events.ts`).
 */
export const GITHUB_APP_DEFAULT_EVENTS = Object.freeze(
  [
    "issues",
    "pull_request",
    "check_run",
    "check_suite",
    "repository",
  ] as const,
);

const LoginSchema = z.string().min(1).max(39).regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
  "Invalid GitHub login.",
).describe(
  "GitHub user or organization login, 1-39 alphanumerics or inner hyphens.",
);

const PermissionLevelSchema = z.enum(["read", "write", "admin"]).describe(
  "GitHub App permission level for one permission scope.",
);

export const GitHubAppManifestSchema = z.object({
  name: z.string().min(1).max(34).describe(
    "GitHub App display name; must be unique on github.com.",
  ),
  url: z.string().url().describe(
    "Homepage GitHub shows for the App: the Bakery public base URL.",
  ),
  hook_attributes: z.object({
    url: z.string().url().describe(
      "Bakery webhook receiver URL derived from the public base URL.",
    ),
    active: z.literal(true).describe(
      "Webhook delivery is on: GitHub sends the subscribed events to the Bakery webhook receiver at the url above.",
    ),
  }).strict().describe("Webhook configuration GitHub stores for the App."),
  redirect_url: z.string().url().describe(
    "Bakery manifest callback GitHub redirects to with the one-time code.",
  ),
  callback_urls: z.array(
    z.string().url().describe(
      "Bakery OAuth callback URL for user authorization.",
    ),
  ).min(1).max(10).describe("OAuth callback URLs GitHub accepts for the App."),
  setup_url: z.string().url().describe(
    "Bakery page GitHub sends users to after installing the App.",
  ),
  setup_on_update: z.literal(true).describe(
    "Also send users to setup_url after they update an installation.",
  ),
  public: z.boolean().describe(
    "Whether any GitHub account may install the App; false limits installs to the owner.",
  ),
  default_permissions: z.record(
    z.string().min(1).describe("GitHub App permission scope name."),
    PermissionLevelSchema,
  ).describe("Permissions the App requests on every installation."),
  default_events: z.array(
    z.enum(GITHUB_APP_DEFAULT_EVENTS).describe(
      "GitHub webhook event name the Bakery receiver reads.",
    ),
  ).length(GITHUB_APP_DEFAULT_EVENTS.length).refine(
    (events) => new Set(events).size === GITHUB_APP_DEFAULT_EVENTS.length,
    "default_events must list each Bakery webhook event exactly once.",
  ).describe(
    "Webhook events the App subscribes to: exactly the five in GITHUB_APP_DEFAULT_EVENTS, each once. Installation lifecycle events arrive without a subscription.",
  ),
}).strict().describe(
  "GitHub App manifest Bakery posts to GitHub's manifest registration page.",
);
export type GitHubAppManifest = z.infer<typeof GitHubAppManifestSchema>;

export const GitHubAppManifestOptionsSchema = z.object({
  name: z.string().min(1).max(34).describe(
    "Requested App display name; Bakery when omitted.",
  ).optional().describe("Optional requested App display name."),
  public: z.boolean().describe(
    "Whether the App is public; false when omitted.",
  ).optional().describe("Optional App visibility."),
}).strict().describe(
  "Administrator choices that shape the GitHub App manifest.",
);
export type GitHubAppManifestOptions = z.infer<
  typeof GitHubAppManifestOptionsSchema
>;

/** Builds the manifest; every URL derives from the deployment's public base URL. */
export function buildGitHubAppManifest(
  publicBaseUrl: string,
  options: GitHubAppManifestOptions = {},
): GitHubAppManifest {
  const at = (path: string) => new URL(path, publicBaseUrl).href;
  return GitHubAppManifestSchema.parse({
    name: options.name ?? "Bakery",
    url: new URL(publicBaseUrl).origin,
    hook_attributes: { url: at(GitHubAppPath.Webhook), active: true },
    redirect_url: at(GitHubAppPath.ManifestCallback),
    callback_urls: [at(GitHubAppPath.OAuthCallback)],
    setup_url: at(GitHubAppPath.Setup),
    setup_on_update: true,
    public: options.public ?? false,
    default_permissions: { ...GITHUB_APP_DEFAULT_PERMISSIONS },
    default_events: [...GITHUB_APP_DEFAULT_EVENTS],
  });
}

/** GitHub's user authorization endpoint for GitHub Apps; the only allowlisted target. */
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const AUTHORIZE_PARAMETERS = [
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;

/** The fixed OAuth callback a registered App lists first in its callback URLs. */
export function gitHubOAuthCallbackUrl(publicBaseUrl: string): string {
  return new URL(GitHubAppPath.OAuthCallback, publicBaseUrl).href;
}

export type GitHubAuthorization = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

/** Builds the user authorization URL with S256 PKCE; only these five parameters. */
export function gitHubAuthorizationUrl(
  authorization: GitHubAuthorization,
): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", authorization.clientId);
  url.searchParams.set("redirect_uri", authorization.redirectUri);
  url.searchParams.set("state", authorization.state);
  url.searchParams.set("code_challenge", authorization.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/**
 * True only for GitHub's authorize endpoint carrying exactly the expected
 * client id and redirect URI, one non-empty state and an S256 challenge.
 */
export function isAllowlistedGitHubAuthorizationUrl(
  value: string,
  expected: { clientId: string; redirectUri: string },
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const allowed = new URL(GITHUB_AUTHORIZE_URL);
  const keys = [...url.searchParams.keys()];
  return url.origin === allowed.origin && url.pathname === allowed.pathname &&
    url.username === "" && url.password === "" && url.hash === "" &&
    keys.length === AUTHORIZE_PARAMETERS.length &&
    AUTHORIZE_PARAMETERS.every((key) =>
      url.searchParams.getAll(key).length === 1
    ) &&
    url.searchParams.get("client_id") === expected.clientId &&
    url.searchParams.get("redirect_uri") === expected.redirectUri &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state")!) &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge")!) &&
    url.searchParams.get("code_challenge_method") === "S256";
}

const AppSlugSchema = z.string().min(1).max(100).regex(
  /^[a-z0-9][a-z0-9-]*$/,
).describe("URL-safe App slug used in github.com/apps/<slug>.");

/**
 * GitHub's install page for the registered App. GitHub passes `state` on to
 * the App's Setup URL, which is how the install binds to the attempt.
 */
export function gitHubInstallationUrl(slug: string, state: string): string {
  const url = new URL(
    `https://github.com/apps/${
      encodeURIComponent(AppSlugSchema.parse(slug))
    }/installations/new`,
  );
  url.searchParams.set("state", state);
  return url.href;
}

/**
 * True only for the registered App's install page on github.com carrying
 * exactly one non-empty state and nothing else.
 */
export function isAllowlistedGitHubInstallationUrl(
  value: string,
  slug: string,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.origin === "https://github.com" &&
    url.pathname === `/apps/${slug}/installations/new` &&
    url.username === "" && url.password === "" && url.hash === "" &&
    [...url.searchParams.keys()].length === 1 &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "");
}

/** GitHub page that creates an App from a posted manifest, for a user or an organization. */
export function gitHubAppRegistrationUrl(
  state: string,
  organizationLogin?: string,
): string {
  const url = organizationLogin === undefined
    ? new URL("https://github.com/settings/apps/new")
    : new URL(
      `https://github.com/organizations/${
        encodeURIComponent(LoginSchema.parse(organizationLogin))
      }/settings/apps/new`,
    );
  url.searchParams.set("state", state);
  return url.href;
}

const PositiveIdSchema = z.number().int().positive().max(
  Number.MAX_SAFE_INTEGER,
).describe("Positive GitHub numeric identifier.");

export const GitHubAppConversionSchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub App id."),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/).describe(
    "URL-safe App slug used in github.com/apps/<slug>.",
  ),
  name: z.string().min(1).max(100).describe("GitHub App display name."),
  client_id: z.string().min(1).max(100).describe(
    "Public OAuth client id of the App.",
  ),
  client_secret: z.string().min(1).max(4096).describe(
    "OAuth client secret; stored only as installation-owned ciphertext.",
  ),
  webhook_secret: z.string().min(1).max(4096).describe(
    "Webhook signing secret; stored only as installation-owned ciphertext.",
  ).nullable().describe(
    "Webhook signing secret, or null when GitHub generated none.",
  ),
  pem: z.string().min(1).max(16384).regex(/^-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    .describe(
      "PEM private key that signs App JWTs; stored only as installation-owned ciphertext.",
    ),
  html_url: z.string().url().max(2048).describe("GitHub page of the App."),
  owner: z.object({
    login: LoginSchema.describe("Login of the account that owns the App."),
    id: PositiveIdSchema.describe(
      "Numeric id of the account that owns the App.",
    ),
    type: z.string().min(1).max(40).describe(
      "Account type of the owner, such as User or Organization.",
    ),
  }).describe("Account that owns the new App; unknown fields are dropped.")
    .transform(({ login, id, type }) => ({ login, id, type })).describe(
      "Owner identity reduced to login, id and type.",
    ),
  permissions: z.record(
    z.string().min(1).max(100).describe("Permission scope name."),
    z.string().min(1).max(40).describe("Granted permission level."),
  ).describe("Permissions GitHub granted the App at creation."),
  events: z.array(
    z.string().min(1).max(100).describe("Subscribed webhook event name."),
  ).max(200).describe("Webhook events the App subscribed to at creation."),
}).describe(
  "Selected fields of GitHub's manifest conversion response; unknown fields are dropped and never stored.",
);
export type GitHubAppConversion = z.output<typeof GitHubAppConversionSchema>;

/**
 * Manifest codes are opaque URL-safe tokens. Anything else (".", "..", "/",
 * "?") could change the conversion URL, so it is refused before any call.
 */
export function isGitHubManifestCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{1,4096}$/.test(code);
}

/** Opaque GitHub OAuth authorization codes; anything else is refused unsent. */
export function isGitHubOAuthCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{1,512}$/.test(code);
}

/** A GitHub installation id: a positive decimal integer within the safe range. */
export function parseGitHubInstallationId(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** The user-to-server token response; only the access token is read. */
export const GitHubOAuthTokenSchema = z.object({
  access_token: z.string().min(1).max(4096).describe(
    "Short-lived GitHub App user access token; used in memory only and never stored or logged.",
  ),
}).describe(
  "Selected field of GitHub's OAuth token response; refresh tokens and every other field are dropped.",
);

export const GitHubInstallationSchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub App installation id."),
  app_id: PositiveIdSchema.describe(
    "Numeric id of the GitHub App this installation belongs to.",
  ),
  account: z.object({
    id: PositiveIdSchema.describe("Numeric id of the installation account."),
    login: z.string().max(100).nullish().describe(
      "Login of the user or organization the App is installed on; absent for enterprise accounts, which have a slug instead.",
    ),
    slug: z.string().max(100).nullish().describe(
      "Slug of an enterprise account the App is installed on.",
    ),
    type: z.string().min(1).max(40).describe(
      "Account type, such as User or Organization.",
    ),
  }).describe("Account the App is installed on; unknown fields are dropped."),
  repository_selection: z.enum(["all", "selected"]).describe(
    "Whether the installation covers all or only selected repositories.",
  ),
  permissions: z.record(
    z.string().min(1).max(100).describe("Permission scope name."),
    z.string().min(1).max(40).describe("Granted permission level."),
  ).describe("Permissions the installation granted the App."),
  suspended_at: z.string().max(64).nullable().optional().describe(
    "Time the installation was suspended, or null or absent when active.",
  ),
}).describe(
  "Selected fields of a GitHub App installation; unknown fields are dropped and never stored.",
).transform((wire) => ({
  id: wire.id,
  appId: wire.app_id,
  account: {
    id: wire.account.id,
    // Presentation only: the immutable identity is the numeric account id.
    login: wire.account.login || wire.account.slug || String(wire.account.id),
    type: wire.account.type,
  },
  repositorySelection: wire.repository_selection,
  permissions: wire.permissions,
  suspended: wire.suspended_at !== null && wire.suspended_at !== undefined,
})).describe("Installation identity, permissions and suspension state.");
export type GitHubInstallation = z.output<typeof GitHubInstallationSchema>;

const GitHubInstallationPageSchema = z.object({
  total_count: z.number().int().nonnegative().describe(
    "Total installations the user token can access.",
  ),
  installations: z.array(GitHubInstallationSchema).max(100).describe(
    "One page of installations the user token can access.",
  ),
}).describe("One page of GET /user/installations.");

/** Installations per GitHub listing page; GitHub's maximum. */
export const GITHUB_INSTALLATIONS_PER_PAGE = 100;

/** GitHub `owner/name`: an account login, a slash and a repository name. */
export const RepositoryFullNameSchema = z.string().max(141).regex(
  // "." and ".." are refused: they would change the safe URL's path.
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/,
  "Invalid GitHub repository full name.",
).describe(
  "GitHub repository full name: owner login, a slash, then the repository name.",
);

export const GitHubRepositorySchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub repository id."),
  full_name: RepositoryFullNameSchema,
  private: z.boolean().describe("Whether the repository is private."),
  archived: z.boolean().optional().describe(
    "Whether the repository is archived; absent counts as not archived.",
  ),
  permissions: z.object({
    admin: z.boolean().optional().describe(
      "Whether the authenticated user administers the repository.",
    ),
  }).optional().describe(
    "The authenticated user's own permissions on the repository; absent means none are known.",
  ),
}).describe(
  "Selected fields of a repository listed with a user token; URLs and every other field are dropped.",
).transform((wire) => ({
  id: wire.id,
  fullName: wire.full_name,
  private: wire.private,
  archived: wire.archived === true,
  // Fail closed: only an explicit admin grant to this user counts.
  admin: wire.permissions?.admin === true,
})).describe(
  "Repository identity and whether the connecting user administers it.",
);
export type GitHubRepository = z.output<typeof GitHubRepositorySchema>;

const GitHubRepositoryPageSchema = z.object({
  total_count: z.number().int().nonnegative().describe(
    "Total repositories of the installation the user token can access.",
  ),
  repositories: z.array(GitHubRepositorySchema).max(100).describe(
    "One page of the installation's repositories the user token can access.",
  ),
}).describe("One page of GET /user/installations/{id}/repositories.");

/** A short-lived installation token, held in memory only to revoke it. */
const InstallationTokenSchema = z.string().min(1).max(4096).describe(
  "Short-lived installation token; used in memory only to revoke it, never stored or logged.",
);
/** Only the token of an installation token answer, read to revoke it. */
const GitHubTokenOnlySchema = z.object({ token: InstallationTokenSchema })
  .describe(
    "The token field of GitHub's installation token response, read alone so it can always be revoked.",
  );
/**
 * The answer to a narrowed installation token request: the token, kept only
 * to revoke it at once, and the covered repository ids. Its expiry and
 * permissions are dropped; nothing here leaves the client.
 */
const GitHubNarrowedTokenSchema = z.object({
  token: InstallationTokenSchema,
  repositories: z.array(
    z.object({
      id: PositiveIdSchema.describe("Numeric id of a covered repository."),
    }).describe(
      "One repository the narrowed token covers; other fields dropped.",
    ),
  ).max(1).describe("Repositories the narrowed token covers."),
}).describe(
  "Selected fields of GitHub's installation token response; its expiry and permissions are dropped.",
);

/**
 * The answer to an unnarrowed metadata-read token request: only the token
 * and its expiry; the caller revokes it when its scan ends.
 */
const GitHubDiscoveryTokenSchema = z.object({
  token: InstallationTokenSchema,
  expires_at: z.string().datetime({ offset: true }).describe(
    "Time GitHub expires the installation token, at most one hour away.",
  ),
}).describe(
  "Selected fields of GitHub's unnarrowed installation token answer; the token is held in memory for one scan only.",
);

/**
 * GitHub's answer to an installation token request narrowed to a selection:
 * the token, its expiry, the permissions GitHub granted and the covered
 * repository ids. Nothing here is stored or logged.
 */
const GitHubInstallationTokenSchema = z.object({
  token: InstallationTokenSchema,
  expires_at: z.string().datetime({ offset: true }).describe(
    "Time GitHub expires the installation token, at most one hour away.",
  ),
  permissions: z.record(
    z.string().min(1).max(64).describe("GitHub App permission scope name."),
    PermissionLevelSchema,
  ).describe("Permissions GitHub granted the token."),
  repositories: z.array(
    z.object({
      id: PositiveIdSchema.describe("Numeric id of a covered repository."),
    }).describe("One repository the token covers; other fields dropped."),
  ).max(500).describe("Repositories the narrowed token covers."),
}).describe(
  "Selected fields of GitHub's installation token response; the token never leaves memory.",
);

/** One page of `GET /installation/repositories` read with an installation token. */
const GitHubTokenRepositoryPageSchema = z.object({
  total_count: z.number().int().nonnegative().describe(
    "Total repositories the installation token can access.",
  ),
  repositories: z.array(
    z.object({
      id: PositiveIdSchema.describe("Numeric id of an accessible repository."),
    }).describe("One repository the token can access; other fields dropped."),
  ).max(100).describe("One page of repositories the token can access."),
}).describe(
  "Selected fields of one page of GET /installation/repositories; only repository ids are kept.",
);

/** Items per issue or check-run list page Bakery asks GitHub for. */
export const GITHUB_READ_PAGE_SIZE = 50;
/** At most this many label names are kept for one issue. */
export const GITHUB_MAX_LABELS = 50;
/** Each kept label name is cut to this many characters. */
export const GITHUB_MAX_LABEL_LENGTH = 50;
/** Check run names are cut to this many characters. */
const MAX_CHECK_RUN_NAME_LENGTH = 255;
/** A page of 50 issues with their bodies runs to several MiB; the bodies are dropped. */
const MAX_READ_PAGE_BYTES = 4_194_304;
/** One issue, pull request or repository read. */
const MAX_SINGLE_READ_BYTES = 1_048_576;

const GitHubTimestampSchema = z.string().datetime({ offset: true }).describe(
  "ISO 8601 timestamp GitHub reports for an object, with a UTC offset, at one-second resolution.",
);

const GitHubCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/).describe(
  "Lowercase 40-character hexadecimal Git commit SHA.",
);

/** The bare label names, at most GITHUB_MAX_LABELS of GITHUB_MAX_LABEL_LENGTH characters. */
function boundedLabelNames(
  labels: readonly (string | { name: string })[],
): string[] {
  return labels.slice(0, GITHUB_MAX_LABELS).map((label) =>
    (typeof label === "string" ? label : label.name).slice(
      0,
      GITHUB_MAX_LABEL_LENGTH,
    )
  );
}

/** The labels of an issue list item or issue read, as names or label objects. */
const GitHubIssueLabelsSchema = z.array(
  z.union([
    z.string().describe("A label name sent as a bare string."),
    z.object({
      name: z.string().describe("Name of the label."),
    }).describe("A label object; every field except its name is dropped."),
  ]).describe("One label of the issue, as a name or an object."),
).describe("Labels on the issue; reduced to bounded names.");

/**
 * True when an issue list or issue read item is really a pull request: GitHub
 * marks those with a `pull_request` key and omits it on plain issues. Key
 * presence decides, whatever the value, so a pull request is never admitted
 * as an issue.
 */
export function isPullRequestItem(issueItem: object): boolean {
  return Object.hasOwn(issueItem, "pull_request");
}

/**
 * One item of GitHub's issue list or one issue read. GitHub lists pull
 * requests as issues, marked by a `pull_request` key; that key makes the item
 * `pull_request`, never a ticket. Bodies, titles, authors and URLs are
 * dropped; labels are reduced to bounded names.
 */
const GitHubIssueSchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub id of the issue item."),
  number: PositiveIdSchema.describe("Issue number within its repository."),
  state: z.enum(["open", "closed"]).describe("Whether the issue is open."),
  updated_at: GitHubTimestampSchema.describe(
    "Time GitHub last updated the issue; the ordering key of the issue list.",
  ),
  labels: GitHubIssueLabelsSchema,
  locked: z.boolean().describe("Whether the conversation is locked."),
  state_reason: z.string().max(64).nullable().optional().describe(
    "Why the issue is in its state, such as completed or not_planned; null or absent when none.",
  ),
  pull_request: z.object({}).nullable().optional().describe(
    "Present, under any value, only when the item is a pull request listed as an issue.",
  ),
}).describe(
  "Selected fields of one GitHub issue list item; unknown fields, the body and the title are dropped.",
).transform((wire) => ({
  kind: isPullRequestItem(wire) ? "pull_request" as const : "issue" as const,
  id: wire.id,
  number: wire.number,
  state: wire.state,
  updatedAt: wire.updated_at,
  labels: boundedLabelNames(wire.labels),
  locked: wire.locked,
  stateReason: wire.state_reason ?? null,
})).describe(
  "Issue or pull request item identity, state, update time and bounded labels.",
);
export type GitHubIssueItem = z.output<typeof GitHubIssueSchema>;

const GitHubIssuePageSchema = z.array(GitHubIssueSchema).max(100).describe(
  "One page of GET /repos/{owner}/{repo}/issues.",
);

const GitHubPullRequestSchema = z.object({
  number: PositiveIdSchema.describe(
    "Pull request number within its repository.",
  ),
  state: z.enum(["open", "closed"]).describe(
    "Whether the pull request is open.",
  ),
  merged: z.boolean().describe("Whether the pull request was merged."),
  merge_commit_sha: GitHubCommitShaSchema.nullable().optional().describe(
    "Merge commit of a merged pull request; for an open one GitHub reports a test merge commit instead.",
  ),
  updated_at: GitHubTimestampSchema.describe(
    "Time GitHub last updated the pull request.",
  ),
  html_url: z.string().url().max(2048).describe(
    "Web page of the pull request on GitHub.",
  ),
  head: z.object({
    sha: GitHubCommitShaSchema.describe("Commit at the head of the branch."),
  }).describe("Head branch of the pull request; other fields are dropped."),
  base: z.object({
    sha: GitHubCommitShaSchema.describe("Commit at the base of the branch."),
  }).describe("Base branch of the pull request; other fields are dropped."),
}).describe(
  "Selected fields of GET /repos/{owner}/{repo}/pulls/{number}; unknown fields, the body and the title are dropped.",
).transform((wire) => ({
  number: wire.number,
  state: wire.state,
  merged: wire.merged,
  headSha: wire.head.sha,
  baseSha: wire.base.sha,
  // Only a merged pull request has a merge commit worth recording.
  mergedSha: wire.merged ? wire.merge_commit_sha ?? null : null,
  updatedAt: wire.updated_at,
  url: wire.html_url,
})).describe(
  "Pull request number, state, head, base and merge commit SHAs, update time and web URL.",
);
export type GitHubPullRequest = z.output<typeof GitHubPullRequestSchema>;

const GitHubCheckRunSchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub id of the check run."),
  name: z.string().min(1).describe("Name the check run reports."),
  status: z.string().min(1).max(32).describe(
    "Lifecycle of the check run, such as queued, in_progress or completed.",
  ),
  conclusion: z.string().max(32).nullable().optional().describe(
    "Final result of a completed check run; null or absent until it completes.",
  ),
  app: z.object({
    id: PositiveIdSchema.describe("Numeric id of the GitHub App that ran it."),
    slug: z.string().min(1).max(100).describe("Slug of the GitHub App."),
  }).describe("GitHub App that created the check run; other fields dropped.")
    .nullable().optional().describe(
      "GitHub App that created the check run; null or absent once GitHub no longer has the App.",
    ),
  head_sha: GitHubCommitShaSchema.describe("Commit the check run reports on."),
  started_at: GitHubTimestampSchema.nullable().optional().describe(
    "Time the check run started; null or absent before it starts.",
  ),
  completed_at: GitHubTimestampSchema.nullable().optional().describe(
    "Time the check run completed; null or absent before it completes.",
  ),
}).describe(
  "Selected fields of one GitHub check run; unknown fields, the output and the details URL are dropped.",
).transform((wire) => ({
  id: wire.id,
  name: wire.name.slice(0, MAX_CHECK_RUN_NAME_LENGTH),
  status: wire.status,
  conclusion: wire.conclusion ?? null,
  // GitHub reports `app: null` for a run whose creating App was deleted. The
  // run stays in the page with an unknown author (`appId` and `appSlug`
  // null), which a consumer must treat as untrusted, so one such run cannot
  // fail every read of its commit.
  appId: wire.app?.id ?? null,
  appSlug: wire.app?.slug ?? null,
  headSha: wire.head_sha,
  startedAt: wire.started_at ?? null,
  completedAt: wire.completed_at ?? null,
})).describe(
  "Check run identity, status, conclusion, creating App (null when unknown), commit and start and completion times.",
);
/**
 * One check run. `appId` and `appSlug` are null when GitHub no longer has the
 * App that created the run (`app: null` on the wire): an unknown author, to be
 * treated as untrusted.
 */
export type GitHubCheckRun = z.output<typeof GitHubCheckRunSchema>;

const GitHubCheckRunPageSchema = z.object({
  total_count: z.number().int().nonnegative().describe(
    "Total check runs GitHub holds for the commit, across all pages.",
  ),
  check_runs: z.array(GitHubCheckRunSchema).max(100).describe(
    "One page of check runs for the commit.",
  ),
}).describe("One page of GET /repos/{owner}/{repo}/commits/{sha}/check-runs.");

const GitHubRepositoryIdentitySchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub repository id."),
}).describe(
  "The stable numeric id of GET /repos/{owner}/{repo}; every other field is dropped.",
);

/**
 * The repository read asked for its default branch. A separate schema keeps
 * `readRepositoryIdentity` callers that do not ask unaffected by a malformed
 * `default_branch`.
 */
const GitHubRepositoryDefaultBranchSchema = GitHubRepositoryIdentitySchema
  .extend({
    default_branch: z.string().min(1).max(255).describe(
      "Name of the repository's default branch; GitHub caps a branch name at 255 bytes.",
    ),
  }).describe(
    "The stable numeric id and default branch of GET /repos/{owner}/{repo}; every other field is dropped.",
  );

/**
 * One wire byte budget for an issue read with its body: 65,536 characters at
 * four bytes each is 262,144 bytes, doubled for JSON overhead and labels.
 */
export const MAX_ISSUE_DETAIL_BYTES = 524_288;
/** GitHub's issue body ceiling, in Unicode code points. */
export const GITHUB_MAX_ISSUE_BODY_CODE_POINTS = 65_536;
/** An issue title is cut to this many UTF-16 code units. */
export const GITHUB_MAX_ISSUE_TITLE_LENGTH = 500;
/** Items per blocker, issue event or commit pull request page; GitHub's maximum. */
export const GITHUB_LIST_PAGE_SIZE = 100;
/**
 * A page of 100 blockers carries 100 full issues with their bodies; the
 * bodies are dropped, the page is not allowed to grow past this.
 */
const MAX_BLOCKER_PAGE_BYTES = 8_388_608;

const GitHubCountSchema = z.number().int().nonnegative().max(
  Number.MAX_SAFE_INTEGER,
).describe("Non-negative count GitHub reports for a list.");

/** Pattern of a GitHub login Bakery will put into a request path. */
const GitHubCollaboratorLoginSchema = z.string().regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
  "Invalid GitHub login.",
).describe(
  "GitHub user login, 1-39 alphanumerics or hyphens, safe to place in a request path.",
);

/** True when `text` holds more than `limit` Unicode code points; a lone surrogate counts as one. */
function exceedsCodePoints(text: string, limit: number): boolean {
  // A code point is one or two UTF-16 units, so length decides both extremes.
  if (text.length <= limit) return false;
  if (text.length > limit * 2) return true;
  let count = 0;
  for (const _point of text) {
    if (++count > limit) return true;
  }
  return false;
}

/** `text` cut to at most `max` UTF-16 units, never ending inside a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** An issue another object refers to: its repository and number. */
export type GitHubIssueRef = { repositoryFullName: string; number: number };

/** `owner/name` of a `https://api.github.com/repos/{owner}/{name}` URL, else null. */
function repositoryFullNameOfUrl(url: string): string | null {
  const prefix = `${GITHUB_API_ORIGIN}/repos/`;
  if (!url.startsWith(prefix)) return null;
  const name = RepositoryFullNameSchema.safeParse(url.slice(prefix.length));
  return name.success ? name.data : null;
}

/** The issue a `https://api.github.com/repos/{owner}/{name}/issues/{n}` URL names, else null. */
function issueRefOfUrl(url: string): GitHubIssueRef | null {
  const match = /^(.+)\/issues\/([1-9][0-9]{0,14})$/.exec(url);
  if (match === null) return null;
  const repositoryFullName = repositoryFullNameOfUrl(match[1]);
  return repositoryFullName === null
    ? null
    : { repositoryFullName, number: Number(match[2]) };
}

/**
 * One issue read with its body and links. A body over 65,536 code points is
 * reported (`bodyTooLarge`) and no text of it is kept; the title is cut to 500
 * units. `labels` keeps the first GITHUB_MAX_LABELS names; when GitHub listed
 * more, `labelsTruncated` is true and `labels` is only a prefix, so a caller
 * must not read the absence of a label (a hold label above all) from it.
 * `subIssuesTotal`, `blockedByTotal`, `blockingTotal` and `repositoryPrivate`
 * are null when GitHub did not report them, which a caller must read as
 * unknown, never as zero or public.
 */
const GitHubIssueDetailSchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub id of the issue item."),
  number: PositiveIdSchema.describe("Issue number within its repository."),
  state: z.enum(["open", "closed"]).describe("Whether the issue is open."),
  state_reason: z.string().max(64).nullable().optional().describe(
    "Why the issue is in its state, such as completed or not_planned; null or absent when none.",
  ),
  title: z.string().describe(
    "Issue title as GitHub holds it; cut to 500 UTF-16 units before it leaves the client.",
  ),
  body: z.string().nullable().optional().describe(
    "Issue body, up to 65,536 characters; null or absent when empty.",
  ),
  labels: GitHubIssueLabelsSchema,
  locked: z.boolean().describe("Whether the conversation is locked."),
  updated_at: GitHubTimestampSchema.describe(
    "Time GitHub last updated the issue.",
  ),
  pull_request: z.object({}).nullable().optional().describe(
    "Present, under any value, only when the item is a pull request read as an issue.",
  ),
  parent_issue_url: z.string().max(2048).nullable().optional().describe(
    "API URL of the parent issue when this issue is a sub-issue; null or absent when it has none.",
  ),
  sub_issues_summary: z.object({
    total: GitHubCountSchema.describe("Number of sub-issues of this issue."),
  }).nullable().optional().describe(
    "Sub-issue counts; absent when GitHub does not report them for this issue.",
  ),
  issue_dependencies_summary: z.object({
    total_blocked_by: GitHubCountSchema.optional().describe(
      "Number of issues blocking this one.",
    ),
    total_blocking: GitHubCountSchema.optional().describe(
      "Number of issues this one blocks.",
    ),
  }).nullable().optional().describe(
    "Dependency counts; absent when GitHub does not report them for this issue.",
  ),
  repository: z.object({
    private: z.boolean().describe("Whether the repository is private."),
  }).nullable().optional().describe(
    "The repository object, which the single-issue read usually omits.",
  ),
}).describe(
  "Selected fields of GET /repos/{owner}/{repo}/issues/{number} including title, body and links; unknown fields are dropped.",
).transform((wire, ctx) => {
  let parent: GitHubIssueRef | null = null;
  if (wire.parent_issue_url !== null && wire.parent_issue_url !== undefined) {
    parent = issueRefOfUrl(wire.parent_issue_url);
    if (parent === null) {
      ctx.addIssue({
        code: "custom",
        message: "parent_issue_url is not a GitHub issue URL",
      });
      return z.NEVER;
    }
  }
  const body = wire.body ?? "";
  const bodyTooLarge = exceedsCodePoints(
    body,
    GITHUB_MAX_ISSUE_BODY_CODE_POINTS,
  );
  return {
    kind: isPullRequestItem(wire) ? "pull_request" as const : "issue" as const,
    id: wire.id,
    number: wire.number,
    state: wire.state,
    stateReason: wire.state_reason ?? null,
    title: cutText(wire.title, GITHUB_MAX_ISSUE_TITLE_LENGTH),
    body: bodyTooLarge ? "" : body,
    bodyTooLarge,
    labels: boundedLabelNames(wire.labels),
    labelsTruncated: wire.labels.length > GITHUB_MAX_LABELS,
    locked: wire.locked,
    updatedAt: wire.updated_at,
    parent,
    subIssuesTotal: wire.sub_issues_summary?.total ?? null,
    blockedByTotal: wire.issue_dependencies_summary?.total_blocked_by ?? null,
    blockingTotal: wire.issue_dependencies_summary?.total_blocking ?? null,
    repositoryPrivate: wire.repository?.private ?? null,
  };
}).describe(
  "Issue identity, state, bounded title and body, labels with a flag for a cut label list, parent, link counts and repository visibility when reported.",
);
/**
 * One issue or pull request read with its text. `body` is empty when the
 * issue has none or `bodyTooLarge` is true; `parent` is the issue this one is
 * a sub-issue of.
 */
export type GitHubIssueDetail = z.output<typeof GitHubIssueDetailSchema>;

/** One issue another issue is blocked by, with the repository it lives in. */
const GitHubBlockerSchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub id of the blocking issue."),
  number: PositiveIdSchema.describe(
    "Number of the blocking issue within its repository.",
  ),
  state: z.enum(["open", "closed"]).describe(
    "Whether the blocking issue is open.",
  ),
  state_reason: z.string().max(64).nullable().optional().describe(
    "Why the blocking issue is closed, such as completed or not_planned; null or absent when none.",
  ),
  repository_url: z.string().max(2048).optional().describe(
    "API URL of the repository holding the blocking issue; GitHub sends it on every issue.",
  ),
  repository: z.object({
    full_name: RepositoryFullNameSchema,
  }).nullable().optional().describe(
    "The repository object when GitHub includes it; only its full name is read, and only if repository_url is absent.",
  ),
}).describe(
  "Selected fields of one issue of GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by; the body, title and every other field are dropped.",
).transform((wire, ctx) => {
  const repositoryFullName = wire.repository_url !== undefined
    ? repositoryFullNameOfUrl(wire.repository_url)
    : wire.repository?.full_name ?? null;
  if (repositoryFullName === null) {
    ctx.addIssue({
      code: "custom",
      message: "blocker names no valid repository",
    });
    return z.NEVER;
  }
  return {
    id: wire.id,
    number: wire.number,
    state: wire.state,
    stateReason: wire.state_reason ?? null,
    repositoryFullName,
  };
}).describe(
  "Blocking issue id, number, state, close reason and repository full name.",
);
/** One issue blocking another; `repositoryFullName` may differ from the blocked issue's. */
export type GitHubBlocker = z.output<typeof GitHubBlockerSchema>;

const GitHubBlockerPageSchema = z.array(GitHubBlockerSchema).max(
  GITHUB_LIST_PAGE_SIZE,
).describe(
  "One page of GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by.",
);

/** Issue event kinds the client keeps; every other kind is dropped. */
export const GITHUB_ISSUE_EVENT_KINDS = [
  "labeled",
  "unlabeled",
  "closed",
] as const;
export type GitHubIssueEventKind = typeof GITHUB_ISSUE_EVENT_KINDS[number];

const GitHubIssueEventSchema = z.object({
  id: PositiveIdSchema.describe("Numeric GitHub id of the issue event."),
  event: z.enum(GITHUB_ISSUE_EVENT_KINDS).describe(
    "Kind of issue event; only labeled, unlabeled and closed reach this schema.",
  ),
  actor: z.object({
    id: PositiveIdSchema.describe("Numeric GitHub id of the actor."),
    login: z.string().min(1).max(100).describe(
      "Login of the actor; a bot login carries a [bot] suffix.",
    ),
  }).nullable().optional().describe(
    "Who caused the event; null or absent when GitHub names no actor.",
  ),
  label: z.object({
    name: z.string().min(1).describe("Name of the label the event applied."),
  }).nullable().optional().describe(
    "The label of a labeled or unlabeled event; absent on a closed event.",
  ),
  commit_id: GitHubCommitShaSchema.nullable().optional().describe(
    "The commit that closed the issue, on a closed event; null or absent when none closed it.",
  ),
  created_at: GitHubTimestampSchema.describe("Time the event happened."),
}).describe(
  "Selected fields of one labeled, unlabeled or closed issue event; unknown fields are dropped.",
).transform((wire, ctx) => {
  if (wire.event !== "closed" && !wire.label) {
    ctx.addIssue({
      code: "custom",
      message: "label event without a label",
    });
    return z.NEVER;
  }
  return {
    id: wire.id,
    event: wire.event,
    labelName: wire.event === "closed" || !wire.label
      ? null
      : wire.label.name.slice(0, GITHUB_MAX_LABEL_LENGTH),
    actor: wire.actor ?? null,
    commitId: wire.event === "closed" ? wire.commit_id ?? null : null,
    createdAt: wire.created_at,
  };
}).describe(
  "Event id, kind, label name for label events, actor (null when unnamed), closing commit for closed events and time.",
);
/**
 * One labeled, unlabeled or closed event. `actor` is null when GitHub named
 * none; `labelName` is set only on label events and `commitId` only on a
 * closed event that a commit closed.
 */
export type GitHubIssueEvent = z.output<typeof GitHubIssueEventSchema>;

const GitHubIssueEventPageSchema = z.array(
  z.unknown().describe(
    "One raw issue event; kept only when it is a labeled, unlabeled or closed event.",
  ),
).max(GITHUB_LIST_PAGE_SIZE).describe(
  "One page of GET /repos/{owner}/{repo}/issues/{number}/events, reduced to labeled, unlabeled and closed events.",
).transform((entries, ctx) => {
  const kept: GitHubIssueEvent[] = [];
  for (const entry of entries) {
    const kind = typeof entry === "object" && entry !== null
      ? (entry as { event?: unknown }).event
      : undefined;
    if (typeof kind !== "string") {
      ctx.addIssue({ code: "custom", message: "issue event without a kind" });
      return z.NEVER;
    }
    if (!(GITHUB_ISSUE_EVENT_KINDS as readonly string[]).includes(kind)) {
      continue;
    }
    const event = GitHubIssueEventSchema.safeParse(entry);
    if (!event.success) {
      ctx.addIssue({ code: "custom", message: "malformed issue event" });
      return z.NEVER;
    }
    kept.push(event.data);
  }
  return kept;
}).describe(
  "The labeled, unlabeled and closed events of one issue event page, in the order GitHub sent them.",
);

const GitHubCommitPullRequestSchema = z.object({
  number: PositiveIdSchema.describe(
    "Pull request number within its repository.",
  ),
  merged_at: GitHubTimestampSchema.nullable().optional().describe(
    "Time the pull request was merged; null or absent when it was not merged.",
  ),
  merge_commit_sha: GitHubCommitShaSchema.nullable().optional().describe(
    "Merge commit of a merged pull request; for an open one GitHub reports a test merge commit instead.",
  ),
  base: z.object({
    ref: z.string().min(1).max(255).describe(
      "Name of the branch the pull request targets.",
    ),
  }).describe("Base branch of the pull request; other fields are dropped."),
}).describe(
  "Selected fields of one pull request of GET /repos/{owner}/{repo}/commits/{sha}/pulls; unknown fields, the body and the title are dropped.",
).transform((wire) => ({
  number: wire.number,
  // The list items carry no `merged` flag: `merged_at` decides.
  merged: wire.merged_at !== null && wire.merged_at !== undefined,
  mergedAt: wire.merged_at ?? null,
  mergeCommitSha: wire.merged_at ? wire.merge_commit_sha ?? null : null,
  baseRef: wire.base.ref,
})).describe(
  "Pull request number, whether and when it merged, its merge commit and the branch it targets.",
);
/** One pull request that contains a commit; `mergeCommitSha` is null unless it merged. */
export type GitHubCommitPullRequest = z.output<
  typeof GitHubCommitPullRequestSchema
>;

const GitHubCommitPullRequestPageSchema = z.array(
  GitHubCommitPullRequestSchema,
).max(GITHUB_LIST_PAGE_SIZE).describe(
  "One page of GET /repos/{owner}/{repo}/commits/{sha}/pulls.",
);

const GitHubCollaboratorPermissionSchema = z.object({
  permission: z.enum(["admin", "write", "read", "none"]).describe(
    "The user's calculated permission on the repository; organization and repository grants are not told apart.",
  ),
  user: z.object({
    id: PositiveIdSchema.describe("Numeric GitHub id of the user."),
  }).describe("The user asked about; only the id is kept."),
}).describe(
  "Selected fields of GET /repos/{owner}/{repo}/collaborators/{login}/permission; the role name and every other field are dropped.",
).transform((wire) => ({
  kind: "present" as const,
  userId: wire.user.id,
  permission: wire.permission,
})).describe(
  "The user's numeric GitHub id and calculated repository permission.",
);
/** A user's repository permission; `userId` is the user's numeric id, which a caller compares with an event actor's. */
export type GitHubCollaboratorPermission = z.output<
  typeof GitHubCollaboratorPermissionSchema
>;

/**
 * A repository, issue or pull request GitHub no longer serves at the path
 * Bakery asked for: `moved` when GitHub answered 301 or 308 (the repository
 * was renamed or transferred, or the issue was transferred), `gone` when it
 * answered 404 or 410.
 */
export type GitHubReadAbsent = { kind: "gone" } | { kind: "moved" };

/** A GitHub App permission map: scope name to level. */
export type GitHubPermissions = Record<string, "read" | "write" | "admin">;

/** A narrowed installation token GitHub issued; held in memory only. */
export type GitHubInstallationToken = {
  kind: "minted";
  token: string;
  /** Unix milliseconds at which GitHub expires the token. */
  expiresAt: number;
  permissions: GitHubPermissions;
  repositoryIds: number[];
};

/** Repositories per GitHub listing page; GitHub's maximum. */
export const GITHUB_REPOSITORIES_PER_PAGE = 100;
/** GitHub narrows an installation token to at most 500 repositories. */
export const GITHUB_MAX_TOKEN_REPOSITORIES = 500;
/** A full page of GitHub repository objects runs to several hundred KiB. */
const MAX_REPOSITORY_PAGE_BYTES = 4_194_304;

export type GitHubCodeExchange = {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

/** Selected fields of GitHub's `GET /app` response: the App a JWT authenticates as. */
const GitHubAppIdentitySchema = GitHubAppConversionSchema.omit({
  client_secret: true,
  webhook_secret: true,
  pem: true,
}).describe(
  "Selected fields of GitHub's GET /app response; unknown fields are dropped and the response carries no credential.",
);
export type GitHubAppIdentity = z.output<typeof GitHubAppIdentitySchema>;

/** `GET /app` outcome: GitHub named the App, or refused the JWT (401, 403 or 404). */
export type GitHubAppLookup =
  | { kind: "confirmed"; app: GitHubAppIdentity }
  | { kind: "rejected" };

/** Port to the GitHub App endpoints Bakery uses; tests inject a fake fetch. */
export type GitHubAppClient = {
  /** Converts a one-time manifest code into the new App's identity and credentials. */
  convertManifest(
    code: string,
    signal: AbortSignal,
  ): Promise<GitHubAppConversion>;
  /**
   * Exchanges a one-time OAuth code (with its PKCE verifier) for a user access
   * token. A failure after sending leaves the code spent: callers must not retry.
   */
  exchangeCode(
    exchange: GitHubCodeExchange,
    signal: AbortSignal,
  ): Promise<{ accessToken: string }>;
  /** One page of the installations of this App the user token can access. */
  listUserInstallations(
    accessToken: string,
    page: number,
    signal: AbortSignal,
  ): Promise<{ installations: GitHubInstallation[]; hasNext: boolean }>;
  /**
   * One page of an installation's repositories the user token can access,
   * each with that user's own admin permission.
   */
  listUserInstallationRepositories(
    accessToken: string,
    installationId: number,
    page: number,
    signal: AbortSignal,
  ): Promise<{ repositories: GitHubRepository[]; hasNext: boolean }>;
  /** Reads one installation with App authority (an RS256 App JWT). */
  getInstallation(
    request: { appId: number; privateKeyPem: string; installationId: number },
    signal: AbortSignal,
  ): Promise<GitHubInstallation>;
  /**
   * Reads one installation's current state with an RS256 App JWT the caller
   * signed (`GET /app/installations/{id}`). GitHub answering 404 (the
   * installation was deleted, or never belonged to this App) is `absent`;
   * anything else that is not a valid installation, including a rate-limited
   * answer, is DEPENDENCY_UNAVAILABLE and proves nothing about the state.
   */
  readInstallationState(
    request: { jwt: string; installationId: number },
    signal: AbortSignal,
  ): Promise<
    { kind: "present"; installation: GitHubInstallation } | { kind: "absent" }
  >;
  /**
   * Reads the App an RS256 App JWT authenticates as. GitHub refusing the
   * JWT is `rejected`; anything else that is not a valid App is
   * DEPENDENCY_UNAVAILABLE.
   */
  getApp(jwt: string, signal: AbortSignal): Promise<GitHubAppLookup>;
  /**
   * Whether, right now and with App authority, one installation of this App
   * is active and still covers one repository, by their stable numeric ids.
   * It reads the installation (`GET /app/installations/{id}`), then asks for
   * an installation token narrowed to that one repository and metadata read
   * (`POST /app/installations/{id}/access_tokens`); GitHub refuses the token
   * for a repository the installation does not cover. The token is revoked
   * at once (`DELETE /installation/token`) and never returned, stored or
   * logged; a failed revocation leaves it to expire within the hour. False
   * when the installation is gone, suspended or another App's, or does not
   * cover the repository.
   */
  isRepositoryCovered(
    request: {
      appId: number;
      privateKeyPem: string;
      installationId: number;
      repositoryId: number;
    },
    signal: AbortSignal,
  ): Promise<boolean>;
  /**
   * Asks GitHub, with an RS256 App JWT, for an installation token narrowed
   * to these stable repository ids and permissions
   * (`POST /app/installations/{id}/access_tokens`). The caller signs the JWT,
   * so the private key never reaches this client. GitHub refusing the
   * narrowing (an uncovered repository: 422; a removed installation: 404; a
   * suspended one or a permission it lacks: 403 without a rate-limit signal)
   * is `refused`; anything else that is not a valid token is
   * DEPENDENCY_UNAVAILABLE, and a token inside a malformed answer is revoked
   * first. The token is returned to the caller only, never stored or logged.
   */
  mintInstallationToken(
    request: {
      jwt: string;
      installationId: number;
      repositoryIds: readonly number[];
      permissions: GitHubPermissions;
    },
    signal: AbortSignal,
  ): Promise<GitHubInstallationToken | { kind: "refused" }>;
  /**
   * Asks GitHub, with an RS256 App JWT the caller signed, for an unnarrowed
   * installation token holding only `metadata: read`
   * (`POST /app/installations/{id}/access_tokens`), for a rescan of every
   * repository the installation covers. Refusals (404 removed, 403
   * suspended without a rate-limit signal, 422) are `refused`; anything else
   * that is not a valid token is DEPENDENCY_UNAVAILABLE, and a token inside
   * a malformed answer is revoked first. The caller revokes the token when
   * the scan ends; it is never stored or logged.
   */
  mintDiscoveryToken(
    request: { jwt: string; installationId: number },
    signal: AbortSignal,
  ): Promise<{ kind: "minted"; token: string } | { kind: "refused" }>;
  /**
   * Revokes an installation token (`DELETE /installation/token`). Best
   * effort and never throws: an unrevoked token expires within the hour.
   */
  revokeInstallationToken(token: string): Promise<void>;
  /**
   * One page of the repositories an installation token can access
   * (`GET /installation/repositories`): a read-only call that returns only
   * repository ids.
   */
  listInstallationRepositories(
    token: string,
    page: number,
    signal: AbortSignal,
  ): Promise<{ repositoryIds: number[]; hasNext: boolean }>;
  /**
   * One page of 50 items of a repository's issue list
   * (`GET /repos/{owner}/{repo}/issues`), oldest update first. GitHub lists
   * pull requests as issues; they come back as `kind: "pull_request"`. A
   * `since` of ISO 8601 time asks for items updated at or after it (GitHub
   * documents only "after", at one-second resolution). The read token, the
   * `fullName`, `since` and `page` are validated before any request; the
   * token is sent only as the Authorization header and never kept, logged or
   * placed in an error. A rate limit throws GitHubReadFailure with a bounded
   * wait; any other failure, malformed or oversized answer is
   * DEPENDENCY_UNAVAILABLE.
   */
  listRepositoryIssues(
    request: {
      token: string;
      fullName: string;
      state: "open" | "all";
      since?: string;
      page: number;
    },
    signal: AbortSignal,
  ): Promise<{ items: GitHubIssueItem[]; hasNext: boolean }>;
  /**
   * One issue (`GET /repos/{owner}/{repo}/issues/{number}`); a pull request
   * number answers `kind: "pull_request"`. GitHub answering 301 or 308 is
   * `moved`, 404 or 410 is `gone`; neither is proof about the repository, so
   * a caller checks `readRepositoryIdentity` before concluding anything.
   */
  readIssue(
    request: { token: string; fullName: string; number: number },
    signal: AbortSignal,
  ): Promise<GitHubIssueItem | GitHubReadAbsent>;
  /**
   * One pull request (`GET /repos/{owner}/{repo}/pulls/{number}`), with the
   * same `moved` and `gone` meaning as `readIssue`.
   */
  readPullRequest(
    request: { token: string; fullName: string; number: number },
    signal: AbortSignal,
  ): Promise<GitHubPullRequest | GitHubReadAbsent>;
  /**
   * One page of 50 check runs on a commit
   * (`GET /repos/{owner}/{repo}/commits/{sha}/check-runs`). `headSha` is a
   * lowercase 40-character hexadecimal SHA, refused before any request
   * otherwise. `totalCount` is GitHub's count across all pages.
   */
  listCheckRuns(
    request: {
      token: string;
      fullName: string;
      headSha: string;
      page: number;
    },
    signal: AbortSignal,
  ): Promise<{
    checkRuns: GitHubCheckRun[];
    hasNext: boolean;
    totalCount: number;
  }>;
  /**
   * The stable numeric id GitHub holds for a repository name
   * (`GET /repos/{owner}/{repo}`): `present` with the id, `moved` when
   * GitHub answers 301 or 308 (renamed or transferred), `gone` for 404 or
   * 410. A caller compares the id with the id it stored, since a name can be
   * reused by another repository. Only with `withDefaultBranch: true` does a
   * `present` answer also carry `defaultBranch` (and a read without a valid
   * `default_branch` is then DEPENDENCY_UNAVAILABLE); without it the answer
   * is exactly `{ kind, id }`, as before.
   */
  readRepositoryIdentity(
    request: { token: string; fullName: string; withDefaultBranch?: boolean },
    signal: AbortSignal,
  ): Promise<
    { kind: "present"; id: number; defaultBranch?: string } | GitHubReadAbsent
  >;
  /**
   * One issue or pull request with its text and links
   * (`GET /repos/{owner}/{repo}/issues/{number}`): title cut to 500 UTF-16
   * units, body kept up to 65,536 code points (longer sets `bodyTooLarge` and
   * keeps no text), labels, parent, sub-issue and dependency counts. The
   * answer is read up to `MAX_ISSUE_DETAIL_BYTES`. A pull request number
   * answers `kind: "pull_request"`; 301 or 308 is `moved`, 404 or 410 is
   * `gone`, with the same meaning as `readIssue`.
   */
  readIssueDetail(
    request: { token: string; fullName: string; number: number },
    signal: AbortSignal,
  ): Promise<GitHubIssueDetail | GitHubReadAbsent>;
  /**
   * One page of 100 issues blocking an issue
   * (`GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by`),
   * each with the repository it lives in. A missing issue is
   * DEPENDENCY_UNAVAILABLE; a caller reads the issue first.
   */
  listBlockedBy(
    request: { token: string; fullName: string; number: number; page: number },
    signal: AbortSignal,
  ): Promise<{ items: GitHubBlocker[]; hasNext: boolean }>;
  /**
   * One page of 100 events of an issue
   * (`GET /repos/{owner}/{repo}/issues/{number}/events`), reduced to the
   * `labeled`, `unlabeled` and `closed` ones. GitHub documents no order, so
   * a caller sorts. The closing commit of an issue is the `commitId` of its
   * latest `closed` event; the timeline is not used because it lists every
   * comment and a close can sit past its first page. A page may keep fewer
   * than 100 events, so only `hasNext` says whether another page exists.
   */
  listIssueEvents(
    request: { token: string; fullName: string; number: number; page: number },
    signal: AbortSignal,
  ): Promise<{ items: GitHubIssueEvent[]; hasNext: boolean }>;
  /**
   * One page of 100 pull requests that contain a commit
   * (`GET /repos/{owner}/{repo}/commits/{sha}/pulls`). `sha` is a lowercase
   * 40-character hexadecimal SHA, refused before any request otherwise.
   */
  listCommitPullRequests(
    request: { token: string; fullName: string; sha: string; page: number },
    signal: AbortSignal,
  ): Promise<{ items: GitHubCommitPullRequest[]; hasNext: boolean }>;
  /**
   * A user's calculated permission on a repository
   * (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`). `login`
   * must match `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`, refused before any
   * request otherwise. 404 or 410 is `gone` (no such user), 301 or 308 is
   * `moved`.
   */
  readCollaboratorPermission(
    request: { token: string; fullName: string; login: string },
    signal: AbortSignal,
  ): Promise<GitHubCollaboratorPermission | GitHubReadAbsent>;
};

/**
 * Fetch-backed client. The conversion call carries no credential: the
 * one-hour, single-use code is the only authority (GitHub REST
 * `POST /app-manifests/{code}/conversions`). The OAuth exchange authenticates
 * with the registered App's client secret, the installation and repository
 * listings with the user token and the installation read with an App JWT;
 * none of them is ever logged.
 */
export function createFetchGitHubAppClient(
  fetcher: typeof fetch = fetch,
  options: { requestTimeoutMs?: number } = {},
): GitHubAppClient {
  const transport: Transport = {
    fetch: fetcher,
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  };
  const parsed = <T extends z.ZodTypeAny>(schema: T, wire: unknown) => {
    const result = schema.safeParse(wire);
    if (!result.success) {
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    return result.data as z.output<T>;
  };
  /** A request input that fails validation is refused before any request. */
  const refused = () => new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  const positiveInteger = (value: unknown): number => {
    if (
      typeof value !== "number" || !Number.isSafeInteger(value) || value < 1
    ) {
      throw refused();
    }
    return value;
  };
  /**
   * The `/repos/{owner}/{repo}` path of a valid full name. The full name is
   * validated first, and its characters are all ones `encodeURIComponent`
   * leaves alone, so the encoding changes nothing today: it is defence in
   * depth should the schema ever admit a wider alphabet.
   */
  const repositoryPath = (fullName: unknown): string => {
    const name = RepositoryFullNameSchema.safeParse(fullName);
    if (!name.success) throw refused();
    const [owner, repository] = name.data.split("/");
    return `/repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(repository)
    }`;
  };
  /** The Authorization value of a read token; the token is only ever sent. */
  const bearer = (token: unknown): string => {
    if (typeof token !== "string" || token.length < 1 || token.length > 4096) {
      throw refused();
    }
    return `Bearer ${token}`;
  };
  /** Only the presence of rel="next" is read; the provider URL is never followed. */
  const hasNextPage = (link: string | null) =>
    link !== null && /<[^>]*>;\s*rel="next"/.test(link);
  const absent = (status: number): GitHubReadAbsent => ({
    kind: status === 301 || status === 308 ? "moved" : "gone",
  });
  /** Statuses that read as a moved (301, 308) or missing (404, 410) object. */
  const ABSENT_STATUSES = [301, 308, 404, 410] as const;
  return {
    async convertManifest(code, signal) {
      if (!isGitHubManifestCode(code)) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const { body } = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}/app-manifests/${
          encodeURIComponent(code)
        }/conversions`,
        { method: "POST", expectedStatus: 201 },
        signal,
      );
      return parsed(GitHubAppConversionSchema, body);
    },
    async exchangeCode(exchange, signal) {
      if (!isGitHubOAuthCode(exchange.code)) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      // GitHub answers 200 with an `error` member for a refused code, which
      // the schema rejects because access_token is missing.
      const { body } = await readJson(
        transport,
        GITHUB_OAUTH_TOKEN_URL,
        {
          method: "POST",
          expectedStatus: 200,
          accept: "application/json",
          body: {
            client_id: exchange.clientId,
            client_secret: exchange.clientSecret,
            code: exchange.code,
            redirect_uri: exchange.redirectUri,
            code_verifier: exchange.codeVerifier,
          },
        },
        signal,
      );
      return { accessToken: parsed(GitHubOAuthTokenSchema, body).access_token };
    },
    async listUserInstallations(accessToken, page, signal) {
      if (!Number.isSafeInteger(page) || page < 1) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const url = new URL(`${GITHUB_API_ORIGIN}/user/installations`);
      url.searchParams.set("per_page", String(GITHUB_INSTALLATIONS_PER_PAGE));
      url.searchParams.set("page", String(page));
      const { body, link } = await readJson(
        transport,
        url.href,
        {
          method: "GET",
          expectedStatus: 200,
          authorization: `Bearer ${accessToken}`,
        },
        signal,
      );
      return {
        installations: parsed(GitHubInstallationPageSchema, body).installations,
        // Only the presence of rel="next" is read; the provider URL is not
        // followed, so the next request is always built from the page number.
        hasNext: link !== null && /<[^>]*>;\s*rel="next"/.test(link),
      };
    },
    async listUserInstallationRepositories(
      accessToken,
      installationId,
      page,
      signal,
    ) {
      if (
        !Number.isSafeInteger(page) || page < 1 ||
        !Number.isSafeInteger(installationId) || installationId < 1
      ) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const url = new URL(
        `${GITHUB_API_ORIGIN}/user/installations/${installationId}/repositories`,
      );
      url.searchParams.set("per_page", String(GITHUB_REPOSITORIES_PER_PAGE));
      url.searchParams.set("page", String(page));
      const { body, link } = await readJson(
        transport,
        url.href,
        {
          method: "GET",
          expectedStatus: 200,
          authorization: `Bearer ${accessToken}`,
          maxBytes: MAX_REPOSITORY_PAGE_BYTES,
        },
        signal,
      );
      return {
        repositories: parsed(GitHubRepositoryPageSchema, body).repositories,
        // As for installations: only rel="next" is read, never followed.
        hasNext: link !== null && /<[^>]*>;\s*rel="next"/.test(link),
      };
    },
    async getInstallation(request, signal) {
      if (
        !Number.isSafeInteger(request.installationId) ||
        request.installationId < 1
      ) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const jwt = await createGitHubAppJwt(
        request.appId,
        request.privateKeyPem,
      );
      const { body } = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}/app/installations/${request.installationId}`,
        { method: "GET", expectedStatus: 200, authorization: `Bearer ${jwt}` },
        signal,
      );
      return parsed(GitHubInstallationSchema, body);
    },
    async readInstallationState(request, signal) {
      if (
        !Number.isSafeInteger(request.installationId) ||
        request.installationId < 1
      ) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const { body } = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}/app/installations/${request.installationId}`,
        {
          method: "GET",
          expectedStatus: 200,
          absentStatuses: [404],
          authorization: `Bearer ${request.jwt}`,
        },
        signal,
      );
      if (body === null) return { kind: "absent" };
      return {
        kind: "present",
        installation: parsed(GitHubInstallationSchema, body),
      };
    },
    async getApp(jwt, signal) {
      let body: unknown;
      try {
        ({ body } = await readJson(
          transport,
          `${GITHUB_API_ORIGIN}/app`,
          {
            method: "GET",
            expectedStatus: 200,
            authorization: `Bearer ${jwt}`,
            rejectedStatuses: REJECTED_CREDENTIAL_STATUSES,
          },
          signal,
        ));
      } catch (error) {
        if (error instanceof GitHubRejected) return { kind: "rejected" };
        throw error;
      }
      return { kind: "confirmed", app: parsed(GitHubAppIdentitySchema, body) };
    },
    async isRepositoryCovered(request, signal) {
      if (
        !Number.isSafeInteger(request.installationId) ||
        request.installationId < 1 ||
        !Number.isSafeInteger(request.repositoryId) || request.repositoryId < 1
      ) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const jwt = await createGitHubAppJwt(
        request.appId,
        request.privateKeyPem,
      );
      const installationUrl =
        `${GITHUB_API_ORIGIN}/app/installations/${request.installationId}`;
      const read = await readJson(
        transport,
        installationUrl,
        {
          method: "GET",
          expectedStatus: 200,
          absentStatuses: [404],
          authorization: `Bearer ${jwt}`,
        },
        signal,
      );
      if (read.body === null) return false;
      const installation = parsed(GitHubInstallationSchema, read.body);
      if (
        installation.id !== request.installationId ||
        installation.appId !== request.appId || installation.suspended
      ) return false;
      const minted = await readJson(
        transport,
        `${installationUrl}/access_tokens`,
        {
          method: "POST",
          expectedStatus: 201,
          // 422: the installation does not cover the repository; 404: it
          // was removed, 403: it was suspended, after the read. Each fails
          // closed as "not covered"; a rate-limited 403 is a failure.
          absentStatuses: [403, 404, 422],
          authorization: `Bearer ${jwt}`,
          body: {
            repository_ids: [request.repositoryId],
            permissions: { metadata: "read" },
          },
        },
        signal,
      );
      if (minted.body === null) return false;
      // The token is read on its own first, so it is revoked even when the
      // rest of the answer is malformed.
      const token = GitHubTokenOnlySchema.safeParse(minted.body);
      try {
        const covered = parsed(GitHubNarrowedTokenSchema, minted.body);
        return covered.repositories.length === 1 &&
          covered.repositories[0].id === request.repositoryId;
      } finally {
        if (token.success) {
          try {
            // Detached from the caller: a disconnect after GitHub issued
            // the token must not skip its revocation; readJson keeps its
            // own timeout.
            await readJson(
              transport,
              `${GITHUB_API_ORIGIN}/installation/token`,
              {
                method: "DELETE",
                expectedStatus: 204,
                authorization: `Bearer ${token.data.token}`,
              },
              new AbortController().signal,
            );
          } catch {
            // Best effort: the token is metadata-read on one repository,
            // held only here, and expires within the hour.
          }
        }
      }
    },
    async mintInstallationToken(request, signal) {
      if (
        !Number.isSafeInteger(request.installationId) ||
        request.installationId < 1 || request.repositoryIds.length < 1 ||
        request.repositoryIds.length > GITHUB_MAX_TOKEN_REPOSITORIES ||
        request.repositoryIds.some((id) => !Number.isSafeInteger(id) || id < 1)
      ) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const minted = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}/app/installations/${request.installationId}/access_tokens`,
        {
          method: "POST",
          expectedStatus: 201,
          // As for the selection recheck: each fails closed as "refused";
          // a rate-limited 403 is a failure.
          absentStatuses: [403, 404, 422],
          // A rate limit and a timeout keep their kind; GitHub refusing the
          // App JWT itself stays an outage, not a rejected installation token.
          classify: "provider",
          authorization: `Bearer ${request.jwt}`,
          // The answer lists every covered repository in full.
          maxBytes: MAX_REPOSITORY_PAGE_BYTES,
          body: {
            repository_ids: [...request.repositoryIds],
            permissions: { ...request.permissions },
          },
        },
        signal,
      );
      if (minted.body === null) return { kind: "refused" };
      const result = GitHubInstallationTokenSchema.safeParse(minted.body);
      if (result.success) {
        return {
          kind: "minted",
          token: result.data.token,
          expiresAt: Date.parse(result.data.expires_at),
          permissions: result.data.permissions,
          repositoryIds: result.data.repositories.map(({ id }) => id),
        };
      }
      // A malformed answer may still carry a live token: revoke it.
      const token = GitHubTokenOnlySchema.safeParse(minted.body);
      if (token.success) {
        try {
          await readJson(
            transport,
            `${GITHUB_API_ORIGIN}/installation/token`,
            {
              method: "DELETE",
              expectedStatus: 204,
              authorization: `Bearer ${token.data.token}`,
            },
            new AbortController().signal,
          );
        } catch {
          // Best effort: the token was never used and expires within the hour.
        }
      }
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
    },
    async mintDiscoveryToken(request, signal) {
      if (
        !Number.isSafeInteger(request.installationId) ||
        request.installationId < 1
      ) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const minted = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}/app/installations/${request.installationId}/access_tokens`,
        {
          method: "POST",
          expectedStatus: 201,
          absentStatuses: [403, 404, 422],
          authorization: `Bearer ${request.jwt}`,
          body: { permissions: { metadata: "read" } },
        },
        signal,
      );
      if (minted.body === null) return { kind: "refused" };
      const result = GitHubDiscoveryTokenSchema.safeParse(minted.body);
      if (result.success) return { kind: "minted", token: result.data.token };
      const token = GitHubTokenOnlySchema.safeParse(minted.body);
      if (token.success) await this.revokeInstallationToken(token.data.token);
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
    },
    async revokeInstallationToken(token) {
      try {
        await readJson(
          transport,
          `${GITHUB_API_ORIGIN}/installation/token`,
          {
            method: "DELETE",
            expectedStatus: 204,
            authorization: `Bearer ${token}`,
          },
          new AbortController().signal,
        );
      } catch {
        // Best effort: the token expires within the hour.
      }
    },
    async listInstallationRepositories(token, page, signal) {
      if (!Number.isSafeInteger(page) || page < 1) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      const url = new URL(`${GITHUB_API_ORIGIN}/installation/repositories`);
      url.searchParams.set("per_page", String(GITHUB_REPOSITORIES_PER_PAGE));
      url.searchParams.set("page", String(page));
      const { body, link } = await readJson(
        transport,
        url.href,
        {
          method: "GET",
          expectedStatus: 200,
          // A 401 rejects this installation token; a 403 is a permission
          // loss or, with rate-limit evidence, a rate limit.
          classify: "token",
          authorization: `Bearer ${token}`,
          maxBytes: MAX_REPOSITORY_PAGE_BYTES,
        },
        signal,
      );
      return {
        repositoryIds: parsed(GitHubTokenRepositoryPageSchema, body)
          .repositories.map(({ id }) => id),
        // Only rel="next" is read, never followed.
        hasNext: link !== null && /<[^>]*>;\s*rel="next"/.test(link),
      };
    },
    async listRepositoryIssues(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const page = positiveInteger(request.page);
      if (request.state !== "open" && request.state !== "all") throw refused();
      if (
        request.since !== undefined &&
        !GitHubTimestampSchema.safeParse(request.since).success
      ) throw refused();
      const url = new URL(`${GITHUB_API_ORIGIN}${path}/issues`);
      url.searchParams.set("per_page", String(GITHUB_READ_PAGE_SIZE));
      url.searchParams.set("state", request.state);
      url.searchParams.set("sort", "updated");
      url.searchParams.set("direction", "asc");
      if (request.since !== undefined) {
        url.searchParams.set("since", request.since);
      }
      url.searchParams.set("page", String(page));
      const { body, link } = await readJson(
        transport,
        url.href,
        {
          method: "GET",
          expectedStatus: 200,
          classify: "token",
          authorization,
          maxBytes: MAX_READ_PAGE_BYTES,
        },
        signal,
      );
      return {
        items: parsed(GitHubIssuePageSchema, body),
        hasNext: hasNextPage(link),
      };
    },
    async readIssue(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const number = positiveInteger(request.number);
      const { body, status } = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}${path}/issues/${encodeURIComponent(number)}`,
        {
          method: "GET",
          expectedStatus: 200,
          absentStatuses: ABSENT_STATUSES,
          classify: "token",
          authorization,
          maxBytes: MAX_SINGLE_READ_BYTES,
        },
        signal,
      );
      return status === 200 ? parsed(GitHubIssueSchema, body) : absent(status);
    },
    async readPullRequest(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const number = positiveInteger(request.number);
      const { body, status } = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}${path}/pulls/${encodeURIComponent(number)}`,
        {
          method: "GET",
          expectedStatus: 200,
          absentStatuses: ABSENT_STATUSES,
          classify: "token",
          authorization,
          maxBytes: MAX_SINGLE_READ_BYTES,
        },
        signal,
      );
      return status === 200
        ? parsed(GitHubPullRequestSchema, body)
        : absent(status);
    },
    async listCheckRuns(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const page = positiveInteger(request.page);
      if (
        typeof request.headSha !== "string" ||
        !GitHubCommitShaSchema.safeParse(request.headSha).success
      ) throw refused();
      const url = new URL(
        `${GITHUB_API_ORIGIN}${path}/commits/${
          encodeURIComponent(request.headSha)
        }/check-runs`,
      );
      url.searchParams.set("per_page", String(GITHUB_READ_PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const { body, link } = await readJson(
        transport,
        url.href,
        {
          method: "GET",
          expectedStatus: 200,
          classify: "token",
          authorization,
          maxBytes: MAX_READ_PAGE_BYTES,
        },
        signal,
      );
      const result = parsed(GitHubCheckRunPageSchema, body);
      return {
        checkRuns: result.check_runs,
        hasNext: hasNextPage(link),
        totalCount: result.total_count,
      };
    },
    async readRepositoryIdentity(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const { body, status } = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}${path}`,
        {
          method: "GET",
          expectedStatus: 200,
          absentStatuses: ABSENT_STATUSES,
          classify: "token",
          authorization,
          maxBytes: MAX_SINGLE_READ_BYTES,
        },
        signal,
      );
      if (status !== 200) return absent(status);
      // Only a caller that asks gets the default branch, so a callback that
      // never asked is unaffected by how GitHub spells it.
      if (request.withDefaultBranch === true) {
        const repository = parsed(GitHubRepositoryDefaultBranchSchema, body);
        return {
          kind: "present",
          id: repository.id,
          defaultBranch: repository.default_branch,
        };
      }
      return {
        kind: "present",
        id: parsed(GitHubRepositoryIdentitySchema, body).id,
      };
    },
    async readIssueDetail(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const number = positiveInteger(request.number);
      const { body, status } = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}${path}/issues/${encodeURIComponent(number)}`,
        {
          method: "GET",
          expectedStatus: 200,
          absentStatuses: ABSENT_STATUSES,
          classify: "token",
          authorization,
          maxBytes: MAX_ISSUE_DETAIL_BYTES,
        },
        signal,
      );
      return status === 200
        ? parsed(GitHubIssueDetailSchema, body)
        : absent(status);
    },
    async listBlockedBy(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const number = positiveInteger(request.number);
      const page = positiveInteger(request.page);
      const url = new URL(
        `${GITHUB_API_ORIGIN}${path}/issues/${
          encodeURIComponent(number)
        }/dependencies/blocked_by`,
      );
      url.searchParams.set("per_page", String(GITHUB_LIST_PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const { body, link } = await readJson(
        transport,
        url.href,
        {
          method: "GET",
          expectedStatus: 200,
          classify: "token",
          authorization,
          maxBytes: MAX_BLOCKER_PAGE_BYTES,
        },
        signal,
      );
      return {
        items: parsed(GitHubBlockerPageSchema, body),
        hasNext: hasNextPage(link),
      };
    },
    async listIssueEvents(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const number = positiveInteger(request.number);
      const page = positiveInteger(request.page);
      const url = new URL(
        `${GITHUB_API_ORIGIN}${path}/issues/${
          encodeURIComponent(number)
        }/events`,
      );
      url.searchParams.set("per_page", String(GITHUB_LIST_PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const { body, link } = await readJson(
        transport,
        url.href,
        {
          method: "GET",
          expectedStatus: 200,
          classify: "token",
          authorization,
          maxBytes: MAX_READ_PAGE_BYTES,
        },
        signal,
      );
      return {
        items: parsed(GitHubIssueEventPageSchema, body),
        hasNext: hasNextPage(link),
      };
    },
    async listCommitPullRequests(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const page = positiveInteger(request.page);
      if (
        typeof request.sha !== "string" ||
        !GitHubCommitShaSchema.safeParse(request.sha).success
      ) throw refused();
      const url = new URL(
        `${GITHUB_API_ORIGIN}${path}/commits/${
          encodeURIComponent(request.sha)
        }/pulls`,
      );
      url.searchParams.set("per_page", String(GITHUB_LIST_PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const { body, link } = await readJson(
        transport,
        url.href,
        {
          method: "GET",
          expectedStatus: 200,
          classify: "token",
          authorization,
          maxBytes: MAX_READ_PAGE_BYTES,
        },
        signal,
      );
      return {
        items: parsed(GitHubCommitPullRequestPageSchema, body),
        hasNext: hasNextPage(link),
      };
    },
    async readCollaboratorPermission(request, signal) {
      const authorization = bearer(request.token);
      const path = repositoryPath(request.fullName);
      const login = GitHubCollaboratorLoginSchema.safeParse(request.login);
      if (!login.success) throw refused();
      const { body, status } = await readJson(
        transport,
        `${GITHUB_API_ORIGIN}${path}/collaborators/${
          encodeURIComponent(login.data)
        }/permission`,
        {
          method: "GET",
          expectedStatus: 200,
          absentStatuses: ABSENT_STATUSES,
          classify: "token",
          authorization,
          maxBytes: MAX_SINGLE_READ_BYTES,
        },
        signal,
      );
      return status === 200
        ? parsed(GitHubCollaboratorPermissionSchema, body)
        : absent(status);
    },
  };
}

/**
 * A ten-minute-maximum GitHub App JWT (RS256) from a stored PEM. A key that
 * cannot sign is a dependency failure here: it was validated when stored.
 */
export async function createGitHubAppJwt(
  appId: number,
  privateKeyPem: string,
  now: number = Date.now(),
): Promise<string> {
  try {
    return await signGitHubAppJwt(
      await importGitHubAppPrivateKey(privateKeyPem),
      appId,
      new Date(now),
    );
  } catch {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
}
