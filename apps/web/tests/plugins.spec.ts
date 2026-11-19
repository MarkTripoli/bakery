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
import { shot } from "./helpers/real-api.ts";

// A shared machine can be slow to answer; give each assertion and test room.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 60_000 });

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
) => ({
  id: versionId,
  organizationId: MOCK_ORGANIZATION_ID,
  pluginPackageId: packageId,
  versionName,
  sdkRange: "^1",
  manifest: { requestedCapabilities },
  bundleDigest: `sha256:${"ab".repeat(32)}`,
  sourceEvidence: {},
  buildEvidence: {},
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
  failNextUpdate: boolean;
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
      ]),
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
      ]),
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
      state.failNextUpdate = false;
      target.lastUpdateFailure = {
        versionId: String(body.versionId),
        versionName: "1.1.0",
        reason: "plugin_sdk_incompatible",
        at: "2026-11-19T21:00:00.000Z",
      };
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
      expect((await review.boundingBox())!.height).toBeLessThan(48);
      await shot(page, `plugins-list-${viewport.name}`);
    });

    test("the list, the install dialog and the plugin page have no accessibility violations", async ({ page }) => {
      // Three axe scans and two navigations take longer than the default.
      test.setTimeout(90_000);
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
      await expect(
        dialog.getByText("Version 1.1.0 can also: Run on a schedule."),
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
      await dialog.getByRole("button", { name: "Update and allow" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0].method).toBe("PATCH");
      expect(state.writes[0].body).toEqual({ versionId: NOTES_V2 });
      expect(state.writes[0].ifMatch).toBe('"v3"');
    });

    test("an update that does not start is remembered, says the old version is still running, and can be dismissed", async ({ page }) => {
      const state = await pluginsFixture(page);
      state.failNextUpdate = true;
      await page.goto("/settings/organization/plugins");
      await page.getByRole("button", { name: "Review update of Notes" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Update and allow" }).click();
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
        const version = await page
          .getByTestId("plugin-versions")
          .getByText("1.1.0", { exact: true })
          .boundingBox();
        const badge = await page
          .getByTestId("plugin-versions")
          .getByText("Did not start", { exact: true })
          .boundingBox();
        expect(badge!.x - (version!.x + version!.width)).toBeLessThan(24);
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
        const badge = await versions.getByText("Installed", { exact: true })
          .boundingBox();
        const button = await versions.getByRole("button", {
          name: "Update to 1.1.0",
        }).boundingBox();
        expect(
          Math.abs((badge!.x + badge!.width) - (button!.x + button!.width)),
        ).toBeLessThan(2);
      }
      const about = page.getByTestId("plugin-about");
      await expect(about.getByRole("heading", { name: "About this version" }))
        .toBeVisible();
      await expect(about.getByText("Published Nov 2, 2026")).toBeVisible();
      await expect(about.getByText("Fingerprint").first()).toBeVisible();
      await expect(about.getByText("sha256:abababababab")).toBeVisible();
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
      await expect(
        dialog.getByText("Version 1.0.0 can also: Save its own data."),
      )
        .toBeVisible();
      await expect(dialog.getByText("It will no longer: Run on a schedule."))
        .toBeVisible();
      // 1.0.0 can do something 1.1.0 cannot, so the button says it allows it.
      await dialog.getByRole("button", { name: "Go back and allow" }).click();
      expect(state.writes[0].body).toEqual({ versionId: NOTES_V1 });
    });
  });
}
