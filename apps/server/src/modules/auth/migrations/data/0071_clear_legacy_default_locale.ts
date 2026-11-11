import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";

const BATCH_SIZE = 1_000;
// Schema migration 0022 defaulted every organization to this value before the
// default became an explicit administrator choice.
const LEGACY_DEFAULT_LOCALE = "en";

async function clearBatch(
  connection: Parameters<DataMigration["run"]>[0],
): Promise<number> {
  return await runDataMigrationBatch(connection, async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      with batch as (
        select id from bakery.organizations
        where default_locale = ${LEGACY_DEFAULT_LOCALE}
        order by id
        for update
        limit ${BATCH_SIZE}
      )
      update bakery.organizations as organization
      set default_locale = null
      from batch
      where organization.id = batch.id
      returning organization.id
    `;
    return rows.length;
  });
}

/**
 * The default was never writable before schema migration 0071, so every stored
 * legacy value is the old column default rather than an administrator choice.
 * Clearing it lets the member's Accept-Language decide until an Admin sets one.
 * The data-migration ledger runs this once, so a later explicit choice is never
 * cleared; an interrupted run resumes on the rows still holding the default.
 */
export const clearLegacyDefaultLocale: DataMigration = {
  version: "0071_clear_legacy_default_locale",
  source: new URL(import.meta.url),
  async run(connection, options): Promise<boolean> {
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      if (await clearBatch(connection) === 0) return true;
    }
    return false;
  },
};
