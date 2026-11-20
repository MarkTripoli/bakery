import type { PgTransactionClient } from "@bakery/persistence";
import { StandardError } from "@bakery/contracts/http";

// New FK kinds must register a check before collection can resume.
export const artifactVersionReferences = [
  {
    kind: "current-pointer",
    table: "artifacts",
    constraint: "artifacts_current_version_fk",
    protection: "none",
  },
  {
    kind: "draft-base",
    table: "artifact_drafts",
    constraint: "artifact_drafts_base_version_fk",
    protection: "active",
  },
  {
    // Only closed streams publish segments; collection preserves these references.
    kind: "output-transcript",
    table: "output_transcript_segments",
    constraint: "output_transcript_segments_artifact_version_fk",
    protection: "none",
  },
  {
    kind: "unresolved-comment",
    table: "artifact_comments",
    constraint: "artifact_comments_organization_id_artifact_version_id_fkey",
    protection: "open-root",
  },
  {
    // A preview grant opens the bytes only while they exist; a purged version
    // answers 410, so collection never needs to wait for a grant.
    kind: "preview-grant",
    table: "artifact_preview_grants",
    constraint: "artifact_preview_grants_version_fk",
    protection: "none",
  },
  {
    // A live external effect (prepared, submitted or uncertain) may still be
    // dispatched or reconciled from these oversized arguments.
    kind: "external-effect-arguments",
    table: "external_effects",
    constraint: "external_effects_argument_artifact_version_fk",
    protection: "live-effect",
  },
  {
    // A draft publication records which version a checkpoint became (#71). It
    // never keeps the bytes alive: purging the version removes the record.
    kind: "draft-publication",
    table: "artifact_draft_publications",
    constraint: "artifact_draft_publications_version_fk",
    protection: "none",
  },
  {
    // A check row cites its output as retained evidence. The bytes stay for as
    // long as the row exists: expiry alone never retires check evidence.
    kind: "retained-evidence",
    table: "check_runs",
    constraint: "check_runs_evidence_version_fk",
    protection: "retained-evidence",
  },
  {
    // A run pins the exact version each declared input resolved to at
    // admission (#402). The bytes stay readable for as long as the run is
    // live, then the pin ends with it; a person's separate hold is untouched.
    kind: "run-input-pin",
    table: "run_input_pins",
    constraint: "run_input_pins_version_fk",
    protection: "run-pin",
  },
  {
    // A memory revision cites the version it was promoted from. The citation is
    // the whole point of sourced memory: a reader has to be able to reach the
    // evidence, so the bytes stay for as long as the revision that cites them.
    kind: "memory-source",
    table: "memory_revisions",
    constraint: "memory_revisions_source_fk",
    protection: "retained-evidence",
  },
  {
    // An evaluation case pins the input it is scored on (#44). A dataset is
    // only reproducible while that input is readable, so the bytes stay for as
    // long as the case exists.
    kind: "evaluation-case-input",
    table: "evaluation_cases",
    constraint: "evaluation_cases_input_fk",
    protection: "retained-evidence",
  },
  {
    // An evaluation result names the exact output it scored. The score is
    // evidence about those bytes, so they stay for as long as the result does.
    kind: "evaluation-result-output",
    table: "evaluation_results",
    constraint: "evaluation_results_output_fk",
    protection: "retained-evidence",
  },
] as const;
export const declaredArtifactReferenceKinds = [
  "current-pointer",
  "draft-base",
  "run-snapshot",
  "step-input-output",
  "job-input-output",
  "unresolved-comment",
  "retained-evidence",
  "output-transcript",
  "external-effect-arguments",
  "run-input-pin",
  "memory-source",
  "evaluation-case-input",
  "evaluation-result-output",
] as const;
export type ArtifactReferenceKind =
  typeof declaredArtifactReferenceKinds[number];
