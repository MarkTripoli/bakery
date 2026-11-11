import { readArtifactStorageConfig, readDatabaseConfig } from "@bakery/config";
import { closePgDatabase, openPgDatabase } from "@bakery/persistence";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";

if (import.meta.main) {
  const config = readArtifactStorageConfig();
  if (!config.collectionEnabled) {
    console.log("Artifact collection disabled.");
  } else {
    const versionId = Deno.args[0];
    if (!versionId || !/^[0-9a-f-]{36}$/i.test(versionId)) {
      throw new Error("ARTIFACT_VERSION_ID_REQUIRED");
    }
    const database = openPgDatabase(
      readDatabaseConfig(Deno.env.toObject(), "owner").url,
      1,
    );
    try {
      console.log(
        JSON.stringify({
          versionId,
          collected: await collectArtifactVersion(database, versionId),
        }),
      );
    } finally {
      await closePgDatabase(database);
    }
  }
}
