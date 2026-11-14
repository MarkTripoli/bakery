import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

/**
 * Mocked proof of the organization Integrations page, the route every GitHub
 * connection callback returns to. The real-API proof with the fake GitHub
 * App is `organization-integrations-fake-github.spec.ts`.
 */
const ORG = MOCK_ORGANIZATION_ID;
const PAGE_PATH = "/settings/organization/integrations";
const STAMP = "2026-10-28T12:00:00.000Z";
const CONNECTION_ID = "00000000-0000-4000-8000-0000000000c1";
const INSTALLATION_ID = "00000000-0000-4000-8000-0000000000d1";
const STATE = "A".repeat(43);
const INSTALL_URL =
  `https://github.com/apps/bakery-test-912345/installations/new?state=${STATE}`;
const AUTHORIZE_URL =
  `https://github.com/login/oauth/authorize?client_id=Iv23li&redirect_uri=x&state=${STATE}&code_challenge=${
    "B".repeat(43)
  }&code_challenge_method=S256`;
const STORAGE_KEY = "bakery.githubConnect";

type Connection = {
  id: string;
  status: "pending" | "enabled" | "disabled" | "degraded" | "revoked";
  version: number;
  lastCheckedAt: string | null;
};

type Resource = {
  id: string;
  name: string;
  selected: boolean;
  available: boolean;
  version: number;
};

type World = {
  role: "admin" | "developer";
  connections: Connection[];
  resources: Resource[];
  createAnswer: "ok" | "unregistered";
  /** Repositories per page; the rest follow a `nextCursor`. */
  pageSize?: number;
  /** The next request for a later page fails once, with a 500. */
  failLaterPage?: boolean;
  /** While true, the first read of the repositories fails with a 500. */
  failFirstRead?: boolean;
  seen: { method: string; path: string; body: unknown; ifMatch?: string }[];
  github: string[];
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function problem(status: number, code: string, reason?: string) {
  return {
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({
      type: "https://bakery.example/problems/test",
      title: "Request refused",
      detail: "Request refused.",
      status,
      code,
      retryable: false,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      ...(reason ? { reason } : {}),
    }),
  };
}

function connectionBody(connection: Connection) {
  return {
    id: connection.id,
    provider: "github",
    label: "acme-org",
    externalAccountId: "7000001",
    config: {},
    secretId: null,
    grantedScopes: { metadata: "read", contents: "write" },
    createdBy: "00000000-0000-4000-8000-000000000001",
    status: connection.status,
    lastCheckedAt: connection.lastCheckedAt,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: connection.version,
  };
}

function resourceBody(resource: Resource) {
  return {
    id: resource.id,
    organizationId: ORG,
    connectionId: CONNECTION_ID,
    installationId: INSTALLATION_ID,
    externalId: resource.id.slice(-4),
    kind: "repository",
    displayName: resource.name,
    safeUrl: `https://github.com/${resource.name}`,
    selected: resource.selected,
    available: resource.available,
    enabled: true,
    capabilitySnapshot: {},
    lastDiscoveryGeneration: 1,
    archivedAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: resource.version,
  };
}

function newWorld(overrides: Partial<World> = {}): World {
  return {
    role: "admin",
    connections: [],
    resources: [],
    createAnswer: "ok",
    seen: [],
    github: [],
    ...overrides,
  };
}

async function fixture(page: Page, world: World) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${ORG}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: ORG,
        role: world.role,
        capabilities: [],
      })),
  );
  const handle = (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" ? null : request.postDataJSON();
    world.seen.push({
      method,
      path,
      body,
      ifMatch: request.headers()["if-match"],
    });
    if (method === "POST" && path === "/v1/integration-auth-attempts") {
      if (world.createAnswer === "unregistered") {
        return route.fulfill(
          problem(409, "STATE_CONFLICT", "provider_unregistered"),
        );
      }
      return route.fulfill(json({
        id: "00000000-0000-4000-8000-0000000000a1",
        authorizationUrl: AUTHORIZE_URL,
        installationUrl: INSTALL_URL,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }, 201));
    }
    if (method === "GET" && path === "/v1/integration-connections") {
      return route.fulfill(json({
        items: world.connections.map(connectionBody),
        nextCursor: null,
      }));
    }
    const connection = world.connections.find((item) =>
      path.startsWith(`/v1/integration-connections/${item.id}`)
    );
    if (!connection) return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
    const base = `/v1/integration-connections/${connection.id}`;
    if (method === "GET" && path === `${base}/resources`) {
      const cursor = new URL(request.url()).searchParams.get("cursor");
      if (!cursor && world.failFirstRead) {
        return route.fulfill(problem(500, "INTERNAL_ERROR"));
      }
      const size = world.pageSize ?? world.resources.length;
      if (cursor && world.failLaterPage) {
        world.failLaterPage = false;
        return route.fulfill(problem(500, "INTERNAL_ERROR"));
      }
      return route.fulfill(json({
        items: (cursor
          ? world.resources.slice(size)
          : world.resources.slice(0, size)).map(resourceBody),
        nextCursor: !cursor && size < world.resources.length ? "r2" : null,
      }));
    }
    if (method === "PATCH" && path.startsWith(`${base}/resources/`)) {
      const resource = world.resources.find((item) =>
        path.endsWith(`/${item.id}`)
      )!;
      resource.selected = (body as { selected: boolean }).selected;
      resource.version++;
      // As on the server, a selection change moves the connection on.
      connection.version++;
      return route.fulfill(json(resourceBody(resource)));
    }
    if (method === "PATCH" && path === base) {
      if (request.headers()["if-match"] !== `"v${connection.version}"`) {
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      if (!world.resources.some((item) => item.selected)) {
        return route.fulfill(
          problem(409, "STATE_CONFLICT", "no_selected_resource"),
        );
      }
      connection.status = "enabled";
      connection.version++;
      return route.fulfill(json(connectionBody(connection)));
    }
    if (method === "POST" && path === `${base}/checks`) {
      connection.lastCheckedAt = STAMP;
      return route.fulfill(json({
        healthy: true,
        checkedAt: STAMP,
        capabilities: ["contents:write", "issues:write", "metadata:read"],
        fault: null,
        health: "healthy",
      }));
    }
    return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
  };
  await page.route("**/v1/integration-auth-attempts", handle);
  await page.route("**/v1/integration-connections", handle);
  await page.route("**/v1/integration-connections/**", handle);
  await page.route("https://github.com/**", (route) => {
    world.github.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>GitHub</title><p>GitHub</p>",
    });
  });
}

