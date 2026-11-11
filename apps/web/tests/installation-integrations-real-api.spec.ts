import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { submitUntilAccepted } from "./helpers/api-retry.ts";

/**
 * Real-API browser proof of the installation Integrations page (#478, on the
 * server work of #477): no route mocks for Bakery's own API, a real server,
 * real sessions and a real database. Only the navigation to github.com is
 * intercepted, because the spec must not reach the internet.
 *
 * What a started server can show is the unregistered installation: it cannot
 * inject the fake GitHub client, so the registered view is proved by
 * `installation-integrations.spec.ts` and the stored result by the #477 Deno
 * integration test.
 *
 * `begin` needs a secrets key mounted in the API. The CI `ui_web` stack has
 * none, so a real `begin` answers a conflict there and the page shows the
 * recoverable setup-unavailable error. An operator whose stack mounts a key
 * sets `BAKERY_REAL_SECRETS_KEY=1` to run the hand-off case instead.
 *
 * The Object storage section (E05, #49) is proved on desktop and, through a
 * phone viewport, on mobile: the form saves account, bucket and credentials
 * (a conflict when no secrets key is mounted), the credentials never come
 * back in a response or the page, and a member is refused. Verify is not
 * clicked: it would probe the real R2 endpoint for the typed account, and the
 * spec must not reach the internet.
 *
 * The existing-App form (#480) is proved here only on paths the server
 * refuses before it would call GitHub `GET /app`: a malformed key, and a
 * well-formed key without a secrets key. A confirmed App needs the fake
 * GitHub client the Deno integration suite injects.
 */
const enabled = process.env.BAKERY_REAL_API === "1";
const explicitEmail = process.env.BAKERY_REAL_EMAIL?.trim().toLowerCase();
const explicitPassword = process.env.BAKERY_REAL_PASSWORD;
const fixtureDefaultAllowed = process.env.BAKERY_ENV === "test";
const ADMIN_EMAIL = explicitEmail ||
  (fixtureDefaultAllowed ? "browser-admin@example.test" : "");
const ADMIN_PASSWORD = explicitPassword ||
  (fixtureDefaultAllowed ? "Browser-Admin-Passw0rd-1" : "");
const credentialsAvailable = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);
const secretsKeyMounted = process.env.BAKERY_REAL_SECRETS_KEY === "1";

const PAGE_PATH = "/settings/installation/integrations";
const MANIFEST_CALLBACK_PATH = "/v1/integration-auth/github/manifest-callback";
const MEMBER_EMAIL = "integrations-member@example.test";

const helper = (name: string) =>
  fileURLToPath(new URL(`../../../tests/helpers/${name}.ts`, import.meta.url));

function deno(file: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    helper(file),
    ...args,
  ], { encoding: "utf8", env: { ...process.env, ...env } });
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    if (await page.getByTestId("sign-in-throttled").isVisible()) {
      await page.getByRole("button", { name: "Return to sign in", exact: true })
        .click();
    }
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page).toHaveURL("/");
}

const createButton = (page: Page) =>
  page.getByRole("button", { name: "Create GitHub App", exact: true });

const STORAGE_PATH = "/v1/installation/skill-storage";
const STORAGE_ACCOUNT_ID = "b".repeat(32);
const STORAGE_BUCKET = "bakery-real-api-spec";

type StoredStorage = {
  version: number;
  configured: boolean;
  credentialRevision: number | null;
};

const storageSection = (page: Page) => page.getByTestId("skill-storage");
const storageField = (page: Page, name: string) =>
  page.getByTestId("skill-storage-form").locator(`input[name="${name}"]`);

/**
 * Saves the object storage form through the real API, in whichever state the
 * installation row is in, and proves no credential comes back. A repeat run
 * against the same database rotates the credentials instead of creating them.
 */
