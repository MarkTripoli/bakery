import { presetRead } from "./preset-read.ts";
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
  /** The definition's own version, sent back as If-Match. */
  version?: number;
  /** The address the server holds; the name's words when not given. */
  slug?: string;
};

/** One version of a workflow, with the steps its specification holds. */
export type VersionRow = {
  id: string;
  workflowId: string;
  revision: number;
  status: "draft" | "published" | "retired";
  steps: {
    id: string;
    uses: string;
    agentVersionId?: string;
    skills?: string[];
    /** A step that waits for others is written in code: the panel cannot show it. */
    needs?: string[];
  }[];
  /** The definition's own `steps` value, when a test needs nodes beyond plain actions. */
  spec?: unknown;
  /** The workflow's agent bindings by action. */
  agents?: Record<string, string>;
  createdAt?: string;
};
export type AgentVersionRow = {
  id: string;
  agentId: string;
  revision: number;
  /** What the version is configured to do (harness, billing, capabilities, bindings). */
  config?: Record<string, unknown>;
  createdAt?: string;
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
  versions?: VersionRow[];
  agentVersions?: AgentVersionRow[];
  /** The agents and their versions are read slowly (until `seen.releaseAgents()`) or fail. */
  agentReads?: "hold" | "fail";
  /** Every workflow versions page says there is another, two versions to a page. */
  endlessVersions?: boolean;
  /** What the checker says about a definition: fine (default), with problems, with only warnings, or it cannot answer. */
  validation?: "ok" | "errors" | "named" | "warnings" | "unbound" | "fail";
  /** A copy whose workflow cannot be made, or whose steps cannot be added (always, or on the first try). */
  copy?:
    | "workflow-fails"
    | "workflow-403"
    | "workflow-429"
    | "workflow-409-once"
    | "workflow-422-once"
    | "workflow-drop-once"
    | "steps-fail"
    | "steps-fail-once";
  /** A change that answers 409 (someone else got there first). */
  conflict?: "activate" | "update";
  /** A read that answers 500 INTERNAL_ERROR, or 403 AUTH_FORBIDDEN. */
  failing?: "workflows" | "agents" | "presets";
  forbidden?: boolean;
  /** The workflows read waits until `seen.release()`: the page is loading meanwhile. */
  hold?: boolean;
  /** The workflows read cannot connect, as when the device is offline. */
  offline?: boolean;
  /** Every workflows page says there is another, so the list is cut short. */
  endless?: boolean;
  /** What the skills read answers for any version: its items, or "fail" for a read that cannot be answered. */
  skills?: { items: unknown[] } | "fail";
  /** The skills the picker may offer (the skills list read): the skills, or "fail". Empty by default. */
  catalog?: unknown[] | "fail";
  /** Milliseconds the draft save takes to answer, so a test can edit while one is in flight. */
  saveDelayMs?: number;
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
  slug: item.slug ?? item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name: item.name,
  description: item.description,
  activeVersionId: item.activeVersionId,
  enabled: item.enabled,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: item.version ?? 1,
});
/** A workflow also says where it came from; an agent has no origin. */
const workflowBody = (item: Definition) => ({
  ...body(item),
  origin: {
    kind: "authored",
    catalogKey: null,
    catalogVersion: null,
    sourceWorkflowId: null,
    sourceVersionId: null,
    sourceDigest: null,
  },
});
const versionBody = (row: VersionRow) => ({
  id: row.id,
  workflowId: row.workflowId,
  revision: row.revision,
  sourceYaml:
    `kind: fixed\n# version ${row.revision} of ${row.workflowId}\nsteps:\n${
      row.steps.map((step) => `  - id: ${step.id}\n    uses: ${step.uses}\n`)
        .join("")
    }`,
  normalizedSpec: {
    kind: "fixed",
    workflow: { kind: "fixed" },
    steps: row.spec ?? row.steps,
    ...(row.agents ? { agents: row.agents } : {}),
  },
  digest: String(row.revision).padStart(2, "0").repeat(32),
  status: row.status,
  createdBy: uuid(1),
  createdAt: row.createdAt ?? "2026-02-0" + Math.min(row.revision, 9) +
      "T10:00:00.000Z",
  updatedAt: STAMP,
  version: 1,
  // The version's own starts (#406): none, in these fixtures.
  starts: [],
});

/** Stubs the session, the role and the three Library reads; returns what it saw and a switch to stop failing. */
export const SAVED_DIGEST = "ab".repeat(32);

