import type { PgTransactionClient } from "@bakery/persistence";
import type { StepFact } from "./step-facts.ts";

export type GivenFactState = "given" | "corrected_since" | "stopped_since";

export type GivenFact = Readonly<{
  memoryId: string;
  wording: string;
  recordedAt: string;
  state: GivenFactState;
}>;

export type FactNow = Readonly<{
  currentRevisionId: string | null;
  status: string;
}>;

export function describeGivenFact(
  recorded: StepFact,
  now: FactNow | undefined,
): GivenFact {
  const state: GivenFactState = now === undefined || now.status === "retired"
    ? "stopped_since"
    : now.currentRevisionId !== null &&
        now.currentRevisionId !== recorded.revisionId
    ? "corrected_since"
    : "given";
  return {
    memoryId: recorded.memoryId,
    wording: recorded.wording,
    recordedAt: recorded.recordedAt,
    state,
  };
}

export function describeGivenFacts(
  recorded: readonly StepFact[],
  now: ReadonlyMap<string, FactNow>,
): readonly GivenFact[] {
  return recorded.map((fact) =>
    describeGivenFact(fact, now.get(fact.memoryId))
  );
}

export type GivenDocument = Readonly<{
  artifactVersionId: string;
  name: string;
  kind: string;
  version: number;
  sizeBytes: number;
}>;

export type StepGiven = Readonly<{
  stepKey: string;
  startedAt: string | null;
  ranAnAgent: boolean;
  facts: readonly GivenFact[];
  factsOmitted: number;
  documents: readonly GivenDocument[];
}>;

type StepFactsRecord = Readonly<{
  facts?: readonly StepFact[];
  omitted?: number;
}>;

export async function readStepGiven(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    runId: string;
    stepKey: string;
  }>,
): Promise<StepGiven | null> {
  const step = (await transaction.query<{
    stepKey: string;
    startedAt: string | null;
    recorded: StepFactsRecord | null;
  }>(
    `select step_key as "stepKey",
            started_at::text as "startedAt",
            dispatch -> 'facts' as recorded
       from bakery.run_steps
      where organization_id = $1 and run_id = $2 and step_key = $3
      order by iteration desc
      limit 1`,
    [input.organizationId, input.runId, input.stepKey],
  )).rows[0];
  if (step === undefined) return null;

  const ranAnAgent = (await transaction.query<{ ran: boolean }>(
    `select exists (
       select 1 from bakery.agent_sessions
        where organization_id = $1 and run_step_id = (
          select id from bakery.run_steps
           where organization_id = $1 and run_id = $2 and step_key = $3
           order by iteration desc limit 1))
       as ran`,
    [input.organizationId, input.runId, input.stepKey],
  )).rows[0].ran;

  const recorded = step.recorded?.facts ?? [];
  const now = new Map<string, FactNow>();
  if (recorded.length > 0) {
    const rows = await transaction.query<{
      memoryId: string;
      currentRevisionId: string | null;
      status: string;
    }>(
      `select id as "memoryId",
              current_revision_id as "currentRevisionId",
              status
         from bakery.memory_entries
        where organization_id = $1 and id = any($2::uuid[])`,
      [input.organizationId, recorded.map((fact) => fact.memoryId)],
    );
    for (const row of rows.rows) now.set(row.memoryId, row);
  }

  return {
    stepKey: step.stepKey,
    startedAt: step.startedAt,
    ranAnAgent,
    facts: describeGivenFacts(recorded, now),
    factsOmitted: step.recorded?.omitted ?? 0,
    documents: await readGivenDocuments(transaction, input),
  };
}

async function readGivenDocuments(
  transaction: PgTransactionClient,
  input: Readonly<{ organizationId: string; runId: string }>,
): Promise<readonly GivenDocument[]> {
  const rows = await transaction.query<GivenDocument>(
    `select version.id as "artifactVersionId",
            artifact.name as "name",
            artifact.artifact_type as "kind",
            version.revision::integer as "version",
            version.size_bytes as "sizeBytes"
       from bakery.run_input_pins pin
       join bakery.artifact_versions version on version.id = pin.artifact_version_id
       join bakery.artifacts artifact on artifact.id = version.artifact_id
      where pin.organization_id = $1 and pin.run_id = $2
      order by pin.created_at, pin.id`,
    [input.organizationId, input.runId],
  );
  return rows.rows;
}