export type ReferenceCheck = {
  readonly kind: ArtifactReferenceKind;
  readonly protects: (
    transaction: PgTransactionClient,
    organizationId: string,
    versionId: string,
  ) => Promise<boolean>;
};
export const additionalArtifactReferenceChecks: readonly ReferenceCheck[] = [
  {
    kind: "run-input-pin",
    async protects(transaction, organizationId, versionId) {
      const result = await transaction.query(
        `select 1 from bakery.run_input_pins p
           join bakery.workflow_runs r
             on r.organization_id = p.organization_id and r.id = p.run_id
          where p.organization_id=$1 and p.artifact_version_id=$2
            and r.status not in ('completed','failed','canceled')
          limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
  {
    kind: "unresolved-comment",
    async protects(transaction, organizationId, versionId) {
      const result = await transaction.query(
        `select 1 from bakery.artifact_comments
         where organization_id=$1 and artifact_version_id=$2
           and parent_comment_id is null and status='open' and deleted_at is null
         limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
  {
    kind: "external-effect-arguments",
    async protects(transaction, organizationId, versionId) {
      const result = await transaction.query(
        `select 1 from bakery.external_effects
         where organization_id=$1 and argument_artifact_version_id=$2
           and status in ('prepared','submitted','uncertain')
         limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
  {
    kind: "retained-evidence",
    async protects(transaction, organizationId, versionId) {
      const result = await transaction.query(
        `select 1 from bakery.check_runs
         where organization_id=$1 and evidence_version_id=$2
         limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
  {
    kind: "memory-source",
    async protects(transaction, organizationId, versionId) {
      const result = await transaction.query(
        `select 1 from bakery.memory_revisions
         where organization_id=$1 and source_artifact_version_id=$2
         limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
  {
    kind: "evaluation-case-input",
    async protects(transaction, organizationId, versionId) {
      const result = await transaction.query(
        `select 1 from bakery.evaluation_cases
         where organization_id=$1 and input_artifact_version_id=$2
         limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
  {
    kind: "evaluation-result-output",
    async protects(transaction, organizationId, versionId) {
      const result = await transaction.query(
        `select 1 from bakery.evaluation_results
         where organization_id=$1 and output_artifact_version_id=$2
         limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
];

export function isClassifiedArtifactForeignKey(
  table: string,
  constraint: string,
): boolean {
  return artifactVersionReferences.some((entry) =>
    entry.table === table && entry.constraint === constraint
  );
}

export async function lockRetainedArtifactVersion(
  transaction: PgTransactionClient,
  organizationId: string,
  artifactId: string,
  versionId: string,
): Promise<void> {
  const parent = await transaction.query(
    `select id from bakery.artifacts where organization_id=$1 and id=$2 for update`,
    [organizationId, artifactId],
  );
  if (!parent.rowCount) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<
    { purged_at: Date | null; present: boolean }
  >(
    // "Present" is "has a home for its bytes", not "has inline bytes": a
    // blob-backed version carries no content column and is still present.
    `select purged_at, (content is not null or blob_id is not null) as present from bakery.artifact_versions where organization_id=$1 and artifact_id=$2 and id=$3 for update`,
    [organizationId, artifactId, versionId],
  );
  if (!result.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (result.rows[0].purged_at !== null) {
    throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
  }
  if (!result.rows[0].present) throw new StandardError({ code: "INTERNAL" });
}

export async function hasProtectedArtifactReference(
  transaction: PgTransactionClient,
  organizationId: string,
  versionId: string,
): Promise<boolean> {
  const foreignKeys = await transaction.query<
    { table_name: string; constraint_name: string }
  >(`
    select c.conrelid::regclass::text as table_name, c.conname as constraint_name
    from pg_catalog.pg_constraint c
    where c.contype='f' and c.confrelid='bakery.artifact_versions'::regclass`);
  if (
    foreignKeys.rows.some((row) =>
      !isClassifiedArtifactForeignKey(
        row.table_name.replace(/^bakery\./, ""),
        row.constraint_name,
      )
    )
  ) return true;
  const protectedRows = await transaction.query(
    `
    select 1 from bakery.artifact_drafts where organization_id=$1 and base_version_id=$2 and status='active'
    union all
    select 1 from bakery.workflow_runs where organization_id=$1 and status not in ('completed','failed','canceled')
      and jsonb_path_exists(snapshot, '$.** ? (@ == $id)', jsonb_build_object('id',$2::text))
    union all
    select 1 from bakery.run_steps s join bakery.workflow_runs r on r.organization_id=s.organization_id and r.id=s.run_id
      where s.organization_id=$1 and (s.status not in ('completed','failed','canceled','skipped') or r.status not in ('completed','failed','canceled'))
      and (jsonb_path_exists(s.input, '$.** ? (@ == $id)', jsonb_build_object('id',$2::text))
        or jsonb_path_exists(s.output, '$.** ? (@ == $id)', jsonb_build_object('id',$2::text))
        or s.id in (select run_step_id from bakery.artifact_versions where id=$2))
    union all
    select 1 from bakery.jobs where organization_id=$1 and status not in ('completed','failed','canceled')
      and (jsonb_path_exists(input, '$.** ? (@ == $id)', jsonb_build_object('id',$2::text))
        or jsonb_path_exists(current_checkpoints, '$.** ? (@ == $id)', jsonb_build_object('id',$2::text)))
    limit 1`,
    [organizationId, versionId],
  );
  if (protectedRows.rowCount) return true;
  for (const check of additionalArtifactReferenceChecks) {
    if (await check.protects(transaction, organizationId, versionId)) {
      return true;
    }
  }
  return false;
}
