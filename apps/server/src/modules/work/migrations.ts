import {
  MigrationOwner,
  type MigrationSource,
} from "../../platform/migrate.ts";
import { outboxDispatchBackfill } from "./migrations/data/0015_outbox_dispatch_backfill.ts";
import { eventClockSeed } from "./migrations/data/0019_event_clock_seed.ts";
import { frozenExecutionContextBackfill } from "./migrations/data/0049_issue46_frozen_execution_context.ts";

import { artifactRetentionBackfill } from "./migrations/data/0074_artifact_retention.ts";

export const workBakeryMigrationSource: MigrationSource = {
  owner: MigrationOwner.Bakery,
  root: new URL("./migrations/bakery/", import.meta.url),
};
export const EVENT_CLOCK_SCHEMA_BOUNDARY = "0019_event_clock_indexes";
export const EVENT_CLOCK_CONTRACT_VERSION = "0020_event_clock_contract";
export const EVENT_CLOCK_DATA_BOUNDARY = eventClockSeed.version;

export const workDataMigrations = Object.freeze([
  outboxDispatchBackfill,
  artifactRetentionBackfill,
  eventClockSeed,
  frozenExecutionContextBackfill,
]);
