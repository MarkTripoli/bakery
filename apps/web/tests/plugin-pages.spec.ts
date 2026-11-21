import {
  expect as baseExpect,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";
import { shot } from "./helpers/real-api.ts";

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: laneBudgetMs(60_000) });

// #76 revision 5: a plugin's own page opens in a sealed frame under Bakery's
// strip, the rail lists the pages, and the plugin's settings page lists them.

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOTES = id(101);
const NOTES_V1 = id(111);
const INSTALL = id(201);
const PAGE = "release-checklist";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const entry = (pageId: string, title: string) => ({
  installId: INSTALL,
  pageId,
  title,
  pluginPackageId: NOTES,
  pluginDisplayName: "Notes",
  pluginVersionId: NOTES_V1,
  versionName: "1.0.0",
  scope: "organization",
  documentPath: `/v1/plugin-installs/${INSTALL}/pages/${pageId}/document`,
});
const access = (
  reason:
    | "off"
    | "removed"
    | "no_such_page"
    | "no_access"
    | "not_granted"
    | null,
) => ({
  ...entry(PAGE, "Release checklist"),
  status: reason === null ? "available" : "refused",
  reason,
  ...(reason === null ? {} : { title: null, documentPath: null }),
});

type Fixture = {
  pages: ReturnType<typeof entry>[];
  /** What the page read answers with; a number is a failing status. */
  answer: ReturnType<typeof access> | number;
  status: "enabled" | "disabled";
  documents: string[];
};

async function pluginPagesFixture(
  page: Page,
  options: { role?: "admin" | "viewer" } = {},
): Promise<Fixture> {
  const state: Fixture = {
    pages: [entry(PAGE, "Release checklist")],
    answer: access(null),
    status: "enabled",
    documents: [],
  };
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/**`,
    (route: Route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}`,
    (route) =>
      route.fulfill(json({
        id: MOCK_ORGANIZATION_ID,
        name: "Fixture Org",
        slug: "fixture-org",
        logo: null,
        metadata: {},
        defaultLocale: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        version: 1,
      })),
  );
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: options.role ?? "admin",
        capabilities: ["pluginInstall:read"],
      })),
  );
  await page.route("**/v1/plugin-packages?**", (route) =>
    route.fulfill(json({
      items: [{
        id: NOTES,
        organizationId: MOCK_ORGANIZATION_ID,
        name: "notes",
        displayName: "Notes",
        provenance: {},
        license: "MIT",
        visibility: "private",
        listingStatus: "unlisted",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        version: 1,
      }],
      nextCursor: null,
    })));
  await page.route(
    "**/v1/plugin-packages/*/versions**",
    (route) =>
      route.fulfill(json({
        items: [{
          id: NOTES_V1,
          organizationId: MOCK_ORGANIZATION_ID,
          pluginPackageId: NOTES,
          versionName: "1.0.0",
          sdkRange: "^1",
          manifest: { requestedCapabilities: ["ui.page"] },
          bundleDigest: `sha256:${"ab".repeat(32)}`,
          sourceEvidence: {},
          buildEvidence: {},
          publishedAt: "2026-11-03T00:00:00.000Z",
          createdAt: "2026-11-03T00:00:00.000Z",
          updatedAt: "2026-11-03T00:00:00.000Z",
          version: 1,
        }],
        nextCursor: null,
      })),
  );
  // The generic installs route first: the more specific ones below win.
  await page.route("**/v1/plugin-installs**", (route) =>
    route.fulfill(json({
      items: [{
        id: INSTALL,
        organizationId: MOCK_ORGANIZATION_ID,
        pluginPackageId: NOTES,
        pluginVersionId: NOTES_V1,
        scope: "organization",
        ownerPrincipalId: null,
        status: state.status,
        stateSchemaVersion: 1,
        activatedAt: "2026-11-02T00:00:00.000Z",
        disabledAt: null,
        createdAt: "2026-11-02T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
        version: 3,
      }],
      nextCursor: null,
    })));
  // The saved-data list the settings page shows under "Pages it adds".
  await page.route(
    `**/v1/plugin-installs/${INSTALL}/state-items**`,
    (route) =>
      route.fulfill(json({
        items: [{
          id: id(301),
          pluginInstallId: INSTALL,
          namespace: "checklist",
          key: "release-1",
          sizeBytes: 2048,
          createdAt: "2026-11-09T09:30:00.000Z",
          updatedAt: "2026-11-10T09:30:00.000Z",
        }, {
          id: id(302),
          pluginInstallId: INSTALL,
          namespace: "checklist",
          key: "release-2",
          sizeBytes: 512,
          createdAt: "2026-11-11T14:05:00.000Z",
          updatedAt: "2026-11-12T14:05:00.000Z",
        }],
        nextCursor: null,
      })),
  );
  await page.route("**/v1/plugin-pages**", (route) =>
    route.fulfill(json({
      items: state.status === "enabled" ? state.pages : [],
      nextCursor: null,
    })));
  await page.route(`**/v1/plugin-installs/${INSTALL}/pages/**`, (route) => {
    if (route.request().url().includes("/document")) {
      state.documents.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body:
          "<!doctype html><title>Release checklist</title><body style='font-family:sans-serif;margin:24px'><h1>Release checklist</h1><p>Made by the plugin Notes.</p></body>",
      });
    }
    return typeof state.answer === "number"
      ? route.fulfill({ status: state.answer, body: "{}" })
      : route.fulfill(json(state.answer));
  });
  return state;
}

