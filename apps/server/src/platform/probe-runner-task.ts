import { readRuntimeConfig, type RuntimeConfig } from "@bakery/config";
import { createSkillObjectStore } from "../modules/catalog/storage-backend.ts";
import { ScopedOrganizationBlobStore } from "../modules/catalog/blob-store.ts";
import {
  type ProbeRunnerDeps,
  type ProbeRunnerResult,
  readArtifactVersionProbeSubjectBytes,
  readBlobProbeSubjectBytes,
  readInlineProbeSubjectBytes,
  runProbeTick,
} from "../modules/knowledge/probe-runner.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "./database.ts";

/**
 * The bakery-server "probe-runner" task: asks the sandbox what a version's bytes
 * are, so a reader can show facts instead of a name (#437 slice 4).
 *
 * tasks.ts passes DATABASE_URL, and the task runs as the database owner because it
 * writes probe answers and clears requests. It is a periodic task rather than an
 * event consumer because the sandbox must be local: the probe needs this host's
 * systemd user bus and a spool directory, which an event worker elsewhere cannot
 * offer.
 *
 * The dependencies are built by `probeRunnerDeps`, in one place, so the test that
 * proves a tick answers is the test that proves this wiring. A runner assembled
 * twice is a runner whose second assembly can quietly omit the spool directory and
 * then refuse every subject as "the host is unavailable".
 */
export async function runProbeRunnerTask(
  ownerDatabaseUrl: string,
): Promise<ProbeRunnerResult> {
  const database = openPgDatabase(ownerDatabaseUrl, 1);
  try {
    const config = readRuntimeConfig();
    const result = await runProbeTick(
      database,
      probeRunnerDeps(config, database),
    );
    if (result.spoolDirMissing) {
      // Said out loud rather than left in a JSON field nobody reads: a runner with
      // no spool directory cannot answer anything, and silence would look exactly
      // like a workspace with nothing to ask about.
      console.error(
        "bakery-server probe-runner: BAKERY_PROBE_SPOOL_DIR is not set, so no " +
          "version can be spooled and no probe can run. Nothing was claimed and " +
          "no request was counted; set the variable and restart the service.",
      );
    }
    if (result.storeUnavailable) {
      // The same shape of message as the spool directory: a deployment that cannot
      // read a blob-backed subject would otherwise look like a workspace whose
      // files all vanished.
      console.error(
        "bakery-server probe-runner: no object store is configured, so a " +
          "blob-backed version cannot be read. Its request was left queued and " +
          "nothing was counted; configure the store and restart the service.",
      );
    }
    return result;
  } finally {
    await closePgDatabase(database);
  }
}

/**
 * Everything a tick needs, from the runtime config the entrypoint reads.
 *
 * Exported so a test can run a real tick over a real database with only the
 * launcher swapped for a stub: what is under test is that this function passes the
 * spool directory, the store and the subject readers at all.
 */
export function probeRunnerDeps(
  config: Pick<
    RuntimeConfig,
    "probeSpoolDir" | "skillFileRoot" | "secretsKey" | "environment"
  >,
  database: PgDatabase,
): ProbeRunnerDeps {
  const store = createSkillObjectStore(database, {
    filesystemRoot: config.skillFileRoot?.root,
    secretsKey: config.secretsKey,
    allowLoopbackEndpoint: config.environment === "test",
  });
  // The store is key-addressed; a blob subject is addressed by organization and
  // digest, so it goes through the scoped adapter. Handing the raw store here made
  // every blob subject throw inside the runner and be deferred for ever, which is
  // how a probe that works for inline bytes never worked for an uploaded one.
  const blobs = store === undefined
    ? undefined
    : new ScopedOrganizationBlobStore(store);
  return {
    readBlobBytes: (organizationId, blobId) =>
      readBlobProbeSubjectBytes(database, blobs, organizationId, blobId),
    readInlineBytes: (organizationId, entryId, revision) =>
      readInlineProbeSubjectBytes(database, organizationId, entryId, revision),
    readArtifactVersionBytes: (organizationId, artifactVersionId) =>
      readArtifactVersionProbeSubjectBytes(
        database,
        organizationId,
        artifactVersionId,
      ),
    // The spool directory is the part that is easy to lose and impossible to
    // notice: without it the probe refuses every subject before reading a byte.
    ...(config.probeSpoolDir === undefined
      ? {}
      : { probeOptions: { spoolDir: config.probeSpoolDir.root } }),
    log: (line) => console.error(line),
  };
}
