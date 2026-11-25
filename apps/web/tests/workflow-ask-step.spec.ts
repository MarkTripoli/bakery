import { expect, type Page, test } from "@playwright/test";
import {
  definition,
  libraryFixture,
  type Options,
  uuid,
} from "./helpers/library-fixture.ts";
import { MOCK_ORGANIZATION_ID } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const DANA = "11111111-1111-4111-8111-111111111111";
const LEE = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";
const LONG_NAME =
  "Anneliese Mariana Featherstonehaugh-Villanueva of the release engineering group";

const WORKFLOW = definition(10, "Release train", {
  activeVersionId: uuid(1001),
});
const EDIT = `/library/workflows/${WORKFLOW.id}/edit`;

const member = (
  principalId: string,
  displayName: string,
  status = "active",
) => ({
  id: principalId.replace(/^./, "a"),
  organizationId: MOCK_ORGANIZATION_ID,
  principalId,
  displayName,
  role: "developer",
  status,
  joinedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
});
const MEMBERS = [
  member(DANA, "Dana Okafor"),
  member(LEE, LONG_NAME),
  member(GONE, "Sam Rivers", "inactive"),
];

type Step = Record<string, unknown>;

type Setup = {
  readonly steps?: readonly Step[];
  readonly membersStatus?: number;
  readonly saveDelayMs?: number;
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function editor(page: Page, setup: Setup = {}) {
  const steps = setup.steps ?? [{ id: "brief", uses: "task.brief" }];
  const options: Options = {
    workflows: [WORKFLOW],
    versions: [{
      id: uuid(1001),
      workflowId: WORKFLOW.id,
      revision: 1,
      status: "published",
      steps: [{ id: "brief", uses: "task.brief" }],
    }, {
      id: uuid(1002),
      workflowId: WORKFLOW.id,
      revision: 2,
      status: "draft",
      steps: [{ id: "brief", uses: "task.brief" }],
    }],
  };
  await libraryFixture(page, options);
  const server = {
    steps: [...steps] as Step[],
    version: 1,
    saves: [] as Step[][],
    membersStatus: setup.membersStatus ?? 200,
  };
  const draft = () => ({
    id: uuid(1002),
    workflowId: WORKFLOW.id,
    revision: 2,
    sourceYaml: "",
    normalizedSpec: { steps: server.steps },
    digest: String(server.version).padStart(2, "0").repeat(32),
    status: "draft",
    createdBy: uuid(1),
    createdAt: "2026-02-02T10:00:00.000Z",
    updatedAt: "2026-02-02T10:00:00.000Z",
    version: server.version,
    starts: [],
  });
  await page.route(
    (url) => url.pathname === `/v1/workflows/${WORKFLOW.id}/versions`,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill(json({ items: [draft()], nextCursor: null }))
        : route.fallback(),
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/workflows/${WORKFLOW.id}/versions/${uuid(1002)}`,
    async (route) => {
      const sent = route.request().postDataJSON() as {
        definition: { steps: Step[] };
      };
      server.saves.push(sent.definition.steps);
      if (setup.saveDelayMs) {
        await new Promise((done) => setTimeout(done, setup.saveDelayMs));
      }
      server.steps = sent.definition.steps;
      server.version += 1;
      await route.fulfill(json(draft()));
    },
  );
  await page.route(
    (url) => url.pathname.endsWith("/memberships"),
    (route) =>
      server.membersStatus === 200
        ? route.fulfill(json({ items: MEMBERS, nextCursor: null }))
        : route.fulfill({
          status: server.membersStatus,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "x",
            status: server.membersStatus,
            code: "INTERNAL_ERROR",
          }),
        }),
  );
  await page.goto(EDIT);
  await expect(page.locator("[data-card='start']")).toBeVisible();
  return server;
}

const ask = (input?: Record<string, unknown>): Step => ({
  id: "ask",
  uses: "human.approval",
  ...(input === undefined ? {} : { with: input }),
});

const card = (page: Page) => page.locator("[data-card='ask']");
const prompt = (page: Page) =>
  page.getByRole("textbox", { name: /What you are asking/ });
const who = (page: Page) =>
  page.getByRole("combobox", { name: "Who is asked" });
const savedInput = (steps: Step[] | undefined) =>
  steps?.find((step) => step.uses === "human.approval")?.with;

const PROMPT_PROBLEM =
  "Write what you are asking. The workflow cannot be published without it.";

test.describe("workflow editor: Ask a person", () => {
  test("adding the step shows its fields, the owner by default and the missing question", async ({ page }) => {
    const server = await editor(page);
    await page.getByRole("button", { name: /Add a step after/ }).last().click();
    const picker = page.getByTestId("step-picker");
    await expect(picker.locator("[data-pick-step='human.approval']"))
      .toContainText("The run waits until someone approves.");
    await picker.locator("[data-pick-step='human.approval']").click();
    await expect(
      page.getByText(
        "This step stops the run and asks a person. The run continues when they answer.",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("approval-people"))
      .toHaveText("The workflow's owner");
    await expect(page.getByRole("alert").filter({ hasText: PROMPT_PROBLEM }))
      .toBeVisible();
    await expect(page.getByText("If nobody answers after 7 days"))
      .toBeVisible();
    await expect(page.locator("[data-card]").last()).toContainText(
      "Needs setup",
    );
    await still(page, "ask-step-empty");
    await prompt(page).fill("Ship the release for $5?");
    await prompt(page).blur();
    await expect(page.locator("[data-card]").last()).toContainText(
      "Asks the workflow's owner to approve",
    );
    await expect.poll(() => savedInput(server.saves.at(-1))).toEqual({
      prompt: { $literal: "Ship the release for $5?" },
    });
    await expect(page.getByText(PROMPT_PROBLEM)).toHaveCount(0);
  });

  test("people are added and removed, and the card says who is asked", async ({ page }) => {
    const server = await editor(page, { steps: [ask({ prompt: "Ship it?" })] });
    await card(page).click();
    await who(page).selectOption(DANA);
    await expect(card(page)).toContainText("Asks Dana Okafor to approve");
    await who(page).selectOption(LEE);
    await expect(card(page)).toContainText(
      "Asks Dana Okafor and 1 other to approve",
    );
    await expect(who(page).locator("option")).not.toContainText([
      "Sam Rivers",
    ]);
    await page.getByRole("checkbox", { name: "Let them request changes" })
      .uncheck();
    await page.getByRole("textbox", { name: "Approve button" }).fill("Ship");
    await page.getByRole("textbox", { name: "Reject button" }).fill("Hold");
    await page.getByRole("textbox", { name: "Reject button" }).press("Enter");
    await expect.poll(() => savedInput(server.saves.at(-1))).toEqual({
      prompt: "Ship it?",
      audience: [DANA, LEE],
      allowRequestChanges: false,
      approveLabel: "Ship",
      rejectLabel: "Hold",
    });
    await still(page, "ask-step-filled");
    await page.getByRole("button", { name: "Remove Dana Okafor" }).click();
    await expect.poll(() =>
      (savedInput(server.saves.at(-1)) as { audience: string[] }).audience
    ).toEqual([LEE]);
  });

  test("someone who left is named, and Publish lists it without publishing", async ({ page }) => {
    await editor(page, {
      steps: [ask({ prompt: "Ship it?", audience: [GONE] })],
    });
    await card(page).click();
    const problem =
      "Sam Rivers is no longer a member of Fixture Org. Remove them or choose someone else. A run cannot start while they are the only person asked.";
    await expect(page.getByRole("alert").filter({ hasText: problem }))
      .toBeVisible();
    await still(page, "ask-step-left");
    await page.getByRole("button", { name: "Publish" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "Fix these first. The workflow cannot be published until you do.",
    );
    await expect(dialog.getByRole("button", { name: /^Publish/ })).toHaveCount(
      0,
    );
    await still(page, "ask-step-publish-blocked");
    await dialog.getByRole("button", { name: "Show me" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(who(page)).toBeFocused();
  });

  test("Show me on a missing question lands in the question", async ({ page }) => {
    await editor(page, { steps: [ask()] });
    await page.getByRole("button", { name: "Publish" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Show me" })
      .click();
    await expect(prompt(page)).toBeFocused();
  });

  test("people that cannot be loaded say so, and Try again loads them", async ({ page }) => {
    const server = await editor(page, {
      steps: [ask({ prompt: "Ship it?" })],
      membersStatus: 500,
    });
    await card(page).click();
    await expect(page.getByText("People could not be loaded.")).toBeVisible();
    await expect(who(page)).toBeDisabled();
    server.membersStatus = 200;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(who(page)).toBeEnabled();
  });

  test("an edit made while a save is on its way is kept", async ({ page }) => {
    const server = await editor(page, {
      steps: [ask({ prompt: "Ship it?" })],
      saveDelayMs: 1200,
    });
    await card(page).click();
    await prompt(page).fill("Ship the release?");
    await prompt(page).blur();
    await expect.poll(() => server.saves.length).toBe(1);
    await page.getByRole("checkbox", { name: "Let them request changes" })
      .uncheck();
    await expect.poll(() => savedInput(server.saves.at(-1)), {
      timeout: 10_000,
    }).toEqual({ prompt: "Ship the release?", allowRequestChanges: false });
    await expect(
      page.getByRole("checkbox", { name: "Let them request changes" }),
    ).not.toBeChecked();
  });

  test("a step asking a group is left to the code view", async ({ page }) => {
    await editor(page, {
      steps: [ask({ prompt: "Ok?", audience: ["@design-reviewers"] })],
    });
    await card(page).click();
    await expect(page.getByTestId("approval-fields")).toHaveCount(0);
    await expect(page.getByText(/written in code/)).toBeVisible();
  });
});
