import { assert, assertEquals, assertRejects } from "@std/assert";
import { openPgDatabase } from "../../apps/server/src/platform/database.ts";
import { openAuthFixture } from "../helpers/auth.ts";
import { deleteEventExportHistory } from "../../apps/server/src/modules/integrations/event-export-retention.ts";

/**
 * Event export history and tenant pinning, proved against a real database
 * (issue #21).
 *
 * The rail in `tests/rails/event-export-history-and-tenant-pinning_test.ts`
 * asserts the declared contract. This file proves the behaviour, because the
 * defect it guards against was a privilege bypass that only exists at runtime:
 * `bakery_app` held no DELETE on `integration_deliveries`, yet deleting a
 * subscription removed the delivery anyway, because Postgres performs
 * referential actions without checking the deleting role's privilege on the
 * referencing table.
 *
 * The writes that matter run as `bakery_app`, the role the application actually
 * uses, so a grant that looks right but is defeated by a cascade still fails.
 */

/**
 * Applies migrations before any test touches the database.
 *
 * This used to depend on whatever ran first: on a fresh database the suite failed
 * with "relation bakery.integration_deliveries does not exist", which means a
 * file that passes only because another file migrated first is not evidence. QA
 * found it by running the file alone on an empty PG16.
 *
 * `openAuthFixture` already applies every module's migrations plus data
 * migrations, so this reuses that path instead of a second one, and closes the
 * fixture immediately - only the schema is wanted here, not an app instance.
 */
let migrated: Promise<void> | undefined;
function ensureMigrated(): Promise<void> {
  migrated ??= (async () => {
    const fixture = await openAuthFixture();
    await fixture.close();
  })().catch((error) => {
    migrated = undefined;
    throw error;
  });
  return migrated;
}

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

type Db = ReturnType<typeof openPgDatabase>;

/** `pg` Pool, so statements are `$n` parameterised rather than tagged templates. */
async function q<T = Record<string, unknown>>(
  db: Db,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.query(text, values as unknown[]);
  return result.rows as T[];
}

const adminUrl = required("BAKERY_ADMIN_DATABASE_URL");
const appUrl = required("BAKERY_APP_DATABASE_URL");

const organizationId = crypto.randomUUID();
const principalId = crypto.randomUUID();
const secretId = crypto.randomUUID();
let registrationId: string = crypto.randomUUID();
let createdRegistration = false;
const installationId = crypto.randomUUID();
const otherInstallationId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
const otherConnectionId = crypto.randomUUID();
const resourceId = crypto.randomUUID();
const otherResourceId = crypto.randomUUID();
const destinationId = crypto.randomUUID();
const otherDestinationId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();

