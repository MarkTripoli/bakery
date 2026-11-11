import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type APIRequestContext, expect } from "@playwright/test";
import type {
  M1AgentConfig,
  M1AgentDefinition,
  M1AgentRole,
  M1BillingFile,
} from "../../../../scripts/evidence/m1-billing.ts";

/**
 * Real-API calls of the M1 journey spec: the application, the
 * agents with their versions and activations, the repository and its profile,
 * and the direct run start the journey uses to prove a wrong approval is
 * refused. Every call goes through the signed-in browser context's request
 * object, so it carries the session cookie, the organization header, an
 * `Idempotency-Key` and the web `Origin` exactly like the app's own calls. No
 * database write and no route mock.
 */

/** Recursively key-sorted JSON, the form the server digests (`canonical-json.ts`). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

/** The digest the agent version and profile routes require for `config`. */
export function digestOf(config: unknown): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/** `<state>/billing.json`, the constants the pricing snapshot rows came from. */
export function readBilling(stateDirectory: string): M1BillingFile {
  const parsed = JSON.parse(
    readFileSync(`${stateDirectory}/billing.json`, "utf8"),
  ) as M1BillingFile;
  expect(parsed.schema, "billing.json schema").toBe("bakery.m1-billing/v1");
  expect(Object.keys(parsed.agents).sort(), "billing.json agent roles").toEqual(
    ["coder", "coordinator"],
  );
  return parsed;
}

export type ApiResult = { status: number; body: Record<string, unknown> };

export class M1Api {
  constructor(
    readonly request: APIRequestContext,
    /** The web origin the browser signed in on (the `Origin` header). */
    readonly origin: string,
    readonly organizationId: string,
  ) {}

  /** A copy that sends another organization header (cross-organization reads). */
  inOrganization(organizationId: string): M1Api {
    return new M1Api(this.request, this.origin, organizationId);
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(path, {
      headers: { "Bakery-Organization-Id": this.organizationId },
    });
    expect(response.ok(), `GET ${path}: ${response.status()}`).toBe(true);
    return await response.json() as T;
  }

  /** A mutation with its own idempotency key; never throws on a 4xx. */
  async send(
    method: "POST" | "PATCH",
    path: string,
    data: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResult> {
    const response = await this.request.fetch(path, {
      method,
      headers: {
        "Bakery-Organization-Id": this.organizationId,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: this.origin,
        ...headers,
      },
      data,
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text === "" ? {} : JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { status: response.status(), body };
  }

  /** A mutation that must succeed with `status` (default 201). */
  async create(
    path: string,
    data: unknown,
    status = 201,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const result = await this.send("POST", path, data, headers);
    expect(
      result.status,
      `POST ${path}: ${result.status} ${JSON.stringify(result.body)}`,
    ).toBe(status);
    return result.body;
  }
}

function text(value: unknown, label: string): string {
  expect(typeof value, label).toBe("string");
  return value as string;
}

export type CreatedAgent = {
  role: M1AgentRole;
  agentId: string;
  versionId: string;
  slug: string;
};

/**
 * Creates one agent, its first version (config from `billing.json`), and
 * activates that version: `POST /v1/agents`, `/versions`, `/activations`, the
 * last with `If-Match` set to the definition's current version.
 */
export async function createAgent(
  api: M1Api,
  role: M1AgentRole,
  definition: M1AgentDefinition,
): Promise<CreatedAgent> {
  const agent = await api.create("/v1/agents", {
    slug: definition.slug,
    name: definition.name,
    description: `${definition.name} for the M1 journey proof.`,
  });
  const agentId = text(agent.id, "agent id");
  const config: M1AgentConfig = definition.config;
  const version = await api.create(`/v1/agents/${agentId}/versions`, {
    revision: 1,
    config,
    digest: digestOf(config),
  });
  const versionId = text(version.id, "agent version id");
  const current = await api.get<{ version: number }>(`/v1/agents/${agentId}`);
  const activated = await api.create(
    `/v1/agents/${agentId}/activations`,
    { versionId },
    200,
    { "If-Match": `"${current.version}"` },
  );
  expect(activated.activeVersionId, `${role} active version`).toBe(versionId);
  return { role, agentId, versionId, slug: definition.slug };
}

export type CreatedRepository = {
  repositoryId: string;
  profileId: string;
  owner: string;
  name: string;
};

/** The profile config of the proof: the fixed workflow and the coder binding. */
export function profileConfig(coderVersionId: string) {
  return {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["delivery/*", "fix/*"] },
    worktree: { root: ".agents/worktrees/bakery" },
    agentBindings: { "harness.implement": coderVersionId },
  };
}

/**
 * Registers the repository record for the harness clone, creates its first
 * profile (bound to the coder agent version) and makes that profile active.
 * The record is metadata: the worker runs in the dedicated clone it was
 * configured with, whatever these fields say.
 */
export async function createRepository(
  api: M1Api,
  applicationId: string,
  coderVersionId: string,
  suffix: string,
): Promise<CreatedRepository> {
  const owner = "MarkTripoli";
  const name = "bakery";
  const repository = await api.create("/v1/repositories", {
    applicationId,
    slug: `bakery-m1-${suffix}`,
    integrationConnectionId: crypto.randomUUID(),
    providerRepoId: `${owner}/${name}`,
    owner,
    name,
    defaultBranch: "main",
  });
  const repositoryId = text(repository.id, "repository id");
  const config = profileConfig(coderVersionId);
  const profile = await api.create(
    `/v1/repositories/${repositoryId}/profiles`,
    {
      revision: 1,
      config,
      digest: digestOf(config),
    },
  );
  const profileId = text(profile.id, "profile id");
  const current = await api.get<{ version: number }>(
    `/v1/repositories/${repositoryId}`,
  );
  const patched = await api.send(
    "PATCH",
    `/v1/repositories/${repositoryId}`,
    { activeProfileId: profileId },
    { "If-Match": `"${current.version}"` },
  );
  expect(
    patched.status,
    `PATCH repository: ${patched.status} ${JSON.stringify(patched.body)}`,
  ).toBe(200);
  return { repositoryId, profileId, owner, name };
}

/**
 * `POST /v1/tasks/{id}/runs` as the app's Start run does, with an explicit
 * approval id, so the journey can prove a wrong or used approval is refused.
 */
export async function startRunWithApproval(
  api: M1Api,
  taskId: string,
  repositoryId: string,
  approvalId: string,
): Promise<ApiResult> {
  const task = await api.get<{ repositoryProfileId: string }>(
    `/v1/tasks/${taskId}`,
  );
  const presets = await api.get<{
    items: { id: string; defaultBudgetLimitUsd: string }[];
  }>(`/v1/workflow-presets?repositoryId=${repositoryId}`);
  expect(presets.items.length, "a workflow preset").toBeGreaterThan(0);
  return await api.send("POST", `/v1/tasks/${taskId}/runs`, {
    presetId: presets.items[0].id,
    repositoryProfileId: task.repositoryProfileId,
    executionMode: "repository",
    budgetLimitUsd: presets.items[0].defaultBudgetLimitUsd,
    approvalId,
  });
}
