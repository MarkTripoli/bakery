import { expect, type Page, test } from "@playwright/test";
import {
  type AgentVersionRow,
  definition,
  libraryFixture,
  type Options,
  uuid,
} from "./helpers/library-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * One agent of the library (design-ux, #66, slice 3c): what its version is
 * configured to do, its versions with the one in use, and an administrator's
 * changes to which version is used and whether it is on.
 */
const AGENT = definition(20, "Code writer", {
  description: "Writes the change for a task.",
  activeVersionId: uuid(2002),
});
const version = (
  n: number,
  revision: number,
  config: Record<string, unknown> = {},
): AgentVersionRow => ({
  id: uuid(2000 + n),
  agentId: AGENT.id,
  revision,
  config,
});
const VERSIONS: AgentVersionRow[] = [
  version(1, 1, { harness: "codex" }),
  version(2, 2, {
    harness: "claude_code",
    billing: { provider: "anthropic", model: "claude-sonnet-5-5" },
    allowedCapabilities: ["repo.read", "repo.write"],
    promptBindings: { system: "p-1" },
    skillBindings: { review: "s-1" },
  }),
  version(3, 3, { harness: "pi" }),
];
const WORLD: Options = { agents: [AGENT], agentVersions: VERSIONS };

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: agent page`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const open = async (
      page: Page,
      options: Options = WORLD,
      path = `/library/agents/${AGENT.id}`,
    ) => {
      const seen = await libraryFixture(page, options);
      await page.goto(path);
      await expect(page.getByTestId("agent-page")).toBeVisible();
      return seen;
    };
    const versionRow = (page: Page, revision: number) =>
      page.getByTestId("agent-versions").locator("[data-version-id]")
        .filter({ hasText: `Version ${revision}` });
    const more = (page: Page) =>
      page.getByRole("button", { name: "More actions for Code writer" });

    test("opens from the Agents list and shows the version in use and every version", async ({ page }) => {
      await libraryFixture(page, WORLD);
      await page.goto("/library?tab=agents");
      await page.getByRole("button", { name: "Open Code writer" }).click();
      await expect(page.getByTestId("agent-page")).toBeVisible();
      await expect(page).toHaveURL(`/library/agents/${AGENT.id}`);
      const root = page.getByTestId("agent-page");
      await expect(page.getByRole("heading", { name: "Code writer", level: 1 }))
        .toBeVisible();
      await expect(root).toContainText("Writes the change for a task.");
      await expect(root).toContainText("In use");
      const details = page.getByTestId("agent-details");
      await expect(details).toContainText("Version 2");
      await expect(details).toContainText("Runs on");
      await expect(details).toContainText("Claude Code");
      await expect(details).toContainText("claude-sonnet-5-5");
      await expect(details).toContainText("repo.read, repo.write");
      await expect(details).toContainText("system");
      await expect(details).toContainText("review");
      // A help button stays on its label's line; on a wide screen all five
      // rows keep one height (on a phone a long value may wrap to a second line).
      const rows = details.locator('[data-ui-component="detailRow"]');
      await expect(rows).toHaveCount(5);
      const heights = await rows.evaluateAll((nodes) =>
        nodes.map((node) => Math.round(node.getBoundingClientRect().height))
      );
      if (viewport.name === "desktop") {
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(
          1,
        );
      }
      const tools = rows.filter({ hasText: "Tools it may use" });
      const row = (await tools.boundingBox())!;
      const help = (await tools.getByRole("button").boundingBox())!;
      expect(help.y).toBeLessThan(row.y + row.height / 2 + 4);
      expect(help.y + help.height).toBeLessThanOrEqual(row.y + row.height + 1);
      // The identifiers say what they are: each label has its help.
      await details.getByRole("button", { name: "Tools it may use" }).click();
      await expect(
        page.locator('[data-ui-component="helpTip"] .ui-help-tip__panel')
          .filter({
            has: page.getByText(
              "What this agent is allowed to do in a repository.",
            ),
          }),
      ).toBeVisible();
      const versions = page.getByTestId("agent-versions");
      await expect(versions).toContainText(
        "Workflows keep the agent version they were published with.",
      );
      await expect(versionRow(page, 2)).toHaveAttribute(
        "data-version-state",
        "inUse",
      );
      await expect(versionRow(page, 1)).toHaveAttribute(
        "data-version-state",
        "other",
      );
      await page.mouse.move(700, 700);
      await shot(page, "agent-page");
    });

    test("View shows another version's configuration and the address names it", async ({ page }) => {
      await open(page);
      await page.getByRole("link", { name: "View version 1" }).click();
      await expect(page).toHaveURL(new RegExp(`version=${uuid(2001)}`));
      const details = page.getByTestId("agent-details");
      await expect(details).toContainText("Version 1");
      await expect(details).toContainText("Codex");
      await expect(details).toContainText("Not set");
      await expect(versionRow(page, 1)).toContainText("Shown above");
    });

    test("an address with a version the agent does not have shows the version in use, and says so", async ({ page }) => {
      await open(
        page,
        WORLD,
        `/library/agents/${AGENT.id}?version=${uuid(9999)}`,
      );
      await expect(page.getByTestId("agent-page")).toContainText(
        "That version does not exist. This is the version in use.",
      );
      await expect(page.getByTestId("agent-details")).toContainText(
        "Version 2",
      );
    });

    test("a version with nothing configured says so rather than guessing", async ({ page }) => {
      await open(page, {
        agents: [AGENT],
        agentVersions: [version(2, 2, {})],
      });
      const details = page.getByTestId("agent-details");
      await expect(details).toContainText("Runs on");
      await expect(details).toContainText("Not set");
      await expect(details).toContainText("None");
    });

    test("Use this version asks first, then sends the version with the agent's own version", async ({ page }) => {
      const seen = await open(page);
      await versionRow(page, 3).getByRole("button", {
        name: "Use this version",
      })
        .click();
      const confirm = page.getByRole("alertdialog", {
        name: "Use version 3?",
      });
      await expect(confirm).toContainText(
        "Tasks already running keep the version they started with.",
      );
      await page.mouse.move(700, 700);
      await shot(page, "agent-use-version", [], { windowOnly: true });
      await confirm.getByRole("button", { name: "Use version 3" }).click();
      await expect(versionRow(page, 3)).toHaveAttribute(
        "data-version-state",
        "inUse",
      );
      expect(seen.agentActivations).toHaveLength(1);
      expect(seen.agentActivations[0]?.body).toEqual({ versionId: uuid(2003) });
      expect(seen.agentActivations[0]?.ifMatch).toContain("1");
    });

    test("someone else changed it first: a warning, and nothing is applied", async ({ page }) => {
      await open(page, { ...WORLD, conflict: "activate" });
      await versionRow(page, 3).getByRole("button", {
        name: "Use this version",
      })
        .click();
      const confirm = page.getByRole("alertdialog", { name: "Use version 3?" });
      await confirm.getByRole("button", { name: "Use version 3" }).click();
      await expect(confirm).toContainText(
        "Someone else changed this just now. The latest version is shown.",
      );
      await expect(versionRow(page, 2)).toHaveAttribute(
        "data-version-state",
        "inUse",
      );
    });

    test("Turn off asks first and says what it does; Turn on is direct; both send the version they saw", async ({ page }) => {
      const seen = await open(page);
      await more(page).click();
      await page.locator(".ui-popover__content").getByRole("button", {
        name: "Turn off",
        exact: true,
      }).click();
      const confirm = page.getByRole("alertdialog", {
        name: "Turn off Code writer?",
      });
      await expect(confirm).toContainText("Tasks already running finish.");
      await confirm.getByRole("button", { name: "Turn off" }).click();
      await expect(page.getByTestId("agent-page")).toContainText("Turned off");
      expect(seen.agentUpdates[0]?.body).toEqual({ enabled: false });
      expect(seen.agentUpdates[0]?.ifMatch).toContain("1");
      await more(page).click();
      await page.locator(".ui-popover__content").getByRole("button", {
        name: "Turn on",
        exact: true,
      }).click();
      await expect(page.getByTestId("agent-page")).not.toContainText(
        "Turned off",
      );
      expect(seen.agentUpdates).toHaveLength(2);
      expect(seen.agentUpdates[1]?.body).toEqual({ enabled: true });
    });

    test("Rename sends only the name", async ({ page }) => {
      const seen = await open(page);
      await more(page).click();
      await page.locator(".ui-popover__content").getByRole("button", {
        name: "Rename",
      }).click();
      const form = page.getByRole("dialog", { name: "Rename agent" });
      await form.getByLabel("Name").fill("Primary writer");
      await form.getByRole("button", { name: "Rename" }).click();
      await expect(
        page.getByRole("heading", { name: "Primary writer", level: 1 }),
      )
        .toBeVisible();
      expect(seen.agentUpdates[0]?.body).toEqual({ name: "Primary writer" });
    });

    test("with no version in use the page says so and offers the newest", async ({ page }) => {
      const seen = await open(page, {
        agents: [{ ...AGENT, activeVersionId: null }],
        agentVersions: VERSIONS,
      });
      const banner = page.locator('[data-ui-component="alertBanner"]').filter({
        hasText: "No version is in use",
      });
      await expect(banner).toContainText("cannot be chosen for new tasks");
      await banner.getByRole("button", { name: "Use version 3" }).click();
      await page.getByRole("alertdialog", { name: "Use version 3?" }).getByRole(
        "button",
        { name: "Use version 3" },
      ).click();
      await expect(banner).toHaveCount(0);
      expect(seen.agentActivations).toHaveLength(1);
    });

    test("a member reads it but cannot change it", async ({ page }) => {
      await open(page, { ...WORLD, role: "developer" });
      await expect(page.getByTestId("agent-page")).toContainText(
        "Only organization administrators can change workflows and agents.",
      );
      await expect(page.getByRole("button", { name: "Use this version" }))
        .toHaveCount(0);
      await expect(more(page)).toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "agent-member");
    });

    test("an agent that is not there says so and leads back to the Agents list", async ({ page }) => {
      await libraryFixture(page, WORLD);
      await page.goto(`/library/agents/${uuid(999)}`);
      await expect(page.getByTestId("agent-page")).toContainText(
        "This agent was not found",
      );
      await page.getByRole("button", { name: "Back to the library" }).click();
      await expect(page).toHaveURL(/\/library\?tab=agents$/);
    });

    test("Show all lists every version in a sheet", async ({ page }) => {
      const many: AgentVersionRow[] = Array.from(
        { length: 7 },
        (_, index) => version(index + 1, index + 1, { harness: "pi" }),
      );
      await open(page, {
        agents: [{ ...AGENT, activeVersionId: uuid(2007) }],
        agentVersions: many,
      });
      await page.getByRole("button", { name: /^Show all 7/ }).click();
      const sheet = page.getByRole("dialog", {
        name: "All versions of Code writer",
      });
      await expect(sheet.locator("[data-version-id]")).toHaveCount(7);
      await page.mouse.move(700, 700);
      await shot(page, "agent-show-all", [], { windowOnly: true });
    });
  });
}