export async function libraryFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const workflows = (options.workflows ?? []).map((item) => ({ ...item }));
  const agents = (options.agents ?? []).map((item) => ({ ...item }));
  const versions = (options.versions ?? []).map((row) => ({ ...row }));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseAgents: () => void = () => {};
  const agentsHeld = new Promise<void>((resolve) => {
    releaseAgents = resolve;
  });
  let versionPages = 0;
  const seen = {
    release: () => release(),
    draftSaves: [] as {
      versionId: string;
      ifMatch: string | null;
      body: Record<string, unknown>;
    }[],
    releaseAgents: () => releaseAgents(),
    agentActivations: [] as {
      id: string;
      ifMatch: string | null;
      body: Record<string, unknown>;
    }[],
    agentUpdates: [] as {
      id: string;
      ifMatch: string | null;
      body: Record<string, unknown>;
    }[],
    activations: [] as {
      id: string;
      ifMatch: string | null;
      body: Record<string, unknown>;
    }[],
    updates: [] as {
      id: string;
      ifMatch: string | null;
      body: Record<string, unknown>;
    }[],
    created: [] as {
      slug: string;
      name: string;
      description: string;
    }[],
    versionsCreated: [] as {
      workflowId: string;
      definition: { steps?: { id: string; uses: string }[] };
      sourceYaml?: string;
    }[],
    stepWrites: 0,
    validations: [] as { definition: unknown }[],
    /** The Idempotency-Key of each workflow write and each version write, in order. */
    workflowKeys: [] as (string | undefined)[],
    versionKeys: [] as (string | undefined)[],
    workflowWrites: 0,
    workflowReads: 0,
    agentReads: 0,
    presetReads: 0,
    /** Reads of a version's skills, and what the next one answers (a test may change it). */
    skillReads: 0,
    skillsAnswer: options.skills as Options["skills"],
    /** Reads of the skills catalog, and what the next one answers. */
    catalogReads: 0,
    catalogAnswer: options.catalog as Options["catalog"],
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
      if (route.request().method() === "POST") {
        seen.workflowWrites += 1;
        seen.workflowKeys.push(route.request().headers()["idempotency-key"]);
        const first = seen.workflowWrites === 1;
        if (options.copy === "workflow-fails") {
          return route.fulfill(problem(500, "INTERNAL_ERROR"));
        }
        if (options.copy === "workflow-403") {
          return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
        }
        if (options.copy === "workflow-429") {
          return route.fulfill(problem(429, "RATE_LIMITED"));
        }
        if (options.copy === "workflow-409-once" && first) {
          return route.fulfill(problem(409, "STATE_CONFLICT"));
        }
        if (options.copy === "workflow-422-once" && first) {
          return route.fulfill(problem(422, "UNPROCESSABLE"));
        }
        if (options.copy === "workflow-drop-once" && first) {
          return route.abort("failed");
        }
        const input = route.request().postDataJSON() as {
          slug: string;
          name: string;
          description: string;
        };
        seen.created.push(input);
        const made = definition(900 + seen.created.length, input.name, {
          description: input.description,
          activeVersionId: null,
          slug: input.slug,
        });
        workflows.push(made);
        return route.fulfill({ ...json(workflowBody(made)), status: 201 });
      }
      seen.workflowReads += 1;
      if (options.offline) return route.abort("failed");
      if (options.endless) {
        return route.fulfill(json({
          items: [
            workflowBody(
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
      return answer("workflows", workflows.map(workflowBody))(route);
    },
  );
  const conflict = (route: import("@playwright/test").Route) =>
    route.fulfill(problem(409, "STATE_CONFLICT"));
  await page.route(
    (url) => /^\/v1\/workflows\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      const target = workflows.find((item) => item.id === id);
      if (!target) return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
      if (route.request().method() === "PATCH") {
        seen.updates.push({
          id,
          ifMatch: route.request().headers()["if-match"] ?? null,
          body: route.request().postDataJSON() as Record<string, unknown>,
        });
        if (options.conflict === "update") return conflict(route);
        const patch = route.request().postDataJSON() as Partial<Definition>;
        if (typeof patch.name === "string") target.name = patch.name;
        if (typeof patch.enabled === "boolean") target.enabled = patch.enabled;
        target.version = (target.version ?? 1) + 1;
      }
      return route.fulfill(json(workflowBody(target)));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/skills",
    (route) => {
      seen.catalogReads += 1;
      if (seen.catalogAnswer === "fail") {
        return route.fulfill(problem(500, "INTERNAL_ERROR"));
      }
      return route.fulfill(
        json({ items: seen.catalogAnswer ?? [], nextCursor: null }),
      );
    },
  );
  await page.route(
    (url) =>
      /^\/v1\/workflows\/[^/]+\/versions\/[^/]+\/skills$/.test(url.pathname),
    (route) => {
      seen.skillReads += 1;
      if (seen.skillsAnswer === "fail") {
        return route.fulfill(problem(500, "INTERNAL_ERROR"));
      }
      return route.fulfill(json(seen.skillsAnswer ?? { items: [] }));
    },
  );
  await page.route(
    (url) => /^\/v1\/workflows\/[^/]+\/versions\/[^/]+$/.test(url.pathname),
    async (route) => {
      const parts = new URL(route.request().url()).pathname.split("/");
      seen.draftSaves.push({
        versionId: parts[5] ?? "",
        ifMatch: route.request().headers()["if-match"] ?? null,
        body: route.request().postDataJSON() as Record<string, unknown>,
      });
      const row = versions.find((one) => one.id === parts[5]);
      // As the server does: a slot the save settled is gone from the next read of the skills.
      const settled = (route.request().postDataJSON() as {
        resolveSkillSlots?: string[];
      }).resolveSkillSlots;
      if (
        settled !== undefined && typeof seen.skillsAnswer === "object" &&
        seen.skillsAnswer !== null
      ) {
        seen.skillsAnswer = {
          items: seen.skillsAnswer.items.filter((item) => {
            const held = item as {
              skillVersionId?: unknown;
              stepPath?: string;
            };
            return !(held.skillVersionId === null &&
              settled.includes(held.stepPath ?? ""));
          }),
        };
      }
      const saved = {
        id: parts[5] ?? "",
        workflowId: parts[3] ?? "",
        revision: row?.revision ?? 1,
        sourceYaml: "",
        normalizedSpec: {
          kind: "fixed",
          steps: (route.request().postDataJSON() as {
            definition?: { steps?: unknown };
          }).definition?.steps ?? [],
        },
        digest: SAVED_DIGEST,
        status: "draft",
        createdBy: uuid(9000),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 2,
        starts: [],
      };
      if (options.saveDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.saveDelayMs)
        );
      }
      return route.fulfill(json(saved));
    },
  );
  await page.route(
    (url) => /^\/v1\/workflows\/[^/]+\/versions$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      if (route.request().method() === "POST") {
        seen.stepWrites += 1;
        seen.versionKeys.push(route.request().headers()["idempotency-key"]);
        if (
          options.copy === "steps-fail" ||
          (options.copy === "steps-fail-once" && seen.stepWrites === 1)
        ) {
          return route.fulfill(problem(500, "INTERNAL_ERROR"));
        }
        const input = route.request().postDataJSON() as {
          definition: { steps?: { id: string; uses: string }[] };
          sourceYaml?: string;
        };
        seen.versionsCreated.push({ workflowId: id, ...input });
        const row: VersionRow = {
          id: uuid(8000 + seen.versionsCreated.length),
          workflowId: id,
          revision: 1,
          status: "draft",
          steps: input.definition.steps ?? [],
        };
        versions.push(row);
        return route.fulfill({ ...json(versionBody(row)), status: 201 });
      }
      if (options.endlessVersions) {
        versionPages += 1;
        const base = 100 * versionPages;
        return route.fulfill(json({
          items: [base + 1, base + 2].map((revision) =>
            versionBody({
              id: uuid(5000 + revision),
              workflowId: id,
              revision,
              status: "published",
              steps: [{ id: "brief", uses: "task.brief" }],
            })
          ),
          nextCursor: `more-${versionPages}`,
        }));
      }
      return route.fulfill(json({
        items: versions.filter((row) => row.workflowId === id).map(versionBody),
        nextCursor: null,
      }));
    },
  );
  await page.route(
    (url) => /^\/v1\/workflows\/[^/]+\/activations$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      const request = route.request().postDataJSON() as { versionId: string };
      seen.activations.push({
        id,
        ifMatch: route.request().headers()["if-match"] ?? null,
        body: request,
      });
      if (options.conflict === "activate") return conflict(route);
      const target = workflows.find((item) => item.id === id);
      if (!target) return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
      target.activeVersionId = request.versionId;
      target.version = (target.version ?? 1) + 1;
      return route.fulfill(json(workflowBody(target)));
    },
  );
  await page.route(
    (url) => /^\/v1\/agents\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      if (options.forbidden) {
        return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
      }
      const target = agents.find((item) => item.id === id);
      if (!target) return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
      if (route.request().method() === "PATCH") {
        seen.agentUpdates.push({
          id,
          ifMatch: route.request().headers()["if-match"] ?? null,
          body: route.request().postDataJSON() as Record<string, unknown>,
        });
        if (options.conflict === "update") return conflict(route);
        const patch = route.request().postDataJSON() as Partial<Definition>;
        if (typeof patch.name === "string") target.name = patch.name;
        if (typeof patch.enabled === "boolean") target.enabled = patch.enabled;
        target.version = (target.version ?? 1) + 1;
      }
      return route.fulfill(json(body(target)));
    },
  );
  await page.route(
    (url) => /^\/v1\/agents\/[^/]+\/activations$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      const request = route.request().postDataJSON() as { versionId: string };
      seen.agentActivations.push({
        id,
        ifMatch: route.request().headers()["if-match"] ?? null,
        body: request,
      });
      if (options.conflict === "activate") return conflict(route);
      const target = agents.find((item) => item.id === id);
      if (!target) return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
      target.activeVersionId = request.versionId;
      target.version = (target.version ?? 1) + 1;
      return route.fulfill(json(body(target)));
    },
  );
  await page.route(
    (url) => /^\/v1\/agents\/[^/]+\/versions$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      return route.fulfill(json({
        items: (options.agentVersions ?? []).filter((row) => row.agentId === id)
          .map((row) => ({
            id: row.id,
            agentId: row.agentId,
            revision: row.revision,
            config: row.config ?? {},
            digest: String(row.revision).padStart(2, "0").repeat(32),
            createdBy: uuid(1),
            createdAt: row.createdAt ?? "2026-03-0" +
                Math.min(row.revision, 9) + "T10:00:00.000Z",
            updatedAt: STAMP,
            version: 1,
          })),
        nextCursor: null,
      }));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/agents",
    async (route) => {
      seen.agentReads += 1;
      if (options.agentReads === "fail") {
        return route.fulfill(problem(500, "INTERNAL_ERROR"));
      }
      if (options.agentReads === "hold") await agentsHeld;
      return answer("agents", agents.map(body))(route);
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/workflow-validations",
    (route) => {
      const input = route.request().postDataJSON() as { definition: unknown };
      seen.validations.push(input);
      if (options.validation === "fail") {
        return route.fulfill(problem(500, "INTERNAL_ERROR"));
      }
      const errors = options.validation === "named"
        ? [
          {
            path: "/steps/0/id",
            code: "field_missing",
            message: "A required field is missing.",
          },
          {
            path: "/steps",
            code: "field_missing",
            message: "A required field is missing.",
          },
          {
            path: "/steps/0/parallel/branches/1/steps",
            code: "field_missing",
            message: "A required field is missing.",
          },
          {
            path: "/steps/1/with",
            code: "field_invalid",
            message: "A field has an invalid shape.",
          },
          {
            path: "/inputs/target/type",
            code: "field_invalid",
            message: "A field has an invalid shape.",
          },
          {
            path: "/steps/2/id",
            code: "step_id_invalid",
            message: "A step id is invalid.",
          },
        ]
        : options.validation === "errors"
        ? [
          {
            path: "/steps/1/uses",
            code: "action_unknown",
            message: "The action is not registered.",
          },
          {
            path: "",
            code: "field_missing",
            message: "A required field is missing.",
          },
        ]
        : [];
      const warnings = options.validation === "warnings"
        ? [{
          path: "/steps/0/uses",
          code: "action_not_executable",
          message: "The step's action cannot run yet.",
        }]
        : options.validation === "unbound"
        ? [{
          path: "/steps/0/uses",
          code: "model_agent_unbound",
          message: "The step runs a model but no agent is bound.",
        }]
        : [];
      return route.fulfill(
        json({
          valid: errors.length === 0,
          errors,
          warnings,
          normalizedDigest: errors.length === 0 ? "a".repeat(64) : null,
        }),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/workflow-presets",
    (route) => {
      seen.presetReads += 1;
      return answer(
        "presets",
        [
          {
            id: "fixed-coding",
            revision: 2,
            digest: "a".repeat(64),
            nameKey: "workflowPresets.fixedCoding.name",
            steps: [{ id: "brief", uses: "task.brief" }, {
              id: "implement",
              uses: "harness.implement",
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
              { id: "implement", uses: "harness.implement" },
              { id: "review", uses: "agent.review" },
            ],
            defaultBudgetLimitUsd: "8.00",
            availability: null,
          },
        ].map((preset) => presetRead(preset)),
      )(route);
    },
  );
  return seen;
}
