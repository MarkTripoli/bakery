import { assert, assertEquals } from "@std/assert";
import {
  OrganizationRepositoryRulesSchema,
  type PinnedRepositoryRules,
  RepositoryRuleOverridesSchema,
  resolveRepositoryRules,
} from "../../packages/contracts/src/repository-rules.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  type PresetRepository,
  type PresetScope,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "./fixed-coding-preset.ts";
import type { WorkerFixture } from "./worker-execution.ts";

/** SHA-256 of {"entries":[],"organizationRevision":0}: the pinned empty baseline. */
export const EMPTY_BASELINE_DIGEST =
  "29b63ecc492e00756b31919bc5c780cca04a908684a519265743512a08406a1d";

export type RunBody = {
  id: string;
  status: string;
  workflowVersionId: string;
};

export type RuleEntry = Record<string, unknown>;

/** A repository override: the organization entry without its lock flag. */
export function asOverride(entry: RuleEntry): RuleEntry {
  const { locked: _locked, ...rest } = entry;
  return rest;
}

export function numbersRule(
  overrides: RuleEntry = {},
  options: RuleEntry = {},
): RuleEntry {
  return {
    ruleKey: "code.magicNumbers",
    enabled: true,
    mode: "require",
    options: {
      checkBinding: "magic.numbers",
      allowedNumbers: [0, 1],
      excludedPaths: [],
      ...options,
    },
    locked: false,
    ...overrides,
  };
}

/** A require rule with no checker binding: it can never bind a workflow stage. */
export function unboundNumbersRule(
  overrides: RuleEntry = {},
  options: RuleEntry = {},
): RuleEntry {
  return numbersRule(overrides, { checkBinding: null, ...options });
}

/** Publishes one organization rules revision through the real API. */
export async function publishOrganizationRules(
  fixture: Pick<WorkerFixture, "app">,
  scope: PresetScope,
  expectedRevision: number,
  entries: RuleEntry[],
): Promise<void> {
  await expectJson(
    await apiCall(
      fixture,
      scope,
      "POST",
      `/v1/organizations/${scope.organizationId}/repository-rule-versions`,
      { body: { expectedRevision, entries } },
    ),
    201,
  );
}

/** Inserts a corrupt or hand-built rule version row as the owner role. */
export async function insertRuleVersionRow(
  database: PgDatabase,
  organizationId: string,
  revision: number,
  config: unknown,
  digest: string,
): Promise<void> {
  await database.query(
    `insert into bakery.organization_repository_rule_versions (
       id, organization_id, revision, config, digest
     ) values ($1, $2, $3, $4::jsonb, $5)`,
    [
      crypto.randomUUID(),
      organizationId,
      revision,
      JSON.stringify(config),
      digest,
    ],
  );
}

/**
 * Inserts another immutable v1 profile revision for a seeded repository and,
 * when asked, makes it the active one. Returns a repository handle pinned to it.
 */
export async function addProfileRevision(
  database: PgDatabase,
  scope: PresetScope,
  repository: PresetRepository,
  revision: number,
  repositoryRules: { entries: RuleEntry[] } | undefined,
  options: { activate?: boolean } = {},
): Promise<PresetRepository> {
  const profileId = crypto.randomUUID();
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
    ...(repository.agentVersionId === null ? {} : {
      agentBindings: { "harness.implement": repository.agentVersionId },
    }),
    ...(repositoryRules === undefined ? {} : { repositoryRules }),
  };
  const digest = await sha256Hex(canonicalJson(config));
  await database.query(
    `insert into bakery.repository_profiles (
       id, organization_id, application_id, repository_id, revision, config,
       digest, created_by
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      profileId,
      scope.organizationId,
      repository.applicationId,
      repository.repositoryId,
      revision,
      JSON.stringify(config),
      digest,
      scope.principalId,
    ],
  );
  if (options.activate !== false) {
    await database.query(
      `update bakery.repositories set active_profile_id = $3
        where organization_id = $1 and id = $2`,
      [scope.organizationId, repository.repositoryId, profileId],
    );
  }
  return { ...repository, profileId, profileDigest: digest };
}

/** An agent-bound repository whose first profile carries the given overrides. */
export async function seedRulesRepository(
  fixture: Pick<WorkerFixture, "app" | "pgDatabase">,
  scope: PresetScope,
  label: string,
  repositoryRules?: { entries: RuleEntry[] },
): Promise<PresetRepository> {
  const agent = await seedFundedCodingAgent(fixture, scope, label);
  return await seedPresetRepository(fixture.pgDatabase, scope, {
    agentVersionId: agent,
    profileExtra: repositoryRules === undefined ? {} : { repositoryRules },
  });
}

export type StartedRun = { run: RunBody; taskId: string };

export async function startRun(
  fixture: Pick<WorkerFixture, "app">,
  scope: PresetScope,
  repository: PresetRepository,
): Promise<StartedRun> {
  const task = await createPresetTask(fixture, scope, repository);
  const run = await expectJson<RunBody>(
    await startPresetRun(fixture, scope, task, repository),
    201,
  );
  return { run, taskId: task.id };
}

export type SnapshotProfile = {
  id: string;
  revision: number;
  repositoryRules?: PinnedRepositoryRules;
};

/** The stored snapshot as exact JSON text plus its parsed repository profile. */
export async function readSnapshot(
  database: PgDatabase,
  organizationId: string,
  runId: string,
): Promise<{ text: string; profile: SnapshotProfile }> {
  const result = await database.query<{ text: string; snapshot: unknown }>(
    `select snapshot::text as text, snapshot
       from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  assertEquals(result.rows.length, 1);
  const snapshot = result.rows[0].snapshot as {
    repositoryProfile: SnapshotProfile;
  };
  return { text: result.rows[0].text, profile: snapshot.repositoryProfile };
}

