import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { devices, expect, type Page, test } from "@playwright/test";
import { totpCode } from "../../../tests/helpers/totp.ts";
import { AUTH_BOOTSTRAP_PROJECT } from "../../../scripts/ci/browser-core.mjs";
import {
  requestUntilAccepted,
  retryDelayMs,
  sleep,
  submitUntilAccepted,
} from "./helpers/api-retry.ts";

/**
 * Live, real-API proof of the acceptance criteria in FS03 (#127) Phase 6 —
 * everything `real-api.spec.ts` cannot reach because it never signs up,
 * invites, or mutates two-factor state. Gated on `BAKERY_REAL_API === "1"`
 * like `real-api.spec.ts:9-15`, so the fixtures lane (no backend) skips this
 * file entirely and every other spec in this directory is unaffected.
 *
 * This file owns one shared bootstrap admin and shares Better Auth's real
 * `/api/auth/**` rate-limit buckets with it — both are unsafe under
 * `playwright.config.ts`'s `fullyParallel: true` + multi-worker projects, so
 * this file runs only in the single-worker `desktop-auth-bootstrap` project
 * (other shared-admin seeders depend on this project; every test is skipped unless
 * `testInfo.project.name === AUTH_BOOTSTRAP_PROJECT`, see the `beforeEach`
 * below); the plan's "mobile repeat" of
 * assertion 1 runs in-process instead, via a manually created iPhone-13
 * context (test `1c`), so it is exercised without a second worker racing
 * the same admin/rate-limit state.
 *
 * `beforeAll` seeds the single bootstrap admin via
 * `tests/helpers/web-auth-seed.ts` (a Deno script — `pnpm createsuperuser`
 * itself refuses a non-TTY stdin). Everything after that seed uses real HTTP
 * against the real API proxied by the Vite dev server
 * (`apps/web/vite.config.ts`'s `/health`, `/v1`, `/api` proxy targets).
 */
const enabled = process.env.BAKERY_REAL_API === "1";
const realSignupsEnabled = process.env.BAKERY_REAL_SIGNUPS === "1";
const explicitEmail = process.env.BAKERY_REAL_EMAIL?.trim().toLowerCase();
const explicitPassword = process.env.BAKERY_REAL_PASSWORD;
const fixtureDefaultAllowed = process.env.BAKERY_ENV === "test";
const ADMIN_EMAIL = explicitEmail ||
  (fixtureDefaultAllowed ? "browser-admin@example.test" : "");
const ADMIN_PASSWORD = explicitPassword ||
  (fixtureDefaultAllowed ? "Browser-Admin-Passw0rd-1" : "");
const credentialsAvailable = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);

const seedScriptPath = fileURLToPath(
  new URL("../../../tests/helpers/web-auth-seed.ts", import.meta.url),
);

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

/**
 * A rate-limited submit replaces the form with Paper's `throttled`
 * interstitial ("A short pause", `SignInScreen`); its "Return to sign in"
 * restores the form, so every retry path first steps back through it when
 * it is showing.
 */
async function returnToSignInFormIfThrottled(page: Page): Promise<void> {
  if (await page.getByTestId("sign-in-throttled").isVisible()) {
    await page.getByRole("button", { name: "Return to sign in", exact: true })
      .click();
  }
}

/** Mouse/tap sign-in: used everywhere except assertion 1's keyboard-only case. */
async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await submitUntilAccepted(
    page,
    "/api/auth/sign-in/email",
    async () => {
      // A failed submit clears the password field (SignInPage's own error
      // handling) and a 429 swaps in the throttled interstitial, so a retry
      // steps back to the form and refills both fields, not just re-click.
      await returnToSignInFormIfThrottled(page);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true })
        .click();
    },
  );
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

/**
 * Signs out the way the account menu does: `/sign-out` confirms, the
 * success screen offers "Sign in" as the deliberate next step
 * (`SignOutPage`). Ends on `/sign-in`, ready for `signIn`.
 */
