import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { mockUserPreferences } from "./helpers/mock-session.ts";
import {
  GITHUB_MANIFEST as MANIFEST,
  GITHUB_REGISTRATION_URL,
  INTEGRATIONS_PAGE_PATH as PAGE_PATH,
  integrationsFixture,
  problem,
  registered,
  slackSet,
  slackUnset,
  unregistered,
} from "./helpers/installation-integrations-fixtures.ts";

const createButton = (page: Page) =>
  page.getByRole("button", { name: "Create GitHub App" });

test("AC1 unregistered administrator is offered Create GitHub App and sees no credentials", async ({ page }) => {
  await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" }))
    .toBeVisible();
  await expect(page.getByText("No GitHub App registered")).toBeVisible();
  await expect(createButton(page)).toBeEnabled();
  // The existing-App form offers empty fields; no credential is ever shown.
  const form = page.getByTestId("github-existing-app-register");
  for (const name of ["appId", "clientId", "clientSecret", "webhookSecret"]) {
    await expect(form.locator(`input[name="${name}"]`)).toHaveValue("");
  }
  await expect(form.locator('textarea[name="privateKey"]')).toHaveValue("");
});

test(
  "the page sits in the installation section navigation and breadcrumb",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "the phone collapses section navigation into a menu",
    );
    await integrationsFixture(page);
    await page.goto(PAGE_PATH);
    await expect(
      page.locator('.bakery-section-navigation a[href$="/integrations"]'),
    ).toHaveAttribute("aria-current", "page");
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(breadcrumb).toContainText("Installation");
    await expect(breadcrumb).toContainText("Integrations");
  },
);

test("AC2 Create GitHub App submits the manifest and state to GitHub", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  await createButton(page).click();
  await expect.poll(() => f.githubPosts.length).toBe(1);
  const post = f.githubPosts[0];
  expect(post?.method).toBe("POST");
  expect(post?.url).toBe(GITHUB_REGISTRATION_URL);
  expect(post?.body.get("manifest")).toBe(MANIFEST);
  expect(post?.body.get("state")).toBe("state-from-bakery");
  // The prefilled name is Bakery plus this deployment's host.
  expect(f.begins).toEqual([{ name: "Bakery 127-0-0-1" }]);
  // The single-use state never reaches storage. The click navigates the page to
  // GitHub, so evaluating in the page races that navigation ("Execution context
  // was destroyed") and, when it wins, reads GitHub's storage instead of
  // Bakery's. The context's storage state reads every origin the page visited,
  // Bakery's included, without needing a live execution context.
  const storage = await page.context().storageState();
  expect(JSON.stringify(storage.origins)).not.toContain("state-from-bakery");
});

test("the App name the administrator types is the name the manifest asks GitHub for", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  const name = page.getByRole("textbox", { name: "App name" });
  await expect(name).toHaveValue("Bakery 127-0-0-1");
  await expect(
    page.getByText("if GitHub says the name is already taken"),
  ).toBeVisible();
  // Empty, blank and over 34 characters are refused before any request.
  for (const value of ["", "   ", "x".repeat(35)]) {
    await name.fill(value);
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Enter a name of 1 to 34 characters."))
      .toBeVisible();
    await expect(createButton(page)).toBeDisabled();
  }
  await name.fill("  Acme Bakery Staging  ");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await createButton(page).click();
  await expect.poll(() => f.githubPosts.length).toBe(1);
  expect(f.begins).toEqual([{ name: "Acme Bakery Staging" }]);
});

test("AC3 an unknown or expired state is a recoverable error that changes nothing", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(`${PAGE_PATH}?githubAppRegistration=state_rejected`);
  await expect(
    page.getByText("The registration link expired or was not recognised"),
  )
    .toBeVisible();
  await expect(page.getByText("No GitHub App registered")).toBeVisible();
  expect(f.begins).toHaveLength(0);
  expect(f.githubPosts).toHaveLength(0);
  const reads = f.reads;
  await page.getByRole("button", { name: "Start again" }).click();
  await expect.poll(() => f.githubPosts.length).toBe(1);
  expect(f.begins).toHaveLength(1);
  expect(f.reads).toBe(reads);
});

