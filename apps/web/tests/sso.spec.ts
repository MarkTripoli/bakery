import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { shot } from "./helpers/real-api.ts";

type Provider = {
  providerId: string;
  issuer: string;
  domain: string;
  domainVerified: boolean;
  protocol: "oidc" | "saml";
};

type Fixture = {
  providers: Provider[];
  enforce: boolean;
  verified: boolean;
  registered: Record<string, unknown>[];
  enforcement: boolean[];
  removed: string[];
  updated: Record<string, unknown>[];
};

/** IdP metadata naming a POST and a redirect endpoint: the redirect one wins. */
const SAML_METADATA =
  `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.acme.example"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.acme.example/post"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.acme.example/redirect"/></IDPSSODescriptor></EntityDescriptor>`;

const OKTA_UNVERIFIED = {
  providerId: "okta",
  issuer: "https://acme.okta.example",
  domain: "acme.example",
  domainVerified: false,
  protocol: "oidc",
} as const;
const ENTRA_UNVERIFIED = {
  providerId: "entra",
  issuer: "",
  domain: "corp.example",
  domainVerified: false,
  protocol: "saml",
} as const;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function ssoFixture(
  page: Page,
  options: Partial<Pick<Fixture, "providers" | "enforce">> & {
    forbidden?: boolean;
    /** The server already holds the domain as verified: every check answers 409. */
    alreadyVerified?: boolean;
  } = {},
) {
  await mockAuthenticatedSession(page);
  const state: Fixture = {
    providers: options.providers ?? [],
    enforce: options.enforce ?? false,
    verified: false,
    registered: [],
    enforcement: [],
    removed: [],
    updated: [],
  };
  await page.route(
    "**/api/auth/bakery-sso/providers**",
    (route) =>
      options.forbidden
        ? route.fulfill(json({ code: "AUTH_FORBIDDEN" }, 403))
        : route.fulfill(json({
          enforce: state.enforce,
          providers: state.providers,
        })),
  );
  await page.route("**/api/auth/sso/register", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.registered.push(body);
    state.providers.push({
      providerId: String(body.providerId),
      issuer: String(body.issuer),
      domain: String(body.domain),
      domainVerified: false,
      protocol: body.samlConfig ? "saml" : "oidc",
    });
    return route.fulfill(json({ providerId: body.providerId }));
  });
  await page.route(
    "**/api/auth/sso/request-domain-verification",
    (route) =>
      route.fulfill(json({ domainVerificationToken: "txt-token-123" }, 201)),
  );
  await page.route("**/api/auth/sso/verify-domain", (route) => {
    if (options.alreadyVerified) {
      state.providers = state.providers.map((p) => ({
        ...p,
        domainVerified: true,
      }));
      return route.fulfill(json({ code: "DOMAIN_VERIFIED" }, 409));
    }
    if (!state.verified) {
      return route.fulfill(json({ code: "BAD_GATEWAY" }, 502));
    }
    state.providers = state.providers.map((p) => ({
      ...p,
      domainVerified: true,
    }));
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/sso/update-provider", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.updated.push(body);
    return route.fulfill(json({ providerId: body.providerId }));
  });
  await page.route("**/api/auth/sso/delete-provider", (route) => {
    const body = route.request().postDataJSON() as { providerId: string };
    state.removed.push(body.providerId);
    state.providers = state.providers.filter((p) =>
      p.providerId !== body.providerId
    );
    return route.fulfill(json({ success: true }));
  });
  await page.route("**/api/auth/bakery-sso/enforcement", (route) => {
    const body = route.request().postDataJSON() as { enforce: boolean };
    state.enforcement.push(body.enforce);
    state.enforce = body.enforce;
    return route.fulfill(json({ enforce: body.enforce }));
  });
  return state;
}

