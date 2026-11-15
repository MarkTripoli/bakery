import { expect, type Page, test } from "@playwright/test";
import {
  type Options,
  type Profile,
  REPOSITORY_ID,
  repositoryFixture,
} from "./helpers/repository-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * One repository's page (design-ux, #65, slice 2a): the setup steps (the
 * connection, the working settings) and the working-settings sheet, whose
 * version number is worked out by the page and never typed.
 */

const SETTINGS: Profile[] = [
  { revision: 1, branches: ["main"] },
  { revision: 2, branches: ["main", "release/*"] },
];

async function open(page: Page, options: Options = {}) {
  const fixture = await repositoryFixture(page, options);
  await page.goto(`/projects/repositories/${REPOSITORY_ID}`);
  // The reads can be slow on a busy host: wait for the page itself once, so a
  // later assertion never fails for the load alone.
  if (options.repositoryStatus === undefined) {
    await expect(page.getByTestId("setup-settings")).toBeVisible({
      timeout: 20_000,
    });
  }
  return fixture;
}
const sheet = (page: Page) =>
  page.getByRole("dialog", { name: "Working settings" });

test.describe("a repository with no working settings", () => {
  test("shows what is known and the one next action", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("heading", { name: "acme/api-service" }))
      .toBeVisible();
    await expect(page.getByText("Checkout · default branch main"))
      .toBeVisible();
    await expect(page.getByText("Not set up")).toBeVisible();
    const connection = page.getByTestId("setup-connection");
    await expect(connection).toContainText("Connected to GitHub");
    await expect(connection).toContainText("Through the acme-org connection.");
    await expect(page.getByTestId("setup-settings")).toContainText(
      "Choose which branches Bakery may work from.",
    );
    await expect(page.getByTestId("setup-check")).toContainText(
      "Choose working settings first.",
    );
    await expect(
      page.getByText("Bakery can start tasks here once all three are done."),
    ).toBeVisible();
    // The open step is in progress (not a warning), and its action is label-wide
    // at the end of the step's line on desktop, full width only on a phone.
    await expect(page.getByTestId("setup-settings")).toHaveAttribute(
      "data-state",
      "running",
    );
    const choose = await page.getByRole("button", { name: "Choose settings" })
      .boundingBox();
    const step = await page.getByTestId("setup-settings").boundingBox();
    if (test.info().project.name === "mobile") {
      expect(choose!.width).toBeGreaterThan(step!.width * 0.7);
    } else {
      expect(choose!.width).toBeLessThan(step!.width * 0.3);
      expect(choose!.x + choose!.width).toBeGreaterThan(
        step!.x + step!.width * 0.7,
      );
    }
    // One primary button on the page: the next setup action.
    await expect(
      page.getByRole("button", { name: "Choose settings" }),
    ).toBeEnabled();
    await expect(page.getByRole("button", { name: "Open the readiness check" }))
      .toHaveCount(0);
    // No sideways scroll at any width.
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
    await page.mouse.move(700, 700);
    await shot(page, "repository-page-not-set-up");
  });

  test("Choose settings saves version 1 and puts it in use", async ({ page }) => {
    const { seen } = await open(page);
    await page.getByRole("button", { name: "Choose settings" }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(page.getByLabel("Branches Bakery may work from")).toHaveValue(
      "main",
    );
    await expect(page.getByText("This saves version 1.")).toBeVisible();
    await expect(
      page.getByText(
        "Bakery starts work only from the branches you list here.",
      ),
    ).toBeVisible();
    // There are no versions yet, so there is no Versions section.
    await expect(page.getByRole("heading", { name: "Versions" })).toHaveCount(
      0,
    );
    await shot(page, "repository-settings-first");
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId("setup-settings")).toContainText(
      "Works from main · version 1",
    );
    expect(seen.createdProfiles).toHaveLength(1);
    const created = seen.createdProfiles[0] as {
      revision: number;
      digest: string;
      config: unknown;
    };
    expect(created.revision).toBe(1);
    expect(created.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(created.config).toEqual({
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      branches: { base: "main", allowedPatterns: ["main"] },
      worktree: { root: "." },
    });
    expect(seen.updates).toHaveLength(1);
    expect(seen.updates[0].ifMatch).toBe('"v1"');
    expect(seen.updates[0].body).toMatchObject({
      activeProfileId: expect.any(String),
    });
    // With settings in use, the readiness check is the next step, with a way to it.
    await expect(page.getByTestId("setup-check")).toContainText(
      "Run the check to see whether Bakery can work here.",
    );
    await expect(
      page.getByTestId("setup-check").getByRole("button", {
        name: "Open the readiness check",
      }),
    ).toBeVisible();
    await page.mouse.move(700, 700);
    await shot(page, "repository-page-set-up");
    await expect(page.getByText("Not set up")).toHaveCount(0);
  });

  test("an empty branch list or a bad folder is refused in words, with nothing sent", async ({ page }) => {
    const { seen } = await open(page);
    await page.getByRole("button", { name: "Choose settings" }).click();
    await page.getByLabel("Branches Bakery may work from").fill("  \n ");
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(page.getByText("Enter at least one branch.")).toBeVisible();
    await expect(page.getByLabel("Branches Bakery may work from"))
      .toHaveAttribute(
        "aria-invalid",
        "true",
      );
    await page.getByLabel("Branches Bakery may work from").fill("main");
    await page.getByRole("button", { name: "Advanced" }).click();
    await page.getByLabel("Working folder").fill("/abs");
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(page.getByText(/Enter a folder inside the repository/))
      .toBeVisible();
    expect(seen.createdProfiles).toHaveLength(0);
    await page.getByLabel("Working folder").fill("packages/web");
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    expect(
      (seen.createdProfiles[0] as { config: { worktree: unknown } }).config
        .worktree,
    ).toEqual({ root: "packages/web" });
  });
});

