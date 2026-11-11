import { PutObjectCommand } from "@aws-sdk/client-s3";
import { S3SkillObjectStore } from "../../apps/server/src/modules/catalog/s3-store.ts";
import { createSkillS3Client } from "../../apps/server/src/modules/catalog/storage-backend.ts";
import { resolveSkillStorage } from "../../apps/server/src/modules/catalog/storage-backend.ts";
import { readSkillStorageSettings } from "../../apps/server/src/modules/catalog/skill-storage-settings.ts";
import {
  readSecretsKeyConfig,
  readTestDatabaseConfig,
} from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../packages/persistence/src/postgres.ts";
import { skillObjectStoreContract } from "../helpers/skill-object-store-contract.ts";

/**
 * Live R2 proof. The administrator enters the account, bucket and credentials
 * in the product UI; this lane reads them from the lane database's installation
 * settings and decrypts them with the mounted secrets key. Nothing comes from
 * an R2 variable or a credential file, and a loopback override never counts as
 * live proof. The lane still blocks (exit 78) without BAKERY_LANE_AUTHORIZED
 * and a prerequisite manifest.
 */
Deno.test("authorized live R2 obeys the immutable object contract", async () => {
  const env = Deno.env.toObject();
  const database = openPgDatabase(readTestDatabaseConfig(env).databaseUrl, 2);
  try {
    const settings = await readSkillStorageSettings(database);
    if (
      settings === null || settings.endpointOverride !== null ||
      settings.secretId === null
    ) throw new Error("LIVE_OBJECT_STORAGE_CONFIG_REQUIRED");
    const resolved = await resolveSkillStorage(database, settings, {
      secretsKey: readSecretsKeyConfig(env),
      allowLoopbackEndpoint: false,
    }, "r2");
    if (resolved.backend !== "r2") {
      throw new Error("LIVE_OBJECT_STORAGE_CONFIG_REQUIRED");
    }
    const client = createSkillS3Client(
      resolved.connection,
      resolved.credentials,
    );
    try {
      await skillObjectStoreContract(
        new S3SkillObjectStore(client, resolved.connection.bucket),
        async (key, bytes) => {
          await client.send(
            new PutObjectCommand({
              Bucket: resolved.connection.bucket,
              Key: key,
              Body: bytes,
            }),
          );
        },
      );
    } finally {
      client.destroy();
    }
  } finally {
    await closePgDatabase(database);
  }
});
