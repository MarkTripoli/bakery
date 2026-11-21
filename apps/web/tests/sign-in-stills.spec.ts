import { expect, test } from "@playwright/test";
import { still } from "./helpers/stills.ts";

// #241 evidence: the sign-in family and the account rows it touches, as
// stills. A still is written only when BAKERY_EVIDENCE_DIR is set.

const STATES = [
  ["sign-in", "login-github-disabled", "sign-in"],
  ["sign-in-wrong-password", "login-invalid", "sign-in-failure"],
  ["sign-in-too-many-tries", "login-rate-limited", "sign-in-failure"],
  ["forgot-password", "forgot-default", "forgot-password"],
  ["invitation-needed", "join-default", "join"],
  ["new-accounts-paused", "join-disabled", "registration-paused"],
  ["change-password", "password-default", "change-password"],
  ["account-and-security", "security-hub-default", "security-hub"],
  ["passkeys-empty", "passkeys-default", "passkeys-none"],
  ["connected-clients", "clients-default", "connected-clients"],
  ["connected-clients-empty", "clients-empty", "security-empty"],
  ["profile", "profile-default", "profile-settings"],
  ["access-levels", "your-access-default", "access-settings"],
  ["access-levels-no-access", "your-access-no-access", "access-no-grant"],
] as const;

for (const [name, specimen, marker] of STATES) {
  test(`still: ${name}`, async ({ page }) => {
    await page.goto(`/__fixtures__/auth/${specimen}`);
    await expect(page.getByTestId(marker).first()).toBeVisible();
    await still(page, name);
  });
}
