import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  requestUntilAccepted,
  submitUntilAccepted,
} from "./helpers/api-retry.ts";

/**
 * Real-API browser proof of Organization -> Access (#359, feeding #316).
 *
 * One serial journey against a real server, real sessions and a real
 * database: no route mocks, no fixture fallback, no HAR. It proves scoped
 * bindings at application and repository scope (and their effect on the next
 * real request), non-admin denial, cross-organization isolation, the real
 * last-admin refusal and the page states a person actually sees.
 *
 * It creates a second organization (B) because the admin of the seeded
 * organization (A) must stay out of the data the journey changes. Cleanup
 * promotes the invited guest to B's admin and removes the bootstrap admin
 * from B, so the shared admin is left with only A for the specs that run after
 * this one in `desktop-shared-admin`.
 */
const enabled = process.env.BAKERY_REAL_API === "1";
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
const captureDirectory = fileURLToPath(
  new URL(
    "../../../artifacts/ui-baseline/organization-access-real-api/",
    import.meta.url,
  ),
);
const ACCESS_PATH = "/settings/organization/access";

/**
 * In-app navigation to the Access page through the settings links, away and
 * back so it remounts and refetches. Avoids full document loads: Vite dev
 * serves hundreds of modules per load and exhausts browser resources after a
 * few.
 *
 * The query cache keeps lists fresh for a while, so a change made by another
 * browser context only shows on a remount after that window. `until` names
 * what the caller is waiting for: the remount repeats until it is visible, so
 * the wait follows the observable condition and not the cache's constant.
 */
async function openAccess(
  page: Page,
  options: { until?: Locator } = {},
): Promise<void> {
  const remount = async () => {
    if (!new URL(page.url()).pathname.startsWith("/settings")) {
      await page.getByRole("link", { name: "Settings", exact: true }).click();
    }
    if (new URL(page.url()).pathname === ACCESS_PATH) {
      await page.getByRole("link", { name: "Profile", exact: true }).click();
      await expect(page).toHaveURL("/settings/profile");
    }
    await page.getByRole("link", { name: "Members & access", exact: true })
      .click();
    await expect(page).toHaveURL(ACCESS_PATH);
  };
  const until = options.until;
  if (until === undefined) {
    await remount();
    return;
  }
  await expect(async () => {
    await remount();
    await expect(until).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 60_000, intervals: [250, 500, 1_000] });
}

type Reply = {
  status: number;
  code: string | undefined;
  body: unknown;
  text: string;
};

type Actor = { page: Page; origin: string };

/** One real API call as a signed-in browser context, retried on 429 only. */
async function call(
  actor: Actor,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: {
    org?: string;
    data?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.org) headers["Bakery-Organization-Id"] = options.org;
  if (method !== "GET") {
    headers.Origin = actor.origin;
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  const response = await requestUntilAccepted(() =>
    actor.page.request.fetch(path, {
      method,
      headers,
      ...(options.data === undefined ? {} : { data: options.data }),
    })
  );
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const code = typeof (body as { code?: unknown } | null)?.code === "string"
    ? (body as { code: string }).code
    : undefined;
  return { status: response.status(), code, body, text };
}

function expectStatus(reply: Reply, status: number, what: string): void {
  expect(reply.status, `${what}: ${reply.status} ${reply.text}`).toBe(status);
}

function ifMatch(version: unknown): Record<string, string> {
  return { "If-Match": `"v${version}"` };
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

/**
 * `toBeVisible` ignores occlusion and inertness, so a refusal rendered behind
 * a native modal passes it while no person (or screen reader) can perceive it.
 * This asserts the element is inside the open modal (when one is open), not
 * inert, and is the element at its own centre point. The check repeats until
 * it holds or the expect timeout ends, because a confirm dialog that just
 * closed can still paint over the point for a frame or two; a refusal that
 * stays covered still fails.
 */
async function expectPerceivable(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(() =>
    locator.evaluate((el) => {
      el.scrollIntoView({ block: "center" });
      const modal = document.querySelector("dialog:modal");
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        insideOpenModal: modal === null || modal.contains(el),
        notInert: el.closest("[inert]") === null,
        onTop: hit !== null && (el === hit || el.contains(hit)),
      };
    })
  ).toEqual({
    insideOpenModal: true,
    notInert: true,
    onTop: true,
  });
}

async function returnToSignInFormIfThrottled(page: Page): Promise<void> {
  if (await page.getByTestId("sign-in-throttled").isVisible()) {
    await page.getByRole("button", { name: "Return to sign in", exact: true })
      .click();
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    await returnToSignInFormIfThrottled(page);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page).toHaveURL("/");
}

/** Body with request-scoped ids removed and known resource ids masked. */
function comparable(reply: Reply, ids: string[]): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !/request|trace|correlation|instance/i.test(key))
          .map(([key, inner]) => [key, strip(inner)]),
      );
    }
    return value;
  };
  let text = JSON.stringify(strip(reply.body));
  for (const id of ids) text = text.split(id).join("<id>");
  return JSON.parse(text);
}

/**
 * Picks an organization through the shell's workspace switcher when the app is
 * already up, and loads /organizations only when it is not: like
 * `openAccess`, this keeps full Vite dev loads in one browser to a minimum.
 */
