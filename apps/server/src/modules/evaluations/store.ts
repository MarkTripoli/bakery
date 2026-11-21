/**
 * Evaluation batches over Postgres (issue #44 slice 1): scorers and cases,
 * immutable datasets, batch admission with one result row per required case
 * x scorer x side x repetition, the batch read with counts, coverage and the
 * gate, cancel, comparison, and the idempotent recording of an attempt. Every
 * read is organization-scoped and bounded; decisions are domain.ts.
 */

import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  batchStateOf,
  compareBatches,
  compatibility,
  corpusReport,
  emptyCounts,
  type GateBlocker,
  type GateRule,
  isMeasured,
  judgeGateCounts,
  optionalScorerProblem,
  pinSpec,
  type ReportFact,
  RESULT_STATES,
  type ResultFact,
  type ResultState,
  ResultState as State,
  resultStateOfAttempt,
  type Role,
  validatePin,
} from "./domain.ts";

/** The most result rows one batch may admit. */
export const MAX_BATCH_RESULTS = 20_000;
const TS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

const notFound = (): never => {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
};
function unprocessable(field: string, code: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: [field], code, message: code }] },
  });
}
const conflict = (reason: string): never => {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
};
const iso = (v: Date | string) =>
  (v instanceof Date ? v : new Date(v)).toISOString();

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with sorted keys, so a digest does not depend on key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value as object).sort().map((k) =>
      JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function pageLimit(limit: number | undefined): number {
  const value = limit ?? 25;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    unprocessable("limit", "out_of_range");
  }
  return value;
}

// ---------------------------------------------------------------- scorers

type DefinitionRow = {
  id: string;
  slug: string;
  revision: number;
  evaluator_type: string;
  config: unknown;
  digest: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  version: number;
  cursor_created_at?: string;
};

const definition = (row: DefinitionRow) => ({
  id: row.id,
  slug: row.slug,
  revision: Number(row.revision),
  evaluatorType: row.evaluator_type,
  config: row.config,
  digest: row.digest,
  enabled: row.enabled,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  version: Number(row.version),
});

/**
 * A scorer revision. The same slug and revision again with the same content
 * answers the stored row; with other content it is a conflict, since a
 * revision never changes.
 */
export async function createDefinition(
  context: ActionContext,
  input: {
    slug: string;
    revision: number;
    evaluatorType: string;
    config: unknown;
  },
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const digest = await sha256(canonical({
    slug: input.slug,
    revision: input.revision,
    evaluatorType: input.evaluatorType,
    config: input.config,
  }));
  const inserted = await tx.query<DefinitionRow>(
    `insert into bakery.evaluation_definitions
       (organization_id, slug, revision, evaluator_type, config, digest, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, slug, revision) do nothing
     returning *`,
    [
      organizationId,
      input.slug,
      input.revision,
      input.evaluatorType,
      JSON.stringify(input.config),
      digest,
      principalId,
    ],
  );
  if (inserted.rows[0]) return definition(inserted.rows[0]);
  const existing = await tx.query<DefinitionRow>(
    "select * from bakery.evaluation_definitions where organization_id = $1 and slug = $2 and revision = $3",
    [organizationId, input.slug, input.revision],
  );
  if (existing.rows[0]?.digest !== digest) {
    conflict("evaluation_revision_exists");
  }
  return definition(existing.rows[0]);
}

export function createDefinitionLister(secret: string) {
  return async (
    context: ActionContext,
    input: { cursor?: string; limit?: number },
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageLimit(input.limit);
    const binding: CursorBinding = {
      action: "evaluationDefinitions.list",
      principalId,
      organizationId,
      ordering: "createdAt:desc,id:desc",
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const found = await tx.query<DefinitionRow>(
      `select *, to_char(created_at at time zone 'UTC', ${TS}) as cursor_created_at
         from bakery.evaluation_definitions
        where organization_id = $1
          and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
        order by created_at desc, id desc limit $4`,
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    return await page(found.rows, limit, definition, secret, binding);
  };
}

async function page<R extends { id: string; cursor_created_at?: string }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
  secret: string,
  binding: CursorBinding,
) {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    nextCursor: rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at!,
        id: last.id,
      })
      : null,
  };
}