const connectButton = (page: Page) =>
  page.getByRole("button", { name: "Connect GitHub", exact: true });
const outcomeBanner = (page: Page) =>
  page.getByTestId("github-connection-outcome");

test("Connect GitHub creates an attempt and opens the App's install page with its state", async ({ page }) => {
  const world = newWorld();
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" }))
    .toBeVisible();
  await expect(page.getByText("No GitHub connection yet")).toBeVisible();
  await connectButton(page).click();
  await expect.poll(() => world.github).toEqual([INSTALL_URL]);
  const created = world.seen.filter((call) =>
    call.path === "/v1/integration-auth-attempts"
  );
  expect(created.map((call) => call.body)).toEqual([{ provider: "github" }]);
  // The attempt's two links wait in this tab's session storage only; nothing
  // holding the state reaches local storage.
  await page.goto(PAGE_PATH);
  expect(
    JSON.parse(
      await page.evaluate(
        (key) => sessionStorage.getItem(key) ?? "null",
        STORAGE_KEY,
      ),
    ),
  ).toMatchObject({
    authorizationUrl: AUTHORIZE_URL,
    installationUrl: INSTALL_URL,
  });
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toContain(STATE);
  // A final outcome forgets both.
  await page.goto(`${PAGE_PATH}?githubConnection=installation_requested`);
  await expect(outcomeBanner(page)).toBeVisible();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), STORAGE_KEY),
  ).toBeNull();
});

test("after the install, awaiting_authorization continues to GitHub authorization on its own, once", async ({ page }) => {
  test.setTimeout(45_000);
  const world = newWorld();
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await connectButton(page).click();
  await expect.poll(() => world.github).toEqual([INSTALL_URL]);
  // GitHub's Setup URL answered awaiting_authorization.
  await page.goto(`${PAGE_PATH}?githubConnection=awaiting_authorization`);
  await expect.poll(() => world.github).toEqual([INSTALL_URL, AUTHORIZE_URL]);
  // The tab is leaving for GitHub: read this origin's storage once it is back,
  // not mid-navigation (the old context dies) or on GitHub's origin.
  await page.waitForURL(world.github.at(-1)!);
  await page.goto(PAGE_PATH);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), STORAGE_KEY),
  ).toBeNull();
  // Coming back to the same answer again never replays the spent link.
  await page.goto(`${PAGE_PATH}?githubConnection=awaiting_authorization`);
  await expect(outcomeBanner(page)).toContainText(
    "this tab no longer holds the link to authorize Bakery",
  );
  await expect(
    outcomeBanner(page).getByRole("button", { name: "Connect GitHub again" }),
  ).toBeVisible();
  expect(world.github).toHaveLength(2);
});

