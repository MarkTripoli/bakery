import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

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

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function ssoFixture(
  page: Page,
  options: Partial<Pick<Fixture, "providers" | "enforce">> & {
    forbidden?: boolean;
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
    await expect(page.getByText("Disabled")).toBeVisible();
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
    await expect(
      page.getByText("organization administrators who still hold a password", {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByLabel("Require SSO for all members").click();
    await expect.poll(() => state.enforcement).toEqual([true]);
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
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Provider removed.")).toBeVisible();
    expect(state.removed).toEqual(["okta"]);
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