test("AC4 a viewer who is not an Installation administrator sees forbidden and no action", async ({ page }) => {
  const f = await integrationsFixture(page, "forbidden");
  await page.goto(PAGE_PATH);
  await expect(
    page.getByText(
      "Only installation administrators can view or change integrations.",
    ),
  ).toBeVisible();
  await expect(createButton(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start again" }))
    .toHaveCount(0);
  expect(f.begins).toHaveLength(0);
});

test("AC4 an authority revoked after load shows forbidden and removes the action", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.beginAnswer = "forbidden";
  await page.goto(PAGE_PATH);
  await createButton(page).click();
  await expect(
    page.getByText(
      "Only installation administrators can view or change integrations.",
    ),
  ).toBeVisible();
  await expect(createButton(page)).toHaveCount(0);
  expect(f.githubPosts).toHaveLength(0);
});

test("returning from GitHub through the back/forward cache re-enables Create", async ({ page }) => {
  await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  // Keep the page in place, as the back/forward cache does on return.
  await page.evaluate(() => {
    HTMLFormElement.prototype.submit = () => {};
  });
  await createButton(page).click();
  await expect(page.getByRole("button", { name: "Opening GitHub" }))
    .toBeDisabled();
  await page.evaluate(() =>
    globalThis.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    )
  );
  await expect(createButton(page)).toBeEnabled();
  await expect(page.getByText("Taking you to GitHub to confirm the App."))
    .toHaveCount(0);
});

test("AC5 a valid state shows the registered App name, id, owner and permissions", async ({ page }) => {
  await integrationsFixture(page, registered);
  await page.goto(`${PAGE_PATH}?githubAppRegistration=registered`);
  await expect(page.getByText("GitHub App registered.")).toBeVisible();
  const main = page.getByTestId("installation-integrations");
  await expect(main.getByText("Bakery Test 912345")).toBeVisible();
  await expect(main.getByText("912345", { exact: true })).toBeVisible();
  await expect(main.getByText("bakery-test-912345")).toBeVisible();
  await expect(main.getByText("bakery-owner (Organization)")).toBeVisible();
  const permissions = main.getByRole("list", {
    name: "GitHub App permissions",
  });
  await expect(permissions.getByRole("listitem")).toHaveCount(3);
  await expect(
    permissions.getByRole("listitem").filter({ hasText: "contents" }),
  )
    .toContainText("Write");
  await expect(
    permissions.getByRole("listitem").filter({ hasText: "metadata" }),
  )
    .toContainText("Read");
  await expect(
    main.getByText(
      "The client secret, private key and webhook secret are stored encrypted and never shown.",
    ),
  ).toBeVisible();
  await expect(createButton(page)).toHaveCount(0);
  await expect(main.getByText("Iv23liPublicClientId")).toHaveCount(0);
});

test("dismissing the registered outcome clears the query string", async ({ page }) => {
  await integrationsFixture(page, registered);
  await page.goto(`${PAGE_PATH}?githubAppRegistration=registered`);
  await page.getByRole("button", { name: /dismiss/i }).click();
  await expect(page).toHaveURL(PAGE_PATH);
  await expect(page.getByText("GitHub App registered.")).toHaveCount(0);
});

for (
  const [outcome, text, retry] of [
    [
      "conversion_failed",
      "GitHub could not finish creating the App. Nothing was stored.",
      true,
    ],
    [
      "storage_failed",
      "GitHub created the App but Bakery could not store its credentials.",
      true,
    ],
    [
      "already_registered",
      "A GitHub App is already registered, so nothing was changed.",
      false,
    ],
  ] as const
) {
  test(
    `${outcome} outcome is reported${
      retry ? " with a way to start again" : ""
    }`,
    async ({ page }) => {
      const f = await integrationsFixture(
        page,
        outcome === "already_registered" ? registered : unregistered,
      );
      await page.goto(`${PAGE_PATH}?githubAppRegistration=${outcome}`);
      await expect(page.getByText(text)).toBeVisible();
      await expect(page.getByRole("button", { name: "Start again" }))
        .toHaveCount(retry ? 1 : 0);
      expect(f.begins).toHaveLength(0);
    },
  );
}

