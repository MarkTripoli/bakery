import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  requestUntilAccepted,
  submitUntilAccepted,
} from "./helpers/api-retry.ts";

/**
 * Live, real-API proof of the settings acceptance criteria (#151 AC1, AC3):
 * preferences saved on the server survive a reload and show up in a second
 * browser context, the organization default language is the fallback for
 * people without a language of their own, an Admin edits it through the
 * organization settings page while a Developer is refused, and feature
 * availability reaches the pages that depend on it.
 *
 * Gated on `BAKERY_REAL_API === "1"` like `auth-journey.spec.ts`, whose
 * shared bootstrap admin it signs in as (seeded the same way). The file is
 * serial and `desktop-shared-admin`-only: it mutates one admin's preferences and one
 * organization's default language, and shares Better Auth's real
 * `/api/auth/**` rate-limit buckets.
 *
 * Optional environment:
 * - `BAKERY_REAL_SIGNUPS=1` asserts the API accepts invited registrations and
 *   enables the Developer part (the Developer is invited and registers through
 *   the real UI, as in auth-journey assertion 5b).
 * The feature-availability test updates installation settings through the
 * authenticated API and verifies the public capability projection.
 */
const enabled = process.env.BAKERY_REAL_API === "1";
const realSignupsEnabled = process.env.BAKERY_REAL_SIGNUPS === "1";
const explicitEmail = process.env.BAKERY_REAL_EMAIL?.trim().toLowerCase();
const explicitPassword = process.env.BAKERY_REAL_PASSWORD;
const fixtureDefaultAllowed = process.env.BAKERY_ENV === "test";
const ADMIN_EMAIL = explicitEmail ||
  (fixtureDefaultAllowed ? "browser-admin@example.test" : "");
const ADMIN_PASSWORD = explicitPassword ||
  (fixtureDefaultAllowed ? "Browser-Admin-Passw0rd-1" : "");
const credentialsAvailable = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);

const seedScriptPath = fileURLToPath(
  new URL("../../../tests/helpers/web-auth-seed.ts", import.meta.url),
);

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

async function returnToSignInFormIfThrottled(page: Page): Promise<void> {
  if (await page.getByTestId("sign-in-throttled").isVisible()) {
    await page.getByRole("button", { name: "Return to sign in", exact: true })
      .click();
  }
}

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/sign-in");
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    await returnToSignInFormIfThrottled(page);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page).toHaveURL("/");
}

type Preferences = {
  theme: string;
  locale: string | null;
  timeZone: string | null;
  effectiveLocale: string;
  direction: string;
  availableLocales: string[];
  casVersion: number;
};

function scoped(organizationId: string) {
  return { "Bakery-Organization-Id": organizationId };
}

async function readPreferences(
  page: Page,
  organizationId: string,
): Promise<Preferences> {
  const response = await requestUntilAccepted(() =>
    page.request.get("/v1/user-preferences", {
      headers: scoped(organizationId),
    })
  );
  expect(response.ok()).toBe(true);
  return await response.json() as Preferences;
}

async function patchPreferences(
  page: Page,
  organizationId: string,
  baseURL: string,
  change: Record<string, unknown>,
): Promise<Preferences> {
  const current = await readPreferences(page, organizationId);
  const response = await requestUntilAccepted(() =>
    page.request.patch("/v1/user-preferences", {
      data: { ...change, expectedCasVersion: current.casVersion },
      headers: {
        ...scoped(organizationId),
        origin: baseURL,
        "Idempotency-Key": crypto.randomUUID(),
      },
    })
  );
  expect(response.ok()).toBe(true);
  return await response.json() as Preferences;
}

/** Puts the organization back on the Bakery default, whatever an earlier run left. */
async function resetOrganizationDefault(
  page: Page,
  organizationId: string,
  baseURL: string,
): Promise<void> {
  const current = await requestUntilAccepted(() =>
    page.request.get(`/v1/organizations/${organizationId}`, {
      headers: scoped(organizationId),
    })
  );
  const organization = await current.json() as {
    defaultLocale: string | null;
    version: number;
  };
  if (organization.defaultLocale === null) return;
  const reset = await requestUntilAccepted(() =>
    page.request.patch(`/v1/organizations/${organizationId}`, {
      data: { defaultLocale: null },
      headers: {
        ...scoped(organizationId),
        origin: baseURL,
        "If-Match": `"v${organization.version}"`,
        "Idempotency-Key": crypto.randomUUID(),
      },
    })
  );
  expect(reset.ok()).toBe(true);
}

