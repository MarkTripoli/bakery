import { createHash, randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

type Credentials = {
  email: string;
  password: string;
  clientId: string;
  redirectUri: string;
};

const PROTOCOL = "2026-07-28";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function signIn(page: Page, credentials: Credentials) {
  await page.goto("/__test__/auth");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");
}

/** Walks authorize → consent page → callback in the browser; returns the callback params. */
async function authorizeInBrowser(
  page: Page,
  baseURL: string,
  credentials: Credentials,
  decision: "Allow" | "Deny",
  challenge: string,
) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: credentials.clientId,
    redirect_uri: credentials.redirectUri,
    scope: "bakery:read bakery:operate",
    state: `state-${randomBytes(8).toString("hex")}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${baseURL}/mcp`,
  });
  await page.goto(`/api/auth/oauth2/authorize?${params}`);
  await expect(page).toHaveURL(/\/oauth\/consent\?/);
  await expect(page.getByRole("heading", { name: "Authorize client" }))
    .toBeVisible();
  await page.getByRole("button", { name: decision }).click();
  await expect(page).toHaveURL(/\/__test__\/mcp\/callback\?/);
  return {
    code: await page.getByTestId("code").textContent() ?? "",
    error: await page.getByTestId("error").textContent() ?? "",
  };
}

async function mcpToolsList(page: Page, token: string) {
  return await page.request.post("/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      "mcp-method": "tools/list",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientInfo": {
            name: "bakery-browser-spec",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  });
}

test("a person consents in the browser, the client calls MCP, and revoking the connection ends it", async ({ page, baseURL }) => {
  const credentials = await (
    await page.request.get("/__test__/mcp/credentials")
  ).json() as Credentials;
  await signIn(page, credentials);

  // Deny first: the client gets access_denied and no code.
  const denied = await authorizeInBrowser(
    page,
    baseURL!,
    credentials,
    "Deny",
    pkce().challenge,
  );
  expect(denied.code).toBe("");
  expect(denied.error).toBe("access_denied");

  // Allow: a code comes back, and only the PKCE verifier redeems it.
  const { verifier, challenge } = pkce();
  const allowed = await authorizeInBrowser(
    page,
    baseURL!,
    credentials,
    "Allow",
    challenge,
  );
  expect(allowed.error).toBe("");
  expect(allowed.code.length).toBeGreaterThan(10);
  const token = await page.request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code: allowed.code,
      client_id: credentials.clientId,
      redirect_uri: credentials.redirectUri,
      code_verifier: verifier,
      resource: `${baseURL}/mcp`,
    },
  });
  expect(token.status()).toBe(200);
  const { access_token: accessToken } = await token.json() as {
    access_token: string;
  };

  const listed = await mcpToolsList(page, accessToken);
  expect(listed.status()).toBe(200);
  const names = ((await listed.json()) as {
    result: { tools: { name: string }[] };
  }).result.tools.map((tool) => tool.name);
  expect(names).toContain("whoami");

  // A consent POST from another origin is refused, whatever the cookie.
  const forged = await page.request.post("/api/auth/oauth2/consent", {
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    data: { accept: true, oauth_query: "client_id=x" },
  });
  expect(forged.status()).toBeGreaterThanOrEqual(400);

  // The person sees the connection and revokes it; the token stops at once.
  const connections = await page.request.get("/v1/me/connected-clients");
  expect(connections.status()).toBe(200);
  const items = (await connections.json() as {
    items: { id: string; clientId: string }[];
  }).items.filter((item) => item.clientId === credentials.clientId);
  expect(items).toHaveLength(1);
  const revoked = await page.request.delete(
    `/v1/me/connected-clients/${items[0]!.id}`,
    { headers: { origin: baseURL! } },
  );
  expect(revoked.ok()).toBe(true);
  const after = await mcpToolsList(page, accessToken);
  expect(after.status()).toBe(401);
});
