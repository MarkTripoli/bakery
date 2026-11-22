import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { laneBudgetMs } from "../../apps/web/tests/helpers/lane-budget.ts";
import {
  createTotpOffsets,
  parseTotpSecret,
  totpCode,
} from "../helpers/totp.ts";

// #52 (B15.06) AC3 in a real browser: Chromium's own WebAuthn stack backed by a
// CDP virtual authenticator, against the real auth server. A captured
// assertion is never accepted twice, a real assertion sent from another origin
// is refused, the browser itself refuses a foreign RP ID, a dismissed ceremony
// changes nothing, and a passkey alone never reaches the account until the
// second factor steps the session up. One person, owned by this spec, runs the
// cases in order on one page: the authenticator lives as long as the page.

test.describe.configure({ mode: "serial" });

type Captured = { body: string };
const FOREIGN_ORIGIN = "http://evil.example.test";
let context: BrowserContext;
let page: Page;
let secret: string;
const nextOffset = createTotpOffsets();
let captured: Captured | undefined;

function identityStatus(): Promise<number> {
  return page.evaluate(() =>
    fetch("/v1/me", { headers: { accept: "application/json" } }).then((
      response,
    ) => response.status)
  );
}

/** A real assertion from Chromium's authenticator for a fresh server challenge, not yet sent. */
function freshAssertion(): Promise<string> {
  return page.evaluate(async () => {
    const options = await fetch(
      "/api/auth/passkey/generate-authenticate-options",
      { headers: { accept: "application/json" } },
    ).then((response) => response.json());
    const credential = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
    }) as PublicKeyCredential;
    return JSON.stringify({ response: credential.toJSON() });
  });
}

/**
 * Posts a sign-in body. Without `origin` it is the page's own fetch (the
 * browser sets the real Origin); with one, the same cookie jar sends that
 * Origin header instead, which a browser on another site would.
 */
async function verify(body: string, origin?: string) {
  if (!origin) {
    return await page.evaluate(async (data) => {
      const response = await fetch("/api/auth/passkey/verify-authentication", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: data,
      });
      return { status: response.status, text: await response.text() };
    }, body);
  }
  const response = await page.request.post(
    "/api/auth/passkey/verify-authentication",
    {
      data: body,
      headers: {
        "content-type": "application/json",
        origin,
      },
    },
  );
  return { status: response.status(), text: await response.text() };
}

async function signOut() {
  await page.evaluate(() =>
    fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  );
  expect(await identityStatus()).toBe(401);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/__test__/passkeys");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const credentials = await (
    await page.request.get("/__test__/webauthn/credentials")
  ).json() as { email: string; password: string };
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");
  await page.getByLabel("Confirm your password").fill(credentials.password);
  await page.getByRole("button", { name: "Enable authenticator" }).click();
  await expect(page.locator("#enrollment-details")).toBeVisible();
  const totpUri = await page.getByTestId("totp-uri").textContent();
  if (!totpUri) throw new Error("TOTP_URI_MISSING");
  secret = parseTotpSecret(totpUri);
  await page.locator("#verify-code").fill(await totpCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("Authenticator enabled.");
  await page.getByLabel("Passkey name").fill("Desk");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status")).toHaveText("Passkey added.");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed out.");
});

test.afterAll(async () => {
  await context?.close();
});

test("a passkey alone is not a session: the second factor steps it up", async () => {
  test.setTimeout(laneBudgetMs(30_000));
  const request = page.waitForRequest((request) =>
    request.url().endsWith("/api/auth/passkey/verify-authentication")
  );
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  captured = { body: (await request).postData() ?? "" };
  await expect(page.getByRole("status")).toHaveText(
    "Enter your authenticator code.",
  );
  expect(await identityStatus()).toBe(401);

  await page.locator("#challenge-code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.locator("#challenge-error")).toBeVisible();
  expect(await identityStatus()).toBe(401);

  await page.locator("#challenge-code").fill(
    await totpCode(secret, { stepOffset: nextOffset() }),
  );
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");
  expect(await identityStatus()).toBe(200);
  await signOut();
});

test("a captured assertion is refused when replayed, with its own or a fresh challenge", async () => {
  expect(captured?.body).toContain('"response"');
  const sameChallenge = await verify(captured!.body);
  expect(sameChallenge.status).toBe(400);
  expect(sameChallenge.text).toContain("CHALLENGE_NOT_FOUND");
  expect(await identityStatus()).toBe(401);

  // A new ceremony cookie, then the old assertion: signed over another challenge.
  await page.evaluate(() =>
    fetch("/api/auth/passkey/generate-authenticate-options").then((r) =>
      r.status
    )
  );
  const freshChallenge = await verify(captured!.body);
  expect(freshChallenge.status).toBe(400);
  expect(freshChallenge.text).toContain("AUTHENTICATION_FAILED");
  expect(await identityStatus()).toBe(401);
});

test("a real assertion sent from another origin is refused", async () => {
  const foreign = await verify(await freshAssertion(), FOREIGN_ORIGIN);
  expect(foreign.status).toBe(403);
  expect(await identityStatus()).toBe(401);

  // Control: the same kind of assertion from the page's own origin is accepted
  // (it reaches the second-factor step), so the refusal above is the origin.
  const own = await verify(await freshAssertion());
  expect(own.status).toBe(200);
  expect(own.text).toContain("twoFactorRedirect");
  expect(await identityStatus()).toBe(401);
  // Leave no half-finished two-factor ceremony behind for the next case.
  await context.clearCookies();
});

test("Chromium refuses a ceremony for a foreign RP ID before any authenticator is asked", async () => {
  const outcome = await page.evaluate(async () => {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const results: string[] = [];
    try {
      await navigator.credentials.get({
        publicKey: { challenge, rpId: "evil.example.test" },
      });
      results.push("get:accepted");
    } catch (error) {
      results.push(`get:${(error as DOMException).name}`);
    }
    try {
      await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { id: "evil.example.test", name: "Evil" },
          user: {
            id: crypto.getRandomValues(new Uint8Array(16)),
            name: "x",
            displayName: "x",
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
      });
      results.push("create:accepted");
    } catch (error) {
      results.push(`create:${(error as DOMException).name}`);
    }
    return results;
  });
  expect(outcome).toEqual(["get:SecurityError", "create:SecurityError"]);
  expect(await identityStatus()).toBe(401);
});

test("a dismissed sign-in ceremony sends nothing and signs nobody in", async () => {
  let sent = 0;
  const count = (request: { url(): string }) => {
    if (request.url().endsWith("/api/auth/passkey/verify-authentication")) {
      sent += 1;
    }
  };
  page.on("request", count);
  const name = await page.evaluate(async () => {
    const options = await fetch(
      "/api/auth/passkey/generate-authenticate-options",
      { headers: { accept: "application/json" } },
    ).then((response) => response.json());
    const ceremony = new AbortController();
    const pending = navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
      signal: ceremony.signal,
    });
    ceremony.abort();
    return await pending.then(() => "completed", (error) => error.name);
  });
  page.off("request", count);
  expect(name).toBe("AbortError");
  expect(sent).toBe(0);
  expect(await identityStatus()).toBe(401);
});