async function htmlState(page: Page) {
  return await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
  }));
}

/** Reloads with the app's entry module aborted, so only the pre-paint script ran. */
async function prePaintState(page: Page) {
  await page.route(/\/src\/main\.tsx/, (route) => route.abort());
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    return await htmlState(page);
  } finally {
    await page.unroute(/\/src\/main\.tsx/);
  }
}

type InstallationSettings = {
  registrationMode: "invitation" | "closed";
  organizationCreationPolicy: "any_user" | "installation_admins";
  version: number;
};

async function updateInstallationSettings(
  page: Page,
  baseURL: string,
  change: Partial<Omit<InstallationSettings, "version">>,
): Promise<void> {
  const currentResponse = await requestUntilAccepted(() =>
    page.request.get("/v1/installation/settings")
  );
  expect(currentResponse.ok()).toBe(true);
  const current = await currentResponse.json() as InstallationSettings;
  const updated = await requestUntilAccepted(() =>
    page.request.patch("/v1/installation/settings", {
      data: {
        registrationMode: change.registrationMode ?? current.registrationMode,
        organizationCreationPolicy: change.organizationCreationPolicy ??
          current.organizationCreationPolicy,
      },
      headers: {
        origin: baseURL,
        "If-Match": `"v${current.version}"`,
        "Idempotency-Key": crypto.randomUUID(),
      },
    })
  );
  expect(updated.ok()).toBe(true);
}

async function readAvailability(page: Page) {
  const response = await requestUntilAccepted(() =>
    page.request.get("/v1/installation/capabilities")
  );
  expect(response.ok()).toBe(true);
  const body = await response.json() as {
    registration: "invitation" | "closed";
    organizationCreation: "any_user" | "installation_admins";
  };
  return {
    signups: body.registration === "invitation",
    organizationCreation: body.organizationCreation === "any_user",
  };
}

