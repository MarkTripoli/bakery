import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";

const BATCH_SIZE = 100;

async function migrateBatch(
  connection: Parameters<DataMigration["run"]>[0],
  beforeCommit: (() => Promise<void>) | undefined,
): Promise<number> {
  return await runDataMigrationBatch(connection, async (transaction) => {
    const rows = await transaction<{ migrated: number }[]>`
      with batch as (
        select id, organization_id, sequence
        from bakery.domain_events
        where organization_sequence is null
        order by sequence
        for update
        limit ${BATCH_SIZE}
      ),
      starts as (
        select organizations.organization_id,
          coalesce(clock.next_seq, 1) as start_sequence
        from (
          select distinct organization_id from batch
        ) as organizations
        left join bakery.event_clock as clock
          on clock.organization_id = organizations.organization_id
         and clock.stream = 'domain_events'
      ),
      ranked as (
        select batch.id, batch.organization_id,
          starts.start_sequence + row_number() over (
            partition by batch.organization_id order by batch.sequence
          ) - 1 as organization_sequence
        from batch
        join starts using (organization_id)
      ),
      updated as (
        update bakery.domain_events as event
        set organization_sequence = ranked.organization_sequence
        from ranked
        where event.id = ranked.id
        returning event.organization_id, event.organization_sequence
      ),
      clocks as (
        select organization_id, max(organization_sequence) + 1 as next_seq
        from updated
        group by organization_id
      ),
      advanced as (
        insert into bakery.event_clock (
          organization_id, stream, next_seq
        )
        select organization_id, 'domain_events', next_seq
        from clocks
        on conflict (organization_id, stream) do update
          set next_seq = excluded.next_seq
        returning organization_id
      )
      select count(*)::integer as migrated from updated
    `;
    return rows[0]?.migrated ?? 0;
  }, beforeCommit);
}

export const eventClockSeed: DataMigration = {
  version: "0019_event_clock_seed",
  source: new URL(import.meta.url),
  async run(connection, options): Promise<boolean> {
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      const migrated = await migrateBatch(connection, options.beforeCommit);
      if (migrated < BATCH_SIZE) return true;
    }
    return false;
  },
};
