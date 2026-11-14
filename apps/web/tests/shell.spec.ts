import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  openAccountMenu,
  revealShellNavigation,
} from "./helpers/shell-navigation.ts";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { shot } from "./helpers/real-api.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { firstRender } from "./helpers/first-render.ts";

registerPageHealth(test);

type RouteCoverageEntry = {
  readonly id: string;
  readonly path: string;
  readonly classification: string;
  readonly states: readonly string[];
};

type RouteCoverage = {
  readonly routes: readonly RouteCoverageEntry[];
  readonly shellStates: readonly string[];
  readonly authStates: readonly string[];
};

function routeEntry(candidate: unknown): RouteCoverageEntry {
  if (candidate === null || typeof candidate !== "object") {
    throw new Error("route entry must be an object");
  }
  if (
    !("id" in candidate) || typeof candidate.id !== "string" ||
    !("path" in candidate) || typeof candidate.path !== "string" ||
    !("classification" in candidate) ||
    typeof candidate.classification !== "string" ||
    !("states" in candidate) || !Array.isArray(candidate.states)
  ) {
    throw new Error(
      "route entry must declare id, path, classification, states",
    );
  }
  const states: unknown[] = candidate.states;
  for (const state of states) {
    if (typeof state !== "string") {
      throw new Error(`route ${candidate.id} must declare string states`);
    }
  }
  return {
    id: candidate.id,
    path: candidate.path,
    classification: candidate.classification,
    states: states.map(String),
  };
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} must be strings`);
    return entry;
  });
}

/**
 * Reads canonical route coverage from the DEV-only `window.__bakeryRouteCoverage`
 * hook that `src/router.tsx` installs. The data is the app's own, evaluated in
 * the page; no /src module is imported, so it works under `vite preview`.
 */
async function readRouteCoverage(page: Page): Promise<RouteCoverage> {
  const value: unknown = await page.evaluate(
    `(() => {
      const hook = window.__bakeryRouteCoverage;
      if (!hook) throw new Error("route coverage hook missing");
      return {
        routes: hook.routeCoverage.map((route) => ({
          id: route.id,
          path: route.path,
          classification: route.classification,
          states: [...route.states],
        })),
        shellStates: [...hook.shellFixtureStates],
        authStates: [...hook.authFixtureStates],
      };
    })()`,
  );
  if (
    value === null || typeof value !== "object" ||
    !("routes" in value) || !Array.isArray(value.routes) ||
    !("shellStates" in value) || !("authStates" in value)
  ) {
    throw new Error("route coverage module did not expose routes and states");
  }
  const routes: unknown[] = value.routes;
  return {
    routes: routes.map(routeEntry),
    shellStates: stringArray(value.shellStates, "shell state"),
    authStates: stringArray(value.authStates, "auth fixture state"),
  };
}

/**
 * Known auth fixture screen ids, longest first so a screen name that is
 * itself a prefix of another (`invite` / `invite-login`) never matches
 * short. Mirrors the ids `AuthStateFixture.tsx` prefixes with.
 */
const AUTH_FIXTURE_SCREENS = [
  "setup",
  "login",
  "expired",
  "join",
  "register",
  "invite",
  "invite-login",
  "organizations",
  "security",
  "sessions",
  "revoke-client",
  "revoke",
  "clients",
  "consent",
  "totp-challenge",
  "two-factor",
  "totp-setup",
  "backup-codes",
  "totp-disable",
  "backup-challenge",
  "signout",
  "security-hub",
  "password",
  "passkeys",
  "passkey-add",
  "reauth",
  "profile",
  "appearance",
  "your-access",
  "section-index",
].sort((a, b) => b.length - a.length);

/** The auth fixture screens `isSettingsPath` (`auth-paths.ts`) places in the settings shell. */
const SETTINGS_SHELL_AUTH_SCREENS = [
  "section-index",
  "profile",
  "appearance",
  "your-access",
  "security",
  "sessions",
  "revoke",
  "revoke-client",
  "clients",
  "two-factor",
  "totp-setup",
  "backup-codes",
  "totp-disable",
  "password",
  "passkeys",
  "passkey-add",
];

function authFixtureBareState(token: string): string {
  const screen = AUTH_FIXTURE_SCREENS.find((id) => token.startsWith(`${id}-`));
  if (!screen) throw new Error(`unrecognised auth fixture token ${token}`);
  return token.slice(screen.length + 1);
}

function routedCases(
  coverage: RouteCoverage,
): readonly { readonly id: string; readonly path: string }[] {
  return coverage.routes.flatMap((route) => {
    if (route.id === "fixture-auth") {
      return coverage.authStates.map((state) => ({
        id: `${route.id}:${state}`,
        path: route.path.replace("$state", state),
      }));
    }
    return route.path.includes("$state")
      ? route.states.map((state) => ({
        id: `${route.id}:${state}`,
        path: route.path.replace("$state", state),
      }))
      : [{ id: route.id, path: route.path }];
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() =>
    page.evaluate(() =>
      document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    )
  ).toBe(true);
}

async function expectSelectedParent(page: Page, path: string) {
  if (path === "/settings" || path.startsWith("/settings/")) {
    const expectedHref = path.startsWith("/settings/sessions")
      ? "/settings/sessions"
      : path.startsWith("/settings/clients")
      ? "/settings/clients"
      : path === "/settings" || path.startsWith("/settings/profile")
      ? "/settings/profile"
      : path.startsWith("/settings/security")
      ? "/settings/security"
      : path.startsWith("/settings/access")
      ? "/settings/access"
      : path.startsWith("/settings/organization/access")
      ? "/settings/organization/access"
      : path.startsWith("/settings/organization/roles")
      ? "/settings/organization/roles"
      : path.startsWith("/settings/organization/repository-rules")
      ? "/settings/organization/repository-rules"
      : path.startsWith("/settings/organization/integrations")
      ? "/settings/organization/integrations"
      : path.startsWith("/settings/organization/sso")
      ? "/settings/organization/sso"
      : path.startsWith("/settings/audit")
      ? "/settings/audit"
      : path.startsWith("/settings/scim")
      ? "/settings/scim"
      : path.startsWith("/settings/installation/integrations")
      ? "/settings/installation/integrations"
      : "/settings/appearance";
    await expect(
      page.locator(
        `.bakery-section-navigation a[aria-current="page"][href="${expectedHref}"]`,
      ),
    ).toHaveCount(1);
    return;
  }
  if (path === "/machines" || path.startsWith("/machines/")) {
    // Machines is a main rail destination, not a settings section: these pages
    // use the frame Work uses, so there is no settings navigation at all.
    await expect(page.locator(".bakery-section-navigation")).toHaveCount(0);
    return;
  }
  // Paper `settingsShell` fixtures (`isSettingsPath` in `auth-paths.ts`):
  // the account-settings specimens render inside the production settings
  // shell so the parity gate can compare the real `<main>` box. The section
  // navigation is present, but no production href matches a fixture path,
  // so nothing is marked current.
  const authFixture = "/__fixtures__/auth/";
  if (
    path.startsWith(authFixture) &&
    SETTINGS_SHELL_AUTH_SCREENS.some((screen) =>
      path.startsWith(`${authFixture}${screen}-`)
    )
  ) {
    // Sidebar list at desktop, `<details>` menu on phone — the container
    // class is the one thing both modes share.
    await expect(page.locator(".bakery-section-navigation").first())
      .toBeAttached();
    await expect(
      page.locator('.bakery-section-navigation a[aria-current="page"]'),
    ).toHaveCount(0);
    return;
  }
  if (!path.startsWith("/__fixtures__/settings")) {
    await expect(
      page.getByRole("navigation", { name: "Settings sections" }),
    ).toHaveCount(0);
    return;
  }

  const expected = path.startsWith("/__fixtures__/settings/security")
    ? "Account & security"
    : path.startsWith("/__fixtures__/settings/sessions")
    ? "Active sessions"
    : path.startsWith("/__fixtures__/settings/clients")
    ? "Connected clients"
    : path.startsWith("/__fixtures__/settings/appearance")
    ? "Appearance"
    : path.startsWith("/__fixtures__/settings/access")
    ? "Your access"
    : path === "/__fixtures__/settings"
    ? null
    : "Profile";

  if (expected) {
    await expect(
      page.locator('.bakery-section-navigation a[aria-current="page"]', {
        hasText: expected,
      }).first(),
    ).toHaveAttribute("aria-current", "page");
  }
}

type RouteMatrixCase = { readonly id: string; readonly path: string };

const ROUTE_MATRIX_SNAPSHOT = new URL(
  "./helpers/route-matrix-cases.json",
  import.meta.url,
);
const UPDATE_COMMAND =
  "BAKERY_UPDATE_ROUTE_MATRIX=1 pnpm --dir apps/web exec playwright test shell.spec.ts --project=desktop --workers=1 -g 'manifest route matrix phone route manifest matches the running app'";
const UPDATING_ROUTE_MATRIX = process.env.BAKERY_UPDATE_ROUTE_MATRIX === "1";

/** Reads the committed case list; only a missing file in update mode is empty. */
function readRouteMatrixSnapshot(): readonly RouteMatrixCase[] {
  let text: string;
  try {
    text = readFileSync(ROUTE_MATRIX_SNAPSHOT, "utf8");
  } catch (error) {
    if (
      UPDATING_ROUTE_MATRIX && error instanceof Error && "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw new Error(
      `route matrix snapshot unreadable; regenerate with: ${UPDATE_COMMAND}`,
      { cause: error },
    );
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `route matrix snapshot must be a non-empty array; regenerate with: ${UPDATE_COMMAND}`,
    );
  }
  const seen = new Set<string>();
  return parsed.map((entry: unknown): RouteMatrixCase => {
    if (
      entry === null || typeof entry !== "object" || !("id" in entry) ||
      typeof entry.id !== "string" || !("path" in entry) ||
      typeof entry.path !== "string"
    ) {
      throw new Error("route matrix snapshot entries need string id and path");
    }
    if (seen.has(entry.id)) {
      throw new Error(`route matrix snapshot repeats id ${entry.id}`);
    }
    seen.add(entry.id);
    return { id: entry.id, path: entry.path };
  });
}

/** Atomically rewrites the snapshot; refused under CI. */
function writeRouteMatrixSnapshot(cases: readonly RouteMatrixCase[]): void {
  if (process.env.CI) {
    throw new Error("route matrix snapshot cannot be rewritten under CI");
  }
  const target = fileURLToPath(ROUTE_MATRIX_SNAPSHOT);
  const temporary = `${target}.tmp-${process.pid}`;
  const body = JSON.stringify(
    cases.map(({ id, path }) => ({ id, path })),
    null,
    2,
  ) + "\n";
  writeFileSync(temporary, body);
  renameSync(temporary, target);
}

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 744, height: 960 },
  { name: "desktop", width: 1280, height: 960 },
] as const;
const MATRIX_CASE_TIMEOUT_MS = 60_000;

async function assertRouteCase(
  page: Page,
  route: RouteMatrixCase,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  await mockAuthenticatedSession(page);
  await page.setViewportSize(viewport);
  const phoneIndex = route.path === "/settings" &&
    viewport.width < 744;
  await firstRender(() => page.goto(route.path), async (timeout) => {
    if (route.path === "/settings") {
      await expect(page).toHaveURL(
        phoneIndex ? "/settings" : "/settings/profile",
        { timeout },
      );
    }
    await expect(page.locator("main h1")).toHaveCount(1, { timeout });
  });
  await expect(
    page.locator(".bakery-section-navigation")
      .getByRole("link", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  if (!phoneIndex) {
    await expectSelectedParent(page, route.path);
  }
  await expectNoHorizontalOverflow(page);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations, route.id).toEqual([]);
}

test.describe("manifest route matrix", () => {
  // Every routed case (the auth screens times their design states plus the
  // shell/settings fixtures) is a navigation plus an axe scan at three
  // viewports. Each (viewport, case) is its own test so Playwright spreads
  // and reports them individually and none nears its budget under runner
  // contention. The case list is committed in helpers/route-matrix-cases.json
  // because it only exists at runtime; a guard per viewport proves it still
  // matches the running app. Regenerate (never under CI) with UPDATE_COMMAND.
  test.skip(
    ({ isMobile }) => isMobile,
    "route matrix runs in the desktop project only",
  );
  const snapshot = readRouteMatrixSnapshot();
  for (const viewport of VIEWPORTS) {
    test(
      `${viewport.name} route manifest matches the running app`,
      async ({ page }) => {
        test.skip(
          UPDATING_ROUTE_MATRIX && viewport.name !== "phone",
          "only the phone guard rewrites the snapshot",
        );
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await mockAuthenticatedSession(page);
        await page.setViewportSize(viewport);
        await page.goto("/");
        const coverage = await readRouteCoverage(page);
        const shellRoute = coverage.routes.find((route) =>
          route.path === "/__fixtures__/shell/$state"
        );
        expect(shellRoute?.states).toEqual(coverage.shellStates);

        const authRoute = coverage.routes.find((route) =>
          route.id === "fixture-auth"
        );
        expect(authRoute).toBeDefined();
        const bareStates = [
          ...new Set(coverage.authStates.map(authFixtureBareState)),
        ].sort();
        expect([...(authRoute?.states ?? [])].sort()).toEqual(bareStates);

        const cases = routedCases(coverage);
        expect(cases.length).toBeGreaterThan(0);
        if (UPDATING_ROUTE_MATRIX) {
          writeRouteMatrixSnapshot(cases);
        } else {
          expect(cases, `regenerate with: ${UPDATE_COMMAND}`).toEqual(
            snapshot,
          );
        }
      },
    );
    for (const route of snapshot) {
      test(`${viewport.name} ${route.id}`, async ({ page }) => {
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await assertRouteCase(page, route, viewport);
      });
    }
  }
});

test("keeps shell navigation and route focus native", async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto("/__fixtures__/settings/profile");
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  await expect(page).toHaveURL("/__fixtures__/settings/appearance");
  await expect(page.getByRole("heading", { name: "Appearance", exact: true }))
    .toBeFocused();

  // Paper's Work destination is the task queue (5J-0).
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await expect(page).toHaveURL("/tasks");
  await expect(page.locator("main h1")).toBeFocused();
});

test.describe("settings routes and navigation", () => {
  const RENAMED: readonly {
    readonly path: string;
    readonly heading: string | RegExp;
    readonly selected: string;
  }[] = [
    {
      path: "/settings/security",
      heading: "Account and security",
      selected: "/settings/security",
    },
    {
      path: "/settings/security/two-factor",
      heading: /Two-factor authentication/,
      selected: "/settings/security",
    },
    {
      path: "/settings/security/two-factor/setup",
      heading: /authenticator/i,
      selected: "/settings/security",
    },
    {
      path: "/settings/sessions",
      heading: "Active sessions",
      selected: "/settings/sessions",
    },
    {
      path: "/settings/sessions/revoke",
      heading: /sessions?/i,
      selected: "/settings/sessions",
    },
    {
      path: "/settings/appearance",
      heading: "Appearance",
      selected: "/settings/appearance",
    },
  ];

  for (const route of RENAMED) {
    test(`${route.path} renders one h1 and keeps its section selected`, async ({ page }) => {
      await mockAuthenticatedSession(page);
      await page.setViewportSize({ width: 1280, height: 960 });
      await page.goto(route.path);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.locator("main h1")).toHaveText(route.heading);
      await expect(
        page.locator(
          `.bakery-section-navigation a[aria-current="page"][href="${route.selected}"]`,
        ),
      ).toHaveCount(1);
      await expect(page).toHaveURL(route.path);
    });
  }

  /** The person's role in the organization, which decides whether the Organization group shows. */
  async function stubRole(page: Page, role: "admin" | "developer") {
    await page.route(
      `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            organizationId: MOCK_ORGANIZATION_ID,
            role,
            capabilities: [],
          }),
        }),
    );
  }

  test("a member without administrator rights does not see the Organization group", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await stubRole(page, "developer");
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.goto("/settings/sessions");
    await expect(page.getByText("This device")).toBeVisible();
    const navigation = page.getByRole("navigation", {
      name: "Settings sections",
    }).first();
    await expect(navigation.getByRole("list", { name: "Your account" }))
      .toBeVisible();
    await expect(navigation.getByRole("list", { name: "Organization" }))
      .toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "Members & access" }))
      .toHaveCount(0);
    await shot(page, "settings-navigation-member");
  });

  test("a sub-page keeps its section selected and names itself in the breadcrumb, with no back link", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.goto("/settings/security/password");
    await expect(page.locator("main h1")).toBeVisible();
    const navigation = page.getByRole("navigation", {
      name: "Settings sections",
    }).first();
    await expect(navigation.getByRole("link", { name: "Account & security" }))
      .toHaveAttribute("aria-current", "page");
    const trail = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(trail).toContainText("Settings");
    await expect(trail).toContainText("Account & security");
    await expect(trail.locator("[aria-current=page]")).toHaveText(
      "Change password",
    );
    // The breadcrumb does the back link's job.
    await expect(
      page.locator("main").getByRole("link", { name: "Account and security" }),
    ).toHaveCount(0);
    await shot(page, "settings-subpage-selected");
  });

  test("every settings page opens with one title style and one typeface", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await stubRole(page, "admin");
    // Your access reads the organization's name.
    await page.route(
      `**/v1/organizations/${MOCK_ORGANIZATION_ID}`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: MOCK_ORGANIZATION_ID,
            name: "Fixture Org",
            slug: "fixture-org",
            logo: null,
            defaultLocale: null,
            metadata: {},
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          }),
        }),
    );
    await page.route("**/v1/me/profile", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          principalId: "00000000-0000-4000-8000-000000000001",
          name: "Alex Morgan",
          firstName: "Alex",
          lastName: "Morgan",
          title: null,
          image: null,
          email: "alex.morgan@example.com",
          emailVerified: true,
          version: 3,
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      }));
    await page.setViewportSize({ width: 1440, height: 960 });
    const styles: string[] = [];
    const columns: string[] = [];
    for (
      const path of [
        "/settings/profile",
        "/settings/sessions",
        "/settings/clients",
        "/settings/appearance",
        "/settings/access",
      ]
    ) {
      await page.goto(path);
      const title = page.locator("main h1");
      await expect(title).toBeVisible();
      await shot(
        page,
        `settings-title${path.replace("/settings", "").replace("/", "-")}`,
      );
      styles.push(
        await title.evaluate((node) => {
          const style = getComputedStyle(node);
          return `${style.fontFamily} ${style.fontSize}/${style.lineHeight} ${style.fontWeight}`;
        }),
      );
      // One content width on every settings page (the personal pages used to
      // fill the main and Appearance was narrower).
      const width = await page.locator("main .ui-settings-content").first()
        .evaluate((node) => Math.round(node.getBoundingClientRect().width));
      columns.push(`${width}`);
    }
    expect(new Set(columns).size, columns.join(" | ")).toBe(1);
    expect(columns[0]).toBe("760");
    expect(new Set(styles).size, styles.join(" | ")).toBe(1);
    // The app's typeface, not the platform font the personal pages used to set.
    expect(styles[0]).toMatch(/^Geist\b/);
  });

  test("lists the sections under two labelled groups, with the connected-clients item and without Machines", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await stubRole(page, "admin");
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.goto("/settings/sessions");
    await expect(page.getByText("This device")).toBeVisible();
    const navigation = page.getByRole("navigation", {
      name: "Settings sections",
    }).first();
    // Two groups, in order, each a list named by its heading.
    await expect(navigation.locator(".bakery-section-navigation__heading"))
      .toHaveText(["Your account", "Organization"]);
    await expect(
      navigation.getByRole("list", { name: "Your account" }).getByRole("link"),
    ).toHaveText([
      "Profile",
      "Account & security",
      "Active sessions",
      "Connected clients",
      "Appearance",
      "Your access",
    ]);
    await expect(
      navigation.getByRole("list", { name: "Organization" }).getByRole("link"),
    ).toHaveText([
      "Members & access",
      "Custom roles",
      "Repository rules",
      "Integrations",
      "Audit log",
      "Single sign-on",
      "User provisioning",
    ]);
    // Machines is in the main rail only.
    await shot(page, "settings-navigation-grouped");
    await expect(navigation.getByRole("link", { name: "Machines" }))
      .toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Machines", exact: true }).first(),
    ).toBeVisible();
  });

  test("on a phone the settings menu opens one sheet with both groups as headings", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/sessions");
    await expect(page.getByText("This device")).toBeVisible();
    await page.locator(".bakery-section-navigation__summary").click();
    const sheet = page.locator(".bakery-section-navigation__mobile");
    await expect(sheet.locator(".bakery-section-navigation__heading"))
      .toHaveText(["Your account", "Organization"]);
    await shot(page, "settings-navigation-sheet");
    // Headings are not controls, and every link is reachable and not truncated.
    await expect(
      sheet.locator(
        ".bakery-section-navigation__heading a, .bakery-section-navigation__heading button",
      ),
    )
      .toHaveCount(0);
    const links = sheet.getByRole("link");
    await expect(links).toHaveCount(13);
    for (let index = 0; index < 13; index += 1) {
      const clipped = await links.nth(index).evaluate((node) =>
        node.scrollWidth > node.clientWidth + 1
      );
      expect(clipped).toBe(false);
    }
  });

  test("a phone gets the section index at /settings and each row opens its page", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings");
    await expect(page).toHaveURL("/settings");
    await expect(page.locator("main h1")).toHaveText("Settings");
    await expect(page.locator("main .ui-settings-index-row")).toHaveText([
      /Profile/,
      /Account & security/,
      /Active sessions/,
      /Appearance/,
      /Your access/,
    ]);
    await page.getByRole("link", { name: /Appearance/ }).click();
    await expect(page).toHaveURL("/settings/appearance");
  });

  test("the Settings rail link and /settings land on Profile", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.goto("/settings");
    await expect(page).toHaveURL("/settings/profile");
    await page.goto("/tasks");
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL("/settings/profile");
    await expect(page.locator("main h1")).toBeFocused();
  });

  test("settings pages claim the breadcrumb region in the top bar", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.goto("/settings/sessions");
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(breadcrumb).toContainText("Settings");
    await expect(breadcrumb).toContainText("Active sessions");
    await expect(breadcrumb.locator("[aria-current=page]")).toHaveText(
      "Active sessions",
    );
  });

  test("organization settings is reached from the account menu, outside the Settings tree", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.goto("/tasks");
    const menu = await openAccountMenu(page, "Fixture Admin");
    await menu.getByRole("button", { name: "Organization settings" }).click();
    await expect(page).toHaveURL("/organization/settings");
    await expect(page.locator("main h1")).toHaveText("Organization settings");
    await expect(page.locator("main h1")).toBeFocused();
    // It is organization administration, not a personal section.
    await expect(page.locator(".bakery-section-navigation")).toHaveCount(0);
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(breadcrumb).toContainText("Settings");
    await expect(breadcrumb).toContainText("Organization settings");
  });

  test("organization settings is reached from the workspace switcher", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.goto("/tasks");
    await revealShellNavigation(page);
    // The rail names the organization the person is in.
    const switcher = page.locator('[data-ui-component="workspaceSwitcher"]');
    await expect(switcher).toContainText("Fixture Org");
    await switcher.locator("button[aria-expanded]").click();
    await page.getByRole("button", { name: "Organization settings" }).click();
    await expect(page).toHaveURL("/organization/settings");
  });
});