test.describe("settings journey", () => {
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

  let organizationId: string;

  // deno-lint-ignore no-empty-pattern
  test.beforeAll(({}, workerInfo) => {
    if (workerInfo.project.name !== "desktop-shared-admin") return;
    const output = execFileSync("deno", [
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
    const lastLine = output.trim().split("\n").filter(Boolean).pop();
    const seeded = JSON.parse(lastLine ?? "{}") as { organizationId?: string };
    if (!seeded.organizationId) {
      throw new Error("seed returned no organization");
    }
    organizationId = seeded.organizationId;
  });

  test("1. a saved theme survives a reload and follows the person to a second browser context", async ({ page, browser, baseURL }) => {
    test.setTimeout(90_000);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    // Start from a known server state.
    await patchPreferences(page, organizationId, baseURL!, {
      theme: "system",
      locale: null,
      timeZone: null,
    });
    await page.goto("/settings/appearance");
    await expect(page.locator("main h1")).toHaveText("Appearance");

    const saved = page.waitForResponse((response) =>
      response.url().includes("/v1/user-preferences") &&
      response.request().method() === "PATCH"
    );
    await page.getByRole("radiogroup", { name: "Color theme" }).getByText(
      "Dark",
      { exact: true },
    ).click();
    expect((await saved).status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect((await readPreferences(page, organizationId)).theme).toBe("dark");

    // Reload: the cached choice is applied before the app mounts.
    expect((await prePaintState(page)).theme).toBe("dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // A second context has no cache at all; the server's answer wins.
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await signIn(secondPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    await secondPage.goto("/settings/appearance");
    await expect(secondPage.locator("html")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await expect(secondPage.getByRole("radio", { name: "Dark" })).toBeChecked();
    await second.close();

    // Put it back.
    await page.getByRole("radiogroup", { name: "Color theme" }).getByText(
      "System",
      { exact: true },
    ).click();
    await expect.poll(async () =>
      (await readPreferences(page, organizationId)).theme
    ).toBe("system");
  });

  test("2. the time zone preference formats dates and falls back to the browser", async ({ page, browser, baseURL }) => {
    test.setTimeout(90_000);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    // A second signed-in session gives the sessions page a row with a date.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, ADMIN_EMAIL, ADMIN_PASSWORD);

    const sessionsResponse = await requestUntilAccepted(() =>
      page.request.get("/v1/me/sessions")
    );
    const sessions = await sessionsResponse.json() as {
      items: { current: boolean; updatedAt: string }[];
    };
    const otherSession = sessions.items.find((item) => !item.current);
    expect(otherSession).toBeDefined();
    const format = (timeZone: string) =>
      new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(new Date(otherSession!.updatedAt));

    const preferences = await patchPreferences(page, organizationId, baseURL!, {
      timeZone: "Pacific/Auckland",
    });
    expect(preferences.timeZone).toBe("Pacific/Auckland");
    await page.goto("/settings/sessions");
    await expect(page.getByTestId("sessions-other").first()).toContainText(
      format("Pacific/Auckland"),
    );

    await patchPreferences(page, organizationId, baseURL!, { timeZone: null });
    await page.goto("/settings/sessions");
    const browserZone = await page.evaluate(() =>
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
    await expect(page.getByTestId("sessions-other").first()).toContainText(
      format(browserZone),
    );
    await other.close();
  });

  test("3. an Admin sets the organization default language; people without their own language fall back to it", async ({ page, browser, baseURL }) => {
    test.setTimeout(120_000);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await resetOrganizationDefault(page, organizationId, baseURL!);
    await patchPreferences(page, organizationId, baseURL!, { locale: null });

    await page.goto("/organization/settings");
    await expect(page.locator("main h1")).toHaveText("Organization settings");
    const language = page.getByLabel("Default language");
    await expect(language).toBeVisible();
    await expect(language.locator("option")).toHaveText([
      "Bakery default",
      "English",
      "English (accented pseudo-locale)",
      "Arabic (right-to-left pseudo-locale)",
    ]);
    // Any earlier run's default is cleared first, so the save below changes it.
    await language.selectOption("");
    const save = page.getByRole("button", { name: "Save default language" });
    if (await save.isEnabled()) {
      await save.click();
      await expect(
        page.getByRole("status").filter({ hasText: "Default language saved." }),
      ).toBeVisible();
    }

    const patched = page.waitForResponse((response) =>
      response.url().includes(`/v1/organizations/${organizationId}`) &&
      response.request().method() === "PATCH"
    );
    await language.selectOption("ar-XB");
    await save.click();
    const patchResponse = await patched;
    expect(patchResponse.status()).toBe(200);
    expect(patchResponse.request().headers()["if-match"]).toMatch(/^"v\d+"$/);
    await expect(
      page.getByRole("status").filter({ hasText: "Default language saved." }),
    ).toBeVisible();

    // No language of their own: the organization default is the fallback.
    const fallback = await readPreferences(page, organizationId);
    expect(fallback.locale).toBeNull();
    expect(fallback.effectiveLocale).toBe("ar-XB");
    expect(fallback.direction).toBe("rtl");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "ar-XB");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    expect(await prePaintState(page)).toMatchObject({
      lang: "ar-XB",
      dir: "rtl",
    });

    // A second context sees the same (no cache; the server answers).
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await signIn(secondPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(secondPage.locator("html")).toHaveAttribute("lang", "ar-XB");
    await expect(secondPage.locator("html")).toHaveAttribute("dir", "rtl");
    await second.close();

    // A language of their own beats the organization default...
    const personal = await patchPreferences(page, organizationId, baseURL!, {
      locale: "en-XA",
    });
    expect(personal.effectiveLocale).toBe("en-XA");
    expect(personal.direction).toBe("ltr");
    // ...and clearing it falls back again.
    const cleared = await patchPreferences(page, organizationId, baseURL!, {
      locale: null,
    });
    expect(cleared.effectiveLocale).toBe("ar-XB");

    // "Bakery default" clears the organization default.
    await page.goto("/organization/settings");
    await page.getByLabel("Default language").selectOption("");
    await page.getByRole("button", { name: "Save default language" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Default language saved." }),
    ).toBeVisible();
    await expect.poll(async () =>
      (await readPreferences(page, organizationId)).effectiveLocale
    ).toBe("en");
  });

  test("4. a stale save surfaces the conflict state and keeps the draft", async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await resetOrganizationDefault(page, organizationId, baseURL!);
    await patchPreferences(page, organizationId, baseURL!, { locale: null });
    await page.goto("/organization/settings");
    const language = page.getByLabel("Default language");
    await expect(language).toBeVisible();

    // Someone else edits the organization between load and save.
    const current = await requestUntilAccepted(() =>
      page.request.get(`/v1/organizations/${organizationId}`, {
        headers: scoped(organizationId),
      })
    );
    const organization = await current.json() as { version: number };
    const concurrent = await requestUntilAccepted(() =>
      page.request.patch(`/v1/organizations/${organizationId}`, {
        data: { defaultLocale: "en" },
        headers: {
          ...scoped(organizationId),
          origin: baseURL!,
          "If-Match": `"v${organization.version}"`,
          "Idempotency-Key": crypto.randomUUID(),
        },
      })
    );
    expect(concurrent.ok()).toBe(true);

    await language.selectOption("ar-XB");
    await page.getByRole("button", { name: "Save default language" }).click();
    await expect(page.getByTestId("security-conflict")).toBeVisible();
    await expect(language).toHaveValue("ar-XB");
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId("security-conflict")).toHaveCount(0);
    await expect(language).toHaveValue("en");

    // Leave the organization on the Bakery default.
    await language.selectOption("");
    await page.getByRole("button", { name: "Save default language" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Default language saved." }),
    ).toBeVisible();
  });

  test(
    "5. a Developer sees the default language read-only and the server refuses their edit",
    async ({ page, browser, baseURL }, testInfo) => {
      test.skip(
        !realSignupsEnabled,
        "set BAKERY_REAL_SIGNUPS=1 once signups.enabled is on: the Developer " +
          "registers through an invitation",
      );
      test.setTimeout(150_000);
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      const developer = await inviteAndRegisterDeveloper(
        page,
        browser,
        organizationId,
        baseURL!,
        `${testInfo.project.name}-${randomToken()}`,
      );
      try {
        const devPage = developer.page;
        await devPage.goto("/organization/settings");
        await expect(devPage.locator("main h1")).toHaveText(
          "Organization settings",
        );
        await expect(devPage.getByTestId("organization-locale-readonly"))
          .toBeVisible();
        await expect(devPage.getByLabel("Default language")).toHaveCount(0);
        await expect(
          devPage.getByRole("button", { name: "Save default language" }),
        ).toHaveCount(0);
        // Feature availability is visible to everyone.
        await expect(devPage.getByTestId("feature-availability")).toBeVisible();

        const current = await requestUntilAccepted(() =>
          devPage.request.get(`/v1/organizations/${organizationId}`, {
            headers: scoped(organizationId),
          })
        );
        const organization = await current.json() as { version: number };
        const refused = await requestUntilAccepted(() =>
          devPage.request.patch(`/v1/organizations/${organizationId}`, {
            data: { defaultLocale: "ar-XB" },
            headers: {
              ...scoped(organizationId),
              origin: baseURL!,
              "If-Match": `"v${organization.version}"`,
              "Idempotency-Key": crypto.randomUUID(),
            },
          })
        );
        expect(refused.status()).toBe(403);
      } finally {
        await developer.context.close();
      }
    },
  );

  test(
    "6. installation capabilities reach /register and /organizations",
    async ({ page, browser, baseURL }, testInfo) => {
      test.setTimeout(150_000);
      const reported = async () => {
        return await readAvailability(page);
      };
      const anonymous = await browser.newContext();
      const anonymousPage = await anonymous.newPage();
      // Capture any JS errors on the anonymous page to aid diagnosis.
      const anonymousErrors: string[] = [];
      anonymousPage.on(
        "pageerror",
        (error) => anonymousErrors.push(error.message),
      );
      const expectRegister = async (signups: boolean) => {
        await anonymousPage.goto("/register");
        // Surface any JS errors that would prevent the join form from rendering.
        expect(anonymousErrors, "anonymous page JS errors").toEqual([]);
        await expect(anonymousPage).not.toHaveURL(/\/sign-in/);
        await expect(anonymousPage.getByTestId("join")).toBeVisible();
        await expect(anonymousPage.getByTestId("registration-paused"))
          .toHaveCount(signups ? 0 : 1);
        if (!signups) {
          await expect(anonymousPage.getByTestId("registration-paused"))
            .toContainText("Registration paused");
        }
      };
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      const developer = await inviteAndRegisterDeveloper(
        page,
        browser,
        organizationId,
        baseURL!,
        `${testInfo.project.name}-capabilities-${randomToken()}`,
      );
      const expectAdminExemption = async () => {
        await page.goto("/organizations");
        await expect(page.getByTestId("organizations-page")).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Create organization" }),
        ).toHaveCount(0);
      };
      const expectDeveloperOrganizations = async (
        organizationCreation: boolean,
      ) => {
        await developer.page.goto("/organizations");
        await expect(developer.page.getByTestId("organizations-page"))
          .toBeVisible();
        const create = developer.page.getByRole("button", {
          name: "Create organization",
        });
        if (organizationCreation) {
          await expect(create).toHaveCount(0);
        } else {
          await expect(create).toBeDisabled();
          await expect(create).toHaveAccessibleDescription(
            /Creating organizations is paused/,
          );
        }
      };

      try {
        await updateInstallationSettings(page, baseURL!, {
          organizationCreationPolicy: "installation_admins",
        });
        await expectAdminExemption();
        await expectDeveloperOrganizations(false);
        await updateInstallationSettings(page, baseURL!, {
          organizationCreationPolicy: "any_user",
        });
        await expectDeveloperOrganizations(true);
        await updateInstallationSettings(page, baseURL!, {
          registrationMode: "closed",
        });
        await expectRegister(false);
        await updateInstallationSettings(page, baseURL!, {
          registrationMode: "invitation",
        });
        // Confirm the server sees the updated capabilities before
        // the anonymous page hits its own fetch — a cached HTTP response
        // or a React Query stale read in the anonymous context can
        // otherwise keep showing the old "closed" value.
        const verify = await requestUntilAccepted(() =>
          page.request.get("/v1/installation/capabilities")
        );
        expect(verify.ok()).toBe(true);
        const verifyBody = await verify.json() as {
          registration: string;
        };
        expect(verifyBody.registration).toBe("invitation");
        // Clear the anonymous page's route cache by navigating away
        // first, so the next /register load issues a fresh capabilities
        // fetch rather than serving a disk-cached response.
        await anonymousPage.goto("/sign-in");
        await expectRegister(true);

        // The organization settings page shows the same answers read-only.
        const state = await reported();
        await page.goto("/organization/settings");
        const features = page.getByTestId("feature-availability");
        await expect(features).toContainText(
          state.signups
            ? "Invited people can create accounts."
            : "New accounts can’t be created right now.",
        );
        await expect(features).toContainText(
          state.organizationCreation
            ? "Signed-in people can create organizations."
            : "New organizations can’t be created right now.",
        );
      } finally {
        await Promise.all([anonymous.close(), developer.context.close()]);
      }
    },
  );

  test("7. a profile edit saves with its version, and a stale save surfaces the conflict and keeps the draft", async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const read = async () => {
      const response = await requestUntilAccepted(() =>
        page.request.get("/v1/me/profile")
      );
      expect(response.ok()).toBe(true);
      return await response.json() as { version: number; title: string | null };
    };
    const patch = (version: number, data: Record<string, unknown>) =>
      requestUntilAccepted(() =>
        page.request.patch("/v1/me/profile", {
          data,
          headers: {
            origin: baseURL!,
            "If-Match": `"v${version}"`,
            "Idempotency-Key": crypto.randomUUID(),
          },
        })
      );
    const before = await read();
    await page.goto("/settings/profile");
    const title = page.getByLabel("Job title");
    await expect(title).toBeVisible();
    await title.fill(`Journey ${randomToken()}`);
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Profile saved." }),
    ).toBeVisible();
    const saved = await read();
    expect(saved.version).toBeGreaterThan(before.version);
    expect(saved.title).toMatch(/^Journey /);
    await page.reload();
    await expect(page.getByLabel("Job title")).toHaveValue(saved.title!);

    // Someone else edits the profile between load and save.
    const concurrent = await patch(saved.version, {
      title: "Edited elsewhere",
    });
    expect(concurrent.ok()).toBe(true);
    await page.getByLabel("Job title").fill("My stale edit");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByTestId("security-conflict")).toBeVisible();
    await expect(page.getByLabel("Job title")).toHaveValue("My stale edit");
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId("security-conflict")).toHaveCount(0);
    await expect(page.getByLabel("Job title")).toHaveValue("Edited elsewhere");

    // Leave the profile as it was.
    const latest = await read();
    const restore = await patch(latest.version, { title: before.title });
    expect(restore.ok()).toBe(true);
  });

  test("8. Save preferences stores language and time zone, which survive a reload", async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await patchPreferences(page, organizationId, baseURL!, {
      locale: null,
      timeZone: null,
    });
    await page.goto("/settings/appearance");
    await expect(page.locator("#appearance-time-zone")).toBeVisible();
    await page.locator("#appearance-language").selectOption("en-XA");
    await page.locator("#appearance-time-zone").selectOption(
      "Pacific/Auckland",
    );
    await page.locator("main button[type=submit]").click();
    // The page switches to the chosen language, so wait on the stored record
    // rather than on translated copy.
    await expect.poll(async () =>
      (await readPreferences(page, organizationId)).timeZone
    ).toBe("Pacific/Auckland");
    const stored = await readPreferences(page, organizationId);
    expect(stored.locale).toBe("en-XA");
    await page.reload();
    await expect(page.locator("#appearance-time-zone")).toHaveValue(
      "Pacific/Auckland",
    );
    await expect(page.locator("#appearance-language")).toHaveValue("en-XA");

    // Back to the system defaults.
    await patchPreferences(page, organizationId, baseURL!, {
      locale: null,
      timeZone: null,
    });
  });

  test("9. Your access shows the live role and refreshes on request", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const response = await requestUntilAccepted(() =>
      page.request.get(`/v1/organizations/${organizationId}/effective-access`, {
        headers: scoped(organizationId),
      })
    );
    expect(response.ok()).toBe(true);
    const access = await response.json() as { role: string | null };
    await page.goto("/settings/access");
    await expect(page.locator("main h1")).toHaveText("Your access");
    const label = access.role === "admin" ? "Admin" : "Developer";
    await expect(page.getByTestId("access-settings")).toContainText(label);
    await expect(
      page.getByRole("list", { name: "What your role allows" }),
    ).toBeVisible();
    // A reload re-reads the live answer; the role does not change underneath.
    await page.reload();
    await expect(page.getByTestId("access-settings")).toContainText(label);
  });
});

