import { expect, type Page } from "@playwright/test";
import {
  definition,
  libraryFixture,
  type Options,
  uuid,
} from "./library-fixture.ts";
import { MOCK_ORGANIZATION_ID } from "./mock-session.ts";

export const DANA = "11111111-1111-4111-8111-111111111111";
export const DESIGNERS = "44444444-4444-4444-8444-444444444444";

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
  }, {
    roleKey: "developer",
    name: "Developers",
    mentionName: "developers",
    kind: "system",
    memberCount: 0,
  }],
};

export type Step = Record<string, unknown>;

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

export async function stepEditor(page: Page, setup: Setup = {}) {
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

export const field = (page: Page, name: string) =>
  page.getByRole("combobox", { name, exact: true });

export const savedInput = (steps: Step[] | undefined, uses: string) =>
  steps?.find((step) => step.uses === uses)?.with;

export const lastCard = (page: Page) => page.locator("[data-card]").last();
