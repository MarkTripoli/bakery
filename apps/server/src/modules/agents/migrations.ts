import {
  MigrationOwner,
  type MigrationSource,
} from "../../platform/migrate.ts";

export const agentsBakeryMigrationSource: MigrationSource = {
  owner: MigrationOwner.Bakery,
  root: new URL("./migrations/bakery/", import.meta.url),
};