test("an unknown outcome value is ignored", async ({ page }) => {
  await integrationsFixture(page);
  await page.goto(`${PAGE_PATH}?githubAppRegistration=%3Cb%3Eboom`);
  await expect(page.getByText("No GitHub App registered")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start again" }))
    .toHaveCount(0);
});

test("begin conflict with an App already stored shows the registered App", async ({ page }) => {
  const f: Fixture = await integrationsFixture(page);
  f.beginAnswer = "conflict";
  await page.goto(PAGE_PATH);
  await expect(createButton(page)).toBeVisible();
  f.current = registered;
  await createButton(page).click();
  await expect(page.getByText("Bakery Test 912345")).toBeVisible();
  expect(f.githubPosts).toHaveLength(0);
});

test("begin conflict without an App shows a recoverable setup-unavailable error", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.beginAnswer = "conflict";
  await page.goto(PAGE_PATH);
  await createButton(page).click();
  await expect(page.getByText(/GitHub App setup is not available/))
    .toBeVisible();
  await expect(page.getByText("No GitHub App registered")).toBeVisible();
  f.beginAnswer = "ok";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => f.githubPosts.length).toBe(1);
});

test("a failed begin is a recoverable error and a failed read offers retry", async ({ page }) => {
  const f = await integrationsFixture(page, "error");
  await page.goto(PAGE_PATH);
  await expect(page.getByText("The GitHub App could not be loaded."))
    .toBeVisible();
  await expect(createButton(page)).toHaveCount(0);
  f.current = unregistered;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(createButton(page)).toBeVisible();
  f.beginAnswer = "error";
  await createButton(page).click();
  await expect(page.getByText("GitHub App setup could not start."))
    .toBeVisible();
  await expect(page.getByText(/secrets key/)).toHaveCount(0);
  expect(f.githubPosts).toHaveLength(0);
});

test("Create GitHub App is single-flight", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  await createButton(page).dblclick();
  await expect.poll(() => f.githubPosts.length).toBe(1);
  expect(f.begins).toHaveLength(1);
});

test("a registered row missing its name shows the load error and no Create", async ({ page }) => {
  await integrationsFixture(page, { ...registered, name: null });
  await page.goto(PAGE_PATH);
  await expect(page.getByText("The GitHub App could not be loaded."))
    .toBeVisible();
  await expect(createButton(page)).toHaveCount(0);
});

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test(
  "Tab order runs from the section navigation to Create GitHub App, which Enter activates",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "the phone collapses section navigation into a menu",
    );
    const f = await integrationsFixture(page);
    await page.goto(PAGE_PATH);
    await expect(createButton(page)).toBeVisible();
    const current = page.locator(
      '.bakery-section-navigation a[aria-current="page"]',
    );
    await current.focus();
    const seen: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press("Tab");
      seen.push(
        await page.evaluate(() =>
          document.activeElement?.textContent?.trim() ?? ""
        ),
      );
      if (
        await createButton(page).evaluate((node) =>
          node === document.activeElement
        )
      ) break;
    }
    await expect(createButton(page)).toBeFocused();
    expect(seen.at(-1)).toBe("Create GitHub App");
    await page.keyboard.press("Enter");
    await expect.poll(() => f.githubPosts.length).toBe(1);
  },
);

