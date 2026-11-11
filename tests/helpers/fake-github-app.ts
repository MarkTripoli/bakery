import {
  createFetchGitHubAppClient,
  type GitHubAppClient,
} from "../../apps/server/src/modules/integrations/github-app.ts";

/** Scripted GitHub failures for the installation-token endpoints. */
export type FakeFailureScript =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "quota"
  | "hang";

/**
 * Marks every byte the fake sends with a scripted failure (bodies, headers,
 * abort reasons), so tests can prove none of it leaves Bakery.
 */
export const FAKE_PROVIDER_CANARY = "fake-provider-canary-7f3a9c";

/**
 * How the fake treats the second a `since` names. GitHub documents the issue
 * list filter only as "updated after", so both readings must stay correct.
 */
export type FakeSinceMode = "inclusive" | "exclusive";

/**
 * The repository read routes of the fake a failure can be scripted on. The
 * `issue` route is `GET .../issues/{n}`, which `readIssue` and `readIssueDetail`
 * share.
 */
export type FakeReadRoute =
  | "repository"
  | "issues"
  | "issue"
  | "pull"
  | "check-runs"
  | "blocked-by"
  | "issue-events"
  | "commit-pulls"
  | "collaborator-permission";

/** A scripted failure on a read route: the shared scripts or a plain 502. */
export type FakeReadFailureScript = FakeFailureScript | "server_error";

/** One issue item of a fake repository, pull requests included. */
export type FakeIssue = {
  id: number;
  number: number;
  state: "open" | "closed";
  /** ISO 8601 at one-second resolution, as GitHub reports it. */
  updatedAt: string;
  labels: string[];
  locked: boolean;
  stateReason: string | null;
  /** True for a pull request, which GitHub lists among the issues. */
  pullRequest: boolean;
  /** Orders items that share one second; an edit takes the next value. */
  sequence: number;
};

/** What a test sets on an issue it seeds or edits; the rest is defaulted. */
export type FakeIssueSeed = Partial<
  Omit<FakeIssue, "id" | "sequence">
>;

/** One pull request of a fake repository. */
export type FakePullRequest = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseSha: string;
  mergedSha: string | null;
  updatedAt: string;
};

/** What a test sets on a pull request it seeds; the rest is defaulted. */
export type FakePullRequestSeed = Partial<FakePullRequest>;

/** One check run on a commit of a fake repository. */
export type FakeCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** Null, with `appSlug`, once the creating App is gone: the wire says `app: null`. */
  appId: number | null;
  appSlug: string | null;
  headSha: string;
  startedAt: string | null;
  completedAt: string | null;
};

/**
 * What a test sets on a check run it seeds; the rest is defaulted. Setting
 * `appId` or `appSlug` to null seeds a run whose creating App GitHub no longer
 * has, which the wire reports as `app: null`.
 */
export type FakeCheckRunSeed = Partial<Omit<FakeCheckRun, "headSha">>;

/** The text and links GitHub holds for one issue beyond its list item. */
export type FakeIssueDetail = {
  title: string;
  /** Null when the issue has no body, as GitHub sends it. */
  body: string | null;
  /** API URL of the parent issue, or null when the issue is not a sub-issue. */
  parentIssueUrl: string | null;
  subIssuesTotal: number;
  blockingTotal: number;
  /**
   * Visibility of the `repository` object the wire carries; null leaves the
   * object out, as the single-issue read usually does.
   */
  repositoryPrivate: boolean | null;
};

/** What a test sets on an issue's detail it seeds; the rest is defaulted. */
export type FakeIssueDetailSeed = Partial<FakeIssueDetail>;

/** One issue another issue is blocked by. */
export type FakeBlocker = {
  id: number;
  number: number;
  /** `owner/name` of the repository the blocker lives in. */
  repositoryFullName: string;
  state: "open" | "closed";
  stateReason: string | null;
};

/** What a test sets on a blocker it seeds; the rest is defaulted. */
export type FakeBlockerSeed = Partial<FakeBlocker> & { number: number };

/** One event of an issue, of any kind GitHub lists. */
export type FakeIssueEvent = {
  id: number;
  /** `labeled`, `unlabeled`, `closed`, or any other kind such as `referenced`. */
  event: string;
  /** The label name of a label event. */
  label: string | null;
  /** Null when GitHub names no actor. */
  actor: { id: number; login: string } | null;
  /** The commit that closed the issue, on a closed event. */
  commitId: string | null;
  createdAt: string;
};

/** What a test sets on an event it seeds; the rest is defaulted. */
export type FakeIssueEventSeed =
  & Partial<Omit<FakeIssueEvent, "event">>
  & Pick<FakeIssueEvent, "event">;

/** One pull request that contains a commit, as the commit's pull list shows it. */
export type FakeCommitPull = {
  number: number;
  state: "open" | "closed";
  /** Null for a pull request that is not merged. */
  mergedAt: string | null;
  mergeCommitSha: string | null;
  baseRef: string;
};

/** What a test sets on a commit pull request it seeds; the rest is defaulted. */
export type FakeCommitPullSeed = Partial<FakeCommitPull> & { number: number };

/** A user's permission on a repository. */
export type FakeCollaborator = {
  id: number;
  permission: "admin" | "write" | "read" | "none";
};

/** A random lowercase 40-character hexadecimal commit SHA. */
export function fakeCommitSha(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")
    .slice(0, 40);
}

/** ISO 8601 UTC at one-second resolution, as GitHub reports timestamps. */
export function fakeTimestamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(
    ".000Z",
    "Z",
  );
}

/** One request the fake GitHub API received. */
export type FakeGitHubCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
};

/** The connecting user's own permissions on one repository, as GitHub reports them. */
export type FakeRepositoryPermissions = {
  admin: boolean;
  maintain: boolean;
  push: boolean;
  triage: boolean;
  pull: boolean;
};

/**
 * One repository of a fake installation. `permissions` is what the
 * authorizing user holds; null omits the field, as GitHub may.
 */
export type FakeRepository = {
  id: number;
  name: string;
  private: boolean;
  archived: boolean;
  permissions: FakeRepositoryPermissions | null;
};

/** One installation of a fake App, as GitHub's installation API returns it. */
export type FakeInstallation = {
  id: number;
  appId: number;
  account: { id: number; login: string; type: string };
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  suspendedAt: string | null;
  repositories: FakeRepository[];
};

/** Permission sets by role, as GitHub reports them for the authenticated user. */
export const fakeRepositoryRole = Object.freeze(
  {
    admin: {
      admin: true,
      maintain: true,
      push: true,
      triage: true,
      pull: true,
    },
    maintain: {
      admin: false,
      maintain: true,
      push: true,
      triage: true,
      pull: true,
    },
    write: {
      admin: false,
      maintain: false,
      push: true,
      triage: true,
      pull: true,
    },
    triage: {
      admin: false,
      maintain: false,
      push: false,
      triage: true,
      pull: true,
    },
    read: {
      admin: false,
      maintain: false,
      push: false,
      triage: false,
      pull: true,
    },
  } as const satisfies Record<string, FakeRepositoryPermissions>,
);

let nextRepositoryId = 600_000_000 + Math.floor(Math.random() * 1_000_000);

/**
 * `count` repositories cycling through `roles` (admin first by default), so
 * a multi-page installation mixes administered and other repositories.
 */
export function fakeRepositories(
  count: number,
  roles: (keyof typeof fakeRepositoryRole | null)[] = [
    "admin",
    "write",
    "read",
    "maintain",
    null,
  ],
): FakeRepository[] {
  return Array.from({ length: count }, (_, index) => {
    const role = roles[index % roles.length];
    const id = nextRepositoryId++;
    return {
      id,
      name: `repo-${id}`,
      private: index % 2 === 0,
      archived: index % 7 === 6,
      permissions: role === null ? null : { ...fakeRepositoryRole[role] },
    };
  });
}

function derRead(bytes: Uint8Array, offset: number) {
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let index = 0; index < count; index++) {
      length = (length << 8) | bytes[offset + 2 + index];
    }
    header += count;
  }
  return { tag, start: offset + header, end: offset + header + length };
}

