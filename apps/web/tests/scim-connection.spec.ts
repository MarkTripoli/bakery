import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { firstRender } from "./helpers/first-render.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

type Status = "none" | "active" | "revoked";

const CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000d1";
const SECRET = "bsc_playwrightSecretValue0123456789abcdefghij";

const credential = (
  id: string,
  status: "active" | "revoked" | "expired" = "active",
  lastUsedAt: string | null = null,
) => ({
  id,
  prefix: "bsc_play",
  status,
  expiresAt: "2026-12-31T12:00:00.000Z",
  lastUsedAt,
  createdAt: "2026-10-13T00:00:00.000Z",
  revokedAt: status === "revoked" ? "2026-10-14T00:00:00.000Z" : null,
});

function connection(status: Status, credentials = [credential(CREDENTIAL_ID)]) {
  return {
    status,
    id: status === "none" ? null : "00000000-0000-4000-8000-0000000000c1",
    baseUrl: status === "none"
      ? null
      : "http://127.0.0.1:5173/api/auth/scim/v2",
    createdAt: status === "none" ? null : "2026-10-13T00:00:00.000Z",
    credentials: status === "none" ? [] : credentials,
  };
}

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

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

async function scimFixture(
  page: Page,
  options: { initial: Status; forbidden?: boolean; hidden?: boolean },
) {
  await mockAuthenticatedSession(page);
  const state = { current: options.initial, calls: [] as string[] };
  await page.route("**/v1/scim-connection**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    state.calls.push(`${request.method()} ${path}`);
    if (options.forbidden) return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    // The real server answers a plain member's read with 404.
    if (options.hidden) {
      return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
    }
    if (request.method() === "GET") {
      return route.fulfill(json(200, connection(state.current)));
    }
    if (path.endsWith("/revoke")) {
      state.current = "revoked";
      return route.fulfill(
        json(
          201,
          connection("revoked", [credential(CREDENTIAL_ID, "revoked")]),
        ),
      );
    }
    state.current = "active";
    return route.fulfill(
      json(201, { connection: connection("active"), token: SECRET }),
    );
  });
  return state;
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("an admin creates the connection and sees the token once", async ({ page }) => {
      const state = await scimFixture(page, {
        initial: "none",
      });
      await page.goto("/settings/scim");
      await expect(
        page.getByRole("heading", { name: "SCIM", exact: true })
          .first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Create connection" }).click();
      const once = page.getByTestId("scim-token-once");
      await expect(once).toContainText(SECRET);
      await expect(once).toContainText("not shown again");
      expect(state.calls).toContain("POST /v1/scim-connection");
      await page.getByRole("button", { name: "I have stored the token" })
        .click();
      await expect(page.getByTestId("scim-token-once")).toHaveCount(0);
      // The secret never reaches storage or a later read.
      const stored = await page.evaluate(() =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage })
      );
      expect(stored).not.toContain(SECRET);
      await page.reload();
      await expect(page.getByText(SECRET)).toHaveCount(0);
      await expect(page.getByText("http://127.0.0.1:5173/api/auth/scim/v2"))
        .toBeVisible();
    });

    test("rotate and revoke ask for confirmation", async ({ page }) => {
      const state = await scimFixture(page, {
        initial: "active",
      });
      await page.goto("/settings/scim");
      await page.getByRole("button", { name: "Rotate token", exact: true })
        .click();
      const dialog = page.getByRole("alertdialog", {
        name: "Rotate the SCIM token?",
      });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(state.calls.filter((call) => call.includes("rotate"))).toEqual([]);
      await page.getByRole("button", { name: "Rotate token", exact: true })
        .click();
      await dialog.getByRole("button", { name: "Rotate token", exact: true })
        .click();
      await expect(page.getByTestId("scim-token-once")).toContainText(SECRET);
      await page.getByRole("button", { name: "I have stored the token" })
        .click();
      await page.getByRole("button", { name: "Revoke token", exact: true })
        .click();
      await page.getByRole("alertdialog", {
        name: "Revoke the SCIM token?",
      })
        .getByRole("button", { name: "Revoke token", exact: true }).click();
      await expect(page.getByText("Revoked").first()).toBeVisible();
      expect(state.calls).toContain("POST /v1/scim-connection/revoke");
    });

    test("a non-admin sees the forbidden notice and no controls", async ({ page }) => {
      await scimFixture(page, {
        initial: "none",
        forbidden: true,
      });
      await firstRender(
        () => page.goto("/settings/scim"),
        (timeout) =>
          expect(
            page.getByText(
              "Only organization administrators can manage SCIM provisioning.",
            ),
          ).toBeVisible({ timeout }),
      );
      await expect(page.getByRole("button", { name: "Create connection" }))
        .toHaveCount(0);
    });

    test("sits under the Organization breadcrumb, as the Paper frames draw it", async ({ page }) => {
      test.skip(viewport.name === "phone", "a phone shows the section title");
      await scimFixture(page, { initial: "none" });
      await page.goto("/settings/scim");
      const trail = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(trail.getByText("SCIM", { exact: true })).toBeVisible();
      await expect(trail.getByText("Organization", { exact: true }))
        .toBeVisible();
      await expect(trail.getByText("Settings", { exact: true })).toHaveCount(0);
    });

    test("sits in the same column and uses the same buttons as the SSO page", async ({ page }) => {
      await scimFixture(page, { initial: "active" });
      await page.goto("/settings/scim");
      await shot(page, "scim-connection");
      const column = (await page.getByTestId("scim-connection").boundingBox())!;
      if (viewport.name === "desktop") {
        // The settings column every settings page shares: 760 px, from the same left edge.
        expect(Math.round(column.width)).toBe(760);
      }
      // Every button on the page is the default Button inside a settings page: 44 px.
      const buttons = page.getByTestId("scim-connection").locator(".ui-button");
      const count = await buttons.count();
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const box = await buttons.nth(index).boundingBox();
        if (box) expect(Math.round(box.height)).toBe(44);
      }
    });

    test("credentials are a table on a wide screen and a list of rows on a phone", async ({ page }) => {
      await scimFixture(page, { initial: "active" });
      await page.route(
        "**/v1/scim-connection",
        (route) =>
          route.request().method() === "GET"
            ? route.fulfill(
              json(
                200,
                connection("active", [
                  credential(
                    "00000000-0000-4000-8000-0000000000d1",
                    "active",
                    "2026-11-11T12:00:00.000Z",
                  ),
                  credential("00000000-0000-4000-8000-0000000000d2", "active"),
                  credential("00000000-0000-4000-8000-0000000000d3", "revoked"),
                  credential("00000000-0000-4000-8000-0000000000d4", "expired"),
                ]),
              ),
            )
            : route.fallback(),
      );
      await page.goto("/settings/scim");
      await expect(page.getByText("bsc_play").first()).toBeVisible();
      await shot(page, "scim-credentials");
      const list = page.getByTestId("scim-credentials-list");
      if (viewport.name === "desktop") {
        await expect(list).toHaveCount(0);
        await expect(page.getByRole("table", { name: "SCIM credentials" }))
          .toBeVisible();
        return;
      }
      await expect(page.getByRole("table", { name: "SCIM credentials" }))
        .toHaveCount(0);
      const rows = list.getByRole("listitem");
      await expect(rows).toHaveCount(4);
      // Line 1 is the credential and its status; line 2 the dates, short, with no time.
      await expect(rows.nth(0)).toContainText("bsc_play…");
      await expect(rows.nth(0)).toContainText("Status: Active");
      await expect(rows.nth(0)).toContainText(
        "Expires Dec 31, 2026 · Last used Nov 11, 2026",
      );
      await expect(rows.nth(1)).toContainText(
        "Expires Dec 31, 2026 · Never used",
      );
      await expect(rows.nth(2)).toContainText("Status: Revoked");
      await expect(rows.nth(3)).toContainText("Status: Expired");
      // No date wraps: each detail line is one line tall.
      const detail = await rows.nth(0).locator("[class*='detail']").first()
        .boundingBox();
      if (detail) expect(detail.height).toBeLessThan(28);
      // Rotate and Revoke are still the page's own buttons, below the list.
      const revoke = page.getByRole("button", {
        name: "Revoke token",
        exact: true,
      });
      const last = (await rows.nth(3).boundingBox())!;
      expect((await revoke.boundingBox())!.y).toBeGreaterThan(last.y);
    });

    test("the lifetime select and Create connection have a gap between them", async ({ page }) => {
      await scimFixture(page, { initial: "none" });
      await page.goto("/settings/scim");
      // The create form's own select; the rotate dialog holds another one.
      const select = page.getByRole("combobox", { name: "Credential lifetime" })
        .first();
      const create = page.getByRole("button", { name: "Create connection" });
      await expect(create).toBeVisible();
      const selectBox = (await select.boundingBox())!;
      const createBox = (await create.boundingBox())!;
      const gap = createBox.y - (selectBox.y + selectBox.height);
      // The standard field gap, not touching.
      expect(gap).toBeGreaterThanOrEqual(8);
    });

    test("a refused read is an information notice, not an error alert", async ({ page }) => {
      await scimFixture(page, { initial: "none", forbidden: true });
      await page.goto("/settings/scim");
      const refusal =
        "Only organization administrators can manage SCIM provisioning.";
      await expect(page.getByText(refusal)).toBeVisible();
      await expect(
        page.getByRole("status").filter({ hasText: refusal }),
      ).toHaveCount(1);
      await expect(page.getByRole("alert").filter({ hasText: refusal }))
        .toHaveCount(0);
    });

    test("a member whose read the server answers with 404 sees the forbidden notice", async ({ page }) => {
      await scimFixture(page, { initial: "none", hidden: true });
      await page.goto("/settings/scim");
      await expect(
        page.getByText(
          "Only organization administrators can manage SCIM provisioning.",
        ),
      ).toBeVisible();
      await expect(page.getByText("could not be loaded", { exact: false }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: "Create connection" }))
        .toHaveCount(0);
    });
  });
}