/** Invites a Developer, registers them through the real UI and accepts. */
async function inviteAndRegisterDeveloper(
  adminPage: Page,
  browser: Browser,
  organizationId: string,
  baseURL: string,
  tag: string,
) {
  const email = `settings-dev-${tag}@example.test`.toLowerCase();
  const password = `Settings-Dev-${tag}-1`;
  const invite = await requestUntilAccepted(() =>
    adminPage.request.post(`/v1/organizations/${organizationId}/invitations`, {
      data: { email, role: "developer" },
      headers: {
        origin: baseURL,
        "Bakery-Organization-Id": organizationId,
        "Idempotency-Key": crypto.randomUUID(),
      },
    })
  );
  expect(invite.ok()).toBe(true);
  const invitation = await invite.json() as { id: string };

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/invitations/${invitation.id}`);
  await page.getByTestId("invitation-create-account").click();
  await expect(page).toHaveURL(`/register?invitation=${invitation.id}`);
  await submitUntilAccepted(page, "/api/auth/sign-up/email", async () => {
    await page.getByLabel("Full name").fill("Settings Developer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create account", exact: true })
      .click();
  });
  await expect(page.getByTestId("register-submitted")).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", {
      name: "Sign in and continue",
      exact: true,
    })
      .click();
  });
  await expect(page.getByTestId("invitation-authenticated")).toBeVisible();
  await page.getByTestId("invitation-accept").click();
  await expect(page.getByTestId("invitation-accepted")).toBeVisible();
  await page.getByTestId("invitation-open-organization").click();
  await expect(page).toHaveURL("/");
  return { context, page };
}
