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
    // The server puts a repository's first version in use itself, which moves
    // the repository's version: the page reads it again and sends nothing more
    // (a PATCH with the version it held before the save would be refused).
    expect(seen.updates).toHaveLength(0);
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
    await expect(
      page.getByText(
        "A new version is saved when you save settings and each time the readiness check passes.",
      ),
    ).toBeVisible();
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

test.describe("the two writes against how the server behaves", () => {
  const WORLD: Options = { profiles: SETTINGS, active: 2 };

  test("a later save puts the new version in use with the repository's current version", async ({ page }) => {
    const { seen } = await open(page, WORLD);
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByLabel("Branches Bakery may work from").fill(
      "main\nhotfix/*",
    );
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    expect(seen.updates).toHaveLength(1);
    expect(seen.updates[0].ifMatch).toBe('"v1"');
    await expect(page.getByTestId("setup-settings")).toContainText(
      "Works from main, hotfix/* · version 3",
    );
  });

  test("a put-in-use that is refused after the save says the version was saved, not that nothing was applied", async ({ page }) => {
    await open(page, { ...WORLD, use: "conflict" });
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(page.getByText(/Version 3 was saved but is not in use yet/))
      .toBeVisible();
    await expect(page.getByText(/nothing was applied/i)).toHaveCount(0);
    await expect(page.getByTestId("profile-version-3")).toBeVisible();
  });

  test("a repository with rules of its own is changed like any other: the branches are saved, the rules are kept, and nothing here mentions them", async ({ page }) => {
    const { seen } = await open(page, {
      profiles: [
        { revision: 1, branches: ["main"] },
        { revision: 2, branches: ["main", "release/*"], rules: true },
      ],
      active: 2,
    });
    await expect(page.getByRole("button", { name: "View" })).toHaveCount(0);
    await shot(page, "repository-page-rules-in-force");
    await page.getByRole("button", { name: "Change" }).click();
    // The same sheet as any repository: a field, a Save, the version it makes.
    // The one word about rules is the folder's line: the rules are why it is fixed.
    await expect(sheet(page).getByLabel("Branches Bakery may work from"))
      .toHaveValue("main\nrelease/*");
    await expect(sheet(page).getByText("This saves version 3")).toBeVisible();
    await expect(sheet(page).getByTestId("folder-text")).toContainText(
      "The whole repository",
    );
    await expect(sheet(page).getByTestId("rules-in-force")).toHaveCount(0);
    await page.mouse.move(700, 700);
    await shot(page, "repository-settings-rules-in-force");
    await sheet(page).getByLabel("Branches Bakery may work from").fill(
      "main\nrelease/*\nhotfix/*",
    );
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId("setup-settings")).toContainText(
      "Works from main, release/*, hotfix/* · version 3",
    );
    // What was sent: the branches, the rules left to the server to keep (never
    // stated), and the repository's version as If-Match.
    expect(seen.createdProfiles).toHaveLength(1);
    const sent = seen.createdProfiles[0] as {
      revision: number;
      keepRepositoryRules?: boolean;
      config: Record<string, unknown>;
    };
    expect(sent.revision).toBe(3);
    expect(sent.keepRepositoryRules).toBe(true);
    expect(sent.config.repositoryRules).toBeUndefined();
    expect(seen.createIfMatch).toEqual(['"v1"']);
    // The server put the new version in use itself, so the page sent nothing more.
    expect(seen.updates).toHaveLength(0);
    // The new version holds the rules still: saving again keeps them again.
    await page.getByRole("button", { name: "Change" }).click();
    await expect(sheet(page).getByText("This saves version 4")).toBeVisible();
    await expect(sheet(page).getByTestId("profile-version-3")).toContainText(
      "In use",
    );
    await sheet(page).getByLabel("Branches Bakery may work from").fill(
      "main\nhotfix/*",
    );
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    expect(seen.createIfMatch).toEqual(['"v1"', '"v2"']);
    expect(
      (seen.createdProfiles[1] as { keepRepositoryRules?: boolean })
        .keepRepositoryRules,
    ).toBe(true);
  });

  test("with rules in force the working folder is text with where to change it, and is kept", async ({ page }) => {
    const { seen } = await open(page, {
      profiles: [{
        revision: 1,
        branches: ["main"],
        folder: "services/api",
        rules: true,
      }],
      active: 1,
    });
    await page.getByRole("button", { name: "Change" }).click();
    const folder = sheet(page).getByTestId("folder-text");
    await expect(folder).toContainText("Working folder");
    // A real folder is a path: it reads in the code face.
    await expect(folder.locator(".ui-data-text")).toHaveText("services/api");
    await expect(folder).toContainText(
      "Set by this repository's rules. To change it, change the rules.",
    );
    // Text, not a greyed field, and no Advanced toggle for it.
    await expect(sheet(page).getByLabel("Working folder")).toHaveCount(0);
    await expect(sheet(page).getByRole("button", { name: "Advanced" }))
      .toHaveCount(0);
    await expect(
      folder.getByRole("link", { name: "change the rules" }),
    ).toHaveAttribute(
      "href",
      `/projects/repositories/${REPOSITORY_ID}/rules`,
    );
    await page.mouse.move(700, 700);
    await shot(page, "repository-settings-rules-folder");
    await sheet(page).getByLabel("Branches Bakery may work from").fill(
      "main\ndevelop",
    );
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    const sent = seen.createdProfiles[0] as {
      config: { worktree: { root: string } };
    };
    expect(sent.config.worktree.root).toBe("services/api");
    await expect(page.getByTestId("setup-settings")).toContainText(
      "Works from main, develop · version 2",
    );
  });

  test("someone who may not open the rules page sees the same words, with nothing to follow", async ({ page }) => {
    await open(page, {
      role: "developer",
      profiles: [{ revision: 1, branches: ["main"], rules: true }],
      active: 1,
    });
    await page.getByRole("button", { name: "Change" }).click();
    const folder = sheet(page).getByTestId("folder-text");
    await expect(folder).toContainText(
      "Set by this repository's rules. To change it, change the rules.",
    );
    await expect(
      sheet(page).getByRole("link", { name: "change the rules" }),
    ).toHaveCount(0);
    await expect(folder).toContainText("change the rules");
  });

  test("a repository without rules still sends no rules statement and no If-Match", async ({ page }) => {
    const { seen } = await open(page, { profiles: SETTINGS, active: 2 });
    await page.getByRole("button", { name: "Change" }).click();
    await sheet(page).getByLabel("Branches Bakery may work from").fill("main");
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    const sent = seen.createdProfiles[0] as Record<string, unknown>;
    expect(sent.keepRepositoryRules).toBeUndefined();
    expect(seen.createIfMatch).toEqual([]);
  });

  test("the server refusing fixed branches says so with where to change them, keeps what was typed, and never says Try again", async ({ page }) => {
    const { seen } = await open(page, {
      profiles: [
        { revision: 1, branches: ["main"] },
        { revision: 2, branches: ["main"], rules: true },
      ],
      active: 2,
      branchesLocked: true,
    });
    await page.getByRole("button", { name: "Change" }).click();
    await sheet(page).getByLabel("Branches Bakery may work from").fill(
      "main\nrelease/*",
    );
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    const notice = sheet(page).getByRole("alert");
    await expect(notice).toContainText(
      "Nothing was saved. Your organization's rules fix the branches for this repository, so they cannot be changed here. An organization administrator can change that in Organization rules.",
    );
    // The words in the sentence are the link: one link, no line repeating them.
    await expect(notice.getByRole("link", { name: "Organization rules" }))
      .toHaveAttribute("href", "/settings/organization/repository-rules");
    await expect(notice.getByRole("link")).toHaveCount(1);
    await expect(sheet(page).getByText(/Try again/)).toHaveCount(0);
    // What was typed stays, and nothing changed: version 2 is still in use.
    await expect(sheet(page).getByLabel("Branches Bakery may work from"))
      .toHaveValue("main\nrelease/*");
    expect(seen.createdProfiles).toHaveLength(1);
    await expect(sheet(page).getByTestId("profile-version-2")).toContainText(
      "In use",
    );
    await expect(page.getByTestId("setup-settings")).toContainText(
      "version 2",
    );
    await page.mouse.move(700, 700);
    await shot(page, "repository-settings-branches-locked");
  });

  test("a version in use with a fixed policy shows its branches as text, with where to change them, and nothing to save", async ({ page }) => {
    await open(page, {
      profiles: [
        { revision: 1, branches: ["main"] },
        {
          revision: 2,
          branches: ["main", "release/*"],
          rules: true,
          fixed: true,
        },
      ],
      active: 2,
    });
    await page.getByRole("button", { name: "Change" }).click();
    const notice = sheet(page).getByTestId("branches-fixed");
    await expect(notice).toContainText(
      "Your organization's rules fix the branches for this repository. An organization administrator can change that in Organization rules.",
    );
    // The words in the sentence are the link: one link, no line repeating them.
    await expect(notice.getByRole("link", { name: "Organization rules" }))
      .toHaveAttribute("href", "/settings/organization/repository-rules");
    await expect(notice.getByRole("link")).toHaveCount(1);
    // Text, not a field; nothing to save, cancel or toggle.
    await expect(sheet(page).getByLabel("Branches Bakery may work from"))
      .toHaveCount(0);
    const branches = sheet(page).getByTestId("branches-text");
    await expect(branches).toContainText("main");
    await expect(branches).toContainText("release/*");
    await expect(
      sheet(page).getByRole("button", { name: "Save and use these settings" }),
    ).toHaveCount(0);
    await expect(sheet(page).getByRole("button", { name: "Cancel" }))
      .toHaveCount(0);
    await expect(sheet(page).getByText(/This saves version/)).toHaveCount(0);
    const folderText = sheet(page).getByTestId("folder-text");
    await expect(folderText).toContainText("The whole repository");
    // A sentence about the folder, in the body face; only a real path is code.
    await expect(folderText.locator(".ui-data-text")).toHaveCount(0);
    // The versions are still listed, with the one in use.
    await expect(sheet(page).getByTestId("profile-version-2")).toContainText(
      "In use",
    );
    await page.mouse.move(700, 700);
    await shot(page, "repository-settings-branches-fixed");
  });

  test("someone who may not open Organization rules sees the same words as plain text", async ({ page }) => {
    await open(page, {
      role: "developer",
      profiles: [{ revision: 1, branches: ["main"], fixed: true }],
      active: 1,
    });
    await page.getByRole("button", { name: "Change" }).click();
    const notice = sheet(page).getByTestId("branches-fixed");
    await expect(notice).toContainText(
      "An organization administrator can change that in Organization rules.",
    );
    // The words, not a link: nothing to follow, and nothing repeated below.
    await expect(notice.getByRole("link")).toHaveCount(0);
  });

  test("Use version over rules says when the chosen version does not carry them, and the button is the danger kind", async ({ page }) => {
    const { seen } = await open(page, {
      profiles: [
        { revision: 1, branches: ["main"] },
        { revision: 2, branches: ["main"], rules: true },
        { revision: 3, branches: ["main"], rules: "title.length" },
        { revision: 4, branches: ["main", "dev"], rules: true },
      ],
      active: 2,
    });
    await page.getByRole("button", { name: "Change" }).click();
    // No rules in the chosen version: they stop applying, said and shown as a danger.
    await sheet(page).getByRole("button", { name: "Use version 1" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Use version 1?" });
    await expect(confirm.getByTestId("use-rules-stop")).toHaveText(
      "Version 1 does not include this repository's own rules, so they stop applying.",
    );
    await expect(confirm.getByRole("button", { name: "Use version 1" }))
      .toHaveAttribute("data-variant", "destructive");
    await page.mouse.move(700, 700);
    await shot(page, "repository-use-version-rules-stop");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    // Other rules: said in its own words.
    await sheet(page).getByRole("button", { name: "Use version 3" }).click();
    const other = page.getByRole("alertdialog", { name: "Use version 3?" });
    await expect(other.getByTestId("use-rules-stop")).toHaveText(
      "Version 3 has other rules of its own, so the ones in force now stop applying.",
    );
    await expect(other.getByRole("button", { name: "Use version 3" }))
      .toHaveAttribute("data-variant", "destructive");
    await other.getByRole("button", { name: "Cancel" }).click();
    // The same rules: the ordinary confirmation.
    await sheet(page).getByRole("button", { name: "Use version 4" }).click();
    const same = page.getByRole("alertdialog", { name: "Use version 4?" });
    await expect(same.getByTestId("use-rules-stop")).toHaveCount(0);
    await expect(same.getByRole("button", { name: "Use version 4" }))
      .toHaveAttribute("data-variant", "primary");
    await same.getByRole("button", { name: "Use version 4" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(seen.updates).toHaveLength(1);
  });

  test("Use version over a repository without rules is the ordinary confirmation", async ({ page }) => {
    await open(page, { profiles: SETTINGS, active: 2 });
    await page.getByRole("button", { name: "Change" }).click();
    await sheet(page).getByRole("button", { name: "Use version 1" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Use version 1?" });
    await expect(confirm.getByTestId("use-rules-stop")).toHaveCount(0);
    await expect(confirm.getByRole("button", { name: "Use version 1" }))
      .toHaveAttribute("data-variant", "primary");
  });

  test("values the server does not accept are named as such", async ({ page }) => {
    await open(page, { ...WORLD, save: "rejected" });
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(
      sheet(page).getByText(
        "The server did not accept these settings. Check the branches and the folder.",
      ),
    ).toBeVisible();
  });

  test("a control character in a branch is refused in words, with nothing sent", async ({ page }) => {
    const { seen } = await open(page, WORLD);
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByLabel("Branches Bakery may work from").fill("main\u0000x");
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(
      page.getByText("Remove the control characters from the branch names."),
    ).toBeVisible();
    expect(seen.createdProfiles).toHaveLength(0);
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
    await expect(step(page)).toContainText("on a Linux (x64) machine");
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
    await expect(node).toContainText(
      "The check ran and failed. Fix the build in the repository, then check again.",
    );
    // The optional one is shown last, marked Optional.
    const optional = page.locator('[data-check-id="deno"]');
    await expect(optional).toContainText("Optional");
    await expect(optional).toContainText(
      "The check took too long and was stopped.",
    );
    await expect(optional).toContainText("This does not stop work.");
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

  test("a start refused as a conflict says the repository changed, not that a check is running", async ({ page }) => {
    await open(page, { ...WORLD, start: "conflict" });
    await run(page).click();
    await expect(
      page.getByText(
        "The repository changed since this page was loaded, so the check was not started. Reload the page and try again.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/already running/)).toHaveCount(0);
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

test.describe("where the setup stands, in the header and the footnote", () => {
  const WORLD: Options = { profiles: SETTINGS, active: 2 };
  const standing = (page: Page) => page.getByTestId("repository-standing");
  const run = (page: Page) =>
    page.getByTestId("setup-check").getByRole("button", {
      name: "Run the check",
    });

  test("before any check the header says nothing about readiness, and the footnote is the plain one", async ({ page }) => {
    await open(page, WORLD);
    await expect(standing(page)).toHaveCount(0);
    await expect(page.getByText("Not set up")).toHaveCount(0);
    await expect(
      page.getByText("Bakery can start tasks here once all three are done."),
    ).toBeVisible();
    // No line under step 3's sentence when no list of checks follows (wide screen).
    if (test.info().project.name === "desktop") {
      await expect(
        page.getByTestId("setup-check").locator(".ui-step-item__detail"),
      ).toHaveCount(0);
    }
  });

  test("a passed check is Ready in the header and the footnote says tasks can start", async ({ page }) => {
    await open(page, WORLD);
    await run(page).click();
    await expect(standing(page)).toHaveText("Ready", { timeout: 15_000 });
    await expect(
      page.getByText("Bakery can start tasks here.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/once all three are done/),
    ).toHaveCount(0);
    if (test.info().project.name === "desktop") {
      await expect(
        page.getByTestId("setup-check").locator(".ui-step-item__detail"),
      ).toHaveCount(0);
    }
    await page.mouse.move(700, 700);
    await shot(page, "repository-standing-ready");
  });

  test("a check that publishes the next version of the settings is judged against it, without a reload", async ({ page }) => {
    await open(page, { ...WORLD, completionPublishes: true });
    await expect(page.getByTestId("setup-settings")).toContainText("version 2");
    await run(page).click();
    // The server put version 3 in use when the check completed: the page reads
    // the repository again, so the result is this version's and the step,
    // the header and the settings all agree.
    await expect(page.getByTestId("setup-check")).toContainText(
      "All 3 required checks passed",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("setup-settings")).toContainText("version 3");
    await expect(standing(page)).toHaveText("Ready");
    // Who saved the new version, in the same words as when it did not pass.
    await expect(page.getByTestId("check-saved")).toContainText(
      "This check saved version 3, and it is now in use.",
    );
    await expect(page.getByText(/The last check was for version/)).toHaveCount(
      0,
    );
    await expect(page.getByText("Not known")).toHaveCount(0);
  });

  test("a check that did not pass publishes a newer version and leaves the one in use: its failure is shown, not another-version", async ({ page }) => {
    await open(page, { ...WORLD, check: "blocked", completionPublishes: true });
    await run(page).click();
    // The real server saves the version it checked (3) but keeps version 2 in use.
    await expect(page.getByTestId("setup-check")).toContainText(
      "2 of 3 required checks did not pass",
      { timeout: 15_000 },
    );
    await expect(standing(page)).toHaveText("Check failed");
    await expect(page.getByTestId("setup-settings")).toContainText("version 2");
    await expect(page.getByTestId("check-not-in-use")).toContainText(
      "The check did not pass, so the settings it tested are not in use. Version 2 stays in use.",
    );
    await expect(
      page.locator('[data-check-id="tools"]'),
    ).toContainText("deno is not installed on the machine");
    await expect(page.getByText(/The last check was for version/)).toHaveCount(
      0,
    );
    await page.mouse.move(700, 700);
    await shot(page, "repository-check-blocked-candidate");
  });

  test("a check that did not pass is Check failed in the header", async ({ page }) => {
    await open(page, { ...WORLD, check: "blocked" });
    await run(page).click();
    await expect(standing(page)).toHaveText("Check failed", {
      timeout: 15_000,
    });
    await expect(
      page.getByText("Bakery can start tasks here once all three are done."),
    ).toBeVisible();
  });

  test("a check that could not be completed is Check failed too", async ({ page }) => {
    await open(page, { ...WORLD, check: "failed" });
    await run(page).click();
    await expect(standing(page)).toHaveText("Check failed", {
      timeout: 15_000,
    });
  });

  test("a result for another version of the settings says nothing in the header", async ({ page }) => {
    await repositoryFixture(page, {
      ...WORLD,
      check: "stale",
      existingCheck: true,
    });
    await page.goto(
      `/projects/repositories/${REPOSITORY_ID}?check=${CHECK_ID}`,
    );
    await expect(
      page.getByTestId("setup-check").getByText(
        /The last check was for version 1/,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(standing(page)).toHaveCount(0);
  });

  test("with the connection not working a passed check is not Ready", async ({ page }) => {
    await open(page, { ...WORLD, connection: "revoked" });
    await run(page).click();
    await expect(
      page.getByTestId("setup-check").getByText(/checked/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(standing(page)).toHaveCount(0);
  });
});

test.describe("after a check: a person's version over a check-made one, and a failed check's hidden candidate", () => {
  const CHECKED: Options = {
    profiles: [
      { revision: 1, branches: ["main"] },
      { revision: 2, branches: ["main"], checkMade: true },
    ],
    active: 2,
  };
  const standing = (page: Page) => page.getByTestId("repository-standing");

  test("the sheet says a save after a check means running the check again, and the save is a person's plain version", async ({ page }) => {
    const { seen } = await open(page, CHECKED);
    await page.getByRole("button", { name: "Change" }).click();
    await expect(
      page.getByText(
        "This saves version 3 and puts it in use. Run the readiness check again afterwards: until it passes, tasks stop at the steps where Bakery runs its checks. Tasks already running keep version 2.",
      ),
    ).toBeVisible();
    await page.mouse.move(700, 700);
    await shot(page, "repository-settings-after-check");
    await page.getByLabel("Branches Bakery may work from").fill(
      "main\nrelease/*",
    );
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(sheet(page)).toHaveCount(0);
    // A person's version: the check's own key is not carried (the strict parser refuses it).
    const sent = seen.createdProfiles[0] as {
      config: Record<string, unknown>;
    };
    expect(sent.config.schemaVersion).toBe(1);
    expect(sent.config.checkPolicy).toBeUndefined();
    // The page after the save: Check needed, the step to do now, the new footnote.
    await expect(standing(page)).toHaveText("Check needed");
    await expect(page.getByTestId("setup-settings")).toContainText("version 3");
    await expect(page.getByTestId("setup-check")).toContainText(
      "The settings changed. Run the check again: until it passes, tasks stop at the steps where Bakery runs its checks.",
    );
    await expect(page.getByTestId("setup-check")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(
      page.getByText(
        "Bakery can start tasks here. They stop at Bakery's checks until the readiness check passes again.",
      ),
    ).toBeVisible();
    await expect(
      page.getByTestId("setup-check").getByRole("button", {
        name: "Run the check",
      }),
    ).toBeVisible();
    await page.mouse.move(700, 700);
    await shot(page, "repository-check-needed");
  });

  test("a check-made version in use is its own evidence: Ready, not Check needed, even with no check in the address", async ({ page }) => {
    await open(page, CHECKED);
    await expect(standing(page)).toHaveText("Ready");
    await expect(page.getByTestId("setup-check")).toContainText(
      "A readiness check passed for version 2.",
    );
    await expect(page.getByTestId("setup-check")).toHaveAttribute(
      "data-state",
      "done",
    );
    await expect(
      page.getByText("Bakery can start tasks here.", { exact: true }),
    ).toBeVisible();
    // The sheet and the page agree: the version in use came from a passed check.
    await page.getByRole("button", { name: "Change" }).click();
    await expect(
      page.getByText(/Run the readiness check again afterwards/),
    ).toBeVisible();
    await expect(standing(page)).toHaveText("Ready");
  });

  test("a repository never checked says nothing about a check being needed", async ({ page }) => {
    await open(page, { profiles: SETTINGS, active: 2 });
    await expect(standing(page)).toHaveCount(0);
  });

  test("using a person's version over a check-made one adds the run-the-check sentence; using a check-made one does not", async ({ page }) => {
    await open(page, CHECKED);
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Use version 1" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Use version 1?" });
    await expect(confirm).toContainText(
      "Run the readiness check again afterwards; until it passes, tasks stop at the steps where Bakery runs its checks.",
    );
    await shot(page, "repository-use-version-after-check");
    await confirm.getByRole("button", { name: "Cancel" }).click();
  });

  test("switching to a check-made version from a person's carries no such sentence", async ({ page }) => {
    await open(page, {
      profiles: [
        { revision: 1, branches: ["main"] },
        { revision: 2, branches: ["main"], checkMade: true },
        { revision: 3, branches: ["main"] },
      ],
      active: 3,
    });
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByRole("button", { name: "Use version 2" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Use version 2?" });
    await expect(confirm).toContainText("New tasks use version 2.");
    await expect(confirm).not.toContainText("Run the readiness check again");
  });

  test("a failed check's candidate is not in the Versions list, holds a revision, and the next save takes the next free one", async ({ page }) => {
    const { seen } = await open(page, {
      profiles: SETTINGS,
      active: 2,
      check: "blocked",
      completionPublishes: true,
    });
    await page.getByTestId("setup-check").getByRole("button", {
      name: "Run the check",
    }).click();
    await expect(page.getByTestId("setup-check")).toContainText(
      "2 of 3 required checks did not pass",
      { timeout: 15_000 },
    );
    await page.getByRole("button", { name: "Change" }).click();
    // Version 3 (the candidate) is stored but not listed; the next free number is 4.
    await expect(page.getByTestId("profile-version-3")).toHaveCount(0);
    await expect(page.getByTestId("profile-version-2")).toBeVisible();
    await expect(page.getByText(/This saves version 4\./)).toBeVisible();
    await page.getByRole("button", { name: "Save and use these settings" })
      .click();
    await expect(page.getByRole("dialog", { name: "Working settings" }))
      .toHaveCount(0);
    expect((seen.createdProfiles.at(-1) as { revision: number }).revision)
      .toBe(4);
  });
});

test.describe("a locked repository's versions", () => {
  // The version in use fixes the branches (#65), so a version recorded with
  // another set cannot be put in use: its row says so instead of offering a
  // button the server would refuse.
  const LOCKED: Options = {
    profiles: [
      { revision: 1, branches: ["main", "earlier/*"] },
      { revision: 2, branches: ["main", "locked/*"], fixed: true },
      { revision: 3, branches: ["main", "locked/*", "hotfix/*"] },
    ],
    active: 2,
  };

  test("says a version works from other branches instead of offering Use", async ({ page }) => {
    await open(page, LOCKED);
    await page.getByRole("button", { name: "Change" }).click();
    const diverging = page.getByTestId("profile-version-1");
    await expect(diverging).toContainText("Works from other branches");
    // design-ux's ruling: muted body text where the control was, not a badge.
    await expect(
      page.getByTestId("profile-version-1").getByText(
        "Works from other branches",
      ),
    ).toBeVisible();
    await expect(diverging.getByRole("button")).toHaveCount(0);
    // A version whose branches leave the fixed set is the same case.
    await expect(page.getByTestId("profile-version-3")).toContainText(
      "Works from other branches",
    );
    // The version in use says so and offers nothing either.
    await expect(page.getByTestId("profile-version-2")).toContainText("In use");
    await expect(
      page.getByTestId("profile-version-2").getByRole("button"),
    ).toHaveCount(0);
    await page.mouse.move(700, 700);
    await shot(page, "locked-branch-versions", [], { windowOnly: true });
  });

  test("keeps Use on a version whose branches match the fixed set", async ({ page }) => {
    await open(page, {
      profiles: [
        { revision: 1, branches: ["main", "locked/*"] },
        { revision: 2, branches: ["main", "locked/*"], fixed: true },
        { revision: 3, branches: ["main", "earlier/*"] },
      ],
      active: 2,
    });
    await page.getByRole("button", { name: "Change" }).click();
    await expect(
      page.getByTestId("profile-version-1").getByRole("button", {
        name: "Use version 1",
      }),
    ).toBeVisible();
    await expect(
      page.getByTestId("profile-version-3").getByText(
        "Works from other branches",
      ),
    ).toBeVisible();
    await page.mouse.move(700, 700);
    await shot(page, "locked-branch-versions-matching", [], {
      windowOnly: true,
    });
  });

  test("leaves an unlocked repository's rows unchanged", async ({ page }) => {
    await open(page, {
      profiles: [
        { revision: 1, branches: ["main"] },
        { revision: 2, branches: ["main", "release/*"] },
      ],
      active: 2,
    });
    await page.getByRole("button", { name: "Change" }).click();
    await expect(
      page.getByTestId("profile-version-1").getByRole("button", {
        name: "Use version 1",
      }),
    ).toBeVisible();
    await expect(page.getByText("Works from other branches")).toHaveCount(0);
    await page.mouse.move(700, 700);
    await shot(page, "unlocked-version-rows", [], { windowOnly: true });
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
    await sheet(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByLabel(/^Name\*?$/).fill("  api  ");
    await sheet(page).getByLabel("Other names").fill("backend");
    await sheet(page).getByRole("button", { name: "Save name" }).click();
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
    await sheet(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByRole("button", { name: "Save name" }).click();
    await expect(sheet(page).getByText("Enter a name.")).toBeVisible();
    await expect(sheet(page).getByLabel(/^Name\*?$/))
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
    await expect(sheet(page).getByLabel(/^Name\*?$/)).toHaveValue(
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
    await sheet(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByLabel(/^Name\*?$/).fill("api");
    await sheet(page).getByRole("button", { name: "Save name" }).click();
    await expect(
      sheet(page).getByText(
        "“api” is already used in this application. Names must be unique in an application.",
      ),
    ).toBeVisible();
    await expect(sheet(page).getByLabel(/^Name\*?$/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(card(page).getByTestId("name-api")).toHaveCount(0);
  });

  test("a retry after a lost answer keeps its key", async ({ page }) => {
    const { seen } = await open(page, { nameWrite: "down" });
    await card(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByRole("button", { name: "Add a name" }).click();
    await sheet(page).getByLabel(/^Name\*?$/).fill("api");
    await sheet(page).getByRole("button", { name: "Save name" }).click();
    await expect(
      sheet(page).getByText("The change could not be saved. Try again."),
    ).toBeVisible();
    await sheet(page).getByRole("button", { name: "Save name" }).click();
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
    const dialog = page.getByRole("alertdialog", {
      name: "Which repository does a name point to?",
    });
    await expect(dialog).toBeVisible();
    if (name !== "") {
      await dialog.getByLabel(/^Name\*?$/).fill(name);
    }
    await dialog.getByRole("button", { name: "Check" }).click();
    return dialog;
  };

  test("Test a name opens on its Name field, not on a button", async ({ page }) => {
    await open(page, { names: NAMES });
    await page.getByRole("button", { name: /^More/ }).first().click();
    await page.getByRole("button", { name: "Test a name", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", {
      name: "Which repository does a name point to?",
    });
    await expect(dialog.getByLabel(/^Name\*?$/)).toBeFocused();
  });

  test("Test a name says which repository agents would get", async ({ page }) => {
    const { seen } = await open(page, { names: NAMES });
    const dialog = await test_(page, "api");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "“api” points to this repository.",
    );
    expect(seen.resolves).toEqual([{ role: "api" }]);
    await page.mouse.move(700, 700);
    await shot(page, "repository-test-name");
  });

  test("a name of another repository is named, and a missing one says no repository has it", async ({ page }) => {
    await open(page, { resolve: "other" });
    const dialog = await test_(page, "billing");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "“billing” points to acme/billing.",
    );
  });

  test("no match, an archived repository, an ambiguous name and a foreign one each say so", async ({ page }) => {
    await open(page, { resolve: "none" });
    const dialog = await test_(page, "x");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "Nothing in this application is called “x”.",
    );
  });

  test("an ambiguous name says more than one repository has it", async ({ page }) => {
    await open(page, { resolve: "ambiguous" });
    const dialog = await test_(page, "api");
    await expect(dialog.getByTestId("test-name-result")).toContainText(
      "“api” matches more than one repository",
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

  test("Details for support are closed until opened, open with a line to quote from, and leave out what the page has not read", async ({ page }) => {
    await open(page, { profiles: SETTINGS, active: 2 });
    const details = page.getByTestId("support-details");
    await expect(details.getByText(REPOSITORY_ID)).toBeHidden();
    await details.getByRole("button", { name: "Details for support" }).click();
    await expect(details.getByText(REPOSITORY_ID)).toBeVisible();
    await expect(details).toContainText("Settings version in use");
    await expect(details).toContainText("GitHub repository ID");
    // Each known value has its own Copy, named for what it copies.
    await expect(details.getByRole("button", { name: "Copy Repository ID" }))
      .toBeVisible();
    await expect(details.getByText("Quote these when asking for help."))
      .toBeVisible();
    // No check is known, so those rows are not there.
    await expect(details.getByText("Not known")).toHaveCount(0);
    await expect(details).not.toContainText("Check job");
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

test.describe("archive and restore from More", () => {
  const more = (page: Page) =>
    page.getByRole("button", { name: /^More/ }).first();
  const openMore = async (page: Page, options: Options = {}) => {
    const fixture = await repositoryFixture(page, options);
    await page.goto(`/projects/repositories/${REPOSITORY_ID}`);
    await expect(more(page)).toBeVisible({ timeout: 20_000 });
    await more(page).click();
    return fixture;
  };

  test("an administrator archives after confirming, and sees it archived", async ({ page }) => {
    const fixture = await openMore(page);
    await page.getByRole("button", { name: "Archive repository", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", {
      name: "Archive acme/api-service?",
    });
    await expect(dialog).toContainText(
      "Bakery stops working in it. Tasks already running finish.",
    );
    await expect(dialog).toContainText("You can restore it.");
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(
      page.getByText(
        "This repository is archived, so its settings cannot be changed.",
      ),
    ).toBeVisible();
    const sent = fixture.seen.updates.at(-1)!;
    expect(sent.ifMatch).toBe('"v1"');
    expect(typeof sent.body.archivedAt).toBe("string");
  });

  test("cancel archives nothing", async ({ page }) => {
    const fixture = await openMore(page);
    await page.getByRole("button", { name: "Archive repository", exact: true })
      .click();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Cancel",
      exact: true,
    }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(fixture.seen.updates).toEqual([]);
  });

  test("a restore needs no confirmation and clears the archived notice", async ({ page }) => {
    const fixture = await openMore(page, { archived: true });
    await page.getByRole("button", { name: "Restore repository", exact: true })
      .click();
    await expect(
      page.getByText(
        "This repository is archived, so its settings cannot be changed.",
      ),
    ).toHaveCount(0);
    const sent = fixture.seen.updates.at(-1)!;
    expect(sent.body.archivedAt).toBeNull();
  });

  test("a stale archive says someone else changed it and archives nothing", async ({ page }) => {
    await openMore(page, { use: "conflict" });
    await page.getByRole("button", { name: "Archive repository", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(dialog).toContainText("Someone else changed this just now");
  });

  test("a retry after a lost answer sends the same body under the same key", async ({ page }) => {
    const fixture = await openMore(page, { use: "down" });
    const archive = () =>
      page.getByRole("button", { name: "Archive repository", exact: true });
    await archive().click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(dialog).toContainText("That did not work. Try again.");
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect.poll(() => fixture.seen.updates.length).toBe(2);
    const [first, second] = fixture.seen.updates;
    expect(second.key).not.toBeNull();
    expect(second.key).toBe(first.key);
    expect(second.body.archivedAt).toBe(first.body.archivedAt);
  });

  test("after a refusal the next try is a new intent with a new key", async ({ page }) => {
    const fixture = await openMore(page, { use: "conflict" });
    await page.getByRole("button", { name: "Archive repository", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(dialog).toContainText("Someone else changed this");
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect.poll(() => fixture.seen.updates.length).toBe(2);
    const [first, second] = fixture.seen.updates;
    expect(second.key).not.toBe(first.key);
  });

  test("only an administrator is offered Archive", async ({ page }) => {
    await openMore(page, { role: "member" });
    await expect(
      page.getByRole("button", { name: "Test a name", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive repository" }))
      .toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restore repository" }))
      .toHaveCount(0);
  });
});

test.describe("change the default branch from More", () => {
  const more = (page: Page) =>
    page.getByRole("button", { name: /^More/ }).first();
  const openEdit = async (page: Page, options: Options = {}) => {
    const fixture = await repositoryFixture(page, options);
    await page.goto(`/projects/repositories/${REPOSITORY_ID}`);
    await expect(more(page)).toBeVisible({ timeout: 20_000 });
    await more(page).click();
    await page.getByRole("button", {
      name: "Change default branch",
      exact: true,
    })
      .click();
    return {
      fixture,
      dialog: page.getByRole("alertdialog", { name: "Change default branch" }),
    };
  };

  test("Change default branch is first in the menu and the dialog starts untouched", async ({ page }) => {
    await repositoryFixture(page, {});
    await page.goto(`/projects/repositories/${REPOSITORY_ID}`);
    await more(page).click();
    const items = page.getByRole("button", {
      name:
        /^(Change default branch|Test a name|Archive repository|Restore repository)$/,
    });
    await expect(items.first()).toHaveText("Change default branch");
    await page.getByRole("button", {
      name: "Change default branch",
      exact: true,
    })
      .click();
    const dialog = page.getByRole("alertdialog", {
      name: "Change default branch",
    });
    await expect(dialog.getByLabel(/^Default branch/)).toHaveValue("main");
    await expect(dialog.getByLabel(/^Name/)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Save changes" }))
      .toBeDisabled();
  });

  test("saving sends only the branch with the version, then shows it", async ({ page }) => {
    const { fixture, dialog } = await openEdit(page);
    await dialog.getByLabel(/^Default branch/).fill("develop");
    await expect(dialog.getByRole("button", { name: "Save changes" }))
      .toBeEnabled();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Changes saved")).toBeVisible();
    await expect(page.getByText(/default branch develop/)).toBeVisible();
    const sent = fixture.seen.updates.at(-1)!;
    expect(sent.ifMatch).toBe('"v1"');
    expect(sent.body).toEqual({ defaultBranch: "develop" });
  });

  test("an empty branch says what to enter and sends nothing", async ({ page }) => {
    const { fixture, dialog } = await openEdit(page);
    await dialog.getByLabel(/^Default branch/).fill("");
    await dialog.getByLabel(/^Default branch/).press("Enter");
    await expect(dialog.getByText("Enter a branch.")).toBeVisible();
    expect(fixture.seen.updates).toEqual([]);
  });

  test("a retry after a lost answer keeps its key; a refusal starts a new intent", async ({ page }) => {
    const lost = await openEdit(page, { use: "down" });
    await lost.dialog.getByLabel(/^Default branch/).fill("develop");
    await lost.dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(lost.dialog).toContainText("That did not work. Try again.");
    await lost.dialog.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => lost.fixture.seen.updates.length).toBe(2);
    const [a, b] = lost.fixture.seen.updates;
    expect(b.key).toBe(a.key);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const refused = await openEdit(page, { use: "conflict" });
    await refused.dialog.getByLabel(/^Default branch/).fill("develop");
    await refused.dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(refused.dialog).toContainText(
      "changed while you were editing",
    );
    await refused.dialog.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => refused.fixture.seen.updates.length).toBe(2);
    const [c, d] = refused.fixture.seen.updates;
    expect(d.key).not.toBe(c.key);
  });

  test("a version that moved says so, with Reload, and keeps the dialog", async ({ page }) => {
    const { dialog } = await openEdit(page, { use: "conflict" });
    await dialog.getByLabel(/^Default branch/).fill("develop");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toContainText(
      "This repository changed while you were editing. Reload to see the latest.",
    );
    await expect(dialog.getByRole("button", { name: "Reload" })).toBeVisible();
  });

  test("Cancel sends nothing; an archived repository and a non-administrator have no Change default branch", async ({ page }) => {
    const { fixture, dialog } = await openEdit(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixture.seen.updates).toEqual([]);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await repositoryFixture(page, { archived: true });
    await page.goto(`/projects/repositories/${REPOSITORY_ID}`);
    await more(page).click();
    await expect(
      page.getByRole("button", { name: "Change default branch", exact: true }),
    ).toHaveCount(0);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await repositoryFixture(page, { role: "member" });
    await page.goto(`/projects/repositories/${REPOSITORY_ID}`);
    await more(page).click();
    await expect(
      page.getByRole("button", { name: "Change default branch", exact: true }),
    ).toHaveCount(0);
  });
});
