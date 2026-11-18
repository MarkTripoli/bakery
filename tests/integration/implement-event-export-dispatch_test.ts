import { assert, assertEquals } from "@std/assert";
import { openPgDatabase } from "../../apps/server/src/platform/database.ts";
import { openAuthFixture } from "../helpers/auth.ts";
import type { AuthoritySnapshot } from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  deliveryIdentity,
  type DeliveryLedger,
  type DeliveryOutcome,
  type DeliveryTransport,
  dispatchEventExport,
} from "../../apps/server/src/modules/integrations/event-export-dispatch.ts";
import type {
  ExportDestination,
  ExportSubscription,
} from "../../apps/server/src/modules/integrations/event-export-authorization.ts";
import { exportSourceEvent } from "../../apps/server/src/modules/integrations/event-export-worker.ts";

/**
 * Slice 3 of issue #21, AC2, proved at the seam that matters.
 *
 * A predicate with no caller proves nothing about AC2, which is a statement
 * about what reaches the wire and the ledger. So these tests drive the real
 * dispatch path against a real database and a recording transport, and assert
 * the two things a refusal must leave behind: no delivery row, and no outbound
 * request.
 *
 * The authorized baseline runs alongside every refusal, in the same test file,
 * so "nothing was sent" cannot be satisfied by a path that never sends at all.
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
const registrationId = crypto.randomUUID();
const installationId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
const resourceId = crypto.randomUUID();
const destinationId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();

const now = (): Date => new Date("2026-01-01T00:00:00Z");

const subscription: ExportSubscription & { id: string } = {
  id: subscriptionId,
  status: "active",
  revokedAt: null,
  eventKinds: ["issue.opened"],
};

const destination: ExportDestination & {
  id: string;
  origin: string;
  path: string;
} = {
  id: destinationId,
  status: "active",
  tombstonedAt: null,
  origin: "https://receiver.example.test",
  path: "/events",
};

function snapshot(
  overrides: {
    scopes?: readonly string[];
    selected?: boolean;
    available?: boolean;
    connectionState?: "active" | "reconnect_required" | "disabled";
  } = {},
): AuthoritySnapshot {
  return {
    organizationId,
    actor: { principalId, subjectType: "principal", active: true },
    install: {
      id: "install-1",
      providerId: "github",
      manifestDigest: "digest-1",
      enabled: true,
      approvedScopes: overrides.scopes ?? ["events:subscribe"],
    },
    connection: {
      id: connectionId,
      installId: "install-1",
      state: overrides.connectionState ?? "active",
      providerPermissions: {},
    },
    resource: {
      id: resourceId,
      kind: "repository",
      selected: overrides.selected ?? true,
      available: overrides.available ?? true,
      binding: {},
      repositoryId: "1",
    },
    grants: [],
    policyRevision: 1,
  } as unknown as AuthoritySnapshot;
}

/** Records every attempt to write a delivery row, so a refusal is observable. */
function recordingLedger(db: Db): DeliveryLedger & { records: number } {
  const state = { records: 0 };
  return {
    get records() {
      return state.records;
    },
    async record(input) {
      state.records += 1;
      const id = crypto.randomUUID();
      const status = input.attempt === 1 ? "prepared" : "prepared";
      await q(
        db,
        `insert into bakery.integration_deliveries (
           id, organization_id, subscription_id, destination_id, source_event_id,
           event_kind, attempt, delivery_identity, payload_digest, status,
           acknowledgement_state, created_at, updated_at, version
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', now(), now(), 1)`,
        [
          id,
          input.organizationId,
          input.subscriptionId,
          input.destinationId,
          input.sourceEventId,
          input.eventKind,
          input.attempt,
          input.deliveryIdentity,
          input.payloadDigest,
          status,
        ],
      );
      return { deliveryId: id };
    },
    async settle(input) {
      await q(
        db,
        `update bakery.integration_deliveries
           set status = $2, acknowledgement_state = $3, response_status = $4,
               outcome_code = $5, not_before = $6, updated_at = now(), version = version + 1
         where id = $1`,
        [
          input.deliveryId,
          input.status,
          input.acknowledgementState,
          input.responseStatus,
          input.outcomeCode,
          input.notBefore,
        ],
      );
    },
  };
}

