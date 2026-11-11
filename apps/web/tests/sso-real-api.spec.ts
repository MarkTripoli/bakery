import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";

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
 * `BAKERY_EVIDENCE_VIDEO=1` records video.
 */
const enabled = process.env.BAKERY_REAL_API === "1" &&
  process.env.BAKERY_REAL_API_SSO === "1";
const SSO_PAGE = "/settings/organization/sso";
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
  overview: { enforce: boolean; providers: { providerId: string }[] };
};

type PasswordSignIn = { status: number; code: string | null; sessions: number };

test.use({ video: process.env.BAKERY_EVIDENCE_VIDEO === "1" ? "on" : "off" });

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
    await expect(page.getByRole("heading", { name: "Single sign-on" }).first())
      .toBeVisible();
  }

  const passwordSignIn = (who: "admin" | "developer") =>
    control<PasswordSignIn>("/password-sign-in", { who });

  test.beforeEach(() => {
    test.setTimeout(60_000);
  });

  test("an administrator opens the production route and sees the empty state the backend reports", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    await expect(page.getByText("No identity provider yet", { exact: false }))
      .toBeVisible();
    const state = await control<State>("/state");
    expect(state.stored).toEqual([]);
    expect(state.overview).toEqual({ enforce: false, providers: [] });
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
    await page.getByRole("button", { name: "Save provider" }).click();
    await expect(page.getByRole("button", { name: `${PROVIDER} · OIDC` }))
      .toBeVisible();
    await expect(page.getByText("Disabled")).toBeVisible();
    await expect(page.getByText(server.issuer.clientSecret)).toHaveCount(0);

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
    // No TXT record is published yet: the server's own lookup finds nothing.
    await page.getByRole("button", { name: "Check domain" }).click();
    await expect(page.getByText("Not verified yet.", { exact: false }).first())
      .toBeVisible();
    expect((await control<State>("/state")).stored[0].domainVerified).toBe(
      false,
    );

    await control("/dns", { name: TXT_NAME, value: token });
    await page.getByRole("button", { name: "Check domain" }).click();
    await expect(page.getByText("Domain verified.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Enabled")).toBeVisible();
    expect((await control<State>("/state")).stored[0].domainVerified).toBe(
      true,
    );
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
});
