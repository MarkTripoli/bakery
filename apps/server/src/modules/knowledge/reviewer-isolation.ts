/**
 * Reviewer isolation (chapter 25 section 17.6, O47, issue #448 S8b). A
 * reviewer-role agent session never receives, in a read, a listing or a
 * search result, a version a writer step of the same run tree wrote outside
 * its declared outputs, nor a transcript of another step. The filter reads the
 * provenance each version recorded at its write (#448 S8a), never the folder
 * a file sits in or its name, so a folder grant to the workflow does not
 * reopen what it hides.
 *
 * The rule, for a session whose attempt runs the review action:
 * - its run tree is the reviewer's run, its spawn ancestors to the root, and
 *   every run spawned below that root (workflow_runs.spawned_by_run_id);
 * - a working-area version (bakery.storage_file_versions) is hidden when the
 *   run that wrote it is in that tree and the step that wrote it is not the
 *   reviewer's own. A version written before migration 0300 names no run:
 *   its step write set row names the attempt, and the attempt's job names the
 *   step and run;
 * - a record-area version (bakery.artifact_versions) is a declared output,
 *   the only way a step writes there, and stays visible; except a transcript
 *   (a `log` artifact under `output-transcript/`), which is hidden unless the
 *   reviewer's own step wrote it;
 * - a version a person or a service wrote outside a step names no run and is
 *   never hidden.
 * A person's own request, and every session whose step is not a reviewer's,
 * passes untouched. A hidden file answers 404, the same as one that is not
 * there, so its existence does not leak either.
 */

import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";

/** The job action of a review step: a session running it is a reviewer's. */
export const REVIEW_ACTION = "review.independent";

/** What hides versions from one reviewer session. */
export type ReviewerIsolation = Readonly<{
  /** Every run of the reviewer's run tree, the reviewer's own included. */
  treeRunIds: readonly string[];
  /** The reviewer's own step: what it wrote itself stays visible to it. */
  ownStepId: string;
}>;

type Query = Pick<PgTransactionClient, "query">;

// One lookup per session call: the context's session object is the key.
const memo = new WeakMap<object, Promise<ReviewerIsolation | null>>();

/**
 * The isolation one call runs under, or null when nothing is hidden: a
 * person's request, a session of a step that is not a reviewer's, or an
 * attempt that belongs to no run step in this organization.
 */
export function reviewerIsolationOf(
  tx: Query,
  context: Pick<ActionContext, "agentSession">,
  organizationId: string,
): Promise<ReviewerIsolation | null> {
  const session = context.agentSession;
  if (session === undefined) return Promise.resolve(null);
  const known = memo.get(session);
  if (known !== undefined) return known;
  const found = lookUp(tx, organizationId, session.attemptId);
  memo.set(session, found);
  return found;
}

async function lookUp(
  tx: Query,
  organizationId: string,
  attemptId: string,
): Promise<ReviewerIsolation | null> {
  const step = await tx.query<{ run_id: string; run_step_id: string }>(
    `select step.run_id, step.id as run_step_id
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
      where attempt.organization_id = $1 and attempt.id = $2
        and job.action = $3`,
    [organizationId, attemptId, REVIEW_ACTION],
  );
  const own = step.rows[0];
  if (own === undefined) return null;
  // Up the spawn chain to the root, then every run below it. Both walks are
  // bounded and read with the organization predicate on every row.
  const tree = await tx.query<{ id: string }>(
    `with recursive up as (
       select id, spawned_by_run_id, 0 as depth from bakery.workflow_runs
        where organization_id = $1 and id = $2
       union all
       select run.id, run.spawned_by_run_id, up.depth + 1
         from bakery.workflow_runs run
         join up on run.organization_id = $1 and run.id = up.spawned_by_run_id
        where up.depth < 64
     ),
     root as (select id from up order by depth desc limit 1),
     down as (
       select id, 0 as depth from root
       union all
       select run.id, down.depth + 1
         from bakery.workflow_runs run
         join down on run.organization_id = $1
                  and run.spawned_by_run_id = down.id
        where down.depth < 64
     )
     select distinct id from down`,
    [organizationId, own.run_id],
  );
  const treeRunIds = tree.rows.map((row) => row.id);
  if (!treeRunIds.includes(own.run_id)) treeRunIds.push(own.run_id);
  return { treeRunIds, ownStepId: own.run_step_id };
}

/**
 * SQL that is true when working-area version `v` is a writer side-write the
 * reviewer may not see. `$1` is the organization, `tree` and `own` name the
 * placeholders of the tree's run ids and the reviewer's step.
 */
function workingHiddenSql(v: string, tree: string, own: string): string {
  return `exists (
    select 1
      from (select coalesce(${v}.run_id, traced.run_id) as run_id,
                   coalesce(${v}.run_step_id, traced.step_id) as step_id
              from (select 1) as one
              left join lateral (
                select step.run_id, step.id as step_id
                  from bakery.step_write_set w
                  join bakery.job_attempts attempt
                    on attempt.organization_id = w.organization_id
                   and attempt.id = w.attempt_id
                  join bakery.jobs job
                    on job.organization_id = attempt.organization_id
                   and job.id = attempt.job_id
                  join bakery.run_steps step
                    on step.organization_id = job.organization_id
                   and step.id = job.run_step_id
                 where ${v}.run_id is null
                   and w.organization_id = ${v}.organization_id
                   and w.new_version_id = ${v}.id
                   and w.op in ('put', 'copy')
                 order by w.created_at, w.id
                 limit 1
              ) as traced on true) as producer
     where producer.run_id = any(${tree}::uuid[])
       and producer.step_id is distinct from ${own}::uuid)`;
}

