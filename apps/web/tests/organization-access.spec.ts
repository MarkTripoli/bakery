import { expect, type Page, type Route, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

const ORG = MOCK_ORGANIZATION_ID;
const ADMIN_PRINCIPAL = "00000000-0000-4000-8000-000000000001";
const DEVELOPER_PRINCIPAL = "00000000-0000-4000-8000-0000000000d1";
const VIEWER_PRINCIPAL = "00000000-0000-4000-8000-0000000000e1";
const BOT_PRINCIPAL = "00000000-0000-4000-8000-0000000000b1";
const APP_ID = "00000000-0000-4000-8000-0000000000a1";
const REPO_ID = "00000000-0000-4000-8000-0000000000c1";
const M_ADMIN = "00000000-0000-4000-8000-000000000257";
const M_DEV = "00000000-0000-4000-8000-000000000258";
const M_VIEWER = "00000000-0000-4000-8000-000000000259";
const M_BOT = "00000000-0000-4000-8000-000000000260";
const INV_1 = "00000000-0000-4000-8000-000000000267";
const INV_9 = "00000000-0000-4000-8000-000000000275";
const INV_2 = "00000000-0000-4000-8000-000000000268";
const TOK_1 = "00000000-0000-4000-8000-000000000277";
const TOK_2 = "00000000-0000-4000-8000-000000000278";
const BIND_1 = "00000000-0000-4000-8000-000000000287";
const BIND_9 = "00000000-0000-4000-8000-000000000295";
const BIND_2 = "00000000-0000-4000-8000-000000000288";
const CLIENT_1 = "00000000-0000-4000-8000-000000000297";
const STAMP = "2026-10-01T00:00:00.000Z";

type Body = Record<string, unknown>;
type Seen = {
  method: string;
  path: string;
  body: Body | null;
  headers: Record<string, string>;
};

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: `https://bakery.example/problems/${code}`,
    title: code,
    detail: code,
    status,
    code,
    retryable: false,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  }),
});
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type World = {
  role: "admin" | "developer";
  membersStatus: number;
  memberships: Body[];
  invitations: Body[];
  principals: Body[];
  tokens: Body[];
  bindings: Body[];
  /** The caller's connected clients (any organization). */
  clients: Body[];
  lastAdminConflict: boolean;
  seen: Seen[];
};

function membership(id: string, principalId: string, role: string): Body {
  return {
    id,
    organizationId: ORG,
    principalId,
    role,
    status: "active",
    joinedAt: STAMP,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  };
}
function principal(id: string, displayName: string, type = "human"): Body {
  return {
    id,
    principalType: type,
    displayName,
    disabledAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  };
}

function fullWorld(): World {
  return {
    role: "admin",
    membersStatus: 200,
    memberships: [
      membership(M_ADMIN, ADMIN_PRINCIPAL, "admin"),
      membership(M_DEV, DEVELOPER_PRINCIPAL, "developer"),
      membership(M_VIEWER, VIEWER_PRINCIPAL, "viewer"),
      membership(M_BOT, BOT_PRINCIPAL, "developer"),
    ],
    invitations: [{
      id: INV_1,
      organizationId: ORG,
      email: "sam@example.test",
      role: "guest",
      status: "pending",
      expiresAt: "2026-10-17T00:00:00.000Z",
      inviterPrincipalId: ADMIN_PRINCIPAL,
      createdAt: STAMP,
    }],
    principals: [
      principal(ADMIN_PRINCIPAL, "Ada Rivera"),
      principal(DEVELOPER_PRINCIPAL, "Jon Okafor"),
      principal(VIEWER_PRINCIPAL, "Priya Nair"),
      principal(BOT_PRINCIPAL, "ci-deployer", "service"),
    ],
    tokens: [{
      id: TOK_1,
      organizationId: ORG,
      principalId: BOT_PRINCIPAL,
      createdByPrincipalId: ADMIN_PRINCIPAL,
      name: "deploy",
      prefix: "bk_…9d2f",
      scopes: ["bakery:operate"],
      expiresAt: "2026-12-01T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      createdAt: STAMP,
      updatedAt: STAMP,
      version: 1,
    }],
    bindings: [{
      id: BIND_1,
      organizationId: ORG,
      principalId: DEVELOPER_PRINCIPAL,
      roleKey: "developer",
      scopeType: "application",
      scopeId: APP_ID,
      grantedByPrincipalId: ADMIN_PRINCIPAL,
      createdAt: STAMP,
      updatedAt: STAMP,
      version: 1,
    }],
    clients: [{
      id: CLIENT_1,
      clientId: "bakery-cli",
      clientName: "Bakery CLI",
      organizationId: ORG,
      organizationName: "Fixture Org",
      scopes: ["bakery:read"],
      authorizedAt: "2026-10-02T00:00:00.000Z",
      lastUsedAt: null,
    }],
    lastAdminConflict: false,
    seen: [],
  };
}

