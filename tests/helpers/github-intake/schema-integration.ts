import { assert, assertEquals } from "@std/assert";
import { withFixture } from "./receipts-shared.ts";

/**
 * Issue 71 schema: the structure migration 0143 leaves behind that the
 * TypeScript lifecycles lean on, read back from the catalog of a migrated
 * database.
 */

/** The new tables whose rows follow their connection to a new installation. */
const CASCADING_TABLES = [
  "inbound_event_routes",
  "integration_remote_facts",
  "integration_sync_checkpoints",
] as const;

type CascadingKey = { table: string; name: string; columns: string[] };
type IndexRow = {
  table: string;
  name: string;
  method: string;
  valid: boolean;
  partial: boolean;
  expression: boolean;
  columns: string[];
};

Deno.test("issue 71 schema: every ON UPDATE CASCADE key of the new tables has a plain btree index that starts with its columns", async () => {
  await withFixture(async (f) => {
    // The keys: a same-account reconnect updates integration_connections and
    // the database follows every one of these to the referencing rows.
    const keys = (await f.pgDatabase.query<CascadingKey>(
      `select tbl.relname as "table", con.conname as name,
              array(select att.attname::text
                      from unnest(con.conkey) with ordinality as k(attnum, ord)
                      join pg_attribute as att
                        on att.attrelid = con.conrelid and att.attnum = k.attnum
                     order by k.ord) as columns
         from pg_constraint as con
         join pg_class as tbl on tbl.oid = con.conrelid
         join pg_namespace as ns on ns.oid = tbl.relnamespace
        where ns.nspname = 'bakery' and con.contype = 'f'
          and con.confupdtype = 'c' and tbl.relname = any($1::text[])
        order by tbl.relname, con.conname`,
      [CASCADING_TABLES],
    )).rows;
    assertEquals(
      keys.map(({ table, columns }) => [table, columns.join(",")]),
      CASCADING_TABLES.map((table) => [table, "connection_id,installation_id"]),
      "each new table has exactly one cascading key, on (connection_id, installation_id)",
    );

    const indexes = (await f.pgDatabase.query<IndexRow>(
      `select tbl.relname as "table", idx.relname as name, am.amname as method,
              ix.indisvalid as valid, ix.indpred is not null as partial,
              ix.indexprs is not null as expression,
              array(select att.attname::text
                      from unnest(ix.indkey::smallint[])
                        with ordinality as k(attnum, ord)
                      join pg_attribute as att
                        on att.attrelid = ix.indrelid and att.attnum = k.attnum
                     where k.attnum > 0
                     order by k.ord) as columns
         from pg_index as ix
         join pg_class as tbl on tbl.oid = ix.indrelid
         join pg_class as idx on idx.oid = ix.indexrelid
         join pg_am as am on am.oid = idx.relam
         join pg_namespace as ns on ns.oid = tbl.relnamespace
        where ns.nspname = 'bakery' and tbl.relname = any($1::text[])
        order by tbl.relname, idx.relname`,
      [CASCADING_TABLES],
    )).rows;
    for (const key of keys) {
      const backing = indexes.filter((index) =>
        index.table === key.table && index.method === "btree" &&
        index.valid && !index.partial && !index.expression &&
        index.columns.slice(0, key.columns.length).join(",") ===
          key.columns.join(",")
      );
      assert(
        backing.length >= 1,
        `${key.table}: the key ${key.name} on (${
          key.columns.join(", ")
        }) has no valid, plain btree index starting with its columns`,
      );
    }
    assertEquals(
      indexes.filter((index) =>
        index.columns.join(",") === "connection_id,installation_id"
      ).map(({ name }) => name),
      [
        "inbound_event_routes_installation_idx",
        "integration_remote_facts_installation_idx",
        "integration_sync_checkpoints_installation_idx",
      ],
      "the migration names one index per table, as 0135 did for integration_resources",
    );
  });
});
