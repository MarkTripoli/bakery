/**
 * Fixtures for the issue 82 automation lane. This is not a test module: it only
 * exports. It builds on `fixtures.ts` (which Phases 4 and 5 own) and adds what
 * the webhook and poll functions need: the live reader over the fake GitHub, a
 * signed delivery that becomes a route, the function bodies run with inline
 * steps, a read probe that looks for `idle in transaction` backends, and a
 * live attempt for the run pause.
 */
import { assert, assertEquals } from "@std/assert";
import type { Inngest } from "inngest";
import { readWebhookSecret } from "../../../apps/server/src/modules/integrations/intake-receipts.ts";
import { upsertFact } from "../../../apps/server/src/modules/integrations/remote-facts.ts";
import { createTicketSourceReader } from "../../../apps/server/src/modules/integrations/ticket-reads.ts";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import type { TicketSourceReader } from "../../../apps/server/src/modules/work/ticket-source-reader.ts";
import {
  createTicketIntakeWorkflow,
  createTicketPollWorkflow,
  type TicketIntakeOutcome,
  type TicketWorkflowDeps,
} from "../../../apps/server/src/modules/work/ticket-workflows.ts";
import { type FakeIssueSeed, fakeTimestamp } from "../fake-github-app.ts";
import { presetBudgetPolicy } from "../fixed-coding-preset.ts";
import {
  issuesPayload,
  receipt,
  routeRows,
} from "../github-intake/receipts-shared.ts";
import {
  ACCEPTANCE_BODY,
  AFTER_SINCE,
  createMemoryFactIndex,
  EXECUTE_LABEL,
  LABELER_ID,
  LABELER_LOGIN,
  openTicketFixture,
  type TicketFixture,
} from "./fixtures.ts";

const INTAKE_EVENT = "bakery/intake.received.v1";

/** A function body run with inline steps, as the #71 processor lane runs its own. */
export function captureFunction(create: (client: Inngest) => unknown) {
  let handler:
    | ((context: { event?: unknown; step: unknown }) => Promise<unknown>)
    | undefined;
  const captured: { config: Record<string, unknown>; steps: string[] } = {
    config: {},
    steps: [],
  };
  const client = {
    createFunction(options: Record<string, unknown>, body: typeof handler) {
      captured.config = options;
      handler = body;
      return {};
    },
  } as unknown as Inngest;
  create(client);
  return {
    ...captured,
    run: (event?: unknown) =>
      handler!({
        event,
        step: {
          run: async <T>(id: string, work: () => Promise<T>) => {
            captured.steps.push(id);
            return await work();
          },
        },
      }),
  };
}

/** The fixture plus the live reader over the fake GitHub, deliveries and the two function bodies. */
export type AutomationFixture = Awaited<
  ReturnType<typeof openAutomationFixture>
>;