/** Pinned rules of a run, which must exist on a repository-mode snapshot. */
export async function pinnedRulesOf(
  database: PgDatabase,
  organizationId: string,
  runId: string,
): Promise<PinnedRepositoryRules> {
  const { profile } = await readSnapshot(database, organizationId, runId);
  assert(profile.repositoryRules, "snapshot lacks repositoryRules");
  return profile.repositoryRules;
}

/** What the resolver says the pin must be for one organization/profile pair. */
export async function expectedPin(
  organization: { revision: number; entries: RuleEntry[] } | null,
  overrides: RuleEntry[],
  profile: { id: string; revision: number },
): Promise<PinnedRepositoryRules> {
  const resolved = await resolveRepositoryRules(
    organization === null
      ? null
      : OrganizationRepositoryRulesSchema.parse(organization),
    RepositoryRuleOverridesSchema.parse({ entries: overrides }),
  );
  return {
    organizationRevision: resolved.organizationRevision,
    profileId: profile.id,
    profileRevision: profile.revision,
    entries: resolved.entries,
    digest: resolved.digest,
  };
}

export function provenanceOf(
  pin: PinnedRepositoryRules,
): Record<string, string> {
  return Object.fromEntries(
    pin.entries.map((entry) => [entry.ruleKey, entry.provenance]),
  );
}

export async function countRows(
  database: PgDatabase,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const result = await database.query<{ count: string }>(sql, [...values]);
  return Number(result.rows[0]?.count ?? 0);
}

/** A fixed workflow with one implement stage: a revision producer, so rule-bound. */
export function implementOnlyDefinition(agentVersionId: string) {
  return {
    kind: "fixed",
    agents: { "harness.implement": agentVersionId },
    steps: [{
      id: "implement",
      uses: "harness.implement",
      with: {
        repositoryId: "$task.repositoryId",
        planArtifact: "$input.plan",
        instructions: "$input.instructions",
      },
    }],
  };
}

/** Creates a workflow, publishes its one draft and optionally activates it. */
export async function publishWorkflow(
  fixture: Pick<WorkerFixture, "app">,
  scope: PresetScope,
  slug: string,
  definition: unknown,
  options: { activate?: boolean } = {},
): Promise<{ workflowId: string; versionId: string }> {
  const created = await expectJson<{ id: string }>(
    await apiCall(fixture, scope, "POST", "/v1/workflows", {
      body: { slug, name: slug, description: "" },
    }),
    201,
  );
  const draft = await expectJson<{ id: string }>(
    await apiCall(
      fixture,
      scope,
      "POST",
      `/v1/workflows/${created.id}/versions`,
      {
        body: { definition },
      },
    ),
    201,
  );
  await expectJson(
    await apiCall(
      fixture,
      scope,
      "POST",
      `/v1/workflows/${created.id}/versions/${draft.id}/publish`,
      { body: {}, headers: { "If-Match": '"1"' } },
    ),
    200,
  );
  if (options.activate === true) {
    const current = await expectJson<{ version: number }>(
      await apiCall(fixture, scope, "GET", `/v1/workflows/${created.id}`),
      200,
    );
    await expectJson(
      await apiCall(
        fixture,
        scope,
        "POST",
        `/v1/workflows/${created.id}/activations`,
        {
          body: { versionId: draft.id },
          headers: { "If-Match": `"${current.version}"` },
        },
      ),
      200,
    );
  }
  return { workflowId: created.id, versionId: draft.id };
}

/** Fixture entries checked against the organization schema, not cast to it. */
export function organizationEntries(entries: readonly RuleEntry[]) {
  return OrganizationRepositoryRulesSchema.parse({ revision: 1, entries })
    .entries;
}