test(
  "Tab reaches Dismiss before the registered details and Shift+Tab returns",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "the phone collapses section navigation into a menu",
    );
    await integrationsFixture(page, registered);
    await page.goto(`${PAGE_PATH}?githubAppRegistration=registered`);
    const dismiss = page.getByRole("button", { name: /dismiss/i });
    await expect(dismiss).toBeVisible();
    await page.locator('.bakery-section-navigation a[aria-current="page"]')
      .focus();
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press("Tab");
      if (
        await dismiss.evaluate((node) => node === document.activeElement)
      ) break;
    }
    await expect(dismiss).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dismiss).not.toBeFocused();
    await expect(createButton(page)).toHaveCount(0);
  },
);

for (
  const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]
) {
  test(
    `integrations has no axe violations and reflows at ${viewport.width}`,
    async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name === "mobile",
        "viewports are set explicitly in the desktop project",
      );
      await integrationsFixture(page, registered);
      await page.setViewportSize(viewport);
      await page.goto(`${PAGE_PATH}?githubAppRegistration=registered`);
      await expect(page.getByText("Bakery Test 912345")).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await noHorizontalScroll(page)).toBe(true);
    },
  );
}

test("integrations stays usable at 200% zoom", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name === "mobile",
    "zoom runs in the desktop project",
  );
  await integrationsFixture(page);
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto(PAGE_PATH);
  await expect(createButton(page)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await createButton(page).scrollIntoViewIfNeeded();
  await expect(createButton(page)).toBeInViewport();
});

test(
  "integrations honours reduced motion and the dark theme",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "media emulation runs in the desktop project",
    );
    await integrationsFixture(page);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.goto(PAGE_PATH);
    await expect(createButton(page)).toBeVisible();
    const longest = await page.evaluate(() =>
      Math.max(
        0,
        ...[...document.querySelectorAll<HTMLElement>("main *")].map((
          element,
        ) => parseFloat(getComputedStyle(element).transitionDuration)),
      )
    );
    expect(longest).toBeLessThanOrEqual(0.01);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  },
);

test("the registered owner type is translated, not GitHub's raw word", async ({ page }) => {
  await integrationsFixture(page, registered);
  await mockUserPreferences(page, { effectiveLocale: "en-XA" });
  await page.goto(PAGE_PATH);
  const main = page.getByTestId("installation-integrations");
  await expect(main.getByText("bakery-owner")).toBeVisible();
  await expect(main.getByText("(Organization)")).toHaveCount(0);
});

test(
  "pseudo-locale and RTL render translated copy with logical layout",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "locale emulation runs in the desktop project",
    );
    await integrationsFixture(page);
    await mockUserPreferences(page, {
      effectiveLocale: "ar-XB",
      direction: "rtl",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_PATH);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(
      page.getByTestId("installation-integrations").getByRole("heading", {
        level: 1,
      }),
    ).not.toHaveText("Integrations");
    await expect(
      page.getByRole("button", { name: "Create GitHub App", exact: true }),
    ).toHaveCount(0);
    expect(await noHorizontalScroll(page)).toBe(true);
  },
);

test(
  "the en-XA pseudo-locale renders translated copy without horizontal scroll",
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "locale emulation runs in the desktop project",
    );
    await integrationsFixture(page);
    await mockUserPreferences(page, {
      effectiveLocale: "en-XA",
      direction: "ltr",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PAGE_PATH);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(
      page.getByTestId("installation-integrations").getByRole("heading", {
        level: 1,
      }),
    ).not.toHaveText("Integrations");
    await expect(
      page.getByRole("button", { name: "Create GitHub App", exact: true }),
    ).toHaveCount(0);
    expect(await noHorizontalScroll(page)).toBe(true);
  },
);

const PRIVATE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nprivate-key-body-from-github\n-----END RSA PRIVATE KEY-----\n";
const SECRETS = {
  clientSecret: "client-secret-typed-once",
  privateKey: PRIVATE_KEY,
  webhookSecret: "webhook-secret-typed-once",
};

/** Fills the existing-App form; omitted secrets stay empty. */
async function fillExistingApp(
  page: Page,
  mode: "register" | "replace",
  values: Partial<
    Record<
      "appId" | "clientId" | "clientSecret" | "privateKey" | "webhookSecret",
      string
    >
  >,
) {
  const form = page.getByTestId(`github-existing-app-${mode}`);
  for (const [name, value] of Object.entries(values)) {
    const field = name === "privateKey"
      ? form.locator('textarea[name="privateKey"]')
      : form.locator(`input[name="${name}"]`);
    await field.fill(value);
  }
  return form;
}

