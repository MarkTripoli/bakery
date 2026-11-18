import { assert, assertEquals, assertMatch } from "@std/assert";

/**
 * Event export history and tenant pinning (issue #21).
 *
 * Two defects shipped in this migration's first draft and both were invisible
 * to a reading of the TypeScript around it, because both live in the database
 * contract:
 *
 * 1. The delivery foreign keys were ON DELETE CASCADE while `bakery_app` held
 *    DELETE on the parents. Postgres runs referential actions without checking
 *    the deleting role's privilege on the referencing table, so the missing
 *    DELETE grant on `integration_deliveries` was defeated by deleting a
 *    subscription. Reproduced on a real database: the delivery count went 1 to
 *    0 as `bakery_app`.
 * 2. The composite keys pinned organization only, so a subscription could pair
 *    its own connection with another connection's destination or source
 *    resource, and a delivery could name a destination that was not its
 *    subscription's.
 *
 * These assertions read the SQL rather than a live database, because they are
 * about the declared contract and must run without a Postgres. The behavioural
 * proof lives in `tests/integration/event-export-history-survives_test.ts`.
 */

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);

const migrationPath =
  "apps/server/src/modules/integrations/migrations/bakery/0185_event_export.sql";

/** Statements with comments stripped, so prose about CASCADE cannot satisfy a check. */
function statements(): readonly string[] {
  const sql = Deno.readTextFileSync(`${root}${migrationPath}`);
  const withoutComments = sql.replace(/--[^\n]*/g, "");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => statement.replace(/\s+/g, " "));
}

function statementContaining(fragment: string): string {
  const found = statements().find((statement) => statement.includes(fragment));
  assert(
    found !== undefined,
    `no statement in ${migrationPath} mentions ${fragment}`,
  );
  return found;
}

/** The column list of a named foreign key, lowercased and without spaces. */
function foreignKeyColumns(statement: string, constraint: string): string[] {
  assertMatch(statement, new RegExp(constraint));
  const match = new RegExp(
    `${constraint} foreign key \\(([^)]+)\\)`,
  ).exec(statement);
  assert(match !== null, `${constraint} must declare an explicit column list`);
  return match[1]!.split(",").map((column) => column.trim().toLowerCase());
}

Deno.test("a delivery is never deleted by deleting its subscription or destination", () => {
  const deliveries = statementContaining(
    "create table bakery.integration_deliveries",
  );

  for (
    const constraint of [
      "integration_deliveries_subscription_fk",
      "integration_deliveries_destination_fk",
    ]
  ) {
    const match = new RegExp(
      `${constraint} foreign key \\([^)]+\\) references [^(]+\\([^)]+\\)([^,)]*)`,
    ).exec(deliveries);
    assert(match !== null, `${constraint} must be declared`);
    const actions = match[1]!.trim().toLowerCase();
    assertEquals(
      actions,
      "on delete restrict",
      `${constraint} must be ON DELETE RESTRICT: CASCADE would let a role with ` +
        `DELETE on the parent erase delivery history without ever holding ` +
        `DELETE on integration_deliveries`,
    );
  }
});

Deno.test("a subscription cannot pair its connection with another connection's destination", () => {
  const subscriptions = statementContaining(
    "create table bakery.integration_event_subscriptions",
  );

  const destination = foreignKeyColumns(
    subscriptions,
    "integration_event_subscriptions_destination_fk",
  );
  assert(
    destination.includes("connection_id"),
    "the destination key must carry connection_id, or a subscription can " +
      "name another connection's destination",
  );

  const source = foreignKeyColumns(
    subscriptions,
    "integration_event_subscriptions_source_fk",
  );
  assert(
    source.includes("connection_id"),
    "the source key must carry connection_id, or a subscription can name " +
      "another connection's source resource",
  );
});

Deno.test("a delivery cannot name a destination other than its subscription's", () => {
  const deliveries = statementContaining(
    "create table bakery.integration_deliveries",
  );
  const columns = foreignKeyColumns(
    deliveries,
    "integration_deliveries_subscription_fk",
  );
  assert(
    columns.includes("destination_id"),
    "the subscription key must carry destination_id, or a delivery can " +
      "claim a destination its subscription never selected",
  );

  // Pinning destination_id inside the key is only meaningful when the
  // subscription itself is unique on that triple, otherwise the reference
  // cannot be declared at all.
  const subscriptions = statementContaining(
    "create table bakery.integration_event_subscriptions",
  );
  assert(
    /integration_event_subscriptions_destination_identity_unique unique \(organization_id, id, destination_id\)/
      .test(subscriptions),
    "integration_event_subscriptions must be unique on " +
      "(organization_id, id, destination_id) for the delivery key to reference it",
  );
});
