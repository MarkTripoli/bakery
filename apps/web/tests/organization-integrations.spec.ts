import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";
import { still } from "./helpers/stills.ts";

/**
 * Mocked proof of the organization Integrations pages: the list that every
 * GitHub connection callback returns to, and one connection's own page. The
 * real-API proof with the fake GitHub App is
 * `organization-integrations-fake-github.spec.ts`.
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
  /** The next change to the connection (Turn on, Turn off) fails once, with a 502. */
  failNextSwitch?: boolean;
  /** What a health check answers; healthy unless a test says otherwise. */
  checkHealth?: "healthy" | "degraded" | "auth_required";
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
    grantedScopes: {
      metadata: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
      checks: "write",
    },
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
    // Served since #386/#65: the repository's default branch and its latest
    // check. Unknown here, like a resource connected before that change, so
    // the four fields are present and null rather than absent (Zod rejects a
    // resource missing them).
    defaultBranch: null,
    latestCheckState: null,
    latestCheckConclusion: null,
    latestCheckAt: null,
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
    if (method === "GET" && path === base) {
      return route.fulfill(json(connectionBody(connection)));
    }
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
      // As on the server, the connection's version is what If-Match names.
      if (request.headers()["if-match"] !== `"v${connection.version}"`) {
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      const selected = (body as { selected: boolean }).selected;
      const remaining = world.resources.filter((item) =>
        item.selected && item.id !== resource.id
      ).length + (selected ? 1 : 0);
      // A connection that is on keeps at least one repository.
      if (connection.status === "enabled" && remaining === 0) {
        return route.fulfill(
          problem(409, "STATE_CONFLICT", "no_selected_resource"),
        );
      }
      resource.selected = selected;
      resource.version++;
      // A selection change moves the connection on.
      connection.version++;
      return route.fulfill(json(resourceBody(resource)));
    }
    if (method === "PATCH" && path === base) {
      if (world.failNextSwitch) {
        world.failNextSwitch = false;
        return route.fulfill(problem(502, "UPSTREAM_UNAVAILABLE"));
      }
      if (request.headers()["if-match"] !== `"v${connection.version}"`) {
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      const enable = (body as { enabled?: boolean }).enabled !== false;
      if (enable && !world.resources.some((item) => item.selected)) {
        return route.fulfill(
          problem(409, "STATE_CONFLICT", "no_selected_resource"),
        );
      }
      connection.status = enable ? "enabled" : "disabled";
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
        health: world.checkHealth ?? "healthy",
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

const ID = (n: number) => `00000000-0000-4000-8000-0000000000c${n}`;
const connection = (
  n: number,
  status: Connection["status"],
  overrides: Partial<Connection> = {},
): Connection => ({
  id: ID(n),
  status,
  version: 1,
  lastCheckedAt: status === "enabled" ? STAMP : null,
  ...overrides,
});
const repository = (index: number, selected = false): Resource => ({
  // A fixed-width tail, so repository 12 is as valid a UUID as repository 1.
  id: `00000000-0000-4000-8000-00000001a${String(index).padStart(3, "0")}`,
  name: `acme-org/repo-${index}`,
  selected,
  available: true,
  version: 1,
});
const pageFor = (id: string) => `${PAGE_PATH}/${id}`;
const row = (page: Page, id: string) => page.getByTestId(`connection-${id}`);

test("Connect GitHub creates an attempt and opens the App's install page with its state", async ({ page }) => {
  const world = newWorld();
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" }))
    .toBeVisible();
  await expect(page.getByText("Nothing is connected yet")).toBeVisible();
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
  test.setTimeout(laneBudgetMs(45_000));
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
  test.setTimeout(laneBudgetMs(45_000));
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

test("each connection reads as one badge, one line and one button", async ({ page }) => {
  const world = newWorld({
    connections: [
      connection(1, "enabled"),
      connection(2, "enabled", { lastCheckedAt: null }),
      connection(3, "pending"),
      connection(4, "disabled"),
      connection(5, "degraded"),
      connection(6, "revoked"),
    ],
  });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  const expected: ReadonlyArray<[number, string, string, string | null]> = [
    [1, "Working", "Manage", "Last checked"],
    [2, "Not checked yet", "Check now", null],
    [
      3,
      "Finish setup",
      "Finish setup",
      "Choose repositories, then turn it on.",
    ],
    [4, "Turned off", "Turn on", "No work runs against GitHub."],
    [
      5,
      "Needs attention",
      "Reconnect",
      "GitHub is not accepting some of Bakery's access.",
    ],
    [6, "Removed", "Connect again", "Access to GitHub was removed."],
  ];
  for (const [n, badge, button, line] of expected) {
    const item = row(page, ID(n));
    await expect(item.getByText(badge, { exact: true }).first(), badge)
      .toBeVisible();
    await expect(item.getByRole("button"), `${badge} has one button`)
      .toHaveCount(1);
    await expect(item.getByRole("button", { name: button, exact: true }))
      .toBeVisible();
    if (line !== null) await expect(item).toContainText(line);
    else await expect(item).not.toContainText("Last checked");
  }
  // GitHub is the one provider the server can connect, and it says so.
  await expect(page.getByTestId("available-list")).toContainText("GitHub");
  await expect(
    page.getByTestId("available-list").getByRole("button", {
      name: "Connect",
      exact: true,
    }),
  ).toBeVisible();
});

test("a row's fix opens the connection's page, and Reconnect leaves for GitHub with that connection named", async ({ page }) => {
  const world = newWorld({
    connections: [connection(3, "pending"), connection(5, "degraded")],
  });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await row(page, ID(3)).getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(new RegExp(`${pageFor(ID(3))}$`));
  await page.goto(PAGE_PATH);
  await row(page, ID(5)).getByRole("button", { name: "Reconnect" }).click();
  await expect.poll(() => world.github).toEqual([INSTALL_URL]);
  const created = world.seen.filter((call) =>
    call.path === "/v1/integration-auth-attempts"
  );
  expect(created.map((call) => call.body)).toEqual([{
    provider: "github",
    reconnectConnectionId: ID(5),
    returnPath: pageFor(ID(5)),
  }]);
});

test("a removed connection is connected again, not refreshed", async ({ page }) => {
  const world = newWorld({ connections: [connection(6, "revoked")] });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await row(page, ID(6)).getByRole("button", { name: "Connect again" })
    .click();
  await expect.poll(() => world.github).toEqual([INSTALL_URL]);
  expect(
    world.seen.filter((call) => call.path === "/v1/integration-auth-attempts")
      .map((call) => call.body),
  ).toEqual([{ provider: "github" }]);
});

test("a callback that names its connection lands on that connection's page with the outcome shown", async ({ page }) => {
  const world = newWorld({
    connections: [connection(3, "pending")],
    resources: [repository(1), repository(2)],
  });
  await fixture(page, world);
  await page.goto(
    `${PAGE_PATH}?githubConnection=pending&connectionId=${ID(3)}`,
  );
  await expect(page).toHaveURL(
    new RegExp(`${pageFor(ID(3))}\\?githubConnection=pending$`),
  );
  await expect(outcomeBanner(page)).toHaveAttribute("data-outcome", "pending");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "GitHub · acme-org",
  );
});

test("a pending connection is set up in three steps: choose repositories, save, turn on, then check", async ({ page }) => {
  const world = newWorld({
    connections: [connection(3, "pending")],
    resources: [repository(1), repository(2), repository(3)],
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(3)));
  const steps = page.getByRole("list", { name: "Setup steps" });
  await expect(steps).toBeVisible();
  await expect(steps).toContainText("Install the Bakery app on GitHub");
  await expect(steps).toContainText("Choose repositories");
  await expect(steps).toContainText("Turn on the connection");
  // Nothing is chosen yet: nothing to save, and step three holds Turn on, off.
  await expect(page.getByRole("button", { name: "Save selection" }))
    .toHaveCount(0);
  const turnOn = page.getByRole("button", { name: "Turn on" });
  await expect(turnOn).toBeDisabled();
  await expect(page.getByText("Choose a repository first.")).toBeVisible();
  await expect(
    page.getByText(
      "Setup is not finished. Choose at least one repository below.",
    ),
  ).toBeVisible();
  await page.getByLabel("acme-org/repo-1").check();
  await page.getByLabel("acme-org/repo-3").check();
  await page.getByRole("button", { name: "Save selection" }).click();
  await expect(turnOn).toBeEnabled();
  await expect(page.getByText("Turn on the connection to finish."))
    .toBeVisible();
  // One change at a time, each under the connection's current version.
  const patches = world.seen.filter((call) =>
    call.method === "PATCH" && call.path.includes("/resources/")
  );
  expect(patches.map((call) => call.ifMatch)).toEqual(['"v1"', '"v2"']);
  expect(patches.map((call) => call.body)).toEqual([
    { selected: true },
    { selected: true },
  ]);
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(steps).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "GitHub · acme-org",
  );
  const enabled = world.seen.filter((call) =>
    call.method === "PATCH" && call.path.endsWith(`/${ID(3)}`)
  );
  expect(enabled.map((call) => [call.ifMatch, call.body])).toEqual([
    ['"v3"', { enabled: true }],
  ]);
  // Enabled and never checked: the page says so, and Check now settles it.
  await expect(page.getByText("Not checked yet").first()).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Working", { exact: true })).toBeVisible();
});

test("enabling with nothing selected says to select a repository first", async ({ page }) => {
  const world = newWorld({
    connections: [connection(3, "pending", { version: 2 })],
    resources: [repository(1, true)],
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(3)));
  await expect(page.getByText("Repositories (1 selected)")).toBeVisible();
  // Another Admin deselected it meanwhile.
  world.resources[0].selected = false;
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(
    page.getByText(
      "Select at least one repository before enabling the connection.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Repositories (0 selected)")).toBeVisible();
});

test("the last repository of a connection that is on cannot be removed, and the page says what to do", async ({ page }) => {
  const world = newWorld({
    connections: [connection(1, "enabled")],
    resources: [repository(1, true), repository(2)],
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(1)));
  await page.getByLabel("acme-org/repo-1").uncheck();
  await page.getByRole("button", { name: "Save selection" }).click();
  await expect(
    page.getByText(
      "Keep at least one repository, or turn the connection off first.",
    ),
  ).toBeVisible();
  // What the server holds is shown again.
  await expect(page.getByLabel("acme-org/repo-1")).toBeChecked();
  await expect(page.getByRole("button", { name: "Save selection" }))
    .toHaveCount(0);
});

test("swapping repositories adds before it removes, so a connection that is on never has none", async ({ page }) => {
  const world = newWorld({
    connections: [connection(1, "enabled")],
    resources: [repository(1, true), repository(2)],
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(1)));
  await page.getByLabel("acme-org/repo-1").uncheck();
  await page.getByLabel("acme-org/repo-2").check();
  await page.getByRole("button", { name: "Save selection" }).click();
  // The boxes already show the new choice; the save is over when its button goes.
  await expect(page.getByRole("button", { name: "Save selection" }))
    .toHaveCount(0);
  await expect(page.getByLabel("acme-org/repo-2")).toBeChecked();
  await expect(page.getByLabel("acme-org/repo-1")).not.toBeChecked();
  const patches = world.seen.filter((call) =>
    call.method === "PATCH" && call.path.includes("/resources/")
  );
  expect(patches.map((call) => call.body)).toEqual([
    { selected: true },
    { selected: false },
  ]);
});

test("loading more repositories mid-edit leaves what was already selected there alone", async ({ page }) => {
  const world = newWorld({
    connections: [connection(1, "enabled")],
    // Repository 12 is on the second page, and already selected.
    resources: Array.from(
      { length: 12 },
      (_, index) => repository(index + 1, index === 11),
    ),
    pageSize: 11,
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(1)));
  await page.getByLabel("acme-org/repo-2").check();
  await page.getByRole("button", { name: "Show more repositories" }).click();
  await expect(page.getByLabel("acme-org/repo-12")).toBeChecked();
  await page.getByRole("button", { name: "Save selection" }).click();
  await expect(page.getByRole("button", { name: "Save selection" }))
    .toHaveCount(0);
  const patches = world.seen.filter((call) =>
    call.method === "PATCH" && call.path.includes("/resources/")
  );
  // Only what was ticked is sent: repository 12, never touched, is not removed.
  expect(patches.map((call) => [call.path.split("/").at(-1), call.body]))
    .toEqual([[repository(2).id, { selected: true }]]);
  await expect(page.getByLabel("acme-org/repo-12")).toBeChecked();
});

test("a turn on that fails says so, keeps Turn on available, and a retry succeeds", async ({ page }) => {
  const world = newWorld({
    connections: [connection(3, "pending")],
    resources: [repository(1, true)],
    failNextSwitch: true,
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(3)));
  const turnOn = page.getByRole("button", { name: "Turn on" });
  await turnOn.click();
  await expect(
    page.getByText("The connection could not be changed. Try again."),
  ).toBeVisible();
  // Still set up, not on: the same button is there to try again.
  await expect(turnOn).toBeEnabled();
  await turnOn.click();
  await expect(page.getByRole("list", { name: "Setup steps" })).toHaveCount(0);
  expect(
    world.seen.filter((call) =>
      call.method === "PATCH" && call.path.endsWith(`/${ID(3)}`)
    ),
  ).toHaveLength(2);
});

test("turning a connection off asks first and says nothing is deleted", async ({ page }) => {
  const world = newWorld({
    connections: [connection(1, "enabled")],
    resources: [repository(1, true)],
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(1)));
  await page.getByRole("button", { name: "Turn off" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Turn off GitHub · acme-org?",
  });
  await expect(dialog).toContainText("Nothing is deleted.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(world.seen.filter((call) => call.method === "PATCH")).toHaveLength(0);
  await page.getByRole("button", { name: "Turn off" }).click();
  await dialog.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Turned off", { exact: true })).toBeVisible();
  await expect(
    page.getByText("This connection is off. Work that needs it is waiting."),
  ).toBeVisible();
  const off = world.seen.filter((call) => call.method === "PATCH");
  expect(off.map((call) => call.body)).toEqual([{ enabled: false }]);
  // The one fix is the one button of the banner.
  await page.getByRole("button", { name: "Turn on" }).click();
  // It was checked before it was turned off, so it reads Working again.
  await expect(page.getByText("Working", { exact: true })).toBeVisible();
});

test("a degraded connection says Reconnect, and a check that finds the authorization gone says so", async ({ page }) => {
  const world = newWorld({
    connections: [connection(5, "degraded")],
    resources: [repository(1, true)],
    checkHealth: "auth_required",
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(5)));
  await expect(page.getByText("Needs attention", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByText(
      "GitHub is not accepting some of Bakery's access. Reconnect to restore it.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("If you pick a different GitHub account"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Needs reconnecting", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByText(
      "GitHub no longer accepts Bakery's access. Reconnect to continue. Work that needs it is waiting.",
    ),
  ).toBeVisible();
  await page.getByTestId("connection-problem").getByRole("button", {
    name: "Reconnect",
  }).click();
  await expect.poll(() => world.github).toEqual([INSTALL_URL]);
});

test("a removed connection says so, offers one way back and changes nothing else", async ({ page }) => {
  await fixture(
    page,
    newWorld({
      connections: [connection(6, "revoked")],
      resources: [repository(1, true), repository(2)],
    }),
  );
  await page.goto(pageFor(ID(6)));
  await expect(page.getByText("Removed", { exact: true })).toBeVisible();
  await expect(page.getByText("Access to GitHub was removed.")).toBeVisible();
  await expect(
    page.getByTestId("connection-problem").getByRole("button"),
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Connect again" }))
    .toBeVisible();
  // Bakery has no access: there is nothing to check and nothing to choose.
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0);
  await expect(page.getByText("Connect again to change repositories."))
    .toBeVisible();
  await expect(page.getByRole("checkbox", { name: "acme-org/repo-1" }))
    .toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "acme-org/repo-2" }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "Save selection" }))
    .toHaveCount(0);
});

test("Check now is shown only while the connection is on", async ({ page }) => {
  const world = newWorld({
    connections: [
      connection(1, "enabled"),
      connection(5, "degraded"),
      connection(3, "pending"),
      connection(4, "disabled"),
      connection(6, "revoked"),
    ],
    resources: [repository(1, true)],
  });
  await fixture(page, world);
  for (const id of [1, 5]) {
    await page.goto(pageFor(ID(id)));
    await expect(page.getByRole("button", { name: "Check now" })).toBeEnabled();
  }
  // Setup unfinished, turned off, removed: the server would refuse a check,
  // so the page offers none (and shows no disabled button without a reason).
  for (const id of [3, 4, 6]) {
    await page.goto(pageFor(ID(id)));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check now" }))
      .toHaveCount(0);
  }
  expect(
    world.seen.filter((call) => call.path.endsWith("/checks")),
  ).toEqual([]);
});

test("what Bakery can do is in plain words, with GitHub's names behind a button", async ({ page }) => {
  await fixture(
    page,
    newWorld({
      connections: [connection(1, "enabled")],
      resources: [repository(1, true)],
    }),
  );
  await page.goto(pageFor(ID(1)));
  const can = page.getByTestId("permissions");
  for (
    const words of [
      "See repository names and settings",
      "Read and change code",
      "Read and update issues",
      "Open and update pull requests",
      "Report check results",
    ]
  ) await expect(can).toContainText(words);
  await expect(can).not.toContainText("contents:write");
  await can.getByRole("button", { name: "Show GitHub permission names" })
    .click();
  await expect(can).toContainText("contents:write");
  await expect(can).toContainText("pull_requests:write");
  await expect(
    can.getByRole("button", { name: "Hide GitHub permission names" }),
  )
    .toHaveAttribute("aria-expanded", "true");
});

test("a long repository list has a filter that says it works on what is loaded", async ({ page }) => {
  const world = newWorld({
    connections: [connection(1, "enabled")],
    resources: Array.from({ length: 12 }, (_, i) => repository(i + 1, i === 0)),
    pageSize: 11,
  });
  await fixture(page, world);
  await page.goto(pageFor(ID(1)));
  const search = page.getByRole("searchbox", { name: "Search repositories" });
  await expect(search).toBeVisible();
  await expect(page.getByText("Filtering the repositories loaded so far."))
    .toBeVisible();
  await search.fill("repo-2");
  await expect(page.getByLabel("acme-org/repo-2")).toBeVisible();
  await expect(page.getByLabel("acme-org/repo-3")).toHaveCount(0);
  await search.fill("nothing");
  await expect(page.getByText("No repository matches.")).toBeVisible();
});

test("a short repository list has no filter", async ({ page }) => {
  await fixture(
    page,
    newWorld({
      connections: [connection(1, "enabled")],
      resources: [repository(1, true), repository(2)],
    }),
  );
  await page.goto(pageFor(ID(1)));
  await expect(page.getByLabel("acme-org/repo-2")).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
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

for (const [outcome, message] of Object.entries(OUTCOME_MESSAGES)) {
  test(`the GitHub connection outcome ${outcome} shows its message`, async ({ page }) => {
    const world = newWorld();
    await fixture(page, world);
    await page.goto(`${PAGE_PATH}?githubConnection=${outcome}`);
    await expect(outcomeBanner(page)).toHaveAttribute("data-outcome", outcome);
    await expect(outcomeBanner(page)).toContainText(message);
    expect(world.github).toEqual([]);
  });
}

test("an unknown GitHub connection outcome shows nothing", async ({ page }) => {
  const world = newWorld();
  await fixture(page, world);
  await page.goto(`${PAGE_PATH}?githubConnection=surprise`);
  await expect(page.getByText("Nothing is connected yet")).toBeVisible();
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

test("without a registered GitHub App, Connect GitHub says who registers it and where", async ({ page }) => {
  const world = newWorld({ createAnswer: "unregistered" });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await connectButton(page).click();
  const notice = page.getByTestId("unregistered-notice");
  await expect(notice).toContainText(
    "GitHub is not set up for this Bakery server yet. An installation administrator registers it first.",
  );
  await expect(notice.getByRole("link", { name: "Open installation settings" }))
    .toHaveAttribute("href", "/settings/installation/integrations");
  expect(world.github).toEqual([]);
});

test("a Developer sees connections but no way to change them", async ({ page }) => {
  const world = newWorld({
    role: "developer",
    connections: [connection(1, "enabled"), connection(5, "degraded")],
    resources: [repository(1, true)],
  });
  await fixture(page, world);
  await page.goto(PAGE_PATH);
  await expect(
    page.getByText("Only organization administrators can change integrations."),
  ).toBeVisible();
  await expect(connectButton(page)).toHaveCount(0);
  // Opening a connection is reading; the fixes that leave for GitHub are not offered.
  await expect(row(page, ID(1)).getByRole("button", { name: "Manage" }))
    .toBeVisible();
  await expect(row(page, ID(5)).getByRole("button")).toHaveCount(0);
  await page.goto(pageFor(ID(1)));
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Turn off" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "acme-org/repo-1" }))
    .toBeDisabled();
});

const pagedWorld = (overrides: Partial<World> = {}) =>
  newWorld({
    connections: [connection(3, "pending")],
    resources: [1, 2, 3].map((index) => repository(index)),
    pageSize: 2,
    ...overrides,
  });

test("showing more repositories puts focus on the first one it added", async ({ page }) => {
  await fixture(page, pagedWorld());
  await page.goto(pageFor(ID(3)));
  const more = page.getByRole("button", { name: "Show more repositories" });
  await more.click();
  await expect(page.getByLabel("acme-org/repo-3")).toBeVisible();
  await expect(more).toHaveCount(0);
  // The button that was pressed is gone: focus is on the first repository it added.
  await expect(page.getByLabel("acme-org/repo-3")).toBeFocused();
});

test("a failed load of more repositories puts focus on Try again, and a good retry puts it back on the button", async ({ page }) => {
  await fixture(page, pagedWorld({ failLaterPage: true }));
  await page.goto(pageFor(ID(3)));
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
  await page.goto(pageFor(ID(3)));
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  world.failFirstRead = false;
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("acme-org/repo-1")).toBeVisible();
  await expect(page.locator('[data-paged-heading="repositories"]'))
    .toBeFocused();
});

test("both pages have no accessibility violations", async ({ page }) => {
  await fixture(
    page,
    newWorld({
      connections: [connection(1, "enabled"), connection(5, "degraded")],
      resources: [repository(1, true), repository(2)],
    }),
  );
  await page.goto(PAGE_PATH);
  await expect(row(page, ID(1))).toBeVisible();
  const home = await new AxeBuilder({ page }).include(
    '[data-testid="organization-integrations"]',
  ).analyze();
  expect(home.violations).toEqual([]);
  await page.goto(pageFor(ID(5)));
  await expect(page.getByTestId("connection-problem")).toBeVisible();
  const detail = await new AxeBuilder({ page }).include(
    '[data-testid="connection-page"]',
  ).analyze();
  expect(detail.violations).toEqual([]);
});

// Stills for design-ux's review, written only when BAKERY_STILLS_DIR is set:
// each state on desktop and on a 390 px phone, light and dark.
const STILLS = process.env.BAKERY_STILLS_DIR;
const STILL_FORMS = [[1280, 1800, "desktop"], [390, 3600, "phone"]] as const;

type StillScenario = {
  readonly name: string;
  readonly path: string;
  /** The region pictured. */
  readonly testId: string;
  readonly world: () => World;
  readonly act?: (page: Page, world: World) => Promise<void>;
};

const manyRepositories = (count: number, selected = 1) =>
  Array.from(
    { length: count },
    (_, index) => repository(index + 1, index < selected),
  );

const STILL_SCENARIOS: readonly StillScenario[] = [
  {
    name: "home-states",
    path: PAGE_PATH,
    testId: "organization-integrations",
    world: () =>
      newWorld({
        connections: [
          connection(1, "enabled"),
          connection(2, "enabled", { lastCheckedAt: null }),
          connection(3, "pending"),
          connection(4, "disabled"),
          connection(5, "degraded"),
          connection(6, "revoked"),
        ],
      }),
  },
  {
    name: "home-empty",
    path: PAGE_PATH,
    testId: "organization-integrations",
    world: () => newWorld(),
  },
  {
    // The words a person reads when no GitHub App is registered yet.
    name: "connect-unregistered",
    path: PAGE_PATH,
    testId: "organization-integrations",
    world: () => newWorld({ createAnswer: "unregistered" }),
    act: async (page) => {
      await connectButton(page).click();
      await expect(page.getByTestId("unregistered-notice")).toBeVisible();
    },
  },
  ...([
    ["working", connection(1, "enabled")],
    ["not-checked", connection(2, "enabled", { lastCheckedAt: null })],
    ["finish-setup", connection(3, "pending")],
    ["turned-off", connection(4, "disabled")],
    ["needs-attention", connection(5, "degraded")],
    ["removed", connection(6, "revoked")],
  ] as const).map(([name, item]): StillScenario => ({
    name: `connection-${name}`,
    path: pageFor(item.id),
    testId: "connection-page",
    world: () =>
      newWorld({
        connections: [{ ...item }],
        resources: manyRepositories(3, item.status === "pending" ? 0 : 1),
      }),
  })),
  {
    name: "repositories-filter",
    path: pageFor(ID(1)),
    testId: "repositories",
    world: () =>
      newWorld({
        connections: [connection(1, "enabled")],
        resources: manyRepositories(12),
        pageSize: 11,
      }),
    act: async (page) => {
      await page.getByRole("searchbox", { name: "Search repositories" })
        .fill("repo-1");
      await expect(page.getByLabel("acme-org/repo-10")).toBeVisible();
    },
  },
  {
    name: "repositories-save",
    path: pageFor(ID(1)),
    testId: "repositories",
    world: () =>
      newWorld({
        connections: [connection(1, "enabled")],
        resources: manyRepositories(3),
      }),
    act: async (page) => {
      await page.getByLabel("acme-org/repo-2").check();
      await expect(page.getByRole("button", { name: "Save selection" }))
        .toBeVisible();
    },
  },
  {
    name: "repositories-refusal",
    path: pageFor(ID(1)),
    testId: "repositories",
    world: () =>
      newWorld({
        connections: [connection(1, "enabled")],
        resources: manyRepositories(3),
      }),
    act: async (page) => {
      await page.getByLabel("acme-org/repo-1").uncheck();
      await page.getByRole("button", { name: "Save selection" }).click();
      await expect(
        page.getByText(
          "Keep at least one repository, or turn the connection off first.",
        ),
      ).toBeVisible();
    },
  },
  {
    name: "permissions-closed",
    path: pageFor(ID(1)),
    testId: "permissions",
    world: () =>
      newWorld({
        connections: [connection(1, "enabled")],
        resources: manyRepositories(2),
      }),
  },
  {
    name: "permissions-open",
    path: pageFor(ID(1)),
    testId: "permissions",
    world: () =>
      newWorld({
        connections: [connection(1, "enabled")],
        resources: manyRepositories(2),
      }),
    act: async (page) => {
      await page.getByRole("button", { name: "Show GitHub permission names" })
        .click();
      await expect(page.getByText("contents:write")).toBeVisible();
    },
  },
];

for (const scenario of STILL_SCENARIOS) {
  for (const [width, height, label] of STILL_FORMS) {
    for (const scheme of ["light", "dark"] as const) {
      test(`still: ${scenario.name} ${label} ${scheme}`, async ({ page, isMobile }) => {
        test.skip(STILLS === undefined, "BAKERY_STILLS_DIR is not set");
        test.skip(
          isMobile,
          "the stills set their own sizes; one project takes them",
        );
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        const world = scenario.world();
        await fixture(page, world);
        await page.goto(scenario.path);
        const region = page.getByTestId(scenario.testId);
        await expect(region).toBeVisible();
        // Settle the data before the picture: the list and the page load first.
        await expect(page.getByLabel("Loading connections.")).toHaveCount(0);
        await expect(page.getByText("Loading repositories.")).toHaveCount(0);
        await scenario.act?.(page, world);
        await region.scrollIntoViewIfNeeded();
        await region.screenshot({
          path: `${STILLS}/${scenario.name}-${label}-${scheme}.png`,
        });
      });
    }
  }
}

test("a workspace another organization holds gets its own plain message", async ({ page }) => {
  await fixture(page, newWorld());
  await page.goto(`${PAGE_PATH}?githubConnection=held_elsewhere`);
  await expect(outcomeBanner(page)).toContainText(
    "Another organization in Bakery already holds this connection, so nothing was connected. It can be connected here once that organization removes it.",
  );
  await still(page, "connection-outcome-held-elsewhere");
});
