import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  ActionKind,
  TransactionIsolation,
} from "../../packages/contracts/src/action-registry.ts";
import {
  ProjectsImplementedAction,
  projectsImplementedActions,
  RepositoryRulesImplementedAction,
  repositoryRulesImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  createProjectsActionRegistry,
  type ProjectsActionHandlers,
} from "../../apps/server/src/modules/projects/actions.ts";
import {
  createRepositoryRulesActionRegistry,
  type RepositoryRulesActionHandlers,
} from "../../apps/server/src/modules/repository-rules/actions.ts";
import { resolveRepositoryRules } from "../../packages/contracts/src/repository-rules.ts";
import {
  allRuleEntries,
  commitsEntry,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";

const unavailable = () => Promise.reject(new Error("not called"));
const proxy = <T>() => new Proxy({}, { get: () => unavailable }) as T;
const find = (action: string) =>
  catalogActions.find((entry) => entry.action === action);

Deno.test("catalog declares both previews as Admin side-effect-free POSTs with one new key", () => {
  const organization = find("repositoryRulePreviews.createForOrganization");
  assert(organization);
  assertEquals(organization.method, "POST");
  assertEquals(
    organization.path,
    "/v1/organizations/{id}/repository-rule-previews",
  );
  assertEquals(organization.access, "Admin");
  assertEquals(organization.permission, "repositoryRule:preview");
  assertEquals(
    organization.organizationContext,
    "required_authenticated_context",
  );
  assertEquals(organization.organizationIdParam, "id");
  assertEquals(organization.input, "RepositoryRulePreviewOrganizationCreate");
  assertEquals(organization.output, "RepositoryRulePreviewOrganization");
  assertEquals(organization.event, "");
  assertEquals(
    organization.mcp,
    "bakery_repositoryRulePreviews_createForOrganization",
  );
  // No Idempotency-Key and no replay record: the catalog says so by "read".
  assertEquals(organization.idempotency, "read");
  assert(!organization.idempotency.includes("Idempotency-Key"));
  for (
    const code of [
      "PRECONDITION_FAILED",
      "UNPROCESSABLE",
      "INVALID_CURSOR",
      "RESOURCE_NOT_FOUND",
      "MALFORMED_REQUEST",
    ]
  ) assert(organization.errors.includes(code), code);
  assert(!organization.errors.includes("IDEMPOTENCY_IN_FLIGHT"));
  assert(!organization.errors.includes("PRECONDITION_REQUIRED"));

  const repository = find("repositoryRulePreviews.createForRepository");
  assert(repository);
  assertEquals(repository.method, "POST");
  assertEquals(repository.path, "/v1/repositories/{id}/rule-previews");
  assertEquals(repository.access, "Admin");
  assertEquals(repository.permission, "repositoryRule:preview");
  assertEquals(
    repository.organizationContext,
    "required_authenticated_context",
  );
  assertEquals(repository.input, "RepositoryRulePreviewRepositoryCreate");
  assertEquals(repository.output, "RepositoryRulePreviewRepository");
  assertEquals(
    repository.mcp,
    "bakery_repositoryRulePreviews_createForRepository",
  );
  assertEquals(repository.idempotency, "read");

  // One permission key maps to exactly one minimum role, and no other action
  // borrows the new key or the neighbouring ones.
  const owners = catalogActions.filter((entry) =>
    entry.permission === "repositoryRule:preview"
  );
  assertEquals(owners.map(({ action }) => action).sort(), [
    "repositoryRulePreviews.createForOrganization",
    "repositoryRulePreviews.createForRepository",
  ]);
  assert(owners.every(({ access }) => access === "Admin"));
  assertEquals(
    find("repositoryRuleVersions.create")?.permission,
    "repositoryRule:manage",
  );
  assertEquals(find("repositoryRules.get")?.permission, "repositoryRule:read");
});

Deno.test("implemented-action lists and registries mount both previews as queries", () => {
  assert(
    repositoryRulesImplementedActions.includes(
      "repositoryRulePreviews.createForOrganization",
    ),
  );
  assert(
    projectsImplementedActions.includes(
      "repositoryRulePreviews.createForRepository",
    ),
  );
  assertEquals(
    RepositoryRulesImplementedAction
      .RepositoryRulePreviewsCreateForOrganization,
    "repositoryRulePreviews.createForOrganization",
  );
  assertEquals(
    ProjectsImplementedAction.RepositoryRulePreviewsCreateForRepository,
    "repositoryRulePreviews.createForRepository",
  );
  const rules = createRepositoryRulesActionRegistry(
    {} as never,
    proxy<RepositoryRulesActionHandlers>(),
  ).list().find(({ name }) =>
    name === "repositoryRulePreviews.createForOrganization"
  );
  assert(rules);
  assertEquals(rules.method, "POST");
  assertEquals(rules.path, "/v1/organizations/:id/repository-rule-previews");
  assertEquals(rules.policy.type, ActionKind.Query);
  assertEquals(rules.policy.organizationIdParam, "id");
  assertEquals(rules.transactionIsolation, TransactionIsolation.RepeatableRead);
  assertEquals(rules.successStatus, 200);
  assertEquals(rules.naturalIdempotency, undefined);
  assertEquals(rules.explicitIdempotency, undefined);
  const projects = createProjectsActionRegistry(
    proxy<ProjectsActionHandlers>(),
  ).list().find(({ name }) =>
    name === "repositoryRulePreviews.createForRepository"
  );
  assert(projects);
  assertEquals(projects.method, "POST");
  assertEquals(projects.path, "/v1/repositories/:id/rule-previews");
  assertEquals(projects.policy.type, ActionKind.Query);
  assertEquals(projects.policy.access, "Admin");
  assertEquals(
    projects.transactionIsolation,
    TransactionIsolation.RepeatableRead,
  );
  assertEquals(projects.successStatus, 200);
  assertEquals(projects.naturalIdempotency, undefined);
  assertEquals(projects.explicitIdempotency, undefined);
});

Deno.test("organization preview input is typed, strict and bounded", () => {
  const schema = contractSchemas.RepositoryRulePreviewOrganizationCreate;
  const body = { expectedRevision: 0, entries: allRuleEntries() };
  assertEquals(schema.safeParse(body).success, true);
  assertEquals(
    schema.safeParse({ ...body, limit: 100, cursor: "x" }).success,
    true,
  );
  for (
    const bad of [
      {},
      { expectedRevision: 0 },
      { entries: [] },
      { ...body, expectedRevision: -1 },
      { ...body, expectedRevision: 1.5 },
      { ...body, expectedRevision: "0" },
      { ...body, limit: 0 },
      { ...body, limit: 101 },
      { ...body, limit: 1.5 },
      { ...body, cursor: "x".repeat(513) },
      { ...body, revision: 1 },
      { ...body, organizationId: crypto.randomUUID() },
      { ...body, entries: [...allRuleEntries(), commitsEntry()] },
      { ...body, entries: [{ ...commitsEntry(), extra: true }] },
      { ...body, entries: [{ ...commitsEntry(), explanation: "a\u0000b" }] },
      { ...body, entries: [{ ...commitsEntry(), explanation: "a\ud800b" }] },
      { ...body, entries: [{ ruleKey: "commits.unknown" }] },
    ]
  ) {
    assertEquals(
      schema.safeParse(bad).success,
      false,
      JSON.stringify(bad).slice(0, 100),
    );
  }
});

Deno.test("repository preview input is typed, strict and bounded", () => {
  const schema = contractSchemas.RepositoryRulePreviewRepositoryCreate;
  const override = { ...commitsEntry(), locked: undefined };
  delete (override as Record<string, unknown>).locked;
  const body = { overrides: { entries: [override] } };
  assertEquals(schema.safeParse(body).success, true);
  assertEquals(
    schema.safeParse({
      ...body,
      sample: {
        commitMessages: Array(20).fill("x".repeat(2000)),
        pullRequestTitle: "x".repeat(300),
        pullRequestDescription: "x".repeat(8000),
      },
    }).success,
    true,
  );
  for (
    const bad of [
      {},
      { overrides: {} },
      { overrides: { entries: [{ ...override, locked: true }] } },
      { overrides: { entries: Array(6).fill(override) } },
      { ...body, extra: 1 },
      { ...body, sample: { commitMessages: Array(21).fill("x") } },
      { ...body, sample: { commitMessages: ["x".repeat(2001)] } },
      { ...body, sample: { pullRequestTitle: "x".repeat(301) } },
      { ...body, sample: { pullRequestDescription: "x".repeat(8001) } },
      { ...body, sample: { commitMessages: ["a\u0000b"] } },
      { ...body, sample: { commitMessages: ["a\udc00b"] } },
      { ...body, sample: { pullRequestTitle: "a\u0000b" } },
      { ...body, sample: { pullRequestDescription: "a\ud800b" } },
      { ...body, sample: { unknown: "x" } },
    ]
  ) {
    assertEquals(
      schema.safeParse(bad).success,
      false,
      JSON.stringify(bad).slice(0, 100),
    );
  }
});

Deno.test("preview outputs are typed down to rule entries, statuses and findings", async () => {
  const organization = contractSchemas.RepositoryRulePreviewOrganization;
  const item = {
    repositoryId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryName: "repo",
    status: "newly_locked",
    unsupported: false,
    supersededRules: ["commits.semantic"],
    reactivatedRules: [],
  };
  const page = {
    organizationId: crypto.randomUUID(),
    currentRevision: 1,
    draftRevision: 2,
    draftDigest: "a".repeat(64),
    counts: {
      repositories: 1,
      inherited: 0,
      overridden: 0,
      newlyLocked: 1,
      unsupported: 0,
    },
    items: [item],
    nextCursor: null,
  };
  assertEquals(organization.safeParse(page).success, true);
  assertEquals(
    organization.safeParse({ ...page, nextCursor: "c" }).success,
    true,
  );
  for (
    const bad of [
      { ...page, draftDigest: "nope" },
      { ...page, items: [{ ...item, status: "other" }] },
      { ...page, items: [{ ...item, supersededRules: ["nope"] }] },
      { ...page, items: [{ ...item, reactivatedRules: ["nope"] }] },
      { ...page, items: [{ ...item, reactivatedRules: undefined }] },
    ]
  ) assertEquals(organization.safeParse(bad).success, false);

  const resolved = await resolveRepositoryRules(
    { revision: 3, entries: allRuleEntries() as never },
    { entries: [] },
  );
  const repository = contractSchemas.RepositoryRulePreviewRepository;
  const result = {
    ruleKey: "commits.semantic",
    mode: "require",
    status: "fail",
    appliesTo: "all_commits",
    evaluated: 1,
    findings: [{ code: "type_not_allowed", message: "x" }],
  };
  const body = {
    repositoryId: crypto.randomUUID(),
    profileId: null,
    profileRevision: null,
    organizationRevision: 3,
    conflicts: [],
    effective: resolved,
    sampleResults: [result],
  };
  assertEquals(repository.safeParse(body).success, true);
  assertEquals(
    repository.safeParse({
      ...body,
      conflicts: [{
        ruleKey: "commits.semantic",
        reason: "replaces_locked_rule",
      }],
      effective: null,
      sampleResults: [],
    }).success,
    true,
  );
  for (
    const bad of [
      {
        ...body,
        conflicts: [{ ruleKey: "commits.semantic", reason: "other" }],
      },
      { ...body, effective: { ...resolved, entries: [{ ruleKey: "x" }] } },
      { ...body, effective: { ...resolved, digest: "nope" } },
      { ...body, sampleResults: [{ ...result, status: "maybe" }] },
      { ...body, sampleResults: [{ ...result, findings: [{ code: "x" }] }] },
    ]
  ) assertEquals(repository.safeParse(bad).success, false);
  assertEquals(
    repository.safeParse({
      ...body,
      sampleResults: [{
        ...result,
        mode: null,
        appliesTo: null,
        status: "not_evaluated",
      }],
    }).success,
    true,
  );
});

Deno.test("every preview schema node carries a description", () => {
  for (
    const name of [
      "RepositoryRulePreviewOrganizationCreate",
      "RepositoryRulePreviewRepositoryCreate",
      "RepositoryRulePreviewSample",
      "RepositoryRulePreviewOrganization",
      "RepositoryRulePreviewItem",
      "RepositoryRulePreviewCounts",
      "RepositoryRulePreviewRepository",
      "RepositoryRulePreviewEffective",
      "RuleLockConflict",
      "RuleSampleResult",
      "RuleSampleFinding",
    ] as const
  ) {
    const schema = contractSchemas[name] as unknown as {
      description?: string;
      shape?: Record<string, { description?: string }>;
    };
    assert(schema.description && schema.description.length > 20, name);
    for (const [field, node] of Object.entries(schema.shape ?? {})) {
      assert(
        node.description && node.description.length > 10,
        `${name}.${field}`,
      );
    }
  }
  // Reusing the draft entries keeps one typing for publish and preview.
  assertEquals(
    contractSchemas.RepositoryRuleVersionCreate.safeParse({
      expectedRevision: 0,
      entries: [titleEntry()],
    }).success,
    true,
  );
});