async function exerciseStorageSection(page: Page): Promise<void> {
  const credentials = {
    accessKeyId: `AKIA-real-api-${crypto.randomUUID()}`,
    secretAccessKey: `secret-real-api-${crypto.randomUUID()}`,
  };
  await signIn(page);
  await page.goto(PAGE_PATH);
  await expect(
    storageSection(page).getByRole("heading", { name: "Object storage" }),
  ).toBeVisible();
  const before = await (await page.request.get(STORAGE_PATH))
    .json() as StoredStorage;
  if (before.version === 0) {
    await expect(storageSection(page).getByText("R2 is not configured"))
      .toBeVisible();
    await expect(storageField(page, "accessKeyId")).toHaveValue("");
    await expect(storageField(page, "secretAccessKey")).toHaveValue("");
    await expect(
      page.getByTestId("skill-storage-form").getByRole("button", {
        name: "Save settings",
      }),
    ).toBeDisabled();
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);

  await storageField(page, "accountId").fill(STORAGE_ACCOUNT_ID);
  await storageField(page, "bucket").fill(STORAGE_BUCKET);
  await storageField(page, "accessKeyId").fill(credentials.accessKeyId);
  await storageField(page, "secretAccessKey").fill(credentials.secretAccessKey);
  await page.getByTestId("skill-storage-form").getByRole("button", {
    name: "Save settings",
  }).click();
  if (secretsKeyMounted) {
    await expect(
      page.getByText(
        "Settings saved. The credentials are encrypted and cannot be shown again.",
      ),
    ).toBeVisible();
    await expect(storageSection(page).getByText(/Stored, revision \d+/))
      .toBeVisible();
    const after = await (await page.request.get(STORAGE_PATH)).json() as
      & StoredStorage
      & Record<string, unknown>;
    expect(after.configured).toBe(true);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.accountId).toBe(STORAGE_ACCOUNT_ID);
    expect(after.bucket).toBe(STORAGE_BUCKET);
    // The projection has no credential, id, key id or ciphertext field.
    expect(Object.keys(after).sort()).toEqual([
      "accountId",
      "backend",
      "bucket",
      "configured",
      "credentialRevision",
      "credentialUpdatedAt",
      "updatedAt",
      "version",
    ]);
    expect(after.backend).toBe("filesystem");
    expect(JSON.stringify(after)).not.toContain(credentials.accessKeyId);
    expect(JSON.stringify(after)).not.toContain(credentials.secretAccessKey);
    // A stale version is refused and changes nothing.
    const stale = await page.request.put(STORAGE_PATH, {
      data: { accountId: STORAGE_ACCOUNT_ID, bucket: STORAGE_BUCKET },
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        "If-Match": `"v${after.version + 7}"`,
        // A browser session write must be same-origin, or it is refused 403.
        origin: new URL(page.url()).origin,
      },
    });
    expect(stale.status()).toBe(412);
    await expect(storageField(page, "accountId")).toHaveValue(
      STORAGE_ACCOUNT_ID,
    );
  } else {
    await expect(
      page.getByText("Credentials cannot be stored until", { exact: false }),
    ).toBeVisible();
    const after = await (await page.request.get(STORAGE_PATH))
      .json() as StoredStorage;
    expect(after.version).toBe(before.version);
  }
  // Write-only: the fields are empty and nothing typed remains anywhere.
  await expect(storageField(page, "accessKeyId")).toHaveValue("");
  await expect(storageField(page, "secretAccessKey")).toHaveValue("");
  const page_ = await page.content();
  expect(page_).not.toContain(credentials.accessKeyId);
  expect(page_).not.toContain(credentials.secretAccessKey);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage }) +
      JSON.stringify({ ...sessionStorage })
    ),
  ).not.toContain(credentials.secretAccessKey);
}