/** No typed secret is left in the DOM, the URL or browser storage. */
async function expectNoSecretRetained(page: Page) {
  const retained = await page.evaluate(() =>
    JSON.stringify({
      html: document.documentElement.outerHTML,
      values: [...document.querySelectorAll("input, textarea")].map((node) =>
        (node as HTMLInputElement).value
      ),
      url: location.href,
      local: { ...localStorage },
      session: { ...sessionStorage },
    })
  );
  for (
    const secret of [
      SECRETS.clientSecret,
      SECRETS.webhookSecret,
      "private-key-body-from-github",
    ]
  ) expect(retained).not.toContain(secret);
}

test("AC1 an existing App's pasted credentials are sent once and the registered App shows", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  const form = await fillExistingApp(page, "register", {
    appId: "912345",
    clientId: "Iv23liPublicClientId",
    ...SECRETS,
  });
  await form.getByRole("button", { name: "Verify and save" }).click();
  await expect(page.getByText("GitHub confirmed the App. Credentials stored."))
    .toBeVisible();
  await expect(page.getByText("Bakery Test 912345")).toBeVisible();
  expect(f.puts).toHaveLength(1);
  expect(f.puts[0].body).toEqual({
    appId: 912345,
    clientId: "Iv23liPublicClientId",
    ...SECRETS,
  });
  expect(f.puts[0].headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.puts[0].headers["if-match"]).toBeUndefined();
  await expectNoSecretRetained(page);
});

for (
  const [label, refusal, copy] of [
    [
      "AC2 GitHub not confirming the App",
      {
        status: 422,
        code: "UNPROCESSABLE",
        issues: [{
          path: ["appId"],
          code: "app_not_confirmed",
          message: "app not confirmed",
        }],
      },
      "GitHub did not confirm this App ID and client ID with this private key.",
    ],
    [
      "AC3 a malformed private key",
      {
        status: 400,
        code: "MALFORMED_REQUEST",
        issues: [{
          path: ["privateKey"],
          code: "invalid_private_key",
          message: "Private key must be an RSA private key in PEM format.",
        }],
      },
      "The private key is not an RSA private key in PEM format.",
    ],
    [
      "GitHub being unreachable",
      { status: 503, code: "DEPENDENCY_UNAVAILABLE" },
      "Bakery could not reach GitHub to confirm the App.",
    ],
    [
      "a missing secrets key",
      { status: 409, code: "STATE_CONFLICT" },
      "Credentials cannot be stored until",
    ],
    [
      "another administrator registering first",
      { status: 409, code: "STATE_CONFLICT", reason: "provider_registered" },
      "The registration changed since this page loaded.",
    ],
  ] as const
) {
  test(`${label} shows a safe error, keeps the page and clears every secret field`, async ({ page }) => {
    const f = await integrationsFixture(page);
    f.putAnswer = refusal;
    await page.goto(PAGE_PATH);
    const form = await fillExistingApp(page, "register", {
      appId: "912345",
      clientId: "Iv23liPublicClientId",
      ...SECRETS,
    });
    await form.getByRole("button", { name: "Verify and save" }).click();
    await expect(page.getByText(copy, { exact: false })).toBeVisible();
    await expect(page.getByText("No GitHub App registered")).toBeVisible();
    await expect(form.locator('input[name="appId"]')).toHaveValue("912345");
    await expect(form.locator('input[name="clientId"]')).toHaveValue(
      "Iv23liPublicClientId",
    );
    await expect(form.locator('input[name="clientSecret"]')).toHaveValue("");
    await expect(form.locator('textarea[name="privateKey"]')).toHaveValue("");
    await expect(form.getByRole("button", { name: "Verify and save" }))
      .toBeDisabled();
    expect(f.puts).toHaveLength(1);
    await expectNoSecretRetained(page);
  });
}