// ------------------------------------------------------------------ cases

type CaseRow = {
  id: string;
  repository_id: string | null;
  name: string;
  input_artifact_version_id: string | null;
  expected: unknown;
  tags: unknown;
  revision: number;
  created_at: Date;
  updated_at: Date;
  version: number;
  cursor_created_at?: string;
};

const caseOut = (row: CaseRow) => ({
  id: row.id,
  repositoryId: row.repository_id,
  name: row.name,
  inputArtifactVersionId: row.input_artifact_version_id,
  expected: row.expected,
  tags: row.tags,
  revision: Number(row.revision),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  version: Number(row.version),
});

export async function createCase(
  context: ActionContext,
  input: {
    repositoryId: string;
    name: string;
    inputArtifactVersionId: string;
    expected: unknown;
    tags?: string[];
  },
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const refs = await tx.query<{ repo: boolean; input: boolean }>(
    `select exists (select 1 from bakery.repositories
                     where organization_id = $1 and id = $2) as repo,
            exists (select 1 from bakery.artifact_versions
                     where organization_id = $1 and id = $3) as input`,
    [organizationId, input.repositoryId, input.inputArtifactVersionId],
  );
  if (!refs.rows[0].repo || !refs.rows[0].input) notFound();
  const inserted = await tx.query<CaseRow>(
    `insert into bakery.evaluation_cases (organization_id, repository_id, name,
       input_artifact_version_id, expected, tags, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [
      organizationId,
      input.repositoryId,
      input.name,
      input.inputArtifactVersionId,
      JSON.stringify(input.expected ?? null),
      JSON.stringify(input.tags ?? []),
      principalId,
    ],
  );
  return caseOut(inserted.rows[0]);
}

export function createCaseLister(secret: string) {
  return async (
    context: ActionContext,
    input: { repositoryId?: string; cursor?: string; limit?: number },
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageLimit(input.limit);
    const binding: CursorBinding = {
      action: "evaluationCases.list",
      principalId,
      organizationId,
      ordering: "createdAt:desc,id:desc",
      filters: JSON.stringify({ repositoryId: input.repositoryId ?? null }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const found = await tx.query<CaseRow>(
      `select *, to_char(created_at at time zone 'UTC', ${TS}) as cursor_created_at
         from bakery.evaluation_cases
        where organization_id = $1
          and ($2::uuid is null or repository_id = $2)
          and ($3::timestamptz is null or (created_at, id) < ($3, $4::uuid))
        order by created_at desc, id desc limit $5`,
      [
        organizationId,
        input.repositoryId ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    return await page(found.rows, limit, caseOut, secret, binding);
  };
}

// --------------------------------------------------------------- datasets

type DatasetRow = {
  id: string;
  name: string;
  cases: { caseId: string; caseRevision: number }[];
  digest: string;
  created_at: Date;
  cursor_created_at?: string;
};

const datasetOut = (row: DatasetRow) => ({
  id: row.id,
  name: row.name,
  cases: row.cases,
  digest: row.digest,
  createdAt: iso(row.created_at),
});

/** An immutable dataset: the cases' current revisions, pinned in order. */
export async function createDataset(
  context: ActionContext,
  input: { name: string; caseIds: string[] },
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  if (new Set(input.caseIds).size !== input.caseIds.length) {
    unprocessable("caseIds", "duplicate_case");
  }
  const found = await tx.query<{ id: string; revision: number }>(
    "select id, revision from bakery.evaluation_cases where organization_id = $1 and id = any($2::uuid[])",
    [organizationId, input.caseIds],
  );
  const revisions = new Map(found.rows.map((r) => [r.id, Number(r.revision)]));
  if (revisions.size !== input.caseIds.length) notFound();
  const cases = input.caseIds.map((caseId) => ({
    caseId,
    caseRevision: revisions.get(caseId)!,
  }));
  const digest = await sha256(canonical(cases));
  const inserted = await tx.query<DatasetRow>(
    `insert into bakery.evaluation_datasets (organization_id, name, cases, digest, created_by)
     values ($1, $2, $3, $4, $5) returning *`,
    [organizationId, input.name, JSON.stringify(cases), digest, principalId],
  );
  return datasetOut(inserted.rows[0]);
}

export function createDatasetLister(secret: string) {
  return async (
    context: ActionContext,
    input: { cursor?: string; limit?: number },
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageLimit(input.limit);
    const binding: CursorBinding = {
      action: "evaluationDatasets.list",
      principalId,
      organizationId,
      ordering: "createdAt:desc,id:desc",
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const found = await tx.query<DatasetRow>(
      `select *, to_char(created_at at time zone 'UTC', ${TS}) as cursor_created_at
         from bakery.evaluation_datasets
        where organization_id = $1
          and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
        order by created_at desc, id desc limit $4`,
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    return await page(found.rows, limit, datasetOut, secret, binding);
  };
}

// ---------------------------------------------------------------- batches

type ScorerPin = {
  scorerId: string;
  slug: string;
  scorerRevision: number;
  evaluatorType: string;
  /** False for an optional (sampled) model scorer; absent on a batch admitted before it existed. */
  required?: boolean;
};

type BatchRow = {
  id: string;
  dataset_id: string;
  dataset_digest: string;
  candidate: unknown;
  baseline: unknown | null;
  scorers: ScorerPin[];
  gate_rule: GateRule;
  limits: unknown;
  state: string;
  canceled_at: Date | null;
  canceled_by: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  cursor_created_at?: string;
};

/**
 * What a pin names, for display: the definition's id and its current name, or a
 * null name when the pin names nothing this organization can resolve. The pin
 * itself stays the opaque record of what was measured; this is only a read of
 * the name it points at.
 */
async function pinDefinition(
  tx: PgTransactionClient,
  organizationId: string,
  pin: unknown,
): Promise<{ definitionId: string; name: string | null } | null> {
  if (typeof pin !== "object" || pin === null) return null;
  const { kind, id } = pin as { kind?: unknown; id?: unknown };
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const table = kind === "agentVersion" || kind === "agent"
    ? "agent_definitions"
    : kind === "workflowVersion" || kind === "workflow"
    ? "workflow_definitions"
    : null;
  if (table === null) return { definitionId: id, name: null };
  const found = await tx.query<{ name: string }>(
    `select name from bakery.${table} where organization_id = $1 and id = $2`,
    [organizationId, id],
  );
  return { definitionId: id, name: found.rows[0]?.name ?? null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BatchCreate = {
  datasetId: string;
  candidate: unknown;
  baseline?: unknown;
  scorerIds: string[];
  optionalScorerIds?: string[];
  requireAllPassed?: boolean;
  minPassRate?: number;
  repetitions?: number;
  budgetLimitUsd?: string | number;
};

/**
 * Admits a batch and writes every required result as missing. Deterministic
 * scorers come first in the pinned order, so execution runs them first.
 */
export async function createBatch(context: ActionContext, input: BatchCreate) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  // A pin names one exact version, so a repeated run measures the same thing.
  const pins = [["candidate", input.candidate], [
    "baseline",
    input.baseline,
  ]] as const;
  for (const [field, pin] of pins) {
    if (field === "baseline" && (pin === undefined || pin === null)) continue;
    const checked = validatePin(pin);
    if (!checked.ok) unprocessable(field, checked.reason);
  }
  const dataset = await tx.query<DatasetRow>(
    "select * from bakery.evaluation_datasets where organization_id = $1 and id = $2",
    [organizationId, input.datasetId],
  );
  if (!dataset.rows[0]) notFound();
  if (new Set(input.scorerIds).size !== input.scorerIds.length) {
    unprocessable("scorerIds", "duplicate_scorer");
  }
  const scorerRows = await tx.query<
    {
      id: string;
      slug: string;
      revision: number;
      evaluator_type: string;
      enabled: boolean;
    }
  >(
    "select id, slug, revision, evaluator_type, enabled from bakery.evaluation_definitions where organization_id = $1 and id = any($2::uuid[])",
    [organizationId, input.scorerIds],
  );
  if (scorerRows.rows.length !== input.scorerIds.length) notFound();
  if (scorerRows.rows.some((s) => !s.enabled)) {
    unprocessable("scorerIds", "scorer_disabled");
  }
  const optionalIds = input.optionalScorerIds ?? [];
  const problem = optionalScorerProblem(
    scorerRows.rows.map((s) => ({
      scorerId: s.id,
      evaluatorType: s.evaluator_type,
    })),
    optionalIds,
  );
  if (problem !== null) unprocessable(problem.field, problem.reason);
  const scorers: ScorerPin[] = scorerRows.rows
    .map((s) => ({
      scorerId: s.id,
      slug: s.slug,
      scorerRevision: Number(s.revision),
      evaluatorType: s.evaluator_type,
      required: !optionalIds.includes(s.id),
    }))
    .sort((a, b) =>
      (a.evaluatorType === "deterministic" ? 0 : 1) -
        (b.evaluatorType === "deterministic" ? 0 : 1) ||
      input.scorerIds.indexOf(a.scorerId) - input.scorerIds.indexOf(b.scorerId)
    );
  const repetitions = input.repetitions ?? 1;
  const roles: Role[] = input.baseline === undefined || input.baseline === null
    ? ["candidate"]
    : ["candidate", "baseline"];
  const cases = dataset.rows[0].cases;
  const total = cases.length * scorers.length * roles.length * repetitions;
  if (total > MAX_BATCH_RESULTS) unprocessable("datasetId", "batch_too_large");
  const rule: GateRule = {
    requireAllPassed: input.requireAllPassed ?? true,
    minPassRate: input.minPassRate ?? null,
  };
  const batch = await tx.query<BatchRow>(
    `insert into bakery.evaluation_batches (organization_id, dataset_id,
       dataset_digest, candidate, baseline, scorers, gate_rule, limits, state,
       created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9) returning *`,
    [
      organizationId,
      input.datasetId,
      dataset.rows[0].digest,
      JSON.stringify(input.candidate),
      roles.length === 2 ? JSON.stringify(input.baseline) : null,
      JSON.stringify(scorers),
      JSON.stringify(rule),
      JSON.stringify({
        repetitions,
        budgetLimitUsd: input.budgetLimitUsd === undefined
          ? null
          : String(input.budgetLimitUsd),
      }),
      principalId,
    ],
  );
  const id = batch.rows[0].id;
  // One insert: the result grid, in case order, every row missing.
  await tx.query(
    `insert into bakery.evaluation_results (organization_id, batch_id, role,
       case_id, case_revision, ordinal, scorer_id, scorer_revision, repetition,
       state, reason, required)
     select $1, $2, role, (c.value->>'caseId')::uuid,
            (c.value->>'caseRevision')::integer, c.ordinality::integer,
            (s.value->>'scorerId')::uuid, (s.value->>'scorerRevision')::integer,
            rep, 'missing', 'Not run yet.',
            coalesce((s.value->>'required')::boolean, true)
       from jsonb_array_elements($3::jsonb) with ordinality as c
       cross join jsonb_array_elements($4::jsonb) as s
       cross join unnest($5::text[]) as role
       cross join generate_series(1, $6::integer) as rep`,
    [
      organizationId,
      id,
      JSON.stringify(cases),
      JSON.stringify(scorers),
      roles,
      repetitions,
    ],
  );
  return await batchView(tx, organizationId, id);
}

/** The batch with what it used, counts, coverage, state and gate. */
export async function batchView(
  tx: PgTransactionClient,
  organizationId: string,
  batchId: string,
) {
  const found = await tx.query<BatchRow>(
    "select * from bakery.evaluation_batches where organization_id = $1 and id = $2",
    [organizationId, batchId],
  );
  const row = found.rows[0];
  if (!row) notFound();
  return await viewOf(tx, organizationId, row);
}

async function viewOf(
  tx: PgTransactionClient,
  organizationId: string,
  row: BatchRow,
) {
  const grouped = await tx.query<
    { state: ResultState; n: string; attempted: boolean }
  >(
    `select state, count(*)::text as n, bool_or(attempt_count > 0) as attempted
       from bakery.evaluation_results
      where organization_id = $1 and batch_id = $2 and role = 'candidate' and required
      group by state`,
    [organizationId, row.id],
  );
  const counts = emptyCounts();
  let attempted = false;
  for (const g of grouped.rows) {
    if ((RESULT_STATES as string[]).includes(g.state)) {
      counts[g.state] = Number(g.n);
    }
    attempted ||= g.attempted;
  }
  const required = Object.values(counts).reduce((s, n) => s + n, 0);
  const state = batchStateOf({
    canceled: row.canceled_at !== null,
    required,
    counts,
    attempted,
  });
  const blockers = await tx.query<GateBlocker>(
    `select case_id as "caseId", scorer_id as "scorerId", state
       from bakery.evaluation_results
      where organization_id = $1 and batch_id = $2 and role = 'candidate'
        and required and state <> 'passed'
      order by ordinal, scorer_id, repetition limit 100`,
    [organizationId, row.id],
  );
  const dataset = await tx.query<{ name: string }>(
    "select name from bakery.evaluation_datasets where organization_id = $1 and id = $2",
    [organizationId, row.dataset_id],
  );
  // The corpus report: each candidate result's history, grouped, so a batch of
  // thousands is one read. A result is interrupted if any attempt at it was.
  const history = await tx.query<
    {
      required: boolean;
      state: ResultState;
      attempted: boolean;
      interrupted: boolean;
      n: string;
    }
  >(
    `select r.required, r.state, r.attempt_count > 0 as attempted,
            exists (select 1 from bakery.evaluation_attempts a
                     where a.organization_id = r.organization_id
                       and a.result_id = r.id and a.state = 'interrupted') as interrupted,
            count(*)::text as n
       from bakery.evaluation_results r
      where r.organization_id = $1 and r.batch_id = $2 and r.role = 'candidate'
      group by 1, 2, 3, 4`,
    [organizationId, row.id],
  );
  const factsOf = (required: boolean): ReportFact[] =>
    history.rows.filter((h) => h.required === required).map((h) => ({
      state: h.state,
      attempts: h.attempted ? 1 : 0,
      interrupted: h.interrupted,
      count: Number(h.n),
    }));
  const optionalFacts = factsOf(false);
  const scorers = row.scorers.map((s) => ({
    ...s,
    required: s.required ?? true,
  }));
  const repetitions = Number(
    (row.limits as { repetitions?: unknown } | null)?.repetitions ?? 1,
  );
  const pinDigest = await sha256(canonical(pinSpec({
    datasetDigest: row.dataset_digest,
    candidate: row.candidate,
    baseline: row.baseline,
    scorers,
    repetitions,
  })));
  return {
    id: row.id,
    datasetId: row.dataset_id,
    datasetName: dataset.rows[0]?.name ?? "",
    datasetDigest: row.dataset_digest,
    candidate: row.candidate,
    candidateDefinition: await pinDefinition(tx, organizationId, row.candidate),
    baseline: row.baseline,
    baselineDefinition: row.baseline === null
      ? null
      : await pinDefinition(tx, organizationId, row.baseline),
    scorers,
    pinDigest,
    state,
    requiredCount: required,
    measuredCount: counts.passed + counts.failed,
    counts,
    report: corpusReport(factsOf(true)),
    optionalReport: optionalFacts.length === 0
      ? null
      : corpusReport(optionalFacts),
    gate: judgeGateCounts(
      { required, counts, blockers: blockers.rows },
      row.gate_rule,
      state,
    ),
    hiddenCount: 0,
    canceledAt: row.canceled_at ? iso(row.canceled_at) : null,
    canceledBy: row.canceled_by,
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export async function getBatch(context: ActionContext) {
  const { transaction: tx, organizationId } = requireWorkTransaction(context);
  const id = context.params.id;
  if (!id) notFound();
  return await batchView(tx, organizationId, id);
}

export function createBatchLister(secret: string) {
  return async (
    context: ActionContext,
    input: { cursor?: string; limit?: number },
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageLimit(input.limit);
    const binding: CursorBinding = {
      action: "evaluationBatches.list",
      principalId,
      organizationId,
      ordering: "createdAt:desc,id:desc",
      filters: "{}",
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const found = await tx.query<BatchRow>(
      `select *, to_char(created_at at time zone 'UTC', ${TS}) as cursor_created_at
         from bakery.evaluation_batches
        where organization_id = $1
          and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
        order by created_at desc, id desc limit $4`,
      [
        organizationId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = found.rows.slice(0, limit);
    const items = [];
    for (const row of visible) {
      items.push(await viewOf(tx, organizationId, row));
    }
    const last = visible.at(-1);
    return {
      items,
      nextCursor: found.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at!,
          id: last.id,
        })
        : null,
    };
  };
}

/**
 * Cancels a batch under the version guard: no new attempts, completed
 * results kept, still-missing results canceled with the reason.
 */
export async function cancelBatch(
  context: ActionContext,
  expectedVersion: number,
) {
  const { transaction: tx, organizationId, principalId } =
    requireWorkTransaction(context);
  const id = context.params.id;
  if (id === undefined) notFound();
  const locked = await tx.query<BatchRow>(
    "select * from bakery.evaluation_batches where organization_id = $1 and id = $2 for update",
    [organizationId, id],
  );
  const row = locked.rows[0];
  if (!row) notFound();
  if (Number(row.version) !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const view = await viewOf(tx, organizationId, row);
  if (view.state !== "queued" && view.state !== "running") {
    conflict("evaluation_batch_settled");
  }
  await tx.query(
    `update bakery.evaluation_results
        set state = 'canceled', reason = 'The batch was canceled before this ran.',
            updated_at = now(), version = version + 1
      where organization_id = $1 and batch_id = $2 and state = 'missing'`,
    [organizationId, id],
  );
  await tx.query(
    `update bakery.evaluation_batches
        set state = 'canceled', canceled_at = now(), canceled_by = $3,
            completed_at = now(), updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [organizationId, id, principalId],
  );
  return await batchView(tx, organizationId, id);
}

