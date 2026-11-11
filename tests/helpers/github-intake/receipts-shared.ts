import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { authTestOrigin } from "../auth.ts";
import {
  enabledConnection,
  type GitHubAppFixture,
  installationRows,
  openGitHubAppFixture,
  patchConnection,
  patchResource,
  pendingConnection,
  type ResourceRow,
  secondOrganization,
} from "../github-app-registration.ts";
import { createIntegrationsActionRegistry } from "../../../apps/server/src/modules/integrations/actions.ts";
import { mountIntakeRoute } from "../../../apps/server/src/modules/integrations/intake-routes.ts";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import type { AuthVariables } from "../../../apps/server/src/modules/auth/middleware.ts";
import { deliveryRequest } from "./signed-delivery.ts";

export const webhookUrl = `${authTestOrigin}/v1/webhooks/github`;
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export async function withFixture(
  run: (f: GitHubAppFixture) => Promise<void>,
): Promise<void> {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

/**
 * A registered App with an enabled connection that selected `selected`
 * repositories (one by default), and everything a signed delivery needs: the
 * webhook secret the App was registered with, the installation's GitHub id and
 * the numeric id of the first selected repository.
 */
export async function enabledReceiver(
  f: GitHubAppFixture,
  options: { selected?: number } = {},
) {
  const connection = await enabledConnection(f, {
    selected: options.selected ?? 1,
  });
  const secret = connection.app.webhookSecret;
  assert(secret !== null, "the fake App registered with a webhook secret");
  const registration = await f.pgDatabase.query<{ id: string }>(
    "select id from bakery.integration_app_registrations",
  );
  assertEquals(registration.rows.length, 1);
  const installation = (await installationRows(f))[0];
  const resource = connection.selected[0];
  return {
    f,
    secret,
    connection,
    registrationId: registration.rows[0].id,
    /** Bakery's own installation row id. */
    installationRowId: installation.id,
    /** GitHub's numeric installation id, as payloads carry it. */
    installationId: connection.installation.id,
    resource,
    /** GitHub's numeric repository id of the first selected repository. */
    repositoryId: Number(resource.external_id),
  };
}
export type Receiver = Awaited<ReturnType<typeof enabledReceiver>>;

/** Identifies the installation and repository a payload is about. */
export type Target = { installationId: number; repositoryId: number };

export const issuesPayload = (
  target: Target,
  number = 1,
  action = "opened",
) => ({
  action,
  issue: { number },
  repository: { id: target.repositoryId },
  installation: { id: target.installationId },
});

export const pullRequestPayload = (
  target: Target,
  number: number,
  headSha: string,
  action = "synchronize",
) => ({
  action,
  pull_request: { number, head: { sha: headSha } },
  repository: { id: target.repositoryId },
  installation: { id: target.installationId },
});

export const checkRunPayload = (
  target: Target,
  headSha: string,
  action = "completed",
) => ({
  action,
  check_run: { id: 4242, head_sha: headSha },
  repository: { id: target.repositoryId },
  installation: { id: target.installationId },
});

export const checkSuitePayload = (
  target: Target,
  headSha: string,
  action = "completed",
) => ({
  action,
  check_suite: { id: 4343, head_sha: headSha },
  repository: { id: target.repositoryId },
  installation: { id: target.installationId },
});

export const installationPayload = (target: Target, action: string) => ({
  action,
  installation: { id: target.installationId },
});

export type SendOptions = {
  event: string;
  /** Serialized as JSON unless `body` is given. */
  payload?: unknown;
  /** Exact bytes to sign and send. */
  body?: string | Uint8Array<ArrayBuffer>;
  deliveryId?: string;
  contentType?: string;
  /** Secret to sign with; defaults to the registered App's. */
  secret?: string;
  /** `undefined` signs; `null` omits the header; a string is sent as given. */
  signature?: string | null;
};

/** Builds a signed delivery request as GitHub would send it. */
export function deliveryOf(
  receiver: Pick<Receiver, "secret">,
  options: SendOptions,
): Promise<Request> {
  return deliveryRequest({
    url: webhookUrl,
    secret: options.secret ?? receiver.secret,
    eventName: options.event,
    deliveryId: options.deliveryId ?? crypto.randomUUID(),
    body: options.body ?? JSON.stringify(options.payload),
    contentType: options.contentType ?? "application/json",
    signature: options.signature,
  });
}

/** Sends a signed delivery through the whole application. */
export async function send(
  receiver: Pick<Receiver, "f" | "secret">,
  options: SendOptions,
): Promise<Response> {
  return await receiver.f.app.fetch(await deliveryOf(receiver, options));
}

/** Sends a delivery and returns the parsed 202 receipt. */
export async function receipt(
  receiver: Pick<Receiver, "f" | "secret">,
  options: SendOptions,
): Promise<
  { eventId: string; status: string; taskId: null; receivedAt: string }
> {
  const response = await send(receiver, options);
  assertEquals(response.status, 202, await response.clone().text());
  return await response.json();
}

export type ReceiptRow = {
  id: string;
  provider: string;
  registration_id: string;
  external_delivery_id: string;
  payload_digest: string;
  event_kind: string;
  event_action: string | null;
  installation_id: string | null;
  normalized_projection: Record<string, unknown> | null;
  status: string;
  rejection_reason: string | null;
  received_at: Date;
  expires_at: Date;
};

export async function receiptRows(f: GitHubAppFixture): Promise<ReceiptRow[]> {
  return (await f.pgDatabase.query<ReceiptRow>(
    "select * from bakery.inbound_events order by received_at, id",
  )).rows;
}

export async function receiptRow(
  f: GitHubAppFixture,
  eventId: string,
): Promise<ReceiptRow> {
  const row = (await receiptRows(f)).find(({ id }) => id === eventId);
  assert(row !== undefined, "the receipt exists");
  return row;
}

export type RouteRow = {
  id: string;
  inbound_event_id: string;
  organization_id: string;
  connection_id: string;
  installation_id: string;
  resource_id: string | null;
  purpose: string;
  status: string;
  outcome_code: string | null;
  attempts: number;
  version: number;
};

export async function routeRows(
  f: GitHubAppFixture,
  eventId?: string,
): Promise<RouteRow[]> {
  return (await f.pgDatabase.query<RouteRow>(
    `select * from bakery.inbound_event_routes
      where $1::uuid is null or inbound_event_id = $1
      order by created_at, id`,
    [eventId ?? null],
  )).rows;
}

/**
 * Rows a refused request must leave unchanged, counted over the receipts that
 * exist: receipts, routes, `intake.received` domain events and their outbox
 * rows, and receive audit rows.
 */
export async function rowCounts(f: GitHubAppFixture) {
  const result = await f.pgDatabase.query<Record<string, string>>(
    `select
       (select count(*) from bakery.inbound_events) as receipts,
       (select count(*) from bakery.inbound_event_routes) as routes,
       (select count(*) from bakery.domain_events
         where event_type = 'intake.received'
           and payload->>'inboundEventId' in
             (select id::text from bakery.inbound_events)) as "domainEvents",
       (select count(*) from bakery.outbox
         where delivery_key like 'intake:%'
           and event_id in (select id from bakery.domain_events
             where payload->>'inboundEventId' in
               (select id::text from bakery.inbound_events))) as outbox,
       (select count(*) from bakery.audit_events
         where operation = 'integrationEvents.receive'
           and resource_id in
             (select id::text from bakery.inbound_events)) as audits`,
  );
  return Object.fromEntries(
    Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]),
  ) as {
    receipts: number;
    routes: number;
    domainEvents: number;
    outbox: number;
    audits: number;
  };
}