async function signOutThroughPage(page: Page): Promise<void> {
  await page.goto("/sign-out");
  await expect(page.getByTestId("sign-out-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByTestId("sign-out-success")).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/sign-in");
}

/**
 * Hands out a TOTP code for a step strictly after the last one this helper
 * already used, waiting out the remainder of the current step when the
 * clock hasn't naturally advanced far enough — so assertion 8's several
 * sequential proofs (enroll, challenge, regenerate, disable) each land on a
 * genuinely fresh, never-submitted 30-second window instead of risking a
 * `INVALID_CODE` replay against Better Auth's per-code replay guard
 * (`tests/helpers/totp.ts`'s own replay-window note covers the same
 * constraint for a single extra proof; this generalises it to any number).
 */
let lastTotpStepMs = -1;
async function freshTotpCode(secret: string): Promise<string> {
  const periodMs = 30_000;
  let stepMs = Math.floor(Date.now() / periodMs) * periodMs;
  if (stepMs <= lastTotpStepMs) {
    const targetMs = lastTotpStepMs + periodMs;
    const waitMs = targetMs - Date.now() + 250;
    if (waitMs > 0) await sleep(waitMs);
    stepMs = Math.floor(Date.now() / periodMs) * periodMs;
  }
  lastTotpStepMs = stepMs;
  return await totpCode(secret, { at: stepMs });
}

/**
 * Submits one of the settings forms that prove the authenticator first and
 * then act (`BackupCodesPage`/`TotpDisablePage`: `verifyTotp`, then the
 * `followUpUrl` call). Either request can be rate-limited; a `429` on
 * either one waits it out and resubmits with a *fresh* code, since a
 * verified code cannot be replayed even when the follow-up never ran.
 */
async function submitTwoFactorProof(
  page: Page,
  secret: string,
  followUpUrl: string,
  submit: (code: string) => Promise<void>,
): Promise<void> {
  // Once a code has verified, the page keeps that proof and a retry sends
  // only the follow-up call, so no second verify-totp response is awaited.
  let proved = false;
  for (;;) {
    const code = await freshTotpCode(secret);
    const verified = proved
      ? null
      : page.waitForResponse((response) =>
        response.url().includes("/api/auth/two-factor/verify-totp")
      );
    const followedUp = page.waitForResponse((response) =>
      response.url().includes(followUpUrl)
    );
    // Never fires when the proof itself was rejected; that timeout must not
    // surface as an unhandled rejection after the loop has moved on.
    followedUp.catch(() => {});
    await submit(code);
    if (verified) {
      const verify = await verified;
      if (verify.status() === 429) {
        await sleep(retryDelayMs(verify));
        continue;
      }
      proved = verify.ok();
    }
    const followUp = await followedUp;
    if (followUp.status() !== 429) return;
    await sleep(retryDelayMs(followUp));
  }
}

test.describe("auth journey", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 with the web server proxied to a running API",
  );
  test.skip(
    !credentialsAvailable,
    "set BAKERY_REAL_EMAIL and BAKERY_REAL_PASSWORD to an existing (or " +
      "about-to-be-seeded) admin; the fixture default only applies when " +
      "BAKERY_ENV=test",
  );

  // Playwright requires an object destructuring pattern here to recognise
  // the hook's fixture parameter.
  // deno-lint-ignore no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== AUTH_BOOTSTRAP_PROJECT,
      "this file owns one shared bootstrap admin and shares Better Auth's " +
        "real /api/auth/** rate-limit buckets with it — both are unsafe " +
        "under fullyParallel + multi-worker projects, so the whole file " +
        "runs once, in `desktop-auth-bootstrap`; the mobile-specific tap interaction from " +
        "assertion 9 is covered in-process by test 1c",
    );
  });

  let organizationId: string;

  // Recorded by `beforeAll`, before seeding, so assertion 1a can observe
  // the real pre-bootstrap state instead of permanently skipping — see the
  // probe below. `null` only if `beforeAll` never ran on this worker at all
  // (the mobile worker: guarded out immediately below).
  let preSeedObservation: {
    readonly bootstrapped: boolean;
    readonly finalPath: string;
    readonly setupDefaultVisible: boolean;
    readonly bootstrapTitleVisible: boolean;
  } | null = null;

  // `beforeAll`/`afterAll` are *worker* hooks: Playwright runs them in every
  // worker that schedules this file, before the dynamic `beforeEach` skip
  // above ever fires. The config only schedules this file in the
  // single-worker `desktop-auth-bootstrap` project; the guard keeps any other
  // project (a `--project` override) from shelling out the seed (whose
  // normal `already-complete` path resets the admin's two-factor state) and
  // the `afterAll` reset below, landing at an arbitrary point relative to
  // the serial chain and potentially wiping TOTP state mid-assertion-8.
  test.beforeAll(async ({ browser }, workerInfo) => {
    if (workerInfo.project.name !== AUTH_BOOTSTRAP_PROJECT) return;

    // Observe the real pre-seed state before this file's own seed can
    // change it — the only honest way to prove assertion 1a live without
    // resetting a Postgres shared with concurrently running lanes. A
    // `bootstrapped:true` database (any already-seeded local run) simply
    // records that fact; 1a then skips with a truthful reason instead of
    // asserting a state that was never observed.
    const probeContext = await browser.newContext();
    const probePage = await probeContext.newPage();
    try {
      const statusResponse = await probePage.request.get(
        "/v1/installation/status",
      );
      const statusBody = await statusResponse.json() as {
        bootstrapped?: boolean;
      };
      const bootstrapped = statusBody.bootstrapped === true;
      if (bootstrapped) {
        preSeedObservation = {
          bootstrapped,
          finalPath: "",
          setupDefaultVisible: false,
          bootstrapTitleVisible: false,
        };
      } else {
        await probePage.goto("/settings/sessions");
        // The `/setup` redirect is a client-side (SPA) router decision made
        // after React mounts and `beforeLoad` resolves `installationStatus`
        // — not a server HTTP redirect — so `goto` itself resolves before
        // it happens; wait for it explicitly rather than reading the URL
        // immediately.
        await probePage.waitForURL("/setup", { timeout: 10_000 });
        // Paper `setup/default`: `bootstrapped:false` states the situation
        // and points at the CLI setup workflow — there is no HTTP admin
        // creation to offer (`SetupScreen`). `setup-ready` is the
        // post-bootstrap confirmation, which a genuinely empty install
        // cannot show.
        const setupDefault = probePage.getByTestId("setup-default");
        // `SetupPage` itself resolves its own `installationStatus` query
        // after mount; give it a moment to settle past `setup-loading`
        // before recording a snapshot, but never throw here — a real
        // timeout should surface as `false` in the recorded observation,
        // which the test then fails loudly on, not as a broken beforeAll.
        await setupDefault.waitFor({ state: "visible", timeout: 5_000 })
          .catch(() => {});
        preSeedObservation = {
          bootstrapped,
          finalPath: new URL(probePage.url()).pathname,
          setupDefaultVisible: await setupDefault.isVisible(),
          bootstrapTitleVisible: await probePage.getByRole("heading", {
            name: "Finish local setup",
          }).isVisible(),
        };
      }
    } finally {
      await probeContext.close();
    }

    let output: string;
    try {
      output = execFileSync("deno", [
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
    } catch (error) {
      const status = (error as { status?: number | null } | undefined)
        ?.status ?? 1;
      const stderr = (error as { stderr?: Buffer | string } | undefined)?.stderr
        ?.toString().trim() ?? "";
      throw new Error(
        `web-auth-seed exited ${status}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    const lastLine = output.trim().split("\n").filter(Boolean).pop();
    const seeded = JSON.parse(lastLine ?? "{}") as {
      organizationId?: string;
      status?: string;
    };
    if (!seeded.organizationId) {
      throw new Error(
        `web-auth-seed produced no organizationId (status: ${
          seeded.status ?? "unknown"
        })`,
      );
    }
    organizationId = seeded.organizationId;
  });

  // deno-lint-ignore no-empty-pattern
  test.afterAll(({}, workerInfo) => {
    if (workerInfo.project.name !== AUTH_BOOTSTRAP_PROJECT) return;
    // Best-effort: an interrupted assertion 8 could leave the admin's
    // two-factor state enabled; clear it so the next run's plain
    // email/password sign-ins are not unexpectedly redirected to
    // /sign-in/two-factor. A failure here is logged, not thrown — it must never
    // turn an otherwise-green run red.
    try {
      execFileSync("deno", [
        "run",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        seedScriptPath,
        "--reset-two-factor",
        ADMIN_EMAIL,
      ], { encoding: "utf8" });
    } catch (error) {
      console.warn(
        `web-auth-seed --reset-two-factor cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  // ---- 1. Empty install / keyboard sign-in / cookie / org-scoped request --

  test("1a. empty install redirects to /setup", () => {
    // Skips only when the database this file's own beforeAll observed was
    // already bootstrapped before this run — an honest recording of what
    // was actually seen, never a forced reset of a Postgres shared with
    // concurrently running lanes.
    test.skip(
      preSeedObservation?.bootstrapped === true,
      "database already bootstrapped before this run",
    );
    expect(preSeedObservation?.finalPath).toBe("/setup");
    expect(preSeedObservation?.setupDefaultVisible).toBe(true);
    expect(preSeedObservation?.bootstrapTitleVisible).toBe(true);
  });

  test("1b. keyboard-only sign-in reaches / with an org-scoped request and an httpOnly session cookie", async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto("/sign-in");
    await expect(page.getByTestId("sign-in")).toBeVisible();
    await expectNoAxeViolations(page);

    // Keyboard-only: focus the first field, then Tab/type/Enter — no clicks.
    await submitUntilAccepted(
      page,
      "/api/auth/sign-in/email",
      async () => {
        // A failed submit clears the password field but leaves email
        // alone (SignInPage's own error handling), so a retry selects
        // each field's current content before retyping — safe whether
        // that content is empty (password, after a failure) or unchanged
        // (email). A 429 first has to leave the throttled interstitial —
        // still keyboard-only: focus its button and press Enter.
        if (await page.getByTestId("sign-in-throttled").isVisible()) {
          await page.getByRole("button", {
            name: "Return to sign in",
            exact: true,
          }).focus();
          await page.keyboard.press("Enter");
        }
        await page.getByLabel("Email").focus();
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type(ADMIN_EMAIL);
        await page.keyboard.press("Tab");
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type(ADMIN_PASSWORD);
        await page.keyboard.press("Enter");
      },
    );

    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("health-ready")).toBeVisible();

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) =>
      cookie.name.endsWith("session_token")
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);

    // No production screen calls an organization-scoped action yet — only
    // `tasks.list` sets `Bakery-Organization-Id` in
    // `apps/web/src/api/client.ts`, and no route renders it — so the
    // header's real wire behaviour for a freshly authenticated admin is
    // proven directly against the contract's own organization-scoped
    // resource (`GET /v1/tasks`, `Developer` access; the admin's `Admin`
    // role satisfies it per `apps/server/src/modules/auth/application/
    // authority.ts`'s role-rank check) instead of through an as-yet-unbuilt
    // screen.
    const scoped = await requestUntilAccepted(() =>
      page.request.get("/v1/tasks", {
        headers: { "Bakery-Organization-Id": organizationId },
      })
    );
    expect(scoped.ok()).toBe(true);
  });

  test("1c. tap-driven sign-in on an emulated iPhone reaches / (assertion 9's mobile repeat of 1)", async ({ browser }) => {
    test.setTimeout(120_000);

    const mobileContext = await browser.newContext({
      ...devices["iPhone 13"],
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();
    try {
      await mobilePage.goto("/sign-in");
      await expect(mobilePage.getByTestId("sign-in")).toBeVisible();
      await expectNoAxeViolations(mobilePage);

      const email = mobilePage.getByLabel("Email");
      const password = mobilePage.getByLabel("Password", { exact: true });
      await submitUntilAccepted(
        mobilePage,
        "/api/auth/sign-in/email",
        async () => {
          // A failed submit clears the password field, so a retry must
          // refill both fields, not just re-tap — after tapping back out
          // of the throttled interstitial when a 429 put it up.
          if (await mobilePage.getByTestId("sign-in-throttled").isVisible()) {
            await mobilePage.getByRole("button", {
              name: "Return to sign in",
              exact: true,
            }).tap();
          }
          await email.fill(ADMIN_EMAIL);
          await password.fill(ADMIN_PASSWORD);
          await mobilePage.getByRole("button", {
            name: "Sign in",
            exact: true,
          }).tap();
        },
      );

      await expect(mobilePage).toHaveURL("/");
      await expect(mobilePage.getByTestId("health-ready")).toBeVisible();
    } finally {
      await mobileContext.close();
    }
  });

  // ---- 2. Deep link ---------------------------------------------------

  test("2. an anonymous deep link to /settings/sessions redirects to sign-in and returns there after sign-in", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto("/settings/sessions");
    await expect(page).toHaveURL("/sign-in");

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await expect(page).toHaveURL("/settings/sessions");
    await expect(page.getByTestId("sessions-settings")).toBeVisible();
  });

  // ---- 3. Expired / tampered session -----------------------------------

  test("3. a tampered session cookie redirects to /sign-in?reason=expired and /v1/me reports AUTH_INVALID", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/");

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) =>
      cookie.name.endsWith("session_token")
    );
    expect(sessionCookie).toBeDefined();

    await page.context().clearCookies();
    await page.context().addCookies([{
      ...sessionCookie!,
      value: `tampered-${sessionCookie!.value}`,
    }]);

    await page.goto("/");
    await expect(page).toHaveURL("/sign-in?reason=expired");
    // Paper `expired`: the session-ended interstitial replaces the form
    // until "Sign in again" is chosen (`SignInScreen`'s `expired` state).
    await expect(page.getByTestId("sign-in-expired")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sign in to continue" }),
    ).toBeVisible();

    const me = await requestUntilAccepted(() => page.request.get("/v1/me"));
    expect(me.status()).toBe(401);
    const body = await me.json() as { code?: string };
    expect(body.code).toBe("AUTH_INVALID");
  });

  // ---- 4. Multi-session revocation --------------------------------------

  test("4. a second session can be listed, revoked individually, and revoking the current session signs the browser out", async ({ page, browser, baseURL }) => {
    test.setTimeout(75_000);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/");

    // Earlier assertions each sign the admin in without signing out, so the
    // account can already hold other live sessions by the time this runs;
    // clear them first so "lists 2" below is this test's own two sessions,
    // not an accumulation across the whole serial run.
    const cleanupOthers = await requestUntilAccepted(() =>
      page.request.post("/v1/me/sessions/revoke-others", {
        data: {},
        headers: { origin: baseURL! },
      })
    );
    expect(cleanupOthers.ok()).toBe(true);

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto("/sign-in");
    await signIn(otherPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(otherPage).toHaveURL("/");

    await page.goto("/settings/sessions");
    await expect(page.getByTestId("sessions-settings")).toBeVisible();
    await expectNoAxeViolations(page);
    // Paper `sessions`: this device's row with its `Current` badge, then one
    // row per other session whose `Revoke` link opens the confirmation page
    // (`/settings/sessions/revoke?session=<id>`) — no dialogs.
    await expect(page.getByTestId("sessions-current")).toHaveCount(1);
    const otherRows = page.getByTestId("sessions-other");
    await expect(otherRows).toHaveCount(1);

    await otherRows.getByRole("link", { name: "Revoke", exact: true }).click();
    await expect(page).toHaveURL(
      /\/settings\/sessions\/revoke\?session=/,
    );
    await expect(page.getByTestId("revoke-sessions")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sign out other sessions?" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByTestId("revoke-sessions-confirm").click();
    // A single revocation returns to the list with its "signed out" notice.
    await expect(page).toHaveURL(/\/settings\/sessions\?revoked=/);
    await expect(page.getByText("The selected session was signed out."))
      .toBeVisible();
    await expect(otherRows).toHaveCount(0);
    await expect(page.getByText("There are no other active sessions."))
      .toBeVisible();

    const otherIdentity = await requestUntilAccepted(() =>
      otherPage.request.get("/v1/me")
    );
    expect(otherIdentity.status()).toBe(401);

    // The list offers no `Revoke` for this device's own row; the same
    // confirmation page still accepts the current session's id (a stale
    // row's link, or a typed URL) and `RevokeSessionsPage` signs the
    // browser out when the revoked session turns out to be its own.
    const sessions = await requestUntilAccepted(() =>
      page.request.get("/v1/me/sessions")
    );
    expect(sessions.ok()).toBe(true);
    const sessionList = await sessions.json() as {
      items: { id: string; current: boolean }[];
    };
    const currentSessionId = sessionList.items.find((item) => item.current)
      ?.id;
    expect(currentSessionId).toBeTruthy();
    await page.goto(
      `/settings/sessions/revoke?session=${currentSessionId}`,
    );
    await expect(page.getByTestId("revoke-sessions")).toBeVisible();
    await page.getByTestId("revoke-sessions-confirm").click();
    await expect(page).toHaveURL("/sign-in");

    await otherContext.close();
  });

  // ---- 5. Invitation -----------------------------------------------------

  test(
    "5a. an anonymous invitation preview (real and unknown), a bare /register, /organizations, " +
      "and the real API boundary (readiness + a non-auth Problem) all render",
    async ({ page, browser, baseURL }, testInfo) => {
      test.setTimeout(90_000);
      const tag = `${testInfo.project.name}-${randomToken()}`;

      // Moved here from `real-api.spec.ts`, which ran these same two
      // signed-in checks from a *second* worker/context signing in as this
      // same shared admin — racing this project's own serial chain (a
      // 2FA-enabled admin mid-assertion-8 turns this sign-in into a
      // `/sign-in/two-factor` redirect instead of "/"; a revoke-others call in
      // assertion 4 could kill this session mid-check). Registered before
      // the sign-in below so it also catches the readiness fetch fired the
      // moment "/" first renders.
      let readiness: Promise<{ status: number; body: unknown }> | null = null;
      page.on("response", (response) => {
        if (!response.url().includes("/health/ready")) return;
        readiness ??= (async () => ({
          status: response.status(),
          body: await response.json(),
        }))();
      });

      await page.goto("/sign-in");
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await expect(page).toHaveURL("/");

      await expect(page.getByTestId("health-ready")).toBeVisible();
      const observedReadiness = await readiness;
      expect(observedReadiness?.status).toBe(200);
      expect(
        typeof observedReadiness?.body === "object" &&
          observedReadiness?.body !== null &&
          "service" in observedReadiness.body,
      ).toBe(true);
      expect(await page.getByTestId("health-ready").innerText()).toContain(
        "Service status",
      );
      await expect(page.getByText(/^Version \d/)).toBeVisible();

      // A signed-in browser asking about a nil invitation id gets a real,
      // non-auth Problem (RESOURCE_NOT_FOUND, packages/contracts/src/http.ts),
      // unlike the anonymous AUTH_REQUIRED `real-api.spec.ts` still exercises.
      const problem = page.waitForResponse((candidate) =>
        candidate.url().includes("/api/auth/organization/get-invitation")
      );
      await page.goto("/__fixtures__/api-boundary?from=smoke#check");
      await page.getByRole("button", { name: "Open action" }).click();
      const wire = problem.then(async (response) => ({
        status: response.status(),
        contentType: response.headers()["content-type"] ?? "",
        body: await response.json() as { code?: string; requestId?: string },
      }));
      const observedProblem = await wire;
      expect(observedProblem.status).toBe(404);
      expect(observedProblem.contentType).toContain(
        "application/problem+json",
      );
      expect(observedProblem.body.code).toBe("RESOURCE_NOT_FOUND");
      await expect(page.getByTestId("api-boundary-error")).toBeVisible();
      await expect(page.getByTestId("api-boundary-code"))
        .toHaveText("RESOURCE_NOT_FOUND");
      // The rendered correlation identifier is the one the wire returned, so
      // the Problem on screen cannot be an invented object.
      await expect(page.getByTestId("api-boundary-request-id"))
        .toHaveText(`Request ID: ${observedProblem.body.requestId ?? ""}`);

      const invitedEmail = `browser-invited-${tag}@example.test`.toLowerCase();
      const inviteResponse = await requestUntilAccepted(() =>
        page.request.post(`/v1/organizations/${organizationId}/invitations`, {
          data: { email: invitedEmail, role: "developer" },
          headers: {
            origin: baseURL!,
            "Bakery-Organization-Id": organizationId,
          },
        })
      );
      expect(inviteResponse.ok()).toBe(true);
      const invitation = await inviteResponse.json() as { id: string };

      // `organizationInvitations.preview` is anonymous by design, so the
      // public `/invitations/<id>` fills Paper's `contextShell` summary
      // (organization, inviter, role) and the invited address before any
      // sign-in — `InvitationPage`'s `default` state.
      const inviteeContext = await browser.newContext();
      const inviteePage = await inviteeContext.newPage();
      await inviteePage.goto(`/invitations/${invitation.id}`);
      await expect(inviteePage.getByTestId("invitation-default"))
        .toBeVisible();
      await expect(
        inviteePage.getByRole("heading", { name: "Join Personal" }),
      ).toBeVisible();
      const summary = inviteePage.getByRole("complementary");
      await expect(summary.getByRole("heading")).toContainText(
        "You’re joining",
      );
      await expect(summary.getByRole("heading")).toContainText("Personal");
      await expect(summary.getByText("Browser Admin")).toBeVisible();
      await expect(summary.getByText("Invited you")).toBeVisible();
      await expect(summary.getByText("Developer", { exact: true }))
        .toBeVisible();
      await expect(inviteePage.getByText(invitedEmail)).toBeVisible();
      await expect(inviteePage.getByText("Email on the invitation"))
        .toBeVisible();
      await expect(inviteePage.getByTestId("invitation-create-account"))
        .toBeVisible();
      await expectNoAxeViolations(inviteePage);

      // An id the preview cannot resolve (unknown, revoked, expired or
      // already accepted — the same `RESOURCE_NOT_FOUND`, anti-enumeration)
      // lands on Paper's single `revoked` dead end.
      await inviteePage.goto(`/invitations/${crypto.randomUUID()}`);
      await expect(inviteePage.getByTestId("invitation-revoked"))
        .toBeVisible();
      await expect(
        inviteePage.getByRole("heading", {
          name: "This invitation is no longer available",
        }),
      ).toBeVisible();
      await expect(inviteePage.getByTestId("invitation-back-to-sign-in"))
        .toBeVisible();
      await expectNoAxeViolations(inviteePage);
      await inviteeContext.close();

      // /register with no invitation stays put and shows Paper's `join`
      // screen (`RegisterRoute` renders `JoinPage` in place, no redirect).
      const bareContext = await browser.newContext();
      const barePage = await bareContext.newPage();
      await barePage.goto("/register");
      await expect(barePage).toHaveURL("/register");
      await expect(barePage.getByTestId("join")).toBeVisible();
      await expect(
        barePage.getByRole("heading", {
          name: "You’re invited to the kitchen.",
        }),
      ).toBeVisible();
      await expectNoAxeViolations(barePage);
      await bareContext.close();

      await page.goto("/organizations");
      await expect(page.getByTestId("organizations-page")).toBeVisible();
      await expectNoAxeViolations(page);
    },
  );

  test(
    "5b. an invited email accepts and lands scoped to the organization; a non-invited email degrades safely (requires BAKERY_REAL_SIGNUPS=1)",
    async ({ page, browser, baseURL }, testInfo) => {
      test.skip(
        !realSignupsEnabled,
        "installation registration mode is not configured for this API",
      );
      test.setTimeout(90_000);
      const tag = `${testInfo.project.name}-${randomToken()}`;

      await page.goto("/sign-in");
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await expect(page).toHaveURL("/");

      const invitedEmail = `browser-invited-${tag}@example.test`.toLowerCase();
      const invitedPassword = `Browser-Invited-${tag}-1`;

      const inviteResponse = await requestUntilAccepted(() =>
        page.request.post(`/v1/organizations/${organizationId}/invitations`, {
          data: { email: invitedEmail, role: "developer" },
          headers: {
            origin: baseURL!,
            "Bakery-Organization-Id": organizationId,
          },
        })
      );
      expect(inviteResponse.ok()).toBe(true);
      const invitation = await inviteResponse.json() as { id: string };

      const inviteeContext = await browser.newContext();
      const inviteePage = await inviteeContext.newPage();

      await inviteePage.goto(`/invitations/${invitation.id}`);
      await expect(inviteePage.getByTestId("invitation-default"))
        .toBeVisible();

      // Paper `register`: the invitation's own address is the account being
      // created — it is shown read-only, never typed.
      await inviteePage.getByTestId("invitation-create-account").click();
      await expect(inviteePage).toHaveURL(
        `/register?invitation=${invitation.id}`,
      );
      await expect(inviteePage.getByTestId("register")).toBeVisible();
      await expect(inviteePage.getByLabel("Email")).toHaveValue(invitedEmail);
      await submitUntilAccepted(
        inviteePage,
        "/api/auth/sign-up/email",
        async () => {
          // A failed submit clears the password field (RegisterPage's own
          // error handling), so a retry refills both editable fields.
          await inviteePage.getByLabel("Full name").fill("Browser Invited");
          await inviteePage.getByLabel("Password", { exact: true }).fill(
            invitedPassword,
          );
          await inviteePage.getByRole("button", {
            name: "Create account",
            exact: true,
          }).click();
        },
      );
      await expect(inviteePage.getByTestId("register-submitted"))
        .toBeVisible();

      // `RegisterPage`'s "Sign in" remembers the invitation as the return-to
      // and opens Paper's `invite-login` variant of `/sign-in`: the same
      // password form on the context shell with the invited address locked.
      await inviteePage.getByRole("button", { name: "Sign in", exact: true })
        .click();
      await expect(inviteePage).toHaveURL(
        `/sign-in?invitation=${invitation.id}`,
      );
      await expect(inviteePage.getByTestId("sign-in-invite")).toBeVisible();
      await expect(inviteePage.getByLabel("Email")).toHaveValue(invitedEmail);
      await submitUntilAccepted(
        inviteePage,
        "/api/auth/sign-in/email",
        async () => {
          await inviteePage.getByLabel("Password", { exact: true }).fill(
            invitedPassword,
          );
          await inviteePage.getByRole("button", {
            name: "Sign in and continue",
            exact: true,
          }).click();
        },
      );
      // Signing in toward an invitation lands straight back on it
      // (`SignInPage` navigates to `INVITATION_PATH` when `?invitation=` is
      // set) instead of the empty organization chooser.
      await expect(inviteePage).toHaveURL(`/invitations/${invitation.id}`);
      await expect(inviteePage.getByTestId("invitation-authenticated"))
        .toBeVisible();
      await expect(
        inviteePage.getByRole("heading", { name: "Join Personal" }),
      ).toBeVisible();
      await expect(inviteePage.getByText("Signed in as Browser Invited"))
        .toBeVisible();
      await expectNoAxeViolations(inviteePage);

      await inviteePage.getByTestId("invitation-accept").click();
      // Paper `invite/accepted`: the page stays put and offers the
      // organization; opening it is the deliberate next step.
      await expect(inviteePage.getByTestId("invitation-accepted"))
        .toBeVisible();
      await expect(
        inviteePage.getByRole("heading", {
          name: "You’re already part of Personal",
        }),
      ).toBeVisible();
      await inviteePage.getByTestId("invitation-open-organization").click();
      await expect(inviteePage).toHaveURL("/");

      const scoped = await requestUntilAccepted(() =>
        inviteePage.request.get("/v1/tasks", {
          headers: { "Bakery-Organization-Id": organizationId },
        })
      );
      expect(scoped.ok()).toBe(true);

      // A non-invited email always resolves "submitted" (anti-enumeration)
      // but never actually creates an account — HTTP sign-up is
      // invitation-gated server-side. The register page no longer offers an
      // address field (the invitation's own address is locked in), so the
      // stranger's sign-up is the raw provider call; the degraded sign-in it
      // leads to is still proven through the real form.
      const strangerContext = await browser.newContext();
      const strangerPage = await strangerContext.newPage();
      const strangerEmail = `browser-stranger-${tag}@example.test`
        .toLowerCase();
      const strangerPassword = `Browser-Stranger-${tag}-1`;
      const strangerSignUp = await requestUntilAccepted(() =>
        strangerPage.request.post("/api/auth/sign-up/email", {
          data: {
            name: "Browser Stranger",
            email: strangerEmail,
            password: strangerPassword,
            rememberMe: false,
          },
          headers: { origin: baseURL! },
        })
      );
      expect(strangerSignUp.ok()).toBe(true);
      await strangerPage.goto("/sign-in");
      await signIn(strangerPage, strangerEmail, strangerPassword);
      await expect(
        strangerPage.getByText(
          "Email or password is incorrect. Please try again.",
        ),
      ).toBeVisible();

      await Promise.all([inviteeContext.close(), strangerContext.close()]);
    },
  );

  // ---- 6. Unauthorized/forbidden org -------------------------------------

  test("6. a stale organization preference is cleared when the session itself has no organization access", async ({ page, browser, baseURL }) => {
    // This scenario's forbidden principal only exists by signing up
    // (unaccepted) against a live invitation — the same real signUpEmail
    // HTTP call assertion 5b gates on `BAKERY_REAL_SIGNUPS=1`; see that
    // assertion's comment and reports/phase6.md ("Fix round 6").
    test.skip(
      !realSignupsEnabled,
      "installation registration mode is not configured for this API",
    );
    test.setTimeout(75_000);
    const tag = `desktop-${randomToken()}`;

    await page.goto("/sign-in");
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/");

    // `GET /v1/me` never returns `AUTH_FORBIDDEN` for a merely
    // zero-organization-membership principal — `identityGet`
    // (apps/server/src/modules/auth/application/identity.ts) carries no
    // membership check at all, so an invited-but-never-accepted signup
    // resolves a plain `200`. The only real trigger is a *disabled*
    // principal: `resolvePrincipal`'s `IdentityResolutionError`
    // (apps/server/src/modules/auth/middleware.ts), which every
    // unit/integration/security lane's own `AUTH_FORBIDDEN` coverage
    // reaches the same way — `update bakery.principals set disabled_at
    // = current_timestamp`. This still needs a live invitation, since
    // `decideRegistration` (apps/server/src/modules/auth/domain/
    // registration.ts) only actually creates the account when one exists.
    const forbiddenEmail = `browser-forbidden-${tag}@example.test`
      .toLowerCase();
    const forbiddenPassword = `Browser-Forbidden-${tag}-1`;
    const inviteResponse = await requestUntilAccepted(() =>
      page.request.post(`/v1/organizations/${organizationId}/invitations`, {
        data: { email: forbiddenEmail, role: "developer" },
        headers: {
          origin: baseURL!,
          "Bakery-Organization-Id": organizationId,
        },
      })
    );
    expect(inviteResponse.ok()).toBe(true);

    const forbiddenContext = await browser.newContext();
    const forbiddenPage = await forbiddenContext.newPage();
    const signUp = await requestUntilAccepted(() =>
      forbiddenPage.request.post("/api/auth/sign-up/email", {
        data: {
          name: "Browser Forbidden",
          email: forbiddenEmail,
          password: forbiddenPassword,
          rememberMe: false,
        },
      })
    );
    expect(signUp.ok()).toBe(true);
    const signInDirect = await requestUntilAccepted(() =>
      forbiddenPage.request.post("/api/auth/sign-in/email", {
        data: { email: forbiddenEmail, password: forbiddenPassword },
      })
    );
    expect(signInDirect.ok()).toBe(true);

    // Deactivate the freshly created principal directly — see the comment
    // above; this is the only real way the next `/v1/me` answers
    // `AUTH_FORBIDDEN`. Reuses `web-auth-seed.ts --disable-principal`
    // rather than a bespoke SQL client, matching every other real-API
    // fixture in this file.
    execFileSync("deno", [
      "run",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      seedScriptPath,
      "--disable-principal",
      forbiddenEmail,
    ], { encoding: "utf8" });

    const preferenceKey = "bakery.organization.lastSelected.v1";
    const staleOrganizationId = crypto.randomUUID();
    await forbiddenContext.addInitScript(
      ([key, value]) => {
        globalThis.localStorage.setItem(key, value);
      },
      [preferenceKey, staleOrganizationId] as const,
    );

    const forbiddenIdentity = forbiddenPage.waitForResponse((response) =>
      response.url().endsWith("/v1/me")
    );
    await forbiddenPage.goto("/");
    const forbiddenResponse = await forbiddenIdentity;
    expect(forbiddenResponse.status()).toBe(403);
    const forbiddenBody = await forbiddenResponse.json() as { code?: string };
    expect(forbiddenBody.code).toBe("AUTH_FORBIDDEN");
    await expect(forbiddenPage).toHaveURL("/organizations?reason=forbidden");
    await expect(forbiddenPage.getByTestId("forbidden-state")).toBeVisible();
    await expect(
      forbiddenPage.getByRole("heading", { name: "Access forbidden" }),
    ).toBeVisible();
    await expectNoAxeViolations(forbiddenPage);

    const remaining = await forbiddenPage.evaluate(
      (key) => globalThis.localStorage.getItem(key),
      preferenceKey,
    );
    expect(remaining).toBeNull();

    await forbiddenContext.close();
  });

  // ---- 7. Cross-origin ----------------------------------------------------

  test("7. a cross-origin sign-in and a cross-origin session revocation are both blocked", async ({ page, request }) => {
    test.setTimeout(75_000);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/");

    const hostileHeaders = {
      origin: "https://hostile.example.test",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };

    // Cookie-less request context, matching `tests/browser/bootstrap-
    // better-auth-and-invite-only-organization-identity.spec.ts:51-65`'s own
    // `{ request }` fixture: Better Auth's CSRF middleware
    // (`formCsrfMiddleware`) only evaluates Sec-Fetch-* metadata when no
    // `Cookie` header is present — `page.request` would carry the admin's
    // session cookie here and take a different (still-blocked, but
    // differently coded) path.
    const hostileSignIn = await requestUntilAccepted(() =>
      request.post("/api/auth/sign-in/email", {
        data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        headers: hostileHeaders,
      })
    );
    expect(hostileSignIn.status()).toBeGreaterThanOrEqual(400);
    const hostileBody = await hostileSignIn.text();
    expect(hostileBody).toContain("CROSS_SITE_NAVIGATION_LOGIN_BLOCKED");
    expect(hostileBody).not.toContain(ADMIN_PASSWORD);

    const sessions = await requestUntilAccepted(() =>
      page.request.get("/v1/me/sessions")
    );
    expect(sessions.ok()).toBe(true);
    const sessionList = await sessions.json() as {
      items: { id: string; current: boolean }[];
    };
    const currentSessionId = sessionList.items.find((item) => item.current)
      ?.id;
    expect(currentSessionId).toBeTruthy();

    const hostileRevoke = await requestUntilAccepted(() =>
      page.request.delete(`/v1/me/sessions/${currentSessionId}`, {
        headers: hostileHeaders,
      })
    );
    expect(hostileRevoke.status()).toBe(403);
    const hostileRevokeBody = await hostileRevoke.json() as {
      code?: string;
    };
    expect(hostileRevokeBody.code).toBe("AUTH_FORBIDDEN");

    // Proves the block was real: the targeted session is still alive.
    const stillThere = await requestUntilAccepted(() =>
      page.request.get("/v1/me")
    );
    expect(stillThere.ok()).toBe(true);
  });

  // ---- 8. Two-factor lifecycle --------------------------------------------

  test("8. two-factor enrollment, challenge, backup codes, regeneration, and disable all work end-to-end", async ({ page, browser }) => {
    // Assertion 5b's invited account only exists when `BAKERY_REAL_SIGNUPS=1`
    // (see that assertion's comment) — this test always runs against the
    // shared admin instead so it never depends on that gate; the
    // file-level `beforeEach` above already keeps it off any other
    // project.
    test.setTimeout(300_000);

    await page.goto("/sign-in");
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/");

    // Paper `security` → `two-factor` → `totp-setup`: every step of
    // enrolment is its own page under /settings/security (no dialogs).
    await page.goto("/settings/security");
    await expect(
      page.getByRole("heading", { name: "Account and security", level: 1 }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await expect(page.getByText("Off · Add a six-digit authenticator code."))
      .toBeVisible();
    await page.getByRole("link", {
      name: "Set up two-factor authentication",
      exact: true,
    })
      .click();
    await expect(page).toHaveURL("/settings/security/two-factor");
    await expect(page.getByTestId("two-factor-settings")).toBeVisible();
    await expectNoAxeViolations(page);
    await expect(page.getByText("Off", { exact: true })).toBeVisible();

    await page.getByRole("button", {
      name: "Set up authenticator",
      exact: true,
    }).click();
    await expect(page).toHaveURL("/settings/security/two-factor/setup");
    await expect(page.getByTestId("totp-setup")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Set up an authenticator" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    // A wrong current password is reported on the field (Paper draws the
    // policy failure there), never as a service outage.
    await submitUntilAccepted(
      page,
      "/api/auth/two-factor/enable",
      async () => {
        await page.getByLabel("Current password").fill(
          `${ADMIN_PASSWORD}-wrong`,
        );
        await page.getByRole("button", { name: "Continue", exact: true })
          .click();
      },
    );
    await expect(
      page.getByText(
        "We couldn’t verify your password. Two-factor authentication was not turned on.",
      ),
    ).toBeVisible();
    await submitUntilAccepted(
      page,
      "/api/auth/two-factor/enable",
      async () => {
        await page.getByLabel("Current password").fill(ADMIN_PASSWORD);
        await page.getByRole("button", { name: "Continue", exact: true })
          .click();
      },
    );

    // Paper `totp-setup/scan`: the QR code plus the hand-typed setup key,
    // grouped in fours (`totpSetupKey`) — the same base32 secret the
    // `otpauth://` URI carries, so the test's authenticator reads it from
    // the screen exactly as a person would.
    await expect(
      page.getByRole("heading", { name: "Connect your authenticator" }),
    ).toBeVisible();
    const setupKey = await page.locator('[data-ui-component="setupKey"]')
      .innerText();
    const totpSecret = setupKey.replace(/\s+/g, "");
    expect(totpSecret).toMatch(/^[A-Z2-7]{16,}$/);

    const enableCode = await freshTotpCode(totpSecret);
    await submitUntilAccepted(
      page,
      "/api/auth/two-factor/verify-totp",
      async () => {
        await page.getByLabel("Authentication code").fill(enableCode);
        await page.getByRole("button", {
          name: "Verify and turn on",
          exact: true,
        }).click();
      },
    );

    // Paper `backup-codes/default`: the first set is shown once, right
    // after enrolment, on its own page.
    await expect(page).toHaveURL(
      "/settings/security/two-factor/backup-codes",
    );
    await expect(page.getByTestId("backup-codes")).toBeVisible();
    await expect(
      page.getByText(
        "Two-factor authentication is on. Save these codes before you leave.",
      ),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    const enrollCodes = page.locator(
      '[data-ui-component="backupCodeList"] code',
    );
    await expect(enrollCodes).toHaveCount(10);
    let backupCodes = await enrollCodes.allTextContents();
    await page.getByRole("button", {
      name: "I’ve saved these codes",
      exact: true,
    }).click();
    await expect(page).toHaveURL("/settings/security/two-factor");
    await expect(page.getByText("On", { exact: true })).toBeVisible();
    await expect(page.getByText("10 unused codes. Each code works once."))
      .toBeVisible();

    // Sign out, sign in -> /sign-in/two-factor; a wrong code is rejected,
    // the correct one (a fresh step — see freshTotpCode's own doc comment)
    // signs in.
    await signOutThroughPage(page);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/sign-in/two-factor");
    await expect(page.getByTestId("two-factor")).toBeVisible();
    await expectNoAxeViolations(page);
    await expect(
      page.getByRole("heading", { name: "One more check" }),
    ).toBeVisible();

    await submitUntilAccepted(
      page,
      "/api/auth/two-factor/verify-totp",
      async () => {
        await page.getByLabel("Authentication code").fill("000000");
        await page.getByRole("button", {
          name: "Verify and sign in",
          exact: true,
        }).click();
      },
    );
    await expect(
      page.getByText(
        "That code is incorrect or expired. Try the current code from your app.",
      ),
    ).toBeVisible();

    const challengeCode = await freshTotpCode(totpSecret);
    await submitUntilAccepted(
      page,
      "/api/auth/two-factor/verify-totp",
      async () => {
        await page.getByLabel("Authentication code").fill(challengeCode);
        await page.getByRole("button", {
          name: "Verify and sign in",
          exact: true,
        }).click();
      },
    );
    await expect(page).toHaveURL("/");

    // Sign out, sign in -> /sign-in/two-factor -> /sign-in/recovery-code.
    await signOutThroughPage(page);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/sign-in/two-factor");
    await page.getByRole("link", { name: "Use a backup code", exact: true })
      .click();
    await expect(page).toHaveURL("/sign-in/recovery-code");
    await expect(page.getByTestId("recovery-code")).toBeVisible();
    await expectNoAxeViolations(page);
    await submitUntilAccepted(
      page,
      "/api/auth/two-factor/verify-backup-code",
      async () => {
        await page.getByLabel("Backup code").fill(backupCodes[0]);
        await page.getByRole("button", {
          name: "Verify and sign in",
          exact: true,
        }).click();
      },
    );
    await expect(page).toHaveURL("/");

    // The same backup code in a new context is a single-use code: invalid.
    const replayContext = await browser.newContext();
    const replayPage = await replayContext.newPage();
    await replayPage.goto("/sign-in");
    await signIn(replayPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(replayPage).toHaveURL("/sign-in/two-factor");
    await replayPage.goto("/sign-in/recovery-code");
    await submitUntilAccepted(
      replayPage,
      "/api/auth/two-factor/verify-backup-code",
      async () => {
        await replayPage.getByLabel("Backup code").fill(backupCodes[0]);
        await replayPage.getByRole("button", {
          name: "Verify and sign in",
          exact: true,
        }).click();
      },
    );
    await expect(
      replayPage.getByText(
        "That code is incorrect or already used. Try a different unused code.",
      ),
    ).toBeVisible();
    await replayContext.close();

    // Regenerate and disable both require their own fresh TOTP proof;
    // `freshTotpCode` guarantees each one targets a step that has not
    // been submitted before (see its own doc comment). Paper
    // `backup-codes/regenerate` is the protection overview's "Generate new
    // codes" link — `?regenerate=1` on the backup-codes page — and asks for
    // the code and the password on one form (`BackupCodesPage` proves the
    // authenticator with `verifyTotp`, then replaces the set with
    // `generateBackupCodes`).
    await page.goto("/settings/security/two-factor");
    await page.getByRole("link", { name: "Generate new codes", exact: true })
      .click();
    await expect(page).toHaveURL(
      /\/settings\/security\/two-factor\/backup-codes\?regenerate=/,
    );
    await expect(page.getByTestId("backup-codes")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Generate new backup codes?" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await submitTwoFactorProof(
      page,
      totpSecret,
      "/api/auth/two-factor/generate-backup-codes",
      async (code) => {
        await page.getByLabel("Current password").fill(ADMIN_PASSWORD);
        await page.getByLabel("Authentication code").fill(code);
        await page.getByRole("button", {
          name: "Generate new codes",
          exact: true,
        }).click();
      },
    );
    await expect(
      page.getByText(
        "New codes are ready. Your previous codes no longer work.",
      ),
    ).toBeVisible();
    const regenerateCodes = page.locator(
      '[data-ui-component="backupCodeList"] code',
    );
    await expect(regenerateCodes).toHaveCount(10);
    const regeneratedCodes = await regenerateCodes.allTextContents();
    expect(regeneratedCodes).not.toEqual(backupCodes);
    backupCodes = regeneratedCodes;
    await page.getByRole("button", {
      name: "I’ve saved these codes",
      exact: true,
    }).click();
    await expect(page).toHaveURL("/settings/security/two-factor");

    // Paper `totp-disable`: the overview's "Turn off" link opens the
    // confirmation page, which proves the authenticator and then the
    // password (`TotpDisablePage`: `verifyTotp`, then `disable`) and stays
    // on its own `disabled` confirmation.
    await page.getByRole("link", {
      name: "Turn off two-factor authentication",
      exact: true,
    }).click();
    await expect(page).toHaveURL("/settings/security/two-factor/disable");
    await expect(page.getByTestId("totp-disable")).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Turn off two-factor authentication?",
      }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    // The code is proved first and consumed by the replay guard; a wrong
    // password afterwards is reported on the password field, the code field
    // is cleared, and the retry needs only the password — the kept proof
    // (five-minute window) is not re-spent on a second code.
    await submitTwoFactorProof(
      page,
      totpSecret,
      "/api/auth/two-factor/disable",
      async (code) => {
        await page.getByLabel("Current password").fill(
          `${ADMIN_PASSWORD}-wrong`,
        );
        await page.getByLabel("Authentication code").fill(code);
        await page.getByRole("button", {
          name: "Turn off two-factor authentication",
          exact: true,
        }).click();
      },
    );
    await expect(
      page.getByText(
        "We couldn’t verify your password. Protection is still on.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Authentication code")).toHaveValue("");
    const disabled = page.waitForResponse((response) =>
      response.url().includes("/api/auth/two-factor/disable")
    );
    const verifiedAgain: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/two-factor/verify-totp")) {
        verifiedAgain.push(request.url());
      }
    });
    await page.getByLabel("Current password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", {
      name: "Turn off two-factor authentication",
      exact: true,
    }).click();
    expect((await disabled).status()).toBe(200);
    expect(verifiedAgain).toEqual([]);
    await expect(
      page.getByRole("heading", {
        name: "Two-factor authentication is off",
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to security", exact: true })
      .click();
    await expect(page).toHaveURL("/settings/security");
    await expect(page.getByText("Off · Add a six-digit authenticator code."))
      .toBeVisible();

    // Sign out, sign in -> straight to / without a challenge.
    await signOutThroughPage(page);
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/");
  });
});
