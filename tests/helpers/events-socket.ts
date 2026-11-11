import { z } from "zod";
import {
  contractSchemas,
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "../../packages/contracts/src/contracts.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "./auth.ts";
import {
  connectWebSocket,
  type WebSocketHandshakeFailure,
  type WsClient,
} from "./ws-client.ts";

export type WebSocketFrame = z.infer<typeof contractSchemas.WebSocketFrame>;
export type EventsSocketFixture = SocketFixture;

export type InsertDomainEventOptions = {
  readonly eventType: string;
  readonly schemaVersion?: number;
  readonly applicationId?: string | null;
  readonly repositoryId?: string | null;
  readonly taskId?: string | null;
  readonly conversationId?: string | null;
  readonly aggregateId?: string;
  readonly aggregateVersion?: number;
  readonly payload?: unknown;
  readonly traceId?: string | null;
  /**
   * Advance `retained_from_seq` past the new event in the same transaction, so
   * no reader can observe the advanced highwater with the old retention bound.
   */
  readonly expired?: boolean;
};

export type InsertedDomainEvent = {
  readonly id: string;
  readonly sequence: string;
};

export type SocketFixtureConnectOptions = {
  readonly cookie?: string;
  readonly origin?: string | null;
  readonly organizationId?: string;
  readonly after?: string | null;
  readonly headers?: HeadersInit;
};

export type SocketFixture = {
  readonly app: Awaited<ReturnType<typeof openAuthFixture>>["app"];
  readonly auth: Awaited<ReturnType<typeof openAuthFixture>>["auth"];
  readonly database: Awaited<ReturnType<typeof openAuthFixture>>["database"];
  readonly pgDatabase: PgDatabase;
  readonly runtimePgDatabase: Awaited<
    ReturnType<typeof openAuthFixture>
  >["runtimePgDatabase"];
  readonly config: Awaited<ReturnType<typeof openAuthFixture>>["config"];
  readonly email: string;
  readonly password: string;
  readonly cookie: string;
  readonly principalId: ReturnType<typeof toPrincipalId>;
  readonly organizationId: ReturnType<typeof toOrganizationId>;
  readonly applicationId: string;
  readonly taskId: string;
  readonly conversationId: string;
  connect(
    options?: SocketFixtureConnectOptions,
  ): Promise<WsClient | WebSocketHandshakeFailure>;
  insertDomainEvent(
    options: InsertDomainEventOptions,
  ): Promise<InsertedDomainEvent>;
  assertFrame(value: string | Uint8Array): WebSocketFrame;
  close(): Promise<void>;
};

function isWsClient(
  value: WsClient | WebSocketHandshakeFailure,
): value is WsClient {
  return "send" in value;
}

function frameText(value: string | Uint8Array): string {
  if (typeof value === "string") return value;
  return new TextDecoder().decode(value);
}

export function assertFrame(value: string | Uint8Array): WebSocketFrame {
  return contractSchemas.WebSocketFrame.parse(
    JSON.parse(frameText(value)),
  ) as WebSocketFrame;
}

export async function openSocketFixture(options: {
  readonly eventsSocket?: NonNullable<
    NonNullable<Parameters<typeof openAuthFixture>[0]>["eventsSocket"]
  >;
} = {}): Promise<SocketFixture> {
  const authFixture = await openAuthFixture({
    eventsSocket: options.eventsSocket,
  });
  const suffix = crypto.randomUUID();
  const email = `events-socket-${suffix}@example.test`;
  const password = `EventsSocket-${suffix}`;
  let server: Deno.HttpServer | undefined;
  const clients = new Set<WsClient>();
  try {
    await createSuperuser({
      pgDatabase: authFixture.pgDatabase,
      config: authFixture.config.auth!,
    }, { email, displayName: "Events Socket", password });
    const signIn = await authFixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    const cookie = sessionCookie(signIn);
    const scope = await authFixture.pgDatabase.query<{
      principalId: string;
      organizationId: string;
    }>(
      `select principal.id as "principalId",
        membership.organization_id as "organizationId"
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships as membership
         on membership.principal_id = principal.id
       where provider_user.email = $1`,
      [email],
    );
    const identity = scope.rows[0];
    if (!identity) throw new Error("SOCKET_FIXTURE_IDENTITY_REQUIRED");
    const principalId = toPrincipalId(identity.principalId);
    const organizationId = toOrganizationId(identity.organizationId);
    const applicationId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    await authFixture.pgDatabase.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'Events acceptance')`,
      [applicationId, organizationId, `events-${suffix}`],
    );
    await authFixture.pgDatabase.query(
      `insert into bakery.conversations (
         id, organization_id, application_id, title, created_by
       ) values ($1, $2, $3, 'Events conversation', $4)`,
      [conversationId, organizationId, applicationId, principalId],
    );
    await authFixture.pgDatabase.query(
      `insert into bakery.tasks (
         id, organization_id, application_id, conversation_id, title,
         task_type, status, priority, created_by
       ) values ($1, $2, $3, $4, 'Events task', 'feature', 'draft', 50, $5)`,
      [taskId, organizationId, applicationId, conversationId, principalId],
    );
    let resolvePort: (port: number) => void = () => {};
    const listening = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => resolvePort(port),
    }, (request) => authFixture.app.fetch(request));
    const port = await listening;
    const connect = async (
      connectOptions: SocketFixtureConnectOptions = {},
    ): Promise<WsClient | WebSocketHandshakeFailure> => {
      const url = new URL(`ws://127.0.0.1:${port}/v1/events`);
      url.searchParams.set(
        "organizationId",
        connectOptions.organizationId ?? organizationId,
      );
      if (connectOptions.after !== undefined && connectOptions.after !== null) {
        url.searchParams.set("after", connectOptions.after);
      }
      const headers = new Headers(connectOptions.headers);
      if (connectOptions.cookie) headers.set("Cookie", connectOptions.cookie);
      if (connectOptions.origin !== null) {
        headers.set("Origin", connectOptions.origin ?? authTestOrigin);
      }
      const client = await connectWebSocket(url, { headers });
      if (isWsClient(client)) clients.add(client);
      return client;
    };
    const insertDomainEvent = async (
      event: InsertDomainEventOptions,
    ): Promise<InsertedDomainEvent> => {
      const aggregateId = event.aggregateId ?? taskId;
      const aggregateVersion = event.aggregateVersion ?? 1;
      return await withPgTransaction(
        authFixture.pgDatabase,
        async (transaction) => {
          const clock = await transaction.query<{ sequence: string }>(
            `insert into bakery.event_clock (organization_id, stream, next_seq)
             select $1, 'domain_events', coalesce(max(organization_sequence), 0) + 2
             from bakery.domain_events
             where organization_id = $1
             on conflict (organization_id, stream) do update
               set next_seq = bakery.event_clock.next_seq + 1
             returning (next_seq - 1)::text as sequence`,
            [organizationId],
          );
          const sequence = clock.rows[0]?.sequence;
          if (!sequence) throw new Error("EVENT_CLOCK_UNAVAILABLE");
          const inserted = await transaction.query<{ id: string }>(
            `insert into bakery.domain_events (
               organization_id, organization_sequence, event_type, schema_version,
               application_id, repository_id, task_id, conversation_id,
               aggregate_id, aggregate_version, payload, trace_id
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
             returning id`,
            [
              organizationId,
              sequence,
              event.eventType,
              event.schemaVersion ?? 1,
              event.applicationId === undefined
                ? applicationId
                : event.applicationId,
              event.repositoryId ?? null,
              event.taskId === undefined ? taskId : event.taskId,
              event.conversationId === undefined
                ? conversationId
                : event.conversationId,
              aggregateId,
              aggregateVersion,
              JSON.stringify(
                event.payload ?? {
                  resourceId: aggregateId,
                  resourceVersion: aggregateVersion,
                },
              ),
              event.traceId ?? null,
            ],
          );
          const id = inserted.rows[0]?.id;
          if (!id) throw new Error("DOMAIN_EVENT_INSERT_FAILED");
          if (event.expired) {
            await transaction.query(
              `update bakery.event_clock
                  set retained_from_seq = next_seq
                where organization_id = $1 and stream = 'domain_events'`,
              [organizationId],
            );
          }
          return { id, sequence };
        },
      );
    };
    return {
      app: authFixture.app,
      auth: authFixture.auth,
      database: authFixture.database,
      pgDatabase: authFixture.pgDatabase,
      runtimePgDatabase: authFixture.runtimePgDatabase,
      config: authFixture.config,
      email,
      password,
      cookie,
      principalId,
      organizationId,
      applicationId,
      taskId,
      conversationId,
      connect,
      insertDomainEvent,
      assertFrame,
      close: async () => {
        const openClients = [...clients];
        clients.clear();
        await Promise.allSettled(
          openClients.map((client) => client.close()),
        );
        await server?.shutdown();
        await cleanupAuthFixture(authFixture.pgDatabase, [email]);
        await authFixture.close();
      },
    };
  } catch (error) {
    await Promise.allSettled([...clients].map((client) => client.close()));
    await server?.shutdown();
    await cleanupAuthFixture(authFixture.pgDatabase, [email]);
    await authFixture.close();
    throw error;
  }
}