/** Records every outbound request, so a refusal is observable on the wire too. */
function recordingTransport(
  outcome: DeliveryOutcome = { kind: "acknowledged", status: 202 },
): DeliveryTransport & { sent: number; addresses: readonly string[] } {
  const state = { sent: 0, addresses: [] as readonly string[] };
  return {
    get sent() {
      return state.sent;
    },
    get addresses() {
      return state.addresses;
    },
    send(input) {
      state.sent += 1;
      state.addresses = input.addresses;
      return Promise.resolve(outcome);
    },
  };
}

async function seed(admin: Db): Promise<void> {
  await q(
    admin,
    "insert into bakery.organizations (id, name, slug, created_at, updated_at) values ($1, 'Event export', $2, now(), now())",
    [organizationId, `probe-${organizationId}`],
  );
  await q(
    admin,
    "insert into bakery.principals (id, display_name, principal_type) values ($1, 'Event export', 'service')",
    [principalId],
  );
  await q(
    admin,
    "insert into bakery.secrets (id, organization_id, name) values ($1, $2, 'Event export secret')",
    [secretId, organizationId],
  );

  // Exactly one GitHub registration may exist per deployment.
  const existing = await q<{ id: string }>(
    admin,
    "select id from bakery.integration_app_registrations where provider = 'github' limit 1",
  );
  let registration = existing[0]?.id ?? null;
  if (registration === null) {
    registration = registrationId;
    await q(
      admin,
      `insert into bakery.integration_app_registrations (
         id, provider, external_app_id, slug, name, client_id, owner_login,
         owner_id, owner_type, html_url, permissions, events, client_secret_id,
         private_key_secret_id, status, registered_by, created_at, updated_at, version
       ) values (
         $1, 'github', $2, $3, 'Event export', 'Iv1.probe', 'probe', '1', 'User',
         'https://github.com/apps/probe', '{}', '{}', $4, $4, 'active', $5,
         now(), now(), 1
       )`,
      [
        registration,
        String(Math.floor(Math.random() * 1_000_000_000)),
        `probe-${registration}`,
        secretId,
        principalId,
      ],
    );
  }

  const token = crypto.randomUUID();
  await q(
    admin,
    `insert into bakery.integration_installations (
       id, provider, registration_id, external_authorization_id,
       external_account_id, account_login, account_type, repository_selection,
       granted_permissions, status, created_at, updated_at, version
     ) values ($1, 'github', $2, $3, $3, 'probe', 'User', 'all', '[]',
       'active', now(), now(), 1)`,
    [installationId, registration, `probe-${token}`],
  );
  await q(
    admin,
    `insert into bakery.integration_connections (
       id, organization_id, provider, installation_id, external_authorization_id,
       external_account_id, label, adapter_version, granted_permissions, status,
       health, created_by, created_at, updated_at, version
     ) values ($1, $2, 'github', $3, $4, $4, 'Event export', '1', '[]',
       'active', 'healthy', $5, now(), now(), 1)`,
    [
      connectionId,
      organizationId,
      installationId,
      `probe-${token}`,
      principalId,
    ],
  );
  await q(
    admin,
    `insert into bakery.integration_resources (
       id, organization_id, connection_id, installation_id, kind, external_id,
       display_name, last_discovery_generation, created_at, updated_at, version
     ) values ($1, $2, $3, $4, 'repository', $5, 'repo', 1, now(), now(), 1)`,
    [
      resourceId,
      organizationId,
      connectionId,
      installationId,
      `probe-${token}`,
    ],
  );
  await q(
    admin,
    `insert into bakery.integration_destinations (
       id, organization_id, connection_id, installation_id, kind, origin, path,
       secret_version_id, recovery_identity, status, health,
       acknowledgement_state, created_at, updated_at, version
     ) values ($1, $2, $3, $4, 'https', $5, $6, $7, $8, 'active', 'healthy',
       'pending', now(), now(), 1)`,
    [
      destinationId,
      organizationId,
      connectionId,
      installationId,
      destination.origin,
      destination.path,
      secretId,
      `probe-${token}`,
    ],
  );
  await q(
    admin,
    `insert into bakery.integration_event_subscriptions (
       id, organization_id, connection_id, installation_id, destination_id,
       source_resource_id, event_kinds, authorization_revision, status,
       created_at, updated_at, version
     ) values ($1, $2, $3, $4, $5, $6, '{issue.opened}', 1, 'active',
       now(), now(), 1)`,
    [
      subscriptionId,
      organizationId,
      connectionId,
      installationId,
      destinationId,
      resourceId,
    ],
  );
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
    "delete from bakery.integration_installations where id = $1",
    [installationId],
  );
  await q(
    admin,
    "delete from bakery.integration_app_registrations where id = $1",
    [registrationId],
  );
  await q(admin, "delete from bakery.secrets where id = $1", [secretId]);
  await q(admin, "delete from bakery.principals where id = $1", [principalId]);
  await q(admin, "delete from bakery.organizations where id = $1", [
    organizationId,
  ]);
}

