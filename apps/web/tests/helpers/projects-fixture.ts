import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

/** Stubs for the Projects list: applications, repositories, the GitHub connection and what is created. */

export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const CONNECTION_ID = uuid(800);
const STAMP = "2026-01-01T00:00:00.000Z";

export type App = {
  id: string;
  name: string;
  slug: string;
  description: string;
  archivedAt: string | null;
  version: number;
};
export type Repo = {
  id: string;
  applicationId: string;
  owner: string;
  name: string;
  providerRepoId: string;
  defaultBranch: string;
  activeProfileId: string | null;
  archivedAt: string | null;
};
export type Offered = { id: string; name: string; selected?: boolean };

export const application = (
  n: number,
  name: string,
  extra: Partial<App> = {},
): App => ({
  id: uuid(100 + n),
  name,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  description: `${name} is a product`,
  archivedAt: null,
  version: 1,
  ...extra,
});
export const repository = (
  n: number,
  applicationId: string,
  name: string,
  extra: Partial<Repo> = {},
): Repo => ({
  id: uuid(200 + n),
  applicationId,
  owner: "acme",
  name,
  providerRepoId: String(5000 + n),
  defaultBranch: "main",
  activeProfileId: null,
  archivedAt: null,
  ...extra,
});

export type Options = {
  role?: "admin" | "developer";
  applications?: App[];
  repositories?: Repo[];
  /** Repositories the GitHub connection offers; null means no connection. */
  offered?: Offered[] | null;
  /** What creating a repository answers: ok, or a 409 without a reason. */
  create?: "ok" | "conflict";
  pageSize?: number;
};

const applicationBody = (app: App) => ({
  id: app.id,
  slug: app.slug,
  name: app.name,
  description: app.description,
  archivedAt: app.archivedAt,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: app.version,
});
const repositoryBody = (repo: Repo) => ({
  id: repo.id,
  applicationId: repo.applicationId,
  slug: repo.name.toLowerCase(),
  integrationConnectionId: CONNECTION_ID,
  providerRepoId: repo.providerRepoId,
  owner: repo.owner,
  name: repo.name,
  defaultBranch: repo.defaultBranch,
  activeProfileId: repo.activeProfileId,
  archivedAt: repo.archivedAt,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
});
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** Stubs the session, role and every read and write of the Projects page; returns what it saw. */
export async function projectsFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  // Copies: the handlers change what they hold, and the worlds are shared.
  const apps = (options.applications ?? []).map((app) => ({ ...app }));
  const repos = (options.repositories ?? []).map((repo) => ({ ...repo }));
  const seen = {
    createdApplications: [] as Record<string, unknown>[],
    createdRepositories: [] as Record<string, unknown>[],
    updates: [] as {
      id: string;
      ifMatch: string | null;
      body: Record<string, unknown>;
    }[],
    applicationReads: 0,
  };
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
    (url) => url.pathname === "/v1/applications",
    (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        seen.createdApplications.push(body);
        const created = application(apps.length + 50, String(body.name), {
          slug: String(body.slug),
          description: String(body.description ?? ""),
        });
        apps.push(created);
        return route.fulfill(json(applicationBody(created), 201));
      }
      seen.applicationReads += 1;
      const url = new URL(request.url());
      const size = options.pageSize ?? 25;
      const offset = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
      const items = apps.slice(offset, offset + size).map(applicationBody);
      return route.fulfill(json({
        items,
        nextCursor: offset + size < apps.length ? `c${offset + size}` : null,
      }));
    },
  );
  await page.route(
    (url) => /^\/v1\/applications\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      if (route.request().method() === "GET") {
        const found = apps.find((app) => app.id === id);
        return found
          ? route.fulfill(json(applicationBody(found)))
          : route.fulfill(json({ status: 404 }, 404));
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      seen.updates.push({
        id,
        ifMatch: route.request().headers()["if-match"] ?? null,
        body,
      });
      const target = apps.find((app) => app.id === id);
      if (!target) return route.fulfill(json({ status: 404 }, 404));
      if (typeof body.name === "string") target.name = body.name;
      if ("archivedAt" in body) {
        target.archivedAt = (body.archivedAt as string | null) ?? null;
      }
      target.version += 1;
      return route.fulfill(json(applicationBody(target)));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/repositories",
    (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        seen.createdRepositories.push(body);
        if (options.create === "conflict") {
          return route.fulfill({
            status: 409,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/test",
              title: "Conflict",
              detail: "Conflict.",
              status: 409,
              code: "STATE_CONFLICT",
              retryable: false,
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
            }),
          });
        }
        const created = repository(
          repos.length + 50,
          String(body.applicationId),
          String(body.name),
          {
            owner: String(body.owner),
            providerRepoId: String(body.providerRepoId),
            defaultBranch: String(body.defaultBranch),
          },
        );
        repos.push(created);
        return route.fulfill(json(repositoryBody(created), 201));
      }
      return route.fulfill(
        json({ items: repos.map(repositoryBody), nextCursor: null }),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/integration-connections",
    (route) =>
      route.fulfill(json({
        items: options.offered === null ? [] : [{
          id: CONNECTION_ID,
          provider: "github",
          label: "acme-org",
          externalAccountId: "7000001",
          config: {},
          secretId: null,
          grantedScopes: { metadata: "read", contents: "write" },
          createdBy: uuid(1),
          status: "enabled",
          lastCheckedAt: STAMP,
          createdAt: STAMP,
          updatedAt: STAMP,
          version: 1,
        }],
        nextCursor: null,
      })),
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/integration-connections/${CONNECTION_ID}/resources`,
    (route) =>
      route.fulfill(json({
        items: (options.offered ?? []).map((item, index) => ({
          id: uuid(900 + index),
          organizationId: MOCK_ORGANIZATION_ID,
          connectionId: CONNECTION_ID,
          installationId: uuid(850),
          externalId: item.id,
          kind: "repository",
          displayName: item.name,
          safeUrl: `https://github.com/${item.name}`,
          selected: item.selected ?? true,
          available: true,
          enabled: true,
          capabilitySnapshot: {},
          lastDiscoveryGeneration: 1,
          archivedAt: null,
          createdAt: STAMP,
          updatedAt: STAMP,
          version: 1,
        })),
        nextCursor: null,
      })),
  );
  return seen;
}
