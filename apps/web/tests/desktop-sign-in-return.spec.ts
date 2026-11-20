import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect as baseExpect, test } from "@playwright/test";
import { submitUntilAccepted } from "./helpers/api-retry.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";

/**
 * Real-API proof for #77: a signed-out visitor of the desktop app's browser
 * question (`/api/desktop/sign-in?request=<id>`, a server page) presses Sign
 * in, completes the ordinary web sign-in, and lands back on the question for
 * that same request. Nothing is stubbed: the request is opened through
 * `POST /v1/desktop-sign-ins` and every page is served by the real API
 * behind the Vite proxy.
 *
 * Gated like the other shared-admin specs: `BAKERY_REAL_API=1`, the shared
 * bootstrap admin, `desktop-shared-admin` project only.
 * `BAKERY_EVIDENCE_DIR=<dir>` saves a 1440x900 still of the question reached
 * after sign-in.
 */
const enabled = process.env.BAKERY_REAL_API === "1";
const explicitEmail = process.env.BAKERY_REAL_EMAIL?.trim().toLowerCase();
const explicitPassword = process.env.BAKERY_REAL_PASSWORD;
const fixtureDefaultAllowed = process.env.BAKERY_ENV === "test";
const ADMIN_EMAIL = explicitEmail ||
  (fixtureDefaultAllowed ? "browser-admin@example.test" : "");
const ADMIN_PASSWORD = explicitPassword ||
  (fixtureDefaultAllowed ? "Browser-Admin-Passw0rd-1" : "");
const COMPUTER = "Return Test Studio";

const seedScriptPath = fileURLToPath(
  new URL("../../../tests/helpers/web-auth-seed.ts", import.meta.url),
);

const expect = baseExpect.configure({ timeout: 20_000 });

async function pkceChallenge(): Promise<string> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48)))
    .toString("base64url");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(new Uint8Array(digest)).toString("base64url");
}

test("signing in from the signed-out desktop question lands back on it", async ({ page }) => {
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 with the web server proxied to a running API",
  );
  test.skip(
    !(ADMIN_EMAIL && ADMIN_PASSWORD),
    "set BAKERY_REAL_EMAIL and BAKERY_REAL_PASSWORD, or BAKERY_ENV=test",
  );
  test.skip(
    test.info().project.name !== "desktop-shared-admin",
    "one shared admin and shared auth rate-limit buckets: `desktop-shared-admin` only",
  );
  test.setTimeout(laneBudgetMs(120_000));
  execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    seedScriptPath,
    ADMIN_EMAIL,
  ], {
    encoding: "utf8",
    env: { ...process.env, WEB_AUTH_SEED_PASSWORD: ADMIN_PASSWORD },
  });

  const started = await page.request.post("/v1/desktop-sign-ins", {
    data: {
      clientId: "bakery-desktop",
      codeChallenge: await pkceChallenge(),
      codeChallengeMethod: "S256",
      redirectUri: "http://127.0.0.1:53682/callback",
      computerName: COMPUTER,
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const { id } = await started.json() as { id: string };
  const question = `/api/desktop/sign-in?request=${id}`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(question);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sign in to continue",
  );
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    if (await page.getByTestId("sign-in-throttled").isVisible()) {
      await page.getByRole("button", { name: "Return to sign in", exact: true })
        .click();
    }
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });

  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/api/desktop/sign-in" &&
      url.searchParams.get("request") === id,
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sign in to the Bakery app?",
  );
  await expect(page.getByText(COMPUTER, { exact: true })).toBeVisible();
  await expect(page.getByText(ADMIN_EMAIL, { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to the app" }),
  ).toBeVisible();

  const evidence = process.env.BAKERY_EVIDENCE_DIR;
  if (evidence) {
    await page.screenshot({
      path: `${evidence}/confirm-after-sign-in--desktop.png`,
      fullPage: true,
    });
  }
});
