import { expect, test } from "@playwright/test";
import { openAccountMenu } from "./helpers/shell-navigation.ts";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
  mockBootstrappedInstallation,
  mockUserPreferences,
} from "./helpers/mock-session.ts";

test.describe("theme bootstrap and preference", () => {
  test("uses the OS preference before the app mounts", async ({ page }) => {
    // No session mock here: `main.tsx` (React's entry, including the
    // router) is aborted below before it can ever run, so a fresh-database
    // `/setup` bounce — which only the mounted router's `beforeLoad`
    // produces — cannot happen on this first load; the mock would be inert.
    await page.addInitScript(() => localStorage.clear());
    await page.emulateMedia({ colorScheme: "dark" });
    await page.route(/\/src\/main\.tsx/, (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const beforeMount = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      colorScheme: document.documentElement.style.colorScheme,
    }));
    expect(beforeMount).toEqual({ theme: "dark", colorScheme: "dark" });
    await page.unroute(/\/src\/main\.tsx/);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  });

  test("follows OS changes while the preference is System", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("bakery.theme.v1", "system");
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("persists an explicit selection and restores it on reload", async ({ page }) => {
    // Unlike the OS-preference tests above (which only assert the
    // pre-React bootstrap attribute, set before any route ever resolves),
    // this test uses the real theme control in the shell's account menu, inside the
    // authenticated shell — `/` is a protected route, so it needs a mocked
    // session to render past `/sign-in` (see mock-session.ts's doc comment).
    await mockAuthenticatedSession(page);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("theme-test-initialized")) {
        localStorage.clear();
        sessionStorage.setItem("theme-test-initialized", "true");
      }
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await (await openAccountMenu(page, "Fixture Admin"))
      .getByRole("button", { name: "Use light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(() =>
      page.evaluate(() => localStorage.getItem("bakery.theme.v1"))
    ).toBe("light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("falls back to light when matchMedia is unavailable", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.addInitScript(() => localStorage.clear());
    await page.addInitScript(() => {
      Object.defineProperty(window, "matchMedia", { value: undefined });
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("rejects an invalid stored preference", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.addInitScript(() => {
      localStorage.setItem("bakery.theme.v1", "violet");
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test.describe("locale and motion preferences", () => {
  test("applies development pseudo-locales to the document", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.goto("/__fixtures__/shell/long-copy?locale=en-XA");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-XA");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.goto("/__fixtures__/shell/long-copy?locale=ar-XB");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar-XB");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("removes loading animation when reduced motion is requested", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/__fixtures__/shell/loading");
    const animated = page.locator('[data-state="loading"]').last();
    await expect(animated).toBeVisible();
    await expect.poll(() =>
      animated.evaluate((element) => getComputedStyle(element).animationName)
    ).toBe("none");
  });
});

const ROOT_BEFORE_MOUNT = () => ({
  theme: document.documentElement.dataset.theme,
  lang: document.documentElement.lang,
  dir: document.documentElement.dir,
});

test.describe("server-driven theme, language and time zone", () => {
  test("sets lang and dir from the locale cache before the app mounts", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem(
        "bakery.locale.v1",
        JSON.stringify({ locale: "ar-XB", dir: "rtl" }),
      );
      localStorage.setItem("bakery.theme.v1", "dark");
    });
    await page.route(/\/src\/main\.tsx/, (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(await page.evaluate(ROOT_BEFORE_MOUNT)).toEqual({
      theme: "dark",
      lang: "ar-XB",
      dir: "rtl",
    });
  });

  test("ignores a corrupted locale cache", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem(
        "bakery.locale.v1",
        JSON.stringify({ locale: "<script>", dir: "rtl" }),
      );
    });
    await page.route(/\/src\/main\.tsx/, (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const root = await page.evaluate(ROOT_BEFORE_MOUNT);
    expect(root.lang).toBe("en");
    expect(root.dir).not.toBe("rtl");
  });

  test("the server preference wins over the browser cache and is cached for the next first paint", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await mockUserPreferences(page, {
      theme: "dark",
      effectiveLocale: "ar-XB",
      direction: "rtl",
    });
    await page.addInitScript((organizationId) => {
      if (!sessionStorage.getItem("server-wins-initialized")) {
        localStorage.clear();
        localStorage.setItem("bakery.theme.v1", "light");
        localStorage.setItem(
          "bakery.organization.lastSelected.v1",
          organizationId,
        );
        sessionStorage.setItem("server-wins-initialized", "true");
      }
    }, MOCK_ORGANIZATION_ID);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar-XB");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect.poll(() =>
      page.evaluate(() => ({
        theme: localStorage.getItem("bakery.theme.v1"),
        locale: localStorage.getItem("bakery.locale.v1"),
      }))
    ).toEqual({
      theme: "dark",
      locale: JSON.stringify({ locale: "ar-XB", dir: "rtl" }),
    });

    // The next visit paints from the cache before React runs.
    await page.route(/\/src\/main\.tsx/, (route) => route.abort());
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await page.evaluate(ROOT_BEFORE_MOUNT)).toEqual({
      theme: "dark",
      lang: "ar-XB",
      dir: "rtl",
    });
  });

  test("saves the theme choice to the server with its version and restores it after reload", async ({ page }) => {
    await mockAuthenticatedSession(page);
    const patches: Record<string, unknown>[] = [];
    const record = await mockUserPreferences(
      page,
      { casVersion: 3 },
      (body) => patches.push(body),
    );
    await page.addInitScript((organizationId) => {
      if (!sessionStorage.getItem("theme-save-initialized")) {
        localStorage.clear();
        localStorage.setItem(
          "bakery.organization.lastSelected.v1",
          organizationId,
        );
        sessionStorage.setItem("theme-save-initialized", "true");
      }
    }, MOCK_ORGANIZATION_ID);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/settings/appearance");
    await page.getByRole("radiogroup", { name: "Color theme" }).getByText(
      "Dark",
      { exact: true },
    ).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ theme: "dark", expectedCasVersion: 3 });
    expect(record.theme).toBe("dark");

    // A new context-free reload: the cache is wiped, the server answers.
    await page.evaluate(() => localStorage.removeItem("bakery.theme.v1"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("formats dates in the preferred time zone, falling back to the browser's", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await mockUserPreferences(page, { timeZone: "Pacific/Auckland" });
    await page.addInitScript((organizationId) => {
      localStorage.setItem(
        "bakery.organization.lastSelected.v1",
        organizationId,
      );
    }, MOCK_ORGANIZATION_ID);
    const updatedAt = "2026-01-01T23:30:00.000Z";
    await page.route("**/v1/me/sessions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              current: true,
              createdAt: updatedAt,
              updatedAt,
              expiresAt: "2026-02-01T00:00:00.000Z",
              userAgent: "Fixture Browser/1.0",
              ipAddress: "127.0.0.1",
            },
            {
              id: "00000000-0000-4000-8000-000000000009",
              current: false,
              createdAt: updatedAt,
              updatedAt,
              expiresAt: "2026-02-01T00:00:00.000Z",
              userAgent: "Other Desktop/1.0",
              ipAddress: "127.0.0.2",
            },
          ],
        }),
      }));
    await page.goto("/settings/sessions");
    const expected = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Pacific/Auckland",
    }).format(new Date(updatedAt));
    await expect(page.getByTestId("sessions-other")).toContainText(expected);
  });
});
