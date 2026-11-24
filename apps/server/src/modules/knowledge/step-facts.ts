import type { PgTransactionClient } from "@bakery/persistence";

export const STEP_FACTS_MAX = 12;
export const STEP_FACTS_BYTE_BUDGET = 6_000;

export type StepFact = Readonly<{
  memoryId: string;
  revisionId: string;
  wording: string;
  recordedAt: string;
}>;

export type StepFacts = Readonly<{
  facts: readonly StepFact[];
  omitted: number;
}>;

export type StepFactRow = Readonly<{
  memoryId: string;
  revisionId: string;
  wording: string;
  recordedAt: string;
}>;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function boundStepFacts(
  candidates: readonly StepFactRow[],
  caps: { max?: number; byteBudget?: number } = {},
): StepFacts {
  const max = caps.max ?? STEP_FACTS_MAX;
  const byteBudget = caps.byteBudget ?? STEP_FACTS_BYTE_BUDGET;
  const facts: StepFact[] = [];
  let used = 0;
  for (const candidate of candidates) {
    if (facts.length >= max) break;
    const cost = utf8Bytes(candidate.wording);
    if (used + cost > byteBudget) break;
    used += cost;
    facts.push(candidate);
  }
  return { facts, omitted: candidates.length - facts.length };
}

export async function chooseStepFacts(
  transaction: PgTransactionClient,
  input: Readonly<{ organizationId: string; repositoryId: string }>,
): Promise<StepFacts> {
  const rows = await transaction.query<StepFactRow>(
    `select m.id as "memoryId",
            r.id as "revisionId",
            r.body as "wording",
            to_char(r.created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt"
       from bakery.memory_entries m
       join bakery.memory_revisions r on r.id = m.current_revision_id
      where m.organization_id = $1
        and m.repository_id = $2
        and m.status = 'active'
        and (r.expires_at is null or r.expires_at > now())
      order by m.updated_at desc, m.id`,
    [input.organizationId, input.repositoryId],
  );
  return boundStepFacts(rows.rows);
}
