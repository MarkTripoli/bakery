import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { shot } from "./helpers/real-api.ts";

/** Opens an area's closed row if it is closed, then ticks one permission in it. */
async function choosePermission(
  panel: Locator,
  area: string,
  permission: string,
) {
  const row = panel.getByTestId(`permission-area-${area}`);
  if ((await row.getAttribute("data-state")) !== "open") {
    await row.locator("summary").click();
  }
  await row.getByLabel(permission).check();
}

const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ID = "00000000-0000-4000-8000-0000000000a2";

type Role = {
  id: string;
  key: string;
  name: string;
  description: string;
  permissions: string[];
  memberCount: number;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
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
    type: `https://bakery.example/problems/${code.toLowerCase()}`,
    title: code,
    detail: code,
    status,
    code,
    retryable: false,
    requestId: "00000000-0000-4000-8000-0000000000e1",
    traceId: "00000000-0000-4000-8000-0000000000e2",
  }),
});

type Fixture = {
  roles: Role[];
  writes: { method: string; path: string; body: unknown }[];
  /** Status the next write answers with, once. */
  refuseNextWrite: { status: number; code: string } | null;
  listStatus: number;
  /** Every organization-roles read the page made. */
  reads: number;
};

async function rolesFixture(
  page: Page,
  options: {
    roles?: Role[];
    listStatus?: number;
    role?: "admin" | "developer";
  } = {},
): Promise<Fixture> {
  const state: Fixture = {
    roles: options.roles ?? [],
    writes: [],
    refuseNextWrite: null,
    listStatus: options.listStatus ?? 200,
    reads: 0,
  };
  await mockAuthenticatedSession(page);
  // The roles page reads only roles: answer the rest empty.
  const empty = (route: Route) =>
    route.fulfill(json({ items: [], nextCursor: null }));
  for (
    const pattern of [
      `**/v1/organizations/${MOCK_ORGANIZATION_ID}/**`,
      "**/v1/access-tokens**",
      "**/v1/access-bindings**",
      "**/v1/applications**",
      "**/v1/repositories**",
    ]
  ) await page.route(pattern, empty);
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
        capabilities: ["task:read"],
      })),
  );
  await page.route("**/v1/principals**", (route) =>
    route.fulfill(json({
      items: [MEMBER_ID, OTHER_ID].map((id, index) => ({
        id,
        principalType: "human",
        createdByPrincipalId: null,
        displayName: index === 0 ? "Ada Member" : "Grace Member",
        disabledAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        version: 1,
      })),
      nextCursor: null,
    })));
  await page.route("**/v1/organization-roles**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET") {
      state.reads += 1;
      if (state.listStatus !== 200) {
        return route.fulfill(problem(state.listStatus, "INTERNAL"));
      }
      return route.fulfill(json({ items: state.roles, nextCursor: null }));
    }
    const body = request.postDataJSON() as Record<string, unknown> | null;
    state.writes.push({ method, path, body });
    if (state.refuseNextWrite) {
      const refusal = state.refuseNextWrite;
      state.refuseNextWrite = null;
      return route.fulfill(problem(refusal.status, refusal.code));
    }
    const now = new Date().toISOString();
    const segments = path.split("/");
    const id = segments[3];
    if (method === "POST" && segments.length === 3) {
      const role: Role = {
        id: crypto.randomUUID(),
        key: String(body?.key),
        name: String(body?.name),
        description: String(body?.description ?? ""),
        permissions: body?.permissions as string[],
        memberCount: 0,
        memberIds: [],
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      state.roles.push(role);
      return route.fulfill(json(role, 201));
    }
    const role = state.roles.find((item) => item.id === id);
    if (!role) return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
    if (method === "PATCH") {
      Object.assign(role, {
        name: body?.name ?? role.name,
        description: body?.description ?? role.description,
        permissions: body?.permissions ?? role.permissions,
        version: role.version + 1,
      });
      return route.fulfill(json(role));
    }
    if (method === "POST" && segments[4] === "members") {
      role.memberIds.push(String(body?.principalId));
      role.memberCount = role.memberIds.length;
      return route.fulfill(json(role, 201));
    }
    if (method === "DELETE" && segments[4] === "members") {
      role.memberIds = role.memberIds.filter((member) =>
        member !== segments[5]
      );
      role.memberCount = role.memberIds.length;
      return route.fulfill({ status: 204 });
    }
    state.roles = state.roles.filter((item) => item.id !== id);
    return route.fulfill({ status: 204 });
  });
  return state;
}

