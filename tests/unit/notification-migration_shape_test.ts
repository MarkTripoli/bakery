import { assert, assertEquals } from "@std/assert";

const migration = await Deno.readTextFile(
  new URL(
    "../../apps/server/src/modules/work/migrations/bakery/0172_notifications.sql",
    import.meta.url,
  ),
);

Deno.test("the notification dedupe key cannot be defeated by a null source", () => {
  // A unique index compares nulls as distinct, so a nullable source_event_id
  // would let one logical event insert two rows and show two badges. The column
  // is required for exactly that reason; this test fails if that is undone.
  assert(
    /source_event_id uuid not null/.test(migration),
    "source_event_id must be NOT NULL or the dedupe unique index does not dedupe",
  );
  assert(
    migration.includes("create unique index notifications_dedupe_unique"),
    "the dedupe unique index must exist",
  );
});

Deno.test("the notification rows are read by recipient, newest first, on one index", () => {
  // The inbox read and its cursor are only fast and stable when a matching
  // index exists; without it a keyset page falls back to a sort of the whole
  // inbox.
  assert(
    migration.includes(
      "on bakery.notifications (organization_id, recipient_id, created_at desc, id desc)",
    ),
    "the inbox index must match the newest-first keyset order",
  );
});

Deno.test("mark-all-read can find unread rows without scanning the inbox", () => {
  assert(
    migration.includes("create index notifications_unread_idx") &&
      migration.includes("where read_at is null"),
    "the unread sweep needs a partial index on unread rows",
  );
});

Deno.test("business vocabulary lives in TypeScript, not in CHECK constraints", () => {
  // The repository's PostgreSQL boundary rail forbids CHECK constraints in new
  // migrations; the kind and target_kind vocabularies are owned by the contract
  // schemas and the target resolver.
  assertEquals(migration.includes("check ("), false);
});

Deno.test("the app role can read and insert notifications but only update read state", () => {
  assert(
    migration.includes(
      "grant select, insert on bakery.notifications to bakery_app",
    ),
    "the projection writer needs select and insert",
  );
  assert(
    migration.includes(
      "grant update (read_at, revision) on bakery.notifications to bakery_app",
    ),
    "only read_at and revision may be updated: the item identity never changes",
  );
  assertEquals(
    migration.includes("grant update on bakery.notifications"),
    false,
    "a table-wide update grant would let a reader rewrite the item identity",
  );
});
