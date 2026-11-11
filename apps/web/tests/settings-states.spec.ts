import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
  mockFeatureAvailability,
  mockUserPreferences,
} from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { firstRender } from "./helpers/first-render.ts";

registerPageHealth(test);

/**
 * Fixture-route state and accessibility matrix for the security suite
 * screens (Phase 6): the security hub, change password, passkeys, add
 * passkey and re-authentication. Every screen is reached through its
 * `/__fixtures__/auth/<screen>-<state>` specimens, which run the real
 * presenters against local state, so nothing here needs the API.
 */

type Screen = {
  readonly id: string;
  readonly heading: string;
  /** V-0 states plus the shared async states this screen renders. */
  readonly states: readonly string[];
  /** The `data-testid` the settled screen root carries. */
  readonly root: string;
  /** Page heading per state, where it differs from `heading`. */
  readonly headings?: Readonly<Record<string, string>>;
  /** Async region test ids, where the screen does not use the shared ones. */
  readonly asyncIds?: Readonly<Record<string, string>>;
};

const ASYNC_STATES = [
  "empty",
  "error",
  "forbidden",
  "conflict",
  "stale",
  "offline",
  "reconnecting",
] as const;

const SCREENS: readonly Screen[] = [
  {
    id: "profile",
    heading: "Profile",
    root: "profile-settings",
    states: ["default", "loading", ...ASYNC_STATES, "long-copy"],
  },
  {
    id: "appearance",
    heading: "Appearance",
    root: "appearance-settings",
    states: ["default", "loading", ...ASYNC_STATES, "long-copy"],
  },
  {
    id: "your-access",
    heading: "Your access",
    root: "access-settings",
    states: [
      "default",
      "loading",
      "empty",
      "error",
      "forbidden",
      "stale",
      "offline",
      "reconnecting",
      "no-access",
    ],
  },
  {
    id: "security-hub",
    heading: "Account and security",
    root: "security-hub",
    states: [
      "default",
      "saved",
      "protected",
      "loading",
      ...ASYNC_STATES,
      "long-copy",
    ],
  },
  {
    id: "password",
    heading: "Change password",
    root: "change-password",
    states: [
      "default",
      "invalid",
      "success",
      "loading",
      "skeleton",
      ...ASYNC_STATES,
      "long-copy",
    ],
  },
  {
    id: "passkeys",
    heading: "Passkeys",
    root: "passkeys-list",
    states: [
      "default",
      "enabled",
      "rename",
      "remove",
      "blocked",
      "failed",
      "loading",
      ...ASYNC_STATES,
      "long-copy",
    ],
  },
  {
    id: "passkey-add",
    heading: "Add a passkey",
    root: "passkey-add",
    states: [
      "default",
      "prompt",
      "canceled",
      "unsupported",
      "failed",
      "success",
      "loading",
      ...ASYNC_STATES,
      "long-copy",
    ],
  },
  {
    id: "clients",
    heading: "Connected clients",
    root: "connected-clients",
    states: [
      "default",
      "revoked",
      "empty",
      "loading",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "reconnecting",
      "long-copy",
    ],
  },
  {
    id: "revoke-client",
    heading: "Revoke client access?",
    root: "revoke-client",
    states: [
      "default",
      "failed",
      "loading",
      "empty",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "reconnecting",
      "long-copy",
    ],
  },
  {
    id: "consent",
    heading: "Allow access to Bakery?",
    root: "consent-request",
    headings: {
      denied: "Access was not granted",
      success: "Client connected",
      expired: "Authorization expired",
    },
    asyncIds: {
      loading: "consent-loading",
      error: "consent-error",
      forbidden: "consent-forbidden",
      offline: "consent-offline",
      reconnecting: "consent-reconnecting",
    },
    states: [
      "default",
      "denied",
      "success",
      "expired",
      "failed",
      "loading",
      "error",
      "forbidden",
      "offline",
      "reconnecting",
      "long-copy",
    ],
  },
  {
    id: "reauth",
    heading: "Confirm it’s you",
    root: "",
    states: [
      "default",
      "invalid",
      "loading",
      "skeleton",
      ...ASYNC_STATES,
      "long-copy",
    ],
  },
];

const fixture = (screen: string, state: string, query = "") =>
  `/__fixtures__/auth/${screen}-${state}${query}`;

/** Opens a specimen and waits until its page heading has rendered. */
async function open(page: Page, screen: string, state: string, query = "") {
  await firstRender(
    () => page.goto(fixture(screen, state, query)),
    (timeout) => expect(page.locator("main h1")).toHaveCount(1, { timeout }),
  );
}

/** Test id of the shared async region a state renders, if it has one. */
const ASYNC_TEST_ID: Readonly<Record<string, string>> = {
  loading: "security-loading",
  skeleton: "security-loading",
  empty: "security-empty",
  error: "security-error",
  forbidden: "security-forbidden",
  conflict: "security-conflict",
  stale: "security-stale",
  offline: "security-offline",
  reconnecting: "security-reconnecting",
};

/** States where the body is replaced rather than annotated. */
const REPLACING = new Set([
  "loading",
  "skeleton",
  "empty",
  "error",
  "forbidden",
]);

async function expectNoHorizontalOverflow(page: Page) {
  try {
    await expect.poll(() =>
      page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
      )
    ).toBe(true);
  } catch (error) {
    // Name what sticks out, so a one-off failure is diagnosable.
    throw new Error(
      `HORIZONTAL_OVERFLOW:${await horizontalOverflowReport(page)}`,
      { cause: error },
    );
  }
}

