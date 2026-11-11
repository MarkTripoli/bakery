import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../packages/persistence/src/postgres.ts";
import {
  readSecretsKeyConfig,
  readSkillFileRootConfig,
} from "../../packages/config/src/env.ts";
import {
  isSkillStorageBackend,
  SkillStorageBackend,
} from "../../apps/server/src/modules/catalog/skill-storage-config.ts";
import {
  readSkillStorageSettings,
  setSkillStorageBackend,
} from "../../apps/server/src/modules/catalog/skill-storage-settings.ts";
import {
  openResolvedSkillStore,
  resolveSkillStorage,
} from "../../apps/server/src/modules/catalog/storage-backend.ts";
import {
  assertReferencedInventory,
  collectSkillInventory,
  copySkillInventory,
  SkillInventorySchema,
  verifySkillInventory,
  withSkillStoragePause,
} from "./skill-object-migration.ts";

const USAGE =
  "Usage: inventory manifest.json | copy|verify|switch filesystem|r2 manifest.json";

/**
 * Copy, verify and switch skill objects between the filesystem and the R2
 * bucket the installation administrator saved in the UI. The active backend
 * is the source; the target is named on the command line. All settings and
 * the encrypted credentials come from the database through DATABASE_URL (the
 * database owner) and the mounted secrets key; no storage credential is read
 * from the environment or from a file. `switch` writes the new backend to the
 * database only after the target inventory verified.
 */
async function main(): Promise<void> {
  const [command, ...rest] = Deno.args;
  if (
    command === undefined ||
    !["inventory", "copy", "verify", "switch"].includes(command)
  ) throw new Error(USAGE);
  const targetName = command === "inventory" ? undefined : rest[0];
  const manifestPath = command === "inventory" ? rest[0] : rest[1];
  if (
    !manifestPath ||
    (command !== "inventory" && !isSkillStorageBackend(targetName))
  ) throw new Error(USAGE);
  const env = Deno.env.toObject();
  const url = env.DATABASE_URL;
  if (!url) throw new Error("SKILL_STORAGE_OWNER_REQUIRED");
  const options = {
    filesystemRoot: readSkillFileRootConfig(env.BAKERY_SKILL_FILE_ROOT)?.root,
    secretsKey: readSecretsKeyConfig(env),
    allowLoopbackEndpoint: env.BAKERY_ENV === "test",
  };
  const database = openDatabase(url);
  const settingsDatabase = openPgDatabase(url, 2);
  const opened: Array<() => void> = [];
  const open = async (
    backend: SkillStorageBackend,
    settings: Awaited<
      ReturnType<typeof readSkillStorageSettings>
    >,
  ) => {
    const live = openResolvedSkillStore(
      await resolveSkillStorage(settingsDatabase, settings, options, backend),
    );
    opened.push(live.close);
    return live.store;
  };
  try {
    await withSkillStoragePause(database, async () => {
      const settings = await readSkillStorageSettings(settingsDatabase);
      const active = settings?.backend ?? SkillStorageBackend.Filesystem;
      if (command === "verify") {
        const inventory = SkillInventorySchema.parse(
          JSON.parse(await Deno.readTextFile(manifestPath)),
        );
        await assertReferencedInventory(database, inventory);
        await verifySkillInventory(
          await open(targetName as SkillStorageBackend, settings),
          inventory,
        );
        return;
      }
      const source = await open(active, settings);
      const inventory = await collectSkillInventory(source);
      await assertReferencedInventory(database, inventory);
      if (command === "inventory") {
        await Deno.writeTextFile(
          manifestPath,
          JSON.stringify(inventory, null, 2) + "\n",
          { mode: 0o600, createNew: true },
        );
        return;
      }
      if (targetName === active) {
        throw new Error("SKILL_STORAGE_TARGET_IS_ACTIVE");
      }
      const target = await open(targetName as SkillStorageBackend, settings);
      if (command === "copy") {
        await copySkillInventory(source, target, inventory);
      } else await verifySkillInventory(target, inventory);
      await Deno.writeTextFile(
        manifestPath,
        JSON.stringify(inventory, null, 2) + "\n",
        { mode: 0o600, createNew: true },
      );
      if (command === "switch") {
        if (settings === null) {
          throw new Error("SKILL_STORAGE_SETTINGS_REQUIRED");
        }
        await setSkillStorageBackend(
          settingsDatabase,
          settings.version,
          targetName as SkillStorageBackend,
          {
            previous: active,
            operator: env.BAKERY_OPERATOR || env.USER || env.LOGNAME ||
              "unknown",
          },
        );
      }
    });
  } finally {
    for (const close of opened) close();
    await closePgDatabase(settingsDatabase);
    await closeDatabase(database);
  }
  console.log(
    command === "switch"
      ? "Skill object switch verified and written to the database; restore application access, then restart writers."
      : "Skill object operation verified.",
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(
      "SKILL_STORAGE_OPERATION_FAILED: keep writers stopped; verify configuration, pause and inventory.",
    );
    Deno.exit(1);
  }
}
