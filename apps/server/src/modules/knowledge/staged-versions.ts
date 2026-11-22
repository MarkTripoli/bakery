/**
 * Settling staged artifact versions from a probe answer (chapter 25 section
 * 17.5, O29, #437 final slice).
 *
 * A version published under a kind with a probe-backed rule is written staged:
 * it exists, it is not the artifact's current version, and no reader serves it
 * (content, preview, extract, comments and handoff all answer not-found) until
 * its probe publishes it. This module is the only thing that moves it on, and it runs in the
 * same transaction that stores the probe's answer, so an answer can never be
 * stored while the version it decides stays undecided.
 *
 * - A described answer runs the kind's probe-backed rules. No `require` finding:
 *   the version becomes current, and the artifact's current pointer moves to it
 *   unless a newer revision is already current. A `require` finding: the version
 *   is refused, naming the kind version and the rule.
 * - A refusal that is the file's fault (too-large, malformed, unreadable) refuses
 *   the version with that code.
 * - A refusal about the host (sandbox-unavailable, timeout, memory) decides
 *   nothing: the version stays staged and the runner asks again.
 */
import type { PgTransactionClient } from "@bakery/persistence";
import type { ArtifactProbeResult } from "@bakery/contracts/artifact-probe";
import {
  refusesArtifactKindPublication,
  validateProbedArtifactKindDocument,
} from "@bakery/contracts/artifact-kinds";
import { resolveArtifactKindBinding } from "../artifact-kinds/publication-gate.ts";
import { reconcileCoordinationForCommittedOutput } from "../work/coordination-projection.ts";
import type { ProbeSubject } from "./blob-probes.ts";

/** The vocabulary of `artifact_versions.publication_status`. */
export const ARTIFACT_PUBLICATION_STATUSES = Object.freeze(
  ["current", "staged", "refused"] as const,
);
export type ArtifactPublicationStatus =
  typeof ARTIFACT_PUBLICATION_STATUSES[number];

/** Probe refusals that are about the file, and so refuse a staged version. */
const FILE_FAULT_CODES: ReadonlySet<string> = new Set([
  "too-large",
  "malformed",
  "unreadable",
]);

/**
 * Whether a probe answer says something about the file a staged version can be
 * settled on. A host fault does not: it leaves the version staged.
 */
export function settlesStagedVersion(result: ArtifactProbeResult): boolean {
  return result.status === "described" || FILE_FAULT_CODES.has(result.code);
}

type StagedRow = {
  id: string;
  artifact_id: string;
  revision: number;
  kind_version_id: string | null;
  artifact_type: string;
  name: string;
  task_id: string;
};

/** The staged versions one probe subject decides, locked for the settle. */
async function stagedVersionsOf(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
  subject: ProbeSubject,
): Promise<readonly StagedRow[]> {
  if ("entryId" in subject) return [];
  const match = "blobId" in subject ? "v.blob_id = $2" : "v.id = $2";
  const value = "blobId" in subject
    ? subject.blobId
    : subject.artifactVersionId;
  const { rows } = await transaction.query<StagedRow>(
    `select v.id, v.artifact_id, v.revision, a.kind_version_id,
            a.artifact_type, a.name, a.task_id
       from bakery.artifact_versions v
       join bakery.artifacts a
         on a.organization_id = v.organization_id and a.id = v.artifact_id
      where v.organization_id = $1 and ${match}
        and v.publication_status = 'staged'
      order by v.revision, v.id
      for update of v, a`,
    [organizationId, value],
  );
  return rows;
}

/** Whether any staged version waits on this subject's answer. */
export async function hasStagedVersions(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
  subject: ProbeSubject,
): Promise<boolean> {
  if ("entryId" in subject) return false;
  const match = "blobId" in subject ? "blob_id = $2" : "id = $2";
  const value = "blobId" in subject
    ? subject.blobId
    : subject.artifactVersionId;
  const { rows } = await transaction.query(
    `select 1 from bakery.artifact_versions
      where organization_id = $1 and ${match}
        and publication_status = 'staged'
      limit 1`,
    [organizationId, value],
  );
  return rows.length > 0;
}

/**
 * Promotes or refuses every staged version the answer decides.
 *
 * Scoped by organization on every statement: the subject is an id the runner
 * read from one organization's request, and a blob id from one organization can
 * never settle another organization's version.
 */
export async function settleStagedVersions(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    subject: ProbeSubject;
    result: ArtifactProbeResult;
  }>,
): Promise<{ promoted: number; refused: number }> {
  let promoted = 0;
  let refused = 0;
  if (!settlesStagedVersion(input.result)) return { promoted, refused };
  const rows = await stagedVersionsOf(
    transaction,
    input.organizationId,
    input.subject,
  );
  for (const row of rows) {
    // A staged version always has a bound kind: staging is decided from the
    // binding the publish transaction pinned on the artifact.
    const binding = row.kind_version_id === null
      ? null
      : await resolveArtifactKindBinding(transaction, {
        organizationId: input.organizationId,
        artifactType: row.artifact_type,
        boundKindVersionId: row.kind_version_id,
      });
    let refusal: { rule: string | null; reason: string } | null = null;
    if (input.result.status === "refused") {
      refusal = { rule: null, reason: input.result.code };
    } else if (binding !== null) {
      const findings = validateProbedArtifactKindDocument(
        binding.definition,
        input.result,
      );
      if (refusesArtifactKindPublication(findings)) {
        const first = findings.find((finding) =>
          finding.severity === "require"
        )!;
        refusal = { rule: first.ruleType, reason: first.message };
      }
    }
    if (refusal !== null) {
      await transaction.query(
        `update bakery.artifact_versions
            set publication_status = 'refused', settled_at = now(),
                refused_kind_version_id = $3, refused_rule_type = $4,
                refused_reason = $5
          where organization_id = $1 and id = $2`,
        [
          input.organizationId,
          row.id,
          binding?.kindVersionId ?? null,
          refusal.rule,
          refusal.reason.slice(0, 500),
        ],
      );
      refused++;
      continue;
    }
    await transaction.query(
      `update bakery.artifact_versions
          set publication_status = 'current', settled_at = now()
        where organization_id = $1 and id = $2`,
      [input.organizationId, row.id],
    );
    // The pointer only moves forward: a newer revision that was promoted first
    // stays current, and this one is still listed as a version of the artifact.
    const moved = await transaction.query(
      `update bakery.artifacts a
          set current_version_id = $3, updated_at = now(),
              version = a.version + 1
        where a.organization_id = $1 and a.id = $2
          and (a.current_version_id is null or (
            select current.revision from bakery.artifact_versions current
             where current.organization_id = a.organization_id
               and current.id = a.current_version_id) < $4)`,
      [input.organizationId, row.artifact_id, row.id, row.revision],
    );
    if ((moved.rowCount ?? 0) === 1) {
      await reconcileCoordinationForCommittedOutput(transaction, {
        organizationId: input.organizationId,
        taskId: row.task_id,
        artifactName: row.name,
        artifactType: row.artifact_type,
        traceId: crypto.randomUUID(),
      });
    }
    promoted++;
  }
  return { promoted, refused };
}
