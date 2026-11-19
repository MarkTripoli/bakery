import {
  MigrationOwner,
  type MigrationSource,
} from "../../platform/migrate.ts";
import { storageEntriesBackfill } from "./migrations/data/0232_storage_entries.ts";

export const knowledgeBakeryMigrationSource: MigrationSource = {
  owner: MigrationOwner.Bakery,
  root: new URL("./migrations/bakery/", import.meta.url),
};

export const knowledgeDataMigrations = Object.freeze([storageEntriesBackfill]);