/** Every receipt and route as text, to prove a refusal left them byte-identical. */
export async function receiptText(f: GitHubAppFixture): Promise<string> {
  const result = await f.pgDatabase.query<{ text: string }>(
    `select concat_ws('|',
       (select coalesce(string_agg(e::text, ',' order by e.id), '')
          from bakery.inbound_events e),
       (select coalesce(string_agg(r::text, ',' order by r.id), '')
          from bakery.inbound_event_routes r)) as text`,
  );
  return result.rows[0].text;
}

/** Lowercase hex SHA-256 of `bytes`, computed here so the receiver's own helper cannot hide a bug. */
export async function digestOf(
  bytes: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
  const data = typeof bytes === "string"
    ? new TextEncoder().encode(bytes)
    : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** The unselected repository resources of the receiver's connection. */
export function unselectedResources(receiver: Receiver): ResourceRow[] {
  const selected = new Set(receiver.connection.selected.map(({ id }) => id));
  return receiver.connection.resources.filter(({ id }) => !selected.has(id));
}

/**
 * A second organization's pending connection to the receiver's installation,
 * with its own resource row for each repository the installation covers.
 */
export async function sharedSecondConnection(receiver: Receiver) {
  const organizationId = await secondOrganization(receiver.f);
  const second = await pendingConnection(receiver.f, {
    app: receiver.connection.app,
    existing: receiver.connection.installation,
    attempt: { organizationId },
  });
  return { organizationId, second };
}

/** Selects `resource` and enables the connection in `organizationId`. */
export async function selectAndEnable(
  f: GitHubAppFixture,
  connectionId: string,
  resource: ResourceRow,
  organizationId: string,
): Promise<void> {
  const selected = await patchResource(
    f,
    connectionId,
    resource.id,
    { selected: true },
    { organizationId },
  );
  assertEquals(selected.status, 200, await selected.clone().text());
  const enabled = await patchConnection(
    f,
    connectionId,
    { enabled: true },
    { organizationId },
  );
  assertEquals(enabled.status, 200, await enabled.clone().text());
}

/**
 * The receiving route mounted alone over `database`, so a test can wrap the
 * pool to count or fail queries, or shorten the deadline, without touching the
 * application the fixture built.
 */
export function receiverApp(
  f: GitHubAppFixture,
  options: {
    database?: PgDatabase;
    deadlineMs?: number;
    /** `null` mounts no secrets key; the default is the fixture's. */
    secretsKey?: GitHubAppFixture["secretsKey"] | null;
  } = {},
): Hono<{ Variables: AuthVariables }> {
  const database = options.database ?? f.runtimePgDatabase!;
  const secretsKey = options.secretsKey === null
    ? undefined
    : options.secretsKey ?? f.secretsKey;
  const app = new Hono<{ Variables: AuthVariables }>();
  mountIntakeRoute(app, {
    registry: createIntegrationsActionRegistry(database, {
      publicBaseUrl: authTestOrigin,
      secretsKey,
      github: f.github.client,
      cursorSecret: "intake-receipts-test-cursor-secret-0123456789",
    }),
    database,
    secretsKey,
    publicBaseUrl: authTestOrigin,
    deadlineMs: options.deadlineMs,
  });
  return app;
}

/**
 * Wraps a pool so every query is observable and selected statements fail or
 * hang. `queries` lists the text of each query; `failing` names a fragment
 * whose query is rejected with a database shutdown error (SQLSTATE 57P01);
 * `stalling` names a fragment whose query is replaced by a 30 second
 * `pg_sleep`, so a deadline that fires meanwhile makes the server cancel it
 * (SQLSTATE 57014); `delaying` holds a matching query back for `ms` before it
 * is sent, so a deadline fires between two statements instead; and
 * `connectFails` rejects checking out a transaction connection.
 */
export function instrumentedDatabase(real: PgDatabase) {
  const state = {
    queries: [] as string[],
    failing: null as string | null,
    stalling: null as string | null,
    delaying: null as { fragment: string; ms: number } | null,
    connectFails: false,
  };
  const shutdown = () =>
    Object.assign(new Error("terminating connection"), { code: "57P01" });
  const intercept =
    (target: { query: (...args: never[]) => unknown }) =>
    (text: unknown, values?: unknown) => {
      const sql = typeof text === "string"
        ? text
        : (text as { text: string }).text;
      state.queries.push(sql);
      const forward = (query: unknown, params?: unknown) =>
        (target.query as (...args: unknown[]) => unknown).call(
          target,
          query,
          params,
        );
      if (state.failing !== null && sql.includes(state.failing)) {
        return Promise.reject(shutdown());
      }
      if (state.stalling !== null && sql.includes(state.stalling)) {
        return forward("select pg_sleep(30)");
      }
      if (state.delaying !== null && sql.includes(state.delaying.fragment)) {
        return new Promise((resolve) => setTimeout(resolve, state.delaying!.ms))
          .then(() => forward(text, values));
      }
      return forward(text, values);
    };
  const database = new Proxy(real, {
    get(target, property) {
      if (property === "query") return intercept(target);
      if (property === "connect") {
        return async () => {
          if (state.connectFails) throw shutdown();
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty === "query") return intercept(clientTarget);
              const value = Reflect.get(clientTarget, clientProperty);
              return typeof value === "function"
                ? value.bind(clientTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, state };
}