test.describe("a repository with working settings", () => {
  const WORLD: Options = { profiles: SETTINGS, active: 2 };

  test("shows the version in use and Change opens the sheet with it", async ({ page }) => {
    await open(page, WORLD);
    await expect(page.getByTestId("setup-settings")).toContainText(
      "Works from main, release/* · version 2",
    );
    await page.getByRole("button", { name: "Change" }).click();
    await expect(page.getByLabel("Branches Bakery may work from")).toHaveValue(
      "main\nrelease/*",
    );
    await expect(
      page.getByText(
        "This saves version 3. Tasks already running keep version 2.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Versions" })).toBeVisible();
    await expect(page.getByTestId("profile-version-2")).toContainText("In use");
    await expect(page.getByTestId("profile-version-1")).toContainText(
      "Version 1",
    );
    await page.mouse.move(700, 700);
    await shot(page, "repository-settings-change");
  });

  test("saving keeps what else the version holds and takes the next number", async ({ page }) => {
    const { seen } = await open(page, WORLD);
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByLabel("Branches Bakery may work from").fill(
      "main\nrelease/*\nhotfix/*",
    );
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    expect((seen.createdProfiles[0] as { revision: number }).revision).toBe(3);
    await expect(page.getByTestId("setup-settings")).toContainText(
      "Works from main, release/*, hotfix/* · version 3",
    );
  });

  test("Use version asks first, says what changes, and only then acts", async ({ page }) => {
    const { seen } = await open(page, WORLD);
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Use version 1" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Use version 1?" });
    await expect(confirm).toContainText(
      "New tasks use version 1. Tasks already running keep version 2.",
    );
    await shot(page, "repository-use-version");
    // Cancel changes nothing.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(seen.updates).toHaveLength(0);
    await page.getByRole("button", { name: "Use version 1" }).click();
    await confirm.getByRole("button", { name: "Use version 1" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("profile-version-1")).toContainText("In use");
    expect(seen.createdProfiles).toHaveLength(0);
    expect(seen.updates).toHaveLength(1);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("setup-settings")).toContainText(
      "Works from main · version 1",
    );
  });

  test("every page of versions is read before a number is chosen", async ({ page }) => {
    const many: Profile[] = Array.from({ length: 5 }, (_, i) => ({
      revision: i + 1,
      branches: ["main"],
    }));
    const { seen } = await open(page, {
      profiles: many,
      active: 5,
      pageSize: 2,
    });
    await expect(page.getByTestId("setup-settings")).toContainText("version 5");
    expect(seen.profileReads).toBeGreaterThanOrEqual(3);
    await page.getByRole("button", { name: "Change" }).click();
    await expect(page.getByText(/This saves version 6\./)).toBeVisible();
  });
});

