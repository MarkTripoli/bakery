import type { PgTransactionClient } from "@bakery/persistence";
import { StandardError } from "@bakery/contracts/http";
import {
  type ArtifactKindDefinition,
  type ArtifactKindDocument,
  type ArtifactKindFinding,
  refusesArtifactKindPublication,
  validateArtifactKindDocument,
} from "@bakery/contracts/artifact-kinds";

/**
 * The gate that makes a kind's rules real.
 *
 * `validateArtifactKindDocument` was written, tested and called by nobody: the
 * rules existed as a function the publication path never reached, so "validation
 * at publication" (chapter 25 section 6, O6) held only in the design. This
 * module is the door it was missing, and it answers the question the function
 * needs - which kind governs this artifact - from the artifact itself.
 *
 * The binding is by key: an artifact's `artifact_type` is the kind key the
 * organization published a kind under. That is the convention the storage tree
 * already uses (artifacts are grouped by work item, then name), and taking it
 * from the artifact's identity means a publisher cannot choose its own judge:
 * the same document name cannot be validated against a weaker kind on the next
 * revision.
 *
 * Three deliberate properties:
 *
 * - An artifact whose key names no kind is not validated. There is nothing to
 *   validate against, and refusing would break every existing workflow for a
 *   standard nobody declared.
 * - The binding is pinned at first publication and never moves. A published
 *   kind version is immutable, and re-resolving to the newest revision on every
 *   revision would let a kind's author retroactively change what an existing
 *   document must be.
 * - A refused publication throws and writes nothing, so a version cannot exist
 *   that a `require` rule refused.
 */

/** The kind version an artifact's documents are validated against. */
export type ArtifactKindBinding = Readonly<{
  kindVersionId: string;
  kindKey: string;
  revision: number;
  definition: ArtifactKindDefinition;
}>;

/**
 * Reads the organization's kind whose key matches this artifact type, newest
 * revision first, or null when the organization published no such kind.
 *
 * The artifact's existing binding wins when there is one: a bound artifact keeps
 * the revision it was first published under even after the kind gains a newer
 * one, which is what "a pinned kind version" has to mean for the version history
 * to stay readable.
 */
export async function resolveArtifactKindBinding(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    artifactType: string;
    boundKindVersionId: string | null;
  }>,
): Promise<ArtifactKindBinding | null> {
  if (input.boundKindVersionId !== null) {
    const bound = await transaction.query<
      {
        kindVersionId: string;
        kindKey: string;
        revision: number;
        definition: unknown;
      }
    >(
      `select version.id as "kindVersionId", kind.key as "kindKey",
              version.revision, version.definition
         from bakery.artifact_kind_versions version
         join bakery.artifact_kinds kind
           on kind.organization_id = version.organization_id
          and kind.id = version.kind_id
        where version.organization_id = $1 and version.id = $2`,
      [input.organizationId, input.boundKindVersionId],
    );
    const row = bound.rows[0];
    // A bound version that cannot be read is a broken binding, not "no kind":
    // skipping validation would silently unpin an artifact whose rules were
    // being enforced.
    if (!row) throw new StandardError({ code: "INTERNAL" });
    return {
      kindVersionId: row.kindVersionId,
      kindKey: row.kindKey,
      revision: row.revision,
      definition: row.definition as ArtifactKindDefinition,
    };
  }
  const latest = await transaction.query<
    {
      kindVersionId: string;
      kindKey: string;
      revision: number;
      definition: unknown;
    }
  >(
    `select version.id as "kindVersionId", kind.key as "kindKey",
            version.revision, version.definition
       from bakery.artifact_kinds kind
       join bakery.artifact_kind_versions version
         on version.organization_id = kind.organization_id
        and version.kind_id = kind.id
      where kind.organization_id = $1 and kind.key = $2
      order by version.revision desc
      limit 1`,
    [input.organizationId, input.artifactType],
  );
  const row = latest.rows[0];
  if (!row) return null;
  return {
    kindVersionId: row.kindVersionId,
    kindKey: row.kindKey,
    revision: row.revision,
    definition: row.definition as ArtifactKindDefinition,
  };
}

/**
 * Runs a binding's rules over one document.
 *
 * The bytes validated are the bytes about to be stored, so a blob-backed
 * version and an inline one are judged identically: the digest check has already
 * proved these are the bytes the version claims, and validating a copy read back
 * from the store would only be able to disagree by being stale.
 *
 * A `require` finding refuses the publication with a typed error naming the rule
 * that refused, because "your document is not acceptable" without the rule is a
 * message nobody can act on. A `warn` finding is returned for the caller to
 * record, and a document that satisfied everything returns an empty list.
 */
export function gateArtifactPublication(
  binding: ArtifactKindBinding,
  document: ArtifactKindDocument,
): readonly ArtifactKindFinding[] {
  const findings = validateArtifactKindDocument(binding.definition, document);
  if (!refusesArtifactKindPublication(findings)) return findings;
  const refusing = findings.find((finding) => finding.severity === "require");
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: {
      field: "content",
      reason: "kind_rule_refused",
      kind: binding.kindKey,
      revision: binding.revision,
      rule: refusing?.ruleType ?? "unknown",
      detail: refusing?.path ?? "content",
      // `unavailable` is reported separately because "we could not check" is a
      // different refusal from "we checked and it failed", and a publisher
      // chasing a binary document under a text rule needs to know which.
      unavailable: refusing?.unavailable === true ? "true" : "false",
    },
  });
}
