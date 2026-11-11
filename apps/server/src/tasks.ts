import { bakeryDataMigrations } from "./data-migrations.ts";
import { parseSettingsCommand } from "./modules/auth/application/settings-command.ts";
import {
  readInstallationSettings,
  updateInstallationSettings,
} from "./modules/auth/adapters/installation-settings-postgres.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  createSuperuser,
  preserveProviderInvitationState,
  registerOAuthClient,
  writeProviderMigration,
} from "./modules/auth/index.ts";
import {
  EVENT_CLOCK_CONTRACT_VERSION,
  EVENT_CLOCK_DATA_BOUNDARY,
  EVENT_CLOCK_SCHEMA_BOUNDARY,
  workBakeryMigrationSource,
} from "./modules/work/migrations.ts";
import { agentsBakeryMigrationSource } from "./modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "./modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "./modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "./modules/delivery/migrations.ts";
import { projectsBakeryMigrationSource } from "./modules/projects/migrations.ts";
import { AuthErrorCode } from "./modules/auth/domain/errors.ts";
import {
  authEnvironmentNames,
  readAuthTaskEnvironment,
} from "./platform/auth-task-config.ts";
import {
  type DatabaseConfig,
  readDatabaseConfig,
  readEnvironmentSnapshot,
  readRuntimeConfig,
  readTestDatabaseResetOptions,
} from "@bakery/config";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
  withPgTransaction,
} from "./platform/database.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
  resetTestDatabase,
} from "./platform/migrate.ts";
import {
  hasPendingApplicationDatabaseDrain,
  migrateData,
  withApplicationDatabaseDrain,
} from "./platform/data-migrate.ts";

function readAuthTaskConfig(databaseConfig: DatabaseConfig) {
  const config = readRuntimeConfig(
    readAuthTaskEnvironment(
      readEnvironmentSnapshot(authEnvironmentNames),
      databaseConfig,
    ),
    "server",
  );
  const problems = [
    ...new Set([...config.missingConfig, ...config.invalidConfig]),
  ];
  if (!config.auth || problems.length > 0) {
    console.error(
      `bakery-server createsuperuser: AUTH_CONFIGURATION_INVALID:${
        problems.join(",")
      }`,
    );
    Deno.exit(78);
  }
  return config.auth;
}

function readPrompt(label: string): string {
  const value = prompt(label);
  if (value === null) throw new Error(AuthErrorCode.BootstrapCancelled);
  return value;
}

async function writeTerminal(value: string): Promise<void> {
  await Deno.stdout.write(new TextEncoder().encode(value));
}

async function readHidden(label: string): Promise<string> {
  await writeTerminal(label);
  const bytes: number[] = [];
  const byte = new Uint8Array(1);
  let raw = false;
  try {
    Deno.stdin.setRaw(true);
    raw = true;
    while (true) {
      const count = await Deno.stdin.read(byte);
      if (count === null || byte[0] === 3 || byte[0] === 4) {
        throw new Error(AuthErrorCode.BootstrapCancelled);
      }
      if (byte[0] === 10 || byte[0] === 13) {
        return new TextDecoder().decode(new Uint8Array(bytes));
      }
      if (byte[0] === 8 || byte[0] === 127) {
        let start = bytes.length - 1;
        while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
        if (start >= 0) bytes.splice(start);
      } else if (byte[0] >= 32) {
        bytes.push(byte[0]);
      }
    }
  } finally {
    if (raw) Deno.stdin.setRaw(false);
    await writeTerminal("\n");
  }
}

function bootstrapErrorCode(error: unknown): string {
  return error instanceof Error &&
      /^AUTH_BOOTSTRAP_[A-Z_]+$/.test(error.message)
    ? error.message
    : AuthErrorCode.BootstrapFailed;
}

/** `--name`, repeatable `--redirect-uri` and `--scopes` for `register-oauth-client`; each takes `--flag value` or `--flag=value`. */
function parseFlags(args: readonly string[]) {
  const flags: { name?: string; scopes?: string; redirectUris: string[] } = {
    redirectUris: [],
  };
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split(/=(.*)/s, 2);
    const value = inline ?? args[++index];
    if (value === undefined) {
      throw new Error(`OAUTH_CLIENT_FLAG_VALUE_REQUIRED:${flag}`);
    }
    if (flag === "--name") flags.name = value;
    else if (flag === "--scopes") flags.scopes = value;
    else if (flag === "--redirect-uri") flags.redirectUris.push(value);
    else throw new Error(`OAUTH_CLIENT_FLAG_UNKNOWN:${flag}`);
  }
  return flags;
}

const task = Deno.args[0];
const tasks = [
  "startup",
  "migrate",
  "auth:migrations:generate",
  "createsuperuser",
  "register-oauth-client",
  "settings",
  "reset",
];
if (!task || !tasks.includes(task)) {
  console.error(`Expected ${tasks.join(", ")}`);
  Deno.exit(2);
}

if (task === "createsuperuser" && !Deno.stdin.isTerminal()) {
  console.error(
    `bakery-server createsuperuser: ${AuthErrorCode.InteractiveStdinRequired}`,
  );
  Deno.exit(2);
}

const databaseConfig = readDatabaseConfig(
  readEnvironmentSnapshot(["DATABASE_URL"]),
  "owner",
);
const authConfig =
  task === "createsuperuser" || task === "register-oauth-client"
    ? readAuthTaskConfig(databaseConfig)
    : undefined;