const existing = (overrides: Partial<Role> = {}): Role => ({
  id: "00000000-0000-4000-8000-0000000000b1",
  key: "auditors",
  name: "Auditors",
  description: "",
  permissions: ["principal:read"],
  memberCount: 0,
  memberIds: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  version: 1,
  ...overrides,
});

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the form words the overrule permission and files it under Tasks and runs", async ({ page }) => {
      await rolesFixture(page);
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await panel.getByRole("button", { name: "Create custom role" }).click();
      const area = panel.getByTestId("permission-area-work");
      if ((await area.getAttribute("data-state")) !== "open") {
        await area.locator("summary").click();
      }
      // Said as what the person may do, with the key beside it; it does not
      // read as accepting the review, and it is not mistaken for the neighbours.
      const row = area.getByLabel("review:accept");
      await expect(row).toBeVisible();
      await expect(
        area.getByText("Overrule reviews that asked for changes"),
      ).toBeVisible();
      await expect(area.getByText("Overrule and accept")).toHaveCount(0);
      // The still is the window with the row in it, at the design's sizes.
      const evidence = process.env.BAKERY_EVIDENCE_DIR;
      if (evidence) {
        await page.setViewportSize(
          viewport.name === "desktop"
            ? { width: 1440, height: 900 }
            : { width: 390, height: 844 },
        );
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${evidence}/roles-overrule-${viewport.name}.png`,
        });
      }
    });

    test("creates, edits, assigns, unassigns and deletes a custom role", async ({ page }) => {
      const state = await rolesFixture(page);
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await expect(panel.getByText("No custom roles yet")).toBeVisible();

      await panel.getByRole("button", { name: "Create custom role" }).click();
      // Saving with nothing filled in is refused before any request.
      await panel.getByRole("button", { name: "Save role" }).click();
      await expect(panel.getByText("Enter a role name.")).toBeVisible();
      expect(state.writes).toEqual([]);

      // The long permission list never widens the page past the viewport.
      expect(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= globalThis.innerWidth
        ),
      ).toBe(true);
      await panel.getByLabel("Role name").fill("Auditors");
      await panel.getByLabel("Role key").fill("auditors");
      await choosePermission(panel, "access", "principal:read");
      await panel.getByRole("button", { name: "Save role" }).click();
      await expect(panel.getByText("Role saved.")).toBeVisible();
      expect(state.writes[0]).toMatchObject({
        method: "POST",
        body: {
          key: "auditors",
          name: "Auditors",
          permissions: ["principal:read"],
        },
      });
      const row = panel.getByTestId("custom-role-auditors");
      await expect(row).toContainText("1 permission · 0 members");

      await row.getByRole("button", { name: "Edit" }).click();
      await panel.getByLabel("Role name").fill("Auditors EU");
      await panel.getByRole("button", { name: "Save role" }).click();
      await expect(row).toContainText("Auditors EU");
      expect(state.writes.at(-1)).toMatchObject({ method: "PATCH" });

      await row.getByLabel("Give Auditors EU to").selectOption({
        label: "Ada Member",
      });
      await row.getByRole("button", { name: "Assign" }).click();
      await expect(panel.getByText("Role assigned.")).toBeVisible();
      await expect(row).toContainText("1 permission · 1 member");
      await expect(row.getByLabel(/Members holding/))
        .toContainText("Ada Member");
      // A role with holders cannot be deleted.
      await expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();

      await row.getByRole("button", { name: "Remove Ada Member" }).click();
      await expect(panel.getByText("Role removed.")).toBeVisible();
      await panel.getByRole("button", { name: "Dismiss notice" }).click();
      await row.getByRole("button", { name: "Delete" }).click();
      // Delete asks first and says what it does.
      const confirm = page.getByRole("alertdialog", {
        name: "Delete Auditors EU?",
      });
      await expect(confirm).toContainText(
        "No members have this role, so nobody's access changes.",
      );
      // The stills show the dialog on its own, not behind the last notice.
      await shot(page, "custom-roles-delete-dialog", [], { windowOnly: true });
      const writesBefore = state.writes.length;
      await confirm.getByRole("button", { name: "Cancel" }).click();
      expect(state.writes).toHaveLength(writesBefore);
      await row.getByRole("button", { name: "Delete" }).click();
      await confirm.getByRole("button", { name: "Delete role" }).click();
      await expect(panel.getByText("Role deleted.")).toBeVisible();
      await shot(page, "custom-roles-deleted");
      await expect(panel.getByText("No custom roles yet")).toBeVisible();
      expect(state.writes.map((write) => write.method)).toEqual([
        "POST",
        "PATCH",
        "POST",
        "DELETE",
        "DELETE",
      ]);
    });

    test("the page has one heading and one primary action, which moves into the empty state", async ({ page }) => {
      await rolesFixture(page);
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await expect(panel.getByText("No custom roles yet")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "Roles", exact: true }))
        .toHaveCount(0);
      await expect(
        panel.getByText(
          "Build a role with exactly the permissions you choose, then give it to members in Members & access.",
        ),
      ).toBeVisible();
      await expect(
        panel.getByText(
          "A member has either a built-in role or one custom role. Custom roles cannot manage the organization.",
        ),
      ).toBeVisible();
      // No roles: the only Create button is the empty state's.
      const create = panel.getByRole("button", { name: "Create custom role" });
      await expect(create).toHaveCount(1);
      await expect(
        panel.getByTestId("custom-roles-empty").getByRole("button", {
          name: "Create custom role",
        }),
      ).toHaveCount(1);
      await expect(
        panel.getByText(
          "Create one when the built-in roles give too much or too little.",
        ),
      ).toBeVisible();
      await shot(page, "custom-roles-empty");
    });

    test("with roles the one Create button sits in the page header", async ({ page }) => {
      await rolesFixture(page, { roles: [existing()] });
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await expect(panel.getByTestId("custom-role-auditors")).toBeVisible();
      const create = panel.getByRole("button", { name: "Create custom role" });
      await expect(create).toHaveCount(1);
      await expect(
        panel.locator(".ui-access-settings__header").getByRole("button", {
          name: "Create custom role",
        }),
      ).toHaveCount(1);
      await shot(page, "custom-roles-list");
    });

    test("a saved role is confirmed in the success tone and can be dismissed", async ({ page }) => {
      await rolesFixture(page);
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await panel.getByRole("button", { name: "Create custom role" }).click();
      await panel.getByLabel("Role name").fill("Auditors");
      await panel.getByLabel("Role key").fill("auditors");
      await choosePermission(panel, "access", "principal:read");
      await panel.getByRole("button", { name: "Save role" }).click();
      const notice = panel.locator('[data-ui-component="inlineNotice"]');
      await expect(notice).toContainText("Role saved.");
      await expect(notice).toHaveAttribute("data-variant", "success");
      await shot(page, "custom-roles-saved");
      await notice.getByRole("button", { name: "Dismiss notice" }).click();
      await expect(panel.getByText("Role saved.")).toHaveCount(0);
    });

    test("permissions sit in closed areas with a count, each permission one line with its key", async ({ page }) => {
      await rolesFixture(page);
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await panel.getByRole("button", { name: "Create custom role" }).click();
      // The empty card does not sit above the form it contradicts.
      await expect(panel.getByText("No custom roles yet")).toHaveCount(0);
      const access = panel.getByTestId("permission-area-access");
      await expect(access).toHaveAttribute("data-state", "closed");
      await expect(access).toContainText("Members and access");
      await expect(access).toContainText(/0 of \d+ chosen/);
      // Every area starts closed on a new role.
      const areas = panel.locator("[data-testid^='permission-area-']");
      for (let index = 0; index < (await areas.count()); index += 1) {
        await expect(areas.nth(index)).toHaveAttribute("data-state", "closed");
      }
      // Save role and Cancel are one size: same height, same type.
      const save = panel.getByRole("button", { name: "Save role" });
      const cancel = panel.getByRole("button", { name: "Cancel" });
      const [saveBox, cancelBox] = [
        await save.boundingBox(),
        await cancel.boundingBox(),
      ];
      expect(Math.round(saveBox!.height)).toBe(Math.round(cancelBox!.height));
      expect(
        await save.evaluate((element) => getComputedStyle(element).fontSize),
      ).toBe(
        await cancel.evaluate((element) => getComputedStyle(element).fontSize),
      );
      await shot(page, "custom-roles-form-closed");
      await access.locator("summary").click();
      await expect(access.getByLabel("principal:read")).toBeVisible();
      await shot(page, "custom-roles-form-area-open");
      // The sentence and the key share one line.
      const label = access.locator("label").filter({
        hasText: "principal:read",
      })
        .first();
      await expect(label).toContainText("See members and service accounts");
      const lineHeight = await label.evaluate((element) =>
        element.getBoundingClientRect().height
      );
      // A phone may wrap a long sentence; a wide screen keeps it on one line.
      if (viewport.name === "desktop") expect(lineHeight).toBeLessThan(48);
      // Choose all / Clear change the count.
      await access.getByRole("button", { name: "Choose all" }).click();
      await expect(access).not.toContainText("0 of");
      await expect(access.getByLabel("principal:read")).toBeChecked();
      await access.getByRole("button", { name: "Clear" }).click();
      await expect(access).toContainText(/^.*0 of \d+ chosen/);
      await panel.getByTestId("permission-area-work").locator("summary")
        .click();
      await expect(panel.getByTestId("permission-area-work")).toContainText(
        "Start, stop and steer runs",
      );
      // Reworded nouns: no system words.
      await panel.getByTestId("permission-area-automation").locator("summary")
        .click();
      await expect(panel.getByTestId("permission-area-automation"))
        .toContainText("what agents are allowed to use");
    });

    test("saving with nothing chosen opens the areas; editing opens the ones with a choice", async ({ page }) => {
      await rolesFixture(page, { roles: [existing()] });
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await page.getByTestId("custom-role-auditors").getByRole("button", {
        name: "Edit Auditors",
      }).click();
      // principal:read is chosen, so its area opens; the others stay closed.
      await expect(panel.getByTestId("permission-area-access")).toHaveAttribute(
        "data-state",
        "open",
      );
      await expect(panel.getByTestId("permission-area-work")).toHaveAttribute(
        "data-state",
        "closed",
      );
      await expect(panel.getByTestId("permission-area-access")).toContainText(
        /1 of \d+ chosen/,
      );
    });

    test("a role with members cannot be deleted and says why", async ({ page }) => {
      await rolesFixture(page, {
        roles: [existing({ memberCount: 2, memberIds: [MEMBER_ID, OTHER_ID] })],
      });
      await page.goto("/settings/organization/roles");
      const row = page.getByTestId("custom-role-auditors");
      await expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();
      await expect(row).toContainText(
        "Remove its 2 members first to delete this role.",
      );
      // The hint belongs to the Delete button, and the member list has its own label.
      await expect(row.getByRole("button", { name: "Delete" }))
        .toHaveAccessibleDescription(
          "Remove its 2 members first to delete this role.",
        );
      await expect(row.getByText("Members with this role")).toBeVisible();
      await shot(page, "custom-roles-with-members");
    });

    test("a refused write names the reason and keeps the form open", async ({ page }) => {
      const state = await rolesFixture(page);
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await panel.getByRole("button", { name: "Create custom role" }).click();
      await panel.getByLabel("Role name").fill("Too much");
      await panel.getByLabel("Role key").fill("too-much");
      await choosePermission(panel, "access", "principal:read");
      state.refuseNextWrite = { status: 403, code: "AUTH_FORBIDDEN" };
      await panel.getByRole("button", { name: "Save role" }).click();
      await expect(
        panel.getByText("You can only grant or change permissions you hold"),
      ).toBeVisible();
      await expect(panel.getByLabel("Role name")).toHaveValue("Too much");
      // The same form can be submitted again once the refusal passes.
      await panel.getByRole("button", { name: "Save role" }).click();
      await expect(panel.getByText("Role saved.")).toBeVisible();
    });

    test("a non-admin gets a notice and no role data is read", async ({ page }) => {
      const state = await rolesFixture(page, {
        roles: [existing()],
        role: "developer",
      });
      await page.goto("/settings/organization/roles");
      await expect(page.getByTestId("org-roles-forbidden")).toContainText(
        "Only organization admins can manage custom roles",
      );
      await expect(page.getByTestId("custom-roles")).toHaveCount(0);
      expect(state.reads).toBe(0);
    });

    test("a failed list read offers a retry", async ({ page }) => {
      const state = await rolesFixture(page, {
        listStatus: 500,
      });
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await expect(panel.getByText("Custom roles could not be loaded."))
        .toBeVisible();
      state.listStatus = 200;
      state.roles = [existing()];
      await panel.getByRole("button", { name: "Reload roles" }).click();
      await expect(panel.getByTestId("custom-role-auditors")).toBeVisible();
    });
  });
}
