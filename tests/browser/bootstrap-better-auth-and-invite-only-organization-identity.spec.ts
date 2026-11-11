import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const baseURL = required("BAKERY_BROWSER_BASE_URL");
const email = required("BAKERY_BROWSER_EMAIL");
const password = required("BAKERY_BROWSER_PASSWORD");

test("real provider cookies resolve identity and revoke immediately", async ({ context, page }) => {
  await page.goto("/__test__/auth");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("status")).toHaveText("Signed in.");
  await expect(page.getByTestId("principal-id")).toHaveText(
    /^[0-9a-f-]{36}$/,
  );
  await expect(page.getByTestId("principal-type")).toHaveText("human");
  await expect(page.getByTestId("display-name")).toHaveText("Browser Admin");

  const cookie = (await context.cookies(baseURL)).find(({ name }) =>
    name.endsWith("session_token")
  );
  expect(cookie).toBeDefined();
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(new URL(baseURL).protocol === "https:");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed out.");
  await expect(page.getByRole("region", { name: "Identity" })).toBeHidden();

  await context.addCookies([cookie!]);
  const stale = await page.evaluate(async () => {
    const response = await fetch("/v1/me", {
      headers: { accept: "application/json" },
    });
    return { status: response.status, body: await response.json() };
  });
  expect(stale.status).toBe(401);
  expect(stale.body).toMatchObject({ code: "AUTH_INVALID" });
  expect(stale.body).not.toHaveProperty("principalId");
  expect(stale.body).not.toHaveProperty("displayName");
});

test("provider rejects a hostile browser origin", async ({ request }) => {
  const response = await request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: {
      origin: "https://hostile.example.test",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
  const body = await response.text();
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(body).toContain("CROSS_SITE_NAVIGATION_LOGIN_BLOCKED");
  expect(body).not.toContain(password);
});

test("test-only sign-in fixture has no axe violations", async ({ page }) => {
  await page.goto("/__test__/auth");
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations).toEqual([]);
});
