import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { submitUntilAccepted } from "./helpers/api-retry.ts";

/**
 * Live, real-API proof of the account-security screens (#151 AC2): the
 * security hub, password change, passkeys (a Chromium virtual authenticator
 * stands in for the device), in-place re-authentication, connected clients
 * (revoke, then the client's next `/mcp` call is refused with 401) and the
 * OAuth consent screen (allow and deny). The MCP client is plain HTTP: no SDK,
 * the same JSON-RPC envelope `tests/helpers/oauth-mcp.ts` sends.
 *
 * Gated like `settings-journey.spec.ts`: `BAKERY_REAL_API=1`, the shared
 * bootstrap admin, `desktop-shared-admin` project only, serial. Extra environment:
 * - `BAKERY_REAL_OAUTH_CLIENT_ID` names an already registered public client
 *   whose redirect URI is `OAUTH_REDIRECT_URI`; without it the spec runs the
 *   shipped `register-oauth-client` task against `DATABASE_URL` (owner URL).
 *
 * The pages shipped in the single V-0 refresh commit, so the guard is on.
 */
const PRODUCTION_ROUTES_SHIPPED = true;

const enabled = process.env.BAKERY_REAL_API === "1";
const explicitEmail = process.env.BAKERY_REAL_EMAIL?.trim().toLowerCase();
const explicitPassword = process.env.BAKERY_REAL_PASSWORD;
const fixtureDefaultAllowed = process.env.BAKERY_ENV === "test";
const ADMIN_EMAIL = explicitEmail ||
  (fixtureDefaultAllowed ? "browser-admin@example.test" : "");
const ADMIN_PASSWORD = explicitPassword ||
  (fixtureDefaultAllowed ? "Browser-Admin-Passw0rd-1" : "");
const credentialsAvailable = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);

const OAUTH_REDIRECT_URI = "http://127.0.0.1:43111/callback";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const SCOPES = "bakery:read bakery:operate";

const seedScriptPath = fileURLToPath(
  new URL("../../../tests/helpers/web-auth-seed.ts", import.meta.url),
);
const tasksPath = fileURLToPath(
  new URL("../../server/src/tasks.ts", import.meta.url),
);

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

/** Installs a CTAP2 platform authenticator that auto-confirms every prompt. */
async function addVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<CDPSession> {
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable");
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return session;
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function registerClient(name: string): string {
  const preset = process.env.BAKERY_REAL_OAUTH_CLIENT_ID?.trim();
  if (preset) return preset;
  const output = execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-net",
    "--allow-sys=hostname",
    "--allow-read",
    tasksPath,
    "register-oauth-client",
    "--name",
    name,
    "--redirect-uri",
    OAUTH_REDIRECT_URI,
    "--scopes",
    SCOPES,
  ], { encoding: "utf8" });
  // The task prints exactly one token-shaped line: the public client id.
  const printed = output.split("\n").map((line) => line.trim()).filter((line) =>
    /^[A-Za-z0-9_-]{32,}$/.test(line)
  );
  expect(printed).toHaveLength(1);
  return printed[0];
}

type Connected = { challenge: string; verifier: string; authorizeUrl: string };

async function authorizeRequest(clientId: string): Promise<Connected> {
  const { verifier, challenge } = await pkcePair();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: SCOPES,
    state: `state-${randomToken()}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return {
    verifier,
    challenge,
    authorizeUrl: `/api/auth/oauth2/authorize?${params}`,
  };
}

/** Follows the authorize redirect in the browser and lands on the consent page. */
async function openConsent(
  page: Page,
  authorizeUrl: string,
  resource: string,
): Promise<void> {
  const url = new URL(authorizeUrl, "http://placeholder.invalid");
  url.searchParams.set("resource", resource);
  await page.goto(`${url.pathname}${url.search}`);
  await expect(page).toHaveURL(/\/oauth\/consent/);
  await expect(page.getByRole("heading", { name: "Allow access to Bakery?" }))
    .toBeVisible();
}

/** Resolves with the callback URL the consent decision redirects to. */
async function callbackAfter(
  page: Page,
  decide: () => Promise<void>,
): Promise<URL> {
  let callback: URL | undefined;
  await page.route(`${OAUTH_REDIRECT_URI}**`, (route) => {
    callback = new URL(route.request().url());
    return route.fulfill({ status: 200, body: "callback" });
  });
  await decide();
  await expect.poll(() => callback !== undefined).toBe(true);
  return callback!;
}

async function exchangeCode(
  baseURL: string,
  options: {
    clientId: string;
    code: string;
    verifier: string;
    resource: string;
  },
): Promise<string> {
  // A native client posts without the person's browser cookies.
  const response = await fetch(`${baseURL}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      client_id: options.clientId,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: options.verifier,
      resource: options.resource,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json() as { access_token: string };
  return body.access_token;
}

/**
 * The API server's own origin: the dev web server proxies `/api` and `/v1`
 * but not `/mcp`, and the access token's audience is checked against the
 * configured public origin, not the request host.
 */
function apiOrigin(): string {
  const host = process.env.BAKERY_SERVER_HOST || "127.0.0.1";
  return `http://${host}:${process.env.BAKERY_SERVER_PORT || "8000"}`;
}