/** The parent chain the export tables require, written as the owner. */
async function seedParents(admin: Db): Promise<void> {
  await q(
    admin,
    "insert into bakery.organizations (id, name, slug, created_at, updated_at) values ($1, 'Event export probe', $2, now(), now())",
    [organizationId, `probe-${organizationId}`],
  );
  await q(
    admin,
    "insert into bakery.principals (id, display_name, principal_type) values ($1, 'Event export probe', 'service')",
    [principalId],
  );
  await q(
    admin,
    "insert into bakery.secrets (id, organization_id, name) values ($1, $2, 'Event export probe secret')",
    [secretId, organizationId],
  );
  // Exactly one GitHub registration may exist per deployment (UNIQUE
  // (provider)), so an existing one is reused rather than replaced: this test
  // must not disturb a registration other rows already point at.
  const existing = await q<{ id: string }>(
    admin,
    "select id from bakery.integration_app_registrations where provider = 'github' limit 1",
  );
  if (existing.length > 0) {
    registrationId = existing[0]!.id;
  } else {
    createdRegistration = true;
    await q(
      admin,
      `insert into bakery.integration_app_registrations (
         id, provider, external_app_id, slug, name, client_id, owner_login,
         owner_id, owner_type, html_url, permissions, events, client_secret_id,
         private_key_secret_id, status, registered_by, created_at, updated_at, version
       ) values (
         $1, 'github', $2, $3, 'Event export probe', 'Iv1.probe', 'probe', '1',
         'User', 'https://github.com/apps/probe', '{}', '{}', $4, $4, 'active',
         $5, now(), now(), 1
       )`,
      [
        registrationId,
        String(Math.floor(Math.random() * 1_000_000_000)),
        `probe-${registrationId}`,
        secretId,
        principalId,
      ],
    );
  }

  const runToken = crypto.randomUUID();
  for (
    const [installation, authorization, account] of [
      [installationId, `probe-a-${runToken}`, `probe-a-${runToken}`],
      [otherInstallationId, `probe-b-${runToken}`, `probe-b-${runToken}`],
    ] as const
  ) {
    await q(
      admin,
      `insert into bakery.integration_installations (
         id, provider, registration_id, external_authorization_id,
         external_account_id, account_login, account_type, repository_selection,
         granted_permissions, status, created_at, updated_at, version
       ) values (
         $1, 'github', $2, $3, $4, $5, 'User', 'all', '[]', 'active',
         now(), now(), 1
       )`,
      [
        installation,
        registrationId,
        authorization,
        account,
        `probe-${account}`,
      ],
    );
  }

  for (
    const [connection, installation, authorization, account] of [
      [
        connectionId,
        installationId,
        `probe-a-${runToken}`,
        `probe-a-${runToken}`,
      ],
      [
        otherConnectionId,
        otherInstallationId,
        `probe-b-${runToken}`,
        `probe-b-${runToken}`,
      ],
    ] as const
  ) {
    await q(
      admin,
      `insert into bakery.integration_connections (
         id, organization_id, provider, installation_id,
         external_authorization_id, external_account_id, label, adapter_version,
         granted_permissions, status, health, created_by, created_at, updated_at, version
       ) values (
         $1, $2, 'github', $3, $4, $5, $6, '1', '[]', 'active', 'healthy',
         $7, now(), now(), 1
       )`,
      [
        connection,
        organizationId,
        installation,
        authorization,
        account,
        `probe-${account}`,
        principalId,
      ],
    );
  }

  for (
    const [resource, connection, installation, external] of [
      [resourceId, connectionId, installationId, "1"],
      [otherResourceId, otherConnectionId, otherInstallationId, "2"],
    ] as const
  ) {
    await q(
      admin,
      `insert into bakery.integration_resources (
         id, organization_id, connection_id, installation_id, kind, external_id,
         display_name, last_discovery_generation, created_at, updated_at, version
       ) values ($1, $2, $3, $4, 'repository', $5, $6, 1, now(), now(), 1)`,
      [
        resource,
        organizationId,
        connection,
        installation,
        external,
        `repo-${external}`,
      ],
    );
  }

  for (
    const [destination, connection, installation, identity] of [
      [destinationId, connectionId, installationId, "probe-one"],
      [otherDestinationId, otherConnectionId, otherInstallationId, "probe-two"],
    ] as const
  ) {
    await q(
      admin,
      `insert into bakery.integration_destinations (
         id, organization_id, connection_id, installation_id, kind, origin,
         path, secret_version_id, recovery_identity, status, health,
         acknowledgement_state, created_at, updated_at, version
       ) values (
         $1, $2, $3, $4, 'https', 'https://example.test', $5, $6, $7,
         'active', 'healthy', 'pending', now(), now(), 1
       )`,
      [
        destination,
        organizationId,
        connection,
        installation,
        `/${identity}`,
        secretId,
        identity,
      ],
    );
  }
}

async function cleanup(admin: Db): Promise<void> {
  await q(
    admin,
    "delete from bakery.integration_deliveries where organization_id = $1",
    [
      organizationId,
    ],
  );
  await q(
    admin,
    "delete from bakery.integration_event_subscriptions where organization_id = $1",
    [organizationId],
  );
  await q(
    admin,
    "delete from bakery.integration_destinations where organization_id = $1",
    [
      organizationId,
    ],
  );
  await q(
    admin,
    "delete from bakery.integration_resources where organization_id = $1",
    [
      organizationId,
    ],
  );
  await q(
    admin,
    "delete from bakery.integration_connections where organization_id = $1",
    [
      organizationId,
    ],
  );
  await q(
    admin,
    "delete from bakery.integration_installations where id = any($1::uuid[])",
    [[installationId, otherInstallationId]],
  );
  if (createdRegistration) {
    await q(
      admin,
      "delete from bakery.integration_app_registrations where id = $1",
      [
        registrationId,
      ],
    );
  }
  await q(admin, "delete from bakery.secrets where id = $1", [secretId]);
  await q(admin, "delete from bakery.principals where id = $1", [principalId]);
  await q(admin, "delete from bakery.organizations where id = $1", [
    organizationId,
  ]);
}