function pem(label: string, der: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...der));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${
    lines.join("\n")
  }\n-----END ${label}-----\n`;
}

/**
 * One real RSA key pair for every fake App that needs App JWTs. The private
 * key is served as PKCS#1 ("RSA PRIVATE KEY"), the format GitHub issues.
 */
export async function generateAppKey() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  // PrivateKeyInfo: SEQUENCE { version, algorithm, OCTET STRING pkcs1 }.
  const outer = derRead(pkcs8, 0);
  const version = derRead(pkcs8, outer.start);
  const algorithm = derRead(pkcs8, version.end);
  const octets = derRead(pkcs8, algorithm.end);
  return {
    pem: pem("RSA PRIVATE KEY", pkcs8.subarray(octets.start, octets.end)),
    pkcs8Pem: pem("PRIVATE KEY", pkcs8),
    publicKey: pair.publicKey,
  };
}

/** Real App signing key shared by fake Apps registered with `pem: fakeAppKey.pem`. */
export const fakeAppKey = await generateAppKey();

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(base64 + "=".repeat((4 - base64.length % 4) % 4)),
    (character) => character.charCodeAt(0),
  );
}

/** Verifies an RS256 App JWT against the fake key; returns its claims or null. */
export async function verifyFakeAppJwt(
  token: string,
): Promise<{ iat: number; exp: number; iss: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(parts[0])),
  );
  if (header.alg !== "RS256" || header.typ !== "JWT") return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    fakeAppKey.publicKey,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...digest)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, "");
}

/** Credentials and identity the fake hands out for one converted manifest code. */
export type FakeGitHubApp = {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
  pem: string;
  ownerLogin: string;
  ownerId: number;
};

/** An existing App the fake knows, with the key pair GitHub would hold. */
export type FakeExistingApp = FakeGitHubApp & {
  /** GitHub's PKCS#1 download (`BEGIN RSA PRIVATE KEY`). */
  pkcs1Pem: string;
  /** The same key as PKCS#8 (`BEGIN PRIVATE KEY`). */
  pkcs8Pem: string;
  publicKey: CryptoKey;
};

/** Claims of a `GET /app` JWT the fake verified, for provider assertions. */
export type FakeVerifiedJwt = {
  header: Record<string, unknown>;
  payload: { iat: number; exp: number; iss: string };
};

/**
 * In-memory stand-in for GitHub: manifest conversions, the OAuth token
 * exchange (PKCE checked, codes single-use), paged `GET /user/installations`
 * and `GET /user/installations/{id}/repositories` (each repository carrying
 * the authorizing user's own permissions), App-JWT
 * `GET /app/installations/{id}`, narrowed
 * `POST /app/installations/{id}/access_tokens`, installation-token
 * `GET /installation/repositories` and `DELETE /installation/token`. Every request is logged so tests
 * can assert that a refused callback made no GitHub call. No test reaches
 * real GitHub. `requestTimeoutMs` shortens the client's per-request deadline
 * so a scripted hang times out quickly.
 *
 * It also serves the repository reads an installation token makes
 * (`GET /repos/{owner}/{repo}`, `/issues`, `/issues/{number}`,
 * `/issues/{number}/events`, `/issues/{number}/dependencies/blocked_by`,
 * `/pulls/{number}`, `/commits/{sha}/check-runs`, `/commits/{sha}/pulls` and
 * `/collaborators/{login}/permission`), seeded per repository
 * id. Like GitHub it needs a token minted for that repository (404 otherwise)
 * with the permission the route needs (403 otherwise), pages with `Link`
 * headers, lists pull requests among the issues with a `pull_request` key,
 * and moves an edited issue to the end of the `updated` ascending order.
 * `sinceMode` (default inclusive) sets whether `since` includes the second it
 * names.
 */
export function createFakeGitHubApp(
  options: { requestTimeoutMs?: number; sinceMode?: FakeSinceMode } = {},
) {
  const calls: FakeGitHubCall[] = [];
  const codes = new Map<string, FakeGitHubApp>();
  let nextId = 900_000 + Math.floor(Math.random() * 90_000);
  const existingApps = new Map<number, FakeExistingApp>();
  const verifiedJwts: FakeVerifiedJwt[] = [];
  let appLookupStatus: number | null = null;
  /** Registers an App GitHub knows, with its own key pair, for `GET /app`. */
  const createExistingApp = async (
    overrides: Partial<FakeGitHubApp> = {},
  ): Promise<FakeExistingApp> => {
    const id = overrides.id ?? nextId++;
    const marker = crypto.randomUUID().replaceAll("-", "");
    const key = await generateAppKey();
    const app: FakeExistingApp = {
      id,
      slug: `bakery-existing-${id}`,
      name: `Bakery Existing ${id}`,
      clientId: `Iv23li${marker.slice(0, 14)}`,
      clientSecret: `client-secret-${marker}`,
      webhookSecret: `webhook-secret-${marker}`,
      ownerLogin: "bakery-owner",
      ownerId: 4242,
      ...overrides,
      pem: key.pem,
      pkcs1Pem: key.pem,
      pkcs8Pem: key.pkcs8Pem,
      publicKey: key.publicKey,
    };
    existingApps.set(id, app);
    return app;
  };
  /** Answers every later `GET /app` with this status (null restores verification). */
  const failAppLookups = (status: number | null) => {
    appLookupStatus = status;
  };
  let heldAppLookup: { arrived: () => void; released: Promise<void> } | null =
    null;
  /**
   * Holds the next `GET /app` until `release` is called; `arrived` resolves
   * once that lookup is in flight, so a test can order a second request.
   */
  const holdNextAppLookup = () => {
    let release = () => {};
    let arrived = () => {};
    const inFlight = new Promise<void>((resolve) => arrived = resolve);
    heldAppLookup = {
      arrived,
      released: new Promise<void>((resolve) => release = resolve),
    };
    return { inFlight, release };
  };
  /** Verifies a `GET /app` RS256 JWT against the issuing App's key; null means 401. */
  const verifyAppJwt = async (authorization: string | null) => {
    const token =
      /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/
        .exec(authorization ?? "");
    if (!token) return null;
    try {
      const header = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(token[1])),
      );
      const payload = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(token[2])),
      );
      const app = existingApps.get(Number(payload.iss));
      const now = Math.floor(Date.now() / 1000);
      if (
        !app || header.alg !== "RS256" || typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" || payload.exp <= now ||
        payload.iat > now + 60 || payload.exp - payload.iat > 600
      ) return null;
      const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        app.publicKey,
        base64UrlDecode(token[3]),
        new TextEncoder().encode(`${token[1]}.${token[2]}`),
      );
      if (!valid) return null;
      verifiedJwts.push({ header, payload });
      return app;
    } catch {
      return null;
    }
  };
  const issueCode = (overrides: Partial<FakeGitHubApp> = {}) => {
    const id = nextId++;
    const marker = crypto.randomUUID().replaceAll("-", "");
    const app: FakeGitHubApp = {
      id,
      slug: `bakery-test-${id}`,
      name: `Bakery Test ${id}`,
      clientId: `Iv23li${marker.slice(0, 14)}`,
      clientSecret: `client-secret-${marker}`,
      webhookSecret: `webhook-secret-${marker}`,
      pem:
        `-----BEGIN RSA PRIVATE KEY-----\nprivate-key-${marker}\n-----END RSA PRIVATE KEY-----\n`,
      ownerLogin: "bakery-owner",
      ownerId: 4242,
      ...overrides,
    };
    const code = `code-${crypto.randomUUID()}`;
    codes.set(code, app);
    return { code, app };
  };
  let barrier: { size: number; arrived: number; release: () => void } | null =
    null;
  let released: Promise<void> = Promise.resolve();
  /** Holds every request until `size` of them are in flight, to force races. */
  const holdConversions = (size: number) => {
    let release = () => {};
    released = new Promise<void>((resolve) => release = resolve);
    barrier = { size, arrived: 0, release };
  };
  /** Apps by client id, as GitHub knows them once their manifest converted. */
  const apps = new Map<string, FakeGitHubApp>();
  const installations = new Map<number, FakeInstallation>();
  let nextInstallationId = 50_000_000 + Math.floor(Math.random() * 1_000_000);
  /** Adds an installation of `app`; it is reachable only through a user grant. */
  const addInstallation = (
    app: FakeGitHubApp,
    overrides: Partial<FakeInstallation> = {},
  ): FakeInstallation => {
    const installation: FakeInstallation = {
      id: nextInstallationId++,
      appId: app.id,
      account: {
        id: 7_000_000 + Math.floor(Math.random() * 1_000_000),
        login: `bakery-org-${crypto.randomUUID().slice(0, 8)}`,
        type: "Organization",
      },
      repositorySelection: "selected",
      permissions: { metadata: "read", contents: "write", issues: "write" },
      suspendedAt: null,
      repositories: [],
      ...overrides,
    };
    installations.set(installation.id, installation);
    return installation;
  };
  type Grant = {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    installationIds: number[];
  };
  const oauthCodes = new Map<string, Grant>();
  const userTokens = new Map<string, number[]>();
  /** Every access and refresh token handed out, for leak assertions. */
  const issuedTokens: string[] = [];
  /** Installations returned per listing page; GitHub's own maximum is 100. */
  const listing = { pageSize: 100 };
  /** Repositories returned per listing page; GitHub's own maximum is 100. */
  const repositoryListing = { pageSize: 100 };
  const failures = {
    exchange: null as "lost" | "refused" | null,
    listing: false,
    /** Installation ids whose repository listing answers 502. */
    repositories: new Set<number>(),
    /** Installation ids whose installation token request answers 502. */
    tokens: new Set<number>(),
    /** Installation ids whose installation token request is rate limited (403). */
    rateLimited: new Set<number>(),
    /** Installation ids whose token answer carries a token but a malformed expiry. */
    malformedTokens: new Set<number>(),
    /** Installation ids whose tokens are granted every permission at read only. */
    downgraded: new Set<number>(),
    /** Installation ids whose `GET /installation/repositories` answers 502. */
    tokenListing: new Set<number>(),
    /** Installation ids whose `GET /installation/repositories` answers a malformed page. */
    malformedListing: new Set<number>(),
    /**
     * Scripted `GET /installation/repositories` failures by installation id,
     * for every token: `unauthorized` 401, `forbidden` 403 without rate-limit
     * evidence, `rate_limited` 403 with `x-ratelimit-remaining: 0` and a
     * reset two minutes out, `quota` 429 with `Retry-After: 30`, `hang`
     * never answers until the request aborts. Each body and header carries
     * FAKE_PROVIDER_CANARY.
     */
    tokenListingScripts: new Map<number, FakeFailureScript>(),
    /** Scripted `POST /app/installations/{id}/access_tokens` failures. */
    tokenScripts: new Map<number, "quota" | "hang">(),
    /** Installation ids whose App-JWT `GET /app/installations/{id}` answers 502. */
    installationReads: new Set<number>(),
    /**
     * Installation ids whose `GET /installation/repositories` fails from one
     * page on: 429 (rate limited) or 502. Earlier pages answer normally, so a
     * scan fails midway.
     */
    listingFailsAt: new Map<number, { page: number; status: 429 | 502 }>(),
  };
  /** Installations `setInstallationState` deleted, so a test can restore one. */
  const deletedInstallations = new Map<number, FakeInstallation>();
  /**
   * Moves an installation as GitHub would: `suspended` sets `suspended_at`,
   * `active` clears it, `deleted` removes the installation (every later App
   * read or token request answers 404). A deleted one set back to active or
   * suspended returns, so a test can stage an answer GitHub gave earlier.
   */
  const setInstallationState = (
    id: number,
    state: "active" | "suspended" | "deleted",
  ) => {
    const installation = installations.get(id) ?? deletedInstallations.get(id);
    if (!installation) throw new Error(`unknown fake installation ${id}`);
    if (state === "deleted") {
      installations.delete(id);
      deletedInstallations.set(id, installation);
    } else {
      deletedInstallations.delete(id);
      installations.set(id, installation);
      installation.suspendedAt = state === "suspended"
        ? "2026-10-28T00:00:00Z"
        : null;
    }
  };
  /** App-JWT installation state reads that reached the fake. */
  const installationReads = () =>
    calls.filter((call) =>
      call.method === "GET" &&
      /^https:\/\/api\.github\.com\/app\/installations\/[0-9]+$/.test(call.url)
    );
  /**
   * The user approves `clientId` with the PKCE challenge from Bakery's
   * authorization URL; the code later lists `installationIds`.
   */
  const authorize = (grant: {
    authorizationUrl: string;
    installationIds: number[];
  }): string => {
    const url = new URL(grant.authorizationUrl);
    const code = `oauth-${crypto.randomUUID().replaceAll("-", "")}`;
    oauthCodes.set(code, {
      clientId: url.searchParams.get("client_id")!,
      codeChallenge: url.searchParams.get("code_challenge")!,
      redirectUri: url.searchParams.get("redirect_uri")!,
      installationIds: grant.installationIds,
    });
    return code;
  };
  const toWire = (installation: FakeInstallation) => ({
    id: installation.id,
    node_id: `MDIz_${installation.id}`,
    client_id: [...apps.values()].find((app) => app.id === installation.appId)
      ?.clientId ?? "unknown",
    app_id: installation.appId,
    app_slug: `bakery-test-${installation.appId}`,
    target_id: installation.account.id,
    target_type: installation.account.type,
    account: {
      login: installation.account.login,
      id: installation.account.id,
      type: installation.account.type,
      site_admin: false,
    },
    repository_selection: installation.repositorySelection,
    access_tokens_url:
      `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    repositories_url: "https://api.github.com/installation/repositories",
    html_url: `https://github.com/settings/installations/${installation.id}`,
    permissions: installation.permissions,
    events: [],
    created_at: "2026-10-26T12:00:00Z",
    updated_at: "2026-10-26T12:00:00Z",
    suspended_at: installation.suspendedAt,
    suspended_by: null,
  });
  const exchange = async (request: Request): Promise<Response> => {
    const body = await request.json() as Record<string, string>;
    const grant = oauthCodes.get(body.code);
    oauthCodes.delete(body.code);
    if (failures.exchange === "lost") {
      failures.exchange = null;
      throw new TypeError("connection reset after the code was spent");
    }
    const app = apps.get(body.client_id);
    if (
      failures.exchange === "refused" || !grant || !app ||
      app.clientSecret !== body.client_secret ||
      grant.clientId !== body.client_id ||
      grant.redirectUri !== body.redirect_uri ||
      grant.codeChallenge !== await s256(body.code_verifier ?? "")
    ) {
      failures.exchange = null;
      return Response.json({
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      });
    }
    const accessToken = `ghu_${crypto.randomUUID().replaceAll("-", "")}`;
    const refreshToken = `ghr_${crypto.randomUUID().replaceAll("-", "")}`;
    issuedTokens.push(accessToken, refreshToken);
    userTokens.set(accessToken, grant.installationIds);
    return Response.json({
      access_token: accessToken,
      expires_in: 28_800,
      refresh_token: refreshToken,
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
      scope: "",
    });
  };
  const userInstallations = (request: Request): Response => {
    const token = /^Bearer (.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const ids = token === undefined ? undefined : userTokens.get(token);
    if (ids === undefined) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (failures.listing) {
      return Response.json({ message: "Server Error" }, { status: 502 });
    }
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const visible = ids.map((id) => installations.get(id)).filter((
      installation,
    ): installation is FakeInstallation => installation !== undefined);
    const size = listing.pageSize;
    const slice = visible.slice((page - 1) * size, page * size);
    const last = Math.max(1, Math.ceil(visible.length / size));
    const link = page < last
      ? `<https://api.github.com/user/installations?per_page=100&page=${
        page + 1
      }>; rel="next", <https://api.github.com/user/installations?per_page=100&page=${last}>; rel="last"`
      : null;
    return Response.json(
      {
        total_count: visible.length,
        installations: slice.map(toWire),
      },
      { headers: link === null ? {} : { link } },
    );
  };
  const repositoryWire = (
    installation: FakeInstallation,
    repository: FakeRepository,
  ) => {
    const fullName = `${installation.account.login}/${repository.name}`;
    return {
      id: repository.id,
      node_id: `R_${repository.id}`,
      name: repository.name,
      full_name: fullName,
      private: repository.private,
      owner: {
        login: installation.account.login,
        id: installation.account.id,
        type: installation.account.type,
      },
      html_url: `https://github.com/${fullName}`,
      description: null,
      fork: false,
      url: `https://api.github.com/repos/${fullName}`,
      archived: repository.archived,
      disabled: false,
      visibility: repository.private ? "private" : "public",
      default_branch: "main",
      ...(repository.permissions === null
        ? {}
        : { permissions: repository.permissions }),
    };
  };
  const installationRepositories = (
    request: Request,
    id: number,
  ): Response => {
    const token = /^Bearer (.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const ids = token === undefined ? undefined : userTokens.get(token);
    if (ids === undefined) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const installation = installations.get(id);
    if (!installation || !ids.includes(id)) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (failures.repositories.has(id)) {
      return Response.json({ message: "Server Error" }, { status: 502 });
    }
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const size = repositoryListing.pageSize;
    const all = installation.repositories;
    const slice = all.slice((page - 1) * size, page * size);
    const last = Math.max(1, Math.ceil(all.length / size));
    const base =
      `https://api.github.com/user/installations/${id}/repositories?per_page=100`;
    const link = page < last
      ? `<${base}&page=${
        page + 1
      }>; rel="next", <${base}&page=${last}>; rel="last"`
      : null;
    return Response.json(
      {
        total_count: all.length,
        repository_selection: installation.repositorySelection,
        repositories: slice.map((repository) =>
          repositoryWire(installation, repository)
        ),
      },
      { headers: link === null ? {} : { link } },
    );
  };
  const appInstallation = async (
    request: Request,
    id: number,
  ): Promise<Response> => {
    const jwt = /^Bearer (.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const claims = jwt === undefined ? null : await verifyFakeAppJwt(jwt);
    const now = Math.floor(Date.now() / 1000);
    if (!claims || claims.exp <= now || claims.exp - claims.iat > 600) {
      return Response.json({
        message: "A JSON web token could not be decoded",
      }, { status: 401 });
    }
    const installation = installations.get(id);
    if (!installation || String(installation.appId) !== claims.iss) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (failures.installationReads.has(id)) {
      return Response.json({ message: "Server Error" }, { status: 502 });
    }
    return Response.json(toWire(installation));
  };
  /**
   * What each issued installation token may reach, by token; null
   * repositoryIds is an unnarrowed token that reaches every repository.
   */
  const tokenGrants = new Map<
    string,
    {
      installationId: number;
      repositoryIds: number[] | null;
      permissions: Record<string, string>;
    }
  >();
  /** Claims of every App JWT a token request presented, verified RS256. */
  const tokenJwts: { iat: number; exp: number; iss: string; at: number }[] = [];
  /** Every narrowed installation token GitHub handed out, without the token. */
  const tokenRequests: {
    installationId: number;
    repositoryIds: number[];
    permissions: Record<string, string> | null;
  }[] = [];
  /**
   * App-JWT `POST /app/installations/{id}/access_tokens`: 404 for an unknown
   * or other App's installation, 403 when suspended, 422 when a requested
   * repository id is not one of the installation's repositories.
   */
  const installationToken = async (
    request: Request,
    id: number,
  ): Promise<Response> => {
    const jwt = /^Bearer (.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const claims = jwt === undefined ? null : await verifyFakeAppJwt(jwt);
    const now = Math.floor(Date.now() / 1000);
    if (!claims || claims.exp <= now || claims.exp - claims.iat > 600) {
      return Response.json({
        message: "A JSON web token could not be decoded",
      }, { status: 401 });
    }
    tokenJwts.push({ ...claims, at: now });
    const installation = installations.get(id);
    if (!installation || String(installation.appId) !== claims.iss) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (failures.tokens.has(id)) {
      return Response.json({ message: "Server Error" }, { status: 502 });
    }
    const tokenScript = failures.tokenScripts.get(id);
    if (tokenScript !== undefined) {
      return await scriptedFailure(request, tokenScript);
    }
    if (failures.rateLimited.has(id)) {
      return Response.json({ message: "API rate limit exceeded" }, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
      });
    }
    if (installation.suspendedAt !== null) {
      return Response.json({
        message: "This installation has been suspended",
      }, { status: 403 });
    }
    const body = await request.json() as {
      repository_ids?: number[];
      permissions?: Record<string, string>;
    };
    const narrowed = body.repository_ids !== undefined;
    const requested = body.repository_ids ?? [];
    const covered = requested.map((repositoryId) =>
      installation.repositories.find((repository) =>
        repository.id === repositoryId
      )
    );
    if (covered.some((repository) => repository === undefined)) {
      return Response.json({
        message:
          "There is at least one repository that does not exist or is not accessible to the parent installation.",
      }, { status: 422 });
    }
    const token = `ghs_${crypto.randomUUID().replaceAll("-", "")}`;
    issuedTokens.push(token);
    const granted = body.permissions ?? installation.permissions;
    const grantedPermissions = failures.downgraded.has(id)
      ? Object.fromEntries(
        Object.keys(granted).map((scope) => [scope, "read"]),
      )
      : granted;
    tokenGrants.set(token, {
      installationId: id,
      repositoryIds: narrowed ? requested : null,
      permissions: grantedPermissions,
    });
    tokenRequests.push({
      installationId: id,
      repositoryIds: requested,
      permissions: body.permissions ?? null,
    });
    return Response.json({
      token,
      expires_at: failures.malformedTokens.has(id)
        ? "soon"
        : new Date(Date.now() + 3_600_000).toISOString(),
      permissions: grantedPermissions,
      ...(narrowed
        ? {
          repository_selection: "selected",
          repositories: covered.map((repository) =>
            repositoryWire(installation, repository!)
          ),
        }
        : { repository_selection: installation.repositorySelection }),
    }, { status: 201 });
  };
  /**
   * Installation-token `GET /installation/repositories`: the token's narrowed
   * repositories the installation still covers, paged like GitHub.
   */
  const tokenRepositories = async (request: Request): Promise<Response> => {
    const token = /^Bearer (ghs_.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const grant = token === undefined ? undefined : tokenGrants.get(token);
    const installation = grant === undefined
      ? undefined
      : installations.get(grant.installationId);
    if (
      token === undefined || grant === undefined || !installation ||
      revokedTokens.includes(token)
    ) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (failures.tokenListing.has(installation.id)) {
      return Response.json({ message: "Server Error" }, { status: 502 });
    }
    const script = failures.tokenListingScripts.get(installation.id);
    if (script !== undefined) return await scriptedFailure(request, script);
    if (failures.malformedListing.has(installation.id)) {
      return Response.json({ total_count: "many", repositories: [{}] });
    }
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const failing = failures.listingFailsAt.get(installation.id);
    if (failing !== undefined && page >= failing.page) {
      return failing.status === 429
        ? Response.json({ message: "API rate limit exceeded" }, {
          status: 429,
          headers: { "retry-after": "60" },
        })
        : Response.json({ message: "Server Error" }, { status: 502 });
    }
    const size = repositoryListing.pageSize;
    const all = installation.repositories.filter((repository) =>
      grant.repositoryIds === null ||
      grant.repositoryIds.includes(repository.id)
    );
    const slice = all.slice((page - 1) * size, page * size);
    const last = Math.max(1, Math.ceil(all.length / size));
    const base =
      "https://api.github.com/installation/repositories?per_page=100";
    const link = page < last
      ? `<${base}&page=${
        page + 1
      }>; rel="next", <${base}&page=${last}>; rel="last"`
      : null;
    return Response.json(
      {
        total_count: all.length,
        repository_selection: "selected",
        repositories: slice.map((repository) =>
          repositoryWire(installation, repository)
        ),
      },
      { headers: link === null ? {} : { link } },
    );
  };
  /** Installation tokens revoked through `DELETE /installation/token`. */
  const revokedTokens: string[] = [];
  const revokeToken = (request: Request): Response => {
    const token = /^Bearer (ghs_.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    if (
      token === undefined || !issuedTokens.includes(token) ||
      revokedTokens.includes(token)
    ) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    revokedTokens.push(token);
    return new Response(null, { status: 204 });
  };
  /** A scripted GitHub failure; the canary marks every provider-sent byte. */
  const scriptedFailure = async (
    request: Request,
    script: FakeFailureScript,
  ): Promise<Response> => {
    const headers = { "x-github-request-id": FAKE_PROVIDER_CANARY };
    const message = (text: string) => ({
      message: `${text} ${FAKE_PROVIDER_CANARY}`,
      documentation_url: `https://docs.github.com/${FAKE_PROVIDER_CANARY}`,
    });
    switch (script) {
      case "unauthorized":
        return Response.json(message("Bad credentials"), {
          status: 401,
          headers,
        });
      case "forbidden":
        return Response.json(
          message("Resource not accessible by integration"),
          { status: 403, headers },
        );
      case "rate_limited":
        return Response.json(message("API rate limit exceeded"), {
          status: 403,
          headers: {
            ...headers,
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120),
          },
        });
      case "quota":
        return Response.json(
          message("You have exceeded a secondary rate limit"),
          { status: 429, headers: { ...headers, "retry-after": "30" } },
        );
      case "hang":
        // GitHub never answers: only the client's own deadline ends it.
        return await new Promise<Response>((_, reject) => {
          const abort = () =>
            reject(new DOMException(FAKE_PROVIDER_CANARY, "AbortError"));
          if (request.signal.aborted) abort();
          request.signal.addEventListener("abort", abort, { once: true });
        });
    }
  };
  /** Everything the fake holds about the issues and commits of one repository. */
  type RepositoryReads = {
    issues: Map<number, FakeIssue>;
    pullRequests: Map<number, FakePullRequest>;
    checkRuns: Map<string, FakeCheckRun[]>;
    /** Issue numbers moved to another repository: their path answers 301. */
    transferred: Set<number>;
    /** Issue numbers deleted: their path answers 410. */
    deleted: Set<number>;
    /** Text and links by issue number, for issues a test seeded detail for. */
    details: Map<number, FakeIssueDetail>;
    /** The issues blocking an issue, by issue number. */
    blockedBy: Map<number, FakeBlocker[]>;
    /** Events of an issue in the order GitHub lists them, by issue number. */
    events: Map<number, FakeIssueEvent[]>;
    /** Pull requests containing a commit, by commit SHA. */
    commitPulls: Map<string, FakeCommitPull[]>;
    /** Collaborator permissions by lowercase login. */
    collaborators: Map<string, { login: string } & FakeCollaborator>;
  };
  /** Read state by repository id; created on first use. */
  const repositoryReads = new Map<number, RepositoryReads>();
  /** Former full names (lowercase) by the id of the repository renamed since. */
  const renamedFrom = new Map<string, number>();
  /** Scripted read failures, consumed oldest first by the next matching route. */
  const readFailures: {
    route: FakeReadRoute;
    script: FakeReadFailureScript;
  }[] = [];
  /** Settings of the issue list that tests may change between requests. */
  const issueListing = {
    sinceMode: options.sinceMode ?? ("inclusive" as FakeSinceMode),
  };
  /** The id of the repository the fake moves a transferred issue to. */
  const TRANSFER_TARGET_REPOSITORY_ID = 700_000_001;
  let issueSequence = 0;
  let nextIssueId = 1_200_000_000 + Math.floor(Math.random() * 1_000_000);
  let nextCheckRunId = 3_000_000_000 + Math.floor(Math.random() * 1_000_000);
  let nextEventId = 5_000_000_000 + Math.floor(Math.random() * 1_000_000);

  /** The fake repository with this id and the installation that holds it. */
  const repositoryById = (id: number) => {
    for (
      const installation of [
        ...installations.values(),
        ...deletedInstallations.values(),
      ]
    ) {
      const repository = installation.repositories.find((candidate) =>
        candidate.id === id
      );
      if (repository) return { installation, repository };
    }
    throw new Error(`unknown fake repository ${id}`);
  };
  const fullNameOf = (
    installation: FakeInstallation,
    repository: FakeRepository,
  ) => `${installation.account.login}/${repository.name}`;
  const readsOf = (repositoryId: number): RepositoryReads => {
    repositoryById(repositoryId);
    let reads = repositoryReads.get(repositoryId);
    if (!reads) {
      reads = {
        issues: new Map(),
        pullRequests: new Map(),
        checkRuns: new Map(),
        transferred: new Set(),
        deleted: new Set(),
        details: new Map(),
        blockedBy: new Map(),
        events: new Map(),
        commitPulls: new Map(),
        collaborators: new Map(),
      };
      repositoryReads.set(repositoryId, reads);
    }
    return reads;
  };
  const takenNumbers = (reads: RepositoryReads) => [
    ...reads.issues.keys(),
    ...reads.transferred,
    ...reads.deleted,
  ];
  const latestUpdate = (reads: RepositoryReads) =>
    Math.max(
      0,
      ...[...reads.issues.values()].map((issue) => Date.parse(issue.updatedAt)),
    );

  /**
   * Adds issue items to a repository. Numbers default to the next free one,
   * `updatedAt` to now, `state` to open; `pullRequest: true` adds a pull
   * request item that GitHub lists among the issues.
   */
  const seedIssues = (
    repositoryId: number,
    seeds: FakeIssueSeed[],
  ): FakeIssue[] => {
    const reads = readsOf(repositoryId);
    return seeds.map((seed) => {
      const number = seed.number ?? Math.max(0, ...takenNumbers(reads)) + 1;
      if (takenNumbers(reads).includes(number)) {
        throw new Error(`fake issue ${number} already exists`);
      }
      const issue: FakeIssue = {
        id: nextIssueId++,
        number,
        state: seed.state ?? "open",
        updatedAt: seed.updatedAt ?? fakeTimestamp(Date.now()),
        labels: seed.labels ?? [],
        locked: seed.locked ?? false,
        stateReason: seed.stateReason ?? null,
        pullRequest: seed.pullRequest ?? false,
        sequence: ++issueSequence,
      };
      reads.issues.set(number, issue);
      return issue;
    });
  };
  /**
   * Edits an issue as a user would: GitHub bumps `updated_at` to now (never
   * below the latest update in the repository, so the item always lands last)
   * and the item moves to the end of the `updated` ascending order. `patch`
   * may set the other fields, or `updatedAt` to pin the time.
   */
  const editIssue = (
    repositoryId: number,
    number: number,
    patch: FakeIssueSeed = {},
  ): FakeIssue => {
    const reads = readsOf(repositoryId);
    const issue = reads.issues.get(number);
    if (!issue) throw new Error(`unknown fake issue ${number}`);
    const { number: _number, updatedAt, ...fields } = patch;
    Object.assign(issue, fields);
    issue.updatedAt = updatedAt ??
      fakeTimestamp(Math.max(Date.now(), latestUpdate(reads)));
    issue.sequence = ++issueSequence;
    const pullRequest = reads.pullRequests.get(number);
    if (pullRequest) pullRequest.updatedAt = issue.updatedAt;
    return issue;
  };
  /** Deletes an issue: it leaves the list and its path answers 410. */
  const deleteIssue = (repositoryId: number, number: number) => {
    const reads = readsOf(repositoryId);
    if (!reads.issues.delete(number)) {
      throw new Error(`unknown fake issue ${number}`);
    }
    reads.deleted.add(number);
  };
  /**
   * Transfers an issue to another repository: it leaves the list and its
   * path answers 301 while this repository still exists.
   */
  const transferIssue = (repositoryId: number, number: number) => {
    const reads = readsOf(repositoryId);
    if (!reads.issues.delete(number)) {
      throw new Error(`unknown fake issue ${number}`);
    }
    reads.transferred.add(number);
  };
  /**
   * Adds or replaces a pull request and its item in the issue list, which
   * carries the `pull_request` key. A merged pull request is closed.
   */
  const seedPullRequest = (
    repositoryId: number,
    seed: FakePullRequestSeed = {},
  ): FakePullRequest => {
    const reads = readsOf(repositoryId);
    const merged = seed.merged ?? false;
    const existing = seed.number === undefined
      ? undefined
      : reads.issues.get(seed.number);
    const updatedAt = seed.updatedAt ?? fakeTimestamp(Date.now());
    const state = seed.state ?? (merged ? "closed" : "open");
    const item = existing ??
      seedIssues(repositoryId, [{ number: seed.number, updatedAt, state }])[0];
    item.pullRequest = true;
    item.state = state;
    item.updatedAt = updatedAt;
    item.sequence = ++issueSequence;
    const pullRequest: FakePullRequest = {
      number: item.number,
      state,
      merged,
      headSha: seed.headSha ?? fakeCommitSha(),
      baseSha: seed.baseSha ?? fakeCommitSha(),
      mergedSha: seed.mergedSha ?? (merged ? fakeCommitSha() : null),
      updatedAt,
    };
    reads.pullRequests.set(item.number, pullRequest);
    return pullRequest;
  };
  /** Sets the check runs GitHub holds for one commit, replacing any before. */
  const seedCheckRuns = (
    repositoryId: number,
    headSha: string,
    seeds: FakeCheckRunSeed[],
  ): FakeCheckRun[] => {
    const runs = seeds.map((seed): FakeCheckRun => {
      const status = seed.status ?? "completed";
      const completed = status === "completed";
      const hasApp = seed.appId !== null && seed.appSlug !== null;
      return {
        id: seed.id ?? nextCheckRunId++,
        name: seed.name ?? "ci",
        status,
        conclusion: seed.conclusion === undefined
          ? completed ? "success" : null
          : seed.conclusion,
        appId: hasApp ? seed.appId ?? 15_368 : null,
        appSlug: hasApp ? seed.appSlug ?? "github-actions" : null,
        headSha,
        startedAt: seed.startedAt === undefined
          ? fakeTimestamp(Date.now() - 60_000)
          : seed.startedAt,
        completedAt: seed.completedAt === undefined
          ? completed ? fakeTimestamp(Date.now()) : null
          : seed.completedAt,
      };
    });
    readsOf(repositoryId).checkRuns.set(headSha, runs);
    return runs;
  };
  /**
   * Sets the title, body and links `GET .../issues/{number}` reports for an
   * issue that is already seeded. Unset fields keep their value, or default to
   * the title and body the fake always sent, no parent, no sub-issues, no
   * blocking and no `repository` object.
   */
  const seedIssueDetail = (
    repositoryId: number,
    number: number,
    seed: FakeIssueDetailSeed = {},
  ): FakeIssueDetail => {
    const reads = readsOf(repositoryId);
    if (!reads.issues.has(number)) {
      throw new Error(`unknown fake issue ${number}`);
    }
    const detail: FakeIssueDetail = {
      title: `Issue ${number}`,
      body: `Body of issue ${number}. Private repository text.`,
      parentIssueUrl: null,
      subIssuesTotal: 0,
      blockingTotal: 0,
      repositoryPrivate: null,
      ...reads.details.get(number),
      ...seed,
    };
    reads.details.set(number, detail);
    return detail;
  };
  /**
   * Sets the issues blocking an issue that is already seeded, replacing any
   * before. A blocker defaults to open, in this repository, with the next free
   * id. The issue's `issue_dependencies_summary` counts them.
   */
  const seedBlockedBy = (
    repositoryId: number,
    number: number,
    blockers: FakeBlockerSeed[],
  ): FakeBlocker[] => {
    const reads = readsOf(repositoryId);
    if (!reads.issues.has(number)) {
      throw new Error(`unknown fake issue ${number}`);
    }
    const { installation, repository } = repositoryById(repositoryId);
    const seeded = blockers.map((seed): FakeBlocker => ({
      id: seed.id ?? nextIssueId++,
      number: seed.number,
      repositoryFullName: seed.repositoryFullName ??
        fullNameOf(installation, repository),
      state: seed.state ?? "open",
      stateReason: seed.stateReason ?? null,
    }));
    reads.blockedBy.set(number, seeded);
    return seeded;
  };
  /**
   * Appends an event to an issue that is already seeded, in the order GitHub
   * would list it (the fake keeps insertion order; GitHub documents none). The
   * actor defaults to a plain user, `null` sends no actor, and the time to now.
   */
  const seedIssueEvent = (
    repositoryId: number,
    number: number,
    seed: FakeIssueEventSeed,
  ): FakeIssueEvent => {
    const reads = readsOf(repositoryId);
    if (!reads.issues.has(number)) {
      throw new Error(`unknown fake issue ${number}`);
    }
    const event: FakeIssueEvent = {
      id: seed.id ?? nextEventId++,
      event: seed.event,
      label: seed.label ?? null,
      actor: seed.actor === undefined
        ? { id: 1, login: "octocat" }
        : seed.actor,
      commitId: seed.commitId ?? null,
      createdAt: seed.createdAt ?? fakeTimestamp(Date.now()),
    };
    reads.events.set(number, [...reads.events.get(number) ?? [], event]);
    return event;
  };
  /**
   * Adds a pull request to the pull list of a commit. A pull request with a
   * `mergedAt` is merged and closed, with a generated merge commit unless one
   * is given; without one it is open. The base branch defaults to `main`.
   */
  const seedCommitPull = (
    repositoryId: number,
    sha: string,
    seed: FakeCommitPullSeed,
  ): FakeCommitPull => {
    const reads = readsOf(repositoryId);
    const mergedAt = seed.mergedAt ?? null;
    const pull: FakeCommitPull = {
      number: seed.number,
      state: seed.state ?? (mergedAt === null ? "open" : "closed"),
      mergedAt,
      mergeCommitSha: seed.mergeCommitSha ??
        (mergedAt === null ? null : fakeCommitSha()),
      baseRef: seed.baseRef ?? "main",
    };
    reads.commitPulls.set(sha, [...reads.commitPulls.get(sha) ?? [], pull]);
    return pull;
  };
  /**
   * Sets a user's permission on a repository, replacing any before. A login
   * never seeded answers 404, as GitHub does for a user that does not exist;
   * `permission: "none"` is an existing user with no access.
   */
  const seedCollaborator = (
    repositoryId: number,
    login: string,
    collaborator: FakeCollaborator,
  ) => {
    readsOf(repositoryId).collaborators.set(login.toLowerCase(), {
      login,
      ...collaborator,
    });
  };
  /**
   * Renames a repository: it lists under the new name and its old name
   * answers 301, as GitHub does for a renamed repository.
   */
  const renameRepository = (repositoryId: number, name: string) => {
    const { installation, repository } = repositoryById(repositoryId);
    renamedFrom.set(
      fullNameOf(installation, repository).toLowerCase(),
      repositoryId,
    );
    repository.name = name;
  };
  /**
   * Makes the next request to `route` fail with `script`, `count` times in a
   * row (once by default). Failures are consumed in the order scripted.
   */
  const failNext = (
    route: FakeReadRoute,
    script: FakeReadFailureScript,
    count = 1,
  ) => {
    for (let index = 0; index < count; index++) {
      readFailures.push({ route, script });
    }
  };

  /**
   * What each route needs, as any one of these permission scopes (metadata
   * read, which every token holds, is an empty list). The new ticket-read
   * routes follow GitHub's REST pages and stay on the narrower reading where
   * the pages list alternatives: blockers and issue events need Issues read,
   * commit pull requests need Pull requests read (the page also lists Contents
   * read, which Bakery's read token does not carry), and a collaborator's
   * permission needs only Metadata read. Widen a set only after a live check.
   */
  const READ_SCOPES: Record<FakeReadRoute, readonly string[]> = {
    repository: [],
    issues: ["issues", "pull_requests"],
    issue: ["issues", "pull_requests"],
    pull: ["pull_requests"],
    "check-runs": ["checks"],
    "blocked-by": ["issues"],
    "issue-events": ["issues"],
    "commit-pulls": ["pull_requests"],
    "collaborator-permission": [],
  };
  type ReadTarget = {
    route: FakeReadRoute;
    owner: string;
    name: string;
    /** The issue or pull request number, the commit SHA, or the collaborator login. */
    key: string | null;
  };
  /** The route of a `/repos/...` path, with its path segments decoded. */
  const readTarget = (pathname: string): ReadTarget | null => {
    const parts = pathname.split("/").slice(1);
    if (parts[0] !== "repos" || parts.length < 3) return null;
    let owner: string;
    let name: string;
    let key: string | null = null;
    try {
      [owner, name] = [
        decodeURIComponent(parts[1]),
        decodeURIComponent(parts[2]),
      ];
      if (parts[4] !== undefined) key = decodeURIComponent(parts[4]);
    } catch {
      return null;
    }
    const rest = parts.slice(3);
    if (rest.length === 0) return { route: "repository", owner, name, key };
    if (rest[0] === "issues" && rest.length === 1) {
      return { route: "issues", owner, name, key };
    }
    if (rest[0] === "issues" && rest.length === 2) {
      return { route: "issue", owner, name, key };
    }
    if (
      rest[0] === "issues" && rest.length === 3 && rest[2] === "events"
    ) {
      return { route: "issue-events", owner, name, key };
    }
    if (
      rest[0] === "issues" && rest.length === 4 && rest[2] === "dependencies" &&
      rest[3] === "blocked_by"
    ) {
      return { route: "blocked-by", owner, name, key };
    }
    if (rest[0] === "pulls" && rest.length === 2) {
      return { route: "pull", owner, name, key };
    }
    if (rest[0] === "commits" && rest.length === 3 && rest[2] === "pulls") {
      return { route: "commit-pulls", owner, name, key };
    }
    if (
      rest[0] === "collaborators" && rest.length === 3 &&
      rest[2] === "permission"
    ) {
      return { route: "collaborator-permission", owner, name, key };
    }
    if (
      rest[0] === "commits" && rest.length === 3 && rest[2] === "check-runs"
    ) {
      return { route: "check-runs", owner, name, key };
    }
    return null;
  };
  /** The repository holding this full name now, or renamed from it. */
  const locateRepository = (fullName: string) => {
    const wanted = fullName.toLowerCase();
    for (const installation of installations.values()) {
      for (const repository of installation.repositories) {
        if (fullNameOf(installation, repository).toLowerCase() === wanted) {
          return { installation, repository, renamed: false };
        }
      }
    }
    const renamedId = renamedFrom.get(wanted);
    if (renamedId === undefined) return null;
    return { ...repositoryById(renamedId), renamed: true };
  };
  const notFound = () =>
    Response.json({ message: "Not Found" }, { status: 404 });
  const pageLink = (
    url: URL,
    page: number,
    perPage: number,
    total: number,
  ): Record<string, string> => {
    const last = Math.max(1, Math.ceil(total / perPage));
    if (page >= last) return {};
    const at = (target: number) => {
      const next = new URL(url);
      next.searchParams.set("page", String(target));
      return next.href;
    };
    return {
      link: `<${at(page + 1)}>; rel="next", <${at(last)}>; rel="last"`,
    };
  };
  const pageOf = (url: URL) => {
    const requested = Number(url.searchParams.get("per_page") ?? "30");
    const perPage = Number.isInteger(requested)
      ? Math.min(100, Math.max(1, requested))
      : 30;
    const page = Number(url.searchParams.get("page") ?? "1");
    return { perPage, page: Number.isInteger(page) && page > 0 ? page : 1 };
  };
  const issueWire = (
    installation: FakeInstallation,
    repository: FakeRepository,
    issue: FakeIssue,
    reads: RepositoryReads,
  ) => {
    const base = `https://api.github.com/repos/${
      fullNameOf(installation, repository)
    }`;
    const detail = reads.details.get(issue.number);
    const blockers = reads.blockedBy.get(issue.number) ?? [];
    return {
      id: issue.id,
      node_id: `I_${issue.id}`,
      url: `${base}/issues/${issue.number}`,
      html_url: `https://github.com/${
        fullNameOf(installation, repository)
      }/issues/${issue.number}`,
      number: issue.number,
      state: issue.state,
      state_reason: issue.stateReason,
      title: detail?.title ?? `Issue ${issue.number}`,
      body: detail === undefined
        ? `Body of issue ${issue.number}. Private repository text.`
        : detail.body,
      user: { login: "octocat", id: 1, type: "User" },
      labels: issue.labels.map((name, index) => ({
        id: index + 1,
        node_id: `L_${index + 1}`,
        name,
        color: "ededed",
        default: false,
        description: null,
      })),
      assignees: [],
      locked: issue.locked,
      comments: 0,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: issue.updatedAt,
      closed_at: issue.state === "closed" ? issue.updatedAt : null,
      repository_url: base,
      parent_issue_url: detail?.parentIssueUrl ?? null,
      sub_issues_summary: {
        total: detail?.subIssuesTotal ?? 0,
        completed: 0,
        percent_completed: 0,
      },
      issue_dependencies_summary: {
        blocked_by: blockers.filter((blocker) => blocker.state === "open")
          .length,
        total_blocked_by: blockers.length,
        blocking: 0,
        total_blocking: detail?.blockingTotal ?? 0,
      },
      ...(detail?.repositoryPrivate == null ? {} : {
        repository: { id: repository.id, private: detail.repositoryPrivate },
      }),
      ...(issue.pullRequest
        ? {
          pull_request: {
            url: `${base}/pulls/${issue.number}`,
            html_url: `https://github.com/${
              fullNameOf(installation, repository)
            }/pull/${issue.number}`,
          },
        }
        : {}),
    };
  };
  const listIssues = (
    request: Request,
    installation: FakeInstallation,
    repository: FakeRepository,
    reads: RepositoryReads,
  ): Response => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "open";
    const sort = url.searchParams.get("sort") ?? "created";
    const direction = url.searchParams.get("direction") ?? "desc";
    const since = url.searchParams.get("since");
    const sinceMs = since === null ? null : Date.parse(since);
    if (
      !["open", "closed", "all"].includes(state) ||
      !["created", "updated", "comments"].includes(sort) ||
      !["asc", "desc"].includes(direction) ||
      (sinceMs !== null && Number.isNaN(sinceMs))
    ) {
      return Response.json({ message: "Validation Failed" }, { status: 422 });
    }
    const matching = [...reads.issues.values()].filter((issue) =>
      (state === "all" || issue.state === state) &&
      (sinceMs === null ||
        (issueListing.sinceMode === "inclusive"
          ? Date.parse(issue.updatedAt) >= sinceMs
          : Date.parse(issue.updatedAt) > sinceMs))
    ).sort((left, right) =>
      sort === "updated"
        ? Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
          left.sequence - right.sequence
        : left.number - right.number
    );
    if (direction === "desc") matching.reverse();
    const { perPage, page } = pageOf(url);
    return Response.json(
      matching.slice((page - 1) * perPage, page * perPage).map((issue) =>
        issueWire(installation, repository, issue, reads)
      ),
      { headers: pageLink(url, page, perPage, matching.length) },
    );
  };
  const pullRequestWire = (
    installation: FakeInstallation,
    repository: FakeRepository,
    pull: FakePullRequest,
  ) => ({
    id: 2_000_000_000 + pull.number,
    node_id: `PR_${pull.number}`,
    html_url: `https://github.com/${
      fullNameOf(installation, repository)
    }/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: `Pull request ${pull.number}`,
    body: `Body of pull request ${pull.number}. Private repository text.`,
    merged: pull.merged,
    // GitHub reports a test merge commit for an open pull request too.
    merge_commit_sha: pull.mergedSha ?? fakeCommitSha(),
    created_at: "2026-10-01T00:00:00Z",
    updated_at: pull.updatedAt,
    head: { label: "o:feature", ref: "feature", sha: pull.headSha },
    base: { label: "o:main", ref: "main", sha: pull.baseSha },
  });
  /**
   * The answer for an issue path with nothing to list under it: 404 when the
   * number is unknown, 410 when deleted, 301 when transferred; null when the
   * issue exists.
   */
  const missingIssue = (
    reads: RepositoryReads,
    number: number,
  ): Response | null => {
    if (reads.deleted.has(number)) {
      return Response.json({ message: "This issue was deleted" }, {
        status: 410,
      });
    }
    if (reads.transferred.has(number)) {
      return new Response(null, {
        status: 301,
        headers: {
          location:
            `https://api.github.com/repositories/${TRANSFER_TARGET_REPOSITORY_ID}/issues/${number}`,
        },
      });
    }
    return reads.issues.has(number) ? null : notFound();
  };
  /** A blocker as a full issue object, which is what GitHub lists. */
  const blockerWire = (blocker: FakeBlocker) => {
    const base = `https://api.github.com/repos/${blocker.repositoryFullName}`;
    return {
      id: blocker.id,
      node_id: `I_${blocker.id}`,
      url: `${base}/issues/${blocker.number}`,
      repository_url: base,
      html_url:
        `https://github.com/${blocker.repositoryFullName}/issues/${blocker.number}`,
      number: blocker.number,
      state: blocker.state,
      state_reason: blocker.stateReason,
      title: `Blocker ${blocker.number}`,
      body: `Body of blocker ${blocker.number}. Private repository text.`,
      user: { login: "octocat", id: 1, type: "User" },
      labels: [],
      locked: false,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    };
  };
  const issueEventWire = (
    installation: FakeInstallation,
    repository: FakeRepository,
    event: FakeIssueEvent,
  ) => {
    const base = `https://api.github.com/repos/${
      fullNameOf(installation, repository)
    }`;
    return {
      id: event.id,
      node_id: `IE_${event.id}`,
      url: `${base}/issues/events/${event.id}`,
      actor: event.actor === null
        ? null
        : { ...event.actor, node_id: `U_${event.actor.id}`, type: "User" },
      event: event.event,
      commit_id: event.commitId,
      commit_url: event.commitId === null
        ? null
        : `${base}/commits/${event.commitId}`,
      created_at: event.createdAt,
      ...(event.label === null
        ? {}
        : { label: { name: event.label, color: "ededed" } }),
    };
  };
  const commitPullWire = (
    installation: FakeInstallation,
    repository: FakeRepository,
    pull: FakeCommitPull,
  ) => ({
    id: 2_000_000_000 + pull.number,
    node_id: `PR_${pull.number}`,
    html_url: `https://github.com/${
      fullNameOf(installation, repository)
    }/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: `Pull request ${pull.number}`,
    body: `Body of pull request ${pull.number}. Private repository text.`,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: pull.mergedAt ?? "2026-10-01T00:00:00Z",
    merged_at: pull.mergedAt,
    // The list items carry a test merge commit for an open pull request too.
    merge_commit_sha: pull.mergeCommitSha ?? fakeCommitSha(),
    head: { label: "o:feature", ref: "feature", sha: fakeCommitSha() },
    base: { label: "o:main", ref: pull.baseRef, sha: fakeCommitSha() },
  });
  const collaboratorWire = (
    collaborator: { login: string } & FakeCollaborator,
  ) => ({
    permission: collaborator.permission,
    role_name: collaborator.permission,
    user: {
      login: collaborator.login,
      id: collaborator.id,
      node_id: `U_${collaborator.id}`,
      type: "User",
    },
  });
  /**
   * Installation-token `GET /repos/...` reads. A token must have been minted
   * for the repository: another repository's token, or none, is 404. A
   * suspended installation or a missing permission is 403. A renamed
   * repository's former name answers 301 to the repository id path.
   */
  const repositoryRead = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const token = /^Bearer (ghs_.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const grant = token === undefined ? undefined : tokenGrants.get(token);
    if (
      token === undefined || grant === undefined ||
      revokedTokens.includes(token) || !installations.has(grant.installationId)
    ) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const target = readTarget(url.pathname);
    if (target === null) return notFound();
    const failure = readFailures.findIndex(({ route }) =>
      route === target.route
    );
    if (failure !== -1) {
      const [{ script }] = readFailures.splice(failure, 1);
      return script === "server_error"
        ? Response.json({
          message: `Server Error ${FAKE_PROVIDER_CANARY}`,
        }, { status: 502 })
        : await scriptedFailure(request, script);
    }
    const located = locateRepository(`${target.owner}/${target.name}`);
    if (
      located === null || located.installation.id !== grant.installationId ||
      (grant.repositoryIds !== null &&
        !grant.repositoryIds.includes(located.repository.id))
    ) return notFound();
    const { installation, repository } = located;
    if (installation.suspendedAt !== null) {
      return Response.json({
        message: "This installation has been suspended",
      }, { status: 403 });
    }
    if (located.renamed) {
      const rest = url.pathname.split("/").slice(4).join("/");
      return new Response(null, {
        status: 301,
        headers: {
          location: `https://api.github.com/repositories/${repository.id}${
            rest === "" ? "" : `/${rest}`
          }${url.search}`,
        },
      });
    }
    const scopes = READ_SCOPES[target.route];
    if (
      scopes.length > 0 &&
      !scopes.some((scope) =>
        ["read", "write", "admin"].includes(grant.permissions[scope] ?? "")
      )
    ) {
      return Response.json({
        message: "Resource not accessible by integration",
      }, { status: 403 });
    }
    const reads = readsOf(repository.id);
    const number = target.key === null || !/^[0-9]+$/.test(target.key)
      ? null
      : Number(target.key);
    switch (target.route) {
      case "repository":
        return Response.json(repositoryWire(installation, repository));
      case "issues":
        return listIssues(request, installation, repository, reads);
      case "issue": {
        if (number === null) return notFound();
        if (reads.deleted.has(number)) {
          return Response.json({ message: "This issue was deleted" }, {
            status: 410,
          });
        }
        if (reads.transferred.has(number)) {
          return new Response(null, {
            status: 301,
            headers: {
              location:
                `https://api.github.com/repositories/${TRANSFER_TARGET_REPOSITORY_ID}/issues/${number}`,
            },
          });
        }
        const issue = reads.issues.get(number);
        return issue === undefined
          ? notFound()
          : Response.json(issueWire(installation, repository, issue, reads));
      }
      case "blocked-by": {
        if (number === null) return notFound();
        const missing = missingIssue(reads, number);
        if (missing !== null) return missing;
        const blockers = reads.blockedBy.get(number) ?? [];
        const { perPage, page } = pageOf(url);
        return Response.json(
          blockers.slice((page - 1) * perPage, page * perPage).map((blocker) =>
            blockerWire(blocker)
          ),
          { headers: pageLink(url, page, perPage, blockers.length) },
        );
      }
      case "issue-events": {
        if (number === null) return notFound();
        const missing = missingIssue(reads, number);
        if (missing !== null) return missing;
        const events = reads.events.get(number) ?? [];
        const { perPage, page } = pageOf(url);
        return Response.json(
          events.slice((page - 1) * perPage, page * perPage).map((event) =>
            issueEventWire(installation, repository, event)
          ),
          { headers: pageLink(url, page, perPage, events.length) },
        );
      }
      case "commit-pulls": {
        if (target.key === null || !/^[0-9a-f]{40}$/.test(target.key)) {
          return Response.json({ message: "Validation Failed" }, {
            status: 422,
          });
        }
        const pulls = reads.commitPulls.get(target.key) ?? [];
        const { perPage, page } = pageOf(url);
        return Response.json(
          pulls.slice((page - 1) * perPage, page * perPage).map((pull) =>
            commitPullWire(installation, repository, pull)
          ),
          { headers: pageLink(url, page, perPage, pulls.length) },
        );
      }
      case "collaborator-permission": {
        const collaborator = target.key === null
          ? undefined
          : reads.collaborators.get(target.key.toLowerCase());
        return collaborator === undefined
          ? notFound()
          : Response.json(collaboratorWire(collaborator));
      }
      case "pull": {
        const pull = number === null
          ? undefined
          : reads.pullRequests.get(number);
        return pull === undefined
          ? notFound()
          : Response.json(pullRequestWire(installation, repository, pull));
      }
      case "check-runs": {
        const runs = target.key === null
          ? []
          : reads.checkRuns.get(target.key) ?? [];
        const { perPage, page } = pageOf(url);
        return Response.json({
          total_count: runs.length,
          check_runs: runs.slice((page - 1) * perPage, page * perPage).map((
            run,
          ) => ({
            id: run.id,
            node_id: `CR_${run.id}`,
            name: run.name,
            head_sha: run.headSha,
            status: run.status,
            conclusion: run.conclusion,
            started_at: run.startedAt,
            completed_at: run.completedAt,
            output: { title: null, summary: null, text: null },
            app: run.appId === null || run.appSlug === null
              ? null
              : { id: run.appId, slug: run.appSlug, name: run.appSlug },
          })),
        }, { headers: pageLink(url, page, perPage, runs.length) });
      }
    }
  };
  /** Runs before each request is answered; tests use it to force races. */
  const hooks = {
    beforeResponse: null as ((request: Request) => Promise<void>) | null,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers = Object.fromEntries(request.headers.entries());
    // Installation tokens are credentials: the log keeps only their shape.
    if (/^Bearer ghs_/.test(headers["authorization"] ?? "")) {
      headers["authorization"] = "Bearer ghs_[redacted]";
    }
    calls.push({ method: request.method, url: request.url, headers });
    await hooks.beforeResponse?.(request);
    if (barrier) {
      barrier.arrived += 1;
      if (barrier.arrived >= barrier.size) {
        barrier.release();
        barrier = null;
      }
      await released;
    }
    if (request.url === "https://api.github.com/app") {
      if (heldAppLookup) {
        const held = heldAppLookup;
        heldAppLookup = null;
        held.arrived();
        await held.released;
      }
      if (request.method !== "GET") {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (appLookupStatus !== null) {
        return Response.json({ message: "Unavailable" }, {
          status: appLookupStatus,
        });
      }
      const app = await verifyAppJwt(request.headers.get("authorization"));
      if (!app) {
        return Response.json({
          message: "A JSON web token could not be decoded",
        }, { status: 401 });
      }
      return Response.json({
        id: app.id,
        slug: app.slug,
        node_id: `A_${app.id}`,
        client_id: app.clientId,
        name: app.name,
        description: "",
        external_url: "https://bakery.example.test",
        html_url: `https://github.com/apps/${app.slug}`,
        created_at: "2026-10-26T12:00:00Z",
        updated_at: "2026-10-26T12:00:00Z",
        owner: {
          login: app.ownerLogin,
          id: app.ownerId,
          type: "Organization",
          site_admin: false,
        },
        permissions: { metadata: "read", issues: "write" },
        events: ["issues"],
        installations_count: 1,
      }, { status: 200 });
    }
    if (
      request.method === "POST" &&
      request.url === "https://github.com/login/oauth/access_token"
    ) {
      return await exchange(request);
    }
    if (
      request.method === "GET" &&
      request.url.startsWith("https://api.github.com/user/installations?")
    ) {
      return userInstallations(request);
    }
    const repositoriesMatch =
      /^https:\/\/api\.github\.com\/user\/installations\/([0-9]+)\/repositories\?/
        .exec(request.url);
    if (request.method === "GET" && repositoriesMatch) {
      return installationRepositories(request, Number(repositoriesMatch[1]));
    }
    const installationMatch =
      /^https:\/\/api\.github\.com\/app\/installations\/([0-9]+)$/.exec(
        request.url,
      );
    if (request.method === "GET" && installationMatch) {
      return await appInstallation(request, Number(installationMatch[1]));
    }
    const tokenMatch =
      /^https:\/\/api\.github\.com\/app\/installations\/([0-9]+)\/access_tokens$/
        .exec(request.url);
    if (request.method === "POST" && tokenMatch) {
      return await installationToken(request, Number(tokenMatch[1]));
    }
    if (
      request.method === "DELETE" &&
      request.url === "https://api.github.com/installation/token"
    ) {
      return revokeToken(request);
    }
    if (
      request.method === "GET" &&
      request.url.startsWith(
        "https://api.github.com/installation/repositories?",
      )
    ) {
      return await tokenRepositories(request);
    }
    if (
      request.method === "GET" &&
      request.url.startsWith("https://api.github.com/repos/")
    ) {
      return await repositoryRead(request);
    }
    const match =
      /^https:\/\/api\.github\.com\/app-manifests\/([^/]+)\/conversions$/
        .exec(request.url);
    if (request.method !== "POST" || !match) {
      return Promise.resolve(
        Response.json({ message: "Not Found" }, { status: 404 }),
      );
    }
    const code = decodeURIComponent(match[1]);
    const app = codes.get(code);
    codes.delete(code);
    if (!app) return Response.json({ message: "Not Found" }, { status: 404 });
    apps.set(app.clientId, app);
    return Response.json({
      id: app.id,
      slug: app.slug,
      node_id: `A_${app.id}`,
      name: app.name,
      description: "",
      external_url: "https://bakery.example.test",
      html_url: `https://github.com/apps/${app.slug}`,
      created_at: "2026-10-26T12:00:00Z",
      updated_at: "2026-10-26T12:00:00Z",
      owner: {
        login: app.ownerLogin,
        id: app.ownerId,
        type: "Organization",
        site_admin: false,
      },
      permissions: {
        metadata: "read",
        issues: "write",
        contents: "write",
        pull_requests: "write",
        checks: "write",
      },
      events: [],
      installations_count: 0,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      webhook_secret: app.webhookSecret,
      pem: app.pem,
    }, { status: 201 });
  };
  const client: GitHubAppClient = createFetchGitHubAppClient(fetcher, options);
  return {
    calls,
    fetch: fetcher,
    client,
    issueCode,
    holdConversions,
    conversionCalls: () =>
      calls.filter((call) => call.url.includes("/app-manifests/")),
    addInstallation,
    setInstallationState,
    installationReads,
    authorize,
    listing,
    repositoryListing,
    failures,
    issuedTokens,
    tokenRequests,
    tokenJwts,
    revokedTokens,
    /** Requests that reached the installation-token repository listing. */
    tokenListings: () =>
      calls.filter((call) =>
        call.url.startsWith("https://api.github.com/installation/repositories?")
      ),
    hooks,
    issueListing,
    seedIssues,
    editIssue,
    deleteIssue,
    transferIssue,
    seedPullRequest,
    seedCheckRuns,
    seedIssueDetail,
    seedBlockedBy,
    seedIssueEvent,
    seedCommitPull,
    seedCollaborator,
    renameRepository,
    failNext,
    /** Requests that reached the repository reads (`GET /repos/...`). */
    repositoryReadCalls: () =>
      calls.filter((call) =>
        call.url.startsWith("https://api.github.com/repos/")
      ),
    oauthCalls: () =>
      calls.filter((call) =>
        call.url === "https://github.com/login/oauth/access_token"
      ),
    createExistingApp,
    failAppLookups,
    holdNextAppLookup,
    verifiedJwts,
    appLookups: () =>
      calls.filter((call) => call.url === "https://api.github.com/app"),
  };
}
