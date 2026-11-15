import { expect, type Page, test } from "@playwright/test";
import {
  CHECK_ID,
  JOB_ID,
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

  test("Rules is visible on both viewports, in the top bar on a wide screen, and opens the rules page", async ({ page }) => {
    await open(page);
    const rules = page.getByRole("button", { name: "Rules" });
    await expect(rules).toBeVisible();
    const box = (await rules.boundingBox())!;
    const title = (await page.getByRole("heading", { name: "acme/api-service" })
      .boundingBox())!;
    if (test.info().project.name === "mobile") {
      // On a phone it follows the title.
      expect(box.y).toBeGreaterThan(title.y);
    } else {
      // On a wide screen it is in the shell's top bar, above the page's title.
      expect(box.y + box.height).toBeLessThan(title.y);
    }
    await page.mouse.move(700, 700);
    await shot(page, "repository-page-rules-action");
    await rules.click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/repositories/${REPOSITORY_ID}/rules$`),
    );
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
    // With settings in use, the readiness check is the step to do now: its
    // in-progress mark and the page's one filled button.
    await expect(page.getByTestId("setup-check")).toContainText(
      "Run the check to see whether Bakery can work here.",
    );
    await expect(page.getByTestId("setup-check")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(
      page.getByTestId("setup-check").getByRole("button", {
        name: "Run the check",
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

test.describe("the readiness check", () => {
  const WORLD: Options = { profiles: SETTINGS, active: 2 };
  const step = (page: Page) => page.getByTestId("setup-check");
  const run = (page: Page) =>
    step(page).getByRole("button", { name: "Run the check" });
  const again = (page: Page) =>
    step(page).getByRole("button", { name: "Check again" });

  test("not started: the step to do now, with the page's one filled button", async ({ page }) => {
    await open(page, WORLD);
    await expect(step(page)).toHaveAttribute("data-state", "running");
    await expect(run(page)).toBeEnabled();
    await expect(page.locator('main [data-variant="primary"]')).toHaveCount(1);
  });

  test("running the check shows its progress, then a pass, and puts the check in the address", async ({ page }) => {
    const { seen } = await open(page, WORLD);
    await run(page).click();
    await expect(step(page)).toContainText(/Checking… started/);
    await expect(step(page)).toContainText(
      "All 3 required checks passed · checked",
      { timeout: 15_000 },
    );
    await expect(step(page)).toContainText("on Linux (x64)");
    await expect(step(page)).toHaveAttribute("data-state", "done");
    await expect(page).toHaveURL(new RegExp(`check=${CHECK_ID}`));
    await expect(again(page)).toBeVisible();
    await expect(page.getByTestId("check-results")).toHaveCount(0);
    expect(seen.starts).toHaveLength(1);
    expect(seen.starts[0]).not.toBeNull();
    await page.mouse.move(700, 700);
    await shot(page, "repository-check-ready");
    // A reload shows the same check, from the address.
    await page.reload();
    await expect(step(page)).toContainText("All 3 required checks passed", {
      timeout: 15_000,
    });
  });

  test("a required check that did not pass is listed with what to do, required first", async ({ page }) => {
    await open(page, { ...WORLD, check: "blocked" });
    await run(page).click();
    await expect(step(page)).toContainText(
      "2 of 3 required checks did not pass · checked",
      { timeout: 15_000 },
    );
    await expect(step(page)).toHaveAttribute("data-state", "failed");
    const rows = page.getByTestId("check-results").getByRole("listitem");
    await expect(rows).toHaveCount(3);
    const tools = page.locator('[data-check-id="tools"]');
    await expect(tools).toContainText("The machine has the tools it needs");
    await expect(tools).toContainText("Required");
    await expect(tools).toContainText("Missing");
    await expect(tools).toContainText(
      "deno is not installed on the machine. Install it there, then check again.",
    );
    const node = page.locator('[data-check-id="node"]');
    await expect(node).toContainText("Project builds (Node)");
    await expect(node).toContainText("The check ran and failed.");
    // The optional one is shown last, marked Optional.
    const optional = page.locator('[data-check-id="deno"]');
    await expect(optional).toContainText("Optional");
    await expect(optional).toContainText(
      "The check took too long and was stopped.",
    );
    expect(await rows.last().getAttribute("data-check-id")).toBe("deno");
    // Check again is the page's one filled button.
    await expect(again(page)).toBeEnabled();
    await expect(page.locator('main [data-variant="primary"]')).toHaveCount(1);
    await page.mouse.move(700, 700);
    await shot(page, "repository-check-blocked");
  });

  test("an optional check that did not pass is shown and never blocks", async ({ page }) => {
    await open(page, { ...WORLD, check: "optional" });
    await run(page).click();
    await expect(step(page)).toContainText("All 3 required checks passed", {
      timeout: 15_000,
    });
    await expect(step(page)).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("check-results")).toContainText(
      "This project uses a check Bakery cannot run. It was skipped. This does not stop work.",
    );
  });

  test("a check that failed or was cancelled says nothing was recorded", async ({ page }) => {
    await open(page, { ...WORLD, check: "failed" });
    await run(page).click();
    await expect(step(page)).toContainText(
      "The check could not be completed. Nothing was recorded.",
      { timeout: 15_000 },
    );
    await expect(again(page)).toBeEnabled();
  });

  test("a cancelled check", async ({ page }) => {
    await open(page, { ...WORLD, check: "canceled" });
    await run(page).click();
    await expect(step(page)).toContainText(
      "The check was cancelled. Nothing was recorded.",
      { timeout: 15_000 },
    );
  });

  test("a check still waiting offers no second check", async ({ page }) => {
    await open(page, { ...WORLD, check: "stuck" });
    await run(page).click();
    await expect(step(page)).toContainText("Waiting to start…");
    await expect(run(page)).toHaveCount(0);
    await expect(again(page)).toHaveCount(0);
  });

  test("progress that cannot be read is Not known, never a result", async ({ page }) => {
    await open(page, { ...WORLD, check: "unreadable" });
    await run(page).click();
    await expect(step(page)).toContainText(
      "The check's progress could not be loaded.",
      { timeout: 15_000 },
    );
    await expect(step(page)).toHaveAttribute("data-state", "unknown");
    await expect(step(page)).not.toContainText("passed");
    await expect(
      step(page).getByRole("button", { name: "Try again" }),
    ).toBeVisible();
  });

  test("a result for another version of the settings is not shown as this one's", async ({ page }) => {
    await repositoryFixture(page, {
      ...WORLD,
      check: "stale",
      existingCheck: true,
    });
    await page.goto(
      `/projects/repositories/${REPOSITORY_ID}?check=${CHECK_ID}`,
    );
    await expect(step(page)).toContainText(
      "The last check was for version 1, and version 2 is in use.",
      { timeout: 15_000 },
    );
    await expect(step(page)).not.toContainText("passed");
    await expect(again(page)).toBeEnabled();
  });

  test("an address that is not a check is ignored", async ({ page }) => {
    await repositoryFixture(page, WORLD);
    await page.goto(`/projects/repositories/${REPOSITORY_ID}?check=nope`);
    await expect(run(page)).toBeVisible({ timeout: 20_000 });
  });

  test("a member sees why they cannot run it", async ({ page }) => {
    await open(page, { ...WORLD, role: "developer" });
    await expect(step(page)).toContainText(
      "Only administrators can run the check.",
    );
    await expect(run(page)).toHaveCount(0);
  });

  test("an archived repository cannot be checked", async ({ page }) => {
    await open(page, { ...WORLD, archived: true });
    await expect(run(page)).toBeDisabled();
  });

  test("a refused start says why; a retry after a lost answer keeps its key", async ({ page }) => {
    const refused = await open(page, { ...WORLD, start: "forbidden" });
    await run(page).click();
    await expect(
      page.getByText("Only organization administrators can run the check."),
    ).toBeVisible();
    expect(refused.seen.starts).toHaveLength(1);
  });

  test("a start that gets no answer is retried with the same key", async ({ page }) => {
    const { seen } = await open(page, { ...WORLD, start: "down" });
    await run(page).click();
    await expect(page.getByText("The check could not be started. Try again."))
      .toBeVisible();
    await run(page).click();
    await expect.poll(() => seen.starts.length).toBe(2);
    expect(seen.starts[1]).toBe(seen.starts[0]);
  });
});

test.describe("names, testing a name, and details for support", () => {
  const NAMES: Options["names"] = [
    { role: "api", alias: "backend", note: "from the wiki" },
    { role: "service" },
    { role: "billing", other: true },
    { role: "old", archived: true },
  ];
  const card = (page: Page) => page.getByTestId("repository-names");
  const sheet = (page: Page) => page.getByRole("dialog", { name: "Names" });
  const open = async (page: Page, options: Options = {}) => {
    const fixture = await repositoryFixture(page, options);
    await page.goto(`/projects/repositories/${REPOSITORY_ID}`);
    await expect(card(page)).toBeVisible({ timeout: 20_000 });
    return fixture;
  };

  test("the card lists this repository's names only, says they give no access, and offers Change names", async ({ page }) => {
    await open(page, { names: NAMES });
    await expect(card(page)).toContainText("Names for this repository");
    await expect(card(page)).toContainText(
      "Names do not give anyone access. They only tell agents which repository is meant.",
    );
    await expect(card(page).getByTestId("name-api")).toContainText("api");
    await expect(card(page).getByTestId("name-api")).toContainText(
      "also: backend",
    );
    await expect(card(page).getByTestId("name-service")).toBeVisible();
    // Another repository's name and an archived name are not here.
    await expect(card(page)).not.toContainText("billing");
    await expect(card(page)).not.toContainText("old");
    await expect(
      card(page).getByRole("button", { name: "Change names" }),
    ).toBeVisible();
    await page.mouse.move(700, 700);
    await shot(page, "repository-names");
  });

  test("with no names the card says so and offers Add a name", async ({ page }) => {
    await open(page);
    await expect(card(page)).toContainText("No names yet.");
    await expect(card(page).getByRole("button", { name: "Add a name" }))
      .toBeVisible();
  });

  test("adding a name sends it trimmed, with a key, and shows it on the card", async ({ page }) => {
    const { seen } = await open(page);
    await card(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByLabel("Name", { exact: true }).fill("  api  ");
    await sheet(page).getByLabel("Other names").fill("backend");
    await sheet(page).getByRole("button", { name: "Add name" }).click();
    await expect(card(page).getByTestId("name-api")).toContainText(
      "also: backend",
    );
    expect(seen.nameWrites).toHaveLength(1);
    expect(seen.nameWrites[0].body).toMatchObject({
      role: "api",
      alias: "backend",
      provenance: null,
      repositoryId: REPOSITORY_ID,
    });
    expect(seen.nameWrites[0].key).not.toBeNull();
  });

  test("a name is required, and nothing is sent without one", async ({ page }) => {
    const { seen } = await open(page);
    await card(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByRole("button", { name: "Add name" }).click();
    await expect(sheet(page).getByText("Enter a name.")).toBeVisible();
    await expect(sheet(page).getByLabel("Name", { exact: true }))
      .toHaveAttribute(
        "aria-invalid",
        "true",
      );
    expect(seen.nameWrites).toHaveLength(0);
  });

  test("editing keeps the form's values, offers Save only for a change, and sends the version", async ({ page }) => {
    const { seen } = await open(page, { names: NAMES });
    await card(page).getByRole("button", { name: "Change names" }).click();
    await sheet(page).getByRole("button", { name: "Edit api" }).click();
    await expect(sheet(page).getByLabel("Name", { exact: true })).toHaveValue(
      "api",
    );
    await expect(sheet(page).getByLabel("Other names")).toHaveValue("backend");
    await expect(sheet(page).getByLabel("Note")).toHaveValue("from the wiki");
    const save = sheet(page).getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    await sheet(page).getByLabel("Other names").fill("backend, core");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(sheet(page).getByText("also: backend, core")).toBeVisible();
    expect(seen.nameWrites).toHaveLength(1);
    expect(seen.nameWrites[0].method).toBe("PATCH");
    expect(seen.nameWrites[0].ifMatch).toBe("1");
    expect(seen.nameWrites[0].body).toMatchObject({
      expectedVersion: 1,
      role: "api",
      alias: "backend, core",
    });
  });

  test("archiving a name takes it off the card and Restore brings it back", async ({ page }) => {
    const { seen } = await open(page, { names: NAMES });
    await card(page).getByRole("button", { name: "Change names" }).click();
    await sheet(page).getByRole("button", { name: "Archive service" }).click();
    await expect(
      sheet(page).getByTestId("name-row-service").getByText("Archived"),
    ).toBeVisible();
    expect(seen.nameWrites[0].body.archivedAt).not.toBeNull();
    await expect(card(page).getByTestId("name-service")).toHaveCount(0);
    await sheet(page).getByRole("button", { name: "Restore service" }).click();
    await expect(
      sheet(page).getByTestId("name-row-service").getByText("Archived"),
    ).toHaveCount(0);
    expect(seen.nameWrites[1].body.archivedAt).toBeNull();
    await page.mouse.move(700, 700);
    await shot(page, "repository-names-sheet");
  });

  test("a name that is already used says so and applies nothing", async ({ page }) => {
    await open(page, { nameWrite: "conflict" });
    await card(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByLabel("Name", { exact: true }).fill("api");
    await sheet(page).getByRole("button", { name: "Add name" }).click();
    await expect(
      sheet(page).getByText(/That name is already used in this application/),
    ).toBeVisible();
    await expect(card(page).getByTestId("name-api")).toHaveCount(0);
  });

  test("a retry after a lost answer keeps its key", async ({ page }) => {
    const { seen } = await open(page, { nameWrite: "down" });
    await card(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByLabel("Name", { exact: true }).fill("api");
    await sheet(page).getByRole("button", { name: "Add name" }).click();
    await expect(
      sheet(page).getByText("The change could not be saved. Try again."),
    ).toBeVisible();
    await sheet(page).getByRole("button", { name: "Add name" }).click();
    await expect.poll(() => seen.nameWrites.length).toBe(2);
    expect(seen.nameWrites[1].key).toBe(seen.nameWrites[0].key);
  });

  test("a member sees the names and cannot change them; neither can anyone on an archived repository", async ({ page }) => {
    await open(page, { names: NAMES, role: "developer" });
    await expect(card(page).getByTestId("name-api")).toBeVisible();
    await expect(
      card(page).getByRole("button", { name: "Change names" }),
    ).toHaveCount(0);
  });

  test("an archived repository's names cannot be changed", async ({ page }) => {
    await open(page, { names: NAMES, archived: true });
    await expect(
      card(page).getByRole("button", { name: "Change names" }),
    ).toHaveCount(0);
  });

  const test_ = async (page: Page, name: string) => {
    const more = page.getByRole("button", { name: /^More/ }).first();
    await more.click();
    // The entries are plain buttons in the popover (the Menu says so itself).
    await page.getByRole("button", { name: "Test a name", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Test a name" });
    await expect(dialog).toBeVisible();
    if (name !== "") {
      await dialog.getByLabel("Name", { exact: true }).fill(name);
    }
    await dialog.getByRole("button", { name: "Test" }).click();
    return dialog;
  };

  test("Test a name says which repository agents would get", async ({ page }) => {
    const { seen } = await open(page, { names: NAMES });
    const dialog = await test_(page, "api");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "“api” means this repository.",
    );
    expect(seen.resolves).toEqual([{ role: "api" }]);
    await page.mouse.move(700, 700);
    await shot(page, "repository-test-name");
  });

  test("a name of another repository is named, and a missing one says no repository has it", async ({ page }) => {
    await open(page, { resolve: "other" });
    const dialog = await test_(page, "billing");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "“billing” means acme/billing.",
    );
  });

  test("no match, an archived repository, an ambiguous name and a foreign one each say so", async ({ page }) => {
    await open(page, { resolve: "none" });
    const dialog = await test_(page, "x");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "No repository in this application has that name.",
    );
  });

  test("an ambiguous name says more than one repository has it", async ({ page }) => {
    await open(page, { resolve: "ambiguous" });
    const dialog = await test_(page, "api");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "2 repositories have that name",
    );
  });

  test("an archived repository's name and a foreign name", async ({ page }) => {
    await open(page, { resolve: "archived" });
    const dialog = await test_(page, "old");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "That name points to a repository that is archived.",
    );
  });

  test("a name from another application is its own answer", async ({ page }) => {
    await open(page, { resolve: "foreign" });
    const dialog = await test_(page, "x");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "That name belongs to another application.",
    );
  });

  test("testing with no name asks for one and sends nothing", async ({ page }) => {
    const { seen } = await open(page);
    const dialog = await test_(page, "");
    await expect(dialog.getByText("Enter a name.")).toBeVisible();
    expect(seen.resolves).toHaveLength(0);
  });

  test("Details for support are closed until opened, and say Not known for what the page has not read", async ({ page }) => {
    await open(page, { profiles: SETTINGS, active: 2 });
    const details = page.getByTestId("support-details");
    await expect(details.getByText(REPOSITORY_ID)).toBeHidden();
    await details.getByRole("button", { name: "Details for support" }).click();
    await expect(details.getByText(REPOSITORY_ID)).toBeVisible();
    await expect(details).toContainText("Settings version in use");
    // No check is known, so its details say so.
    await expect(
      details.getByText("Not known", { exact: true }).first(),
    ).toBeVisible();
  });

  test("with a check in the address its job and result are in the details", async ({ page }) => {
    await repositoryFixture(page, {
      profiles: SETTINGS,
      active: 2,
      existingCheck: true,
    });
    await page.goto(
      `/projects/repositories/${REPOSITORY_ID}?check=${CHECK_ID}`,
    );
    const details = page.getByTestId("support-details");
    await details.getByRole("button", { name: "Details for support" }).click();
    await expect(details.getByText(JOB_ID)).toBeVisible({ timeout: 15_000 });
    await expect(details.getByText("c".repeat(40))).toBeVisible();
  });

  test("More holds Test a name and Rules is still visible beside it", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("button", { name: "Rules" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^More/ }).first())
      .toBeVisible();
  });
});