async function selectOrganization(page: Page, name: string): Promise<void> {
  const switcher = page.locator('[data-ui-component="workspaceSwitcher"]');
  if (await switcher.isVisible()) {
    await switcher.locator("button[aria-expanded]").click();
    await page.getByRole("navigation", { name: "Switch organization" })
      .getByRole("button", { name: "Switch organization", exact: true })
      .click();
    await expect(page).toHaveURL("/organizations");
  } else {
    await page.goto("/organizations");
  }
  await expect(page.getByTestId("organizations-list")).toBeVisible();
  await page.getByTestId("organizations-list").getByText(name, { exact: true })
    .click();
  await expect(page).toHaveURL("/");
}

async function typeIntoFocusedSelect(
  select: Locator,
  text: string,
  expectedValue: string,
): Promise<void> {
  await select.focus();
  await select.page().keyboard.type(text);
  await expect(select).toHaveValue(expectedValue);
}

test.describe("organization access against the real API", () => {
  test.describe.configure({ mode: "serial" });
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

  let organizationA: string;

  // deno-lint-ignore no-empty-pattern
  test.beforeAll(({}, workerInfo) => {
    if (workerInfo.project.name !== "desktop-shared-admin") return;
    const output = execFileSync("deno", [
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
    const lastLine = output.trim().split("\n").filter(Boolean).pop();
    const seeded = JSON.parse(lastLine ?? "{}") as { organizationId?: string };
    if (!seeded.organizationId) {
      throw new Error("seed returned no organization");
    }
    organizationA = seeded.organizationId;
  });

  test(
    "an admin binds, observes and revokes scoped roles; a guest and a foreign org stay isolated",
    async ({ browser, baseURL }, testInfo) => {
      test.setTimeout(300_000);
      mkdirSync(captureDirectory, { recursive: true });
      const origin = new URL(baseURL!).origin;
      const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const shot = async (page: Page, name: string) => {
        await page.screenshot({
          path: `${captureDirectory}/${name}.png`,
          fullPage: true,
        });
      };

      const guestEmail = `access-guest-${tag}@example.test`;
      const guestPassword = `Access-Guest-${tag}-1`;
      let primary: unknown = null;
      let nameA = "";
      const contexts: BrowserContext[] = [];
      const adminContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      contexts.push(adminContext);
      const adminPage = await adminContext.newPage();
      const adminConsole: string[] = [];
      adminPage.on("console", (message) => {
        if (message.type() === "error") adminConsole.push(message.text());
      });
      adminPage.on("framenavigated", (frame) => {
        if (frame === adminPage.mainFrame()) {
          adminConsole.push(`NAV ${frame.url()}`);
        }
      });
      adminPage.on("requestfailed", (request) => {
        adminConsole.push(
          `FAILED ${request.url()} ${request.failure()?.errorText}`,
        );
      });
      adminPage.on("pageerror", (error) => adminConsole.push(String(error)));
      adminPage.on("response", (response) => {
        if (
          response.status() >= 400 || /\/v1\/|\/api\/auth/.test(response.url())
        ) {
          adminConsole.push(
            `${response.status()} ${response.request().method()} ${response.url()}`,
          );
        }
      });
      const admin: Actor = { page: adminPage, origin };
      let guest: Actor | null = null;

      let organizationB: string | null = null;
      let restoreRegistration: "invitation" | "closed" | null = null;
      let invitationId: string | null = null;
      let guestJoined = false;
      let adminPrincipalId = "";

      try {
        // Step 0: pre-flight. Fails fast, never skips.
        await test.step("0. pre-flight: one organization, invitation sign-ups, fixtures", async () => {
          await signIn(adminPage);
          const organizations = await call(admin, "GET", "/v1/organizations");
          expectStatus(organizations, 200, "list organizations");
          const listed = (organizations.body as {
            items: { id: string; name: string }[];
          }).items;
          const initial = listed.map((item) => item.id);
          nameA = listed[0]?.name ?? "";
          expect(
            initial,
            "the shared admin must start with exactly the seeded organization",
          ).toEqual([organizationA]);
          const me = await call(admin, "GET", "/v1/me");
          expectStatus(me, 200, "identity");
          const identity = me.body as { principalId?: string; id?: string };
          adminPrincipalId = identity.principalId ?? identity.id ?? "";
          expect(adminPrincipalId).not.toBe("");

          const capabilities = await call(
            admin,
            "GET",
            "/v1/installation/capabilities",
          );
          expectStatus(capabilities, 200, "installation capabilities");
          const registration = (capabilities.body as {
            registration: "invitation" | "closed";
          }).registration;
          if (registration !== "invitation") {
            const settings = await call(
              admin,
              "GET",
              "/v1/installation/settings",
            );
            expectStatus(settings, 200, "installation settings");
            const current = settings.body as {
              registrationMode: string;
              organizationCreationPolicy: string;
              version: number;
            };
            const patched = await call(
              admin,
              "PATCH",
              "/v1/installation/settings",
              {
                data: {
                  registrationMode: "invitation",
                  organizationCreationPolicy:
                    current.organizationCreationPolicy,
                },
                headers: ifMatch(current.version),
              },
            );
            if (patched.status !== 200) {
              throw new Error(
                `REGISTRATION_MODE_UNAVAILABLE: ${patched.status} ${patched.text}`,
              );
            }
            restoreRegistration = registration;
          }
        });

        const nameB = `Access proof ${tag}`;
        const suffix = tag;
        const created: Record<string, string> = {};
        const names = {
          app1: `app1-${suffix}`,
          app2: `app2-${suffix}`,
          repo1: `repo1-${suffix}`,
          repo2: `repo2-${suffix}`,
        };
        await test.step("0b. seed organization B and its applications, repositories and tasks", async () => {
          const org = await call(admin, "POST", "/v1/organizations", {
            data: { name: nameB, slug: `access-proof-${tag}` },
          });
          expectStatus(org, 201, "create organization B");
          organizationB = (org.body as { id: string }).id;
          const B = organizationB;

          const application = async (
            org: string,
            slug: string,
            name: string,
          ) => {
            const reply = await call(admin, "POST", "/v1/applications", {
              org,
              data: { slug, name, description: "Access journey fixture" },
            });
            expectStatus(reply, 201, `create application ${name}`);
            return (reply.body as { id: string }).id;
          };
          const repository = async (
            org: string,
            applicationId: string,
            name: string,
          ) => {
            const create = await call(admin, "POST", "/v1/repositories", {
              org,
              data: {
                applicationId,
                slug: name,
                integrationConnectionId: crypto.randomUUID(),
                providerRepoId: `access/${name}`,
                owner: "access",
                name,
                defaultBranch: "main",
              },
            });
            expectStatus(create, 201, `create repository ${name}`);
            const repositoryId = (create.body as { id: string }).id;
            const config = {
              branches: { allowedPatterns: ["delivery/*"], base: "main" },
              schemaVersion: 1,
              workflow: { kind: "fixed" },
              worktree: { root: ".agents/worktrees/access" },
            };
            const digest = createHash("sha256").update(JSON.stringify(config))
              .digest("hex");
            const profile = await call(
              admin,
              "POST",
              `/v1/repositories/${repositoryId}/profiles`,
              { org, data: { revision: 1, config, digest } },
            );
            expectStatus(profile, 201, `profile for ${name}`);
            const current = await call(
              admin,
              "GET",
              `/v1/repositories/${repositoryId}`,
              { org },
            );
            expectStatus(current, 200, `read ${name}`);
            const activated = await call(
              admin,
              "PATCH",
              `/v1/repositories/${repositoryId}`,
              {
                org,
                data: { activeProfileId: (profile.body as { id: string }).id },
                headers: {
                  "If-Match": `"${
                    (current.body as { version: unknown }).version
                  }"`,
                },
              },
            );
            expectStatus(activated, 200, `activate profile for ${name}`);
            return repositoryId;
          };
          const task = async (
            org: string,
            applicationId: string,
            repositoryId: string | null,
            title: string,
          ) => {
            const reply = await call(admin, "POST", "/v1/tasks", {
              org,
              data: {
                applicationId,
                ...(repositoryId === null ? {} : { repositoryId }),
                taskType: "feature",
                title,
              },
            });
            expectStatus(reply, 201, `create task ${title}`);
            return (reply.body as { id: string }).id;
          };

          created.app1 = await application(B, `app1-${suffix}`, names.app1);
          created.app2 = await application(B, `app2-${suffix}`, names.app2);
          created.repo1 = await repository(B, created.app1, names.repo1);
          created.repo2 = await repository(B, created.app2, names.repo2);
          created.task1 = await task(
            B,
            created.app1,
            created.repo1,
            `Task one ${suffix}`,
          );
          created.task2 = await task(
            B,
            created.app2,
            created.repo2,
            `Task two ${suffix}`,
          );
          created.appA = await application(
            organizationA,
            `appa-${suffix}`,
            `appa-${suffix}`,
          );
          created.taskA = await task(
            organizationA,
            created.appA,
            null,
            `Task A ${suffix}`,
          );
          await selectOrganization(adminPage, nameB);
        });
        const B = organizationB!;
        const { app1: _app1, app2, repo1, task1, task2, appA, taskA } = created;
        void _app1;

        await test.step("1. an organization with only the admin shows the empty state", async () => {
          await adminPage.goto(ACCESS_PATH);
          await expect(adminPage.locator("main h1")).toHaveText("Access");
          await expect(adminPage.getByTestId("org-access-empty")).toContainText(
            "Only you are in this organization",
          );
          await expect(adminPage.getByTestId("org-access-invite-first"))
            .toBeVisible();
          await expect(adminPage.getByTestId("org-access-members")).toHaveCount(
            0,
          );
          await shot(adminPage, "01-desktop-empty");
        });

        await test.step("1b. the real member read shows loading, then a retryable error, then recovers", async () => {
          // A fresh page has an empty query cache, so every read is a real
          // request. Only the member read is steered, never answered by the
          // test: it is held in flight (loading), refused at the transport
          // (error), then passed through to the real server (retry).
          const probe = await adminContext.newPage();
          try {
            let mode: "hold" | "refuse" | "pass" = "hold";
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            await probe.route(
              /\/v1\/organizations\/[^/]+\/memberships(\?|$)/,
              async (route) => {
                if (mode === "hold") await gate;
                if (mode === "refuse") return await route.abort("failed");
                await route.continue();
              },
            );
            await probe.goto(ACCESS_PATH);
            const loading = probe.getByTestId("org-access-loading");
            await expect(loading).toBeVisible();
            await expect(probe.locator("main h1")).toHaveText("Access");
            await expect(probe.getByTestId("org-access-members")).toHaveCount(
              0,
            );
            await shot(probe, "01b-desktop-loading");
            await expectNoAxeViolations(probe);

            mode = "refuse";
            release();
            const failure = probe.getByTestId("org-access-error");
            await expect(failure).toBeVisible();
            await expect(failure).toContainText("Members could not be loaded");
            await expect(loading).toHaveCount(0);
            await expect(probe.getByTestId("org-access-members")).toHaveCount(
              0,
            );
            await shot(probe, "01c-desktop-load-error");
            await expectNoAxeViolations(probe);

            mode = "pass";
            await probe.getByRole("button", { name: "Try again" }).click();
            await expect(probe.getByTestId("org-access-empty")).toBeVisible();
            await expect(failure).toHaveCount(0);
          } finally {
            await probe.close();
          }
        });

        await test.step("2. the admin invites a guest through the page", async () => {
          await adminPage.getByTestId("org-access-invite").click();
          const form = adminPage.getByTestId("org-access-invite-form");
          await form.getByLabel("Email address").fill(guestEmail);
          await form.getByLabel("Organization role").selectOption("guest");
          const [response] = await Promise.all([
            adminPage.waitForResponse((r) =>
              r.url().endsWith(`/v1/organizations/${B}/invitations`) &&
              r.request().method() === "POST"
            ),
            form.getByTestId("org-access-invite-send").click(),
          ]);
          expect(response.status(), await response.text()).toBe(201);
          invitationId = ((await response.json()) as { id: string }).id;
          await expect(
            adminPage.getByTestId(`org-access-invitation-${invitationId}`),
          ).toContainText(guestEmail);
        });

        await test.step("3. the guest registers from the invitation and joins", async () => {
          const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
          });
          contexts.push(context);
          const page = await context.newPage();
          guest = { page, origin };
          await page.goto(`/invitations/${invitationId}`);
          await page.getByTestId("invitation-create-account").click();
          await expect(page).toHaveURL(`/register?invitation=${invitationId}`);
          await submitUntilAccepted(
            page,
            "/api/auth/sign-up/email",
            async () => {
              await page.getByLabel("Full name").fill("Access Guest");
              await page.getByLabel("Password", { exact: true }).fill(
                guestPassword,
              );
              await page.getByRole("button", {
                name: "Create account",
                exact: true,
              }).click();
            },
          );
          const rejected = page.getByRole("alert");
          if (
            await rejected.count() > 0 && await rejected.first().isVisible()
          ) {
            await testInfo.attach("register-rejected", {
              body: await rejected.first().innerText(),
              contentType: "text/plain",
            });
          }
          await expect(page.getByTestId("register-submitted")).toBeVisible();
          await page.getByRole("button", { name: "Sign in", exact: true })
            .click();
          await submitUntilAccepted(
            page,
            "/api/auth/sign-in/email",
            async () => {
              await page.getByLabel("Password", { exact: true }).fill(
                guestPassword,
              );
              await page.getByRole("button", {
                name: "Sign in and continue",
                exact: true,
              }).click();
            },
          );
          await expect(page.getByTestId("invitation-authenticated"))
            .toBeVisible();
          await page.getByTestId("invitation-accept").click();
          await expect(page.getByTestId("invitation-accepted")).toBeVisible();
          guestJoined = true;
          await page.getByTestId("invitation-open-organization").click();
          await expect(page).toHaveURL("/");
        });
        const guestActor = guest as unknown as Actor;
        const guestPage = guestActor.page;

        const guestMe = await call(guestActor, "GET", "/v1/me");
        expectStatus(guestMe, 200, "guest identity");
        const guestIdentity = guestMe.body as {
          principalId?: string;
          id?: string;
        };
        const guestPrincipalId = guestIdentity.principalId ??
          guestIdentity.id ??
          "";
        expect(guestPrincipalId).not.toBe("");
        const memberships = async () => {
          const reply = await call(
            admin,
            "GET",
            `/v1/organizations/${B}/memberships`,
            { org: B },
          );
          expectStatus(reply, 200, "list memberships of B");
          return (reply.body as {
            items: {
              id: string;
              principalId: string;
              role: string;
              status: string;
              version: number;
            }[];
          }).items;
        };
        const guestMembership = (await memberships()).find((item) =>
          item.principalId === guestPrincipalId
        )!;
        expect(guestMembership.role).toBe("guest");

        await test.step("4. a non-admin is refused in the page and by the API", async () => {
          const requested: string[] = [];
          guestPage.on("request", (request) => requested.push(request.url()));
          await guestPage.goto(ACCESS_PATH);
          await expect(guestPage.getByTestId("org-access-forbidden"))
            .toBeVisible();
          await expect(guestPage.getByTestId("org-access-members")).toHaveCount(
            0,
          );
          expect(
            requested.filter((url) =>
              /\/invitations|\/v1\/access-tokens|\/v1\/access-bindings/.test(
                url,
              )
            ),
            "a non-admin browser must not read admin lists",
          ).toEqual([]);
          await shot(guestPage, "04-guest-forbidden");
          expectStatus(
            await call(guestActor, "GET", "/v1/access-bindings", { org: B }),
            404,
            "guest lists bindings",
          );
          // A guest is hidden from the admin route altogether, even for a scope
          // it can read (step 6), so the server answers 404 before the
          // permission check (403) is reached.
          const forged = await call(guestActor, "POST", "/v1/access-bindings", {
            org: B,
            data: {
              principalId: guestPrincipalId,
              roleKey: "viewer",
              scopeType: "application",
              scopeId: app2,
            },
          });
          expectStatus(forged, 404, "guest creates a binding");
          expect(forged.code).toBe("RESOURCE_NOT_FOUND");
        });

        await test.step("5. before any binding the guest sees task one as absent", async () => {
          const hidden = await call(guestActor, "GET", `/v1/tasks/${task1}`, {
            org: B,
          });
          const absent = await call(
            guestActor,
            "GET",
            `/v1/tasks/${crypto.randomUUID()}`,
            { org: B },
          );
          expectStatus(hidden, 404, "guest reads unbound task one");
          expect(hidden.code).toBe(absent.code);
          expect(absent.status).toBe(404);
        });

        let repoBindingId = "";
        let appBindingId = "";
        let appBindingVersion: unknown = 1;
        await test.step("6. the admin binds a Repository Developer by keyboard", async () => {
          const edit = adminPage.getByTestId(
            `org-access-edit-${guestMembership.id}`,
          );
          await openAccess(adminPage, { until: edit });
          await expect(edit).toBeVisible();
          await edit.focus();
          await adminPage.keyboard.press("Enter");
          const dialog = adminPage.getByTestId("org-access-edit-dialog");
          await expect(dialog).toBeVisible();
          await typeIntoFocusedSelect(
            dialog.getByLabel("Role on the scope"),
            "Developer",
            "developer",
          );
          await typeIntoFocusedSelect(
            dialog.getByLabel("Kind of scope"),
            "Repository",
            "repository",
          );
          await typeIntoFocusedSelect(
            dialog.getByLabel("Application or repository"),
            names.repo1,
            repo1,
          );
          const add = dialog.getByTestId("org-access-binding-add");
          await add.focus();
          const [response] = await Promise.all([
            adminPage.waitForResponse((r) =>
              r.url().endsWith("/v1/access-bindings") &&
              r.request().method() === "POST"
            ),
            adminPage.keyboard.press("Enter"),
          ]);
          expect(response.status(), await response.text()).toBe(201);
          repoBindingId = ((await response.json()) as { id: string }).id;
          await expect(dialog).toContainText(
            `Repository · Developer · access/${names.repo1}`,
          );
          await shot(adminPage, "06-desktop-binding-dialog");

          // Cross-organization scope: an application of organization A is not a
          // resource of B, so the server refuses to bind it.
          const foreignScope = await call(
            admin,
            "POST",
            "/v1/access-bindings",
            {
              org: B,
              data: {
                principalId: guestPrincipalId,
                roleKey: "viewer",
                scopeType: "application",
                scopeId: appA,
              },
            },
          );
          expectStatus(foreignScope, 404, "bind an application of another org");
          expect(foreignScope.code).toBe("RESOURCE_NOT_FOUND");
          // Even holding Developer on repository one, a guest is hidden from
          // the admin route (404); the 403 anti-escalation cap is reachable
          // only by a non-guest member and is covered by resource-bindings_test.ts.
          const escalation = await call(
            guestActor,
            "POST",
            "/v1/access-bindings",
            {
              org: B,
              data: {
                principalId: guestPrincipalId,
                roleKey: "developer",
                scopeType: "repository",
                scopeId: repo1,
              },
            },
          );
          expectStatus(escalation, 404, "guest creates a binding on repo one");
          expect(escalation.code).toBe("RESOURCE_NOT_FOUND");
          const bindings = await call(admin, "GET", "/v1/access-bindings", {
            org: B,
          });
          expectStatus(bindings, 200, "list bindings of B");
          expect(bindings.text).not.toContain(appA);

          // The dialog stays open; close it so the page row is reachable.
          await adminPage.keyboard.press("Escape");
          await expect(adminPage.locator("dialog:modal")).toHaveCount(0);
          // A guest has no organization-wide access, so the row shows what the
          // scoped role grants.
          const guestRow = adminPage.getByTestId(
            `org-access-member-${guestMembership.id}`,
          );
          await expect(guestRow).toContainText("Repository · Developer");
          await expect(guestRow).toContainText(names.repo1);
        });

        await test.step("7. the next request reflects the binding", async () => {
          expectStatus(
            await call(guestActor, "GET", `/v1/tasks/${task1}`, { org: B }),
            200,
            "guest reads bound task one",
          );
          const listed = await call(guestActor, "GET", "/v1/tasks", { org: B });
          expectStatus(listed, 200, "guest lists tasks");
          expect(
            (listed.body as { items: { id: string }[] }).items.map((item) =>
              item.id
            ),
          ).toEqual([task1]);
          const hidden = await call(guestActor, "GET", `/v1/tasks/${task2}`, {
            org: B,
          });
          const absent = await call(
            guestActor,
            "GET",
            `/v1/tasks/${crypto.randomUUID()}`,
            { org: B },
          );
          expect(hidden.status).toBe(404);
          expect(hidden.code).toBe(absent.code);
          const read = await call(guestActor, "GET", `/v1/tasks/${task1}`, {
            org: B,
          });
          const renamed = await call(
            guestActor,
            "PATCH",
            `/v1/tasks/${task1}`,
            {
              org: B,
              data: { title: `Task one renamed ${suffix}` },
              headers: ifMatch((read.body as { version: unknown }).version),
            },
          );
          expectStatus(renamed, 200, "developer binding writes task one");
          await guestPage.goto("/tasks");
          await expect(
            guestPage.getByText(`Task one renamed ${suffix}`).first(),
          )
            .toBeVisible();
          await expect(guestPage.getByText(`Task two ${suffix}`)).toHaveCount(
            0,
          );
        });

        await test.step("8. an application Viewer binding widens reads only; Escape closes the dialog", async () => {
          await openAccess(adminPage);
          await adminPage.getByTestId(`org-access-edit-${guestMembership.id}`)
            .click();
          const dialog = adminPage.getByTestId("org-access-edit-dialog");
          await dialog.getByLabel("Role on the scope").selectOption("viewer");
          await dialog.getByLabel("Kind of scope").selectOption("application");
          await dialog.getByLabel("Application or repository").selectOption(
            app2,
          );
          const [response] = await Promise.all([
            adminPage.waitForResponse((r) =>
              r.url().endsWith("/v1/access-bindings") &&
              r.request().method() === "POST"
            ),
            dialog.getByTestId("org-access-binding-add").click(),
          ]);
          expect(response.status(), await response.text()).toBe(201);
          const appBinding = (await response.json()) as {
            id: string;
            version: unknown;
          };
          appBindingId = appBinding.id;
          appBindingVersion = appBinding.version;
          await expect(dialog).toContainText(
            `Application · Viewer · ${names.app2}`,
          );

          expectStatus(
            await call(guestActor, "GET", `/v1/tasks/${task2}`, { org: B }),
            200,
            "guest reads task two through the application viewer",
          );
          expectStatus(
            await call(guestActor, "PATCH", `/v1/tasks/${task2}`, {
              org: B,
              data: { title: "not allowed" },
              headers: ifMatch(1),
            }),
            403,
            "viewer binding cannot write task two",
          );
          await adminPage.keyboard.press("Escape");
          await expect(adminPage.getByTestId("org-access-edit-dialog"))
            .not.toBeVisible();
          await expect(adminPage.locator("dialog:modal")).toHaveCount(0);
        });

        await test.step("9. removing the repository binding in the edit dialog revokes access on the next request", async () => {
          await adminPage.getByTestId(`org-access-edit-${guestMembership.id}`)
            .click();
          const dialog = adminPage.getByTestId("org-access-edit-dialog");
          const row = dialog.getByTestId(
            `org-access-edit-binding-${repoBindingId}`,
          );
          await row.getByRole("button", { name: /^Remove/ }).click();
          const [response] = await Promise.all([
            adminPage.waitForResponse((r) =>
              r.url().endsWith(`/v1/access-bindings/${repoBindingId}`) &&
              r.request().method() === "DELETE"
            ),
            adminPage.getByTestId("org-access-confirm-action").click(),
          ]);
          expect(response.status()).toBe(204);
          await expect(row).toHaveCount(0);
          await adminPage.keyboard.press("Escape");
          await expect(adminPage.locator("dialog:modal")).toHaveCount(0);
          expectStatus(
            await call(guestActor, "GET", `/v1/tasks/${task1}`, { org: B }),
            404,
            "task one is hidden again after the binding is removed",
          );
          expectStatus(
            await call(guestActor, "GET", `/v1/tasks/${task2}`, { org: B }),
            200,
            "task two stays readable through the application viewer",
          );
        });

        await test.step("10. a stale removal shows the real server refusal in the dialog", async () => {
          await adminPage.getByTestId(`org-access-edit-${guestMembership.id}`)
            .click();
          const dialog = adminPage.getByTestId("org-access-edit-dialog");
          const row = dialog.getByTestId(
            `org-access-edit-binding-${appBindingId}`,
          );
          await row.getByRole("button", { name: /^Remove/ }).click();
          const gone = await call(
            admin,
            "DELETE",
            `/v1/access-bindings/${appBindingId}`,
            { org: B, headers: ifMatch(appBindingVersion) },
          );
          expectStatus(gone, 204, "out-of-band binding removal");
          const [response] = await Promise.all([
            adminPage.waitForResponse((r) =>
              r.url().endsWith(`/v1/access-bindings/${appBindingId}`) &&
              r.request().method() === "DELETE"
            ),
            adminPage.getByTestId("org-access-confirm-action").click(),
          ]);
          expect(response.status(), await response.text()).toBe(404);
          const notice = adminPage.getByTestId("org-access-notice");
          await expect(notice).toContainText("could not be removed");
          await expectPerceivable(notice);
          await expect(row).toHaveCount(0);
          await adminPage.keyboard.press("Escape");
          await expect(adminPage.locator("dialog:modal")).toHaveCount(0);
          expectStatus(
            await call(guestActor, "GET", `/v1/tasks/${task2}`, { org: B }),
            404,
            "no binding is left for the guest",
          );
        });

        await test.step("11. the last admin cannot be demoted or removed; the refusal is perceivable in the open dialog", async () => {
          const own = (await memberships()).find((item) =>
            item.principalId === adminPrincipalId
          )!;
          expect(own.role).toBe("admin");
          await openAccess(adminPage);
          await adminPage.getByTestId(`org-access-edit-${own.id}`).click();
          const dialog = adminPage.getByTestId("org-access-edit-dialog");
          await expect(dialog).toBeVisible();
          // A notice from an earlier row action must not follow into a new dialog.
          await expect(dialog.getByTestId("org-access-notice")).toHaveCount(0);
          await dialog.getByLabel("Organization role").selectOption("viewer");
          const [demote] = await Promise.all([
            adminPage.waitForResponse((r) =>
              r.url().endsWith(`/memberships/${own.id}`) &&
              r.request().method() === "PATCH"
            ),
            dialog.getByTestId("org-access-role-save").click(),
          ]);
          expect(demote.status(), await demote.text()).toBe(409);
          expect(((await demote.json()) as { code: string }).code).toBe(
            "STATE_CONFLICT",
          );
          const notice = adminPage.getByTestId("org-access-notice");
          await expectPerceivable(notice);
          await expect(dialog.getByTestId("org-access-notice")).toContainText(
            "without an admin",
          );
          await shot(adminPage, "11-desktop-refusal-in-dialog");

          await dialog.getByTestId("org-access-member-remove").click();
          const [removal] = await Promise.all([
            adminPage.waitForResponse((r) =>
              r.url().endsWith(`/memberships/${own.id}`) &&
              r.request().method() === "DELETE"
            ),
            adminPage.getByTestId("org-access-confirm-action").click(),
          ]);
          expect(removal.status(), await removal.text()).toBe(409);
          await expect(dialog).toBeVisible();
          await expectPerceivable(adminPage.getByTestId("org-access-notice"));
          await expect(dialog.getByTestId("org-access-notice")).toContainText(
            "without an admin",
          );

          await adminPage.keyboard.press("Escape");
          await expect(adminPage.locator("dialog:modal")).toHaveCount(0);
          await openAccess(adminPage);
          await expect(adminPage.getByTestId(`org-access-member-${own.id}`))
            .toContainText("Organization · Admin");
          const after = (await memberships()).find((item) =>
            item.id === own.id
          )!;
          expect([after.role, after.status]).toEqual(["admin", "active"]);
        });

        await test.step("12. a hidden task in the guest's own organization looks like a foreign one", async () => {
          const inside = await call(guestActor, "GET", `/v1/tasks/${task2}`, {
            org: B,
          });
          const foreign = await call(guestActor, "GET", `/v1/tasks/${taskA}`, {
            org: organizationA,
          });
          const randomTask = crypto.randomUUID();
          const absent = await call(
            guestActor,
            "GET",
            `/v1/tasks/${randomTask}`,
            {
              org: B,
            },
          );
          expect(inside.status).toBe(404);
          expect(foreign.status).toBe(inside.status);
          expect(foreign.code).toBe(inside.code);
          const ids = [task2, taskA, randomTask, B, organizationA];
          expect(comparable(foreign, ids)).toEqual(comparable(inside, ids));
          expect(comparable(absent, ids)).toEqual(comparable(inside, ids));
          const foreignOrganization = await call(
            guestActor,
            "GET",
            `/v1/organizations/${organizationA}`,
            { org: organizationA },
          );
          const randomOrganizationId = crypto.randomUUID();
          const randomOrganization = await call(
            guestActor,
            "GET",
            `/v1/organizations/${randomOrganizationId}`,
            { org: randomOrganizationId },
          );
          expect(foreignOrganization.status).not.toBe(200);
          const orgIds = [organizationA, randomOrganizationId];
          expect(foreignOrganization.status).toBe(randomOrganization.status);
          expect(foreignOrganization.code).toBe(randomOrganization.code);
          expect(comparable(foreignOrganization, orgIds)).toEqual(
            comparable(randomOrganization, orgIds),
          );

          await selectOrganization(adminPage, nameA);
          await openAccess(adminPage);
          await expect(adminPage.getByTestId("org-access")).toBeVisible();
          await expect(adminPage.getByTestId("org-access")).not.toContainText(
            guestEmail,
          );
          await expect(adminPage.getByTestId("org-access")).not.toContainText(
            "Access Guest",
          );
          await expect(adminPage.getByTestId("org-access")).not.toContainText(
            names.repo1,
          );
          await selectOrganization(adminPage, nameB);
        });

        await test.step("13. the page does not scroll sideways on a phone and has no axe violations", async () => {
          await openAccess(adminPage);
          await expect(adminPage.getByTestId("org-access-members"))
            .toBeVisible();
          await expectNoAxeViolations(adminPage);
          await adminPage.getByTestId(`org-access-edit-${guestMembership.id}`)
            .click();
          await expect(adminPage.getByTestId("org-access-edit-dialog"))
            .toBeVisible();
          await expectNoAxeViolations(adminPage);
          await adminPage.keyboard.press("Escape");
          await expect(adminPage.locator("dialog:modal")).toHaveCount(0);

          const storageState = await adminContext.storageState();
          const phoneContext = await browser.newContext({
            storageState,
            viewport: { width: 390, height: 844 },
          });
          contexts.push(phoneContext);
          const phone = await phoneContext.newPage();
          await phone.goto(ACCESS_PATH);
          await expect(phone.getByTestId("org-access-members")).toBeVisible();
          const overflow = await phone.evaluate(() =>
            document.documentElement.scrollWidth - globalThis.innerWidth
          );
          expect(overflow).toBeLessThanOrEqual(0);
          await shot(phone, "13-phone-access");
          await expectNoAxeViolations(phone);
        });
      } catch (error) {
        primary = error;
        writeFileSync(
          `${captureDirectory}/failure-admin-console.txt`,
          adminConsole.join("\n"),
        );
        for (
          const [name, page] of [["admin", adminPage], [
            "guest",
            guest?.page,
          ]] as const
        ) {
          try {
            if (page !== undefined) {
              await page.screenshot({
                path: `${captureDirectory}/failure-${name}.png`,
                fullPage: true,
              });
            }
          } catch {
            // The page may already be gone; the error above is the evidence.
          }
        }
      }
      {
        // Cleanup is attempted in full even when an earlier step failed, then
        // every error is rethrown together.
        const cleanupErrors: string[] = [];
        const attempt = async (
          label: string,
          work: () => void | Promise<void>,
        ) => {
          try {
            await work();
          } catch (error) {
            cleanupErrors.push(`${label}: ${String(error)}`);
          }
        };
        const B = organizationB;
        if (B !== null) {
          await attempt("leave organization B", async () => {
            const listed = await call(
              admin,
              "GET",
              `/v1/organizations/${B}/memberships`,
              { org: B },
            );
            expectStatus(listed, 200, "list memberships of B");
            const items = (listed.body as {
              items: {
                id: string;
                principalId: string;
                role: string;
                status: string;
                version: number;
              }[];
            }).items;
            const other = items.find((item) =>
              item.principalId !== adminPrincipalId && item.status === "active"
            );
            const own = items.find((item) =>
              item.principalId === adminPrincipalId
            );
            if (!guestJoined || !other || !own) {
              await testInfo.attach("ORG_B_LEFT_BEHIND", {
                body: B,
                contentType: "text/plain",
              });
              throw new Error(`ORG_B_LEFT_BEHIND ${B}: the guest never joined`);
            }
            const promoted = await call(
              admin,
              "PATCH",
              `/v1/organizations/${B}/memberships/${other.id}`,
              {
                org: B,
                data: { role: "admin" },
                headers: ifMatch(other.version),
              },
            );
            expectStatus(promoted, 200, "promote the guest in B");
            const left = await call(
              admin,
              "DELETE",
              `/v1/organizations/${B}/memberships/${own.id}`,
              { org: B, headers: ifMatch(own.version) },
            );
            expectStatus(left, 204, "the admin leaves B");
          });
          // Once the guest joined, the invitation is accepted and the admin has
          // left B, so only a guest that never joined can leave a pending one.
          if (invitationId !== null && !guestJoined) {
            await attempt("cancel a pending invitation", async () => {
              const pending = await call(
                admin,
                "GET",
                `/v1/organizations/${B}/invitations`,
                { org: B },
              );
              // A failed list could hide a pending invitation, so it is a
              // cleanup failure.
              expectStatus(pending, 200, "list invitations of B");
              const invitation = (pending.body as {
                items: { id: string; status?: string; version: number }[];
              }).items.find((item) => item.id === invitationId);
              if (
                !invitation || (invitation.status ?? "pending") !== "pending"
              ) {
                return;
              }
              expectStatus(
                await call(
                  admin,
                  "DELETE",
                  `/v1/organizations/${B}/invitations/${invitationId}`,
                  { org: B, headers: ifMatch(invitation.version) },
                ),
                204,
                "cancel the pending invitation",
              );
            });
          }
          await attempt("remove the guest", () => {
            execFileSync("deno", [
              "run",
              "--allow-env",
              "--allow-net",
              "--allow-read",
              seedScriptPath,
              "--purge-user",
              guestEmail,
            ], { encoding: "utf8", env: process.env });
          });
        }
        if (restoreRegistration !== null) {
          await attempt("restore the registration mode", async () => {
            const settings = await call(
              admin,
              "GET",
              "/v1/installation/settings",
            );
            expectStatus(settings, 200, "installation settings");
            const current = settings.body as {
              organizationCreationPolicy: string;
              version: number;
            };
            const restored = await call(
              admin,
              "PATCH",
              "/v1/installation/settings",
              {
                data: {
                  registrationMode: restoreRegistration,
                  organizationCreationPolicy:
                    current.organizationCreationPolicy,
                },
                headers: ifMatch(current.version),
              },
            );
            expectStatus(restored, 200, "restore registration mode");
          });
        }
        await attempt(
          "the admin ends with only the seeded organization",
          async () => {
            const listed = await call(admin, "GET", "/v1/organizations");
            expectStatus(listed, 200, "list organizations");
            expect(
              (listed.body as { items: { id: string }[] }).items.map((item) =>
                item.id
              ),
            ).toEqual([organizationA]);
          },
        );
        for (const context of contexts) {
          await attempt("close context", () => context.close());
        }
        if (cleanupErrors.length > 0) {
          if (primary !== null) {
            await testInfo.attach("cleanup-errors", {
              body: cleanupErrors.join("\n"),
              contentType: "text/plain",
            });
          } else {
            primary = new Error(cleanupErrors.join("\n"));
          }
        }
      }
      if (primary !== null) throw primary;
    },
  );
});
