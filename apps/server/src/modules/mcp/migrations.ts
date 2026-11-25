import {
  MigrationOwner,
  type MigrationSource,
} from "../../platform/migrate.ts";
import { sessionToolEffectiveNameBackfill } from "./migrations/data/0369_session_tool_effective_names.ts";

export const mcpBakeryMigrationSource: MigrationSource = {
  owner: MigrationOwner.Bakery,
  root: new URL("./migrations/bakery/", import.meta.url),
};

export const mcpDataMigrations = Object.freeze([
  sessionToolEffectiveNameBackfill,
]);
