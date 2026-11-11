import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect as baseExpect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";

/**
 * Browser proof of the single sign-on settings page against the real API: a
 * Deno child (tests/helpers/sso-settings-server.child.ts) runs the real
 * Bakery app on a real test database with a real local OpenID Provider and a
 * real TXT DNS server. The page's requests are forwarded to it unchanged,
 * with the seeded person's session cookie and the API's own Origin; nothing
 * is stubbed with `page.route` fulfilment. The sign-in and break-glass
 * semantics are asked of the same server through its control URL, because a
 * password sign-in is an API call, not a page.
 *
 * Needs a migrated test database (`DATABASE_URL`, `BAKERY_APP_DATABASE_URL`,
 * `BAKERY_ENV=test`) and `deno`. It seeds its own Admin, so it runs alone in
 * the `desktop-real-sso` project when the operator sets both
 * `BAKERY_REAL_API=1` and `BAKERY_REAL_API_SSO=1`; it is never CI-selected.
 * `BAKERY_EVIDENCE_VIDEO=1` records video; `BAKERY_EVIDENCE_DIR=<dir>` saves a
 * desktop (1440x900) and a phone (390x844) screenshot of each key state there.
 */
const enabled = process.env.BAKERY_REAL_API === "1" &&
  process.env.BAKERY_REAL_API_SSO === "1";
const SSO_PAGE = "/settings/organization/sso";
const SCIM_PAGE = "/settings/scim";
const SAML_PROVIDER = "saml-acme";
const SAML_DOMAIN = "saml.example.test";
const PROVIDER = "oidc-acme";
const DOMAIN = "example.test";
const TXT_NAME = `_bakery-verify-${PROVIDER}.${DOMAIN}`;
const REQUIRE_SSO = "Require SSO for all members";

type Server = {
  apiUrl: string;
  controlUrl: string;
  publicOrigin: string;
  adminCookie: string;
  developerCookie: string;
  organizationId: string;
  developerEmail: string;
  samlMetadata: string;
  issuer: { issuer: string; clientId: string; clientSecret: string };
};

type State = {
  stored: {
    providerId: string;
    organizationId: string;
    domain: string;
    issuer: string;
    domainVerified: boolean;
  }[];
  overview: {
    enforce: boolean;
    providers: { providerId: string; protocol: string }[];
  };
};

type PasswordSignIn = { status: number; code: string | null; sessions: number };

test.use({ video: process.env.BAKERY_EVIDENCE_VIDEO === "1" ? "on" : "off" });

/**
 * Every page here is a hard load of the unbundled Vite dev server followed by
 * a read through the real API, which takes several seconds on the shared,
 * heavily loaded host (load average above 30 on 12 cores), more than the
 * default 5 s `expect` timeout. The assertions are unchanged; they wait
 * longer, and an assertion that holds returns at once.
 */
const expect = baseExpect.configure({ timeout: 20_000 });

const evidenceDirectory = process.env.BAKERY_EVIDENCE_DIR;
const EVIDENCE_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

/**
 * Saves `<name>--desktop.png` and `<name>--mobile.png` of the page as it is,
 * when `BAKERY_EVIDENCE_DIR` is set; otherwise does nothing. `mask` hides
 * what must not be published, such as the one-time SCIM credential.
 */
async function shot(page: Page, name: string, mask: Locator[] = []) {
  if (!evidenceDirectory) return;
  const original = page.viewportSize();
  for (const { name: viewport, ...size } of EVIDENCE_VIEWPORTS) {
    await page.setViewportSize(size);
    // One frame, so the responsive layout has settled at the new size.
    await page.evaluate(() =>
      new Promise((resolve) => requestAnimationFrame(resolve))
    );
    await page.screenshot({
      path: join(evidenceDirectory, `${name}--${viewport}.png`),
      fullPage: true,
      mask,
      maskColor: "#9ca3af",
    });
  }
  if (original) await page.setViewportSize(original);
}