// ---------------------------------------------------------------- results

type ResultRow = {
  id: string;
  batch_id: string;
  role: Role;
  case_id: string;
  case_revision: number;
  ordinal: number;
  scorer_id: string;
  scorer_revision: number;
  repetition: number;
  required: boolean;
  state: ResultState;
  reason: string | null;
  score: string | null;
  output_artifact_version_id: string | null;
  attempt_count: number;
  updated_at: Date;
};

/** A result as listed: with the name of the case it measured. */
type ListedResultRow = ResultRow & { case_name: string };

const resultOut = (row: ListedResultRow) => ({
  id: row.id,
  batchId: row.batch_id,
  role: row.role,
  caseId: row.case_id,
  caseName: row.case_name,
  caseRevision: Number(row.case_revision),
  scorerId: row.scorer_id,
  scorerRevision: Number(row.scorer_revision),
  repetition: Number(row.repetition),
  required: row.required,
  state: row.state,
  reason: row.reason,
  score: row.score === null ? null : Number(row.score),
  outputArtifactVersionId: row.output_artifact_version_id,
  attemptCount: Number(row.attempt_count),
  updatedAt: iso(row.updated_at),
});

export function createResultLister(secret: string) {
  return async (
    context: ActionContext,
    input: { state?: ResultState; cursor?: string; limit?: number },
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageLimit(input.limit);
    const batchId = context.params.id;
    const exists = await tx.query(
      "select 1 from bakery.evaluation_batches where organization_id = $1 and id = $2",
      [organizationId, batchId],
    );
    if (!exists.rows[0]) notFound();
    const binding: CursorBinding = {
      action: "evaluationBatchResults.list",
      principalId,
      organizationId,
      ordering: "position:asc,iteration:asc,id:asc",
      filters: JSON.stringify({ batchId, state: input.state ?? null }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const found = await tx.query<ListedResultRow>(
      `select r.*, c.name as case_name from bakery.evaluation_results as r
         join bakery.evaluation_cases as c
           on c.organization_id = r.organization_id and c.id = r.case_id
        where r.organization_id = $1 and r.batch_id = $2
          and ($3::text is null or r.state = $3)
          and ($4::integer is null or (r.ordinal, r.id) > ($4, $5::uuid))
        order by r.ordinal, r.id limit $6`,
      [
        organizationId,
        batchId,
        input.state ?? null,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = found.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(resultOut),
      nextCursor: found.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: Number(last.ordinal),
          iteration: 0,
          id: last.id,
        })
        : null,
    };
  };
}

type AttemptRow = {
  id: string;
  result_id: string;
  attempt_no: number;
  state: ResultState | "interrupted";
  reason: string | null;
  score: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  trace_ref: string | null;
  created_at: Date;
};

export function createAttemptLister(secret: string) {
  return async (
    context: ActionContext,
    input: { cursor?: string; limit?: number },
  ) => {
    const { transaction: tx, organizationId, principalId } =
      requireWorkTransaction(context);
    const limit = pageLimit(input.limit);
    const resultId = context.params.id;
    const exists = await tx.query(
      "select 1 from bakery.evaluation_results where organization_id = $1 and id = $2",
      [organizationId, resultId],
    );
    if (!exists.rows[0]) notFound();
    const binding: CursorBinding = {
      action: "evaluationAttempts.list",
      principalId,
      organizationId,
      ordering: "position:asc,iteration:asc,id:asc",
      filters: JSON.stringify({ resultId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const found = await tx.query<AttemptRow>(
      `select * from bakery.evaluation_attempts
        where organization_id = $1 and result_id = $2
          and ($3::integer is null or attempt_no > $3)
        order by attempt_no limit $4`,
      [organizationId, resultId, position?.position ?? null, limit + 1],
    );
    const visible = found.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => ({
        id: row.id,
        resultId: row.result_id,
        attemptNo: Number(row.attempt_no),
        state: row.state,
        reason: row.reason,
        score: row.score === null ? null : Number(row.score),
        startedAt: row.started_at ? iso(row.started_at) : null,
        endedAt: row.ended_at ? iso(row.ended_at) : null,
        traceRef: row.trace_ref,
        createdAt: iso(row.created_at),
      })),
      nextCursor: found.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          position: Number(last.attempt_no),
          iteration: 0,
          id: last.id,
        })
        : null,
    };
  };
}