test.describe("installation integrations against the real API", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 with the web server proxied to a running API",
  );
  test.skip(
    !credentialsAvailable,
    "set BAKERY_REAL_EMAIL and BAKERY_REAL_PASSWORD to an existing admin; " +
      "the fixture default only applies when BAKERY_ENV=test",
  );

  // deno-lint-ignore no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-shared-admin",
      "one shared admin and shared auth rate-limit buckets: `desktop-shared-admin` only",
    );
  });

  // deno-lint-ignore no-empty-pattern
  test.beforeAll(({}, workerInfo) => {
    if (workerInfo.project.name !== "desktop-shared-admin") return;
    deno("web-auth-seed", [ADMIN_EMAIL], {
      WEB_AUTH_SEED_PASSWORD: ADMIN_PASSWORD,
    });
  });

  test("an administrator sees Create and no credentials; the callback with an unknown state is a recoverable error", async ({ page }) => {
    await signIn(page);
    await page.goto(PAGE_PATH);
    await expect(page.getByRole("heading", { level: 1, name: "Integrations" }))
      .toBeVisible();
    await expect(page.getByText("No GitHub App registered")).toBeVisible();
    await expect(createButton(page)).toBeEnabled();
    // The existing-App form shows empty write-only fields, never a value.
    const form = page.getByTestId("github-existing-app-register");
    for (const name of ["clientSecret", "webhookSecret"]) {
      await expect(form.locator(`input[name="${name}"]`)).toHaveValue("");
    }
    await expect(form.locator('textarea[name="privateKey"]')).toHaveValue("");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // GitHub redirects here with a state Bakery never issued.
    await page.goto(
      `${MANIFEST_CALLBACK_PATH}?code=unknown-code&state=unknown-state`,
    );
    await expect(page).toHaveURL(
      `${PAGE_PATH}?githubAppRegistration=state_rejected`,
    );
    await expect(
      page.getByText("The registration link expired or was not recognised"),
    ).toBeVisible();
    await expect(createButton(page)).toBeEnabled();
    const registration = await page.request.get(
      "/v1/integration-app-registrations/github",
    );
    expect(registration.status()).toBe(200);
    expect((await registration.json() as { status: string }).status).toBe(
      "unregistered",
    );
  });

  test(
    secretsKeyMounted
      ? "Create submits the manifest and state to GitHub"
      : "Create without a secrets key shows a recoverable setup error and registers nothing",
    async ({ page }) => {
      const posts: { method: string; body: URLSearchParams }[] = [];
      await page.route("https://github.com/**", (route) => {
        const request = route.request();
        posts.push({
          method: request.method(),
          body: new URLSearchParams(request.postData() ?? ""),
        });
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>GitHub</title><p>Create GitHub App</p>",
        });
      });
      await signIn(page);
      await page.goto(PAGE_PATH);
      await createButton(page).click();
      if (secretsKeyMounted) {
        await expect.poll(() => posts.length).toBe(1);
        expect(posts[0].method).toBe("POST");
        expect(posts[0].body.get("manifest")).toContain("redirect_url");
        expect(posts[0].body.get("state")).toBeTruthy();
      } else {
        await expect(page.getByText(/GitHub App setup is not available/))
          .toBeVisible();
        expect(posts).toHaveLength(0);
        await expect(page.getByText("No GitHub App registered")).toBeVisible();
      }
    },
  );

  test("pasted credentials the server refuses before GitHub store nothing and leave no secret in the page", async ({ page }) => {
    const githubCalls: string[] = [];
    await page.route("https://*.github.com/**", (route) => {
      githubCalls.push(route.request().url());
      return route.abort();
    });
    await signIn(page);
    await page.goto(PAGE_PATH);
    const form = page.getByTestId("github-existing-app-register");
    const clientSecret = `client-secret-${crypto.randomUUID()}`;
    const fill = async (privateKey: string) => {
      await form.locator('input[name="appId"]').fill("912345");
      await form.locator('input[name="clientId"]').fill("Iv23liRealApiSpec");
      await form.locator('input[name="clientSecret"]').fill(clientSecret);
      await form.locator('textarea[name="privateKey"]').fill(privateKey);
      await form.getByRole("button", { name: "Verify and save" }).click();
    };
    await fill("not a private key");
    await expect(
      page.getByText(
        "The private key is not an RSA private key in PEM format.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(form.locator('input[name="clientSecret"]')).toHaveValue("");
    await expect(form.locator('textarea[name="privateKey"]')).toHaveValue("");
    if (!secretsKeyMounted) {
      const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs1", format: "pem" }).toString();
      await fill(pem);
      await expect(
        page.getByText("Credentials cannot be stored until", {
          exact: false,
        }),
      ).toBeVisible();
      const body = pem.split("\n")[1];
      expect(await page.content()).not.toContain(body);
    }
    expect(await page.content()).not.toContain(clientSecret);
    expect(githubCalls).toHaveLength(0);
    const registration = await page.request.get(
      "/v1/integration-app-registrations/github",
    );
    expect((await registration.json() as { status: string }).status).toBe(
      "unregistered",
    );
  });

  test("Object storage saves through the real API and never returns the credentials", async ({ page }) => {
    await exerciseStorageSection(page);
  });

  test.describe("on a phone viewport", () => {
    test.use({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    test("Object storage saves through the real API and never returns the credentials", async ({ page }) => {
      await exerciseStorageSection(page);
    });
  });

  test("a member who is not an installation administrator sees forbidden and no action", async ({ browser, page }) => {
    await signIn(page);
    const member = JSON.parse(
      deno("web-member-seed", [
        ADMIN_EMAIL,
        MEMBER_EMAIL,
        "Integrations Member",
      ])
        .trim().split("\n").at(-1) ?? "null",
    ) as { cookieName: string; cookieValue: string };
    const context = await browser.newContext();
    try {
      await context.addCookies([{
        name: member.cookieName,
        value: member.cookieValue,
        url: new URL(page.url()).origin,
      }]);
      const memberPage = await context.newPage();
      await memberPage.goto(PAGE_PATH);
      await expect(
        memberPage.getByText(
          "Only installation administrators can view or change integrations.",
        ),
      ).toBeVisible();
      await expect(createButton(memberPage)).toHaveCount(0);
      const read = await memberPage.request.get(
        "/v1/integration-app-registrations/github",
      );
      expect(read.status()).toBe(403);
      // The Object storage section refuses the member the same way.
      await expect(
        memberPage.getByText(
          "Only an installation administrator can change object storage.",
        ),
      ).toBeVisible();
      await expect(memberPage.getByTestId("skill-storage-form")).toHaveCount(0);
      expect((await memberPage.request.get("/v1/installation/skill-storage"))
        .status()).toBe(403);
      const write = await memberPage.request.put(
        "/v1/installation/skill-storage",
        {
          data: { accountId: STORAGE_ACCOUNT_ID, bucket: STORAGE_BUCKET },
          headers: {
            "Idempotency-Key": crypto.randomUUID(),
            origin: new URL(memberPage.url()).origin,
          },
        },
      );
      expect(write.status()).toBe(403);
    } finally {
      await context.close();
    }
  });
});