test.describe("when a change does not go through", () => {
  test("a taken version number says someone else changed it and keeps the sheet", async ({ page }) => {
    await open(page, { profiles: SETTINGS, active: 2, save: "conflict" });
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(page.getByText(/Someone else changed this repository/))
      .toBeVisible();
    await expect(sheet(page)).toBeVisible();
  });

  test("a retry after a lost answer keeps its idempotency key; a refusal takes a new one", async ({ page }) => {
    const { seen } = await open(page, { save: "down" });
    await page.getByRole("button", { name: "Choose settings" }).click();
    const save = page.getByRole("button", {
      name: "Save and use these settings",
    });
    await save.click();
    await expect(page.getByText("The settings could not be saved. Try again."))
      .toBeVisible();
    await save.click();
    await expect.poll(() => seen.createKeys.length).toBe(2);
    expect(seen.createKeys[0]).not.toBeNull();
    expect(seen.createKeys[1]).toBe(seen.createKeys[0]);
  });

  test("saved but not in use says which version to use", async ({ page }) => {
    await open(page, { profiles: SETTINGS, active: 2, use: "down" });
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(page.getByText(/Version 3 was saved but is not in use yet/))
      .toBeVisible();
    await expect(page.getByTestId("profile-version-3")).toBeVisible();
  });

  test("Use version that fails says so and keeps the sheet", async ({ page }) => {
    await open(page, { profiles: SETTINGS, active: 2, use: "down" });
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Use version 1" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Use version 1?" });
    await confirm.getByRole("button", { name: "Use version 1" }).click();
    await expect(
      confirm.getByText("The version could not be put in use. Try again."),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("profile-version-2")).toContainText("In use");
  });
});

test.describe("who may change it, and what the page cannot know", () => {
  test("a developer sees the settings and cannot change them", async ({ page }) => {
    await open(page, { role: "developer", profiles: SETTINGS, active: 2 });
    await expect(
      page.getByText(
        "Only organization administrators can change a repository's settings.",
      ).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Change" }).click();
    await expect(
      page.getByRole("button", { name: "Save and use these settings" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Use version 1" }))
      .toBeDisabled();
  });

  test("an archived repository cannot be changed", async ({ page }) => {
    await open(page, { archived: true });
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose settings" }))
      .toBeDisabled();
  });

  test("a connection that is not working is a failed step with a way to Integrations", async ({ page }) => {
    await open(page, { connection: "revoked" });
    await expect(page.getByTestId("setup-connection")).toContainText(
      "The acme-org connection is not working",
    );
    await page.getByRole("button", { name: "Open Integrations" }).click();
    await expect(page).toHaveURL(/\/settings\/organization\/integrations/);
  });

  test("a connection that cannot be read is Not known, never Done", async ({ page }) => {
    await open(page, { connection: "missing" });
    await expect(page.getByTestId("setup-connection")).toContainText(
      "The connection could not be read.",
    );
    await expect(page.getByTestId("setup-connection")).not.toContainText(
      "Through the",
    );
  });

  test("a repository that is not there, not allowed, or failing each say so", async ({ page }) => {
    await open(page, { repositoryStatus: 404 });
    await expect(page.getByText("Repository not found")).toBeVisible();
    await page.getByRole("button", { name: "Back to Projects" }).click();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test("a forbidden read is its own state", async ({ page }) => {
    await open(page, { repositoryStatus: 403 });
    await expect(page.getByText("You cannot see this repository"))
      .toBeVisible();
  });

  test("a failing read is an error with Try again", async ({ page }) => {
    await open(page, { repositoryStatus: 500 });
    await expect(page.getByText("The repository could not be loaded."))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