test("Verify and save waits for a whole-number App ID, client ID, client secret and key", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  const form = page.getByTestId("github-existing-app-register");
  const submit = form.getByRole("button", { name: "Verify and save" });
  await expect(submit).toBeDisabled();
  await fillExistingApp(page, "register", {
    appId: "12a",
    clientId: "Iv23liPublicClientId",
    privateKey: PRIVATE_KEY,
  });
  await expect(form.getByText("Enter the App ID as a whole number."))
    .toBeVisible();
  await expect(submit).toBeDisabled();
  await fillExistingApp(page, "register", { appId: "912345" });
  await expect(submit).toBeDisabled();
  await fillExistingApp(page, "register", {
    clientSecret: SECRETS.clientSecret,
  });
  await expect(submit).toBeEnabled();
  // Values past the contract bounds never leave the form.
  await fillExistingApp(page, "register", { clientId: "I".repeat(101) });
  await expect(
    form.getByText("This value is longer than GitHub issues", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(form.locator('input[name="clientId"]')).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await fillExistingApp(page, "register", {
    clientId: "Iv23liPublicClientId",
    privateKey: "k".repeat(16385),
  });
  const privateKey = form.locator('textarea[name="privateKey"]');
  await expect(privateKey).toHaveAttribute("aria-invalid", "true");
  await expect(submit).toBeDisabled();
  await fillExistingApp(page, "register", { privateKey: PRIVATE_KEY });
  await expect(privateKey).not.toHaveAttribute("aria-invalid");
  await expect(submit).toBeEnabled();
  expect(f.puts).toHaveLength(0);
});

test("AC5 stored secrets render as empty write-only fields with their revision only", async ({ page }) => {
  await integrationsFixture(page, registered);
  await page.goto(PAGE_PATH);
  const form = page.getByTestId("github-existing-app-replace");
  await expect(form.getByRole("heading", { name: "Replace credentials" }))
    .toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Replace credentials" }))
    .toBeVisible();
  await expect(form.locator('input[name="appId"]')).toHaveValue("912345");
  await expect(form.locator('input[name="appId"]')).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(form.locator('input[name="clientId"]')).toHaveValue(
    "Iv23liPublicClientId",
  );
  for (const name of ["clientSecret", "webhookSecret"]) {
    const input = form.locator(`input[name="${name}"]`);
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "new-password");
  }
  await expect(form.locator('textarea[name="privateKey"]')).toHaveValue("");
  await expect(
    form.getByText("Stored (revision 2). Leave empty to keep it."),
  ).toBeVisible();
  await expect(form.getByText(/Stored \(revision 1\)\. Paste the key again/))
    .toBeVisible();
});

test("AC4 replacing sends If-Match and only the secrets typed, then shows the new revisions", async ({ page }) => {
  const f = await integrationsFixture(page, registered);
  await page.goto(PAGE_PATH);
  const form = await fillExistingApp(page, "replace", {
    privateKey: PRIVATE_KEY,
    clientSecret: SECRETS.clientSecret,
  });
  await form.getByRole("button", { name: "Verify and replace" }).click();
  await expect(page.getByText("GitHub confirmed the App. Credentials stored."))
    .toBeVisible();
  expect(f.puts).toHaveLength(1);
  expect(f.puts[0].headers["if-match"]).toBe('"v1"');
  expect(f.puts[0].body).toEqual({
    appId: 912345,
    clientId: "Iv23liPublicClientId",
    clientSecret: SECRETS.clientSecret,
    privateKey: PRIVATE_KEY,
  });
  await expectNoSecretRetained(page);
});