async function deliveryRows(db: Db): Promise<number> {
  const rows = await q<{ count: number }>(
    db,
    "select count(*)::int as count from bakery.integration_deliveries where organization_id = $1",
    [organizationId],
  );
  return rows[0]!.count;
}

const raw = new TextEncoder().encode('{"event":"issue.opened"}');
const sign = (identity: string) =>
  Promise.resolve({ "x-bakery-delivery": identity });

async function dispatch(
  db: Db,
  options: {
    snapshot?: Parameters<typeof snapshot>[0];
    subscription?: Partial<typeof subscription>;
    destination?: Partial<typeof destination>;
    eventKind?: string;
    transportOutcome?: DeliveryOutcome;
    attempt?: number;
    sourceEventId?: string;
    addresses?: readonly string[];
  } = {},
) {
  const ledger = recordingLedger(db);
  const transport = recordingTransport(options.transportOutcome);
  const result = await dispatchEventExport({
    snapshot: snapshot(options.snapshot),
    subscription: { ...subscription, ...options.subscription },
    destination: { ...destination, ...options.destination },
    eventKind: options.eventKind ?? "issue.opened",
    sourceEventId: options.sourceEventId ?? `event-${crypto.randomUUID()}`,
    attempt: options.attempt ?? 1,
    raw,
    payloadDigest: "digest-1",
    sign,
    reloadAuthority: () => Promise.resolve(snapshot(options.snapshot)),
    resolve: () => Promise.resolve(options.addresses ?? ["93.184.216.34"]),
    ledger,
    transport,
    now,
  });
  return { result, ledger, transport };
}