export async function openAutomationFixture() {
  const fx = await openTicketFixture({ label: "issue82-automation" });
  try {
    const github = fx.f.github;
    const repositoryId = Number(fx.resource.external_id);
    const stored = await readWebhookSecret(fx.runtime, fx.f.secretsKey);
    assert(stored !== null, "the fake App registered a webhook secret");
    const secret = new TextDecoder().decode(stored.secret);
    stored.secret.fill(0);
    const installation = await fx.owner.query<
      { external_authorization_id: string }
    >("select external_authorization_id from bakery.integration_installations");
    const target = {
      installationId: Number(installation.rows[0].external_authorization_id),
      repositoryId,
    };
    const live = createTicketSourceReader({
      database: fx.runtime,
      github: github.client,
      secretsKey: fx.f.secretsKey,
      broker: fx.f.broker,
    });
    const index = createMemoryFactIndex();
    const deps = (
      overrides: Partial<TicketWorkflowDeps> = {},
    ): TicketWorkflowDeps => ({
      database: fx.runtime,
      reader: live,
      factIndex: index,
      budget: presetBudgetPolicy,
      ...overrides,
    });

    const automation = {
      fx,
      live,
      index,
      repositoryId,
      deps,

      /** The labeler of the default policy, as the fake GitHub knows it. */
      seedLabeler() {
        github.seedCollaborator(repositoryId, LABELER_LOGIN, {
          id: Number(LABELER_ID),
          permission: "write",
        });
      },

      /** A ready issue in the fake GitHub: acceptance criteria and its labels applied by the labeler. */
      issue(number: number, labels: string[] = [EXECUTE_LABEL]) {
        github.seedIssues(repositoryId, [{ number, labels }]);
        github.seedIssueDetail(repositoryId, number, {
          title: `Issue ${number}`,
          body: ACCEPTANCE_BODY,
        });
        for (const label of labels) {
          github.seedIssueEvent(repositoryId, number, {
            event: "labeled",
            label,
            actor: { id: Number(LABELER_ID), login: LABELER_LOGIN },
            createdAt: fakeTimestamp(Date.parse(AFTER_SINCE)),
          });
        }
      },

      edit(number: number, patch: FakeIssueSeed) {
        github.editIssue(repositoryId, number, patch);
      },

      /** A signed `issues` delivery through the application; returns the route it created. */
      async deliver(number: number, action = "labeled"): Promise<string> {
        const accepted = await receipt({ f: fx.f, secret }, {
          event: "issues",
          payload: issuesPayload(target, number, action),
        });
        const routes = await routeRows(fx.f, accepted.eventId);
        assertEquals(routes.length, 1);
        return routes[0].id;
      },

      /** Runs the intake function body for the `intake.received` event of a route. */
      intake(routeId: string, overrides: Partial<TicketWorkflowDeps> = {}) {
        const fn = captureFunction((client) =>
          createTicketIntakeWorkflow({ client, ...deps(overrides) })
        );
        return fn.run({
          name: INTAKE_EVENT,
          data: { aggregateId: routeId },
        }) as Promise<TicketIntakeOutcome>;
      },

      /** Runs the poll function body once; `sourcesPerRun` lowers the run's source cap. */
      poll(
        overrides: Partial<TicketWorkflowDeps> & { sourcesPerRun?: number } =
          {},
      ) {
        const { sourcesPerRun, ...rest } = overrides;
        const fn = captureFunction((client) =>
          createTicketPollWorkflow({
            client,
            sourcesPerRun,
            ...deps(rest),
          })
        );
        return fn.run() as Promise<
          { sources: number; outcomes: PollRunOutcome[] }
        >;
      },

      /** Every request of a source with the columns the cases compare. */
      async requests(sourceId: string) {
        const result = await fx.owner.query<RequestRow>(
          `select ticket.number, request.disposition,
                  request.disposition_reason, request.origin,
                  request.workflow_run_id, request.pause_requested_at,
                  request.inbound_event_route_id, request.authority_principal_id
             from bakery.ticket_requests as request
             join bakery.external_tickets as ticket
               on ticket.id = request.external_ticket_id
            where request.organization_id = $1 and ticket.ticket_source_id = $2
            order by ticket.number, request.generation`,
          [fx.organizationId, sourceId],
        );
        return result.rows;
      },

      async source(sourceId: string) {
        const result = await fx.owner.query<SourceRow>(
          `select sync_checkpoint, sync_health, last_synced_at,
                  last_problem_code, version, policy_revision
             from bakery.ticket_sources where organization_id = $1 and id = $2`,
          [fx.organizationId, sourceId],
        );
        return result.rows[0];
      },
    };
    return automation;
  } catch (error) {
    await fx.close();
    throw error;
  }
}

export type RequestRow = {
  number: string;
  disposition: string;
  disposition_reason: string | null;
  origin: string;
  workflow_run_id: string | null;
  pause_requested_at: Date | null;
  inbound_event_route_id: string | null;
  authority_principal_id: string;
};

export type SourceRow = {
  sync_checkpoint: Record<string, unknown> | null;
  sync_health: string;
  last_synced_at: Date | null;
  last_problem_code: string | null;
  version: number;
  policy_revision: number;
};

export type PollRunOutcome = {
  sourceId: string;
  outcome: string;
  health: string | null;
  problemCode: string | null;
  candidates: number;
  admitted: number;
  rechecked: number;
  errorName?: string;
  candidateNumber?: number;
};