test("an OAuth callback that finds no installation continues to the install page on its own, once", async ({ page }) => {
  test.setTimeout(45_000);
  const world = newWorld();
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await connectButton(page).click();
  await expect.poll(() => world.github).toEqual([INSTALL_URL]);
  // The OAuth callback answered awaiting_installation.
  await page.goto(`${PAGE_PATH}?githubConnection=awaiting_installation`);
  await expect.poll(() => world.github).toEqual([INSTALL_URL, INSTALL_URL]);
  // The tab is leaving for GitHub: read this origin's storage once it is back,
  // not mid-navigation (the old context dies) or on GitHub's origin.
  await page.waitForURL(world.github.at(-1)!);
  await page.goto(PAGE_PATH);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), STORAGE_KEY),
  ).toBeNull();
  await page.goto(`${PAGE_PATH}?githubConnection=awaiting_installation`);
  await expect(outcomeBanner(page)).toContainText(
    "this tab no longer holds the install link",
  );
  expect(world.github).toHaveLength(2);
});

test("a pending connection is selected, enabled and checked in that order", async ({ page }) => {
  const world = newWorld({
    connections: [{
      id: CONNECTION_ID,
      status: "pending",
      version: 1,
      lastCheckedAt: null,
    }],
    resources: [
      {
        id: "00000000-0000-4000-8000-0000000001a1",
        name: "acme-org/bakery",
        selected: false,
        available: true,
        version: 1,
      },
      {
        id: "00000000-0000-4000-8000-0000000001a2",
        name: "acme-org/tools",
        selected: false,
        available: true,
        version: 1,
      },
    ],
  });
  await fixture(page, world);
  await page.goto(
    `${PAGE_PATH}?githubConnection=pending&connectionId=${CONNECTION_ID}`,
  );
  await expect(outcomeBanner(page)).toContainText(
    "GitHub is connected. Select at least one repository, then enable the connection.",
  );
  const panel = page.getByTestId("github-connection");
  await expect(panel).toHaveAttribute("data-highlighted", "true");
  await expect(panel.getByText("Needs setup")).toBeVisible();
  await expect(
    panel.getByText(
      "To finish: select at least one repository, enable the connection, then check it.",
    ),
  ).toBeVisible();
  const enable = panel.getByRole("button", { name: "Enable connection" });
  const check = panel.getByRole("button", { name: "Check connection" });
  await expect(enable).toBeDisabled();
  await expect(check).toBeDisabled();

  // Each change is saved before the box shows it.
  await panel.getByRole("checkbox", { name: "acme-org/bakery" }).click();
  await expect(panel.getByRole("checkbox", { name: "acme-org/bakery" }))
    .toBeChecked();
  await expect(panel.getByText("Repositories (1 selected)")).toBeVisible();
  const select = world.seen.find((call) => call.method === "PATCH");
  expect(select?.body).toEqual({ selected: true });
  expect(select?.ifMatch).toBe('"v1"');

  await enable.click();
  await expect(panel.getByText("Enabled", { exact: true })).toBeVisible();
  const enabled = world.seen.filter((call) =>
    call.method === "PATCH" && call.path.endsWith(CONNECTION_ID)
  );
  // The selection moved the connection to version 2; Enable sends it, at
  // once or after one reread.
  expect(enabled.at(-1)).toMatchObject({
    body: { enabled: true },
    ifMatch: '"v2"',
  });

  await check.click();
  const result = panel.getByTestId("github-connection-check");
  await expect(result.getByText("Healthy")).toBeVisible();
  for (
    const capability of ["contents:write", "issues:write", "metadata:read"]
  ) {
    await expect(result.getByText(capability)).toBeVisible();
  }
  const scan = await new AxeBuilder({ page }).include(
    '[data-testid="organization-integrations"]',
  ).analyze();
  expect(scan.violations).toEqual([]);
});

test("enabling with nothing selected says to select a repository first", async ({ page }) => {
  const world = newWorld({
    connections: [{
      id: CONNECTION_ID,
      status: "pending",
      version: 1,
      lastCheckedAt: null,
    }],
    resources: [{
      id: "00000000-0000-4000-8000-0000000001a1",
      name: "acme-org/bakery",
      selected: true,
      available: true,
      version: 1,
    }],
  });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  const panel = page.getByTestId("github-connection");
  await expect(panel.getByText("Repositories (1 selected)")).toBeVisible();
  // Another Admin deselected it meanwhile.
  world.resources[0].selected = false;
  await panel.getByRole("button", { name: "Enable connection" }).click();
  await expect(
    panel.getByText(
      "Select at least one repository before enabling the connection.",
    ),
  ).toBeVisible();
  await expect(panel.getByText("Repositories (0 selected)")).toBeVisible();
});