const SUBSCRIPTION_INSERT =
  `insert into bakery.integration_event_subscriptions (
   id, organization_id, connection_id, installation_id, destination_id,
   source_resource_id, event_kinds, authorization_revision, status,
   created_at, updated_at, version
 ) values ($1, $2, $3, $4, $5, $6, '{issue.opened}', 1, 'active', now(), now(), 1)`;

const DELIVERY_INSERT = `insert into bakery.integration_deliveries (
   id, organization_id, subscription_id, destination_id, source_event_id,
   event_kind, attempt, delivery_identity, payload_digest, status,
   acknowledgement_state, created_at, updated_at, version
 ) values (
   $1, $2, $3, $4, $5, 'issue.opened', 1, $6, 'digest-1', 'prepared',
   'pending', now(), now(), 1
 )`;

Deno.test("deleting a subscription cannot erase delivery history", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  const deliveryId = crypto.randomUUID();
  try {
    await seedParents(admin);

    // Written as the application role, so the grants under test are the ones
    // that apply.
    await q(app, SUBSCRIPTION_INSERT, [
      subscriptionId,
      organizationId,
      connectionId,
      installationId,
      destinationId,
      resourceId,
    ]);
    await q(app, DELIVERY_INSERT, [
      deliveryId,
      organizationId,
      subscriptionId,
      destinationId,
      "evt-1",
      `identity-${deliveryId}`,
    ]);

    // The defect: this delete used to succeed and take the delivery with it.
    await assertRejects(
      () =>
        q(
          app,
          "delete from bakery.integration_event_subscriptions where id = $1",
          [
            subscriptionId,
          ],
        ),
      Error,
      "foreign key constraint",
    );

    const remaining = await q<{ count: number }>(
      app,
      "select count(*)::int as count from bakery.integration_deliveries where id = $1",
      [deliveryId],
    );
    assertEquals(
      remaining[0]!.count,
      1,
      "the delivery must survive an attempt to delete its subscription",
    );

    // The second door: the application role holds no DELETE here at all.
    await assertRejects(
      () =>
        q(app, "delete from bakery.integration_deliveries where id = $1", [
          deliveryId,
        ]),
      Error,
      "permission denied",
    );
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("a subscription cannot reach another connection's destination or source", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seedParents(admin);

    // Its own connection, another connection's destination.
    await assertRejects(
      () =>
        q(app, SUBSCRIPTION_INSERT, [
          crypto.randomUUID(),
          organizationId,
          connectionId,
          installationId,
          otherDestinationId,
          resourceId,
        ]),
      Error,
      "foreign key constraint",
    );

    // Its own connection, another connection's source resource.
    await assertRejects(
      () =>
        q(app, SUBSCRIPTION_INSERT, [
          crypto.randomUUID(),
          organizationId,
          connectionId,
          installationId,
          destinationId,
          otherResourceId,
        ]),
      Error,
      "foreign key constraint",
    );

    // The matching pair is accepted, so the refusals above are about the
    // mismatch and not about the insert being impossible.
    await q(app, SUBSCRIPTION_INSERT, [
      subscriptionId,
      organizationId,
      connectionId,
      installationId,
      destinationId,
      resourceId,
    ]);

    // A delivery may not claim a destination its subscription never selected.
    await assertRejects(
      () =>
        q(app, DELIVERY_INSERT, [
          crypto.randomUUID(),
          organizationId,
          subscriptionId,
          otherDestinationId,
          "evt-2",
          `identity-${crypto.randomUUID()}`,
        ]),
      Error,
      "foreign key constraint",
    );

    const accepted = await q<{ count: number }>(
      app,
      "select count(*)::int as count from bakery.integration_event_subscriptions where id = $1",
      [subscriptionId],
    );
    assert(
      accepted[0]!.count === 1,
      "the matching subscription must be stored",
    );
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("a connection with history is deleted only after its history is swept", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  const deliveryId = crypto.randomUUID();
  try {
    await seedParents(admin);
    await q(app, SUBSCRIPTION_INSERT, [
      subscriptionId,
      organizationId,
      connectionId,
      installationId,
      destinationId,
      resourceId,
    ]);
    await q(app, DELIVERY_INSERT, [
      deliveryId,
      organizationId,
      subscriptionId,
      destinationId,
      "evt-1",
      `identity-${deliveryId}`,
    ]);

    // RESTRICT is doing its job: the connection cannot be deleted while it owns
    // a delivery, and that failure is the property we want, not the bug.
    await assertRejects(
      () =>
        q(admin, "delete from bakery.integration_connections where id = $1", [
          connectionId,
        ]),
      Error,
      "foreign key constraint",
    );

    // The application role cannot sweep history, and that is the point: it holds
    // no DELETE on deliveries, so erasing what was sent is an administrative act
    // rather than something the serving path can do.
    await assertRejects(
      () =>
        deleteEventExportHistory(
          {
            // `rowCount` must come from pg: a DELETE without RETURNING yields
            // no rows, so counting rows would report zero for every statement.
            query: async (text, values) => {
              const result = await app.query(text, values as unknown[]);
              return { rowCount: result.rowCount };
            },
          },
          { organizationId, connectionId },
        ),
      Error,
      "permission denied",
    );

    // The named sweep removes history first, in the documented order, as the
    // administrative role, after which the connection can be deleted. Without
    // this the RESTRICT keys would make a connection with history permanently
    // undeletable.
    const swept = await deleteEventExportHistory(
      {
        query: async (text, values) => {
          const result = await admin.query(text, values as unknown[]);
          return { rowCount: result.rowCount };
        },
      },
      { organizationId, connectionId },
    );
    assertEquals(swept.deliveries, 1);
    assertEquals(swept.subscriptions, 1);
    assertEquals(swept.destinations, 1);

    await q(admin, "delete from bakery.integration_connections where id = $1", [
      connectionId,
    ]);
    const remaining = await q<{ count: number }>(
      admin,
      "select count(*)::int as count from bakery.integration_connections where id = $1",
      [connectionId],
    );
    assertEquals(remaining[0]!.count, 0);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("the sweep refuses an id that is not a uuid", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      deleteEventExportHistory(
        {
          query: (text) => {
            calls.push(text);
            return Promise.resolve({ rowCount: 0 });
          },
        },
        { organizationId, connectionId: "1' or '1'='1" },
      ),
    TypeError,
    "invalid_identifier",
  );
  // Nothing ran: the identifier is validated before any statement is built.
  assertEquals(calls.length, 0);
});

Deno.test("the sweep is scoped to its organization and binds its values", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  const deliveryId = crypto.randomUUID();
  try {
    await seedParents(admin);
    await q(app, SUBSCRIPTION_INSERT, [
      subscriptionId,
      organizationId,
      connectionId,
      installationId,
      destinationId,
      resourceId,
    ]);
    await q(app, DELIVERY_INSERT, [
      deliveryId,
      organizationId,
      subscriptionId,
      destinationId,
      "evt-1",
      `identity-${deliveryId}`,
    ]);

    // Same connection id, wrong organization: an administrative sweep handed the
    // wrong tenant must remove nothing. A bare connection id would have matched.
    const wrongTenant = await deleteEventExportHistory(
      {
        query: async (text, values) => {
          const result = await admin.query(text, values as unknown[]);
          return { rowCount: result.rowCount };
        },
      },
      { organizationId: crypto.randomUUID(), connectionId },
    );
    assertEquals(wrongTenant.deliveries, 0);
    assertEquals(wrongTenant.subscriptions, 0);
    assertEquals(wrongTenant.destinations, 0);

    // The history is still there, so the zero above is scoping and not an
    // already-empty table.
    const survived = await q<{ count: number }>(
      admin,
      "select count(*)::int as count from bakery.integration_deliveries where organization_id = $1",
      [organizationId],
    );
    assertEquals(survived[0]!.count, 1);

    // And the right tenant still sweeps.
    const swept = await deleteEventExportHistory(
      {
        query: async (text, values) => {
          const result = await admin.query(text, values as unknown[]);
          return { rowCount: result.rowCount };
        },
      },
      { organizationId, connectionId },
    );
    assertEquals(swept.deliveries, 1);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});
