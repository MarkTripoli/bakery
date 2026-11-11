import { assertEquals } from "@std/assert";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { DatabaseSkillObjectStore } from "../../apps/server/src/modules/catalog/storage-backend.ts";
import { readSkillStorageSettings } from "../../apps/server/src/modules/catalog/skill-storage-settings.ts";
import {
  collectSkillInventory,
  verifySkillInventory,
} from "../../scripts/storage/skill-object-migration.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../packages/persistence/src/postgres.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import { call } from "./installation-settings.ts";
import {
  makeUpload,
  openPublicationTestContext,
} from "./local-skill-publication.ts";
import { cleanupAuthFixture } from "./auth.ts";
import { skillObjectStoreContract } from "./skill-object-store-contract.ts";
import { openSkillS3Fixture } from "./skill-s3-fixture.ts";
import {
  fixtureAccountId,
  pointStorage,
  storageBody,
  storagePath,
} from "./skill-storage-settings.ts";

/**
 * Drives the operator CLI against the database settings an administrator
 * saved: filesystem is active, the R2 bucket (an S3 fixture) is configured
 * with encrypted credentials, and no storage setting or credential travels
 * through the environment or a file. Inventory, copy and verify leave the
 * backend alone; switch writes r2 to the database only after verification.
 */
export async function proveSkillObjectMigrationCli(): Promise<void> {
  const s3 = await openSkillS3Fixture();
  const root = await Deno.makeTempDir();
  const sourceRoot = `${root}/source`;
  const keyFile = `${root}/secrets-key`;
  await Deno.writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const secretsKey = { file: keyFile, keyId: "migration-cli-key-v1" };
  let context: Awaited<ReturnType<typeof openPublicationTestContext>>;
  try {
    context = await openPublicationTestContext({
      root: sourceRoot,
      secretsKey,
    });
  } catch (error) {
    // Do not leave the S3 fixture running when the stack cannot open.
    await s3.close();
    await Deno.remove(root, { recursive: true });
    throw error;
  }
  const { databaseUrl } = readTestDatabaseConfig();
  let closed = false;
  try {
    const source = new SkillFileStore(sourceRoot);
    const skill = await context.createSkill();
    const upload = await makeUpload([{
      path: "SKILL.md",
      content: new TextEncoder().encode("# CLI migration\n"),
    }]);
    assertEquals((await context.publish(skill.id, upload)).status, 201);
    await skillObjectStoreContract(
      source,
      (key, bytes) => Deno.writeFile(`${sourceRoot}/${key}`, bytes),
    );
    const saved = await call(
      context.fixture,
      "PUT",
      storagePath,
      context.cookie,
      {
        body: storageBody({ bucket: s3.bucket }),
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    );
    assertEquals(saved.status, 200, await saved.clone().text());
    assertEquals((await saved.json()).backend, "filesystem");
    await pointStorage(context.fixture, { endpoint: s3.endpoint });
    await context.close(false);
    closed = true;

    const run = async (...args: string[]) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-env",
          "--allow-net",
          "--allow-read",
          `--allow-write=${root}`,
          "--allow-sys=uid,osRelease",
          "scripts/storage/skill-objects.ts",
          ...args,
        ],
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "",
          HOME: Deno.env.get("HOME") ?? "",
          DENO_DIR: Deno.env.get("DENO_DIR") ?? "",
          DATABASE_URL: databaseUrl,
          BAKERY_ENV: "test",
          BAKERY_OPERATOR: "cli-switch-operator",
          BAKERY_SKILL_FILE_ROOT: sourceRoot,
          BAKERY_SECRETS_KEY_FILE: secretsKey.file,
          BAKERY_SECRETS_KEY_ID: secretsKey.keyId,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: result.code,
        stderr: new TextDecoder().decode(result.stderr),
      };
    };
    const ok = async (...args: string[]) => {
      const result = await run(...args);
      assertEquals(result.code, 0, result.stderr);
    };
    await ok("inventory", `${root}/before.json`);
    await ok("copy", "r2", `${root}/copied.json`);
    await ok("verify", "r2", `${root}/copied.json`);
    const owner = openPgDatabase(databaseUrl, 2);
    try {
      assertEquals(
        (await readSkillStorageSettings(owner))?.backend,
        "filesystem",
      );
      // The target is already the source: nothing to switch, nothing written.
      assertEquals(
        (await run("switch", "filesystem", `${root}/noop.json`)).code,
        1,
      );
      const updatedBy = async () =>
        (await owner.query<{ updated_by: string | null }>(
          "select updated_by from bakery.skill_storage_settings",
        )).rows[0].updated_by;
      const since = (await owner.query<{ now: Date }>(
        "select clock_timestamp() as now",
      )).rows[0].now;
      // The administrator's save is the last writer until the switch.
      assertEquals((await updatedBy()) === null, false);
      const beforeSwitch = await readSkillStorageSettings(owner);
      await ok("switch", "r2", `${root}/switched.json`);
      assertEquals(
        await Deno.readTextFile(`${root}/before.json`),
        await Deno.readTextFile(`${root}/switched.json`),
      );
      const active = await readSkillStorageSettings(owner);
      assertEquals(active?.backend, "r2");
      // The switch is attributed truthfully: no administrator is named, and
      // one audit row records the operator, both backends and the version.
      assertEquals(await updatedBy(), null);
      const audits = await owner.query<{
        principal_id: string | null;
        details: Record<string, unknown>;
      }>(
        `select principal_id, details from bakery.audit_events
          where operation = 'skillStorageSettings.switch' and created_at >= $1`,
        [since],
      );
      assertEquals(audits.rows.length, 1);
      assertEquals(audits.rows[0].principal_id, null);
      assertEquals(audits.rows[0].details.operator, "cli-switch-operator");
      assertEquals(audits.rows[0].details.from, "filesystem");
      assertEquals(audits.rows[0].details.backend, "r2");
      assertEquals(audits.rows[0].details.version, active?.version);
      assertEquals(active?.version, (beforeSwitch?.version ?? 0) + 1);
      // A stopped writer that restarts (or a running one) resolves r2 from the
      // database alone; the same objects verify through the S3 target.
      const facade = new DatabaseSkillObjectStore(owner, {
        filesystemRoot: sourceRoot,
        secretsKey,
        allowLoopbackEndpoint: true,
      });
      try {
        await verifySkillInventory(
          facade,
          await collectSkillInventory(source),
        );
        assertEquals(
          (await collectSkillInventory(facade)).length,
          (await collectSkillInventory(source)).length,
        );
      } finally {
        facade.close();
      }
      // The credentials never left the encrypted row.
      assertEquals(fixtureAccountId, active?.accountId);
    } finally {
      await closePgDatabase(owner);
    }
  } finally {
    try {
      if (!closed) await context.close(false);
    } finally {
      try {
        const cleanup = openPgDatabase(databaseUrl, 2);
        try {
          await cleanupAuthFixture(cleanup, [context.identity.email]);
        } finally {
          await closePgDatabase(cleanup);
        }
      } finally {
        try {
          await s3.close();
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      }
    }
  }
}
