import { expect, type Page, test } from "@playwright/test";
import {
  type AgentVersionRow,
  definition,
  libraryFixture,
  type Options,
  uuid,
  type VersionRow,
} from "./helpers/library-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The Library's step names are the workflow editor spec's (design-ux, #432):
 * "Implement", not "Run the coding agent"; a sentence under each name for the
 * actions the spec describes; the whole catalogue named, so a workflow that
 * uses any of it never shows a raw action name; an action the spec does not
 * name keeps showing its own identifier.
 */

/** Every action of the spec's catalogue with its name, and the sentence under it ("" for none yet). */
const CATALOGUE: readonly [string, string, string][] = [
  [
    "task.brief",
    "Write the task brief",
    "Writes down what the task is, for the steps after it.",
  ],
  [
    "rpi.research",
    "Research",
    "Reads the task and the code, then writes up what it found.",
  ],
  ["rpi.design", "Design", "Turns the research into a design document."],
  ["rpi.plan", "Plan", "Writes a step-by-step plan for the change."],
  [
    "harness.implement",
    "Implement",
    "A coding agent makes the change in the repository.",
  ],
  [
    "harness.repair",
    "Fix problems",
    "A coding agent fixes failed checks and review findings.",
  ],
  [
    "agent.review",
    "Review",
    "A separate agent reviews the changes and lists what it found.",
  ],
  [
    "review.independent",
    "Review",
    "A separate agent reviews the changes and lists what it found.",
  ],
  [
    "agent.freeform",
    "Custom agent task",
    "An agent follows instructions written for this step.",
  ],
  [
    "quality.check",
    "Run checks",
    "Runs the repository's lint, tests and build.",
  ],
  [
    "delivery.merge",
    "Merge",
    "Merges the changes when checks and review allow it.",
  ],
  ["delivery.prepare", "Prepare a release", ""],
  ["delivery.deploy", "Deploy", ""],
  ["delivery.health", "Check health", ""],
  ["artifact.publish", "Publish a document", ""],
];

const WORKFLOW = definition(10, "Release train", {
  activeVersionId: uuid(1001),
});
const AGENT = definition(20, "Code writer");
const AGENT_VERSIONS: AgentVersionRow[] = [
  { id: uuid(2000), agentId: AGENT.id, revision: 1 },
];
const VERSION: VersionRow = {
  id: uuid(1001),
  workflowId: WORKFLOW.id,
  revision: 1,
  status: "published",
  steps: [
    ...CATALOGUE.map(([uses], index) => ({
      id: `s${index}`,
      uses,
      ...(uses === "harness.implement" ? { agentVersionId: uuid(2000) } : {}),
    })),
    { id: "other", uses: "custom.thing" },
  ],
};
const WORLD: Options = {
  workflows: [WORKFLOW],
  agents: [AGENT],
  agentVersions: AGENT_VERSIONS,
  versions: [VERSION],
};

const open = async (page: Page) => {
  await libraryFixture(page, WORLD);
  await page.goto(`/library/workflows/${WORKFLOW.id}`);
  await expect(page.getByTestId("workflow-steps")).toBeVisible({
    timeout: 20_000,
  });
};

test("every action of the spec's catalogue is named, with its sentence where the spec has one", async ({ page }) => {
  await open(page);
  const steps = page.getByTestId("workflow-steps");
  for (const [index, [uses, name, line]] of CATALOGUE.entries()) {
    const step = steps.locator(`[data-card=s${index}]`);
    await expect(step, uses).toContainText(name);
    // Never the action's own identifier.
    await expect(step, uses).not.toContainText(uses);
    const action = step.locator(".ui-step-card__summary");
    await expect(action, uses).toHaveText(line);
  }
});

test("the old name is gone, and the sentence sits above the agent line", async ({ page }) => {
  await open(page);
  const steps = page.getByTestId("workflow-steps");
  await expect(steps).not.toContainText("Run the coding agent");
  await expect(steps).not.toContainText("Review the changes");
  const implement = steps.locator("[data-card=s4]");
  await expect(implement.locator(".ui-step-card__summary")).toHaveText(
    "A coding agent makes the change in the repository.",
  );
  await expect(implement.locator('[data-step-extra="true"]')).toHaveText(
    "Agent: Code writer, version 1",
  );
  const sentence = (await implement.locator(".ui-step-card__summary")
    .boundingBox())!;
  const agent = (await implement.locator('[data-step-extra="true"]')
    .boundingBox())!;
  expect(sentence.y).toBeLessThan(agent.y);
});

test("an action the spec does not name keeps showing its own identifier, with no sentence", async ({ page }) => {
  await open(page);
  const other = page.getByTestId("workflow-steps").locator(
    "[data-card=other]",
  );
  await expect(other).toContainText("custom.thing");
  await expect(other.locator(".ui-step-card__summary")).toHaveText("");
  await page.mouse.move(700, 700);
  await shot(page, "workflow-step-names");
});