/** The elements furthest past the viewport's right edge, and font readiness. */
async function horizontalOverflowReport(page: Page): Promise<string> {
  return JSON.stringify(
    await page.evaluate(() => {
      const limit = document.documentElement.clientWidth + 1;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        fonts: document.fonts.status,
        overflowing: [...document.querySelectorAll("body *")]
          .map((element) => ({
            element,
            right: Math.round(element.getBoundingClientRect().right),
          }))
          .filter(({ right }) => right > limit)
          .sort((left, right) => right.right - left.right)
          .slice(0, 6)
          .map(({ element, right }) =>
            `${element.tagName.toLowerCase()}${
              element.getAttribute("data-ui-component")
                ? `[${element.getAttribute("data-ui-component")}]`
                : ""
            }${
              element.getAttribute("data-testid")
                ? `#${element.getAttribute("data-testid")}`
                : ""
            }@${right}`
          ),
      };
    }).catch(() => null),
  );
}

async function expectNoAxeViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, context).toEqual([]);
}

/** Presses Tab until `locator` holds focus; fails if it is never reached. */
async function tabTo(page: Page, locator: ReturnType<Page["locator"]>) {
  for (let presses = 0; presses < 60; presses += 1) {
    if (
      await locator.evaluate((element) => element === document.activeElement)
    ) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("keyboard focus never reached the control");
}

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedSession(page);
});

const MATRIX_CASE_TIMEOUT_MS = 60_000;

/** Page heading a screen renders in a state, as the old matrix computed it. */
function expectedHeading(screen: Screen, state: string): string {
  return screen.headings?.[state] ??
    (screen.id === "passkey-add" && state === "success"
      ? "Your passkey is ready"
      : screen.id === "passkey-add" && state === "prompt"
      ? "Follow your device’s prompt"
      : screen.id === "passkey-add" && state === "canceled"
      ? "Passkey creation canceled"
      : screen.id === "passkey-add" && state === "unsupported"
      ? "Passkeys aren’t available here"
      : screen.id === "passkey-add" && state === "long-copy"
      ? "Your passkey is ready"
      : screen.id === "passkey-add" && state === "failed"
      ? "Passkey wasn’t saved"
      : screen.id === "password" && state === "success"
      ? "Password changed"
      : screen.id === "passkeys" && state === "rename"
      ? "Rename passkey"
      : screen.id === "passkeys" &&
          ["remove", "blocked", "failed"].includes(state)
      ? "Remove this passkey?"
      : screen.heading);
}

test.describe("security suite state matrix", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "state matrix runs in the desktop project only",
  );
  for (const screen of SCREENS) {
    for (const state of screen.states) {
      for (
        const viewport of [{ width: 1280, height: 960 }, {
          width: 390,
          height: 844,
        }]
      ) {
        test(
          `${screen.id}-${state}@${viewport.width}`,
          async ({ page }) => {
            test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
            await page.setViewportSize(viewport);
            const id = `${screen.id}-${state}@${viewport.width}`;
            await firstRender(
              () => page.goto(fixture(screen.id, state)),
              (timeout) =>
                expect(page.locator("main h1"), id).toHaveCount(1, {
                  timeout,
                }),
            );
            await expect(page.locator("main h1"), id).toHaveText(
              expectedHeading(screen, state),
            );
            // password/reauth `loading` is the pending submit (as in V-0);
            // their page-level skeleton is `skeleton`.
            const asyncId =
              state === "loading" && screen.states.includes("skeleton")
                ? undefined
                : screen.asyncIds?.[state] ?? ASYNC_TEST_ID[state];
            if (asyncId) {
              await expect(page.getByTestId(asyncId), id).toBeVisible();
            }
            if (state === "forbidden" && screen.id === "consent") {
              // Nothing about the request survives a refusal.
              await expect(page.getByText("Local development client"))
                .toHaveCount(0);
              await expect(page.getByTestId("consent-allow")).toHaveCount(0);
            } else if (state === "forbidden") {
              // Protected content is cleared and the way out is offered.
              await expect(
                page.getByTestId("security-forbidden").getByRole("link", {
                  name: "Back to personal settings",
                }),
              ).toHaveAttribute("href", "/settings/profile");
              await expect(page.getByText("alex@example.com")).toHaveCount(0);
            }
            if (screen.root && !REPLACING.has(state) && state !== "success") {
              // Annotated states keep the draft or content under the notice.
              if (
                ["conflict", "stale", "offline", "reconnecting"].includes(state)
              ) {
                await expect(page.getByTestId(screen.root), id).toBeVisible();
              }
            }
            await expectNoHorizontalOverflow(page);
            await expectNoAxeViolations(page, id);
          },
        );
      }
    }
  }
});

test.describe("security suite states are honest", () => {
  for (const screen of ["password", "passkey-add", "reauth"]) {
    test(`offline and reconnecting withhold the save action and never report success: ${screen}`, async ({ page }) => {
      test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
      for (const state of ["offline", "reconnecting"]) {
        await open(page, screen, state);
        const submit = page.locator("main button[type=submit]");
        await expect(submit, `${screen}-${state}`).toBeDisabled();
        await expect(
          page.locator(
            '[data-ui-component="inlineNotice"][data-variant="success"]',
          ),
        ).toHaveCount(0);
      }
    });
  }

  test("retry, reload and refresh: password-conflict reload keeps typed value", async ({ page }) => {
    test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
    await open(page, "password", "conflict");
    await page.getByLabel("Current password").fill("old-password");
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId("security-conflict")).toHaveCount(0);
    await expect(page.getByLabel("Current password")).toHaveValue(
      "old-password",
    );
  });

  test("retry, reload and refresh: passkeys-stale refresh", async ({ page }) => {
    test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
    await open(page, "passkeys", "stale");
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByTestId("security-stale")).toHaveCount(0);
  });

  test("retry, reload and refresh: security-hub-error try again", async ({ page }) => {
    test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
    await open(page, "security-hub", "error");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("security-error")).toHaveCount(0);
    await expect(page.getByText("Sign-in methods")).toBeVisible();
  });

  test("loading announces itself and reserves the rows", async ({ page }) => {
    await open(page, "security-hub", "loading");
    await expect(page.getByTestId("security-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(
      page.getByTestId("security-loading").getByRole("status"),
    ).toHaveText("Loading your settings");
  });

  test("errors and failures use alert regions, confirmations use status regions: security-hub-error", async ({ page }) => {
    test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
    await open(page, "security-hub", "error");
    await expect(page.getByTestId("security-error")).toHaveAttribute(
      "role",
      "alert",
    );
  });

  test("errors and failures use alert regions, confirmations use status regions: password-invalid", async ({ page }) => {
    test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
    await open(page, "password", "invalid");
    await expect(
      page.getByRole("alert").filter({ hasText: "We couldn’t complete that" }),
    ).toBeVisible();
  });

  test("errors and failures use alert regions, confirmations use status regions: password-success", async ({ page }) => {
    test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
    await open(page, "password", "success");
    await expect(
      page.getByRole("status").filter({ hasText: "stays signed in" }),
    ).toBeVisible();
  });

  test("errors and failures use alert regions, confirmations use status regions: security-hub-saved", async ({ page }) => {
    test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
    await open(page, "security-hub", "saved");
    await expect(
      page.getByRole("status").filter({ hasText: "identity was confirmed" }),
    ).toBeVisible();
  });
});

test.describe("security suite keyboard-only completion", () => {
  test("change password: invalid focuses the field, then saves", async ({ page }) => {
    await open(page, "password", "default");
    const current = page.getByLabel("Current password");
    const next = page.getByLabel("New password");
    // Focus order inside the page: back link, current field + reveal, new
    // field + reveal, Save, Cancel.
    const order: string[] = [];
    for (let presses = 0; presses < 40 && order.length < 7; presses += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || !element.closest("main")) return null;
        return element.getAttribute("aria-label") ||
          (element as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
          element.textContent?.trim() || null;
      });
      if (label !== null) order.push(label);
    }
    expect(order).toEqual([
      "Account and security",
      "Current password",
      "Show password",
      "New password",
      "Show password",
      "Save password",
      "Cancel",
    ]);
    await tabTo(page, current);
    await page.keyboard.type("old-password");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Show password" }).first(),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
    await page.keyboard.type("short");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Choose a different password")).toBeVisible();
    await expect(next).toBeFocused();
    await page.keyboard.type("-and-much-longer");
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText("Password changed");
    await expect(
      page.getByRole("status").filter({ hasText: "stays signed in" }),
    ).toBeVisible();
  });

  test("passkeys: rename and remove name the device and restore focus", async ({ page }) => {
    await open(page, "passkeys", "enabled");
    const rename = page.getByRole("link", { name: "Rename Personal laptop" });
    const remove = page.getByRole("link", { name: "Remove Personal laptop" });
    // The accessible names carry the device; the visible text stays short.
    await expect(rename).toHaveText("Rename");
    await tabTo(page, rename);
    await page.keyboard.press("Enter");
    const name = page.getByLabel("Passkey name");
    await expect(name).toBeFocused();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Work laptop");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status").filter({
        hasText: "Passkey renamed to Work laptop.",
      }),
    ).toBeVisible();
    // Focus returns to the control that opened the rename page.
    await expect(
      page.getByRole("link", { name: "Rename Work laptop" }),
    ).toBeFocused();

    await tabTo(page, page.getByRole("link", { name: "Remove Work laptop" }));
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText("Remove this passkey?");
    await expect(
      page.getByText("Work laptop will no longer sign in to Bakery."),
    ).toBeVisible();
    const password = page.getByLabel("Current password");
    await expect(password).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("We couldn’t verify your current password").first(),
    ).toBeVisible();
    await expect(password).toBeFocused();
    await page.keyboard.type("correct-horse");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status").filter({
        hasText: "Work laptop was removed from your account.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("No passkeys added yet. Your existing sign-in methods"),
    ).toBeVisible();
    await expect(remove).toHaveCount(0);
  });

  test("passkeys: cancel returns focus to the opener", async ({ page }) => {
    await open(page, "passkeys", "enabled");
    const remove = page.getByRole("link", { name: "Remove Personal laptop" });
    await tabTo(page, remove);
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Current password")).toBeFocused();
    await tabTo(page, page.getByRole("link", { name: "Cancel" }));
    await page.keyboard.press("Enter");
    await expect(remove).toBeFocused();
  });

  test("add a passkey: confirm, prompt, success naming the device", async ({ page }) => {
    await open(page, "passkey-add", "default");
    const password = page.getByLabel("Current password");
    await tabTo(page, password);
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("We couldn’t verify your current password").first(),
    ).toBeVisible();
    await expect(password).toBeFocused();
    await page.keyboard.type("correct-horse");
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText(
      "Follow your device’s prompt",
    );
    await expect(page.locator("main h1")).toHaveText("Your passkey is ready");
    await expect(
      page.getByText("Personal laptop can now sign in to Bakery."),
    ).toBeVisible();
  });

  test("add a passkey: canceling the prompt offers a way back", async ({ page }) => {
    await open(page, "passkey-add", "prompt");
    await tabTo(page, page.getByRole("link", { name: "Cancel" }));
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText(
      "Passkey creation canceled",
    );
    await tabTo(page, page.getByRole("button", { name: "Try again" }));
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText("Add a passkey");
  });

  test("re-authentication: wrong password focuses the field, then confirms and returns", async ({ page }) => {
    await open(page, "reauth", "default");
    const password = page.getByLabel("Password", { exact: true });
    await tabTo(page, password);
    await page.keyboard.type("wrong-password");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("alert").filter({ hasText: "We couldn’t complete that" }),
    ).toBeVisible();
    await expect(password).toBeFocused();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("correct-horse");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(fixture("security-hub", "saved"));
    await expect(
      page.getByText("Your identity was confirmed."),
    ).toBeVisible();
  });
});

test.describe("security suite accessible names and landmarks", () => {
  test("hub rows have unique link names, including connected clients", async ({ page }) => {
    await open(page, "security-hub", "protected");
    for (
      const name of [
        "Change password",
        "Manage passkeys",
        "Manage two-factor authentication",
        "Manage active sessions",
        "Manage connected clients",
        "Sign out of this session",
      ]
    ) {
      await expect(
        page.locator("main").getByRole("link", { name, exact: true }),
      ).toHaveCount(
        1,
      );
    }
    // V-0 core: the email lives in the identity header only, with no
    // read-only "Email address" row and no verification badge.
    await expect(page.getByText("Email address", { exact: true }))
      .toHaveCount(0);
    await expect(page.getByText("Verified")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /email/i }),
    ).toHaveCount(0);
  });

  // One test per screen: each is a single navigation, so none comes near the
  // default timeout even with four workers loading the dev server at once.
  for (
    const [screen, state] of [
      ["security-hub", "default"],
      ["password", "default"],
      ["passkeys", "enabled"],
      ["passkeys", "remove"],
      ["passkey-add", "default"],
      ["reauth", "default"],
    ]
  ) {
    test(`${screen}-${state}: every control has an accessible name`, async ({ page }) => {
      await open(page, screen, state);
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(
          "main button, main a[href], main input, main select, main textarea",
        )].filter((element) => {
          const labelled = element.getAttribute("aria-label") ||
            element.getAttribute("aria-labelledby") ||
            (element as HTMLInputElement).labels?.length;
          return !labelled && !(element.textContent ?? "").trim();
        }).map((element) => element.outerHTML.slice(0, 80))
      );
      expect(unnamed, `${screen}-${state}`).toEqual([]);
    });
  }
});

test.describe("security suite locales", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "locale checks run in the desktop project only",
  );
  const viewports = [{ width: 1280, height: 960 }, {
    width: 390,
    height: 844,
  }];
  for (const locale of ["en-XA", "ar-XB"] as const) {
    for (const viewport of viewports) {
      const at = `@${viewport.width}`;
      test(`${locale} password${at}`, async ({ page }) => {
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await page.setViewportSize(viewport);
        await open(page, "password", "default", `?locale=${locale}`);
        await expect(page.locator("html")).toHaveAttribute(
          "dir",
          locale === "ar-XB" ? "rtl" : "ltr",
        );
        await expect(page.locator("main button[type=submit]")).toBeVisible();
        await expect(page.locator("main input")).toHaveCount(2);
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(page, `password ${locale}`);
      });

      test(`${locale} passkeys${at}`, async ({ page }) => {
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await page.setViewportSize(viewport);
        await open(page, "passkeys", "enabled", `?locale=${locale}`);
        // Rename and Remove keep naming the device in the translated label.
        const actions = page.locator("main [data-passkey-opener]");
        await expect(actions).toHaveCount(2);
        for (
          const label of await actions.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("aria-label") ?? "")
          )
        ) {
          expect(label).toContain("Personal laptop");
        }
        await expect(page.locator("main [data-passkey-add]")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(page, `passkeys ${locale}`);
      });

      test(`${locale} security-hub${at}`, async ({ page }) => {
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await page.setViewportSize(viewport);
        await open(page, "security-hub", "default", `?locale=${locale}`);
        await expect(page.locator("main a[href^='/settings/']"))
          .toHaveCount(5);
        await expectNoHorizontalOverflow(page);
      });

      test(`${locale} profile${at}`, async ({ page }) => {
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await page.setViewportSize(viewport);
        await open(page, "profile", "default", `?locale=${locale}`);
        await expect(page.getByRole("button", { name: /.+/ }).last())
          .toBeVisible();
        await expect(page.locator("main input")).not.toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(page, `profile ${locale}`);
      });

      test(`${locale} appearance${at}`, async ({ page }) => {
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await page.setViewportSize(viewport);
        await open(page, "appearance", "default", `?locale=${locale}`);
        await expect(page.locator("main input[type=radio]")).toHaveCount(3);
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(page, `appearance ${locale}`);
      });

      test(`${locale} your-access${at}`, async ({ page }) => {
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await page.setViewportSize(viewport);
        await open(page, "your-access", "default", `?locale=${locale}`);
        await expect(page.getByTestId("access-settings")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(page, `your-access ${locale}`);
      });
    }

    // The old loop ran this check once per viewport pass at 390x844, so it
    // ran twice with identical URL, viewport and assertions; one test now.
    test(`${locale} section-index@390`, async ({ page }) => {
      test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, "section-index", "default", `?locale=${locale}`);
      await expect(page.locator("main a[href]").first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page, `section-index ${locale}`);
    });
  }
});

test.describe("security suite rendering preferences", () => {
  test.describe("200% zoom", () => {
    test.skip(
      ({ isMobile }) => isMobile,
      "zoom checks run in the desktop project only",
    );
    for (const colorScheme of ["light", "dark"] as const) {
      for (
        const [screen, state] of [
          ["security-hub", "long-copy"],
          ["password", "invalid"],
          ["passkeys", "long-copy"],
          ["passkey-add", "default"],
          ["reauth", "invalid"],
          ["profile", "long-copy"],
          ["appearance", "long-copy"],
          ["your-access", "default"],
          ["section-index", "default"],
        ]
      ) {
        test(`200% zoom ${screen}-${state} ${colorScheme}`, async ({ page }) => {
          test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
          await page.setViewportSize({ width: 1280, height: 960 });
          await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
          await open(page, screen, state);
          await page.evaluate(() => {
            document.documentElement.style.zoom = "200%";
          });
          await expectNoHorizontalOverflow(page);
          await expectNoAxeViolations(
            page,
            `${screen}-${state} ${colorScheme}`,
          );
        });
      }
    }
  });

  test("the loading skeleton stops animating under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "security-hub", "loading");
    const skeleton = page.locator(
      '[data-ui-component="skeleton"][data-state="loading"]',
    ).last();
    await expect(skeleton).toBeVisible();
    await expect.poll(() =>
      skeleton.evaluate((element) => getComputedStyle(element).animationName)
    ).toBe("none");
  });
});

test.describe("security suite coarse pointer targets", () => {
  test.use({ hasTouch: true });

  test.describe("every control on a phone is at least 44px tall", () => {
    for (
      const [screen, state] of [
        ["security-hub", "protected"],
        ["password", "default"],
        ["passkeys", "enabled"],
        ["passkeys", "remove"],
        ["passkey-add", "default"],
        ["reauth", "default"],
        ["profile", "default"],
        ["appearance", "default"],
        ["your-access", "default"],
        ["section-index", "default"],
      ]
    ) {
      test(`${screen}-${state}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop");
        test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
        await page.setViewportSize({ width: 390, height: 844 });
        await open(page, screen, state);
        await expect.poll(() =>
          page.evaluate(() => matchMedia("(pointer: coarse)").matches)
        ).toBe(true);
        // Not scanned: the "View in Integrations" link, whose visible box is
        // text height by design; its 44px tap area is proven by "the View in
        // Integrations link keeps its box and taps 44px tall" below.
        const small = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(
            "main button, main a[href]:not([href='#integrations']), main input:not([type=radio])",
          )].map((element) => ({
            html: element.outerHTML.slice(0, 90),
            height: element.getBoundingClientRect().height,
          })).filter((entry) => entry.height > 0 && entry.height < 44)
        );
        expect(small, `${screen}-${state}`).toEqual([]);
      });
    }
  });

  test(
    "the View in Integrations link keeps its box and taps 44px tall",
    async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, "your-access", "default");
      await expect.poll(() =>
        page.evaluate(() => matchMedia("(pointer: coarse)").matches)
      ).toBe(true);
      const link = page.locator("main a[href='#integrations']");
      await expect(link).toHaveCount(1);
      await link.scrollIntoViewIfNeeded();
      const box = (await link.boundingBox())!;
      // The visible box stays text height: the parity region depends on it.
      expect(box.height).toBeLessThan(44);
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      const reach = (44 - box.height) / 2;
      // Points just inside the 44px target, above and below the text box.
      for (
        const offset of [
          -(box.height / 2 + reach - 1),
          box.height / 2 + reach - 1,
        ]
      ) {
        const hits = await page.evaluate(({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return element?.closest("a[href='#integrations']") !== null;
        }, { x: centerX, y: centerY + offset });
        expect(hits, `elementFromPoint at ${offset}px`).toBe(true);
      }
      // Points beyond the target belong to something else.
      for (
        const offset of [
          -(box.height / 2 + reach + 4),
          box.height / 2 + reach + 4,
        ]
      ) {
        const hits = await page.evaluate(({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return element?.closest("a[href='#integrations']") !== null;
        }, { x: centerX, y: centerY + offset });
        expect(hits, `elementFromPoint at ${offset}px`).toBe(false);
      }
      // A real tap in the lower extension follows the link; go back, then the
      // same for the upper extension, so both sides are proven by a tap.
      await page.touchscreen.tap(centerX, centerY + box.height / 2 + reach - 1);
      await expect(page).toHaveURL(/#integrations$/);
      await page.goBack();
      await expect(page).not.toHaveURL(/#integrations$/);
      await link.scrollIntoViewIfNeeded();
      const again = (await link.boundingBox())!;
      await page.touchscreen.tap(
        again.x + again.width / 2,
        again.y + again.height / 2 - (again.height / 2 + reach - 1),
      );
      await expect(page).toHaveURL(/#integrations$/);
    },
  );

  test(
    "theme cards are the 44px target and tapping one selects the theme",
    async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop");
      await mockUserPreferences(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/settings/appearance");
      await expect(page.locator("main h1")).toHaveText("Appearance");
      const cards = page.locator(".ui-theme-choice");
      await expect(cards).toHaveCount(3);
      // The radio input is not the target: the whole card is.
      const heights = await cards.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height)
      );
      for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
      for (const name of ["Dark", "Light", "System"]) {
        const card = cards.filter({ hasText: name });
        const box = (await card.boundingBox())!;
        await page.touchscreen.tap(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        await expect(card.locator("input[type=radio]")).toBeChecked();
      }
    },
  );
});

