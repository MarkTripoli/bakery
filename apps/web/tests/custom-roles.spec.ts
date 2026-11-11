import { expect, type Page, type Route, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

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
      await panel.getByLabel("principal:read").check();
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
      await expect(row.getByRole("list", { name: /Members holding/ }))
        .toContainText("Ada Member");
      // A role with holders cannot be deleted.
      await expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();

      await row.getByRole("button", { name: "Remove Ada Member" }).click();
      await expect(panel.getByText("Role removed.")).toBeVisible();
      await row.getByRole("button", { name: "Delete" }).click();
      await expect(panel.getByText("Role deleted.")).toBeVisible();
      await expect(panel.getByText("No custom roles yet")).toBeVisible();
      expect(state.writes.map((write) => write.method)).toEqual([
        "POST",
        "PATCH",
        "POST",
        "DELETE",
        "DELETE",
      ]);
    });

    test("a refused write names the reason and keeps the form open", async ({ page }) => {
      const state = await rolesFixture(page);
      await page.goto("/settings/organization/roles");
      const panel = page.getByTestId("custom-roles");
      await panel.getByRole("button", { name: "Create custom role" }).click();
      await panel.getByLabel("Role name").fill("Too much");
      await panel.getByLabel("Role key").fill("too-much");
      await panel.getByLabel("principal:read").check();
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