/** Runs `work` with an automation fixture and closes it whatever `work` does. */
export async function withAutomation<T>(
  work: (automation: AutomationFixture) => Promise<T>,
): Promise<T> {
  const automation = await openAutomationFixture();
  try {
    return await work(automation);
  } finally {
    await automation.fx.close();
  }
}

/** An issue the scripted reader and the fact index both know, labeled by the labeler inside the window. */
export function memoryIssue(
  { fx, index }: Pick<AutomationFixture, "fx" | "index">,
  number: number,
  updatedAt: string,
  labels: string[] = [EXECUTE_LABEL],
) {
  fx.reader.setIssue({ number, labels, updatedAt });
  for (const label of labels) {
    fx.reader.setLabelApplied(number, label, { appliedAt: AFTER_SINCE });
  }
  index.set(number, updatedAt, labels);
}

/** An issue fact in `integration_remote_facts`, which the live fact index reads. */
export async function seedFact(
  { fx }: Pick<AutomationFixture, "fx">,
  number: number,
  updatedAt: string,
  labels: string[],
) {
  await fx.inTransaction((transaction) =>
    upsertFact(transaction, {
      organizationId: fx.organizationId,
      resourceId: fx.resource.id,
      kind: "issue",
      externalId: String(1000 + number),
      number,
      headSha: null,
      state: "open",
      conclusion: null,
      providerUpdatedAt: new Date(updatedAt),
      observedStartedAt: new Date(updatedAt),
      summary: { labels, locked: false, stateReason: null },
    })
  );
}

/**
 * Backends of the application role that sit `idle in transaction`, counted on
 * a second pooled connection of the same role (PostgreSQL shows a session's
 * state only to its own role or a superuser).
 */
export async function idleInTransaction(fx: TicketFixture): Promise<number> {
  const result = await fx.runtime.query<{ n: string }>(
    `select count(*) as n from pg_stat_activity
      where datname = current_database() and usename = current_user
        and state = 'idle in transaction'`,
  );
  return Number(result.rows[0].n);
}

/**
 * A pool whose first plain `query` that contains `match` runs `after` once it
 * has answered: the way to change the database between the two steps of a
 * function that lists rows, then acts on them. Transactions are untouched.
 */
export function afterQuery(
  pool: PgDatabase,
  match: string,
  after: () => Promise<void>,
): PgDatabase {
  let fired = false;
  return new Proxy(pool, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "query") return value.bind(target);
      return async (...args: unknown[]) => {
        const answer = await value.apply(target, args);
        if (!fired && typeof args[0] === "string" && args[0].includes(match)) {
          fired = true;
          await after();
        }
        return answer;
      };
    },
  });
}

/**
 * A pool whose transactions answer every statement that contains `match` with
 * `answer`, instead of running it. A transaction's statements go through the
 * client the pool lends, which `afterQuery` leaves alone.
 */
function answeringTransactions(
  pool: PgDatabase,
  match: string,
  answer: () => Promise<unknown>,
): PgDatabase {
  return new Proxy(pool, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "connect") return value.bind(target);
      return async (...args: unknown[]) => {
        const client = await value.apply(target, args);
        return new Proxy(client, {
          get(clientTarget, clientProperty, clientReceiver) {
            const member = Reflect.get(
              clientTarget,
              clientProperty,
              clientReceiver,
            );
            if (typeof member !== "function") return member;
            if (clientProperty !== "query") return member.bind(clientTarget);
            return (...queryArgs: unknown[]) =>
              typeof queryArgs[0] === "string" && queryArgs[0].includes(match)
                ? answer()
                : member.apply(clientTarget, queryArgs);
          },
        });
      };
    },
  });
}

/**
 * A pool whose transactions read no row for a statement that contains `match`,
 * as if the rows it joins were gone. The foreign keys of a source keep its
 * connection and resource in place, so a missing one cannot be made with SQL.
 */
export function withoutRows(pool: PgDatabase, match: string): PgDatabase {
  return answeringTransactions(
    pool,
    match,
    () =>
      Promise.resolve({
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        rows: [],
        fields: [],
      }),
  );
}

/**
 * A pool whose transactions fail every statement that contains `match` with a
 * plain `Error` that says `message`: a defect thrown inside a transaction.
 */
