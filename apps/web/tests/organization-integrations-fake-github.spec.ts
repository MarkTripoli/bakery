import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";

/**
 * Browser proof of the whole GitHub setup against the real API: a Deno child
 * (tests/helpers/github-connect-server.child.ts) runs the real Bakery app on
 * a real test database with the in-memory fake GitHub App injected. Bakery's
 * own requests are forwarded to it unchanged, with the seeded Admin's session
 * cookie and the API's own Origin; only the github.com pages are played by the spec, through the
 * child's fake. Nothing reaches github.com.
 *
 * Needs a migrated test database (`DATABASE_URL`, `BAKERY_APP_DATABASE_URL`)
 * and `deno`: it runs in the CI real-API browser lanes (`BAKERY_REAL_API=1`),
 * or locally with `BAKERY_FAKE_GITHUB=1`. It replaces the one GitHub App
 * registration, so it runs serially in the shared-admin project, never in two
 * projects at once. `BAKERY_EVIDENCE_VIDEO=1` records video.
 */
const enabled = process.env.BAKERY_REAL_API === "1" ||
  process.env.BAKERY_FAKE_GITHUB === "1";
const APP_NAME = "Acme Bakery Preview";
const INSTALLATION_PAGE = "/settings/installation/integrations";
const CONNECT_PAGE = "/settings/organization/integrations";

type Server = {
  apiUrl: string;
  controlUrl: string;
  publicOrigin: string;
  adminCookie: string;
  organizationId: string;
};

test.use({ video: process.env.BAKERY_EVIDENCE_VIDEO === "1" ? "on" : "off" });