/**
 * `/organization/settings` is a production route with no Paper artboard, so
 * its states are driven through the real page with mocked API answers.
 */
const ORGANIZATION_PATH = "/organization/settings";

type OrganizationMock = {
  version: number;
  defaultLocale: string | null;
  name: string;
  /** Resolves before the next organization GET answers; `null` answers now. */
  gate: Promise<void> | null;
  /** Status the next organization GET answers with. */
  getStatus: number;
  /** Status the next PATCH answers with. */
  patchStatus: number;
  patches: { ifMatch: string | null; key: string | null; body: unknown }[];
};

const PROBLEM_BODY = (status: number, code: string) =>
  JSON.stringify({
    type: `https://bakery.example/problems/${code.toLowerCase()}`,
    title: code,
    status,
    detail: code,
    code,
    requestId: "00000000-0000-4000-8000-0000000000e1",
    traceId: "00000000-0000-4000-8000-0000000000e2",
    retryable: false,
  });

async function mockOrganization(
  page: Page,
  init: Partial<Pick<OrganizationMock, "name" | "defaultLocale" | "version">> =
    {},
  role: "admin" | "developer" = "admin",
): Promise<OrganizationMock> {
  const mock: OrganizationMock = {
    version: 4,
    defaultLocale: null,
    name: "Fixture Org",
    gate: null,
    getStatus: 200,
    patchStatus: 200,
    patches: [],
    ...init,
  };
  const record = () => ({
    id: MOCK_ORGANIZATION_ID,
    name: mock.name,
    slug: "fixture-org",
    logo: null,
    metadata: {},
    defaultLocale: mock.defaultLocale,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    version: mock.version,
  });
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}`,
    async (route) => {
      const request = route.request();
      if (request.method() === "PATCH") {
        mock.patches.push({
          ifMatch: request.headers()["if-match"] ?? null,
          key: request.headers()["idempotency-key"] ?? null,
          body: request.postDataJSON(),
        });
        if (mock.patchStatus !== 200) {
          const code = mock.patchStatus === 403
            ? "AUTH_FORBIDDEN"
            : mock.patchStatus === 409
            ? "VERSION_CONFLICT"
            : "INTERNAL";
          return route.fulfill({
            status: mock.patchStatus,
            contentType: "application/problem+json",
            body: PROBLEM_BODY(mock.patchStatus, code),
          });
        }
        const body = request.postDataJSON() as {
          defaultLocale?: string | null;
        };
        mock.defaultLocale = body.defaultLocale ?? null;
        mock.version += 1;
      } else {
        await mock.gate;
        if (mock.getStatus !== 200) {
          const code = mock.getStatus === 403 ? "AUTH_FORBIDDEN" : "INTERNAL";
          return route.fulfill({
            status: mock.getStatus,
            contentType: "application/problem+json",
            body: PROBLEM_BODY(mock.getStatus, code),
          });
        }
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(record()),
      });
    },
  );
  if (role === "developer") {
    await page.route(
      "**/v1/organizations",
      (route) =>
        route.request().method() !== "GET" ? route.continue() : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [{ ...record(), role: "developer" }],
            nextCursor: null,
          }),
        }),
    );
  }
  return mock;
}

async function openOrganization(page: Page, query = "") {
  await firstRender(
    () => page.goto(`${ORGANIZATION_PATH}${query}`),
    (timeout) => expect(page.locator("main h1")).toHaveCount(1, { timeout }),
  );
}

test.describe("organization settings states", () => {
  test("an unselected workspace routes to organization choice before editing settings", async ({ page }) => {
    await page.route("**/v1/organizations", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [MOCK_ORGANIZATION_ID, "00000000-0000-4000-8000-000000000099"]
            .map((id) => ({
              id,
              name: "Choose a workspace",
              slug: `workspace-${id}`,
              logo: null,
              defaultLocale: null,
              metadata: {},
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              version: 1,
              role: "admin",
            })),
          nextCursor: null,
        }),
      }));
    await openOrganization(page);
    await expect(page.locator("main h1")).toHaveText("Where are we working?");
    await expect(page.getByRole("button", { name: "Choose a workspace Admin" }))
      .toHaveCount(2);
    await expect(page.getByLabel("Default language")).toHaveCount(0);
    await expectNoAxeViolations(page, "organization settings workspace choice");
  });

  test("choosing a workspace settles after a bounded number of requests", async ({ page }) => {
    // Regression: the restore effect depended on the router's per-load
    // `location` object, so each navigation to `/organizations` re-resolved,
    // re-chose and re-navigated, cancelling its own load in an unbounded
    // `/v1/me` + `/v1/organizations` loop (hundreds of calls in seconds).
    let identityReads = 0;
    let membershipReads = 0;
    await page.route("**/v1/me", (route) => {
      identityReads += 1;
      return route.fallback();
    });
    await page.route("**/v1/organizations", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      membershipReads += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [MOCK_ORGANIZATION_ID, "00000000-0000-4000-8000-000000000099"]
            .map((id) => ({
              id,
              name: "Choose a workspace",
              slug: `workspace-${id}`,
              logo: null,
              defaultLocale: null,
              metadata: {},
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              version: 1,
              role: "admin",
            })),
          nextCursor: null,
        }),
      });
    });
    await openOrganization(page);
    await expect(page.locator("main h1")).toHaveText("Where are we working?");
    await expect(page).toHaveURL(/\/organizations$/);
    // Settle: counts unchanged between two samples, so a runaway loop shows
    // itself before the bounds are read.
    let previous = "";
    await expect.poll(() => {
      const current = `${identityReads}/${membershipReads}`;
      const settled = current === previous;
      previous = current;
      return settled;
    }, { intervals: [500] }).toBe(true);
    expect(identityReads).toBeLessThanOrEqual(6);
    expect(membershipReads).toBeGreaterThanOrEqual(1);
    expect(membershipReads).toBeLessThanOrEqual(8);
  });

  test("an Admin edits the default language with a versioned save", async ({ page }) => {
    const organization = await mockOrganization(page, { defaultLocale: "en" });
    await openOrganization(page);
    await expect(page.locator("main h1")).toHaveText("Organization settings");
    const language = page.getByLabel("Default language");
    await expect(language).toHaveValue("en");
    await expect(language.locator("option")).toHaveText([
      "Bakery default",
      "English",
      "English (accented pseudo-locale)",
      "Arabic (right-to-left pseudo-locale)",
    ]);
    const save = page.getByRole("button", { name: "Save default language" });
    await expect(save).toBeDisabled();
    await language.selectOption("ar-XB");
    await save.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Default language saved." }),
    ).toBeVisible();
    expect(organization.patches).toHaveLength(1);
    expect(organization.patches[0].ifMatch).toBe('"v4"');
    expect(organization.patches[0].key).toBeTruthy();
    expect(organization.patches[0].body).toEqual({ defaultLocale: "ar-XB" });

    // "Bakery default" clears the organization default.
    await language.selectOption("");
    await save.click();
    await expect.poll(() => organization.patches.length).toBe(2);
    expect(organization.patches[1].ifMatch).toBe('"v5"');
    expect(organization.patches[1].body).toEqual({ defaultLocale: null });
  });

  test("a non-Admin sees the default language read-only and feature availability", async ({ page }) => {
    await mockOrganization(page, { defaultLocale: "en-XA" }, "developer");
    await mockFeatureAvailability(page, { organizationCreation: false });
    await openOrganization(page);
    await expect(page.getByTestId("organization-locale-readonly"))
      .toContainText(
        "English (accented pseudo-locale)",
      );
    await expect(page.getByLabel("Default language")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Save default language" }),
    ).toHaveCount(0);
    const features = page.getByTestId("feature-availability");
    await expect(features).toContainText("Registration");
    await expect(features).toContainText("Available");
    await expect(features).toContainText("Organization creation");
    await expect(features).toContainText("Paused");
    await expectNoAxeViolations(page, "organization settings read-only");
  });

  test("loading reserves the page and announces itself", async ({ page }) => {
    const organization = await mockOrganization(page);
    let release = () => {};
    organization.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.goto(ORGANIZATION_PATH);
    await expect(page.getByTestId("security-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    release();
    await expect(page.getByTestId("security-loading")).toHaveCount(0);
    await expect(page.getByLabel("Default language")).toBeVisible();
  });

  test("a failed load shows a retryable error", async ({ page }) => {
    const organization = await mockOrganization(page);
    organization.getStatus = 500;
    await openOrganization(page);
    await expect(page.getByTestId("security-error")).toHaveAttribute(
      "role",
      "alert",
    );
    organization.getStatus = 200;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("security-error")).toHaveCount(0);
    await expect(page.getByLabel("Default language")).toBeVisible();
  });

  test("forbidden clears the content and offers the way back", async ({ page }) => {
    const organization = await mockOrganization(page);
    organization.getStatus = 403;
    await openOrganization(page);
    await expect(page.getByTestId("security-forbidden")).toBeVisible();
    await expect(page.getByLabel("Default language")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Back to personal settings" }),
    ).toHaveAttribute("href", "/settings/profile");
    await expectNoAxeViolations(page, "organization settings forbidden");
  });

  test("a conflicting save keeps the draft and reloads on request", async ({ page }) => {
    const organization = await mockOrganization(page, { defaultLocale: "en" });
    await openOrganization(page);
    organization.patchStatus = 409;
    const language = page.getByLabel("Default language");
    await language.selectOption("en-XA");
    await page.getByRole("button", { name: "Save default language" }).click();
    await expect(page.getByTestId("security-conflict")).toBeVisible();
    await expect(language).toHaveValue("en-XA");
    expect(organization.patches[0].ifMatch).toBe('"v4"');

    // Someone else changed it: reloading shows their version.
    organization.patchStatus = 200;
    organization.version = 9;
    organization.defaultLocale = "ar-XB";
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId("security-conflict")).toHaveCount(0);
    await expect(language).toHaveValue("ar-XB");
    await expectNoAxeViolations(page, "organization settings conflict");
  });
  test("a failed save keeps the draft and retries without reporting success", async ({ page }) => {
    const organization = await mockOrganization(page, { defaultLocale: "en" });
    await openOrganization(page);
    organization.patchStatus = 500;
    const language = page.getByLabel("Default language");
    await language.selectOption("en-XA");
    const save = page.getByRole("button", { name: "Save default language" });
    await save.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(language).toHaveValue("en-XA");
    await expect(
      page.getByRole("status").filter({ hasText: "Default language saved." }),
    )
      .toHaveCount(0);
    organization.patchStatus = 200;
    await save.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Default language saved." }),
    )
      .toBeVisible();
    expect(organization.defaultLocale).toBe("en-XA");
  });

  test("a forbidden save replaces the page with the forbidden state", async ({ page }) => {
    const organization = await mockOrganization(page);
    await openOrganization(page);
    organization.patchStatus = 403;
    await page.getByLabel("Default language").selectOption("en");
    await page.getByRole("button", { name: "Save default language" }).click();
    await expect(page.getByTestId("security-forbidden")).toBeVisible();
  });

  test("offline keeps the draft and withholds the save; reconnecting ends when the read settles", async ({ page, context }) => {
    const organization = await mockOrganization(page, { defaultLocale: "en" });
    await openOrganization(page);
    const language = page.getByLabel("Default language");
    await language.selectOption("en-XA");
    await context.setOffline(true);
    await expect(page.getByTestId("security-offline")).toBeVisible();
    await expect(language).toHaveValue("en-XA");
    await expect(
      page.getByRole("button", { name: "Save default language" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("status").filter({ hasText: "Default language saved." }),
    ).toHaveCount(0);

    let release = () => {};
    organization.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await context.setOffline(false);
    await expect(page.getByTestId("security-reconnecting")).toBeVisible();
    release();
    await expect(page.getByTestId("security-reconnecting")).toHaveCount(0);
    await expect(language).toHaveValue("en-XA");
  });

  test("a routine background refetch never shows reconnecting", async ({ page }) => {
    const organization = await mockOrganization(page, { defaultLocale: "en" });
    await openOrganization(page);
    // A conflict's Reload is an ordinary refetch while the browser is online.
    organization.patchStatus = 409;
    await page.getByLabel("Default language").selectOption("en-XA");
    await page.getByRole("button", { name: "Save default language" }).click();
    await expect(page.getByTestId("security-conflict")).toBeVisible();
    organization.patchStatus = 200;
    let release = () => {};
    organization.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId("security-reconnecting")).toHaveCount(0);
    release();
    await expect(page.getByTestId("security-conflict")).toHaveCount(0);
    await expect(page.getByTestId("security-reconnecting")).toHaveCount(0);
  });

  test("worst-case content wraps without overflow at phone and desktop widths", async ({ page }) => {
    await mockOrganization(page, {
      name:
        "Northstar-Platform-Engineering-and-Reliability-Group-of-the-Greater-Metropolitan-Region",
    });
    for (
      const viewport of [{ width: 1280, height: 960 }, {
        width: 390,
        height: 844,
      }]
    ) {
      await page.setViewportSize(viewport);
      await openOrganization(page);
      await expect(page.getByLabel("Default language")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(
        page,
        `organization settings ${viewport.width}`,
      );
    }
  });

  test("keyboard only: tab to the field, change it, save, and hear the confirmation", async ({ page }) => {
    const organization = await mockOrganization(page, { defaultLocale: "en" });
    await openOrganization(page);
    const language = page.getByLabel("Default language");
    await tabTo(page, language);
    await expect(language).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(language).toHaveValue("en-XA");
    await page.keyboard.press("Tab");
    const save = page.getByRole("button", { name: "Save default language" });
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status").filter({ hasText: "Default language saved." }),
    ).toBeVisible();
    expect(organization.patches[0].body).toEqual({ defaultLocale: "en-XA" });
  });

  test("every organization settings control has an accessible name", async ({ page }) => {
    await mockOrganization(page);
    await openOrganization(page);
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(
        "main button, main a[href], main input, main select, main textarea",
      )].filter((element) => {
        const labelled = element.getAttribute("aria-label") ||
          element.getAttribute("aria-labelledby") ||
          (element as HTMLInputElement).labels?.length;
        return !labelled && !(element.textContent ?? "").trim();
      }).map((element) => element.outerHTML.slice(0, 80))
    );
    expect(unnamed).toEqual([]);
  });

  for (const locale of ["en-XA", "ar-XB"] as const) {
    test(
      `${locale}: essential actions stay present and contained`,
      async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop");
        await mockOrganization(page);
        await mockUserPreferences(page, {
          effectiveLocale: locale,
          direction: locale === "ar-XB" ? "rtl" : "ltr",
        });
        for (
          const viewport of [{ width: 1280, height: 960 }, {
            width: 390,
            height: 844,
          }]
        ) {
          await page.setViewportSize(viewport);
          await openOrganization(page);
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.locator("html")).toHaveAttribute(
            "dir",
            locale === "ar-XB" ? "rtl" : "ltr",
          );
          await expect(page.locator("main select")).toBeVisible();
          await expect(page.locator("main button[type=submit]")).toBeVisible();
          await expect(page.getByTestId("feature-availability")).toBeVisible();
          await expectNoHorizontalOverflow(page);
          await expectNoAxeViolations(page, `organization settings ${locale}`);
        }
      },
    );
  }

  test(
    "survives 200% zoom in both themes with reduced motion",
    async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop");
      await mockOrganization(page);
      await page.setViewportSize({ width: 1280, height: 960 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await openOrganization(page);
        await page.evaluate(() => {
          document.documentElement.style.zoom = "200%";
        });
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(
          page,
          `organization settings ${colorScheme}`,
        );
      }
    },
  );

  test.describe("coarse pointer", () => {
    test.use({ hasTouch: true });
    test(
      "every control on a phone is at least 44px tall",
      async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop");
        await mockOrganization(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await openOrganization(page);
        await expect.poll(() =>
          page.evaluate(() => matchMedia("(pointer: coarse)").matches)
        ).toBe(true);
        const small = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(
            "main button, main a[href], main input, main select",
          )].map((element) => ({
            html: element.outerHTML.slice(0, 90),
            height: element.getBoundingClientRect().height,
          })).filter((entry) => entry.height > 0 && entry.height < 44)
        );
        expect(small).toEqual([]);
      },
    );
  });
});

test.describe("contextual feature availability", () => {
  test("/organizations disables Create organization with a reason when creation is paused", async ({ page }) => {
    await mockFeatureAvailability(page, { organizationCreation: false });
    await page.goto("/organizations");
    const create = page.getByRole("button", { name: "Create organization" });
    await expect(create).toBeDisabled();
    await expect(create).toHaveAccessibleDescription(
      /Creating organizations is paused/,
    );
    await expectNoAxeViolations(page, "organizations creation paused");
  });

  test("/organizations shows no create control while creation is open", async ({ page }) => {
    await mockFeatureAvailability(page, { organizationCreation: true });
    await page.goto("/organizations");
    await expect(page.getByTestId("organizations-page")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create organization" }),
    ).toHaveCount(0);
  });

  test("/register says Registration paused when signups are off", async ({ page }) => {
    await mockFeatureAvailability(page, { signups: false });
    await page.goto("/register");
    await expect(page.getByTestId("registration-paused")).toContainText(
      "Registration paused",
    );
    await expectNoAxeViolations(page, "register paused");
  });

  test("/register shows no pause notice while signups are open", async ({ page }) => {
    await mockFeatureAvailability(page, { signups: true });
    await page.goto("/register");
    await expect(page.getByTestId("join")).toBeVisible();
    await expect(page.getByTestId("registration-paused")).toHaveCount(0);
  });
});

/**
 * `/settings/profile`, `/settings/appearance` and `/settings/access` are
 * production routes; their fixture states are covered by the matrix above and
 * their live behavior here, through the real pages with mocked API answers.
 */
type ProfileMock = {
  version: number;
  name: string;
  image: string | null;
  emailVerified: boolean;
  getStatus: number;
  patchStatus: number;
  patches: { ifMatch: string | null; key: string | null; body: unknown }[];
};

async function mockProfile(
  page: Page,
  init: Partial<ProfileMock> = {},
): Promise<ProfileMock> {
  const mock: ProfileMock = {
    version: 3,
    name: "Mark Tripoli",
    image: null,
    emailVerified: false,
    getStatus: 200,
    patchStatus: 200,
    patches: [],
    ...init,
  };
  const record = () => ({
    principalId: "00000000-0000-4000-8000-000000000001",
    name: mock.name,
    firstName: "Mark",
    lastName: "Tripoli",
    title: null,
    image: mock.image,
    email: "me@marktripoli.com",
    emailVerified: mock.emailVerified,
    version: mock.version,
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  await page.route("**/v1/me/profile", (route) => {
    const request = route.request();
    const status = request.method() === "PATCH"
      ? mock.patchStatus
      : mock.getStatus;
    if (request.method() === "PATCH") {
      mock.patches.push({
        ifMatch: request.headers()["if-match"] ?? null,
        key: request.headers()["idempotency-key"] ?? null,
        body: request.postDataJSON(),
      });
    }
    if (status !== 200) {
      const code = status === 403
        ? "AUTH_FORBIDDEN"
        : status === 409
        ? "VERSION_CONFLICT"
        : "INTERNAL";
      return route.fulfill({
        status,
        contentType: "application/problem+json",
        body: PROBLEM_BODY(status, code),
      });
    }
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { name?: string };
      if (body.name !== undefined) mock.name = body.name;
      mock.version += 1;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(record()),
    });
  });
  return mock;
}

test.describe("profile page", () => {
  test("fixture: a saved photo shows and a broken one falls back to initials", async ({ page }) => {
    const photo = "https://photos.example/mark.png";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    await page.route(
      photo,
      (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: png }),
    );
    await open(
      page,
      "profile",
      "default",
      `?photo=${encodeURIComponent(photo)}`,
    );
    const avatar = page.locator('main [data-ui-component="avatar"]').first();
    await expect(avatar.locator("img")).toHaveAttribute("src", photo);

    const broken = "https://photos.example/broken.png";
    await page.route(broken, (route) => route.fulfill({ status: 404 }));
    await open(
      page,
      "profile",
      "default",
      `?photo=${encodeURIComponent(broken)}`,
    );
    await expect(avatar).toHaveAttribute("data-state", "fallback");
    await expect(avatar).toHaveText("MT");
    await expect(avatar.locator("img")).toHaveCount(0);
    // The form stays usable; the broken photo never blocks it.
    await page.getByLabel("Display name").fill("Mark T.");
    await expect(page.getByRole("button", { name: "Save profile" }))
      .toBeEnabled();
  });

  test("shows the saved photo, and a photo that fails to load keeps the initials", async ({ page }) => {
    const photo = "https://photos.example/mark.png";
    // 1x1 transparent PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    await mockProfile(page, { image: photo });
    await page.route(
      photo,
      (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: png }),
    );
    await page.goto("/settings/profile");
    const avatar = page.locator('main [data-ui-component="avatar"]').first();
    await expect(avatar.locator("img")).toHaveAttribute("src", photo);
    await expect(avatar).toHaveAttribute("data-state", "default");
  });

  test("a broken photo falls back to initials and never blocks the form", async ({ page }) => {
    const photo = "https://photos.example/broken.png";
    await mockProfile(page, { image: photo });
    await page.route(photo, (route) => route.fulfill({ status: 404 }));
    await page.goto("/settings/profile");
    const avatar = page.locator('main [data-ui-component="avatar"]').first();
    await expect(avatar).toHaveAttribute("data-state", "fallback");
    await expect(avatar).toHaveText("MT");
    await expect(avatar).toHaveAttribute("aria-label", "Mark Tripoli");
    await expect(avatar.locator("img")).toHaveCount(0);
    await page.getByLabel("Display name").fill("Mark T.");
    await expect(page.getByRole("button", { name: "Save profile" }))
      .toBeEnabled();
  });

  test("shows the Verified badge only when the server says so", async ({ page }) => {
    await mockProfile(page, { emailVerified: true });
    await page.goto("/settings/profile");
    await expect(page.locator("main h1")).toHaveText("Profile");
    await expect(page.getByText("Verified", { exact: true })).toBeVisible();
  });

  test("saves only the changed fields with the version it read", async ({ page }) => {
    const profile = await mockProfile(page);
    await page.goto("/settings/profile");
    await expect(page.locator("main h1")).toHaveText("Profile");
    await expect(page.getByTestId("profile-email")).toHaveText(
      "me@marktripoli.com",
    );
    // The server says the email is unverified, so no badge is shown.
    await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);
    const save = page.getByRole("button", { name: "Save profile" });
    await expect(save).toBeDisabled();
    await page.getByLabel("Display name").fill("Mark T.");
    await page.getByLabel("Job title").fill("Staff engineer");
    await save.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Profile saved." }),
    ).toBeVisible();
    expect(profile.patches).toHaveLength(1);
    expect(profile.patches[0].ifMatch).toBe('"v3"');
    expect(profile.patches[0].key).toBeTruthy();
    expect(profile.patches[0].body).toEqual({
      name: "Mark T.",
      title: "Staff engineer",
    });
  });

  test("validation names the field and sends nothing", async ({ page }) => {
    const profile = await mockProfile(page);
    await page.goto("/settings/profile");
    await page.getByLabel("Display name").fill("   ");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByLabel("Display name")).toBeFocused();
    await expect(page.getByRole("alert")).toContainText(
      "Enter a display name.",
    );
    await page.getByLabel("Display name").fill("Mark");
    await page.getByLabel("Profile photo URL").fill(
      "http://insecure.example/a.png",
    );
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByLabel("Profile photo URL")).toBeFocused();
    expect(profile.patches).toHaveLength(0);
  });

  test("a conflicting save keeps the draft and reloads on request", async ({ page }) => {
    const profile = await mockProfile(page, { patchStatus: 409 });
    await page.goto("/settings/profile");
    await page.getByLabel("Display name").fill("Mark T.");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByTestId("security-conflict")).toBeVisible();
    await expect(page.getByLabel("Display name")).toHaveValue("Mark T.");
    profile.patchStatus = 200;
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByTestId("security-conflict")).toHaveCount(0);
    await expect(page.getByLabel("Display name")).toHaveValue("Mark Tripoli");
  });

  test("forbidden clears the content and offers the way back", async ({ page }) => {
    await mockProfile(page, { getStatus: 403 });
    await page.goto("/settings/profile");
    await expect(page.getByTestId("security-forbidden")).toBeVisible();
    await expect(page.getByText("me@marktripoli.com")).toHaveCount(0);
  });
});

test.describe("appearance page", () => {
  test("saves language and time zone together with the version it read", async ({ page }) => {
    const patches: Record<string, unknown>[] = [];
    await mockUserPreferences(
      page,
      { casVersion: 7 },
      (body) => patches.push(body),
    );
    await page.goto("/settings/appearance");
    await expect(page.locator("main h1")).toHaveText("Appearance");
    const save = page.getByRole("button", { name: "Save preferences" });
    await expect(save).toBeDisabled();
    await page.getByLabel("Language").selectOption("en-XA");
    await page.getByLabel("Time zone").selectOption("Pacific/Auckland");
    await save.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Preferences saved." }),
    ).toBeVisible();
    expect(patches).toEqual([{
      locale: "en-XA",
      timeZone: "Pacific/Auckland",
      expectedCasVersion: 7,
    }]);
  });

  test("Cancel discards the draft", async ({ page }) => {
    await mockUserPreferences(page);
    await page.goto("/settings/appearance");
    await page.getByLabel("Language").selectOption("en-XA");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("Language")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Save preferences" }))
      .toBeDisabled();
  });
});

test.describe("your access page", () => {
  const access = (role: "admin" | "developer" | null, capabilities: string[]) =>
    JSON.stringify({
      organizationId: MOCK_ORGANIZATION_ID,
      role,
      capabilities,
    });

  test("summarizes the role and what it allows", async ({ page }) => {
    await page.route(
      `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: access("developer", ["task:read", "worker:read"]),
        }),
    );
    await page.goto("/settings/access");
    await expect(page.locator("main h1")).toHaveText("Your access");
    await expect(page.getByTestId("access-settings")).toContainText(
      "Developer",
    );
    await expect(
      page.getByRole("list", { name: "What your role allows" })
        .getByRole("listitem"),
    ).toHaveCount(3);
    // Nothing invents an external grant production has no source for.
    await expect(page.getByText("External actions")).toHaveCount(0);
  });

  test("no role and no grants shows the no-access state with a refresh", async ({ page }) => {
    let reads = 0;
    await page.route(
      `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
      (route) => {
        reads += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: access(null, []),
        });
      },
    );
    await page.goto("/settings/access");
    await expect(page.getByTestId("access-no-grant")).toBeVisible();
    await page.getByRole("button", { name: "Check access again" }).click();
    await expect.poll(() => reads).toBeGreaterThan(1);
  });

  test("removed access clears the content and offers the way back", async ({ page }) => {
    let removed = false;
    await page.route(
      `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
      (route) =>
        removed
          ? route.fulfill({
            status: 403,
            contentType: "application/problem+json",
            body: PROBLEM_BODY(403, "AUTH_FORBIDDEN"),
          })
          : route.fulfill({
            status: 200,
            contentType: "application/json",
            body: access("admin", ["task:read"]),
          }),
    );
    await page.goto("/settings/access");
    await expect(page.getByTestId("access-settings")).toContainText("Admin");
    removed = true;
    await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
    await page.reload();
    await expect(page.getByTestId("security-forbidden")).toBeVisible();
    await expect(page.getByText("Admin", { exact: true })).toHaveCount(0);
  });
});