/** SQL that is true when record-area version `v` of artifact `a` is a transcript of another step. */
function artifactHiddenSql(v: string, a: string, own: string): string {
  return `(${a}.artifact_type = 'log'
    and starts_with(${a}.name, 'output-transcript/')
    and ${v}.run_step_id is distinct from ${own}::uuid)`;
}

/**
 * The files among `entryIds` whose current version the reviewer may not see:
 * a working-area file's current version, or a record-area file's artifact's.
 */
export async function hiddenEntryIds(
  tx: Query,
  isolation: ReviewerIsolation | null,
  organizationId: string,
  entryIds: readonly string[],
): Promise<Set<string>> {
  if (isolation === null || entryIds.length === 0) return new Set();
  const found = await tx.query<{ id: string }>(
    `select e.id from bakery.storage_entries e
       left join bakery.storage_file_versions wv
         on e.artifact_id is null
        and wv.organization_id = e.organization_id
        and wv.id = e.current_version_id
       left join bakery.artifacts a
         on a.organization_id = e.organization_id and a.id = e.artifact_id
       left join bakery.artifact_versions av
         on av.organization_id = a.organization_id
        and av.id = a.current_version_id
      where e.organization_id = $1 and e.id = any($2::uuid[])
        and e.kind = 'file'
        and ((wv.id is not null and ${workingHiddenSql("wv", "$3", "$4")})
          or (av.id is not null and ${artifactHiddenSql("av", "a", "$4")}))`,
    [organizationId, entryIds, isolation.treeRunIds, isolation.ownStepId],
  );
  return new Set(found.rows.map((row) => row.id));
}

/** The versions among `versionIds` (working or record area) the reviewer may not see. */
export async function hiddenVersionIds(
  tx: Query,
  isolation: ReviewerIsolation | null,
  organizationId: string,
  versionIds: readonly string[],
): Promise<Set<string>> {
  if (isolation === null || versionIds.length === 0) return new Set();
  const found = await tx.query<{ id: string }>(
    `select wv.id from bakery.storage_file_versions wv
      where wv.organization_id = $1 and wv.id = any($2::uuid[])
        and ${workingHiddenSql("wv", "$3", "$4")}
     union all
     select av.id from bakery.artifact_versions av
       join bakery.artifacts a
         on a.organization_id = av.organization_id and a.id = av.artifact_id
      where av.organization_id = $1 and av.id = any($2::uuid[])
        and ${artifactHiddenSql("av", "a", "$4")}`,
    [organizationId, versionIds, isolation.treeRunIds, isolation.ownStepId],
  );
  return new Set(found.rows.map((row) => row.id));
}

/** The artifacts among `artifactIds` the reviewer may not see: another step's transcripts. */
export async function hiddenArtifactIds(
  tx: Query,
  isolation: ReviewerIsolation | null,
  organizationId: string,
  artifactIds: readonly string[],
): Promise<Set<string>> {
  if (isolation === null || artifactIds.length === 0) return new Set();
  const found = await tx.query<{ id: string }>(
    `select a.id from bakery.artifacts a
       left join bakery.artifact_versions av
         on av.organization_id = a.organization_id
        and av.id = a.current_version_id
      where a.organization_id = $1 and a.id = any($2::uuid[])
        and a.artifact_type = 'log'
        and starts_with(a.name, 'output-transcript/')
        and (av.id is null or av.run_step_id is distinct from $3::uuid)`,
    [organizationId, artifactIds, isolation.ownStepId],
  );
  return new Set(found.rows.map((row) => row.id));
}

/**
 * Whether entry `entryId` is a declared output of the reviewer's run tree: a
 * record-area file whose current version a step of the tree wrote, and not a
 * transcript. The read guard lets a reviewer read it even in a folder its
 * files section does not reach (O47); it widens nothing else.
 */
export async function reviewerDeclaredOutput(
  tx: Query,
  isolation: ReviewerIsolation | null,
  organizationId: string,
  entryId: string,
): Promise<boolean> {
  if (isolation === null) return false;
  const found = await tx.query<{ id: string }>(
    `select e.id from bakery.storage_entries e
       join bakery.artifacts a
         on a.organization_id = e.organization_id and a.id = e.artifact_id
       join bakery.artifact_versions av
         on av.organization_id = a.organization_id
        and av.id = a.current_version_id
      where e.organization_id = $1 and e.id = $2 and e.kind = 'file'
        and av.run_step_id is not null
        and av.run_id = any($3::uuid[])
        and not ${artifactHiddenSql("av", "a", "$4")}`,
    [organizationId, entryId, isolation.treeRunIds, isolation.ownStepId],
  );
  return found.rows.length > 0;
}

/** Not found, as for a file that is not there: a hidden file does not leak. */
export function hiddenFromReviewer(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}
