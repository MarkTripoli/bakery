import { expect, type Page, test } from "@playwright/test";
import {
  definition,
  libraryFixture,
  type Options,
  uuid,
} from "./helpers/library-fixture.ts";
import { repository, repositoryBody } from "./helpers/projects-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const API = repository(1, uuid(101), "api");
const WEB = repository(2, uuid(101), "web", { providerRepoId: "acme/web" });
const WORKFLOW = definition(10, "Release train", {
  activeVersionId: uuid(1001),
});
const EDIT = `/library/workflows/${WORKFLOW.id}/edit`;
const NEEDS = {
  repositoryId: { type: "uuid", required: true },
  brief: { type: "TaskBrief", required: true },
};
const SCHEDULE = {
  id: "nightly",
  on: { kind: "schedule", cron: "0 2 * * *", timezone: "Europe/London" },
};

type Start = Record<string, unknown>;

type Setup = {
  readonly inputs?: Record<string, unknown>;
  readonly starts?: readonly Start[];
  readonly repositoriesStatus?: number;
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: status < 400 ? "application/json" : "application/problem+json",
  body: JSON.stringify(body),
});

async function editor(page: Page, setup: Setup = {}) {
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
    starts: [...(setup.starts ?? [])] as Start[],
    version: 1,
    saves: [] as (Start[] | undefined)[],
    repositoriesStatus: setup.repositoriesStatus ?? 200,
  };
  const draft = () => ({
    id: uuid(1002),
    workflowId: WORKFLOW.id,
    revision: 2,
    sourceYaml: "",
    normalizedSpec: {
      inputs: setup.inputs ?? {},
      steps: [{ id: "brief", uses: "task.brief" }],
    },
    digest: String(server.version).padStart(2, "0").repeat(32),
    status: "draft",
    createdBy: uuid(1),
    createdAt: "2026-02-02T10:00:00.000Z",
    updatedAt: "2026-02-02T10:00:00.000Z",
    version: server.version,
    starts: server.starts,
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
      const sent = route.request().postDataJSON() as { starts?: Start[] };
      server.saves.push(sent.starts);
      server.starts = sent.starts ?? server.starts;
      server.version += 1;
      await route.fulfill(json(draft()));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/repositories",
    (route) =>
      server.repositoriesStatus === 200
        ? route.fulfill(
          json({ items: [API, WEB].map(repositoryBody), nextCursor: null }),
        )
        : route.fulfill(
          json({
            type: "about:blank",
            title: "x",
            status: server.repositoriesStatus,
            code: "INTERNAL_ERROR",
          }, server.repositoriesStatus),
        ),
  );
  await page.goto(EDIT);
  await expect(startCard(page)).toBeVisible();
  return server;
}

const startCard = (page: Page) => page.locator("[data-card='start']");
const rows = (page: Page) => page.getByTestId("start-row");
const field = (page: Page, name: string) =>
  rows(page).first().getByRole("combobox", { name });
const add = (page: Page) =>
  page.getByRole("button", { name: "Add an automatic start" });

test.describe("workflow editor: how it starts", () => {
  test("a start is added, scoped to a repository and saved with the draft", async ({ page }) => {
    const server = await editor(page);
    await expect(startCard(page)).toContainText("From a task");
    await startCard(page).click();
    await expect(
      page.getByText(
        "Add one to have Bakery start this workflow when something happens",
      ),
    ).toBeVisible();
    await still(page, "starts-none");
    await add(page).click();
    await expect(startCard(page)).toContainText(
      "From a task · 1 automatic start",
    );
    await expect(field(page, "Repository")).toHaveValue("");
    await expect(field(page, "Repository").locator("option")).toHaveText([
      "Any connected repository",
      "acme/api",
    ]);
    await field(page, "When").selectOption("work_item.labeled");
    await expect(page.getByText("Any label counts.")).toBeVisible();
    await field(page, "Repository").selectOption(API.id);
    await expect.poll(() => server.saves.at(-1)).toEqual([{
      id: "start-1",
      budgetUsd: 5,
      on: {
        kind: "event",
        eventKind: "work_item.labeled",
        filter: { repositoryId: 5001 },
      },
    }]);
    await still(page, "starts-event");
  });

  test("a workflow with required inputs asks for them before it publishes", async ({ page }) => {
    const server = await editor(page, { inputs: NEEDS });
    await startCard(page).click();
    await add(page).click();
    await expect(startCard(page)).toContainText("Needs setup");
    await expect(page.getByText("Choose the repository this start runs in."))
      .toBeVisible();
    await still(page, "starts-needs-input");
    await page.getByRole("button", { name: "Publish" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "Automatic start 1: choose a repository.",
    );
    await expect(dialog.getByRole("button", { name: "Publish and use" }))
      .toHaveCount(0);
    await still(page, "starts-publish-blocked");
    await dialog.getByRole("button", { name: "Show me" }).first().click();
    await expect(field(page, "Repository")).toBeFocused();
    await field(page, "Repository").selectOption(WEB.id);
    await expect(
      page.getByText("Events from other repositories are recorded as failed"),
    ).toBeVisible();
    const title = page.getByRole("textbox", { name: /Task title/ });
    await title.fill("Triage the issue");
    await title.blur();
    await expect(startCard(page)).not.toContainText("Needs setup");
    await expect.poll(() => server.saves.at(-1)?.[0]?.inputs).toEqual({
      repositoryId: WEB.id,
      brief: {
        title: "Triage the issue",
        description: "",
        taskType: "feature",
      },
    });
    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Publish and use also switches on 1 automatic start.",
    );
    await still(page, "starts-publish");
  });

  test("a scheduled start says it does not run, and removing it can be undone", async ({ page }) => {
    const server = await editor(page, { starts: [SCHEDULE] });
    await expect(startCard(page)).toContainText("1 schedule that does not run");
    await startCard(page).click();
    await expect(page.getByText("On a schedule: 0 2 * * * (Europe/London)"))
      .toBeVisible();
    await expect(page.getByText("Bakery does not run scheduled starts yet."))
      .toBeVisible();
    await still(page, "starts-schedule");
    await page.getByRole("button", { name: "Remove automatic start 1" })
      .click();
    await expect.poll(() => server.saves.at(-1)).toEqual([]);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText("Automatic start 1 deleted")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect.poll(() => server.saves.at(-1)).toEqual([SCHEDULE]);
  });

  test("repositories that cannot be loaded say so, and Try again loads them", async ({ page }) => {
    const server = await editor(page, { repositoriesStatus: 500 });
    await startCard(page).click();
    await add(page).click();
    await expect(page.getByText("Repositories could not be loaded."))
      .toBeVisible();
    await expect(field(page, "Repository")).toBeDisabled();
    server.repositoriesStatus = 200;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(field(page, "Repository")).toBeEnabled();
  });
});
