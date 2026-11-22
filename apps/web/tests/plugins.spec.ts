import { AxeBuilder } from "@axe-core/playwright";
import {
  expect as baseExpect,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";
import { shot } from "./helpers/real-api.ts";
import { still } from "./helpers/stills.ts";

// A shared machine can be slow to answer; give each assertion and test room.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: laneBudgetMs(60_000) });

// #76: the Plugins settings pages, against a mocked plugin API. What matters is
// what the person is told (installing gives all of it at once, turning off takes
// it away), what is sent, and that a refused change is never shown as done.

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOTES = id(101);
const BOARD = id(102);
const DASH = id(103);
const NOTES_V1 = id(111);
const NOTES_V2 = id(112);
const BOARD_V1 = id(121);
const DASH_V1 = id(131);
const NOTES_INSTALL = id(201);
const DASH_INSTALL = id(203);

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const problem = (status: number, code: string, reason?: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: `https://bakery.example/problems/${code.toLowerCase()}`,
    title: code,
    detail: code,
    status,
    code,
    retryable: false,
    ...(reason === undefined ? {} : { reason }),
    requestId: "00000000-0000-4000-8000-0000000000e1",
    traceId: "00000000-0000-4000-8000-0000000000e2",
  }),
});

type Install = {
  id: string;
  organizationId: string;
  pluginPackageId: string;
  pluginVersionId: string;
  scope: "organization" | "personal";
  ownerPrincipalId: string | null;
  status: "staged" | "enabled" | "disabled" | "failed" | "uninstalled";
  stateSchemaVersion: number;
  activatedAt: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  lastUpdateFailure?: {
    versionId: string;
    versionName: string;
    reason: string;
    at: string;
  } | null;
};
type Write = {
  method: string;
  path: string;
  body: unknown;
  ifMatch: string | null;
  key: string | null;
};

const pkg = (pluginId: string, displayName: string) => ({
  id: pluginId,
  organizationId: MOCK_ORGANIZATION_ID,
  name: displayName.toLowerCase(),
  displayName,
  provenance: {},
  license: "MIT",
  visibility: "private",
  listingStatus: "unlisted",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  version: 1,
});
const version = (
  versionId: string,
  packageId: string,
  versionName: string,
  publishedAt: string,
  requestedCapabilities: string[],
  evidence: { source?: unknown; build?: unknown } = {},
) => ({
  id: versionId,
  organizationId: MOCK_ORGANIZATION_ID,
  pluginPackageId: packageId,
  versionName,
  sdkRange: "^1",
  manifest: { requestedCapabilities },
  bundleDigest: `sha256:${"ab".repeat(32)}`,
  sourceEvidence: evidence.source ?? {},
  buildEvidence: evidence.build ?? {},
  publishedAt,
  createdAt: publishedAt,
  updatedAt: publishedAt,
  version: 1,
});
const install = (
  overrides: Partial<Install> & Pick<Install, "id">,
): Install => ({
  organizationId: MOCK_ORGANIZATION_ID,
  pluginPackageId: NOTES,
  pluginVersionId: NOTES_V1,
  scope: "organization",
  ownerPrincipalId: null,
  status: "enabled",
  stateSchemaVersion: 1,
  activatedAt: "2026-11-02T00:00:00.000Z",
  disabledAt: null,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  version: 3,
  ...overrides,
});

type Fixture = {
  installs: Install[];
  writes: Write[];
  /** Status the next write answers with, once. */
  refuseNextWrite: { status: number; code: string; reason?: string } | null;
  /** The next version change is refused the way the server does: answered as the install, failure recorded. */
  failNextUpdate: boolean | {
    readonly reason: string;
    readonly addedCapabilities: readonly string[];
  };
  /** What the plugin has saved, and the status the read answers with. */
  saved: SavedItem[];
  savedStatus: number;
  /** Requests the page made to the full state read, which returns the values. */
  valuesReads: number;
};
type SavedItem = {
  id: string;
  namespace: string;
  key: string;
  sizeBytes: number;
  updatedAt: string;
};

