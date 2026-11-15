import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";
import { CONNECTION_ID, uuid } from "./projects-fixture.ts";

/** Stubs for one repository's page: its reads, its profile versions, the connection, and what is written. */

const STAMP = "2026-01-01T00:00:00.000Z";
export const REPOSITORY_ID = uuid(250);
export const APPLICATION_ID = uuid(150);

export type Profile = {
  revision: number;
  branches: string[];
  folder?: string;
  /** The version states rules of its own (the Rules page publishes such versions). */
  rules?: boolean;
};

export type Options = {
  role?: "admin" | "developer";
  /** The versions of the working settings, oldest first. */
  profiles?: Profile[];
  /** The number of the version in use (none when absent). */
  active?: number;
  archived?: boolean;
  defaultBranch?: string;
  /** The connection's state; "missing" answers 404. */
  connection?: "enabled" | "revoked" | "missing";
  /** What creating a version answers: ok, a 409 (the number is taken), a server fault, a 428 (rules of its own) or a 400. */
  save?: "ok" | "conflict" | "down" | "rules" | "rejected";
  /** What putting a version in use answers: ok, a 412 whatever the version, or a server fault. */
  use?: "ok" | "conflict" | "down";
  /** The repository read answers this status instead of the repository. */
  repositoryStatus?: 403 | 404 | 500;
  /** Versions per page, to prove every page is read. */
  pageSize?: number;
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/test",
    title: "Problem",
    detail: "Problem.",
    status,
    code,
    retryable: status >= 500,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  }),
});

const profileId = (revision: number) => uuid(3000 + revision);

const configOf = (profile: Profile, base: string) => ({
  schemaVersion: 1,
  workflow: { kind: "fixed" },
  branches: { base, allowedPatterns: profile.branches },
  worktree: { root: profile.folder ?? "." },
  ...(profile.rules ? { repositoryRules: { entries: [] } } : {}),
});

/** Stubs the session, role and every read and write of the repository page; returns what it saw. */
export async function repositoryFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const base = options.defaultBranch ?? "main";
  const profiles = (options.profiles ?? []).map((profile) => ({ ...profile }));
  const state = {
    active: options.active ?? null as number | null,
    version: 1,
    archived: options.archived ?? false,
  };
  const seen = {
    createdProfiles: [] as Record<string, unknown>[],
    createKeys: [] as (string | null)[],
    updates: [] as { ifMatch: string | null; body: Record<string, unknown> }[],
    profileReads: 0,
  };
  const profileBody = (profile: Profile) => ({
    id: profileId(profile.revision),
    repositoryId: REPOSITORY_ID,
    revision: profile.revision,
    config: configOf(profile, base),
    digest: "a".repeat(64),
    createdBy: uuid(1),
    createdAt: `2026-01-0${Math.min(profile.revision, 9)}T00:00:00.000Z`,
    updatedAt: STAMP,
    version: 1,
  });
  const repositoryBody = () => ({
    id: REPOSITORY_ID,
    applicationId: APPLICATION_ID,
    slug: "api-service",
    integrationConnectionId: CONNECTION_ID,
    providerRepoId: "5001",
    owner: "acme",
    name: "api-service",
    defaultBranch: base,
    activeProfileId: state.active === null ? null : profileId(state.active),
    archivedAt: state.archived ? STAMP : null,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: state.version,
  });
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: options.role ?? "admin",
        capabilities: [],
      })),
  );
  await page.route(
    (url) => url.pathname === `/v1/repositories/${REPOSITORY_ID}`,
    (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        if (options.repositoryStatus !== undefined) {
          return route.fulfill(problem(options.repositoryStatus, "TEST"));
        }
        return route.fulfill(json(repositoryBody()));
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      seen.updates.push({
        ifMatch: request.headers()["if-match"] ?? null,
        body,
      });
      // The server answers 412 to a stale version: the page must hold the
      // repository's current one (a first version is put in use by the server
      // itself, which moves the version).
      if (
        options.use === "conflict" ||
        request.headers()["if-match"] !== `"v${state.version}"`
      ) {
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      if (options.use === "down") {
        return route.fulfill(problem(500, "INTERNAL"));
      }
      const wanted = profiles.find((profile) =>
        profileId(profile.revision) === body.activeProfileId
      );
      if (wanted) state.active = wanted.revision;
      state.version += 1;
      return route.fulfill(json(repositoryBody()));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/applications/${APPLICATION_ID}`,
    (route) =>
      route.fulfill(json({
        id: APPLICATION_ID,
        slug: "checkout",
        name: "Checkout",
        description: "The checkout service",
        archivedAt: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      })),
  );
  await page.route(
    (url) => url.pathname === `/v1/integration-connections/${CONNECTION_ID}`,
    (route) => {
      if (options.connection === "missing") {
        return route.fulfill(problem(404, "NOT_FOUND"));
      }
      return route.fulfill(json({
        id: CONNECTION_ID,
        provider: "github",
        label: "acme-org",
        externalAccountId: "7000001",
        config: {},
        secretId: null,
        grantedScopes: { metadata: "read", contents: "write" },
        createdBy: uuid(1),
        status: options.connection ?? "enabled",
        lastCheckedAt: STAMP,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      }));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/repositories/${REPOSITORY_ID}/profiles`,
    (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as {
          revision: number;
          config: {
            branches: { allowedPatterns: string[] };
            worktree: { root: string };
          };
        };
        seen.createdProfiles.push(body as never);
        seen.createKeys.push(request.headers()["idempotency-key"] ?? null);
        if (options.save === "conflict") {
          return route.fulfill(problem(409, "STATE_CONFLICT"));
        }
        if (options.save === "down") {
          return route.fulfill(problem(500, "INTERNAL"));
        }
        if (options.save === "rules") {
          return route.fulfill(problem(428, "PRECONDITION_REQUIRED"));
        }
        if (options.save === "rejected") {
          return route.fulfill(problem(400, "MALFORMED_REQUEST"));
        }
        const created = {
          revision: body.revision,
          branches: body.config.branches.allowedPatterns,
          folder: body.config.worktree.root === "."
            ? undefined
            : body.config.worktree.root,
        };
        profiles.push(created);
        // The server puts the first version of a repository in use itself.
        if (state.active === null) {
          state.active = created.revision;
          state.version += 1;
        }
        return route.fulfill(json(profileBody(created), 201));
      }
      seen.profileReads += 1;
      const url = new URL(request.url());
      const size = options.pageSize ?? 100;
      const offset = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
      return route.fulfill(json({
        items: profiles.slice(offset, offset + size).map(profileBody),
        nextCursor: offset + size < profiles.length
          ? `c${offset + size}`
          : null,
      }));
    },
  );
  return { seen, state, profiles };
}
