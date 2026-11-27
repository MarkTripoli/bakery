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
const DESIGNERS = "44444444-4444-4444-8444-444444444444";

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
const MEMBERS = [member(DANA, "Dana Okafor")];
const GROUPS = {
  groups: [{
    id: DESIGNERS,
    name: "Design reviewers",
    mentionName: "design-reviewers",
    purpose: "",
    members: [],
    memberCount: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  }],
  fromRoles: [{
    roleKey: "admin",
    name: "Administrators",
    mentionName: "admins",
    kind: "system",
    memberCount: 2,
  }],
};

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
  await page.route(
    (url) => url.pathname === "/v1/groups",
    (route) => route.fulfill(json(GROUPS)),
  );
  await page.goto(EDIT);
  await expect(page.locator("[data-card='start']")).toBeVisible();
  return server;
}

const field = (page: Page, name: string) =>
  page.getByRole("combobox", { name, exact: true });
const savedInput = (steps: Step[] | undefined) =>
  steps?.find((step) => step.uses === "people.tag")?.with;
const lastCard = (page: Page) => page.locator("[data-card]").last();

const DESIGN: Step = { id: "design", uses: "rpi.design" };

test.describe("workflow editor: Notify", () => {
  test("a new Notify step tells the starter and does not wait", async ({ page }) => {
    const server = await editor(page);
    await page.getByRole("button", { name: /Add a step after/ }).last().click();
    const picker = page.getByTestId("step-picker");
    await expect(picker.locator("[data-pick-step='people.tag']"))
      .toContainText("Tell someone, or ask them, and carry on.");
    await picker.locator("[data-pick-step='people.tag']").click();
    await expect(field(page, "Who is asked")).toHaveValue("run:starter");
    await expect(page.getByRole("switch", { name: "Wait for an answer" }))
      .toBeDisabled();
    await expect(page.getByRole("switch", { name: "If nobody answers" }))
      .toHaveCount(0);
    await expect(lastCard(page)).toContainText(
      "Tells the person who started the run · does not wait",
    );
    await expect.poll(() => savedInput(server.saves.at(-1))).toEqual({
      recipientRunRole: "starter",
      intent: "fyi",
    });
    await still(page, "notify-new");
  });

  test("a waiting review asks a group, then one more, and is saved as the engine reads it", async ({ page }) => {
    const server = await editor(page, {
      steps: [DESIGN, {
        id: "ask",
        uses: "people.tag",
        with: { recipientRunRole: "starter", intent: "fyi" },
      }],
    });
    await page.locator("[data-card='ask']").click();
    await field(page, "Who is asked").selectOption(`group:${DESIGNERS}`);
    await field(page, "What they need to do").selectOption("review");
    await expect(page.getByText("Choose the document to review.").first())
      .toBeVisible();
    await field(page, "Works from").selectOption("design");
    await page.getByRole("switch", { name: "Wait for an answer" }).check();
    await page.getByRole("switch", { name: "If nobody answers" }).check();
    await expect(
      page.getByText("Choose who is asked next, or turn this off.").first(),
    ).toBeVisible();
    await field(page, "Ask").selectOption(`group:${DESIGNERS}`);
    await expect(
      page.getByText("Choose someone different from the first person asked.")
        .first(),
    ).toBeVisible();
    await field(page, "Ask").selectOption(`person:${DANA}`);
    await field(page, "After").selectOption("4");
    await expect(page.locator("[data-card='ask']")).toContainText(
      "Asks Design reviewers to review · then Dana Okafor after 4 hours",
    );
    await expect(page.getByText("If still nobody answers after 7 days"))
      .toBeVisible();
    await expect.poll(() => savedInput(server.saves.at(-1))).toEqual({
      recipientGroupId: DESIGNERS,
      intent: "review",
      artifactVersionId: "$step.design.artifact.versionId",
      wait: true,
      ifNobodyAnswers: { afterHours: 4, recipientId: DANA },
    });
    await still(page, "notify-waiting");
    await page.getByRole("switch", { name: "If nobody answers" }).uncheck();
    await page.getByRole("switch", { name: "If nobody answers" }).check();
    await expect(field(page, "Ask")).toHaveValue(`person:${DANA}`);
  });

  test("a step written with a document id stays in code", async ({ page }) => {
    await editor(page, {
      steps: [{
        id: "ask",
        uses: "people.tag",
        with: {
          recipientRunRole: "starter",
          intent: "review",
          artifactVersionId: DESIGNERS,
        },
      }],
    });
    await page.locator("[data-card='ask']").click();
    await expect(
      page.getByText(
        "This part of the workflow is written in code. You cannot change it here.",
      ),
    ).toBeVisible();
    await expect(field(page, "Who is asked")).toHaveCount(0);
  });
});
