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
  /** Bodies of every delete-provider request, in order. */
  removeRequests: Record<string, unknown>[];
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

const OKTA_VERIFIED = { ...OKTA_UNVERIFIED, domainVerified: true } as const;
const ENTRA_VERIFIED = { ...ENTRA_UNVERIFIED, domainVerified: true } as const;

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
    removeRequests: [],
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
    const body = route.request().postDataJSON() as {
      providerId: string;
      stopRequiringSso?: boolean;
    };
    state.removeRequests.push(body);
    const provider = state.providers.find((p) =>
      p.providerId === body.providerId
    );
    if (!provider) {
      return route.fulfill(json({ code: "RESOURCE_NOT_FOUND" }, 404));
    }
    // As the server does: removing the only verified provider while SSO is
    // required is refused unless the same request says SSO should stop being
    // required, and then both changes happen together.
    const locksOut = state.enforce && provider.domainVerified &&
      !state.providers.some((p) =>
        p.providerId !== body.providerId && p.domainVerified
      );
    if (locksOut && body.stopRequiringSso !== true) {
      return route.fulfill(json({ code: "SSO_LAST_PROVIDER_REQUIRED" }, 409));
    }
    if (locksOut) state.enforce = false;
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
    await expect(page.getByText("No sign-in provider yet")).toBeVisible();
    // One way in: a single "Add provider" action, not a choice of protocols.
    await expect(page.getByRole("button", { name: "Add provider" }))
      .toHaveCount(1);
    await expect(page.getByRole("button", { name: "Add provider" }))
      .toBeEnabled();
    await shot(page, "sso-empty");
  });

  test("the list has exactly one primary button, Add provider", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await expect(page.getByRole("button", { name: "Add provider" }))
      .toHaveCount(1);
    await expect(page.getByRole("button", { name: "Add SAML" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add OIDC" })).toHaveCount(0);
    // The row names the email domain and the next step, not the issuer URL.
    const row = page.getByRole("listitem").filter({ hasText: "okta" });
    await expect(row).toContainText("acme.example");
    await expect(row).toContainText("Verify the domain below to turn this on");
    await expect(row).not.toContainText("https://acme.okta.example");
    await shot(page, "sso-provider-awaiting-domain");
  });

  test("every add-form field has help text tied to its input", async ({ page }) => {
    await ssoFixture(page);
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Add provider" }).click();
    await expect(page.getByRole("radio", { name: "OpenID Connect" }))
      .toBeChecked();
    await shot(page, "sso-add-provider");
    await expect(
      page.getByText(
        "Use whichever your identity provider offers. If it offers both, OpenID Connect is simpler to set up.",
      ),
    ).toBeVisible();
    for (
      const [label, help] of [
        ["Provider name", "Shown to members on the sign-in page"],
        ["Issuer URL", "The address of your identity provider"],
        ["Client ID", "Copy this from the application you created"],
        ["Client secret", "Copy this from the same place."],
        ["Email domain", "Members whose email ends in this domain"],
      ] as const
    ) {
      await expect(page.getByLabel(label, { exact: true }))
        .toHaveAccessibleDescription(new RegExp(help));
    }
    await page.getByRole("radio", { name: "SAML" }).check();
    await expect(page.getByLabel("Identity provider metadata"))
      .toHaveAccessibleDescription(/Paste the metadata XML from your identity/);
    await shot(page, "sso-add-saml");
  });

  test("a check that finds no record says what happened and offers Check again", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    const record = page.getByTestId("txt-okta");
    await expect(record.getByText("TXT", { exact: true })).toBeVisible();
    await expect(record.getByRole("button", { name: "Copy type" }))
      .toBeVisible();
    await expect(record.getByRole("button", { name: "Copy host" }))
      .toBeVisible();
    await expect(record.getByRole("button", { name: "Copy value" }))
      .toBeVisible();
    await record.getByRole("button", { name: "Check domain" }).click();
    const failed = record.getByTestId("sso-check-failed");
    await expect(failed).toContainText(
      "We could not find the record yet. DNS changes can take up to an hour.",
    );
    await expect(failed.getByRole("button", { name: "Check again" }))
      .toBeVisible();
    await shot(page, "sso-check-failed");
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
    await page.getByRole("button", { name: "Add provider" }).click();
    await expect(page.getByRole("heading", { name: "Add provider" }))
      .toBeVisible();
    await expect(page.getByRole("radio", { name: "OpenID Connect" }))
      .toBeChecked();
    await page.getByLabel("Provider name").fill("okta");
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
    await page.getByRole("button", { name: "Add provider" }).click();
    await page.getByRole("radio", { name: "SAML" }).check();
    await page.getByLabel("Provider name").fill("entra");
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
    await page.getByRole("button", { name: "Add provider" }).click();
    await page.getByRole("radio", { name: "SAML" }).check();
    await page.getByLabel("Provider name").fill("entra");
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
    await expect(page.getByTestId("sso-txt-host")).toHaveText(
      "_bakery-verify-okta.acme.example",
    );
    await expect(page.getByTestId("sso-txt-value")).toHaveText("txt-token-123");
    await page.getByRole("button", { name: "okta · OIDC" }).click();
    await page.getByRole("button", { name: "Check domain" }).click();
    await expect(
      page.getByText("We could not find the record yet.", { exact: false })
        .first(),
    ).toBeVisible();
    state.verified = true;
    await page.getByRole("button", { name: "Check again" }).click();
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
    const check = page.getByRole("button", { name: /Check (domain|again)/ });
    await expect(check).toBeVisible();
    // Nothing has been checked yet, so nothing says the record is missing.
    await expect(
      page.getByText("We could not find the record yet.", { exact: false }),
    ).toHaveCount(0);
    state.verified = true;
    await check.click();
    await expect(page.getByText("Domain verified.")).toBeVisible();
    // The form follows the stored provider: nothing left to check, and the
    // "record not found" notice is gone while the green banner shows.
    await expect(check).toHaveCount(0);
    await expect(
      page.getByText("We could not find the record yet.", { exact: false }),
    ).toHaveCount(0);
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
    for (const protocol of ["SAML", "OpenID Connect"]) {
      await page.getByRole("button", { name: "Add provider" }).click();
      await expect(page.getByRole("heading", { name: "Add provider" }))
        .toBeVisible();
      await page.getByRole("radio", { name: protocol }).check();
      await expect(page.getByText("Verify your domain")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Check domain" }))
        .toHaveCount(0);
      await expect(
        page.getByText("We could not find the record yet.", { exact: false }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  });

  test("a saved provider is verified from the list with its own Check domain", async ({ page }) => {
    const state = await ssoFixture(page, {
      providers: [OKTA_UNVERIFIED],
    });
    await page.goto("/settings/organization/sso");
    const record = page.getByTestId("txt-okta");
    await expect(record.getByTestId("sso-txt-host")).toHaveText(
      "_bakery-verify-okta.acme.example",
    );
    await expect(record.getByTestId("sso-txt-value")).toHaveText(
      "txt-token-123",
    );
    const check = record.getByRole("button", { name: /Check (domain|again)/ });
    await check.click();
    await expect(
      page.getByText("We could not find the record yet.", { exact: false }),
    ).toHaveCount(1);
    state.verified = true;
    await check.click();
    await expect(page.getByText("Domain verified.")).toBeVisible();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    await expect(page.getByTestId("txt-okta")).toHaveCount(0);
  });

  test("every unverified provider shows its own record and check", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED, ENTRA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await expect(page.getByTestId("txt-okta").getByTestId("sso-txt-host"))
      .toHaveText("_bakery-verify-okta.acme.example");
    await expect(page.getByTestId("txt-entra").getByTestId("sso-txt-host"))
      .toHaveText("_bakery-verify-entra.corp.example");
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

  test("removing a provider asks first, says what changes, and Cancel keeps it", async ({ page }) => {
    const state = await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    const remove = page.getByRole("button", {
      name: "Remove okta",
      exact: true,
    });
    await remove.click();
    const dialog = page.getByRole("alertdialog", { name: "Remove okta?" });
    await expect(dialog).toBeVisible();
    // Never verified: nobody signs in through it, so nothing changes for members.
    await expect(dialog).toContainText("okta was never turned on");
    await shot(page, "sso-remove-confirm-never-on", [], { only: "desktop" });
    await expect(dialog).toContainText(
      "This is recorded in the audit log and cannot be undone.",
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(remove).toBeFocused();
    expect(state.removeRequests).toEqual([]);
    await remove.click();
    await dialog.getByRole("button", { name: "Remove provider" }).click();
    await expect(page.getByText("Removed okta.")).toBeVisible();
    expect(state.removeRequests).toEqual([{ providerId: "okta" }]);
    // The list is empty: focus lands on Add provider.
    await expect(page.locator("#sso-add-provider")).toBeFocused();
  });

  test("SSO not required: the confirmation tells members how they sign in afterwards", async ({ page }) => {
    const state = await ssoFixture(page, { providers: [OKTA_VERIFIED] });
    await page.goto("/settings/organization/sso");
    await expect(page.getByRole("button", { name: "Remove okta", exact: true }))
      .toBeVisible();
    await shot(page, "sso-remove-list");
    await page.getByRole("button", { name: "Remove okta", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", { name: "Remove okta?" });
    await expect(dialog).toContainText(
      "People at acme.example will no longer be able to sign in through this provider.",
    );
    await shot(page, "sso-remove-confirm-plain");
    await expect(dialog).toContainText(
      "They stay members and keep their roles.",
    );
    await expect(dialog).toContainText(
      "a password reset link from whoever runs this Bakery server",
    );
    await expect(dialog).toContainText(
      "People signed in now stay signed in until their session ends.",
    );
    await expect(dialog).toContainText(
      "Adding the provider again means verifying acme.example again.",
    );
    await expect(dialog).not.toContainText("stop requiring");
    await dialog.getByRole("button", { name: "Remove provider" }).click();
    await expect(page.getByText("Removed okta.")).toBeVisible();
    expect(state.removeRequests).toEqual([{ providerId: "okta" }]);
  });

  test("SSO required and another verified provider remains: removal is plain and SSO stays required", async ({ page }) => {
    const state = await ssoFixture(page, {
      enforce: true,
      providers: [OKTA_VERIFIED, ENTRA_VERIFIED],
    });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Remove okta", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", { name: "Remove okta?" });
    await expect(dialog).toContainText(
      "SSO is still required, so they cannot sign in at all until another provider covers acme.example.",
    );
    await shot(page, "sso-remove-confirm-still-required");
    await dialog.getByRole("button", { name: "Remove provider" }).click();
    await expect(page.getByText("Removed okta.")).toBeVisible();
    expect(state.removeRequests).toEqual([{ providerId: "okta" }]);
    expect(state.enforce).toBe(true);
    await expect(page.getByLabel("Require SSO for all members")).toBeChecked();
  });

  test("the only verified provider while SSO is required: one dialog removes it and stops requiring SSO", async ({ page }) => {
    const state = await ssoFixture(page, {
      enforce: true,
      providers: [OKTA_VERIFIED],
    });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Remove okta", exact: true })
      .click();
    // The title, the warning and the button all say both things happen.
    const dialog = page.getByRole("alertdialog", {
      name: "Remove okta and stop requiring SSO?",
    });
    await expect(dialog).toContainText(
      "This is your only provider, and SSO is required.",
    );
    await expect(dialog).toContainText(
      "Both changes are recorded in the audit log.",
    );
    await shot(page, "sso-remove-only-provider");
    await dialog.getByRole("button", { name: "Remove and stop requiring SSO" })
      .click();
    await expect(
      page.getByText("Removed okta. Single sign-on is no longer required."),
    ).toBeVisible();
    expect(state.removeRequests).toEqual([{
      providerId: "okta",
      stopRequiringSso: true,
    }]);
    expect(state.enforce).toBe(false);
    await expect(page.getByLabel("Require SSO for all members"))
      .not.toBeChecked();
    await shot(page, "sso-remove-after-last");
  });

  test("an out-of-date page: the refusal reloads the dialog into the new situation and nothing is removed until it is confirmed again", async ({ page }) => {
    const state = await ssoFixture(page, {
      enforce: true,
      providers: [OKTA_VERIFIED, ENTRA_VERIFIED],
    });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Remove okta", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", { name: "Remove okta?" });
    await expect(dialog).toBeVisible();
    // Another administrator removes the other provider while this dialog is open.
    state.providers = state.providers.filter((p) => p.providerId === "okta");
    await dialog.getByRole("button", { name: "Remove provider" }).click();
    await expect(page.getByRole("alertdialog", {
      name: "Remove okta and stop requiring SSO?",
    })).toBeVisible();
    await expect(page.getByText("This page was out of date.")).toBeVisible();
    await shot(page, "sso-remove-out-of-date", [], { only: "desktop" });
    expect(state.removed).toEqual([]);
    expect(state.enforce).toBe(true);
    await page.getByRole("button", { name: "Remove and stop requiring SSO" })
      .click();
    await expect(page.getByText("Removed okta. Single sign-on")).toBeVisible();
    expect(state.removeRequests).toEqual([
      { providerId: "okta" },
      { providerId: "okta", stopRequiringSso: true },
    ]);
  });

  test("a stale row: the domain was verified while the dialog was open, and Confirm then sends the flag the dialog now shows", async ({ page }) => {
    const state = await ssoFixture(page, {
      enforce: true,
      providers: [ENTRA_VERIFIED, OKTA_UNVERIFIED],
    });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Remove okta", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", { name: "Remove okta?" });
    await expect(dialog).toContainText("okta was never turned on");
    // Meanwhile another administrator removes entra and okta's domain gets verified.
    state.providers = [OKTA_VERIFIED];
    await dialog.getByRole("button", { name: "Remove provider" }).click();
    const stop = page.getByRole("alertdialog", {
      name: "Remove okta and stop requiring SSO?",
    });
    await expect(stop).toBeVisible();
    await expect(page.getByText("This page was out of date.")).toBeVisible();
    // Confirm again: the request carries the flag the refreshed dialog shows.
    await stop.getByRole("button", { name: "Remove and stop requiring SSO" })
      .click();
    await expect(page.getByText("Removed okta. Single sign-on")).toBeVisible();
    expect(state.removeRequests).toEqual([
      { providerId: "okta" },
      { providerId: "okta", stopRequiringSso: true },
    ]);
    expect(state.enforce).toBe(false);
  });

  test("a provider someone else already removed says so and the list reloads", async ({ page }) => {
    const state = await ssoFixture(page, { providers: [OKTA_VERIFIED] });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Remove okta", exact: true })
      .click();
    state.providers = [];
    await page.getByRole("alertdialog", { name: "Remove okta?" })
      .getByRole("button", { name: "Remove provider" }).click();
    await expect(page.getByText("okta was already removed.")).toBeVisible();
    await shot(page, "sso-remove-already-removed", [], { only: "desktop" });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByText("No sign-in provider yet")).toBeVisible();
  });

  test("the Edit form no longer holds the Remove action", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Edit okta" }).click();
    await expect(page.getByRole("button", { name: "Save provider" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  });

  test("the Edit form says the record was not found once, not twice", async ({ page }) => {
    await ssoFixture(page, { providers: [OKTA_UNVERIFIED] });
    await page.goto("/settings/organization/sso");
    await page.getByRole("button", { name: "Edit okta" }).click();
    await page.getByRole("button", { name: "Check domain" }).click();
    // The check found no record: the record's own notice says so; the page
    // banner does not repeat the sentence.
    await expect(
      page.getByText("We could not find the record yet.", { exact: false }),
    ).toHaveCount(1);
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
    // Required and this is the only verified provider (the domain was just
    // changed, and the stub keeps it verified): removing it also ends the requirement.
    await page.getByRole("button", { name: "Remove okta", exact: true })
      .click();
    await page.getByRole("alertdialog", {
      name: "Remove okta and stop requiring SSO?",
    }).getByRole("button", { name: "Remove and stop requiring SSO" }).click();
    await expect(page.getByText("Removed okta. Single sign-on")).toBeVisible();
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
      .toHaveAccessibleDescription(
        /Leave blank to keep the current secret\.$/,
      );
    await expect(page.getByLabel("Client ID"))
      .toHaveAccessibleDescription(
        /Leave blank to keep the current client ID\.$/,
      );
    // Adding a provider has no such helper: both fields are required there.
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Add provider" }).click();
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
