import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  createTotpOffsets,
  parseTotpSecret,
  totpCode,
} from "../helpers/totp.ts";

test("enrolling an authenticator blocks access until verified and challenges the next sign-in", async ({ page }) => {
  await page.goto("/__test__/two-factor");
  const credentials = await (
    await page.request.get("/__test__/two-factor/credentials")
  ).json() as { email: string; password: string };

  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");
  await expect(page.getByRole("heading", { name: "Enable authenticator" }))
    .toBeVisible();

  await page.getByLabel("Confirm your password").fill(credentials.password);
  await page.getByRole("button", { name: "Enable authenticator" }).click();
  await expect(page.locator("#enrollment-details")).toBeVisible();
  const totpUri = await page.getByTestId("totp-uri").textContent();
  if (!totpUri) throw new Error("TOTP_URI_MISSING");
  const secret = parseTotpSecret(totpUri);
  const nextOffset = createTotpOffsets();
  await expect(page.getByTestId("backup-codes").getByRole("listitem"))
    .toHaveCount(10);

  await page.locator("#verify-code").fill(await totpCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("Authenticator enabled.");

  expect(
    await page.evaluate(() =>
      fetch("/v1/me", { headers: { accept: "application/json" } }).then((
        response,
      ) => response.status)
    ),
  ).toBe(200);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed out.");

  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Enter your authenticator code.",
  );

  expect(
    await page.evaluate(() =>
      fetch("/v1/me", { headers: { accept: "application/json" } }).then((
        response,
      ) => response.status)
    ),
  ).toBe(401);

  await page.locator("#challenge-code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  await page.locator("#challenge-code").fill(
    await totpCode(secret, { stepOffset: nextOffset() }),
  );
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");

  expect(
    await page.evaluate(() =>
      fetch("/v1/me", { headers: { accept: "application/json" } }).then((
        response,
      ) => response.status)
    ),
  ).toBe(200);
});

test("the two-factor fixture has no axe violations", async ({ page }) => {
  await page.goto("/__test__/two-factor");
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations).toEqual([]);
});