/** Raw HTTP MCP `tools/call`, outside any browser session or cookie. */
async function callMcp(token: string): Promise<Response> {
  return await fetch(`${apiOrigin()}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": "whoami",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "whoami",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "bakery-journey-client",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

test.describe("account security journey", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !PRODUCTION_ROUTES_SHIPPED,
    "the account-security routes ship in the V-0 refresh commit",
  );
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
    execFileSync("deno", [
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
  });

  test("1. the hub links to every sign-in method and the connected clients", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto("/settings/security");
    await expect(page.locator("main h1")).toHaveText("Account and security");
    for (const name of ["Change", "Manage"]) {
      await expect(page.getByRole("link", { name }).first()).toBeVisible();
    }
    await expect(page.getByText("Connected clients").first()).toBeVisible();
    await expect(page.getByText("Passkeys").first()).toBeVisible();
    // The nav item reaches the same list the hub row does.
    await page.getByRole("link", { name: "Connected clients" }).first().click();
    await expect(page).toHaveURL(/\/settings\/clients$/);
  });

  test("2. a wrong current password is refused and the right one changes it back", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const replacement = `${ADMIN_PASSWORD}-${randomToken()}`;
    await page.goto("/settings/security/password");
    await expect(page.locator("main h1")).toHaveText("Change password");

    await page.getByLabel("Current password").fill("not-the-password-0");
    await page.getByLabel("New password").fill(replacement);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(
      page.getByText("We couldn’t verify your current password."),
    ).toBeVisible();

    // Change to a new password, then change back so later tests still sign in.
    await page.getByLabel("Current password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page.getByRole("heading", { name: "Password changed" }))
      .toBeVisible();
    await page.goto("/settings/security/password");
    await page.getByLabel("Current password").fill(replacement);
    await page.getByLabel("New password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page.getByRole("heading", { name: "Password changed" }))
      .toBeVisible();
  });

  test("3. re-authentication is in place: a wrong password is refused, the right one returns to the return path", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto(
      "/account/reauthenticate?returnTo=%2Fsettings%2Fsecurity%2Fpasskeys",
    );
    await expect(page.locator("main h1")).toHaveText("Confirm it’s you");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password-0");
    await page.getByRole("button", { name: "Confirm identity" }).click();
    await expect(
      page.getByRole("alert").filter({
        hasText: "We couldn’t complete that request.",
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Confirm identity" }).click();
    await expect(page).toHaveURL(/\/settings\/security\/passkeys$/);
  });

  test("4. a passkey is added through a virtual authenticator, renamed and removed", async ({ page, context, baseURL }) => {
    test.setTimeout(120_000);
    // The server's RP ID is the public origin's hostname and WebAuthn refuses
    // an IP address as an RP ID, so this ceremony needs a DNS name or
    // `localhost` (BAKERY_PUBLIC_BASE_URL and BASE_URL both on `localhost`).
    test.skip(
      /^(\d+\.){3}\d+$|^\[/.test(new URL(baseURL!).hostname),
      "WebAuthn needs a DNS-name RP ID: run with BAKERY_PUBLIC_BASE_URL and BASE_URL on localhost",
    );
    await signIn(page);
    const authenticator = await addVirtualAuthenticator(context, page);
    const name = `Journey key ${randomToken()}`;
    try {
      await page.goto("/settings/security/passkeys");
      await expect(page.locator("main h1")).toHaveText("Passkeys");
      await page.getByRole("link", { name: "Add a passkey" }).first().click();
      await expect(page).toHaveURL(/\/settings\/security\/passkeys\/new$/);

      await page.getByLabel("Passkey name").fill(name);
      await page.getByLabel("Current password").fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { name: "Your passkey is ready" }))
        .toBeVisible();

      await page.getByRole("link", { name: "Manage passkeys" }).click();
      await expect(page.getByRole("list", { name: "Your passkeys" }))
        .toContainText(name);

      // Remove it again: the password proves the removal in place.
      await page.getByRole("link", { name: `Remove ${name}` }).click();
      await expect(page.getByRole("heading", { name: "Remove this passkey?" }))
        .toBeVisible();
      await page.getByLabel("Current password").fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: `Remove passkey ${name}` })
        .click();
      await expect(page.getByText(`${name} was removed from your account.`))
        .toBeVisible();
      await expect(page.getByRole("list", { name: "Your passkeys" }))
        .toHaveCount(0);
    } finally {
      await authenticator.send("WebAuthn.disable");
    }
  });

  test("5. revoking a connected client stops its next /mcp call with 401", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const clientName = `Journey client ${randomToken()}`;
    const clientId = registerClient(clientName);
    const resource = `${baseURL}/mcp`;
    await signIn(page);

    const request = await authorizeRequest(clientId);
    await openConsent(page, request.authorizeUrl, resource);
    const callback = await callbackAfter(
      page,
      () => page.getByRole("button", { name: "Allow access" }).click(),
    );
    const code = callback.searchParams.get("code");
    expect(code, "allow redirects with an authorization code").not.toBeNull();
    const token = await exchangeCode(baseURL!, {
      clientId,
      code: code!,
      verifier: request.verifier,
      resource,
    });
    expect((await callMcp(token)).status).toBe(200);

    await page.goto("/settings/clients");
    await expect(page.locator("main h1")).toHaveText("Connected clients");
    await page.getByRole("button", { name: /^Revoke access for / }).first()
      .click();
    await expect(page.getByRole("heading", { name: "Revoke client access?" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Revoke access" }).click();
    await expect(
      page.getByText(
        "The client’s access was revoked.",
      ),
    ).toBeVisible();

    // The token the client already holds is dead on its next call.
    const refused = await callMcp(token);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate") ?? "").toContain("Bearer");
  });

  test("6. denying consent sends the client back with access_denied and no code", async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    const clientId = registerClient(`Journey denied ${randomToken()}`);
    await signIn(page);
    const request = await authorizeRequest(clientId);
    await openConsent(page, request.authorizeUrl, `${baseURL}/mcp`);
    const callback = await callbackAfter(
      page,
      () => page.getByRole("button", { name: "Deny" }).click(),
    );
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
    await expect(page.getByRole("heading", { name: "Access was not granted" }))
      .toBeVisible();
  });
});