/** On a phone the rail is in the drawer. */
const openRail = async (page: Page) => {
  if ((page.viewportSize()?.width ?? 1440) < 744) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
};

const open = (page: Page) =>
  page.goto(`/plugins/${INSTALL}/${PAGE}`, { waitUntil: "domcontentloaded" });

/** The drawer is tall: scroll it to its end so the account menu is in the still. */
const railShot = async (page: Page, name: string) => {
  const drawer = page.getByRole("dialog");
  if (await drawer.count() > 0) {
    // The pointer stays where the menu button was; park it on the scrim so no row
    // in the still wears a hover fill.
    await page.mouse.move(380, 420);
    await shot(page, name, [], { only: "mobile", scrollToEnd: drawer });
  } else await shot(page, name);
};

test("a plugin page opens under Bakery's strip in a sealed frame that is told how Bakery looks", async ({ page }) => {
  const state = await pluginPagesFixture(page);
  await open(page);
  await expect(
    page.getByRole("heading", { name: "Release checklist", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("Provided by the plugin Notes, version 1.0.0"),
  ).toBeVisible();
  const frame = page.locator("iframe.ui-sealed-frame");
  await expect(frame).toHaveAttribute(
    "title",
    "Release checklist, provided by the plugin Notes",
  );
  // Scripts only: no same-origin right, no forms, popups or navigation.
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  const src = new URL((await frame.getAttribute("src")) ?? "", "http://x");
  expect(src.pathname).toBe(
    `/v1/plugin-installs/${INSTALL}/pages/${PAGE}/document`,
  );
  expect(src.searchParams.get("organizationId")).toBe(MOCK_ORGANIZATION_ID);
  expect(["light", "dark"]).toContain(src.searchParams.get("theme"));
  expect(src.searchParams.get("dir")).toBe("ltr");
  expect(src.searchParams.get("locale")).not.toBeNull();
  await expect(
    page.frameLocator("iframe.ui-sealed-frame").getByText(
      "Made by the plugin Notes.",
    ),
  ).toBeVisible();
  expect(state.documents.length).toBeGreaterThan(0);
  // The strip and frame as they are, with the phone drawer still closed.
  await shot(page, "plugin-page");
  // The rail names the pages' owner: a Plugins group, after Settings.
  await openRail(page);
  const group = page.getByRole("group", { name: "Plugins" });
  await expect(group.getByRole("link", { name: "Release checklist" }))
    .toBeVisible();
  const settings = await page.getByRole("link", { name: "Settings" }).first()
    .boundingBox();
  const mine = await group.getByRole("link", { name: "Release checklist" })
    .boundingBox();
  if (settings === null || mine === null) throw new Error("no boxes");
  expect(mine.y).toBeGreaterThan(settings.y);
  // Opening a page is not an update: no notice says the plugin changed.
  await expect(page.getByText(/was updated to/)).toHaveCount(0);
  await railShot(page, "plugin-page-rail");
});

test("a page that cannot be shown says why in place of the frame", async ({ page }) => {
  const state = await pluginPagesFixture(page);
  const cases: [Fixture["answer"], string][] = [
    [access("off"), "Notes is turned off"],
    [access("no_such_page"), "This page is no longer here"],
    [access("removed"), "This page is no longer here"],
    [access("no_access"), "You do not have access to this page"],
  ];
  for (const [answer, words] of cases) {
    state.answer = answer;
    await open(page);
    await expect(page.getByText(words)).toBeVisible();
    await expect(page.locator("iframe.ui-sealed-frame")).toHaveCount(0);
    // A state that replaces the frame brings its own button: the strip has none.
    await expect(page.getByRole("button", { name: "Reload" })).toHaveCount(0);
    if (words === "Notes is turned off") {
      await expect(page.getByText("Off", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Manage plugin" }))
        .toHaveCount(1);
      await shot(page, "plugin-page-off");
    }
  }
});

test("seven pages show the first six and a way to the rest", async ({ page }) => {
  const state = await pluginPagesFixture(page);
  state.pages = Array.from(
    { length: 7 },
    (_, index) => entry(`page-${index + 1}`, `Plugin page ${index + 1}`),
  );
  await open(page);
  await openRail(page);
  const group = page.getByRole("group", { name: "Plugins" });
  await expect(group.getByRole("link")).toHaveCount(7);
  await expect(group.getByRole("link", { name: "Plugin page 6" }))
    .toBeVisible();
  await expect(group.getByRole("link", { name: "Plugin page 7" })).toHaveCount(
    0,
  );
  await expect(group.getByRole("link", { name: "More plugin pages" }))
    .toBeVisible();
  await railShot(page, "plugin-rail-seven");
});

test("on the compact rail the pages keep their names as tooltips", async ({ page }) => {
  await pluginPagesFixture(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await open(page);
  const link = page.getByRole("group", { name: "Plugins" }).getByRole("link");
  await expect(link).toHaveAttribute("title", "Release checklist");
});

test("a page that failed to load says so and tries again", async ({ page }) => {
  const state = await pluginPagesFixture(page);
  state.answer = 500;
  await open(page);
  await expect(page.getByText("This plugin page could not be shown"))
    .toBeVisible();
  await expect(
    page.getByText(
      "Bakery could not load it. The rest of Bakery is not affected.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toHaveCount(0);
  await shot(page, "plugin-page-failed");
  state.answer = access(null);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("iframe.ui-sealed-frame")).toBeVisible();
});

test("the rail lists a plugin's pages, and its settings page lists them with Open", async ({ page }) => {
  const state = await pluginPagesFixture(page);
  await page.goto("/settings/organization/plugins/" + INSTALL, {
    waitUntil: "domcontentloaded",
  });
  state.pages = [
    entry(PAGE, "Release checklist"),
    entry("handover-notes", "Handover notes"),
  ];
  await page.reload({ waitUntil: "domcontentloaded" });
  const section = page.getByTestId("plugin-pages");
  await expect(section.getByRole("heading", { name: "Pages it adds" }))
    .toBeVisible();
  await expect(
    section.getByText("Each one is also in the sidebar under Plugins."),
  )
    .toBeVisible();
  await expect(section.getByText("Release checklist")).toBeVisible();
  await expect(section.getByText("Handover notes")).toBeVisible();
  await expect(page.getByText("Saved data could not be loaded")).toHaveCount(0);
  await shot(page, "plugin-pages-it-adds");
  await section.getByRole("button", { name: "Open Release checklist" }).click();
  await expect(page).toHaveURL(new RegExp(`/plugins/${INSTALL}/${PAGE}$`));
  await openRail(page);
  await expect(
    page.getByRole("link", { name: "Release checklist" }),
  ).toBeVisible();
  // Off: the pages are hidden, and a version with none says so.
  state.status = "disabled";
  await page.goto("/settings/organization/plugins/" + INSTALL, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByText("Hidden while it is off")).toBeVisible();
  state.status = "enabled";
  state.pages = [];
  await page.goto("/settings/organization/plugins/" + INSTALL, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByText("This version adds no pages.")).toBeVisible();
});
