import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  createTotpOffsets,
  parseTotpSecret,
  totpCode,
} from "../helpers/totp.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const adminEmail = required("BAKERY_BROWSER_EMAIL");
const adminPassword = required("BAKERY_BROWSER_PASSWORD");

/**
 * Chromium's own WebAuthn stack, backed by a CDP virtual authenticator: the
 * page calls `navigator.credentials.*`, so the RP ID, secure-context and
 * user-verification rules a real browser enforces all apply.
 * `automaticPresenceSimulation: false` never completes the ceremony, which is
 * how a dismissed prompt is reproduced. The session is left attached for the
 * page's lifetime; detaching it would remove the authenticator.
 */
async function attachAuthenticator(
  page: Page,
  options: { automaticPresenceSimulation: boolean },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: options.automaticPresenceSimulation,
    },
  });
}

function identityStatus(page: Page): Promise<number> {
  return page.evaluate(() =>
    fetch("/v1/me", { headers: { accept: "application/json" } }).then((
      response,
    ) => response.status)
  );
}

/** The server's own list, not the DOM: the fixture refreshes the list only after a completed ceremony. */
function storedPasskeys(page: Page): Promise<unknown[]> {
  return page.evaluate(() =>
    fetch("/api/auth/passkey/list-user-passkeys", {
      headers: { accept: "application/json" },
    }).then((response) => response.json())
  );
}

test("adding a passkey, signing in with it and removing it keeps the two-factor rules", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/__test__/passkeys");
  await attachAuthenticator(page, { automaticPresenceSimulation: true });
  const credentials = await (
    await page.request.get("/__test__/passkeys/credentials")
  ).json() as { email: string; password: string };

  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");

  await page.getByLabel("Confirm your password").fill(credentials.password);
  await page.getByRole("button", { name: "Enable authenticator" }).click();
  await expect(page.locator("#enrollment-details")).toBeVisible();
  const totpUri = await page.getByTestId("totp-uri").textContent();
  if (!totpUri) throw new Error("TOTP_URI_MISSING");
  const secret = parseTotpSecret(totpUri);
  const nextOffset = createTotpOffsets();
  await page.locator("#verify-code").fill(await totpCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("Authenticator enabled.");

  await page.getByLabel("Passkey name").fill("Laptop");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status")).toHaveText("Passkey added.");
  await expect(page.getByTestId("passkeys").getByRole("listitem"))
    .toHaveCount(1);
  await expect(page.getByTestId("passkey-label")).toHaveText("Laptop");

  await page.getByTestId("passkeys").getByRole("textbox").fill("Desk");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByTestId("passkey-label")).toHaveText("Desk");

  // The rendered list, rename controls and identity section are only in the
  // accessibility tree while signed in; the signed-out audit below never sees them.
  expect(
    (await new AxeBuilder({ page }).include("main").analyze()).violations,
  ).toEqual([]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed out.");

  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Enter your authenticator code.",
  );
  expect(await identityStatus(page)).toBe(401);

  await page.locator("#challenge-code").fill(
    await totpCode(secret, { stepOffset: nextOffset() }),
  );
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");
  expect(await identityStatus(page)).toBe(200);

  await page.getByTestId("passkeys").getByRole("button", { name: "Remove" })
    .click();
  // Removal is confirmed on its own screen, so the emptied list proves the
  // server deleted the credential rather than the row simply disappearing.
  await page.getByRole("button", { name: "Remove passkey" }).click();
  await expect(page.getByTestId("passkeys").getByRole("listitem"))
    .toHaveCount(0);
});

test("canceling a ceremony changes nothing", async ({ page }) => {
  await page.goto("/__test__/passkeys");
  await attachAuthenticator(page, { automaticPresenceSimulation: false });

  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password", { exact: true }).fill(adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");
  await expect(page.getByTestId("passkeys").getByRole("listitem"))
    .toHaveCount(0);

  await page.getByLabel("Passkey name").fill("Phone");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Waiting for your authenticator…",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("status")).toHaveText("Canceled.");
  expect(await storedPasskeys(page)).toEqual([]);
  expect(await identityStatus(page)).toBe(200);
});

test("the passkeys fixture has no axe violations", async ({ page }) => {
  await page.goto("/__test__/passkeys");
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations).toEqual([]);
});
