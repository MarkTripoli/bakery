import type { PgTransactionClient } from "@bakery/persistence";
import { unprocessable } from "@bakery/contracts/http";

/**
 * The key an input value uses to declare a pinned artifact version.
 *
 * A run's declared inputs are free JSON, so the one structural fact this module
 * fixes is how an input names a version. Keeping it a single well-known key
 * means the pin is a value in the run's own inputs rather than a second place
 * a caller has to remember to update.
 */
export const DECLARED_ARTIFACT_VERSION_KEY = "artifactVersionId";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every artifact version id the input tree declares, in first-seen order and
 * without duplicates.
 *
 * A version named twice is pinned once: the pin is keyed by the run and the
 * version, so repetition carries no extra meaning and a duplicate insert would
 * only be noise.
 */
export function declaredArtifactVersionIds(inputs: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (
      const [key, child] of Object.entries(value as Record<string, unknown>)
    ) {
      if (key === DECLARED_ARTIFACT_VERSION_KEY && typeof child === "string") {
        if (!seen.has(child)) {
          seen.add(child);
          ids.push(child);
        }
        continue;
      }
      walk(child);
    }
  };
  walk(inputs);
  return ids;
}

/**
 * Pins, at admission, the exact version each declared input resolved to.
 *
 * The pin carries the digest and size the bytes had at this moment, so a later
 * publication of the same path cannot change what the run reads. A declared
 * version that does not exist for this organization is refused here rather
 * than left to fail later as a hole in the context: a partial pin must not
 * produce a context with missing files.
 */
export async function pinDeclaredRunInputs(
  transaction: PgTransactionClient,
  options: {
    organizationId: string;
    runId: string;
    inputs: unknown;
  },
): Promise<void> {
  for (const versionId of declaredArtifactVersionIds(options.inputs)) {
    if (!UUID_PATTERN.test(versionId)) {
      throw unprocessable(
        ["inputs"],
        "input_artifact_version_invalid",
      );
    }
    const version = await transaction.query<
      {
        id: string;
        artifact_id: string;
        sha256: string;
        size_bytes: number;
      }
    >(
      `select id, artifact_id, sha256, size_bytes
         from bakery.artifact_versions
        where organization_id = $1 and id = $2::uuid`,
      [options.organizationId, versionId],
    );
    const row = version.rows[0];
    if (!row) {
      throw unprocessable(["inputs"], "input_artifact_unavailable");
    }
    await transaction.query(
      `insert into bakery.run_input_pins (
         organization_id, run_id, artifact_id, artifact_version_id,
         sha256, size_bytes
       ) values ($1, $2, $3, $4, $5, $6)
       on conflict (organization_id, run_id, artifact_version_id) do nothing`,
      [
        options.organizationId,
        options.runId,
        row.artifact_id,
        row.id,
        row.sha256,
        row.size_bytes,
      ],
    );
  }
}

export type RunInputPin = {
  artifactVersionId: string;
  artifactId: string;
  sha256: string;
  sizeBytes: number;
};

/** The pins recorded for a run, ordered as they were created. */
export async function readRunInputPins(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<RunInputPin[]> {
  const result = await transaction.query<
    {
      artifact_version_id: string;
      artifact_id: string;
      sha256: string;
      size_bytes: number;
    }
  >(
    `select artifact_version_id, artifact_id, sha256, size_bytes
       from bakery.run_input_pins
      where organization_id = $1 and run_id = $2
      order by created_at asc, id asc`,
    [organizationId, runId],
  );
  return result.rows.map((row) => ({
    artifactVersionId: row.artifact_version_id,
    artifactId: row.artifact_id,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
  }));
}