for (
  const [label, refusal, copy] of [
    [
      "a stale version",
      { status: 412, code: "PRECONDITION_FAILED" },
      "The registration changed since this page loaded.",
    ],
    [
      "another App's credentials",
      { status: 409, code: "STATE_CONFLICT", reason: "app_mismatch" },
      "A different GitHub App is registered.",
    ],
  ] as const
) {
  test(`replacing with ${label} stores nothing and says why`, async ({ page }) => {
    const f = await integrationsFixture(page, registered);
    f.putAnswer = refusal;
    await page.goto(PAGE_PATH);
    const reads = f.reads;
    const form = await fillExistingApp(page, "replace", {
      privateKey: PRIVATE_KEY,
    });
    await form.getByRole("button", { name: "Verify and replace" }).click();
    await expect(page.getByText(copy, { exact: false })).toBeVisible();
    await expect(form.locator('textarea[name="privateKey"]')).toHaveValue("");
    if (refusal.status === 412) {
      await expect.poll(() => f.reads).toBeGreaterThan(reads);
    }
    await expectNoSecretRetained(page);
  });
}

test("Verify and save is single-flight", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.route(
    "**/v1/integration-app-registrations/github",
    async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fallback();
    },
  );
  await page.goto(PAGE_PATH);
  const form = await fillExistingApp(page, "register", {
    appId: "912345",
    clientId: "Iv23liPublicClientId",
    ...SECRETS,
  });
  await form.evaluate((node) => {
    const element = node as HTMLFormElement;
    element.requestSubmit();
    element.requestSubmit();
  });
  await expect(page.getByText("Bakery Test 912345")).toBeVisible();
  expect(f.puts).toHaveLength(1);
});

const slackSection = (page: Page) => page.getByTestId("slack-app");

test("a Slack app that is not set up asks for its details and shows the addresses to paste", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await expect(slack.getByText(/Slack is not set up yet/)).toBeVisible();
  // The addresses Slack needs are shown before anything is stored: they belong
  // to this installation, not to the app details that are still missing.
  await expect(slack.getByTestId("slack-redirect-url"))
    .toHaveText(slackUnset.redirectUrl);
  await expect(slack.getByTestId("slack-events-url"))
    .toHaveText(slackUnset.eventsUrl);
  await expect(slack.getByTestId("slack-interactivity-url"))
    .toHaveText(slackUnset.interactivityUrl);
  await expect(slack.getByRole("button", { name: "Copy redirect URL" }))
    .toBeVisible();
  // The read happens at least once; a strict-mode double render may ask again.
  expect(f.slack.reads).toBeGreaterThanOrEqual(1);
});

test("saving Slack details sends all four fields and the version it read", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await slack.getByLabel("App ID").fill("A0123ABCD");
  await slack.getByLabel("Client ID").fill("1234567890.1234567890");
  await slack.getByLabel("Client secret").fill("client-secret-value");
  await slack.getByLabel("Signing secret").fill("signing-secret-value");
  await slack.getByRole("button", { name: "Save" }).click();
  await expect(slack.getByText("Slack is set up.")).toBeVisible();
  expect(f.slack.puts).toHaveLength(1);
  expect(f.slack.puts[0]!.body).toEqual({
    appId: "A0123ABCD",
    clientId: "1234567890.1234567890",
    clientSecret: "client-secret-value",
    signingSecret: "signing-secret-value",
  });
  // A new app has no version yet, so the write is not conditional.
  expect(f.slack.puts[0]!.headers["if-match"]).toBeUndefined();
});

test("an app id that is not one is refused before anything is sent", async ({ page }) => {
  const f = await integrationsFixture(page);
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await slack.getByLabel("App ID").fill("1234567890.1234567890");
  await slack.getByLabel("Client ID").fill("1234567890.1234567890");
  await slack.getByLabel("Client secret").fill("client-secret-value");
  await slack.getByLabel("Signing secret").fill("signing-secret-value");
  await slack.getByRole("button", { name: "Save" }).click();
  await expect(slack.getByText(/A Slack app ID starts with A/)).toBeVisible();
  expect(f.slack.puts).toHaveLength(0);
});