Deno.test("an authorized export writes one delivery row and sends one request", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    // The baseline must send, or every "nothing was sent" below is vacuous.
    const { result, ledger, transport } = await dispatch(app);
    assertEquals(result.ok, true);
    assertEquals(ledger.records, 1);
    assertEquals(transport.sent, 1);
    assertEquals(await deliveryRows(app), 1);

    // Acknowledged, not left pending.
    const rows = await q<{ status: string; acknowledgement_state: string }>(
      app,
      "select status, acknowledgement_state from bakery.integration_deliveries where organization_id = $1",
      [organizationId],
    );
    assertEquals(rows[0]!.status, "delivered");
    assertEquals(rows[0]!.acknowledgement_state, "acknowledged");
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("a revoked subscription sends nothing and writes no delivery row", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    const { result, ledger, transport } = await dispatch(app, {
      subscription: { status: "revoked" },
    });
    assertEquals(result, { ok: false, reason: "subscription_revoked" });
    assertEquals(ledger.records, 0);
    assertEquals(transport.sent, 0);
    assertEquals(await deliveryRows(app), 0);

    // And the same database still sends when the subscription is live, so the
    // zero above is the refusal and not a broken fixture.
    const second = await dispatch(app);
    assertEquals(second.transport.sent, 1);
    assertEquals(await deliveryRows(app), 1);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("a private source resource sends nothing and writes no delivery row", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    for (const overrides of [{ selected: false }, { available: false }]) {
      const { result, ledger, transport } = await dispatch(app, {
        snapshot: overrides,
      });
      assertEquals(result, { ok: false, reason: "source_not_exportable" });
      assertEquals(ledger.records, 0);
      assertEquals(transport.sent, 0);
    }
    assertEquals(await deliveryRows(app), 0);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("an install re-approved without events:subscribe sends nothing", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    const { result, ledger, transport } = await dispatch(app, {
      snapshot: { scopes: [] },
    });
    assertEquals(result, { ok: false, reason: "scope_not_granted" });
    assertEquals(ledger.records, 0);
    assertEquals(transport.sent, 0);
    assertEquals(await deliveryRows(app), 0);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("an uncertain acknowledgement keeps the delivery and retries under the same identity", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  const eventId = `event-${crypto.randomUUID()}`;
  try {
    await seed(admin);

    const { result, transport } = await dispatch(app, {
      transportOutcome: { kind: "uncertain", reason: "timeout" },
      sourceEventId: eventId,
    });
    assertEquals(result.ok, true);
    assertEquals(transport.sent, 1);

    const rows = await q<{
      status: string;
      acknowledgement_state: string;
      not_before: Date | null;
      delivery_identity: string;
    }>(
      app,
      "select status, acknowledgement_state, not_before, delivery_identity from bakery.integration_deliveries where organization_id = $1",
      [organizationId],
    );
    assertEquals(rows[0]!.status, "uncertain");
    assertEquals(rows[0]!.acknowledgement_state, "uncertain");
    assert(
      rows[0]!.not_before !== null,
      "an uncertain attempt must be scheduled for retry rather than left due now",
    );

    // Asserted through the real function, not a shape check: `startsWith` would
    // have passed the very bug this test exists for, where the identity carried
    // the attempt number and so differed on every retry.
    assertEquals(
      rows[0]!.delivery_identity,
      await deliveryIdentity({ subscriptionId, sourceEventId: eventId }),
    );

    // The property that actually matters: attempt 2 is the same delivery.
    const retry = await dispatchEventExport({
      snapshot: snapshot(),
      subscription,
      destination,
      eventKind: "issue.opened",
      sourceEventId: eventId,
      attempt: 2,
      raw,
      payloadDigest: "digest-1",
      sign,
      reloadAuthority: () => Promise.resolve(snapshot()),
      resolve: () => Promise.resolve(["93.184.216.34"]),
      ledger: recordingLedger(app),
      transport: recordingTransport({
        kind: "acknowledged",
        status: 202,
      }),
      now,
    });
    assertEquals(retry.ok, true);
    if (!retry.ok) throw new Error("unreachable");
    assertEquals(
      retry.deliveryIdentity,
      rows[0]!.delivery_identity,
      "a retry must present the same delivery identity, or the receiver stores one event twice",
    );

    // Both attempts must be recorded. A stable identity made the old
    // `unique (delivery_identity)` collide on the second attempt, so an uncertain
    // delivery could not be retried at all - the constraint had to move to
    // (identity, attempt), which 0191 does. Asserting the rows rather than the
    // constraint name is what proves the retry is actually possible.
    const attempts = await q<{ attempt: number; delivery_identity: string }>(
      app,
      "select attempt, delivery_identity from bakery.integration_deliveries where organization_id = $1 order by attempt",
      [organizationId],
    );
    assertEquals(attempts.length, 2);
    assertEquals(attempts.map((row) => row.attempt), [1, 2]);
    assertEquals(
      attempts[0]!.delivery_identity,
      attempts[1]!.delivery_identity,
      "both attempts must carry the same receiver-facing identity",
    );
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("a destination resolving to a private address sends nothing", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    // The rebinding shape: the registered URL is fine, the answer is not.
    for (
      const addresses of [
        ["127.0.0.1"],
        ["169.254.169.254"],
        ["10.0.0.1"],
        ["93.184.216.34", "127.0.0.1"],
        [],
      ]
    ) {
      const { result, ledger, transport } = await dispatch(app, { addresses });
      assertEquals(result, {
        ok: false,
        reason: addresses.length === 0
          ? "unresolved"
          : "resolves_to_private_address",
      });
      assertEquals(ledger.records, 0);
      assertEquals(transport.sent, 0);
    }
    assertEquals(await deliveryRows(app), 0);

    // The same database still sends to a public address, so the zeros above are
    // the refusal and not a fixture that never sends.
    const allowed = await dispatch(app, { addresses: ["93.184.216.34"] });
    assertEquals(allowed.transport.sent, 1);
    assertEquals(await deliveryRows(app), 1);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("the transport is told the addresses that were checked", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    // Judging one set of addresses and connecting to another is the rebinding
    // attack, so the transport must receive exactly what was judged.
    const { transport } = await dispatch(app, {
      addresses: ["93.184.216.34", "93.184.216.35"],
    });
    assertEquals(transport.addresses, ["93.184.216.34", "93.184.216.35"]);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("a non-https destination sends nothing", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    const { result, ledger, transport } = await dispatch(app, {
      destination: { origin: "http://receiver.example.test" },
    });
    assertEquals(result, { ok: false, reason: "not_https" });
    assertEquals(ledger.records, 0);
    assertEquals(transport.sent, 0);
    assertEquals(await deliveryRows(app), 0);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("the worker dispatches a recorded event to its subscriber", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    // This is the production caller: a recorded source event, subscriptions
    // found from the database, and one dispatch per subscription. Everything
    // below it had no caller before, so its refusals and checks were unreachable
    // in production.
    const transport = recordingTransport();
    const result = await exportSourceEvent(
      {
        database: app,
        authority: {
          load: () => Promise.resolve(snapshot()),
        },
        registry: {} as never,
        transport,
        resolve: () => Promise.resolve(["93.184.216.34"]),
        secretFor: () => Promise.resolve("a".repeat(32)),
      },
      {
        organizationId,
        sourceEventId: "evt-worker-1",
        eventKind: "issue.opened",
        sourceResourceId: resourceId,
        payload: '{"event":"issue.opened"}',
      },
    );

    assertEquals(result.offered, 1);
    assertEquals(result.dispatched, 1);
    assertEquals(result.refused, 0);

    // It actually sent, to the address that was checked, with a signed request.
    assertEquals(transport.sent, 1);
    assertEquals(transport.addresses, ["93.184.216.34"]);

    const rows = await q<{ attempt: number; status: string }>(
      app,
      `select attempt, status from bakery.integration_deliveries
        where organization_id = $1 and source_event_id = 'evt-worker-1'`,
      [organizationId],
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.attempt, 1);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("a second run of the same event is a new attempt, not a new delivery", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);
    const run = (options?: { retryExisting?: boolean }) =>
      exportSourceEvent(
        {
          database: app,
          authority: { load: () => Promise.resolve(snapshot()) },
          registry: {} as never,
          transport: recordingTransport(),
          resolve: () => Promise.resolve(["93.184.216.34"]),
          secretFor: () => Promise.resolve("a".repeat(32)),
        },
        {
          organizationId,
          sourceEventId: "evt-worker-2",
          eventKind: "issue.opened",
          sourceResourceId: resourceId,
          payload: '{"event":"issue.opened"}',
        },
        options,
      );

    await run();
    // A second pass is a retry, and a retry asks for it explicitly: the sweep
    // otherwise offers an event once, so re-reading the same completed route
    // cannot export it again.
    await run({ retryExisting: true });

    // Retrying is possible at all only because 0191 keys the unique index on
    // (identity, attempt): the delivery identity is stable across attempts, so a
    // unique on the identity alone made the second attempt impossible.
    const rows = await q<{ attempt: number; delivery_identity: string }>(
      app,
      `select attempt, delivery_identity from bakery.integration_deliveries
        where organization_id = $1 and source_event_id = 'evt-worker-2'
        order by attempt`,
      [organizationId],
    );
    assertEquals(rows.length, 2);
    assertEquals(rows[0]!.attempt, 1);
    assertEquals(rows[1]!.attempt, 2);
    // One delivery to the receiver, attempted twice.
    assertEquals(rows[0]!.delivery_identity, rows[1]!.delivery_identity);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("the worker refuses a subscription whose authority lapsed", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);
    const transport = recordingTransport();
    const result = await exportSourceEvent(
      {
        database: app,
        // The subscription row is still active; the authority behind it is not.
        // The query found it, and the predicate is what refuses it - which is
        // why AC2 is about the predicate and not about the query.
        authority: {
          load: () =>
            Promise.resolve(snapshot({ connectionState: "disabled" })),
        },
        registry: {} as never,
        transport,
        resolve: () => Promise.resolve(["93.184.216.34"]),
        secretFor: () => Promise.resolve("a".repeat(32)),
      },
      {
        organizationId,
        sourceEventId: "evt-worker-3",
        eventKind: "issue.opened",
        sourceResourceId: resourceId,
        payload: '{"event":"issue.opened"}',
      },
    );

    assertEquals(result.offered, 1);
    assertEquals(result.refused, 1);
    assertEquals(result.dispatched, 0);
    assertEquals(transport.sent, 0);
    assertEquals(await deliveryRows(app), 0);
    assertEquals(Object.keys(result.reasons), ["connection_not_active"]);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("the worker does not send to a private address either", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);
    const transport = recordingTransport();
    const result = await exportSourceEvent(
      {
        database: app,
        authority: { load: () => Promise.resolve(snapshot()) },
        registry: {} as never,
        transport,
        resolve: () => Promise.resolve(["169.254.169.254"]),
        secretFor: () => Promise.resolve("a".repeat(32)),
      },
      {
        organizationId,
        sourceEventId: "evt-worker-4",
        eventKind: "issue.opened",
        sourceResourceId: resourceId,
        payload: '{"event":"issue.opened"}',
      },
    );

    assertEquals(result.refused, 1);
    assertEquals(transport.sent, 0);
    assertEquals(await deliveryRows(app), 0);
    assertEquals(Object.keys(result.reasons), ["resolves_to_private_address"]);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});

Deno.test("the sweep does not export the same event twice", async () => {
  const admin = openPgDatabase(adminUrl);
  const app = openPgDatabase(appUrl);
  await ensureMigrated();
  try {
    await seed(admin);

    // The worker reads completed intake routes on a cron, so the same route is
    // seen on every pass. Without the delivery row as the marker it would export
    // the event again each time - and a receiver deduplicating on the identity
    // would see the same delivery repeated rather than one delivery attempted
    // once.
    const transport = recordingTransport();
    const dependencies = {
      database: app,
      authority: { load: () => Promise.resolve(snapshot()) },
      registry: {} as never,
      transport,
      resolve: () => Promise.resolve(["93.184.216.34"]),
      secretFor: () => Promise.resolve("a".repeat(32)),
    };
    const event = {
      organizationId,
      sourceEventId: "evt-sweep-1",
      eventKind: "issue.opened",
      sourceResourceId: resourceId,
      payload: '{"event":"issue.opened"}',
    };

    const first = await exportSourceEvent(dependencies, event);
    assertEquals(first.offered, 1);
    assertEquals(transport.sent, 1);

    const second = await exportSourceEvent(dependencies, event);
    assertEquals(second.offered, 0);
    assertEquals(second.dispatched, 0);
    assertEquals(transport.sent, 1);
    assertEquals(await deliveryRows(app), 1);
  } finally {
    await cleanup(admin);
    await admin.end();
    await app.end();
  }
});