export type AttemptRecord = Readonly<{
  deliveryKey: string;
  /** "interrupted": the attempt ended before it measured anything; its result is an error with the reason. */
  state: Exclude<ResultState, "missing"> | "interrupted";
  reason: string | null;
  score: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  traceRef?: string | null;
  outputArtifactVersionId?: string | null;
}>;

/**
 * Records one attempt at a result, for the executor. A duplicate delivery
 * (the same delivery key) adds nothing and answers "duplicate"; a canceled
 * batch takes no attempt and answers "canceled", so the worker's result post
 * still succeeds. Only passed and failed carry a score, and they
 * must; any other state keeps its reason and has none. The result shows the
 * latest attempt; earlier attempts stay as they were.
 */
export async function recordAttempt(
  tx: PgTransactionClient,
  organizationId: string,
  resultId: string,
  attempt: AttemptRecord,
): Promise<"recorded" | "duplicate" | "canceled"> {
  const measured = attempt.state !== "interrupted" && isMeasured(attempt.state);
  if (measured !== (attempt.score !== null)) {
    unprocessable("score", measured ? "score_required" : "score_not_allowed");
  }
  if (attempt.score !== null && (attempt.score < 0 || attempt.score > 1)) {
    unprocessable("score", "out_of_range");
  }
  if (!measured && !attempt.reason) unprocessable("reason", "reason_required");
  // Lock order matches cancelBatch: the batch row first, then the result
  // row. The reverse order deadlocks a cancel racing a worker report, and a
  // locked batch row keeps the cancel check below current.
  const batch = await tx.query<{ canceled_at: Date | null }>(
    `select b.canceled_at from bakery.evaluation_batches b
      where b.organization_id = $1
        and b.id = (select r.batch_id from bakery.evaluation_results r
                     where r.organization_id = $1 and r.id = $2)
      for update of b`,
    [organizationId, resultId],
  );
  const batchRow = batch.rows[0];
  if (!batchRow) notFound();
  const locked = await tx.query<ResultRow>(
    `select r.* from bakery.evaluation_results r
      where r.organization_id = $1 and r.id = $2 for update of r`,
    [organizationId, resultId],
  );
  const found = locked.rows[0];
  if (!found) notFound();
  const row = { ...found, canceled_at: batchRow.canceled_at };
  const seen = await tx.query(
    "select 1 from bakery.evaluation_attempts where organization_id = $1 and result_id = $2 and delivery_key = $3",
    [organizationId, resultId, attempt.deliveryKey],
  );
  if (seen.rows[0]) return "duplicate";
  // A canceled batch takes no attempt, but the worker's result still lands:
  // the attempt is acknowledged and nothing changes.
  if (row.canceled_at !== null) return "canceled";
  await tx.query(
    `insert into bakery.evaluation_attempts (organization_id, result_id,
       attempt_no, delivery_key, state, reason, score, started_at, ended_at,
       trace_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      organizationId,
      resultId,
      Number(row.attempt_count) + 1,
      attempt.deliveryKey,
      attempt.state,
      attempt.reason,
      attempt.score,
      attempt.startedAt,
      attempt.endedAt,
      attempt.traceRef ?? null,
    ],
  );
  await tx.query(
    `update bakery.evaluation_results
        set state = $3, reason = $4, score = $5,
            output_artifact_version_id = coalesce($6, output_artifact_version_id),
            attempt_count = attempt_count + 1, updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2`,
    [
      organizationId,
      resultId,
      resultStateOfAttempt(attempt.state),
      attempt.reason,
      attempt.score,
      attempt.outputArtifactVersionId ?? null,
    ],
  );
  const view = await batchView(tx, organizationId, row.batch_id);
  if (view.state === "completed" || view.state === "completed_with_errors") {
    await tx.query(
      `update bakery.evaluation_batches
          set state = $3, completed_at = coalesce(completed_at, now()),
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and state <> $3`,
      [organizationId, row.batch_id, view.state],
    );
  } else if (view.state === "running") {
    await tx.query(
      `update bakery.evaluation_batches set state = 'running', updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2 and state = 'queued'`,
      [organizationId, row.batch_id],
    );
  }
  return "recorded";
}

// -------------------------------------------------------------- comparison

async function facts(
  tx: PgTransactionClient,
  organizationId: string,
  batchId: string,
) {
  const found = await tx.query<ResultRow>(
    `select * from bakery.evaluation_results
      where organization_id = $1 and batch_id = $2 and role = 'candidate'
      order by ordinal, id limit $3`,
    [organizationId, batchId, MAX_BATCH_RESULTS],
  );
  return found.rows.map((r): ResultFact => ({
    role: r.role,
    caseId: r.case_id,
    caseRevision: Number(r.case_revision),
    scorerId: r.scorer_id,
    scorerRevision: Number(r.scorer_revision),
    repetition: Number(r.repetition),
    state: r.state,
    score: r.score === null ? null : Number(r.score),
    required: r.required,
  }));
}

/** Compares the path batch (left) with another batch of the organization. */
export async function compare(
  context: ActionContext,
  input: { other: string },
) {
  const { transaction: tx, organizationId } = requireWorkTransaction(context);
  const read = async (id: string | undefined) => {
    const found = await tx.query<BatchRow & { cases: DatasetRow["cases"] }>(
      `select b.*, d.cases from bakery.evaluation_batches b
         join bakery.evaluation_datasets d
           on d.organization_id = b.organization_id and d.id = b.dataset_id
        where b.organization_id = $1 and b.id = $2`,
      [organizationId, id],
    );
    return found.rows[0] ?? notFound();
  };
  const left = await read(context.params.id);
  const right = await read(input.other);
  const pins = (b: typeof left) => ({
    datasetId: b.dataset_id,
    datasetDigest: b.dataset_digest,
    cases: b.cases,
    scorers: b.scorers.map((s) => ({
      scorerId: s.scorerId,
      scorerRevision: s.scorerRevision,
    })),
  });
  const verdict = compatibility(pins(left), pins(right));
  if (!verdict.compatible) {
    return {
      compatible: false,
      reason: verdict.reason,
      measures: [],
      cases: [],
      onlyLeft: [],
      onlyRight: [],
    };
  }
  const out = compareBatches(
    await facts(tx, organizationId, left.id),
    await facts(tx, organizationId, right.id),
  );
  return {
    compatible: true,
    reason: null,
    measures: out.measures,
    cases: out.cases,
    onlyLeft: out.unpaired.onlyLeft,
    onlyRight: out.unpaired.onlyRight,
  };
}

export { State as EvaluationResultState };