test("replacing the details never refills a secret and keeps one left empty", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.slack.current = { ...slackSet };
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await slack.getByRole("button", { name: "Replace" }).click();
  // The ids come back; the secrets cannot, because the server never returns them.
  await expect(slack.getByLabel("App ID")).toHaveValue("A0123ABCD");
  await expect(slack.getByLabel("Client secret")).toHaveValue("");
  await expect(slack.getByLabel("Signing secret")).toHaveValue("");
  await expect(slack.getByText(/Leave empty to keep it/).first())
    .toBeVisible();
  await slack.getByLabel("Client secret").fill("a-new-client-secret");
  await slack.getByRole("button", { name: "Save" }).click();
  await expect(slack.getByText("Slack is set up.")).toBeVisible();
  const body = f.slack.puts[0]!.body;
  expect(body.clientSecret).toBe("a-new-client-secret");
  // An empty signing secret is not sent at all: the stored one is kept.
  expect(body.signingSecret).toBeUndefined();
  // An existing app is written against the version that was read, as the
  // quoted entity tag the client sends for every conditional write.
  expect(f.slack.puts[0]!.headers["if-match"]).toBe('"v1"');
});

test("check now asks Slack and shows what it answered", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.slack.current = { ...slackSet };
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await expect(slack.getByTestId("slack-signin-state"))
    .toHaveText("Not checked yet.");
  await slack.getByRole("button", { name: "Check now" }).click();
  await expect(slack.getByTestId("slack-signin-state"))
    .toHaveText(/Accepted by Slack on/);
  expect(f.slack.checks).toHaveLength(1);
  expect(f.slack.checks[0]!["if-match"]).toBe('"v1"');
});

test("a check Slack refused names the secret to replace", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.slack.current = { ...slackSet };
  f.slack.checkAnswer = "client_id_refused";
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await slack.getByRole("button", { name: "Check now" }).click();
  await expect(slack.getByText(/does not recognise this client ID/))
    .toBeVisible();
});

test("removing the Slack app asks first and then says it was removed", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.slack.current = { ...slackSet };
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await slack.getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  // Nothing is deleted until the dialog is confirmed.
  expect(f.slack.deletes).toHaveLength(0);
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(slack.getByText("The Slack app details were removed."))
    .toBeVisible();
  expect(f.slack.deletes).toHaveLength(1);
  expect(f.slack.deletes[0]!["if-match"]).toBe('"v1"');
});

test("a removal that fails says so outside the dialog and closes it", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.slack.current = { ...slackSet };
  f.slack.deleteRefusal = { status: 503, code: "DEPENDENCY_UNAVAILABLE" };
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await slack.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" })
    .click();
  // The refusal belongs in the section's banner, not over a modal that hides it,
  // and it names the removal rather than a save.
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    slack.getByText("The details could not be removed. Nothing changed."),
  ).toBeVisible();
  await expect(slack.getByText(/could not be saved/)).toHaveCount(0);
  expect(f.slack.deletes).toHaveLength(1);
});

test("a removal of details that changed answers as unchanged, not as a save", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.slack.current = { ...slackSet };
  f.slack.deleteRefusal = { status: 412, code: "PRECONDITION_FAILED" };
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await slack.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(slack.getByText(/so nothing was removed/)).toBeVisible();
});

test("the Remove trigger is an outline, so it does not read as the page's action", async ({ page }) => {
  const f = await integrationsFixture(page);
  f.slack.current = { ...slackSet };
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  const trigger = slack.getByRole("button", { name: "Remove" });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveClass(/destructive-outline/);
});

test("a Slack read that is forbidden shows the same message as the rest of the page", async ({ page }) => {
  await integrationsFixture(page);
  // Both reads refuse, so the page has one answer for the whole screen.
  await page.route(
    "**/v1/integrations/slack/app",
    (route) => route.fulfill(problem(403, "AUTH_FORBIDDEN")),
  );
  await page.goto(PAGE_PATH);
  const slack = slackSection(page);
  await expect(slack.getByText(/administrator/i).first()).toBeVisible();
  await expect(slack.getByRole("button", { name: "Save" })).toHaveCount(0);
});
