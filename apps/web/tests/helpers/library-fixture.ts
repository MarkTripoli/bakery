import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

/** Stubs for the Library: the built-in presets, the organization's workflows and agents. */

export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAMP = "2026-01-01T00:00:00.000Z";

export type Definition = {
  id: string;
  name: string;
  description: string | null;
  activeVersionId: string | null;
  enabled: boolean;
};

export const definition = (
  n: number,
  name: string,
  over: Partial<Definition> = {},
): Definition => ({
  id: uuid(n),
  name,
  description: `${name} does its work.`,
  activeVersionId: uuid(n + 1000),
  enabled: true,
  ...over,
});

export type Options = {
  role?: "admin" | "developer";
  workflows?: Definition[];
  agents?: Definition[];
  /** A read that answers 500 INTERNAL_ERROR, or 403 AUTH_FORBIDDEN. */
  failing?: "workflows" | "agents" | "presets";
  forbidden?: boolean;
  /** The workflows read waits until `seen.release()`: the page is loading meanwhile. */
  hold?: boolean;
  /** The workflows read cannot connect, as when the device is offline. */
  offline?: boolean;
  /** Every workflows page says there is another, so the list is cut short. */
  endless?: boolean;
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/test",
    title: code,
    detail: code,
    status,
    code,
    retryable: status >= 500,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  }),
});
const body = (item: Definition) => ({
  id: item.id,
  slug: item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name: item.name,
  description: item.description,
  activeVersionId: item.activeVersionId,
  enabled: item.enabled,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
});

/** Stubs the session, the role and the three Library reads; returns what it saw and a switch to stop failing. */
export async function libraryFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = {
    release: () => release(),
    workflowReads: 0,
    agentReads: 0,
    presetReads: 0,
    failing: options.failing ?? null as Options["failing"] | null,
  };
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: options.role ?? "admin",
        capabilities: [],
      })),
  );
  const answer = (
    kind: "workflows" | "agents" | "presets",
    items: unknown[],
  ) =>
  (route: import("@playwright/test").Route) => {
    if (options.forbidden) return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    if (seen.failing === kind) {
      return route.fulfill(problem(500, "INTERNAL_ERROR"));
    }
    return route.fulfill(json({ items, nextCursor: null }));
  };
  await page.route(
    (url) => url.pathname === "/v1/workflows",
    async (route) => {
      seen.workflowReads += 1;
      if (options.offline) return route.abort("failed");
      if (options.endless) {
        return route.fulfill(json({
          items: [
            body(
              definition(
                300 + seen.workflowReads,
                `Page ${seen.workflowReads}`,
              ),
            ),
          ],
          nextCursor: `more-${seen.workflowReads}`,
        }));
      }
      if (options.hold) await held;
      return answer("workflows", (options.workflows ?? []).map(body))(route);
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/agents",
    (route) => {
      seen.agentReads += 1;
      return answer("agents", (options.agents ?? []).map(body))(route);
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/workflow-presets",
    (route) => {
      seen.presetReads += 1;
      return answer("presets", [
        {
          id: "fixed-coding",
          revision: 2,
          digest: "a".repeat(64),
          nameKey: "workflowPresets.fixedCoding.name",
          steps: [{ id: "brief", uses: "task.brief" }, {
            id: "implement",
            uses: "agent.code",
          }],
          defaultBudgetLimitUsd: "5.00",
          availability: null,
        },
        {
          id: "fixed-coding-reviewed",
          revision: 3,
          digest: "b".repeat(64),
          nameKey: "workflowPresets.fixedCodingReviewed.name",
          steps: [
            { id: "brief", uses: "task.brief" },
            { id: "implement", uses: "agent.code" },
            { id: "review", uses: "agent.review" },
          ],
          defaultBudgetLimitUsd: "8.00",
          availability: null,
        },
      ])(route);
    },
  );
  return seen;
}