test.describe("connected clients and consent", () => {
  test("a refused clients read sends the person to sign in", async ({ page }) => {
    let clientsReads = 0;
    await page.route("**/v1/me/connected-clients", (route) => {
      clientsReads += 1;
      return route.fulfill({
        status: 401,
        headers: { "content-type": "application/problem+json" },
        body: JSON.stringify({
          type: "https://bakery.example/problems/auth-required",
          title: "Authentication required",
          detail: "Sign in to continue.",
          status: 401,
          code: "AUTH_REQUIRED",
          retryable: false,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    });
    await page.goto("/settings/clients");
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(clientsReads).toBeGreaterThanOrEqual(1);
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe("/settings/clients");
  });

  test("the list names each grant's client, organization and scopes", async ({ page }) => {
    await open(page, "clients", "default");
    const row = page.getByTestId("clients-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Local development client");
    // The approved Paper caption: organization, then the scopes as one
    // sentence (tests/rails/ui-paper-frames.node.mjs pins the same text).
    await expect(row).toContainText(
      "Northstar · Read work and artifacts, start and steer tasks",
    );
    await expect(
      page.getByRole("button", {
        name: "Revoke access for Local development client in Northstar",
      }),
    ).toBeVisible();
    // The Settings navigation (a menu on phone, so open at desktop width)
    // carries the Connected clients item.
    await page.setViewportSize({ width: 1280, height: 960 });
    await expect(
      page.locator(".bakery-section-navigation").getByRole("link", {
        name: "Connected clients",
      }),
    ).toHaveCount(1);
  });

  test("revoking walks list, confirmation naming client and organization, revoked list", async ({ page }) => {
    await open(page, "clients", "default");
    await page.getByRole("button", { name: /Revoke access for/ }).click();
    await expect(page).toHaveURL(/revoke-client-default$/);
    await expect(page.locator("main h1")).toHaveText("Revoke client access?");
    await expect(page.getByText("Local development client will lose"))
      .toContainText(
        "Northstar",
      );
    await page.getByRole("button", { name: "Revoke access" }).click();
    await expect(page).toHaveURL(/clients-revoked$/);
    await expect(
      page.getByRole("status").filter({ hasText: "Access was revoked" }),
    ).toBeVisible();
    await expect(page.getByTestId("security-empty")).toBeVisible();
    await expect(page.getByTestId("clients-row")).toHaveCount(0);
  });

  test("cancelling the confirmation returns to the list untouched", async ({ page }) => {
    await open(page, "revoke-client", "default");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/clients-default$/);
    await expect(page.getByTestId("clients-row")).toHaveCount(1);
  });

  test("a failed revocation says the grant stays and keeps both actions", async ({ page }) => {
    await open(page, "revoke-client", "failed");
    await expect(
      page.getByRole("alert").filter({
        hasText: "The grant could not be revoked",
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await expect(page.getByTestId("revoke-client-confirm")).toBeEnabled();
  });

  for (const state of ["offline", "reconnecting"]) {
    test(`offline and reconnecting withhold every revoke action: clients-${state}`, async ({ page }) => {
      test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
      await open(page, "clients", state);
      await expect(
        page.getByRole("button", { name: /Revoke access for/ }),
      ).toBeDisabled();
    });

    test(`offline and reconnecting withhold every revoke action: revoke-client-${state}`, async ({ page }) => {
      test.setTimeout(MATRIX_CASE_TIMEOUT_MS);
      await open(page, "revoke-client", state);
      await expect(page.getByTestId("revoke-client-confirm")).toBeDisabled();
    });
  }

  test("consent binds one organization and lists the requested scopes", async ({ page }) => {
    await open(page, "consent", "default");
    const list = page.getByRole("list", { name: "Requested access" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list).toContainText("Read work and artifacts");
    await expect(list).toContainText("Start and steer tasks");
    const organization = page.getByLabel("Organization");
    await expect(organization).toHaveValue(/a1$/);
    await expect(page.getByText("Only this organization is included"))
      .toBeVisible();
    await organization.selectOption({ label: "Harbor Labs · Admin" });
    await expect(page.getByText("Your organization")).toBeVisible();
    await expect(page.getByText("Harbor Labs", { exact: true })).toBeVisible();
    await expect(page.getByText("The client cannot manage members or secrets"))
      .toBeVisible();
  });

  test("allow and deny each end on their own screen", async ({ page }) => {
    await open(page, "consent", "default");
    await page.getByRole("button", { name: "Allow access" }).click();
    await expect(page.locator("main h1")).toHaveText("Client connected");
    await expect(page.getByTestId("consent-success")).toContainText(
      "Return to your client to continue.",
    );
    await expect(
      page.getByRole("button", { name: "Review connected clients" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow access" }))
      .toHaveCount(
        0,
      );
    await open(page, "consent", "default");
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.locator("main h1")).toHaveText("Access was not granted");
    await expect(page.getByTestId("consent-denied")).toContainText(
      "Existing grants are unchanged.",
    );
    await expect(page.getByRole("button", { name: "Return to account" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Allow access" }))
      .toHaveCount(
        0,
      );
  });

  test("consent keyboard order reaches the organization, Deny, then Allow", async ({ page }) => {
    await open(page, "consent", "default");
    await tabTo(page, page.getByLabel("Organization"));
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("consent-deny")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("consent-allow")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText("Client connected");
  });

  test("consent withholds Allow while offline and never reports success", async ({ page }) => {
    for (const state of ["offline", "reconnecting"]) {
      await open(page, "consent", state);
      await expect(page.getByTestId("consent-allow")).toBeDisabled();
      await expect(
        page.locator(
          '[data-ui-component="inlineNotice"][data-variant="success"]',
        ),
      ).toHaveCount(0);
    }
  });

  test("an expired request offers no grant action and says to start again", async ({ page }) => {
    await open(page, "consent", "expired");
    await expect(page.getByTestId("consent-expired")).toContainText(
      "Start a new connection request from your client.",
    );
    await expect(page.getByRole("button", { name: "Return to account" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Allow access" }))
      .toHaveCount(
        0,
      );
    await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0);
  });

  for (const locale of ["en-XA", "ar-XB"] as const) {
    test(`${locale}: consent and revoke keep every action, contained`, async ({ page }) => {
      for (
        const [screen, ids] of [
          ["consent", ["consent-deny", "consent-allow"]],
          ["revoke-client", ["revoke-client-confirm"]],
        ] as const
      ) {
        await open(page, screen, "default", `?locale=${locale}`);
        await expect(page.locator("html")).toHaveAttribute(
          "dir",
          locale === "ar-XB" ? "rtl" : "ltr",
        );
        for (const id of ids) {
          await expect(page.getByTestId(id), `${screen} ${locale}`)
            .toBeVisible();
        }
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(page, `${screen} ${locale}`);
      }
    });
  }
});