const OUTCOME_MESSAGES: Readonly<Record<string, string>> = {
  pending: "GitHub is connected. Select at least one repository",
  refreshed: "The GitHub connection was refreshed.",
  awaiting_authorization: "this tab no longer holds the link to authorize",
  awaiting_installation: "the App is not installed yet",
  installation_requested: "sent your install request to an owner",
  state_rejected: "The GitHub link expired or was started in another",
  expired: "The connection attempt expired after 15 minutes.",
  authorization_denied: "GitHub authorization was cancelled.",
  provider_unregistered: "No GitHub App is registered for this Bakery",
  exchange_failed: "GitHub did not complete the authorization.",
  installation_listing_failed: "could not read your GitHub installations",
  repository_listing_failed: "could not read the installation's repositories",
  installation_unverified: "GitHub did not confirm that your account",
  installation_check_failed: "could not check the installation with GitHub",
  installation_suspended: "The App installation is suspended on GitHub.",
  admin_required: "Only organization Admins can connect GitHub",
  already_connected: "already connected to that GitHub installation",
  reconnect_unavailable: "The connection being reconnected was removed",
  storage_failed: "could not save the connection",
};

test("every GitHub connection outcome shows its message", async ({ page }) => {
  test.setTimeout(90_000);
  const world = newWorld();
  await fixture(page, world);
  for (const [outcome, message] of Object.entries(OUTCOME_MESSAGES)) {
    await page.goto(`${PAGE_PATH}?githubConnection=${outcome}`);
    await expect(outcomeBanner(page)).toHaveAttribute("data-outcome", outcome);
    await expect(outcomeBanner(page)).toContainText(message);
  }
  // An unknown value is no outcome at all.
  await page.goto(`${PAGE_PATH}?githubConnection=surprise`);
  await expect(page.getByText("No GitHub connection yet")).toBeVisible();
  await expect(outcomeBanner(page)).toHaveCount(0);
  expect(world.github).toEqual([]);
});

test("dismissing an outcome clears it from the address", async ({ page }) => {
  await fixture(page, newWorld());
  await page.goto(`${PAGE_PATH}?githubConnection=expired`);
  await outcomeBanner(page).getByRole("button", { name: /dismiss/i }).click();
  await expect(outcomeBanner(page)).toHaveCount(0);
  await expect(page).toHaveURL(PAGE_PATH);
});

test("without a registered GitHub App, Connect GitHub says who registers it", async ({ page }) => {
  const world = newWorld({ createAnswer: "unregistered" });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await connectButton(page).click();
  await expect(
    page.getByText("An installation administrator registers it"),
  ).toBeVisible();
  expect(world.github).toEqual([]);
});

test("a Developer sees connections but no way to change them", async ({ page }) => {
  const world = newWorld({
    role: "developer",
    connections: [{
      id: CONNECTION_ID,
      status: "enabled",
      version: 2,
      lastCheckedAt: STAMP,
    }],
    resources: [{
      id: "00000000-0000-4000-8000-0000000001a1",
      name: "acme-org/bakery",
      selected: true,
      available: true,
      version: 2,
    }],
  });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  const panel = page.getByTestId("github-connection");
  await expect(panel.getByText("Enabled", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Only organization Admins can connect GitHub"),
  ).toBeVisible();
  await expect(connectButton(page)).toHaveCount(0);
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(panel.getByRole("checkbox", { name: "acme-org/bakery" }))
    .toBeDisabled();
});

const pagedWorld = (overrides: Partial<World> = {}) =>
  newWorld({
    connections: [{
      id: CONNECTION_ID,
      status: "pending",
      version: 1,
      lastCheckedAt: null,
    }],
    resources: [1, 2, 3].map((index) => ({
      id: `00000000-0000-4000-8000-0000000001a${index}`,
      name: `acme-org/repo-${index}`,
      selected: false,
      available: true,
      version: 1,
    })),
    pageSize: 2,
    ...overrides,
  });

test("showing more repositories puts focus on the first one it added", async ({ page }) => {
  await fixture(page, pagedWorld());
  await page.goto(PAGE_PATH);
  const more = page.getByRole("button", { name: "Show more repositories" });
  await more.click();
  await expect(page.getByLabel("acme-org/repo-3")).toBeVisible();
  await expect(more).toHaveCount(0);
  // The button that was pressed is gone: focus is on the first repository it added.
  await expect(page.getByLabel("acme-org/repo-3")).toBeFocused();
});

test("a failed load of more repositories puts focus on Try again, and a good retry puts it back on the button", async ({ page }) => {
  await fixture(page, pagedWorld({ failLaterPage: true }));
  await page.goto(PAGE_PATH);
  await page.getByRole("button", { name: "Show more repositories" }).click();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await retry.click();
  // Try again re-reads the list; the button that loads more is back, so focus goes to it.
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show more repositories" }),
  ).toBeFocused();
});

test("a failed first read of the repositories, retried from the keyboard, puts focus on the list's heading", async ({ page }) => {
  const world = pagedWorld({ failFirstRead: true });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  world.failFirstRead = false;
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("acme-org/repo-1")).toBeVisible();
  await expect(page.locator('[data-paged-heading="repositories"]'))
    .toBeFocused();
});
