import { readRuntimeConfig } from "@bakery/config";
import { createSkillObjectStore } from "../modules/catalog/storage-backend.ts";
import {
  type ProbeRunnerResult,
  readArtifactVersionProbeSubjectBytes,
  readBlobProbeSubjectBytes,
  readInlineProbeSubjectBytes,
  runProbeTick,
} from "../modules/knowledge/probe-runner.ts";
import { closePgDatabase, openPgDatabase } from "./database.ts";

/**
 * The bakery-server "probe-runner" task: asks the sandbox what a version's bytes
 * are, so a reader can show facts instead of a name (#437 slice 4).
 *
 * tasks.ts passes DATABASE_URL, and the task runs as the database owner because
 * it writes probe answers and clears requests. It is a periodic task rather than
 * an event consumer because the sandbox must be local: the probe needs this
 * host's systemd user bus and a spool directory, which an event worker elsewhere
 * cannot offer.
 *
 * The backfill walks from the oldest unprobed subject every tick rather than
 * remembering a cursor. That is deliberate and it is cheap in the only state that
 * matters: once everything has been asked about, the "not exists" predicate makes
 * the page empty, and the cost is one index scan rather than a second table whose
 * cursor could be wrong in a way nobody notices.
 */
export async function runProbeRunnerTask(
  ownerDatabaseUrl: string,
): Promise<ProbeRunnerResult> {
  const database = openPgDatabase(ownerDatabaseUrl, 1);
  try {
    const config = readRuntimeConfig();
    const store = createSkillObjectStore(database, {
      filesystemRoot: config.skillFileRoot?.root,
      secretsKey: config.secretsKey,
      allowLoopbackEndpoint: config.environment === "test",
    });
    return await runProbeTick(database, {
      readBlobBytes: (organizationId, blobId) =>
        readBlobProbeSubjectBytes(database, store, organizationId, blobId),
      readInlineBytes: (organizationId, entryId, revision) =>
        readInlineProbeSubjectBytes(
          database,
          organizationId,
          entryId,
          revision,
        ),
      readArtifactVersionBytes: (organizationId, artifactVersionId) =>
        readArtifactVersionProbeSubjectBytes(
          database,
          organizationId,
          artifactVersionId,
        ),
    });
  } finally {
    await closePgDatabase(database);
  }
}