function emptyWorld(): World {
  return {
    ...fullWorld(),
    memberships: [membership(M_ADMIN, ADMIN_PRINCIPAL, "admin")],
    invitations: [],
    principals: [principal(ADMIN_PRINCIPAL, "Ada Rivera")],
    tokens: [],
    bindings: [],
    clients: [],
  };
}

const page_ = (items: unknown[]) => json({ items, nextCursor: null });

async function accessFixture(page: Page, world: World) {
  await mockAuthenticatedSession(page);
  await page.route(
    "**/v1/me/connected-clients",
    (route) => route.fulfill(json({ items: world.clients })),
  );
  const handle = (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" ? null : request.postDataJSON() as Body;
    world.seen.push({
      method,
      path,
      body,
      headers: request.headers(),
    });
    const key = `${method} ${path}`;
    if (key === `GET /v1/organizations/${ORG}/effective-access`) {
      return route.fulfill(json({
        organizationId: ORG,
        role: world.role,
        capabilities: ["task:read"],
      }));
    }
    if (key === `GET /v1/organizations/${ORG}`) {
      return route.fulfill(json({
        id: ORG,
        name: "Acme Bakeries",
        slug: "acme",
        logo: null,
        metadata: {},
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
        defaultLocale: null,
      }));
    }
    if (key === `GET /v1/organizations/${ORG}/memberships`) {
      return world.membersStatus === 200
        ? route.fulfill(page_(world.memberships))
        : route.fulfill(problem(world.membersStatus, "INTERNAL_ERROR"));
    }
    if (key === `PATCH /v1/organizations/${ORG}/memberships/${M_DEV}`) {
      const row = world.memberships.find((item) => item.id === M_DEV)!;
      Object.assign(row, body, { version: Number(row.version) + 1 });
      return route.fulfill(json(row));
    }
    if (key.startsWith(`DELETE /v1/organizations/${ORG}/memberships/`)) {
      if (world.lastAdminConflict) {
        return route.fulfill(problem(409, "STATE_CONFLICT"));
      }
      const id = path.split("/").pop();
      world.memberships = world.memberships.filter((item) => item.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (key === `GET /v1/organizations/${ORG}/invitations`) {
      return route.fulfill(page_(world.invitations));
    }
    if (key === `POST /v1/organizations/${ORG}/invitations`) {
      const created = {
        id: world.invitations.length === 1 ? INV_2 : INV_9,
        organizationId: ORG,
        email: body!.email,
        role: body!.role,
        status: "pending",
        expiresAt: "2026-10-20T00:00:00.000Z",
        inviterPrincipalId: ADMIN_PRINCIPAL,
        createdAt: STAMP,
      };
      world.invitations.push(created);
      return route.fulfill(json(created, 201));
    }
    if (key.startsWith(`DELETE /v1/organizations/${ORG}/invitations/`)) {
      const id = path.split("/").pop();
      world.invitations = world.invitations.filter((item) => item.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (key === "GET /v1/principals") {
      return route.fulfill(page_(world.principals));
    }
    if (key === "POST /v1/principals") {
      const created = principal(
        `00000000-0000-4000-8000-0000000000f${world.principals.length}`,
        String(body!.displayName),
        "service",
      );
      world.principals.push(created);
      world.memberships.push(
        membership(
          String(created.id).replace("-0000000000f", "-0000000001f"),
          String(created.id),
          String(body!.role),
        ),
      );
      return route.fulfill(json(created, 201));
    }
    if (key === "GET /v1/access-tokens") {
      return route.fulfill(page_(world.tokens));
    }
    if (key === "POST /v1/access-tokens") {
      const created = {
        id: TOK_2,
        organizationId: ORG,
        principalId: body!.principalId,
        createdByPrincipalId: ADMIN_PRINCIPAL,
        name: body!.name,
        prefix: "bk_…e07a",
        scopes: body!.scopes,
        expiresAt: body!.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      };
      world.tokens.push(created);
      return route.fulfill(
        json({ ...created, secret: "bk_live_4c81SECRET_e07a" }, 201),
      );
    }
    if (method === "DELETE" && path.startsWith("/v1/access-tokens/")) {
      const id = path.split("/").pop();
      const row = world.tokens.find((item) => item.id === id)!;
      row.revokedAt = STAMP;
      return route.fulfill({ status: 204 });
    }
    if (key === "GET /v1/access-bindings") {
      return route.fulfill(page_(world.bindings));
    }
    if (key === "POST /v1/access-bindings") {
      const created = {
        id: world.bindings.length === 1 ? BIND_2 : BIND_9,
        organizationId: ORG,
        principalId: body!.principalId,
        roleKey: body!.roleKey,
        scopeType: body!.scopeType,
        scopeId: body!.scopeId,
        grantedByPrincipalId: ADMIN_PRINCIPAL,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      };
      world.bindings.push(created);
      return route.fulfill(json(created, 201));
    }
    if (method === "DELETE" && path.startsWith("/v1/access-bindings/")) {
      const id = path.split("/").pop();
      world.bindings = world.bindings.filter((item) => item.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (key === "GET /v1/applications") {
      return route.fulfill(page_([{
        id: APP_ID,
        slug: "storefront",
        name: "storefront",
        description: "",
        archivedAt: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      }]));
    }
    if (key === "GET /v1/repositories") {
      return route.fulfill(page_([{
        id: REPO_ID,
        applicationId: APP_ID,
        slug: null,
        integrationConnectionId: "00000000-0000-4000-8000-0000000000e9",
        providerRepoId: "1",
        owner: "acme",
        name: "oven-api",
        defaultBranch: "main",
        activeProfileId: null,
        archivedAt: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      }]));
    }
    return route.fallback();
  };
  for (
    const pattern of [
      `**/v1/organizations/${ORG}`,
      `**/v1/organizations/${ORG}/**`,
      "**/v1/principals",
      "**/v1/principals?**",
      "**/v1/access-tokens**",
      "**/v1/access-bindings**",
      "**/v1/applications**",
      "**/v1/repositories**",
    ]
  ) await page.route(pattern, handle);
}

const sent = (world: World, method: string, path: string) =>
  world.seen.filter((item) => item.method === method && item.path === path);

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`organization access (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("lists members with scoped roles, invitations, service accounts, tokens and clients", async ({ page }) => {
      const world = fullWorld();
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await expect(page.locator("main h1")).toHaveText("Members & access");
      await expect(page.getByTestId("org-access-members")).toContainText(
        "Ada Rivera",
      );
      if (viewport.name === "desktop") {
        await expect(
          page.getByRole("heading", { name: /Members · 4 people/ }),
        ).toBeVisible();
      } else {
        // A phone moves the counts into the page summary.
        await expect(page.getByRole("heading", { name: "Members" }))
          .toBeVisible();
        await expect(page.getByText("4 people · 1 pending invitation"))
          .toBeVisible();
      }
      // The scoped developer role shows under its member, named by resource.
      const jon = page.getByTestId(`org-access-member-${M_DEV}`);
      await expect(jon).toContainText("Organization · Developer");
      await expect(page.getByTestId(`org-access-binding-${BIND_1}`))
        .toContainText("Application · Developer");
      await expect(page.getByTestId(`org-access-binding-${BIND_1}`))
        .toContainText("storefront");
      await expect(page.getByTestId(`org-access-invitation-${INV_1}`))
        .toContainText("sam@example.test");
      await expect(page.getByTestId(`org-access-invitation-${INV_1}`))
        .toContainText("Organization · Guest");
      await expect(page.getByTestId("org-access-account-" + BOT_PRINCIPAL))
        .toContainText("ci-deployer");
      await expect(page.getByTestId(`org-access-token-${TOK_1}`))
        .toContainText("bk_…9d2f");
      await expect(page.getByTestId("org-access-clients"))
        .toContainText("Bakery CLI");
      // The page never scrolls sideways, on a phone least of all.
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - globalThis.innerWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test("an organization with only you shows the first-invite empty state", async ({ page }) => {
      const world = emptyWorld();
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await expect(page.getByTestId("org-access-empty")).toContainText(
        "Only you are in this organization",
      );
      await expect(page.getByTestId("org-access-invite-first")).toBeVisible();
      // The header action stays on a wide screen; a phone keeps only the card's.
      if (viewport.name === "desktop") {
        await expect(page.getByTestId("org-access-invite")).toBeVisible();
      } else {
        await expect(page.getByTestId("org-access-invite")).toBeHidden();
      }

      // The card hides the accounts section, so it offers the first service
      // account itself; once one exists the sections take over.
      await page.getByTestId("org-access-new-account-first").click();
      const form = page.getByTestId("org-access-account-form");
      await form.getByLabel("Name").fill("release-bot");
      await form.getByRole("button", { name: "Create service account" })
        .click();
      await expect(page.getByTestId("org-access-empty")).toHaveCount(0);
      await expect(page.getByTestId("org-access-accounts")).toContainText(
        "release-bot",
      );
      expect(
        world.seen.some((entry) =>
          entry.method === "POST" && entry.path === "/v1/principals"
        ),
      ).toBe(true);
    });

    test("a connected client alone keeps the sections, so it can be revoked", async ({ page }) => {
      const world = { ...emptyWorld(), clients: fullWorld().clients };
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await expect(page.getByTestId("org-access-clients")).toContainText(
        "Bakery CLI",
      );
      await expect(page.getByTestId("org-access-empty")).toHaveCount(0);
    });

    test("the page waits for connected clients before it picks the empty card", async ({ page }) => {
      const world = { ...emptyWorld(), clients: fullWorld().clients };
      await accessFixture(page, world);
      // Registered last, so it takes the client read before the fixture does.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/v1/me/connected-clients", async (route) => {
        await held;
        await route.fulfill(json({ items: world.clients }));
      });
      await page.goto("/settings/organization/access");
      // Every other admin read has answered; only the client read is held.
      await expect.poll(() =>
        [
          `/v1/organizations/${ORG}/memberships`,
          `/v1/organizations/${ORG}/invitations`,
          "/v1/principals",
          "/v1/access-tokens",
          "/v1/access-bindings",
        ].every((path) => sent(world, "GET", path).length > 0)
      ).toBe(true);
      await expect(page.getByTestId("org-access-loading")).toBeVisible();
      await expect(page.getByTestId("org-access-empty")).toHaveCount(0);
      release();
      await expect(page.getByTestId("org-access-clients")).toContainText(
        "Bakery CLI",
      );
      await expect(page.getByTestId("org-access-empty")).toHaveCount(0);
    });

    test("a non-admin gets a notice and no admin data is read", async ({ page }) => {
      const world = fullWorld();
      world.role = "developer";
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await expect(page.getByTestId("org-access-forbidden")).toBeVisible();
      await expect(page.getByTestId("org-access-members")).toHaveCount(0);
      expect(sent(world, "GET", `/v1/organizations/${ORG}/invitations`))
        .toHaveLength(0);
      expect(sent(world, "GET", "/v1/access-tokens")).toHaveLength(0);
      expect(sent(world, "GET", "/v1/access-bindings")).toHaveLength(0);
    });

    test("a failed read shows an error and retry recovers", async ({ page }) => {
      const world = fullWorld();
      world.membersStatus = 500;
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await expect(page.getByTestId("org-access-error")).toBeVisible();
      await expect(page.getByTestId("org-access-members")).toHaveCount(0);
      world.membersStatus = 200;
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByTestId("org-access-members")).toContainText(
        "Ada Rivera",
      );
      await expect(page.getByTestId("org-access-error")).toHaveCount(0);
    });

    test("inviting a guest adds a pending invitation and cancelling removes it", async ({ page }) => {
      const world = fullWorld();
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await page.getByTestId("org-access-invite").click();
      await page.getByLabel("Email address").fill("guest@example.test");
      await page.getByLabel("Organization role").selectOption("guest");
      await page.getByTestId("org-access-invite-send").click();
      await expect(page.getByTestId(`org-access-invitation-${INV_2}`))
        .toContainText("guest@example.test");
      const posted = sent(
        world,
        "POST",
        `/v1/organizations/${ORG}/invitations`,
      );
      expect(posted).toHaveLength(1);
      expect(posted[0].body).toEqual({
        email: "guest@example.test",
        role: "guest",
      });
      expect(posted[0].headers["idempotency-key"]).toBeTruthy();

      await page.getByTestId(`org-access-cancel-${INV_2}`).click();
      await page.getByTestId("org-access-confirm-action").click();
      await expect(page.getByTestId(`org-access-invitation-${INV_2}`))
        .toHaveCount(0);
      await expect(page.getByTestId(`org-access-invitation-${INV_1}`))
        .toBeVisible();
    });

    test("a service account token is shown once, then revoked", async ({ page }) => {
      const world = fullWorld();
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await page.getByTestId("org-access-new-token-action").click();
      await page.getByLabel("Token name").fill("release");
      await page.getByLabel("Scope").selectOption("bakery:read");
      await page.getByTestId("org-access-token-create").click();
      await expect(page.getByTestId("org-access-token-secret")).toHaveText(
        "bk_live_4c81SECRET_e07a",
      );
      // A touch screen always shows the dismiss, so it must not cover the
      // one-time value.
      const callout = page.getByTestId("org-access-new-token");
      if (await page.evaluate(() => matchMedia("(hover: none)").matches)) {
        const value = await callout.locator("code").boundingBox();
        const dismiss = await callout.getByRole("button", { name: /dismiss/i })
          .boundingBox();
        expect(value).not.toBeNull();
        expect(dismiss).not.toBeNull();
        const overlaps = value!.x < dismiss!.x + dismiss!.width &&
          dismiss!.x < value!.x + value!.width &&
          value!.y < dismiss!.y + dismiss!.height &&
          dismiss!.y < value!.y + value!.height;
        expect(overlaps).toBe(false);
      }
      const posted = sent(world, "POST", "/v1/access-tokens")[0];
      expect(posted.body).toMatchObject({
        principalId: BOT_PRINCIPAL,
        name: "release",
        scopes: ["bakery:read"],
      });
      // The secret is gone once dismissed and never comes back from the list.
      await page.getByTestId("org-access-new-token").getByRole("button", {
        name: /dismiss/i,
      }).click();
      await expect(page.getByTestId("org-access-token-secret")).toHaveCount(0);
      await page.reload();
      await expect(page.getByText("bk_live_4c81SECRET_e07a")).toHaveCount(0);
      await expect(page.getByTestId(`org-access-token-${TOK_2}`)).toBeVisible();

      await page.getByTestId(`org-access-revoke-${TOK_1}`).click();
      await page.getByTestId("org-access-confirm-action").click();
      await expect(page.getByTestId(`org-access-token-${TOK_1}`)).toHaveCount(
        0,
      );
      const revoke = sent(world, "DELETE", `/v1/access-tokens/${TOK_1}`)[0];
      expect(revoke.headers["if-match"]).toBe('"v1"');
    });

    test("changing a role and adding then removing a scoped role sends the right requests", async ({ page }) => {
      const world = fullWorld();
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await page.getByTestId(`org-access-edit-${M_DEV}`).click();
      const dialog = page.getByTestId("org-access-edit-dialog");
      await dialog.getByLabel("Organization role").selectOption("viewer");
      await dialog.getByTestId("org-access-role-save").click();
      await expect(page.getByTestId(`org-access-member-${M_DEV}`))
        .toContainText(
          "Organization · Viewer",
        );
      const patch = sent(
        world,
        "PATCH",
        `/v1/organizations/${ORG}/memberships/${M_DEV}`,
      )[0];
      expect(patch.body).toEqual({ role: "viewer" });
      expect(patch.headers["if-match"]).toBe('"v1"');

      await page.getByTestId(`org-access-edit-${M_VIEWER}`).click();
      await dialog.getByLabel("Kind of scope").selectOption(
        "repository",
      );
      await dialog.getByLabel("Application or repository").selectOption(
        REPO_ID,
      );
      await dialog.getByTestId("org-access-binding-add").click();
      await expect(page.getByTestId(`org-access-binding-${BIND_2}`))
        .toContainText("Repository · Viewer");
      await expect(page.getByTestId(`org-access-binding-${BIND_2}`))
        .toContainText("oven-api");
      expect(sent(world, "POST", "/v1/access-bindings")[0].body).toEqual({
        principalId: VIEWER_PRINCIPAL,
        roleKey: "viewer",
        scopeType: "repository",
        scopeId: REPO_ID,
      });
      await dialog.getByRole("button", { name: "Close dialog" }).click();

      await page.getByTestId(`org-access-binding-${BIND_2}`)
        .getByRole("button", { name: "Remove" }).click();
      await page.getByTestId("org-access-confirm-action").click();
      await expect(page.getByTestId(`org-access-binding-${BIND_2}`))
        .toHaveCount(
          0,
        );
      expect(
        sent(world, "DELETE", `/v1/access-bindings/${BIND_2}`)[0]
          .headers["if-match"],
      ).toBe('"v1"');
    });

    test("removing the last admin is refused and nothing changes", async ({ page }) => {
      const world = fullWorld();
      world.lastAdminConflict = true;
      await accessFixture(page, world);
      await page.goto("/settings/organization/access");
      await page.getByTestId(`org-access-edit-${M_ADMIN}`).click();
      await page.getByTestId("org-access-member-remove").click();
      await page.getByTestId("org-access-confirm-action").click();
      await expect(page.getByTestId("org-access-notice")).toContainText(
        "without an admin",
      );
      await expect(
        page.getByTestId("org-access-edit-dialog").getByTestId(
          "org-access-notice",
        ),
      ).toContainText("without an admin");
      await expect(page.getByTestId(`org-access-member-${M_ADMIN}`))
        .toBeVisible();
    });
  });
}