test.describe("single sign-on settings", () => {
  test("lists providers and shows the empty state", async ({ page }) => {
    await ssoFixture(page);
    await page.goto("/settings/organization/sso");
    await expect(
      page.getByRole("heading", { name: "Single sign-on" }).first(),
    ).toBeVisible();
    await expect(page.getByText("No identity provider yet", { exact: false }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Add OIDC" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Add SAML" })).toBeEnabled();
  });

  test("sits under the Settings breadcrumb", async ({ page, isMobile }) => {
    test.skip(isMobile, "a phone shows the section title, not the trail");
    await ssoFixture(page);
    await page.goto("/settings/organization/sso");
    const trail = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(trail.getByText("Single sign-on")).toBeVisible();
    await expect(trail.getByText("Settings", { exact: true })).toBeVisible();
    await expect(trail.getByText("Organization", { exact: true }))
      .toHaveCount(0);
  });

  test("is reachable from the production settings navigation", async ({ page }) => {
    await ssoFixture(page);
    await page.goto("/settings/appearance");
    await page.locator("main#bakery-main").waitFor();
    // SectionNavigation draws a sidebar and, for a phone, a separate
    // `<details>` menu; only the presentation this viewport shows is
    // reachable by role.
    const menu = page.locator(".bakery-section-navigation__summary");
    if (await menu.isVisible()) await menu.click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Single sign-on" })
      .click();
    await expect(page).toHaveURL(/\/settings\/organization\/sso$/);
    await expect(
      page.getByRole("heading", { name: "Single sign-on" }).first(),
    ).toBeVisible();
    await expect(
      page.locator(
        '.bakery-section-navigation a[aria-current="page"][href="/settings/organization/sso"]',
      ),
    ).toHaveCount(1);
  });

  test("adds an OIDC provider without ever showing the secret again", async ({ page }) => {
    const state = await ssoFixture(page);
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Add OIDC" }).click();
    await expect(page.getByRole("heading", { name: "Add OIDC provider" }))
      .toBeVisible();
    await page.getByLabel("Display name").fill("okta");
    await page.getByLabel("Issuer URL").fill("https://acme.okta.example");
    await page.getByLabel("Client ID").fill("0oa8k2m4n6p");
    await page.getByLabel("Client secret", { exact: true }).fill(
      "super-secret-value",
    );
    await page.getByLabel("Email domain").fill("acme.example");
    await page.getByRole("button", { name: "Save provider" }).click();
    await expect(page.getByRole("button", { name: "okta · OIDC" }))
      .toBeVisible();
    await expect(page.getByText("Not verified", { exact: true })).toBeVisible();
    await expect(page.getByText("Disabled")).toHaveCount(0);
    expect(state.registered).toHaveLength(1);
    expect(
      (state.registered[0].oidcConfig as { clientSecret: string }).clientSecret,
    ).toBe("super-secret-value");
    await expect(page.getByText("super-secret-value")).toHaveCount(0);
  });

  test("adds a SAML provider that always requires signed assertions", async ({ page }) => {
    const state = await ssoFixture(page);
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Add SAML" }).click();
    await page.getByLabel("Display name").fill("entra");
    await page.getByLabel("Identity provider metadata").fill(SAML_METADATA);
    await page.getByLabel("Email domain").fill("acme.example");
    await page.getByRole("button", { name: "Save provider" }).click();
    await expect(page.getByRole("button", { name: "entra · SAML" }))
      .toBeVisible();
    const samlConfig = state.registered[0].samlConfig as {
      wantAssertionsSigned: boolean;
      entryPoint: string;
      idpMetadata: { metadata: string };
    };
    expect(samlConfig.wantAssertionsSigned).toBe(true);
    // The server requires the sign-on URL beside the metadata; the page
    // reads it from the pasted document, preferring the redirect binding.
    expect(samlConfig.entryPoint).toBe("https://idp.acme.example/redirect");
    expect(samlConfig.idpMetadata.metadata).toBe(SAML_METADATA);
  });

  test("refuses SAML metadata that names no sign-on endpoint without calling the server", async ({ page }) => {
    const state = await ssoFixture(page);
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Add SAML" }).click();
    await page.getByLabel("Display name").fill("entra");
    await page.getByLabel("Identity provider metadata").fill(
      "<EntityDescriptor/>",
    );
    await page.getByLabel("Email domain").fill("acme.example");
    await page.getByRole("button", { name: "Save provider" }).click();
    await expect(page.getByText("That is not SAML metadata.", { exact: false }))
      .toBeVisible();
    expect(state.registered).toEqual([]);
  });

  test("shows the TXT record, reports an unverified domain, then verifies", async ({ page }) => {
    const state = await ssoFixture(page, {
      providers: [{
        providerId: "okta",
        issuer: "https://acme.okta.example",
        domain: "acme.example",
        domainVerified: false,
        protocol: "oidc",
      }],
    });
    await page.goto("/settings/organization/sso");
    await expect(page.getByTestId("txt-okta")).toContainText(
      "_bakery-verify-okta.acme.example TXT txt-token-123",
    );
    await page.getByRole("button", { name: "okta · OIDC" }).click();
    await page.getByRole("button", { name: "Check domain" }).click();
    await expect(page.getByText("Not verified yet.", { exact: false }).first())
      .toBeVisible();
    state.verified = true;
    await page.getByRole("button", { name: "Check domain" }).click();
    await expect(page.getByText("Domain verified.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Enabled")).toBeVisible();
  });

  test("a verified domain stops offering the check and the unverified notice", async ({ page }) => {
    const state = await ssoFixture(page, {
      providers: [{
        providerId: "okta",
        issuer: "https://acme.okta.example",
        domain: "acme.example",
        domainVerified: false,
        protocol: "oidc",
      }],
    });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "okta · OIDC" }).click();
    const check = page.getByRole("button", { name: "Check domain" });
    await expect(check).toBeVisible();
    await expect(page.getByText("Not verified yet.", { exact: false }))
      .toHaveCount(1);
    state.verified = true;
    await check.click();
    await expect(page.getByText("Domain verified.")).toBeVisible();
    // The form follows the stored provider: nothing left to check, and the
    // amber "not verified" line is gone while the green banner shows.
    await expect(check).toHaveCount(0);
    await expect(page.getByText("Not verified yet.", { exact: false }))
      .toHaveCount(0);
    await expect(
      page.getByText("The domain could not be checked right now."),
    ).toHaveCount(0);
  });

  test("checking a domain the server already holds as verified is not an error", async ({ page }) => {
    await ssoFixture(page, {
      alreadyVerified: true,
      providers: [{
        providerId: "okta",
        issuer: "https://acme.okta.example",
        domain: "acme.example",
        domainVerified: false,
        protocol: "oidc",
      }],
    });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "okta · OIDC" }).click();
    await page.getByRole("button", { name: "Check domain" }).click();
    await expect(page.getByText("Domain verified.")).toBeVisible();
    await expect(
      page.getByText("The domain could not be checked right now."),
    ).toHaveCount(0);
  });

  test("the add forms have no verification step; a saved provider is verified later", async ({ page }) => {
    await ssoFixture(page);
    await page.goto("/settings/organization/sso");
    for (const protocol of ["SAML", "OIDC"]) {
      await page.getByRole("button", { name: `Add ${protocol}` }).click();
      await expect(
        page.getByRole("heading", { name: `Add ${protocol} provider` }),
      ).toBeVisible();
      await expect(page.getByText("Verify your domain")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Check domain" }))
        .toHaveCount(0);
      await expect(page.getByText("Not verified yet.", { exact: false }))
        .toHaveCount(0);
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  });

  test("a saved provider is verified from the list with its own Check domain", async ({ page }) => {
    const state = await ssoFixture(page, {
      providers: [OKTA_UNVERIFIED],
    });
    await page.goto("/settings/organization/sso");
    const record = page.getByTestId("txt-okta");
    await expect(record).toContainText(
      "_bakery-verify-okta.acme.example TXT txt-token-123",
    );
    const check = record.getByRole("button", { name: "Check domain" });
    await check.click();
    await expect(page.getByText("Not verified yet.", { exact: false }))
      .toHaveCount(1);
    state.verified = true;
    await check.click();
    await expect(page.getByText("Domain verified.")).toBeVisible();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    await expect(page.getByTestId("txt-okta")).toHaveCount(0);
  });

  test("every unverified provider shows its own record and check", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED, ENTRA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await expect(page.getByTestId("txt-okta")).toContainText(
      "_bakery-verify-okta.acme.example TXT",
    );
    await expect(page.getByTestId("txt-entra")).toContainText(
      "_bakery-verify-entra.corp.example TXT",
    );
    await expect(
      page.getByRole("button", { name: "Check domain for okta" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Check domain for entra" }),
    ).toBeVisible();
  });

  test("each provider row has an Edit button that names the provider", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Edit okta" }).click();
    await expect(page.getByRole("heading", { name: "Edit okta" }))
      .toBeVisible();
  });

  test("an unverified provider reads Not verified and a verified one Enabled", async ({ page }) => {
    await ssoFixture(page, {
      providers: [OKTA_UNVERIFIED, {
        ...ENTRA_UNVERIFIED,
        domainVerified: true,
      }],
    });
    await page.goto("/settings/organization/sso");
    await expect(page.getByText("Not verified", { exact: true })).toHaveCount(
      1,
    );
    await expect(page.getByText("Enabled", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Disabled")).toHaveCount(0);
  });

  test("Require SSO waits for a verified provider and says why", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    const requireSso = page.getByLabel("Require SSO for all members");
    await expect(requireSso).toBeDisabled();
    await expect(
      page.getByText("verify its domain before requiring SSO", {
        exact: false,
      }),
    ).toBeVisible();
  });

  test("Require SSO is on offer once a provider is verified, and stays on offer while enforced", async ({ page }) => {
    await ssoFixture(page, {
      providers: [{ ...OKTA_UNVERIFIED, domainVerified: true }],
    });
    await page.goto("/settings/organization/sso");
    await expect(page.getByLabel("Require SSO for all members")).toBeEnabled();
    await expect(
      page.getByText("verify its domain before requiring SSO", {
        exact: false,
      }),
    ).toHaveCount(0);
  });

  test("an enforced organization can always turn Require SSO off", async ({ page }) => {
    await ssoFixture(page, { enforce: true, providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await expect(page.getByLabel("Require SSO for all members")).toBeEnabled();
  });

  test("removing a provider asks first, and Cancel keeps it", async ({ page }) => {
    const state = await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Edit okta" }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove okta?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "People at acme.example can no longer sign in through this provider.",
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.removed).toEqual([]);
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await dialog.getByRole("button", { name: "Remove provider" }).click();
    await expect(page.getByText("Provider removed.")).toBeVisible();
    expect(state.removed).toEqual(["okta"]);
  });

  test("the Edit form says a domain is not verified once, not twice", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Edit okta" }).click();
    await page.getByRole("button", { name: "Check domain" }).click();
    // The check found no record: the form's own line says so; the page banner
    // does not repeat the sentence.
    await expect(page.getByText("Not verified yet.", { exact: false }))
      .toHaveCount(1);
  });

  test("edits a provider, requires SSO through the switch and removes it", async ({ page }) => {
    const state = await ssoFixture(page, {
      providers: [{
        providerId: "okta",
        issuer: "https://acme.okta.example",
        domain: "acme.example",
        domainVerified: true,
        protocol: "oidc",
      }],
    });
    await page.goto("/settings/organization/sso");
    // Verified and off: the box says what turning it on does.
    await expect(
      page.getByText("Everyone in this organization must sign in through", {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByLabel("Require SSO for all members").click();
    // Turning it on asks first, naming the provider; the switch has not moved.
    const confirm = page.getByRole("alertdialog", {
      name: "Require single sign-on for everyone?",
    });
    await expect(confirm).toContainText("through okta");
    await shot(page, "sso-require-confirm");
    await expect(page.getByLabel("Require SSO for all members"))
      .not.toBeChecked();
    expect(state.enforcement).toEqual([]);
    await confirm.getByRole("button", { name: "Require SSO" }).click();
    await expect.poll(() => state.enforcement).toEqual([true]);
    // Required: the note says administrators can still sign in with a password
    // or passkey. The confirmation closes with the same sentence, so wait for it
    // to be gone before looking for the note.
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(
      page.getByText(
        "Organization administrators who still have a password or passkey",
      ).filter({ visible: true }),
    ).toBeVisible();
    await shot(page, "sso-require-on");
    await expect(page.getByLabel("Require SSO for all members"))
      .toBeChecked();
    await page.getByRole("button", { name: "okta · OIDC" }).click();
    await page.getByLabel("Email domain").fill("acme.test");
    await page.getByRole("button", { name: "Save provider" }).click();
    await expect(page.getByText("Provider updated.")).toBeVisible();
    expect(state.updated).toEqual([{
      providerId: "okta",
      domain: "acme.test",
    }]);
    await page.getByRole("button", { name: "okta · OIDC" }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Remove okta?" })
      .getByRole("button", { name: "Remove provider" }).click();
    await expect(page.getByText("Provider removed.")).toBeVisible();
    expect(state.removed).toEqual(["okta"]);
  });

  const VERIFIED = { ...OKTA_UNVERIFIED, domainVerified: true };
  const REQUIRE = "Require SSO for all members";
  const dialogName = "Require single sign-on for everyone?";

  test("Cancel and Escape on the Require SSO question leave it off and return focus to the switch", async ({ page }) => {
    const state = await ssoFixture(page, { providers: [VERIFIED] });
    await page.goto("/settings/organization/sso");
    const switchControl = page.getByLabel(REQUIRE);
    await switchControl.click();
    const confirm = page.getByRole("alertdialog", { name: dialogName });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(switchControl).toBeFocused();
    await expect(switchControl).not.toBeChecked();
    await switchControl.click();
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(switchControl).toBeFocused();
    await expect(switchControl).not.toBeChecked();
    expect(state.enforcement).toEqual([]);
  });

  test("turning Require SSO off asks nothing", async ({ page }) => {
    const state = await ssoFixture(page, {
      enforce: true,
      providers: [VERIFIED],
    });
    await page.goto("/settings/organization/sso");
    await page.getByLabel(REQUIRE).click();
    await expect.poll(() => state.enforcement).toEqual([false]);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByLabel(REQUIRE)).not.toBeChecked();
  });

  test("the Require SSO question names every verified provider as one of yours", async ({ page }) => {
    await ssoFixture(page, {
      providers: [
        VERIFIED,
        { ...VERIFIED, providerId: "entra", domain: "acme.test" },
      ],
    });
    await page.goto("/settings/organization/sso");
    await page.getByLabel(REQUIRE).click();
    await expect(page.getByRole("alertdialog", { name: dialogName }))
      .toContainText("through one of your providers");
  });

  test("a failed Require SSO request leaves it off with the page's error notice", async ({ page }) => {
    await ssoFixture(page, { providers: [VERIFIED] });
    await page.route(
      "**/api/auth/bakery-sso/enforcement",
      (route) => route.fulfill(json({ code: "INTERNAL_ERROR" }, 500)),
    );
    await page.goto("/settings/organization/sso");
    await page.getByLabel(REQUIRE).click();
    await page.getByRole("alertdialog", { name: dialogName })
      .getByRole("button", { name: "Require SSO" }).click();
    await expect(
      page.getByText("Single sign-on enforcement could not be changed."),
    ).toBeVisible();
    await expect(page.getByLabel(REQUIRE)).not.toBeChecked();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByLabel(REQUIRE)).toBeFocused();
  });

  test("the Require SSO box is neutral until it is on, and a disabled switch reads as disabled", async ({ page }) => {
    const state = await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    const box = page.locator(".ui-sso-settings__enforcement");
    const background = () =>
      box.evaluate((node) => getComputedStyle(node).backgroundColor);
    const tokenColor = (token: string) =>
      page.evaluate((name) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }, token);
    // No verified provider: neutral surface, and the switch and its label are disabled.
    await expect(page.getByLabel(REQUIRE)).toBeDisabled();
    await shot(page, "sso-require-unavailable");
    expect(await background()).toBe(await tokenColor("--color-surface"));
    const label = page.locator(".ui-switch").filter({ hasText: REQUIRE });
    // The label is the muted text colour, so it can be read; the track stays disabled.
    expect(await label.evaluate((node) => getComputedStyle(node).color))
      .toBe(await tokenColor("--color-fg-muted"));
    expect(
      await page.getByLabel(REQUIRE).evaluate((node) =>
        getComputedStyle(node, "::before").backgroundColor
      ),
    ).toBe(await tokenColor("--color-fg-disabled"));
    // Verified, off: still neutral, and the label is back to the normal colour.
    state.providers = [VERIFIED];
    await page.reload();
    await expect(page.getByLabel(REQUIRE)).toBeEnabled();
    await shot(page, "sso-require-off");
    expect(await background()).toBe(await tokenColor("--color-surface"));
    expect(await label.evaluate((node) => getComputedStyle(node).color))
      .not.toBe(await tokenColor("--color-fg-muted"));
    // On: the warning tone.
    await page.getByLabel(REQUIRE).click();
    await page.getByRole("alertdialog", { name: dialogName })
      .getByRole("button", { name: "Require SSO" }).click();
    await expect(page.getByLabel(REQUIRE)).toBeChecked();
    expect(await background()).toBe(
      await tokenColor("--color-status-warning-surface"),
    );
  });

  test("editing an OIDC provider says a blank client ID or secret keeps the stored one", async ({ page }) => {
    await ssoFixture(page, { providers: [VERIFIED] });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "okta · OIDC" }).click();
    const secretHint = page.getByText(
      "Leave blank to keep the current secret.",
    );
    const idHint = page.getByText("Leave blank to keep the current client ID.");
    await expect(secretHint).toBeVisible();
    await expect(idHint).toBeVisible();
    await shot(page, "sso-edit-oidc-keep-secret");
    // The hints are tied to their inputs.
    await expect(page.getByLabel("Client secret", { exact: true }))
      .toHaveAccessibleDescription("Leave blank to keep the current secret.");
    await expect(page.getByLabel("Client ID"))
      .toHaveAccessibleDescription(
        "Leave blank to keep the current client ID.",
      );
    // Adding a provider has no such helper: both fields are required there.
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Add OIDC" }).click();
    await expect(secretHint).toHaveCount(0);
    await expect(idHint).toHaveCount(0);
  });

  test("sits in the same column and uses the same buttons as the SCIM page", async ({ page, isMobile }) => {
    await ssoFixture(page, { providers: [VERIFIED] });
    await page.goto("/settings/organization/sso");
    await expect(page.getByRole("button", { name: "okta · OIDC" }))
      .toBeVisible();
    await shot(page, "sso-list");
    const column = (await page.getByTestId("organization-sso").boundingBox())!;
    // The settings column every settings page shares: 760 px on a wide screen.
    if (!isMobile) expect(Math.round(column.width)).toBe(760);
    // Every button on the page is the default Button inside a settings page: 44 px.
    const buttons = page.getByTestId("organization-sso").locator(".ui-button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const box = await buttons.nth(index).boundingBox();
      if (box) expect(Math.round(box.height)).toBe(44);
    }
  });

  test("a refusal clears the page to the forbidden notice", async ({ page }) => {
    await ssoFixture(page, { forbidden: true });
    await page.goto("/settings/organization/sso");
    await expect(
      page.getByText(
        "Only organization administrators can manage single sign-on.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  test("a bearer-style refusal says a browser session is needed", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.route(
      "**/api/auth/bakery-sso/providers**",
      (route) => route.fulfill(json({ code: "SESSION_REQUIRED" }, 403)),
    );
    await page.goto("/settings/organization/sso");
    await expect(
      page.getByText("A browser session is required to manage single sign-on."),
    ).toBeVisible();
  });
});