export function failingStatements(
  pool: PgDatabase,
  match: string,
  message = `statement refused: ${match}`,
): PgDatabase {
  return answeringTransactions(
    pool,
    match,
    () => Promise.reject(new Error(message)),
  );
}

/**
 * A reader that runs `after` once the first `method` read has answered: the
 * way to change a source between a function's provider reads and its write.
 */
export function afterRead(
  reader: TicketSourceReader,
  method: keyof TicketSourceReader,
  after: () => Promise<void>,
): TicketSourceReader {
  let fired = false;
  return new Proxy(reader, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const answer = await value.apply(target, args);
        if (!fired && property === method) {
          fired = true;
          await after();
        }
        return answer;
      };
    },
  });
}

/**
 * A reader that is slow: each call waits, then samples the `idle in
 * transaction` count, then delegates. A transaction held open across the read
 * shows up in the sample.
 */
export function slowReader(fx: TicketFixture, reader: TicketSourceReader) {
  const samples: { method: string; idle: number }[] = [];
  const slow = new Proxy(reader, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        samples.push({
          method: String(property),
          idle: await idleInTransaction(fx),
        });
        return await value.apply(target, args);
      };
    },
  });
  return { reader: slow, samples };
}

/** A live job attempt on a worker host for the run's first step, as the worker would hold it. */
export async function seedAttempt(
  fx: TicketFixture,
  runId: string,
  adapterCapabilities: string[],
) {
  const ids = {
    job: crypto.randomUUID(),
    principal: crypto.randomUUID(),
    host: crypto.randomUUID(),
    attempt: crypto.randomUUID(),
    session: crypto.randomUUID(),
  };
  const step = await fx.owner.query<{ id: string }>(
    `select id from bakery.run_steps where organization_id = $1 and run_id = $2
      order by position, iteration limit 1`,
    [fx.organizationId, runId],
  );
  const org = fx.organizationId;
  await fx.owner.query(
    `insert into bakery.jobs (id, organization_id, run_step_id, action, input,
       requirements, status, current_fence)
     values ($1, $2, $3, 'harness.implement', '{}', '{}', 'running', 1)`,
    [ids.job, org, step.rows[0].id],
  );
  await fx.owner.query(
    `insert into bakery.principals (id, display_name, principal_type)
     values ($1, 'Automation pause worker', 'worker')`,
    [ids.principal],
  );
  await fx.owner.query(
    `insert into bakery.worker_hosts (id, organization_id, principal_id,
       principal_type, name, os, architecture, capabilities, slots,
       credential_hash, worker_session_id, worker_session_generation,
       adapter_capabilities)
     values ($1, $2, $3, 'worker', 'Automation pause host', 'linux', 'x64', '[]',
       1, $4, $5, 0, $6::jsonb)`,
    [
      ids.host,
      org,
      ids.principal,
      `pause-${ids.host}`,
      ids.session,
      JSON.stringify(adapterCapabilities),
    ],
  );
  await fx.owner.query(
    `insert into bakery.job_attempts (id, organization_id, job_id,
       worker_host_id, worker_session_id, worker_session_generation, attempt_no,
       fence, lease_token_hash, lease_expires_at, status, started_at)
     values ($1, $2, $3, $4, $5, 0, 1, 1, $6,
       clock_timestamp() + interval '5 minutes', 'running', clock_timestamp())`,
    [ids.attempt, org, ids.job, ids.host, ids.session, `lease-${ids.attempt}`],
  );
  return {
    commands: async () =>
      (await fx.owner.query<{ idempotency_key: string }>(
        `select idempotency_key from bakery.worker_commands
          where organization_id = $1 and attempt_id = $2`,
        [org, ids.attempt],
      )).rows,
    async cleanup() {
      await fx.owner.query(
        "delete from bakery.worker_commands where attempt_id = $1",
        [ids.attempt],
      );
      await fx.owner.query("delete from bakery.job_attempts where id = $1", [
        ids.attempt,
      ]);
      await fx.owner.query("delete from bakery.jobs where id = $1", [ids.job]);
      await fx.owner.query("delete from bakery.worker_hosts where id = $1", [
        ids.host,
      ]);
      await fx.owner.query("delete from bakery.principals where id = $1", [
        ids.principal,
      ]);
    },
  };
}
