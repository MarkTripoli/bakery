import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";
import { shot } from "./helpers/real-api.ts";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

// #70 part B: adding a machine is a wizard of three steps (name and system,
// coding agent, install) that creates one setup and waits for the machine.

const ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000e1";
const SECOND_ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000e2";
const MACHINE_ID = "00000000-0000-4000-8000-0000000000a1";
const SETUP_CODE = "fixture-setup-code-0001";
const NEW_SETUP_CODE = "fixture-setup-code-0002";
const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Setup = {
  /** What a read of the enrollment says. */
  state: "pending" | "consumed" | "canceled" | "expired";
  workerHostId: string | null;
  /** Requests the page made, to look at afterwards. */
  creates: Request[];
  replacements: Request[];
  /** The first `failures` creates are refused. */
  failures: number;
  /** Rows the enrollments list returns. */
  list: unknown[];
};

function newSetup(overrides: Partial<Setup> = {}): Setup {
  return {
    state: "pending",
    workerHostId: null,
    creates: [],
    replacements: [],
    failures: 0,
    list: [],
    ...overrides,
  };
}

async function open(
  page: Page,
  setup: Setup,
  options: { role?: "admin" | "developer"; path?: string } = {},
) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: options.role ?? "admin",
        capabilities: [],
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/worker-enrollments",
    (route) => {
      if (route.request().method() === "POST") {
        setup.creates.push(route.request());
        if (setup.failures > 0) {
          setup.failures -= 1;
          return route.fulfill({
            status: 500,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/x",
              title: "x",
              status: 500,
              code: "INTERNAL",
            }),
          });
        }
        return route.fulfill(json({
          enrollmentId: ENROLLMENT_ID,
          enrollmentToken: SETUP_CODE,
          expiresAt: inMinutes(10),
        }, 201));
      }
      return route.fulfill(json({ items: setup.list, nextCursor: null }));
    },
  );
  await page.route(
    (url) => url.pathname.endsWith("/replacements"),
    (route) => {
      setup.replacements.push(route.request());
      return route.fulfill(json({
        enrollmentId: SECOND_ENROLLMENT_ID,
        enrollmentToken: NEW_SETUP_CODE,
        expiresAt: inMinutes(10),
      }, 201));
    },
  );
  await page.route(
    (url) => /^\/v1\/worker-enrollments\/[0-9a-f-]{36}$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop();
      return route.fulfill(json({
        enrollmentId: id,
        organizationId: MOCK_ORGANIZATION_ID,
        state: id === SECOND_ENROLLMENT_ID ? "pending" : setup.state,
        expiresAt: inMinutes(10),
        workerHostId: id === SECOND_ENROLLMENT_ID ? null : setup.workerHostId,
        worker: null,
        version: 1,
        snapshotCursor: null,
      }));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/workers",
    (route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.goto(options.path ?? "/machines/new");
}

const settingsOf = (page: Page) =>
  page.locator("[data-ui-component=codeBlock]").filter({
    hasText: "BAKERY_SERVER_URL=",
  });

test.describe("add a machine wizard", () => {
  test("three steps create one setup and wait for the machine to connect", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
      .catch(() => undefined);
    const setup = newSetup();
    await open(page, setup);
    await expect(page.getByRole("heading", { name: "Add a machine", level: 1 }))
      .toBeVisible();
    await expect(page.getByText("Step 1 of 3 · Name and system")).toBeVisible();
    await expect(page.getByText("Windows is not supported yet.")).toBeVisible();
    // The old form's words are gone.
    for (
      const word of [
        "Capabilities",
        "Dispatch slots",
        "enrollment",
        "worker host",
      ]
    ) {
      await expect(page.getByText(word, { exact: false })).toHaveCount(0);
    }

    // Step 1 refuses an empty name and a bad number of slots, in words.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter a name.")).toBeVisible();
    await page.getByLabel("Name").fill("build-mac-01");
    await page.getByLabel("How many tasks at once").fill("0");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter a whole number from 1 to 100."))
      .toBeVisible();
    await page.getByLabel("How many tasks at once").fill("2");
    // The processor follows the system until it is changed.
    await expect(page.getByRole("radio", { name: /Intel or AMD/ }))
      .toBeChecked();
    await page.getByRole("radio", { name: "macOS" }).check({ force: true });
    await expect(page.getByRole("radio", { name: /Apple silicon/ }))
      .toBeChecked();
    await expect(page.getByRole("link", { name: /Name/ })).toHaveCount(0);
    await shot(page, "machines-wizard-system");
    const axeSystem = await new AxeBuilder({ page }).analyze();
    expect(axeSystem.violations.map((v) => v.id)).toEqual([]);
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2: one coding agent, with the line about paying later.
    await expect(page.getByText("Step 2 of 3 · Coding agent")).toBeVisible();
    await expect(
      page.getByText(
        "You choose how it pays for models after the machine connects.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Choose a coding agent to continue."))
      .toBeVisible();
    await page.getByRole("radio", { name: /Codex/ }).check({ force: true });
    await shot(page, "machines-wizard-agent");
    const axeAgent = await new AxeBuilder({ page }).analyze();
    expect(axeAgent.violations.map((v) => v.id)).toEqual([]);
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 3: one setup is created, with exactly what the answers say.
    await expect(page.getByText("Step 3 of 3 · Install")).toBeVisible();
    await expect(page.getByText(SETUP_CODE)).toBeVisible();
    expect(setup.creates).toHaveLength(1);
    expect(setup.creates[0]!.headers()["idempotency-key"]).toBeTruthy();
    expect(setup.creates[0]!.postDataJSON()).toEqual({
      name: "build-mac-01",
      os: "macos",
      architecture: "arm64",
      capabilities: ["git", "shell", "web", "model", "codex"],
      slots: 2,
    });
    await expect(page.getByText(/These settings work for (9|10) minutes\./))
      .toBeVisible();
    for (
      const [n, text] of [
        [1, "Copy the setup code. It is shown once."],
        [
          2,
          "On the machine, save the code in a file that only its owner can read.",
        ],
        [3, "Give Bakery on the Mac these settings."],
        [4, "Start Bakery on the Mac with these settings."],
      ] as const
    ) {
      await expect(page.getByRole("heading", { name: `${n}. ${text}` }))
        .toBeVisible();
    }
    const settings = settingsOf(page);
    await expect(settings).toContainText("BAKERY_WORKER_NAME=build-mac-01");
    await expect(settings).toContainText("BAKERY_WORKER_SLOTS=2");
    await expect(settings).toContainText(
      "BAKERY_WORKER_CAPABILITIES=git,shell,web,model,codex",
    );
    await expect(settings).toContainText("BAKERY_CODEX_HARNESS=1");
    await expect(settings).not.toContainText(/CLAUDE|BAKERY_PI_/);
    // The setup code travels in a file; it is not in the settings, and the
    // page keeps it out of the address and the browser's storage.
    await expect(settings).not.toContainText(SETUP_CODE);
    expect(page.url()).not.toContain(SETUP_CODE);
    const stored = await page.evaluate(() =>
      JSON.stringify([
        ...Object.entries(localStorage),
        ...Object.entries(sessionStorage),
      ])
    );
    expect(stored).not.toContain(SETUP_CODE);
    await expect(page.getByText("Waiting for the machine to connect…"))
      .toBeVisible();
    // No command to start Bakery on a Mac is invented.
    await expect(
      page.locator("[data-ui-component=codeBlock]").filter({
        hasText: "systemctl",
      }),
    ).toHaveCount(0);
    // "harness" is only ever inside a setting name.
    await expect(page.getByText(/harness/i).and(page.locator(":not(code)")))
      .toHaveCount(0);
    await page.getByRole("button", { name: "Copy" }).first().click();
    await shot(page, "machines-wizard-install");
    const axeInstall = await new AxeBuilder({ page }).analyze();
    expect(axeInstall.violations.map((v) => v.id)).toEqual([]);

    // The machine connects: the page says so and leads to the machine.
    setup.state = "consumed";
    setup.workerHostId = MACHINE_ID;
    await expect(page.getByText("Connected.")).toBeVisible({ timeout: 30_000 });
    await shot(page, "machines-wizard-connected");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page).toHaveURL(new RegExp(`/machines/${MACHINE_ID}$`));
    expect(setup.creates).toHaveLength(1);
  });

  test("a Linux machine gets its environment file and the command that starts it", async ({ page }) => {
    const setup = newSetup();
    await open(page, setup);
    await page.getByLabel("Name").fill("ci-linux-02");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: /Claude Code/ }).check({
      force: true,
    });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(SETUP_CODE)).toBeVisible();
    expect(setup.creates[0]!.postDataJSON()).toMatchObject({
      os: "linux",
      architecture: "x86_64",
      slots: 1,
      capabilities: ["git", "shell", "web", "model", "claude"],
    });
    await expect(
      page.getByRole("heading", {
        name: "3. Add these settings to /etc/bakery/worker.env.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "4. Start Bakery on the machine." }),
    )
      .toBeVisible();
    await expect(
      page.locator("[data-ui-component=codeBlock]").filter({
        hasText: "sudo systemctl enable --now bakery-worker",
      }),
    ).toBeVisible();
    await expect(
      page.locator("[data-ui-component=codeBlock]").filter({
        hasText: "cat > /var/lib/bakery/worker/enrollment-token",
      }),
    ).toBeVisible();
    const settings = settingsOf(page);
    await expect(settings).toContainText("BAKERY_CLAUDE_HARNESS=1");
    await expect(settings).toContainText(
      "BAKERY_CLAUDE_HARNESS_EXECUTABLE=claude",
    );
    await expect(settings).not.toContainText(/CODEX|BAKERY_PI_/);
  });

  test("a failed create says so and the retry is the same request", async ({ page }) => {
    const setup = newSetup({ failures: 1 });
    await open(page, setup);
    await page.getByLabel("Name").fill("retry-box");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: /Pi/ }).check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("Bakery could not create the settings. Try again."),
    ).toBeVisible();
    await shot(page, "machines-wizard-failed");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(SETUP_CODE)).toBeVisible();
    expect(setup.creates).toHaveLength(2);
    // The same idempotency key: a retry can never make two setups.
    expect(setup.creates[1]!.headers()["idempotency-key"]).toBe(
      setup.creates[0]!.headers()["idempotency-key"],
    );
  });

  test("a setup whose settings expired offers new ones", async ({ page }) => {
    const setup = newSetup({ state: "expired" });
    await open(page, setup);
    await page.getByLabel("Name").fill("late-box");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: /Claude Code/ }).check({
      force: true,
    });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("The settings expired.")).toBeVisible();
    await shot(page, "machines-wizard-expired");
    await page.getByRole("button", { name: "Get new settings" }).click();
    await expect(page.getByText(NEW_SETUP_CODE)).toBeVisible();
    expect(setup.replacements).toHaveLength(1);
    expect(setup.replacements[0]!.url()).toContain(
      `/worker-enrollments/${ENROLLMENT_ID}/replacements`,
    );
    expect(setup.replacements[0]!.headers()["idempotency-key"]).toBeTruthy();
    await expect(page.getByText("The settings expired.")).toHaveCount(0);
  });

  test("continuing a setup that was left asks for new settings and keeps its answers", async ({ page }) => {
    const setup = newSetup({
      list: [{
        enrollmentId: ENROLLMENT_ID,
        state: "pending",
        name: "half-done-box",
        os: "linux",
        architecture: "arm64",
        capabilities: ["git", "shell", "web", "model", "claude"],
        slots: 3,
        expiresAt: inMinutes(5),
        consumedAt: null,
        canceledAt: null,
        workerHostId: null,
        replacementOfId: null,
        targetWorkerHostId: null,
        version: 4,
      }],
    });
    await open(page, setup, {
      path: `/machines/new?finish=${ENROLLMENT_ID}`,
    });
    await expect(page.getByText("Step 3 of 3 · Install")).toBeVisible();
    await expect(
      page.getByText(
        "The setup code for half-done-box was shown once and is not available again.",
      ),
    ).toBeVisible();
    await shot(page, "machines-wizard-continue");
    expect(setup.creates).toHaveLength(0);
    await page.getByRole("button", { name: "Get new settings" }).click();
    await expect(page.getByText(NEW_SETUP_CODE)).toBeVisible();
    expect(setup.replacements).toHaveLength(1);
    const settings = settingsOf(page);
    await expect(settings).toContainText("BAKERY_WORKER_NAME=half-done-box");
    await expect(settings).toContainText("BAKERY_WORKER_SLOTS=3");
    await expect(settings).toContainText("BAKERY_CLAUDE_HARNESS=1");
    expect(setup.creates).toHaveLength(0);
  });

  test("only an administrator can add a machine", async ({ page }) => {
    const setup = newSetup();
    await open(page, setup, { role: "developer" });
    await expect(page.getByText("Only administrators can add machines"))
      .toBeVisible();
    await expect(
      page.getByText("Ask an organization administrator to add one."),
    )
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await shot(page, "machines-wizard-member");
    expect(setup.creates).toHaveLength(0);
  });
});