async function pluginsFixture(
  page: Page,
  options: { role?: "admin" | "developer" | "viewer"; installs?: Install[] } =
    {},
): Promise<Fixture> {
  const state: Fixture = {
    installs: options.installs ?? [
      install({ id: NOTES_INSTALL }),
      install({
        id: DASH_INSTALL,
        pluginPackageId: DASH,
        pluginVersionId: DASH_V1,
        scope: "personal",
        ownerPrincipalId: MOCK_PRINCIPAL_ID,
        status: "disabled",
        disabledAt: "2026-11-03T00:00:00.000Z",
      }),
    ],
    writes: [],
    refuseNextWrite: null,
    failNextUpdate: false,
    saved: [
      {
        id: id(401),
        namespace: "settings",
        key: "theme",
        sizeBytes: 412,
        updatedAt: "2026-11-18T10:00:00.000Z",
      },
      {
        id: id(402),
        namespace: "drafts",
        key: "welcome-note",
        sizeBytes: 1126,
        updatedAt: "2026-11-17T09:30:00.000Z",
      },
    ],
    savedStatus: 200,
    valuesReads: 0,
  };
  await mockAuthenticatedSession(page);
  const empty = (route: Route) =>
    route.fulfill(json({ items: [], nextCursor: null }));
  await page.route(`**/v1/organizations/${MOCK_ORGANIZATION_ID}/**`, empty);
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
      items: [pkg(NOTES, "Notes"), pkg(BOARD, "Board"), pkg(DASH, "Dash")],
      nextCursor: null,
    })));
  const versionsOf: Record<string, ReturnType<typeof version>[]> = {
    [NOTES]: [
      version(NOTES_V1, NOTES, "1.0.0", "2026-11-03T00:00:00.000Z", [
        "state.read",
        "state.write",
        "ui.page",
      ], {
        source: {
          repository: "example/notes",
          commit: "deadbeef",
          notes: "n".repeat(300),
        },
        build: { checks: ["typecheck", "lint"], status: "passed" },
      }),
      version(NOTES_V2, NOTES, "1.1.0", "2026-11-10T00:00:00.000Z", [
        "state.read",
        "ui.page",
        "jobs.schedule",
      ]),
    ],
    [BOARD]: [
      version(BOARD_V1, BOARD, "0.3.0", "2026-11-04T00:00:00.000Z", [
        "ui.panel",
        "tools.invoke",
      ]),
    ],
    [DASH]: [
      version(DASH_V1, DASH, "2.0.0", "2026-11-05T00:00:00.000Z", [
        "commands.run",
      ], {
        // One part given, one not, and a long value: the other dialog state.
        source: {
          repository: "example/dash",
          notes: "d".repeat(300),
        },
      }),
    ],
  };
  await page.route("**/v1/plugin-packages/*/versions**", (route) => {
    const packageId = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill(
      json({ items: versionsOf[packageId] ?? [], nextCursor: null }),
    );
  });
  await page.route("**/v1/plugin-installs**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET") {
      return route.fulfill(json({ items: state.installs, nextCursor: null }));
    }
    const headers = request.headers();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    state.writes.push({
      method,
      path,
      body,
      ifMatch: headers["if-match"] ?? null,
      key: headers["idempotency-key"] ?? null,
    });
    if (state.refuseNextWrite) {
      const refusal = state.refuseNextWrite;
      state.refuseNextWrite = null;
      return route.fulfill(
        problem(refusal.status, refusal.code, refusal.reason),
      );
    }
    if (method === "POST") {
      const created = install({
        id: id(300 + state.installs.length),
        pluginPackageId: String(body?.packageId),
        pluginVersionId: String(body?.versionId),
        scope: body?.scope as "organization" | "personal",
        ownerPrincipalId: body?.scope === "personal" ? MOCK_PRINCIPAL_ID : null,
        status: "enabled",
        version: 1,
      });
      state.installs.push(created);
      return route.fulfill(json(created, 201));
    }
    const target = state.installs.find((item) =>
      item.id === path.split("/")[3]
    );
    if (!target) return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
    if (body?.versionId && state.failNextUpdate) {
      const refusal = typeof state.failNextUpdate === "object"
        ? state.failNextUpdate
        : { reason: "plugin_sdk_incompatible", addedCapabilities: [] };
      state.failNextUpdate = false;
      target.lastUpdateFailure = {
        versionId: String(body.versionId),
        versionName: "1.1.0",
        reason: refusal.reason,
        at: "2026-11-19T21:00:00.000Z",
        restoreState: false,
        addedCapabilities: [...refusal.addedCapabilities],
      } as Install["lastUpdateFailure"];
      target.version += 1;
      return route.fulfill(json(target));
    }
    if (body?.dismissUpdateFailure) target.lastUpdateFailure = null;
    if (body?.status) target.status = body.status as Install["status"];
    if (body?.versionId) {
      target.pluginVersionId = String(body.versionId);
      target.lastUpdateFailure = null;
    }
    target.version += 1;
    return route.fulfill(json(target));
  });
  // What the plugin has saved: the values-free read the page uses.
  await page.route("**/v1/plugin-installs/*/state-items**", (route) => {
    if (state.savedStatus !== 200) {
      return route.fulfill(problem(state.savedStatus, "INTERNAL"));
    }
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const page = state.saved.slice(offset, offset + limit);
    return route.fulfill(json({
      items: page.map((item) => ({
        id: item.id,
        pluginInstallId: NOTES_INSTALL,
        namespace: item.namespace,
        key: item.key,
        sizeBytes: item.sizeBytes,
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
      })),
      nextCursor: offset + limit < state.saved.length
        ? String(offset + limit)
        : null,
    }));
  });
  // The full state read returns the saved values. The page must never ask for
  // it, so it counts the asks and would hand back a secret.
  await page.route(/\/v1\/plugin-installs\/[^/]+\/state(\?.*)?$/, (route) => {
    state.valuesReads += 1;
    return route.fulfill(json({
      items: [{ key: "theme", value: { secret: "TOPSECRET-VALUE" } }],
      nextCursor: null,
    }));
  });
  return state;
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("lists what is installed and what can be installed, in words", async ({ page }) => {
      await pluginsFixture(page);
      await page.goto("/settings/organization/plugins");
      const installed = page.getByTestId("plugins-installed");
      await expect(installed.getByText("Notes")).toBeVisible();
      await expect(installed.getByText("Version 1.0.0 · 1.1.0 is available"))
        .toBeVisible();
      await expect(installed.getByText("On", { exact: true })).toBeVisible();
      await expect(installed.getByText("Off", { exact: true })).toBeVisible();
      await expect(installed.getByText("Organization")).toBeVisible();
      await expect(installed.getByText("Private")).toBeVisible();
      await expect(
        installed.getByRole("button", { name: "Review update of Notes" }),
      ).toBeVisible();

      const available = page.getByTestId("plugins-available");
      await expect(available.getByText("Board")).toBeVisible();
      await expect(available.getByRole("button", { name: "Install Board" }))
        .toBeVisible();
      // Installed ones are not offered again, and there is nothing to upload.
      await expect(available.getByText("Notes")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /upload/i })).toHaveCount(
        0,
      );
      expect(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= globalThis.innerWidth
        ),
      ).toBe(true);
      // "Review update" stays on one line, so the row keeps its height.
      const review = installed.getByRole("button", {
        name: "Review update of Notes",
      });
      // Layout settles after fonts and the table load: poll the box, not once.
      await expect
        .poll(async () => (await review.boundingBox())?.height ?? Infinity)
        .toBeLessThan(48);
      await shot(page, `plugins-list-${viewport.name}`);
    });

    test("the list, the install dialog and the plugin page have no accessibility violations", async ({ page }) => {
      // Three axe scans and two navigations take longer than the default.
      test.setTimeout(laneBudgetMs(90_000));
      await pluginsFixture(page);
      await page.goto("/settings/organization/plugins");
      await expect(page.getByTestId("plugins-installed")).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole("button", { name: "Install Board" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      await expect(page.getByRole("heading", { name: "What it can do" }))
        .toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test("installing says what it gives, all at once, and sends exactly that", async ({ page }) => {
      const state = await pluginsFixture(page);
      await page.goto("/settings/organization/plugins");
      await page.getByRole("button", { name: "Install Board" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("What it will be able to do"))
        .toBeVisible();
      await expect(dialog.getByText("Add a panel to Bakery's pages"))
        .toBeVisible();
      await expect(dialog.getByText("Use Bakery's tools")).toBeVisible();
      await expect(
        dialog.getByText(
          "Installing gives it all 2 at once. You cannot pick some of them. Turning it off or removing it takes them away.",
        ),
      ).toBeVisible();
      // Never the old, false promise.
      await expect(dialog.getByText(/gives it no permissions/i)).toHaveCount(0);
      await shot(page, `plugins-install-${viewport.name}`, [], {
        windowOnly: true,
      });

      await dialog.getByRole("button", { name: "Install and allow" }).click();
      await expect(page).toHaveURL(/\/settings\/organization\/plugins\/.+/);
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0].method).toBe("POST");
      expect(state.writes[0].body).toEqual({
        packageId: BOARD,
        versionId: BOARD_V1,
        scope: "organization",
      });
      expect(state.writes[0].key).toBeTruthy();
    });

    test("a person who may only install privately cannot pick the organization", async ({ page }) => {
      const state = await pluginsFixture(page, { role: "developer" });
      await page.goto("/settings/organization/plugins");
      await page.getByRole("button", { name: "Install Board" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Organization")).toBeDisabled();
      await expect(
        dialog.getByText(
          "Only organization administrators can install for everyone.",
        ),
      ).toBeVisible();
      await expect(dialog.getByLabel("Private")).toBeChecked();
      await dialog.getByRole("button", { name: "Install and allow" }).click();
      await expect(page).toHaveURL(/\/settings\/organization\/plugins\/.+/);
      expect(state.writes[0].body).toMatchObject({ scope: "personal" });
    });

    test("with nothing published, the page says so and offers nothing to press", async ({ page }) => {
      await pluginsFixture(page, { installs: [] });
      await page.route(
        "**/v1/plugin-packages?**",
        (route) => route.fulfill(json({ items: [], nextCursor: null })),
      );
      await page.goto("/settings/organization/plugins");
      await expect(page.getByText("No plugins yet")).toBeVisible();
      await expect(
        page.getByText(
          "Plugins are built for your organization and published here. When one is published, it appears on this page to install.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /install|upload/i }))
        .toHaveCount(0);
      await shot(page, `plugins-empty-${viewport.name}`);
    });

    test("where a version came from: what Bakery checked, then what the publisher says, never mixed", async ({ page }) => {
      await pluginsFixture(page);
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      const about = page.getByTestId("plugin-about");
      await expect(
        about.getByText(
          "Bakery checked the plugin's files against this fingerprint when the version was published.",
        ),
      ).toBeVisible();
      await expect(about.getByRole("button", { name: "Copy fingerprint" }))
        .toBeVisible();
      await about.getByRole("link", { name: "Where it came from" }).click();

      const dialog = page.getByTestId("plugin-origin");
      await expect(dialog.getByText("Where version 1.0.0 came from"))
        .toBeVisible();
      const checked = dialog.getByTestId("origin-checked");
      await expect(
        checked.getByText(
          "The files matched the fingerprint abababab…abab when this version was published.",
        ),
      ).toBeVisible();
      // The installed version also says it works with this Bakery.
      await expect(
        checked.getByText(
          "It works with this version of Bakery. Checked when Bakery switched to it.",
        ),
      ).toBeVisible();

      // The publisher's words, as written, with the caption that says they are
      // not checked, and no pass mark anywhere in the group.
      const stated = dialog.getByTestId("origin-stated");
      await expect(stated.getByText("Stated by the publisher")).toBeVisible();
      await expect(
        stated.getByText(
          "Bakery keeps these details as they were given and does not check them.",
        ),
      ).toBeVisible();
      await expect(stated.getByText("repository", { exact: true }))
        .toBeVisible();
      await expect(stated.getByText("example/notes", { exact: true }))
        .toBeVisible();
      await expect(stated.getByText("typecheck, lint", { exact: true }))
        .toBeVisible();
      // A publisher writing "passed" is still only a claim.
      await expect(stated.getByText("passed", { exact: true })).toBeVisible();
      // The check mark is Bakery's alone: an icon on each proven line, none
      // anywhere in what the publisher says.
      await expect(checked.getByTestId("origin-checked-line")).toHaveCount(2);
      const checkMark = 'path[d="m5 12 4 4L19 6"]';
      await expect(checked.locator(checkMark)).toHaveCount(2);
      await expect(stated.locator(checkMark)).toHaveCount(0);
      expect(await stated.innerText()).not.toContain("✓");

      // A long value is cut, and "Show all" gives the rest.
      await expect(stated.getByRole("button", { name: "Show all" }))
        .toBeVisible();
      const cut = await stated.getByTestId("stated-row").filter({
        hasText: /^notes/,
      }).innerText();
      expect(cut.length).toBeLessThan(260);
      await stated.getByRole("button", { name: "Show all" }).click();
      await expect(stated.getByText("n".repeat(300))).toBeVisible();
      await shot(page, `plugin-origin-${viewport.name}`, [], {
        windowOnly: true,
        scrollToEnd: dialog,
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByTestId("plugin-origin")).toHaveCount(0);
    });

    test("the publisher's details sit in one labelled box; an empty part and a long value stay inside it", async ({ page }) => {
      await pluginsFixture(page);
      await page.goto(`/settings/organization/plugins/${DASH_INSTALL}`);
      await page.getByTestId("plugin-about")
        .getByRole("link", { name: "Where it came from" }).click();
      const dialog = page.getByTestId("plugin-origin");
      const stated = dialog.getByTestId("origin-stated");
      // One group, named by its heading, not a live region; the caption is its
      // first line and the Source and Build labels are not headings.
      const box = stated.getByRole("group", {
        name: "Stated by the publisher",
      });
      await expect(box).toBeVisible();
      await expect(box.getByText(
        "Bakery keeps these details as they were given and does not check them.",
      )).toBeVisible();
      await expect(stated.getByRole("heading")).toHaveCount(1);
      await expect(box.getByText("Source", { exact: true })).toBeVisible();
      await expect(box.getByText("Build", { exact: true })).toBeVisible();
      await expect(box.getByText("example/dash", { exact: true }))
        .toBeVisible();
      // The part that was not given says so inside the box.
      await expect(box.getByText("The publisher gave no build details."))
        .toBeVisible();
      // A long value is cut; Show all is the quietest button and gives the rest.
      await expect(box.getByRole("button", { name: "Show all" }))
        .toBeVisible();
      expect(
        await box.getByTestId("stated-row").filter({ hasText: /^notes/ })
          .innerText(),
      ).not.toContain("d".repeat(300));
      await box.getByRole("button", { name: "Show all" }).click();
      await expect(box.getByText("d".repeat(300))).toBeVisible();
      // Nothing green inside the box: the check mark is Bakery's alone.
      await expect(box.locator('path[d="m5 12 4 4L19 6"]')).toHaveCount(0);
      await shot(page, `plugin-origin-partial-${viewport.name}`, [], {
        windowOnly: true,
        scrollToEnd: dialog,
      });
    });

    test("the update dialog links to where the new version came from, without claiming it works yet", async ({ page }) => {
      await pluginsFixture(page);
      await page.goto("/settings/organization/plugins");
      await page.getByRole("button", { name: "Review update of Notes" })
        .click();
      await page.getByRole("button", { name: "Where 1.1.0 came from" }).click();
      const dialog = page.getByTestId("plugin-origin");
      await expect(dialog.getByText("Where version 1.1.0 came from"))
        .toBeVisible();
      // The first line only: a version the install is not on has not been checked
      // against this Bakery yet, and no details were given for it.
      await expect(dialog.getByText(/The files matched the fingerprint/))
        .toBeVisible();
      await expect(dialog.getByText(/It works with this version of Bakery/))
        .toHaveCount(0);
      await expect(
        dialog.getByText("The publisher gave no source details."),
      ).toBeVisible();
      await expect(
        dialog.getByText("The publisher gave no build details."),
      ).toBeVisible();
    });

    test("saved data lists group, name, size and last saved, and never shows a value", async ({ page }) => {
      const state = await pluginsFixture(page);
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      const saved = page.getByTestId("plugin-saved");
      await expect(saved.getByRole("heading", { name: "Saved data" }))
        .toBeVisible();
      await expect(saved.getByText("theme", { exact: true })).toBeVisible();
      await expect(saved.getByText("welcome-note", { exact: true }))
        .toBeVisible();
      if (viewport.name === "desktop") {
        await expect(saved.getByText("settings", { exact: true }))
          .toBeVisible();
        await expect(saved.getByText("drafts", { exact: true })).toBeVisible();
        await expect(saved.getByText("412 B", { exact: true })).toBeVisible();
        await expect(saved.getByText("1.1 KB", { exact: true })).toBeVisible();
      } else {
        // On a phone each item is one stacked row: group, size and when.
        await expect(saved.getByText(/^settings · 412 B · saved /))
          .toBeVisible();
        await expect(saved.getByText(/^drafts · 1.1 KB · saved /))
          .toBeVisible();
      }
      await expect(
        saved.getByText(
          "2 items, 1.5 KB. Only Notes reads and changes these. Bakery does not show what is inside, and nothing here can be edited. Turning it off keeps them.",
        ),
      ).toBeVisible();
      // The page reads what is saved without the values, and never asks for the
      // full read that carries them.
      expect(await page.content()).not.toContain("TOPSECRET");
      expect(state.valuesReads).toBe(0);
      // Read only: nothing to edit, add or delete in this section.
      await expect(
        saved.getByRole("button", { name: /^(edit|add|delete|remove)/i }),
      ).toHaveCount(0);
      if (viewport.name === "desktop") {
        for (const header of ["Group", "Name", "Size", "Last saved"]) {
          await expect(saved.getByRole("columnheader", { name: header }))
            .toBeVisible();
        }
      }
      await shot(page, `plugin-saved-${viewport.name}`);
    });

    test("saved data pages by ten, and says when there is more", async ({ page }) => {
      const state = await pluginsFixture(page);
      state.saved = Array.from({ length: 12 }, (_, index) => ({
        id: id(500 + index),
        namespace: "settings",
        key: `item-${String(index).padStart(2, "0")}`,
        sizeBytes: 100,
        updatedAt: "2026-11-18T10:00:00.000Z",
      }));
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      const saved = page.getByTestId("plugin-saved");
      await expect(saved.getByText("item-09", { exact: true })).toBeVisible();
      await expect(saved.getByText("item-10", { exact: true })).toHaveCount(0);
      await expect(saved.getByText(/^10 items so far, 1,000 B\./))
        .toBeVisible();
      await saved.getByRole("button", { name: "Show more" }).click();
      await expect(saved.getByText("item-11", { exact: true })).toBeVisible();
      await expect(saved.getByText(/^12 items, 1.2 KB\./)).toBeVisible();
      await expect(saved.getByRole("button", { name: "Show more" }))
        .toHaveCount(0);
    });

    test("saved data says so when empty, unreadable, or not loaded, and keeps the rest of the page", async ({ page }) => {
      const state = await pluginsFixture(page);
      state.saved = [];
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      await expect(
        page.getByTestId("plugin-saved").getByText(
          "It has not saved anything yet.",
        ),
      ).toBeVisible();

      state.savedStatus = 403;
      await page.reload();
      await expect(
        page.getByTestId("plugin-saved").getByText(
          "You do not have access to this plugin's saved data.",
        ),
      ).toBeVisible();
      // The rest of the page is still there.
      await expect(page.getByRole("heading", { name: "What it can do" }))
        .toBeVisible();

      state.savedStatus = 500;
      await page.reload();
      const saved = page.getByTestId("plugin-saved");
      await expect(saved.getByText("Saved data could not be loaded."))
        .toBeVisible();
      state.savedStatus = 200;
      state.saved = [{
        id: id(600),
        namespace: "settings",
        key: "back",
        sizeBytes: 10,
        updatedAt: "2026-11-18T10:00:00.000Z",
      }];
      await saved.getByRole("button", { name: "Try again" }).click();
      await expect(saved.getByText("back", { exact: true })).toBeVisible();
    });

    test("a plugin that is not found says so, with a way back", async ({ page }) => {
      await pluginsFixture(page);
      await page.goto(`/settings/organization/plugins/${id(999)}`);
      await expect(page.getByRole("heading", { name: "Plugins", level: 1 }))
        .toBeVisible();
      await expect(page.getByText("This plugin could not be found."))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Go to Plugins" }))
        .toBeVisible();
      if (viewport.name === "desktop") {
        // The trail ends on the one Plugins crumb, not Plugins / Plugins.
        await expect(
          page.getByRole("navigation", { name: "Breadcrumb" }).getByText(
            "Plugins",
            { exact: true },
          ),
        ).toHaveCount(1);
      }
      await page.mouse.move(700, 700);
      await shot(page, `plugin-not-found-${viewport.name}`);
    });

    test("a viewer sees the list and nothing to change", async ({ page }) => {
      await pluginsFixture(page, { role: "viewer" });
      await page.goto("/settings/organization/plugins");
      await expect(
        page.getByText(
          "Only organization administrators can install and manage plugins for everyone.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /^Install / })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name: /Review update/ }))
        .toHaveCount(0);
    });

    test("an update shows what it adds and takes away, then moves the install", async ({ page }) => {
      const state = await pluginsFixture(page);
      await page.goto("/settings/organization/plugins");
      await page.getByRole("button", { name: "Review update of Notes" })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("1.0.0 → 1.1.0")).toBeVisible();
      await expect(dialog.getByText("New in 1.1.0: it also asks to"))
        .toBeVisible();
      await expect(dialog.getByRole("listitem")).toHaveText([
        "Run on a schedule",
      ]);
      await expect(
        dialog.getByText("It keeps the 2 permissions it already has."),
      ).toBeVisible();
      // The caption sits close under its list; the next block is set apart.
      const [listBox, captionBox, noLongerBox] = [
        await dialog.getByRole("listitem").boundingBox(),
        await dialog.getByText("It keeps the 2 permissions it already has.")
          .boundingBox(),
        await dialog.getByText("It will no longer: Save its own data.")
          .boundingBox(),
      ];
      expect(
        noLongerBox!.y - (captionBox!.y + captionBox!.height),
      ).toBeGreaterThan(captionBox!.y - (listBox!.y + listBox!.height));
      await expect(
        dialog.getByText(
          "If 1.1.0 asks for anything else, Bakery does not switch and asks you again.",
        ),
      ).toBeVisible();
      await expect(
        dialog.getByText("It will no longer: Save its own data."),
      ).toBeVisible();
      await expect(
        dialog.getByText(
          "The new version is checked before Bakery switches to it. If it does not pass, 1.0.0 keeps running.",
        ),
      ).toBeVisible();
      await shot(page, `plugins-update-${viewport.name}`, [], {
        windowOnly: true,
      });
      await still(page, "plugin-update-approve");
      await dialog.getByRole("button", { name: "Update and allow 1" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0].method).toBe("PATCH");
      // Exactly the permission the dialog showed as new is what is allowed.
      expect(state.writes[0].body).toEqual({
        versionId: NOTES_V2,
        approveCapabilities: ["jobs.schedule"],
      });
      expect(state.writes[0].ifMatch).toBe('"v3"');
    });

    test("an update that does not start is remembered, says the old version is still running, and can be dismissed", async ({ page }) => {
      const state = await pluginsFixture(page);
      state.failNextUpdate = true;
      await page.goto("/settings/organization/plugins");
      await page.getByRole("button", { name: "Review update of Notes" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Update and allow 1" }).click();
      await expect(dialog.getByText("The update to 1.1.0 did not start."))
        .toBeVisible();
      await expect(
        dialog.getByText(
          "Version 1.0.0 is still running and nothing was lost. Bakery checked 1.1.0 before switching and it did not pass.",
        ),
      ).toBeVisible();
      // Once the error shows, the "is checked before" line is not repeated.
      await expect(dialog.getByText(/is checked before Bakery switches/))
        .toHaveCount(0);
      await shot(page, `plugins-update-failed-${viewport.name}`, [], {
        windowOnly: true,
      });
      await dialog.getByRole("button", { name: "Not now" }).click();
      // The row says so, and its one control is See problem.
      await expect(page.getByText("Update failed", { exact: true }))
        .toBeVisible();
      await expect(
        page.getByRole("button", { name: "See the problem with Notes" }),
      ).toBeVisible();
      expect(state.installs[0].pluginVersionId).toBe(NOTES_V1);

      // It is still there after a reload: the server remembers it.
      await page.reload();
      await expect(page.getByText("Update failed", { exact: true }))
        .toBeVisible();
      await shot(page, `plugins-failed-reload-list-${viewport.name}`);
      await page.getByRole("button", { name: "See the problem with Notes" })
        .click();
      await expect(page.getByText("The update to 1.1.0 did not start."))
        .toBeVisible();
      await shot(page, `plugin-failed-reload-page-${viewport.name}`);
      await expect(
        page.getByTestId("plugin-versions").getByText("Did not start", {
          exact: true,
        }),
      ).toBeVisible();

      // The badge follows the version number, not the middle of the row.
      if (viewport.name === "desktop") {
        const version = page
          .getByTestId("plugin-versions")
          .getByText("1.1.0", { exact: true });
        const badge = page
          .getByTestId("plugin-versions")
          .getByText("Did not start", { exact: true });
        // Both boxes are read together, again and again, until the layout has
        // settled; one read under load can catch the row before it is laid out.
        await expect.poll(async () => {
          const [v, b] = [
            await version.boundingBox(),
            await badge.boundingBox(),
          ];
          return v && b ? b.x - (v.x + v.width) : Infinity;
        }).toBeLessThan(24);
      }

      // The notice offers the update again first (primary), and it opens the
      // review dialog; Dismiss follows.
      const notice = page.getByRole("alert").filter({
        hasText: "The update to 1.1.0 did not start.",
      });
      const buttons = notice.getByRole("button");
      await expect(buttons.nth(0)).toHaveText("Try the update again");
      await expect(buttons.nth(1)).toHaveText("Dismiss");
      await buttons.nth(0).click();
      const retry = page.getByRole("dialog");
      await expect(retry.getByText("1.0.0 → 1.1.0")).toBeVisible();
      await retry.getByRole("button", { name: "Not now" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // Dismissing sends only that, and the note goes.
      await page.getByRole("button", { name: "Dismiss" }).click();
      await expect(page.getByText("The update to 1.1.0 did not start."))
        .toHaveCount(0);
      const last = state.writes.at(-1)!;
      expect(last.body).toEqual({ dismissUpdateFailure: true });
    });

    test("the plugin page shows what it can do, read only, and turning off takes it away", async ({ page }) => {
      const state = await pluginsFixture(page);
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      await expect(page.getByRole("heading", { name: "What it can do" }))
        .toBeVisible();
      for (
        const text of [
          "Add its own pages to Bakery",
          "Read the data it has saved",
          "Save its own data",
        ]
      ) await expect(page.getByText(text)).toBeVisible();
      await expect(
        page.getByText(
          "It got these when it was installed. Turning it off takes them all away; a new version can ask for different ones.",
        ),
      ).toBeVisible();
      // Nothing in the list can be pressed: no Allow, no Take away.
      await expect(page.getByRole("button", { name: /^Allow/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Take away/ })).toHaveCount(
        0,
      );
      // Versions: the installed one is "Installed" (not "In use"), the other is
      // offered as a quiet "Review update", and Remove sits at the end under More.
      const versions = page.getByTestId("plugin-versions");
      await expect(versions.getByText("Installed", { exact: true }))
        .toBeVisible();
      await expect(versions.getByText("In use")).toHaveCount(0);
      // The installed version's badge sits in the action column, level with the
      // other row's button, and the page tells about the version it runs.
      if (viewport.name === "desktop") {
        const badge = versions.getByText("Installed", { exact: true });
        const button = versions.getByRole("button", {
          name: "Update to 1.1.0",
        });
        await expect.poll(async () => {
          const [b, a] = [
            await badge.boundingBox(),
            await button.boundingBox(),
          ];
          return b && a
            ? Math.abs((b.x + b.width) - (a.x + a.width))
            : Infinity;
        }).toBeLessThan(2);
      }
      const about = page.getByTestId("plugin-about");
      await expect(about.getByRole("heading", { name: "About this version" }))
        .toBeVisible();
      await expect(about.getByText("Nov 2, 2026")).toBeVisible();
      await expect(about.getByText("Fingerprint").first()).toBeVisible();
      await expect(about.getByText("abababab…abab")).toBeVisible();
      await expect(
        versions.getByRole("button", { name: "Update to 1.1.0" }),
      ).toHaveText("Review update");
      await expect(
        page.getByTestId("plugin-more").getByRole("button", { name: "Remove" }),
      ).toBeVisible();
      await expect(
        page.getByTestId("plugin-can-do").getByRole("button", {
          name: "Remove",
        }),
      ).toHaveCount(0);
      await shot(page, `plugin-page-on-${viewport.name}`);

      await page.getByRole("button", { name: "Turn off" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByText("Turn off Notes?")).toBeVisible();
      await shot(page, `plugin-turn-off-${viewport.name}`, [], {
        windowOnly: true,
      });
      await expect(
        dialog.getByText(
          "It stops for everyone and loses its 3 permissions. Its saved data is kept. You can turn it on again.",
        ),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Turn off" }).click();
      expect(state.writes[0].body).toEqual({ status: "disabled" });
      await expect(
        page.getByText(
          "It has none of these while it is off. Turning it on gives them back.",
        ),
      ).toBeVisible();
      await shot(page, `plugin-page-off-${viewport.name}`);

      // Turning on asks nothing: it gives back what was agreed.
      await page.getByRole("button", { name: "Turn on" }).click();
      expect(state.writes[1].body).toEqual({ status: "enabled" });
      await expect(page.getByText("Notes is on.")).toBeVisible();
    });

    test("removing says it cannot be turned back on, and a stale page is told", async ({ page }) => {
      const state = await pluginsFixture(page);
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      await page.getByRole("button", { name: "Remove" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByText(/cannot be turned back on/)).toBeVisible();
      await shot(page, `plugin-remove-${viewport.name}`, [], {
        windowOnly: true,
      });
      state.refuseNextWrite = { status: 412, code: "PRECONDITION_FAILED" };
      await dialog.getByRole("button", { name: "Remove" }).click();
      await expect(
        dialog.getByText(
          "This plugin was changed by someone else. The latest state is shown.",
        ),
      ).toBeVisible();
      expect(state.installs[0].status).toBe("enabled");
    });

    test("a version that cannot read the saved data says so on its row and draws no button", async ({ page }) => {
      await pluginsFixture(page, {
        installs: [
          install({
            id: NOTES_INSTALL,
            pluginVersionId: NOTES_V2,
            cannotReadVersionIds: [NOTES_V1],
          }),
        ],
      });
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      const row = page.locator(`[data-plugin-version="${NOTES_V1}"]`);
      await expect(row).toContainText("Cannot read the saved data");
      await expect(row).toContainText(
        "Ask the plugin's author for a version that can read this data.",
      );
      // No button, not a faded one: there is nothing the person can do here.
      await expect(page.getByRole("button", { name: "Go back to 1.0.0" }))
        .toHaveCount(0);
      await shot(page, `plugin-cannot-read-${viewport.name}`, [], {
        windowOnly: true,
      });
      await still(page, "plugin-cannot-read-row");
    });

    test("a version that could not read the saved data is said once, and restoring its data asks first", async ({ page }) => {
      const state = await pluginsFixture(page, {
        installs: [
          install({
            id: NOTES_INSTALL,
            pluginVersionId: NOTES_V1,
            lastUpdateFailure: {
              versionId: NOTES_V2,
              versionName: "1.1.0",
              reason: "plugin_state_incompatible",
              at: "2026-11-20T00:00:00.000Z",
              restoreState: false,
              addedCapabilities: [],
            },
            stateCopy: {
              versionId: NOTES_V2,
              versionName: "1.1.0",
              takenAt: "2026-11-19T10:30:00.000Z",
              itemCount: 3,
            },
            cannotReadVersionIds: [NOTES_V2],
          }),
        ],
      });
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      const notice = page.getByRole("alert");
      await expect(notice).toContainText(
        "Bakery did not switch to version 1.1.0",
      );
      await expect(notice).toContainText(
        "It cannot read the data Notes has saved. Version 1.0.0 is still running with its data.",
      );
      await shot(page, `plugin-cannot-read-notice-${viewport.name}`, [], {
        windowOnly: true,
      });
      await still(page, "plugin-cannot-read-notice");
      // The row says what the notice says, once: not "Did not start".
      const keptRow = page.locator(`[data-plugin-version="${NOTES_V2}"]`);
      await expect(keptRow).toContainText("Cannot read the saved data");
      await expect(keptRow).not.toContainText("Did not start");
      // Its button opens the restore dialog, so it says that, in the notice's words.
      await expect(
        keptRow.getByRole("button", {
          name: "Go back to 1.1.0 and restore its data",
        }),
      ).toHaveText("Go back and restore its data");
      await notice.getByRole("button", { name: "Go back and restore its data" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText(
        "Go back to 1.1.0 and restore its data?",
      );
      await expect(dialog).toContainText(": 3 items.");
      // The permission it allows is a label and a row, as in the Update dialog,
      // and not a second caption; going back removes data, so the button says so.
      await expect(dialog.getByText("New in 1.1.0: it also asks to", {
        exact: true,
      })).toBeVisible();
      await expect(dialog.getByRole("listitem")).toHaveText([
        "Run on a schedule",
      ]);
      await expect(
        dialog.getByRole("button", { name: "Go back, restore and allow 1" }),
      ).toHaveAttribute("data-variant", "destructive");
      // Three blocks at the Update dialog's gap: the sentences, the permission
      // and its label together, then the caption.
      const [removed, label, item, caption] = [
        await dialog.getByText(
          "Everything it saved after that, on 1.0.0, is removed.",
        ).boundingBox(),
        await dialog.getByText("New in 1.1.0: it also asks to", { exact: true })
          .boundingBox(),
        await dialog.getByRole("listitem").boundingBox(),
        await dialog.getByText(/Bakery keeps one copy of the data/)
          .boundingBox(),
      ];
      const within = label!.height === 0
        ? 0
        : item!.y - (label!.y + label!.height);
      expect(label!.y - (removed!.y + removed!.height)).toBeGreaterThan(within);
      expect(caption!.y - (item!.y + item!.height)).toBeGreaterThan(within);
      await expect(dialog).toContainText(
        "Everything it saved after that, on 1.0.0, is removed.",
      );
      await shot(page, `plugin-restore-${viewport.name}`, [], {
        windowOnly: true,
      });
      await still(page, "plugin-restore");
      // The version it goes back to asks for a permission the installed one lacks: the button says so.
      await dialog.getByRole("button", { name: "Go back, restore and allow 1" })
        .click();
      expect(state.writes[0].body).toMatchObject({
        versionId: NOTES_V2,
        restoreState: true,
      });
      expect(
        (state.writes[0].body as { approveCapabilities?: string[] })
          .approveCapabilities,
      ).toEqual(["jobs.schedule"]);
    });

    test("a refused approval keeps the dialog open with one warning and raises no page notice", async ({ page }) => {
      const state = await pluginsFixture(page);
      await page.goto("/settings/organization/plugins");
      await page.getByRole("button", { name: "Review update of Notes" })
        .click();
      const dialog = page.getByRole("dialog");
      // The server answers the way it does when the list changed under the person.
      state.failNextUpdate = {
        reason: "plugin_capabilities_not_approved",
        addedCapabilities: ["jobs.schedule", "state.write"],
      };
      await dialog.getByRole("button", { name: "Update and allow 1" }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveCount(1);
      await expect(dialog.getByRole("alert")).toHaveText(
        "Version 1.1.0 now asks for a different list. Check it and allow again.",
      );
      expect(state.writes).toHaveLength(1);
      // Closing it leaves no page notice behind.
      await dialog.getByRole("button", { name: "Not now" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
    });

    test("a refused approval never raises a page notice", async ({ page }) => {
      await pluginsFixture(page, {
        installs: [
          install({
            id: NOTES_INSTALL,
            pluginVersionId: NOTES_V1,
            lastUpdateFailure: {
              versionId: NOTES_V2,
              versionName: "1.1.0",
              reason: "plugin_capabilities_not_approved",
              at: "2026-11-20T00:00:00.000Z",
              restoreState: false,
              addedCapabilities: ["jobs.schedule"],
            },
          }),
        ],
      });
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      await expect(page.getByRole("heading", { name: "Notes" }).first())
        .toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
    });

    test("going back to an older version shows what changes first", async ({ page }) => {
      const state = await pluginsFixture(page, {
        installs: [install({ id: NOTES_INSTALL, pluginVersionId: NOTES_V2 })],
      });
      await page.goto(`/settings/organization/plugins/${NOTES_INSTALL}`);
      await page.getByRole("button", { name: "Go back to 1.0.0" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("1.1.0 → 1.0.0")).toBeVisible();
      await shot(page, `plugin-go-back-${viewport.name}`, [], {
        windowOnly: true,
      });
      await expect(dialog.getByText("New in 1.0.0: it also asks to"))
        .toBeVisible();
      await expect(dialog.getByRole("listitem")).toHaveText([
        "Save its own data",
      ]);
      await expect(dialog.getByText("It will no longer: Run on a schedule."))
        .toBeVisible();
      // 1.0.0 can do something 1.1.0 cannot, so the button says it allows it.
      await dialog.getByRole("button", { name: "Go back and allow 1" }).click();
      expect(state.writes[0].body).toEqual({
        versionId: NOTES_V1,
        approveCapabilities: ["state.write"],
      });
    });
  });
}