test("the account and organization triggers stay one row when a name is long, and the full name is their title", async ({ page, isMobile }) => {
  test.skip(isMobile, "the rail is a wide-screen layout");
  const LONG_PERSON =
    "Fixture Administrator With A Remarkably Long Display Name Indeed";
  await mockAuthenticatedSession(page);
  await page.route("**/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        principalId: "00000000-0000-4000-8000-000000000001",
        principalType: "human",
        displayName: LONG_PERSON,
        locale: "en",
        timeZone: null,
        direction: "ltr",
        catalogVersion: "2",
        twoFactorEnabled: false,
        email: "fixture-admin@example.test",
        backupCodesRemaining: null,
      }),
    }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/settings/sessions");
  await expect(page.getByRole("heading", { name: "Active sessions" }).first())
    .toBeVisible();
  for (
    const trigger of [
      ".bakery-user-menu__trigger",
      ".bakery-workspace-switcher__trigger",
    ]
  ) {
    const row = page.locator(trigger).first();
    await expect(row).toBeVisible();
    // One row: nothing wraps below the avatar, and the chevron stays at the end.
    const name = row.locator("[class$='__name']");
    const rowBox = (await row.boundingBox())!;
    const nameBox = (await name.boundingBox())!;
    expect(nameBox.height).toBeLessThan(28);
    expect(rowBox.height).toBeLessThan(60);
    const chevron = row.locator("svg.ui-icon").last();
    const chevronBox = (await chevron.boundingBox())!;
    expect(chevronBox.x + chevronBox.width).toBeLessThanOrEqual(
      rowBox.x + rowBox.width,
    );
    expect(chevronBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width - 1);
  }
  await shot(page, "account-trigger-long-name");
  const person = page.locator(".bakery-user-menu__name");
  await expect(person).toHaveAttribute("title", LONG_PERSON);
  await expect(person).toHaveCSS("text-overflow", "ellipsis");
  // The full name is still the trigger's accessible name.
  await expect(
    page.locator(".bakery-user-menu .ui-popover__trigger"),
  ).toContainText(LONG_PERSON);
});