if (task === "auth:migrations:generate") {
  const pgDatabase = openPgDatabase(databaseConfig.url);
  try {
    await writeProviderMigration(pgDatabase);
  } finally {
    await closePgDatabase(pgDatabase);
  }
  Deno.exit(0);
}

const db = openDatabase(databaseConfig.url);
if (task === "reset") {
  try {
    await resetTestDatabase(
      db,
      {
        targetUrl: databaseConfig.url,
        ...readTestDatabaseResetOptions(),
      },
    );
  } finally {
    await closeDatabase(db);
  }
  Deno.exit(0);
}

const pgDatabase = openPgDatabase(databaseConfig.url);
try {
  const settingsCommand = task === "settings"
    ? parseSettingsCommand(Deno.args.slice(1))
    : undefined;
  const dataMigrations = bakeryDataMigrations;
  const providerMigrations = await loadMigrations(betterAuthMigrationSource);
  const bakeryMigrations = [
    ...await loadMigrations(bakeryPlatformMigrationSource),
    ...await loadMigrations(authBakeryMigrationSource),
    ...await loadMigrations(workBakeryMigrationSource),
    ...await loadMigrations(projectsBakeryMigrationSource),
    ...await loadMigrations(agentsBakeryMigrationSource),
    ...await loadMigrations(repositoryRulesBakeryMigrationSource),
    ...await loadMigrations(integrationsBakeryMigrationSource),
    ...await loadMigrations(deliveryBakeryMigrationSource),
  ];
  await migrateProvider(pgDatabase, providerMigrations, {
    beforeApply: preserveProviderInvitationState,
  });
  // Task migrations stay CONNECT-neutral. Only the drain owns revocation and
  // restoration, so a concurrent migrator cannot reopen a cutover in progress.
  await migrate(db, bakeryMigrations, {
    through: EVENT_CLOCK_SCHEMA_BOUNDARY,
    manageApplicationConnect: false,
  });
  const contractRows = await db<{ applied: boolean }[]>`
    select exists (
      select 1 from bakery.schema_migrations
      where version = ${EVENT_CLOCK_CONTRACT_VERSION}
    ) as applied
  `;
  const pendingDrain = await hasPendingApplicationDatabaseDrain(db);
  if (contractRows[0]?.applied && !pendingDrain) {
    await migrateData(db, dataMigrations, {
      through: EVENT_CLOCK_DATA_BOUNDARY,
      untilComplete: true,
    });
    await migrate(db, bakeryMigrations, {
      manageApplicationConnect: false,
    });
    await migrateData(db, dataMigrations, { untilComplete: true });
  } else {
    await withApplicationDatabaseDrain(db, async () => {
      await migrateData(db, dataMigrations, {
        through: EVENT_CLOCK_DATA_BOUNDARY,
        untilComplete: true,
      });
      await migrate(db, bakeryMigrations, {
        manageApplicationConnect: false,
      });
      await migrateData(db, dataMigrations, { untilComplete: true });
    });
  }
  if (settingsCommand) {
    const settings = settingsCommand.operation === "get"
      ? await readInstallationSettings(pgDatabase)
      : await withPgTransaction(
        pgDatabase,
        (transaction) =>
          updateInstallationSettings(
            transaction,
            settingsCommand.input,
            settingsCommand.expectedVersion,
            null,
          ),
      );
    console.log(JSON.stringify(settings));
  }
  if (task === "register-oauth-client") {
    const flags = parseFlags(Deno.args.slice(1));
    // Only the client id is printed: it is public, and nothing else is a secret to leak.
    console.log(
      await registerOAuthClient(
        { pgDatabase, config: authConfig! },
        {
          name: flags.name ?? "",
          redirectUris: flags.redirectUris,
          scopes: (flags.scopes ?? "").split(/[ ,]+/).filter(Boolean),
        },
      ),
    );
  }
  if (task === "createsuperuser") {
    const email = readPrompt("Email:");
    const displayName = readPrompt("Display name:");
    const password = await readHidden("Password: ");
    const confirmation = await readHidden("Password (again): ");
    if (password !== confirmation) {
      throw new Error(AuthErrorCode.BootstrapPasswordMismatch);
    }
    const result = await createSuperuser(
      { pgDatabase, config: authConfig! },
      { email, displayName, password },
    );
    console.log(
      result.status === "already-complete"
        ? "Superuser bootstrap already complete."
        : "Superuser bootstrap complete.",
    );
  }
} catch (error) {
  if (task === "settings") {
    const code = error instanceof Error &&
        /^INSTALLATION_SETTINGS_[A-Z_]+$/.test(error.message)
      ? error.message
      : "INSTALLATION_SETTINGS_COMMAND_FAILED";
    console.error(`bakery-server settings: ${code}`);
    Deno.exitCode = 1;
  } else if (task === "register-oauth-client") {
    console.error(
      `bakery-server register-oauth-client: ${
        error instanceof Error && /^OAUTH_CLIENT_[A-Z_]+/.test(error.message)
          ? error.message
          : "OAUTH_CLIENT_REGISTRATION_FAILED"
      }`,
    );
    Deno.exitCode = 1;
  } else {
    if (task !== "createsuperuser") throw error;
    console.error(
      `bakery-server createsuperuser: ${bootstrapErrorCode(error)}`,
    );
    Deno.exitCode = 1;
  }
} finally {
  await Promise.all([closePgDatabase(pgDatabase), closeDatabase(db)]);
}
