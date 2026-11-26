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
  readonly inUse?: "listed" | "none";
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: status < 400 ? "application/json" : "application/problem+json",
  body: JSON.stringify(body),
});

async function editor(page: Page, setup: Setup = {}) {
  const workflow = setup.inUse === "none"
    ? { ...WORKFLOW, activeVersionId: null }
    : { ...WORKFLOW };
  const options: Options = {
    workflows: [workflow],
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
  const seen = await libraryFixture(page, options);
  const server = {
    starts: [...(setup.starts ?? [])] as Start[],
    version: 1,
    saves: [] as (Start[] | undefined)[],
    repositoriesStatus: setup.repositoriesStatus ?? 200,
    status: "draft",
    id: uuid(1002),
    revision: 2,
    older: [] as unknown[],
    publishes: 0,
    activations: seen.activations,
  };
  const draft = () => ({
    id: server.id,
    workflowId: WORKFLOW.id,
    revision: server.revision,
    sourceYaml: "",
    normalizedSpec: {
      inputs: setup.inputs ?? {},
      steps: [{ id: "brief", uses: "task.brief" }],
    },
    digest: String(server.version).padStart(2, "0").repeat(32),
    status: server.status,
    createdBy: uuid(1),
    createdAt: "2026-02-02T10:00:00.000Z",
    updatedAt: "2026-02-02T10:00:00.000Z",
    version: server.version,
    starts: server.starts,
  });
  await page.route(
    (url) => url.pathname === `/v1/workflows/${WORKFLOW.id}/versions`,
    (route) => {
      if (route.request().method() === "POST") {
        server.older = [draft()];
        server.id = uuid(1003);
        server.revision = 3;
        server.status = "draft";
        server.version = 1;
        return route.fulfill(json(draft(), 201));
      }
      return route.fulfill(json({
        items: setup.inUse === "listed"
          ? [draft(), {
            ...draft(),
            id: uuid(1001),
            revision: 1,
            status: "published",
            starts: [],
          }]
          : [draft(), ...server.older],
        nextCursor: null,
      }));
    },
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/workflows/${WORKFLOW.id}/versions/${server.id}`,
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
  await page.route(
    (url) => url.pathname.endsWith("/publish"),
    (route) => {
      server.publishes += 1;
      if (server.status !== "draft") {
        return route.fulfill(
          json({
            type: "about:blank",
            title: "x",
            status: 409,
            code: "STATE_CONFLICT",
          }, 409),
        );
      }
      server.status = "published";
      server.version += 1;
      return route.fulfill(json(draft()));
    },
  );
  await page.goto(EDIT);
  await expect(startCard(page)).toBeVisible();
  return server;
}

const startCard = (page: Page) => page.locator("[data-card='start']");
const rows = (page: Page) => page.getByTestId("start-row");
const field = (page: Page, name: string, exact = false) =>
  rows(page).first().getByRole("combobox", { name, exact });
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

  test("what is typed in a start is saved without leaving the box", async ({ page }) => {
    const server = await editor(page, { inputs: NEEDS });
    await startCard(page).click();
    await add(page).click();
    const title = page.getByRole("textbox", { name: /Task title/ });
    await title.pressSequentially("Triage the new issue", { delay: 60 });
    await expect.poll(
      () =>
        (server.saves.at(-1)?.[0]?.inputs as { brief?: { title: string } })
          ?.brief?.title,
      { timeout: 10_000 },
    ).toBe("Triage the new issue");
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("Triage the new issue");
    const budget = page.getByRole("textbox", { name: /Spend limit/ });
    await budget.fill("");
    await budget.pressSequentially("12.5", { delay: 60 });
    await expect(budget).toHaveValue("12.5");
    await expect.poll(() => server.saves.at(-1)?.[0]?.budgetUsd).toBe(12.5);
  });

  test("a hand-written schedule is shown as written, and removing it can be undone", async ({ page }) => {
    const written = {
      ...SCHEDULE,
      on: { ...SCHEDULE.on, cron: "*/15 2 * * *" },
      inputs: { repositoryId: API.id },
    };
    const server = await editor(page, { starts: [written] });
    await expect(startCard(page)).toContainText(
      "From a task · 1 automatic start",
    );
    await startCard(page).click();
    await expect(field(page, "Repeats")).toHaveValue("custom");
    await expect(field(page, "Repeats").locator("option:checked"))
      .toHaveText("As written: */15 2 * * *");
    await expect(field(page, "Time", true)).toHaveCount(0);
    await expect(field(page, "Time zone")).toHaveValue("Europe/London");
    await page.getByRole("button", { name: "Remove automatic start 1" })
      .click();
    await expect.poll(() => server.saves.at(-1)).toEqual([]);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText("Automatic start 1 deleted")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect.poll(() => server.saves.at(-1)).toEqual([written]);
  });

  test("a start is put on a schedule, with its next starts listed", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-27T10:30:00.000Z"));
    const server = await editor(page);
    await startCard(page).click();
    await add(page).click();
    await field(page, "When").selectOption({ label: "On a schedule" });
    await expect(field(page, "Repeats")).toHaveValue("weekdays");
    await expect(field(page, "Time", true)).toHaveValue("09:00");
    await expect(field(page, "Repository")).toHaveValue(API.id);
    await expect.poll(() => server.saves.at(-1)?.[0]).toMatchObject({
      inputs: { repositoryId: API.id },
      on: { kind: "schedule", cron: "0 9 * * 1-5" },
    });
    await field(page, "Repeats").selectOption("mon");
    await field(page, "Time", true).selectOption("07:30");
    await field(page, "Time zone").selectOption("Europe/London");
    await field(page, "Repository").selectOption(WEB.id);
    await expect.poll(() => server.saves.at(-1)?.[0]).toMatchObject({
      inputs: { repositoryId: WEB.id },
      on: { kind: "schedule", cron: "30 7 * * 1", timezone: "Europe/London" },
    });
    const next = page.getByTestId("start-next");
    await expect(next).toContainText("Mon, Nov 30 07:30");
    await expect(next).toContainText("Mon, Dec 28 07:30");
    await expect(page.getByText("If the clocks skip this time")).toBeVisible();
    await still(page, "starts-schedule");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Publish and use also switches on 1 automatic start.",
    );
    await page.getByRole("button", { name: "Keep editing" }).click();
    await field(page, "When").selectOption("work_item.opened");
    await expect(field(page, "Repeats")).toHaveCount(0);
    await expect.poll(() => server.saves.at(-1)?.[0]?.on).toMatchObject({
      kind: "event",
      eventKind: "work_item.opened",
    });
  });

  test("a schedule written without a repository asks for one", async ({ page }) => {
    await editor(page, { starts: [SCHEDULE] });
    await expect(startCard(page)).toContainText("Needs setup");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("alertdialog")
      .getByRole("button", { name: "Show me" }).click();
    await expect(field(page, "Repository")).toBeFocused();
    await expect(page.getByText("Choose the repository this start runs in."))
      .toBeVisible();
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

test.describe("workflow editor: a published workflow", () => {
  test("an edit opens a draft first and is saved into it with the starts", async ({ page }) => {
    await libraryFixture(page, {
      workflows: [WORKFLOW],
      versions: [{
        id: uuid(1001),
        workflowId: WORKFLOW.id,
        revision: 1,
        status: "published",
        steps: [{ id: "brief", uses: "task.brief" }],
      }],
    });
    const writes: string[] = [];
    const published = {
      id: uuid(1001),
      workflowId: WORKFLOW.id,
      revision: 1,
      sourceYaml: "",
      normalizedSpec: { steps: [{ id: "brief", uses: "task.brief" }] },
      digest: "01".repeat(32),
      status: "published",
      createdBy: uuid(1),
      createdAt: "2026-02-02T10:00:00.000Z",
      updatedAt: "2026-02-02T10:00:00.000Z",
      version: 3,
      starts: [SCHEDULE],
    };
    let draft: Record<string, unknown> | null = null;
    let sentStarts: unknown;
    await page.route(
      (url) => url.pathname === `/v1/workflows/${WORKFLOW.id}/versions`,
      (route) => {
        if (route.request().method() === "GET") {
          return route.fulfill(json({
            items: draft === null ? [published] : [draft, published],
            nextCursor: null,
          }));
        }
        writes.push("create");
        draft = {
          ...published,
          id: uuid(1002),
          revision: 2,
          status: "draft",
          version: 1,
          starts: [],
        };
        return route.fulfill(json(draft, 201));
      },
    );
    await page.route(
      (url) =>
        /\/versions\/[^/]+$/.test(url.pathname) &&
        url.pathname.includes(WORKFLOW.id),
      (route) => {
        const id = new URL(route.request().url()).pathname.split("/").at(-1);
        writes.push(id === uuid(1002) ? "save draft" : "save published");
        if (id !== uuid(1002)) {
          return route.fulfill(
            json({
              type: "about:blank",
              title: "x",
              status: 409,
              code: "STATE_CONFLICT",
            }, 409),
          );
        }
        const body = route.request().postDataJSON() as {
          definition: Record<string, unknown>;
          starts?: unknown;
        };
        sentStarts = body.starts;
        draft = {
          ...draft,
          normalizedSpec: body.definition,
          starts: body.starts ?? [],
          version: 2,
        };
        return route.fulfill(json(draft));
      },
    );
    await page.goto(EDIT);
    await page.getByRole("button", { name: /Add a step after/ }).last().click();
    await page.getByTestId("step-picker")
      .locator("[data-pick-step='review.independent']").click();
    await expect.poll(() => writes).toEqual(["create", "save draft"]);
    expect(sentStarts).toEqual([SCHEDULE]);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.locator("[data-card]")).toHaveCount(3);
  });

  test("a spend limit that cannot be saved as typed blocks publishing", async ({ page }) => {
    const server = await editor(page);
    await startCard(page).click();
    await add(page).click();
    const limit = page.getByRole("textbox", { name: /Spend limit/ });
    for (const typed of ["$25", "5,00", "-1", "abc", "20000"]) {
      await limit.fill(typed);
      await expect(limit).toHaveValue(typed);
      await expect(limit).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByText("Write an amount from 0 to 10000"))
        .toBeVisible();
      await expect(startCard(page)).toContainText("Needs setup");
    }
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "Automatic start 1: fix the spend limit.",
    );
    await expect(dialog).toContainText("How it starts");
    await expect(dialog).not.toContainText("Started by hand");
    await expect(dialog.getByRole("button", { name: "Publish and use" }))
      .toHaveCount(0);
    await still(page, "starts-budget-blocked");
    await dialog.getByRole("button", { name: "Show me" }).click();
    await expect(limit).toBeFocused();
    await limit.fill("2.50");
    await expect(page.getByText("Write an amount from 0 to 10000"))
      .toHaveCount(0);
    await expect.poll(() => server.saves.at(-1)?.[0]?.budgetUsd).toBe(2.5);
    expect(JSON.stringify(server.saves)).not.toContain("budgetTyped");
  });

  test("Show me puts the cursor in the field each problem names", async ({ page }) => {
    await editor(page, {
      inputs: {
        ...NEEDS,
        goal: { type: "string", required: true },
        retries: { type: "number", required: true },
      },
    });
    await startCard(page).click();
    await add(page).click();
    const show = async (sentence: string) => {
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await page.getByRole("alertdialog")
        .locator("[data-problem-row]", { hasText: sentence })
        .getByRole("button", { name: "Show me" }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
    };
    await show("write a value for goal");
    await expect(page.getByRole("textbox", { name: /^goal/ })).toBeFocused();
    await show("write a task title");
    await expect(page.getByRole("textbox", { name: /Task title/ }))
      .toBeFocused();
    await show("retries cannot be filled in here");
    await expect(page.locator(":focus")).toContainText(
      "This workflow asks for retries",
    );
    await show("choose a repository");
    await expect(field(page, "Repository")).toBeFocused();
  });

  for (const inUse of ["none", "listed"] as const) {
    test(`a version published but not used can be put in use, in use before: ${inUse}`, async ({ page }) => {
      const server = await editor(page, { inUse });
      await startCard(page).click();
      await add(page).click();
      await expect.poll(() => server.saves.length).toBeGreaterThan(0);
      const publish = page.getByRole("button", {
        name: "Publish",
        exact: true,
      });
      const dialog = page.getByRole("alertdialog");
      await publish.click();
      await dialog.getByRole("button", { name: "Publish only" }).click();
      await expect(dialog).toHaveCount(0);
      await publish.click();
      await expect(dialog).toContainText("Use version 2");
      await expect(dialog).toContainText(
        "Using it also switches on 1 automatic start.",
      );
      await expect(dialog.getByRole("button", { name: "Publish only" }))
        .toHaveCount(0);
      await still(page, "starts-use-published");
      await dialog.getByRole("button", { name: "Use this version" }).click();
      await expect(dialog).toHaveCount(0);
      expect(server.activations.map((one) => one.body.versionId)).toEqual([
        uuid(1002),
      ]);
      expect(server.publishes).toBe(1);
    });
  }

  for (const earlier of ["5", ""]) {
    test(`a limit typed past what can be saved leaves the earlier limit saved: "${earlier}"`, async ({ page }) => {
      const server = await editor(page);
      await startCard(page).click();
      await add(page).click();
      const limit = page.getByRole("textbox", { name: /Spend limit/ });
      const saved = () => String(server.saves.at(-1)?.[0]?.budgetUsd ?? "");
      await expect.poll(saved).toBe("5");
      for (const typed of ["20000", "1e3"]) {
        await limit.fill(earlier);
        await limit.blur();
        await expect.poll(saved).toBe(earlier);
        await limit.focus();
        await limit.press("ControlOrMeta+a");
        await limit.pressSequentially(typed, { delay: 800 });
        await expect(limit).toHaveAttribute("aria-invalid", "true");
        await expect.poll(saved).toBe(earlier);
      }
    });
  }

  test("after Publish only, the next edit is offered as the next version", async ({ page }) => {
    const server = await editor(page, { inUse: "none" });
    await startCard(page).click();
    await add(page).click();
    await expect.poll(() => server.saves.length).toBeGreaterThan(0);
    const publish = page.getByRole("button", { name: "Publish", exact: true });
    const dialog = page.getByRole("alertdialog");
    await publish.click();
    await expect(dialog).toContainText("Publish version 2");
    await dialog.getByRole("button", { name: "Publish only" }).click();
    await expect(dialog).toHaveCount(0);
    const before = server.saves.length;
    await field(page, "When").selectOption("work_item.labeled");
    await expect.poll(() => server.saves.length).toBeGreaterThan(before);
    await publish.click();
    await expect(dialog).toContainText("Publish version 3");
  });
});
