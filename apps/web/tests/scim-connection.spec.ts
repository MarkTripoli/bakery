import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { firstRender } from "./helpers/first-render.ts";

registerPageHealth(test);

type Status = "none" | "active" | "revoked";

const CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000d1";
const SECRET = "bsc_playwrightSecretValue0123456789abcdefghij";

const credential = (id: string, status: "active" | "revoked" = "active") => ({
  id,
  prefix: "bsc_play",
  status,
  expiresAt: "2026-12-31T00:00:00.000Z",
  lastUsedAt: null,
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
  options: { initial: Status; forbidden?: boolean },
) {
  await mockAuthenticatedSession(page);
  const state = { current: options.initial, calls: [] as string[] };
  await page.route("**/v1/scim-connection**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    state.calls.push(`${request.method()} ${path}`);
    if (options.forbidden) return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
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
        page.getByRole("heading", { name: "SCIM provisioning" })
          .first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Create connection" }).click();
      const once = page.getByTestId("scim-token-once");
      await expect(once).toContainText(SECRET);
      await expect(once).toContainText("shown once");
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
      await page.getByRole("button", { name: "Rotate credential" }).click();
      const dialog = page.getByRole("alertdialog", {
        name: "Rotate the SCIM credential?",
      });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(state.calls.filter((call) => call.includes("rotate"))).toEqual([]);
      await page.getByRole("button", { name: "Rotate credential" }).click();
      await dialog.getByRole("button", { name: "Rotate", exact: true }).click();
      await expect(page.getByTestId("scim-token-once")).toContainText(SECRET);
      await page.getByRole("button", { name: "I have stored the token" })
        .click();
      await page.getByRole("button", { name: "Revoke connection" }).click();
      await page.getByRole("alertdialog", {
        name: "Revoke the SCIM connection?",
      })
        .getByRole("button", { name: "Revoke", exact: true }).click();
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
  });
}
