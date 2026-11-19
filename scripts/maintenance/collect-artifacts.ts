import {
  readArtifactStorageConfig,
  readDatabaseConfig,
  readSecretsKeyConfig,
  readSkillFileRootConfig,
} from "@bakery/config";
import { closePgDatabase, openPgDatabase } from "@bakery/persistence";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import { createSkillObjectStore } from "../../apps/server/src/modules/catalog/storage-backend.ts";
import { sweepCollectablePluginBundles } from "../../apps/server/src/modules/catalog/retention/sweep-bundles.ts";

if (import.meta.main) {
  const config = readArtifactStorageConfig();
  if (!config.collectionEnabled) {
    console.log("Artifact collection disabled.");
  } else {
    // Two subjects, one sweep: an artifact version by id, or every plugin
    // bundle that has become collectable. Plugin bundles live in the skill
    // object store rather than the artifact store, so this script owns both
    // because it is the maintenance entry point, not because they share bytes.
    const command = Deno.args[0];
    const env = Deno.env.toObject();
    const database = openPgDatabase(
      readDatabaseConfig(env, "owner").url,
      1,
    );
    try {
      if (command === "plugins") {
        const store = createSkillObjectStore(database, {
          filesystemRoot: readSkillFileRootConfig(env.BAKERY_SKILL_FILE_ROOT)
            ?.root,
          secretsKey: readSecretsKeyConfig(env),
          allowLoopbackEndpoint: env.BAKERY_ENV === "test",
        });
        if (!store) throw new Error("SKILL_FILE_ROOT_REQUIRED");
        console.log(
          JSON.stringify(await sweepCollectablePluginBundles(database, store)),
        );
      } else {
        // Backwards compatible: one argument is an artifact version id.
        const versionId = command;
        if (!versionId || !/^[0-9a-f-]{36}$/i.test(versionId)) {
          throw new Error("ARTIFACT_VERSION_ID_REQUIRED");
        }
        console.log(
          JSON.stringify({
            versionId,
            collected: await collectArtifactVersion(database, versionId),
          }),
        );
      }
    } finally {
      await closePgDatabase(database);
    }
  }
}