test.describe("single sign-on settings against the real API", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 and BAKERY_REAL_API_SSO=1 with a test database for the child API",
  );

  let child: ChildProcess;
  let server: Server;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const root = new URL("../../../", import.meta.url);
    child = spawn("deno", [
      "run",
      "--allow-all",
      "--config",
      fileURLToPath(new URL("deno.json", root)),
      fileURLToPath(
        new URL("tests/helpers/sso-settings-server.child.ts", root),
      ),
    ], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
    const lines = createInterface({ input: child.stdout! });
    server = await new Promise<Server>((resolve, reject) => {
      child.once("exit", (code) => reject(new Error(`child exited ${code}`)));
      lines.on("line", (line) => {
        if (line.startsWith("{")) resolve(JSON.parse(line) as Server);
      });
    });
  });

  // The page keeps polling the API through `forward`; a request still in
  // route.fetch when a test ends otherwise fails it with "Test ended".
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test.afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin?.end();
    await exited;
  });

  const control = async <T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> => {
    const response = await fetch(
      `${server.controlUrl}${path}`,
      body === undefined
        ? undefined
        : { method: "POST", body: JSON.stringify(body) },
    );
    expect(response.ok, path).toBe(true);
    return await response.json() as T;
  };

  /** Bakery's API through the child, as the person owning `cookie`; never mocked. */
  async function connect(page: Page, baseURL: string, cookie: string) {
    const forward = async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await route.fetch({
        url: `${server.apiUrl}${url.pathname}${url.search}`,
        // The API's CSRF check expects its own public origin.
        headers: {
          ...request.headers(),
          cookie,
          ...(request.headers().origin ? { origin: server.publicOrigin } : {}),
        },
        maxRedirects: 0,
      });
      await route.fulfill({ response });
    };
    await page.route(`${baseURL}/v1/**`, forward);
    await page.route(`${baseURL}/api/**`, forward);
  }

  async function openAsAdmin(page: Page, baseURL: string | undefined) {
    await connect(page, baseURL!, server.adminCookie);
    await page.goto(SSO_PAGE);
    await expect(
      page.getByRole("heading", { name: "Single sign-on" }).first(),
    )
      .toBeVisible();
  }

  const passwordSignIn = (who: "admin" | "developer") =>
    control<PasswordSignIn>("/password-sign-in", { who });

  test.beforeEach(() => {
    test.setTimeout(90_000);
  });

  test("an administrator opens the production route and sees the empty state the backend reports", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    await expect(page.getByText("No identity provider yet", { exact: false }))
      .toBeVisible();
    const state = await control<State>("/state");
    expect(state.stored).toEqual([]);
    expect(state.overview).toEqual({ enforce: false, providers: [] });
    await shot(page, "sso-empty");
  });

  test("registers an OIDC provider the backend stores and the page keeps after a reload", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    await page.getByRole("button", { name: "Add OIDC" }).click();
    await page.getByLabel("Display name").fill(PROVIDER);
    await page.getByLabel("Issuer URL").fill(server.issuer.issuer);
    await page.getByLabel("Client ID").fill(server.issuer.clientId);
    await page.getByLabel("Client secret", { exact: true }).fill(
      server.issuer.clientSecret,
    );
    await page.getByLabel("Email domain").fill(DOMAIN);
    await shot(page, "sso-add-oidc");
    await page.getByRole("button", { name: "Save provider" }).click();
    await expect(page.getByRole("button", { name: `${PROVIDER} · OIDC` }))
      .toBeVisible();
    await expect(page.getByText("Disabled")).toBeVisible();
    await expect(page.getByTestId(`txt-${PROVIDER}`)).toBeVisible();
    await expect(page.getByText(server.issuer.clientSecret)).toHaveCount(0);
    await shot(page, "sso-provider-awaiting-domain");

    const state = await control<State>("/state");
    expect(state.stored).toEqual([{
      providerId: PROVIDER,
      organizationId: server.organizationId,
      domain: DOMAIN,
      issuer: server.issuer.issuer,
      domainVerified: false,
    }]);
    // The secret is stored, never echoed back to the page.
    expect(JSON.stringify(state.overview)).not.toContain(
      server.issuer.clientSecret,
    );

    await page.reload();
    await expect(page.getByRole("button", { name: `${PROVIDER} · OIDC` }))
      .toBeVisible();
  });

  test("verifies the domain through a real DNS lookup, refusing until the record exists", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    const record = page.getByTestId(`txt-${PROVIDER}`);
    await expect(record).toContainText(`${TXT_NAME} TXT `);
    const token = (await record.textContent())!.split(" TXT ").at(-1)!.trim();
    expect(token).not.toBe("");

    await page.getByRole("button", { name: `${PROVIDER} · OIDC` }).click();
    const check = page.getByRole("button", { name: "Check domain" });
    const verifyAnswer = () =>
      page.waitForResponse((response) =>
        response.url().endsWith("/api/auth/sso/verify-domain")
      );

    // No TXT record is published yet: the server's own lookup finds nothing.
    // Wait for that answer itself; the form's static "Not verified yet." line
    // is on screen before any check has been made.
    const refused = verifyAnswer();
    await check.click();
    expect((await refused).status()).toBe(502);
    expect((await control<State>("/state")).stored[0].domainVerified).toBe(
      false,
    );

    await control("/dns", { name: TXT_NAME, value: token });
    const accepted = verifyAnswer();
    await check.click();
    expect((await accepted).status()).toBe(204);
    await expect(page.getByText("Domain verified.")).toBeVisible();
    // Verified: the form follows the stored provider and offers no further
    // check, so nothing here can ask the server about it a second time.
    await expect(check).toHaveCount(0);
    await expect(page.getByText("Not verified yet.", { exact: false }))
      .toHaveCount(0);
    await expect(
      page.getByText("The domain could not be checked right now."),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Enabled")).toBeVisible();
    expect((await control<State>("/state")).stored[0].domainVerified).toBe(
      true,
    );
    await shot(page, "sso-domain-verified");
  });

  test("enforcement refuses a member's password, keeps break-glass and SSO working, and lifts again", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    await expect(
      page.getByText("organization administrators who still hold a password", {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByLabel(REQUIRE_SSO).click();
    await expect(page.getByLabel(REQUIRE_SSO)).toBeChecked();
    await expect.poll(async () =>
      (await control<State>("/state")).overview.enforce
    )
      .toBe(true);
    await page.reload();
    await expect(page.getByLabel(REQUIRE_SSO)).toBeChecked();
    await shot(page, "sso-enforcement-on");

    // The member is refused on password sign-in and gets no session.
    expect(await passwordSignIn("developer")).toEqual({
      status: 403,
      code: "SSO_REQUIRED",
      sessions: 0,
    });
    // The administrator who holds a password keeps break-glass access.
    expect(await passwordSignIn("admin")).toMatchObject({
      status: 200,
      code: null,
      sessions: 1,
    });
    // The same member signs in through the real issuer while enforcement is on.
    expect(
      await control("/sso-sign-in", { providerId: PROVIDER }),
    ).toEqual({
      signedIn: true,
      email: server.developerEmail,
      usedClientSecret: true,
    });

    await page.getByLabel(REQUIRE_SSO).click();
    await expect(page.getByLabel(REQUIRE_SSO)).not.toBeChecked();
    await expect.poll(async () =>
      (await control<State>("/state")).overview.enforce
    )
      .toBe(false);
    expect(await passwordSignIn("developer")).toMatchObject({
      status: 200,
      sessions: 1,
    });
  });

  test("a member who is not an administrator is refused by the server", async ({ page, baseURL }) => {
    await connect(page, baseURL!, server.developerCookie);
    await page.goto(SSO_PAGE);
    await expect(
      page.getByText(
        "Only organization administrators can manage single sign-on.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: `${PROVIDER} · OIDC` }))
      .toHaveCount(0);
    await shot(page, "sso-forbidden");
  });

  test("removes the provider and the backend no longer holds it", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    await page.getByRole("button", { name: `${PROVIDER} · OIDC` }).click();
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Provider removed.")).toBeVisible();
    const state = await control<State>("/state");
    expect(state.stored).toEqual([]);
    expect(state.overview.providers).toEqual([]);
  });

  test("registers a SAML provider from pasted identity provider metadata and shows its TXT record", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    await page.getByRole("button", { name: "Add SAML" }).click();
    await page.getByLabel("Display name").fill(SAML_PROVIDER);
    await page.getByLabel("Email domain").fill(SAML_DOMAIN);
    await shot(page, "sso-add-saml");
    await page.getByLabel("Identity provider metadata").fill(
      server.samlMetadata,
    );
    const registered = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/sso/register")
    );
    await page.getByRole("button", { name: "Save provider" }).click();
    const response = await registered;
    expect(response.status(), await response.text()).toBe(200);
    await expect(page.getByRole("button", { name: `${SAML_PROVIDER} · SAML` }))
      .toBeVisible();

    const state = await control<State>("/state");
    expect(state.stored).toMatchObject([{
      providerId: SAML_PROVIDER,
      organizationId: server.organizationId,
      domain: SAML_DOMAIN,
      domainVerified: false,
    }]);
    expect(state.overview.providers).toMatchObject([
      { providerId: SAML_PROVIDER, protocol: "saml" },
    ]);
    await expect(page.getByTestId(`txt-${SAML_PROVIDER}`)).toContainText(
      `_bakery-verify-${SAML_PROVIDER}.${SAML_DOMAIN} TXT `,
    );
    await shot(page, "sso-saml-registered");
    await page.reload();
    await expect(
      page.getByRole("button", { name: `${SAML_PROVIDER} · SAML` }),
    )
      .toBeVisible();
  });

  /** The HTTP status of a SCIM client calling the provisioning API with `token`. */
  const scimStatus = async (token: string) =>
    (await control<{ status: number }>("/scim", {
      token,
      method: "GET",
      path: "/Users",
    })).status;
  /**
   * The credential the page shows once, read from the token element alone:
   * its section also holds the Copy button, whose label is not part of it.
   */
  const shownToken = async (page: Page) =>
    (await page.getByTestId("scim-token-once")
      .getByText(/^bsc_[A-Za-z0-9_-]+$/).textContent() ?? "").trim();
  let scimToken = "";

  test("creates the SCIM connection; the token shown once is a real credential", async ({ page, baseURL }) => {
    await connect(page, baseURL!, server.adminCookie);
    await page.goto(SCIM_PAGE);
    await expect(
      page.getByRole("heading", { name: "SCIM", exact: true }).first(),
    ).toBeVisible();
    // No connection yet: provisioning refuses everyone.
    expect(await scimStatus("")).toBe(401);

    await page.getByRole("button", { name: "Create connection" }).click();
    await expect(page.getByTestId("scim-token-once")).toContainText(
      "not shown again",
    );
    scimToken = await shownToken(page);
    expect(scimToken).not.toBe("");
    expect(await scimStatus(scimToken)).toBe(200);
    expect(await scimStatus("bsc_wrong")).toBe(401);
    // The credential is hidden: it is shown once and must not be published.
    await shot(page, "scim-token-shown-once", [
      page.getByTestId("scim-token-once").getByText(/^bsc_[A-Za-z0-9_-]+$/),
    ]);

    await page.getByRole("button", { name: "I have stored the token" })
      .click();
    await expect(page.getByTestId("scim-token-once")).toHaveCount(0);
    await page.reload();
    // The connection and its base URL are read back; the secret never is.
    // Wait for the loaded page first, or the absence check passes vacuously.
    await expect(page.getByText(`${server.publicOrigin}/api/auth/scim/v2`))
      .toBeVisible();
    await expect(page.getByText(scimToken)).toHaveCount(0);
  });

  test("rotating replaces the SCIM credential and revoking ends provisioning access", async ({ page, baseURL }) => {
    await connect(page, baseURL!, server.adminCookie);
    await page.goto(SCIM_PAGE);
    await page.getByRole("button", { name: "Rotate token", exact: true })
      .click();
    const rotate = page.getByRole("alertdialog", {
      name: "Rotate the SCIM token?",
    });
    await expect(rotate).toBeVisible();
    await shot(page, "scim-rotate-confirm");
    await rotate.getByRole("button", { name: "Cancel" }).click();
    // Cancelling changed nothing: the first token still works.
    expect(await scimStatus(scimToken)).toBe(200);

    await page.getByRole("button", { name: "Rotate token", exact: true })
      .click();
    await rotate.getByRole("button", { name: "Rotate token", exact: true })
      .click();
    await expect(page.getByTestId("scim-token-once")).toContainText(
      "not shown again",
    );
    const rotated = await shownToken(page);
    expect(rotated).not.toBe("");
    expect(rotated).not.toBe(scimToken);
    expect(await scimStatus(scimToken)).toBe(401);
    expect(await scimStatus(rotated)).toBe(200);
    await page.getByRole("button", { name: "I have stored the token" })
      .click();

    await page.getByRole("button", { name: "Revoke token", exact: true })
      .click();
    const revoke = page.getByRole("alertdialog", {
      name: "Revoke the SCIM token?",
    });
    await expect(revoke).toBeVisible();
    await shot(page, "scim-revoke-confirm");
    // Wait for the revoke request itself: after the rotation the credentials
    // table already holds an older Revoked row, so the word "Revoked" alone is
    // on screen before this request has finished.
    const revoked = page.waitForResponse((response) =>
      response.url().endsWith("/v1/scim-connection/revoke") &&
      response.request().method() === "POST"
    );
    await revoke.getByRole("button", { name: "Revoke token", exact: true })
      .click();
    expect((await revoked).status()).toBe(201);
    // The page offers a new connection only once the status is no longer
    // active, which is a signal no older table row can give early.
    await expect(page.getByRole("button", { name: "Create connection" }))
      .toBeVisible();
    expect(await scimStatus(rotated)).toBe(401);
    await page.reload();
    await expect(page.getByText("Revoked").first()).toBeVisible();
    await shot(page, "scim-revoked");
  });

  test("a member who is not an administrator cannot manage SCIM", async ({ page, baseURL }) => {
    await connect(page, baseURL!, server.developerCookie);
    await page.goto(SCIM_PAGE);
    await expect(
      page.getByText(
        "Only organization administrators can manage SCIM provisioning.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Create connection" }))
      .toHaveCount(0);
    await shot(page, "scim-forbidden");
  });
});