test.describe("GitHub setup against the real API and the fake GitHub App", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 or BAKERY_FAKE_GITHUB=1 with a test database for the child API",
  );

  let child: ChildProcess;
  let server: Server;
  const manifests: { name: string }[] = [];

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const root = new URL("../../../", import.meta.url);
    child = spawn("deno", [
      "run",
      "--allow-all",
      "--config",
      fileURLToPath(new URL("deno.json", root)),
      fileURLToPath(
        new URL("tests/helpers/github-connect-server.child.ts", root),
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

  const control = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${server.controlUrl}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.ok, path).toBe(true);
    return await response.json() as Record<string, string>;
  };

  /** Bakery's API through the child, as the seeded Admin; never mocked. */
  async function connect(page: Page, baseURL: string) {
    const forward = async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await route.fetch({
        url: `${server.apiUrl}${url.pathname}${url.search}`,
        // The API's CSRF check expects its own public origin.
        headers: {
          ...request.headers(),
          cookie: server.adminCookie,
          ...(request.headers().origin ? { origin: server.publicOrigin } : {}),
        },
        maxRedirects: 0,
      });
      await route.fulfill({ response });
    };
    await page.route(`${baseURL}/v1/**`, forward);
    await page.route(`${baseURL}/api/**`, forward);
    // A page that navigates on, not a 303: Playwright does not route the
    // hops of a fulfilled redirect, and Bakery's must reach the child.
    const redirect = (route: Route, path: string) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><title>GitHub</title><script>location.replace(${
          JSON.stringify(`${baseURL}${path}`)
        })</script>`,
      });
    await page.route("https://github.com/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const state = url.searchParams.get("state") ?? "";
      if (
        request.method() === "POST" && url.pathname === "/settings/apps/new"
      ) {
        const manifest = new URLSearchParams(request.postData() ?? "").get(
          "manifest",
        )!;
        manifests.push(JSON.parse(manifest));
        const { code } = await control("/manifest", { manifest });
        return redirect(
          route,
          `/v1/integration-auth/github/manifest-callback?${new URLSearchParams(
            { code, state },
          )}`,
        );
      }
      const install = /^\/apps\/([a-z0-9-]+)\/installations\/new$/.exec(
        url.pathname,
      );
      if (install) {
        const { installationId } = await control("/install", {
          slug: install[1],
        });
        return redirect(
          route,
          `/v1/integration-auth/github/setup?${new URLSearchParams({
            installation_id: String(installationId),
            setup_action: "install",
            state,
          })}`,
        );
      }
      if (url.pathname === "/login/oauth/authorize") {
        const { code } = await control("/authorize", {
          authorizationUrl: url.href,
        });
        return redirect(
          route,
          `/v1/integration-auth/github/callback?${new URLSearchParams({
            code,
            state,
          })}`,
        );
      }
      return route.fulfill({ status: 404, body: "not a GitHub page here" });
    });
  }

  test("the App name the administrator types is the name GitHub registers", async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    await connect(page, baseURL!);
    await page.goto(INSTALLATION_PAGE);
    const name = page.getByRole("textbox", { name: "App name" });
    await expect(name).toBeVisible();
    await name.fill(APP_NAME);
    await page.getByRole("button", { name: "Create GitHub App" }).click();
    await expect(page).toHaveURL(/githubAppRegistration=registered/);
    expect(manifests.map((manifest) => manifest.name)).toEqual([APP_NAME]);
    await expect(page.getByText(APP_NAME, { exact: true })).toBeVisible();
    await expect(page.getByText("acme-bakery-preview", { exact: true }))
      .toBeVisible();
  });

  test("Connect GitHub installs, authorizes and lands on a pending connection; select, enable and check make it healthy", async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await connect(page, baseURL!);
    await page.goto(CONNECT_PAGE);
    await expect(page.getByText("No GitHub connection yet")).toBeVisible();
    await page.getByRole("button", { name: "Connect GitHub", exact: true })
      .click();
    // Install page, Setup URL (awaiting_authorization), automatic hop to
    // authorization, OAuth callback: no hand-run step in between.
    await expect(page).toHaveURL(
      /githubConnection=pending&connectionId=[0-9a-f-]{36}/,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("github-connection-outcome")).toContainText(
      "GitHub is connected. Select at least one repository",
    );
    expect(
      await page.evaluate(() => sessionStorage.getItem("bakery.githubConnect")),
    ).toBeNull();
    const panel = page.getByTestId("github-connection");
    await expect(panel).toHaveAttribute("data-highlighted", "true");
    await expect(panel.getByText("acme-org", { exact: true })).toBeVisible();
    await expect(panel.getByText("Needs setup")).toBeVisible();
    const enable = panel.getByRole("button", { name: "Enable connection" });
    await expect(enable).toBeDisabled();
    for (const repository of ["bakery", "tools", "docs"]) {
      await expect(panel.getByRole("checkbox", { name: repository }))
        .not.toBeChecked();
    }
    await panel.getByRole("checkbox", { name: "bakery" }).click();
    await expect(panel.getByRole("checkbox", { name: "bakery" }))
      .toBeChecked();
    await expect(panel.getByText("Repositories (1 selected)")).toBeVisible();
    await enable.click();
    await expect(panel.getByText("Enabled", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Check connection" }).click();
    const result = panel.getByTestId("github-connection-check");
    await expect(result.getByText("Healthy", { exact: true })).toBeVisible();
    await expect(result.getByRole("list")).toBeVisible();
    await expect(panel.getByText("Never")).toHaveCount(0);
    // The reloaded list agrees with what the server stored.
    await page.goto(CONNECT_PAGE);
    await expect(
      page.getByTestId("github-connection").getByText("Enabled", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("a GitHub redirect Bakery refuses lands on the page with its message", async ({ page, baseURL }) => {
    await connect(page, baseURL!);
    // A state Bakery never issued, as GitHub would send a stale one.
    await page.goto(
      `/v1/integration-auth/github/setup?${new URLSearchParams({
        installation_id: "12345",
        setup_action: "install",
        state: "Z".repeat(43),
      })}`,
    );
    await expect(page).toHaveURL(
      `${CONNECT_PAGE}?githubConnection=state_rejected`,
    );
    await expect(page.getByTestId("github-connection-outcome")).toContainText(
      "The GitHub link expired or was started in another browser session.",
    );
    // An install that needs an owner's approval carries no installation id.
    await page.goto(
      `/v1/integration-auth/github/setup?${new URLSearchParams({
        setup_action: "request",
        state: "Z".repeat(43),
      })}`,
    );
    await expect(page.getByTestId("github-connection-outcome")).toContainText(
      "sent your install request to an owner",
    );
  });

  test("every outcome the callbacks can send shows its message", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await connect(page, baseURL!);
    for (
      const outcome of [
        "pending",
        "refreshed",
        "awaiting_authorization",
        "awaiting_installation",
        "installation_requested",
        "state_rejected",
        "expired",
        "authorization_denied",
        "provider_unregistered",
        "exchange_failed",
        "installation_listing_failed",
        "repository_listing_failed",
        "installation_unverified",
        "installation_check_failed",
        "installation_suspended",
        "admin_required",
        "already_connected",
        "reconnect_unavailable",
        "storage_failed",
      ]
    ) {
      await page.goto(`${CONNECT_PAGE}?githubConnection=${outcome}`);
      const banner = page.getByTestId("github-connection-outcome");
      await expect(banner).toHaveAttribute("data-outcome", outcome);
      await expect(banner).not.toBeEmpty();
    }
  });
});
