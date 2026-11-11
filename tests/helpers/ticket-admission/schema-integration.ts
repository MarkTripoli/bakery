import { assert, assertEquals } from "@std/assert";
import { defaultTicketSourcePolicy } from "../../../packages/contracts/src/ticket-admission.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import { enabledConnection } from "../github-app-registration.ts";
import { withFixture } from "../github-intake/receipts-shared.ts";
import {
  removeSeed,
  type SeededTask,
  seedTaskAndRepository,
} from "../github-intake/seed.ts";

/**
 * Issue 82 schema: the structure migration 0145 leaves behind that the
 * TypeScript admission leans on, read back from a migrated database and
 * exercised with real rows as the owner role.
 */

const TABLES = [
  "ticket_sources",
  "external_tickets",
  "ticket_task_links",
  "ticket_readiness_reports",
  "ticket_requests",
] as const;

const SHA = "b".repeat(64);
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_INSUFFICIENT_PRIVILEGE = "42501";

/** SQLSTATE and constraint name of a failed statement. */
async function violation(
  statement: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await statement;
  } catch (error) {
    const read = (key: string) =>
      typeof error === "object" && error !== null && key in error
        ? String((error as Record<string, unknown>)[key])
        : undefined;
    return { code: read("code"), constraint: read("constraint") };
  }
  throw new Error("the statement was expected to fail");
}

type Seeded = {
  organizationId: string;
  sourceId: string;
  adminId: string;
  seed: SeededTask;
  /** Database owner: seeds rows and reads them back. */
  owner: PgDatabase;
  /** The application role `bakery_app`, with exactly its grants. */
  app: PgDatabase;
  ticket(number: number): Promise<string>;
  task(): Promise<string>;
  link(ticketId: string, taskId: string, role: string): Promise<string>;
  report(ticketId: string, version: number): Promise<string>;
  request(
    ticketId: string,
    linkId: string,
    generation: number,
    disposition: string,
    reportId?: string | null,
  ): Promise<string>;
};

async function withTicketRows(
  run: (seeded: Seeded) => Promise<void>,
): Promise<void> {
  await withFixture(async (f) => {
    const connection = await enabledConnection(f, { selected: 1 });
    const resource = connection.selected[0];
    const seed = await seedTaskAndRepository(f, resource);
    const owner = f.pgDatabase;
    const app = f.runtimePgDatabase;
    assert(app, "the fixture opens the application-role pool");
    const sourceId = crypto.randomUUID();
    const organizationId = resource.organization_id;
    const created: { tasks: string[]; conversations: string[] } = {
      tasks: [],
      conversations: [],
    };
    try {
      await owner.query(
        `insert into bakery.ticket_sources
           (id, organization_id, integration_connection_id,
            integration_resource_id, application_id, repository_id,
            external_container_id, enabled, policy)
         values ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb)`,
        [
          sourceId,
          organizationId,
          resource.connection_id,
          resource.id,
          seed.applicationId,
          seed.repositoryId,
          resource.external_id,
          JSON.stringify(defaultTicketSourcePolicy()),
        ],
      );
      const seeded: Seeded = {
        organizationId,
        sourceId,
        adminId: f.adminId,
        seed,
        owner,
        app,
        async ticket(number) {
          const id = crypto.randomUUID();
          await owner.query(
            `insert into bakery.external_tickets
               (id, organization_id, ticket_source_id, external_ticket_id,
                key, number, safe_url, snapshot, requirements_digest,
                provider_update_marker, visibility, state, last_observed_at)
             values ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9,
               'private', 'open', now())`,
            [
              id,
              organizationId,
              sourceId,
              String(9000 + number),
              `${resource.display_name}#${number}`,
              String(number),
              `https://github.com/${resource.display_name}/issues/${number}`,
              SHA,
              "2026-11-01T00:00:00.000Z",
            ],
          );
          return id;
        },
        async task() {
          const conversationId = crypto.randomUUID();
          const taskId = crypto.randomUUID();
          await owner.query(
            `insert into bakery.conversations
               (id, organization_id, application_id, repository_id, title, created_by)
             values ($1, $2, $3, $4, 'Ticket schema', $5)`,
            [
              conversationId,
              organizationId,
              seed.applicationId,
              seed.repositoryId,
              f.adminId,
            ],
          );
          await owner.query(
            `insert into bakery.tasks
               (id, organization_id, application_id, repository_id,
                conversation_id, title, task_type, created_by)
             values ($1, $2, $3, $4, $5, 'Ticket schema', 'feature', $6)`,
            [
              taskId,
              organizationId,
              seed.applicationId,
              seed.repositoryId,
              conversationId,
              f.adminId,
            ],
          );
          created.tasks.push(taskId);
          created.conversations.push(conversationId);
          return taskId;
        },
        async link(ticketId, taskId, role) {
          const id = crypto.randomUUID();
          await owner.query(
            `insert into bakery.ticket_task_links
               (id, organization_id, external_ticket_id, task_id, role)
             values ($1, $2, $3, $4, $5)`,
            [id, organizationId, ticketId, taskId, role],
          );
          return id;
        },
        async report(ticketId, version) {
          const id = crypto.randomUUID();
          await owner.query(
            `insert into bakery.ticket_readiness_reports
               (id, organization_id, external_ticket_id, version, verdict,
                basis_digest, requirements_digest, dependency_digest,
                source_policy_revision, preset, checks, origin, evaluated_at)
             values ($1, $2, $3, $4, 'ready', $5, $5, null, 1, $6::jsonb,
               '[]'::jsonb, 'manual', now())`,
            [
              id,
              organizationId,
              ticketId,
              version,
              SHA,
              JSON.stringify({ id: "fixed-coding", revision: 1, digest: SHA }),
            ],
          );
          return id;
        },
        async request(ticketId, linkId, generation, disposition, reportId) {
          const id = crypto.randomUUID();
          await owner.query(
            `insert into bakery.ticket_requests
               (id, organization_id, ticket_task_link_id, external_ticket_id,
                intent, generation, origin, authority_principal_id,
                authority_evidence, source_policy_revision,
                requirements_digest, readiness_report_id, pinned_preset,
                disposition)
             values ($1, $2, $3, $4, 'start', $5, 'manual', $6, '{}'::jsonb, 1,
               $7, $8, $9::jsonb, $10)`,
            [
              id,
              organizationId,
              linkId,
              ticketId,
              generation,
              f.adminId,
              SHA,
              reportId ?? null,
              JSON.stringify({ id: "fixed-coding", revision: 1, digest: SHA }),
              disposition,
            ],
          );
          return id;
        },
      };
      await run(seeded);
    } finally {
      // The owner deletes children first; nothing here relies on cascades.
      const scope = [organizationId];
      await owner.query(
        "delete from bakery.ticket_requests where organization_id = $1",
        scope,
      );
      await owner.query(
        "delete from bakery.ticket_task_links where organization_id = $1",
        scope,
      );
      await owner.query(
        "delete from bakery.ticket_readiness_reports where organization_id = $1",
        scope,
      );
      await owner.query(
        "delete from bakery.external_tickets where organization_id = $1",
        scope,
      );
      await owner.query(
        "delete from bakery.ticket_sources where organization_id = $1",
        scope,
      );
      if (created.tasks.length > 0) {
        await owner.query(
          "delete from bakery.tasks where organization_id = $1 and id = any($2::uuid[])",
          [organizationId, created.tasks],
        );
        await owner.query(
          "delete from bakery.conversations where organization_id = $1 and id = any($2::uuid[])",
          [organizationId, created.conversations],
        );
      }
      await removeSeed(f, seed);
    }
  });
}

Deno.test("issue 82 schema: migration 0145 creates the five tables with named constraints, no CHECK and no trigger", async () => {
  await withFixture(async (f) => {
    for (const table of TABLES) {
      const present = await f.pgDatabase.query<{ found: boolean }>(
        "select to_regclass($1) is not null as found",
        [`bakery.${table}`],
      );
      assertEquals(present.rows[0].found, true, `${table} exists`);
    }
    const constraints = await f.pgDatabase.query<
      { table: string; name: string; type: string }
    >(
      `select tbl.relname as "table", con.conname as name, con.contype as type
         from pg_constraint as con
         join pg_class as tbl on tbl.oid = con.conrelid
         join pg_namespace as ns on ns.oid = tbl.relnamespace
        where ns.nspname = 'bakery' and tbl.relname = any($1::text[])
        order by tbl.relname, con.conname`,
      [TABLES],
    );
    assertEquals(
      constraints.rows.filter((row) => row.type === "c").length,
      0,
      "PostgreSQL holds structure only: no CHECK constraint",
    );
    const names = (table: string) =>
      constraints.rows.filter((row) => row.table === table).map((row) =>
        row.name
      );
    assertEquals(names("ticket_sources"), [
      "ticket_sources_application_fk",
      "ticket_sources_connection_fk",
      "ticket_sources_container_unique",
      "ticket_sources_organization_fk",
      "ticket_sources_organization_id_unique",
      "ticket_sources_pkey",
      "ticket_sources_repository_fk",
      "ticket_sources_resource_fk",
    ]);
    assertEquals(names("external_tickets"), [
      "external_tickets_identity_unique",
      "external_tickets_organization_fk",
      "external_tickets_organization_id_unique",
      "external_tickets_pkey",
      "external_tickets_source_fk",
    ]);
    assertEquals(names("ticket_task_links"), [
      "ticket_task_links_organization_fk",
      "ticket_task_links_organization_id_unique",
      "ticket_task_links_pair_unique",
      "ticket_task_links_pkey",
      "ticket_task_links_task_fk",
      "ticket_task_links_ticket_fk",
      "ticket_task_links_ticket_id_unique",
    ]);
    assertEquals(names("ticket_readiness_reports"), [
      "ticket_readiness_reports_organization_fk",
      "ticket_readiness_reports_organization_id_unique",
      "ticket_readiness_reports_pkey",
      "ticket_readiness_reports_ticket_fk",
      "ticket_readiness_reports_ticket_id_unique",
      "ticket_readiness_reports_version_unique",
    ]);
    assertEquals(names("ticket_requests"), [
      "ticket_requests_authority_principal_fk",
      "ticket_requests_link_fk",
      "ticket_requests_link_generation_unique",
      "ticket_requests_organization_fk",
      "ticket_requests_organization_id_unique",
      "ticket_requests_pkey",
      "ticket_requests_report_fk",
      "ticket_requests_route_fk",
      "ticket_requests_run_fk",
      "ticket_requests_ticket_fk",
    ]);
    const triggers = await f.pgDatabase.query(
      `select 1 from pg_trigger as trg
         join pg_class as tbl on tbl.oid = trg.tgrelid
         join pg_namespace as ns on ns.oid = tbl.relnamespace
        where ns.nspname = 'bakery' and tbl.relname = any($1::text[])
          and not trg.tgisinternal`,
      [TABLES],
    );
    assertEquals(triggers.rows.length, 0, "no trigger on the five tables");
    const routeKey = await f.pgDatabase.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'ticket_requests_route_fk'`,
    );
    assert(
      routeKey.rows[0].definition.includes(
        "ON DELETE SET NULL (inbound_event_route_id)",
      ),
      "receipt retention nulls only the route pointer",
    );
  });
});

Deno.test("issue 82 schema: both partial unique indexes carry their predicates", async () => {
  await withFixture(async (f) => {
    const definitions = await f.pgDatabase.query<
      { name: string; definition: string }
    >(
      `select indexname as name, indexdef as definition from pg_indexes
        where schemaname = 'bakery'
          and indexname in ('ticket_requests_one_nonterminal_idx',
                            'ticket_task_links_one_primary_idx')
        order by indexname`,
    );
    assertEquals(definitions.rows.length, 2);
    const byName = new Map(
      definitions.rows.map((row) => [row.name, row.definition]),
    );
    const slot = byName.get("ticket_requests_one_nonterminal_idx")!;
    assert(slot.includes("UNIQUE"));
    assert(slot.includes("(external_ticket_id)"));
    for (const open of ["waiting", "admitted", "active", "suspended"]) {
      assert(slot.includes(`'${open}'`), `the slot is held by ${open}`);
    }
    for (
      const closed of ["pending", "rejected", "completed", "failed", "canceled"]
    ) {
      assert(!slot.includes(`'${closed}'`), `${closed} does not hold the slot`);
    }
    const primary = byName.get("ticket_task_links_one_primary_idx")!;
    assert(primary.includes("UNIQUE"));
    assert(primary.includes("(organization_id, task_id)"));
    assert(primary.includes("role = 'primary'"));
  });
});

Deno.test("issue 82 schema: one nonterminal request per ticket, terminal generations free the slot", async () => {
  await withTicketRows(async (rows) => {
    const ticket = await rows.ticket(1);
    const first = await rows.task();
    const second = await rows.task();
    const firstLink = await rows.link(ticket, first, "primary");
    const secondLink = await rows.link(ticket, second, "reference");
    const firstRequest = await rows.request(ticket, firstLink, 1, "suspended");

    assertEquals(
      await violation(rows.request(ticket, secondLink, 2, "waiting")),
      {
        code: PG_UNIQUE_VIOLATION,
        constraint: "ticket_requests_one_nonterminal_idx",
      },
      "a second nonterminal request is refused by the database",
    );
    assertEquals(
      await violation(rows.request(ticket, firstLink, 1, "completed")),
      {
        code: PG_UNIQUE_VIOLATION,
        constraint: "ticket_requests_link_generation_unique",
      },
      "a generation number repeats per link at most once",
    );

    await rows.request(ticket, secondLink, 2, "completed");
    await rows.request(ticket, secondLink, 3, "failed");
    await rows.owner.query(
      "update bakery.ticket_requests set disposition = 'canceled' where id = $1",
      [firstRequest],
    );
    await rows.request(ticket, secondLink, 4, "active");
    const open = await rows.owner.query<{ count: string }>(
      `select count(*) from bakery.ticket_requests
        where external_ticket_id = $1
          and disposition in ('waiting', 'admitted', 'active', 'suspended')`,
      [ticket],
    );
    assertEquals(open.rows[0].count, "1");
  });
});

Deno.test("issue 82 schema: a task has one primary link, a request's ticket equals its link's ticket", async () => {
  await withTicketRows(async (rows) => {
    const ticketA = await rows.ticket(1);
    const ticketB = await rows.ticket(2);
    const task = await rows.task();
    const other = await rows.task();
    const linkA = await rows.link(ticketA, task, "primary");

    assertEquals(
      await violation(rows.link(ticketB, task, "primary")),
      {
        code: PG_UNIQUE_VIOLATION,
        constraint: "ticket_task_links_one_primary_idx",
      },
      "a second primary link on one task is refused",
    );
    await rows.link(ticketB, task, "reference");
    assertEquals(
      await violation(rows.link(ticketA, task, "reference")),
      {
        code: PG_UNIQUE_VIOLATION,
        constraint: "ticket_task_links_pair_unique",
      },
      "a ticket links a task once",
    );
    await rows.link(ticketB, other, "primary");

    assertEquals(
      await violation(rows.request(ticketB, linkA, 1, "waiting")),
      {
        code: PG_FOREIGN_KEY_VIOLATION,
        constraint: "ticket_requests_link_fk",
      },
      "a request cannot name one ticket and another ticket's link",
    );
    await rows.request(ticketA, linkA, 1, "waiting");
  });
});

Deno.test("issue 82 schema: a request pins a report of its own ticket and report versions are unique per ticket", async () => {
  await withTicketRows(async (rows) => {
    const ticketA = await rows.ticket(1);
    const ticketB = await rows.ticket(2);
    const task = await rows.task();
    const link = await rows.link(ticketA, task, "primary");
    const reportA = await rows.report(ticketA, 1);
    const reportB = await rows.report(ticketB, 1);

    assertEquals(
      await violation(rows.report(ticketA, 1)),
      {
        code: PG_UNIQUE_VIOLATION,
        constraint: "ticket_readiness_reports_version_unique",
      },
      "a report version repeats per ticket at most once",
    );
    await rows.report(ticketA, 2);
    assertEquals(
      await violation(rows.request(ticketA, link, 1, "waiting", reportB)),
      {
        code: PG_FOREIGN_KEY_VIOLATION,
        constraint: "ticket_requests_report_fk",
      },
      "a request cannot pin another ticket's report",
    );
    await rows.request(ticketA, link, 1, "waiting", reportA);
  });
});

Deno.test("issue 82 schema: reports are insert-only and the other tables keep identity columns out of reach", async () => {
  await withFixture(async (f) => {
    const table = (name: string, privilege: string) =>
      f.pgDatabase.query<{ granted: boolean }>(
        "select has_table_privilege('bakery_app', $1, $2) as granted",
        [`bakery.${name}`, privilege],
      ).then((result) => result.rows[0].granted);
    const column = (name: string, columnName: string) =>
      f.pgDatabase.query<{ granted: boolean }>(
        `select has_column_privilege('bakery_app', $1, $2, 'update') as granted`,
        [`bakery.${name}`, columnName],
      ).then((result) => result.rows[0].granted);

    for (const name of TABLES) {
      assertEquals(await table(name, "select"), true, `${name} select`);
      assertEquals(await table(name, "insert"), true, `${name} insert`);
      assertEquals(await table(name, "delete"), false, `${name} delete`);
      assertEquals(await table(name, "update"), false, `${name} table update`);
    }
    const mutable: Record<string, string[]> = {
      ticket_sources: [
        "enabled",
        "policy",
        "policy_revision",
        "sync_checkpoint",
        "sync_health",
        "last_synced_at",
        "last_problem_code",
        "updated_at",
        "version",
      ],
      external_tickets: [
        "key",
        "number",
        "safe_url",
        "snapshot",
        "requirements_digest",
        "provider_update_marker",
        "visibility",
        "state",
        "last_observed_at",
        "updated_at",
        "version",
      ],
      ticket_task_links: [
        "status_comment_external_id",
        "last_synced_run_revision",
        "sync_health",
        "last_problem_code",
        "updated_at",
        "version",
      ],
      ticket_requests: [
        "intent",
        "source_policy_revision",
        "requirements_digest",
        "readiness_report_id",
        "disposition",
        "disposition_reason",
        "workflow_run_id",
        "pause_requested_at",
        "updated_at",
        "version",
      ],
    };
    for (const [name, columns] of Object.entries(mutable)) {
      for (const columnName of columns) {
        assertEquals(
          await column(name, columnName),
          true,
          `${name}.${columnName} updates`,
        );
      }
    }
    const frozen: Record<string, string[]> = {
      ticket_sources: [
        "id",
        "organization_id",
        "provider",
        "integration_connection_id",
        "integration_resource_id",
        "application_id",
        "repository_id",
        "external_container_id",
        "created_at",
      ],
      external_tickets: [
        "id",
        "organization_id",
        "ticket_source_id",
        "external_ticket_id",
        "created_at",
      ],
      ticket_task_links: [
        "id",
        "organization_id",
        "external_ticket_id",
        "task_id",
        "role",
        "created_at",
      ],
      ticket_requests: [
        "id",
        "organization_id",
        "ticket_task_link_id",
        "external_ticket_id",
        "generation",
        "origin",
        "authority_principal_id",
        "authority_evidence",
        "inbound_event_route_id",
        "pinned_preset",
        "created_at",
      ],
      ticket_readiness_reports: [
        "verdict",
        "basis_digest",
        "checks",
        "preset",
        "version",
        "external_ticket_id",
        "created_at",
      ],
    };
    for (const [name, columns] of Object.entries(frozen)) {
      for (const columnName of columns) {
        assertEquals(
          await column(name, columnName),
          false,
          `${name}.${columnName} has no update grant`,
        );
      }
    }
  });
});

const UPDATE_COLUMNS: Record<typeof TABLES[number], string[]> = {
  ticket_sources: [
    "enabled",
    "policy",
    "policy_revision",
    "sync_checkpoint",
    "sync_health",
    "last_synced_at",
    "last_problem_code",
    "updated_at",
    "version",
  ],
  external_tickets: [
    "key",
    "number",
    "safe_url",
    "snapshot",
    "requirements_digest",
    "provider_update_marker",
    "visibility",
    "state",
    "last_observed_at",
    "updated_at",
    "version",
  ],
  ticket_task_links: [
    "status_comment_external_id",
    "last_synced_run_revision",
    "sync_health",
    "last_problem_code",
    "updated_at",
    "version",
  ],
  ticket_readiness_reports: [],
  ticket_requests: [
    "intent",
    "source_policy_revision",
    "requirements_digest",
    "readiness_report_id",
    "disposition",
    "disposition_reason",
    "workflow_run_id",
    "pause_requested_at",
    "updated_at",
    "version",
  ],
};

Deno.test("issue 82 schema: bakery_app updates exactly the documented columns of each table", async () => {
  await withFixture(async (f) => {
    for (const table of TABLES) {
      const granted = await f.pgDatabase.query<{ name: string }>(
        `select att.attname as name
           from pg_attribute as att
           join pg_class as tbl on tbl.oid = att.attrelid
           join pg_namespace as ns on ns.oid = tbl.relnamespace
          where ns.nspname = 'bakery' and tbl.relname = $1
            and att.attnum > 0 and not att.attisdropped
            and has_column_privilege('bakery_app', tbl.oid, att.attnum, 'update')`,
        [table],
      );
      assertEquals(
        granted.rows.map((row) => row.name).sort(),
        [...UPDATE_COLUMNS[table]].sort(),
        `${table}: columns bakery_app may update`,
      );
    }
  });
});

Deno.test("issue 82 schema: bakery_app cannot rewrite identity or admission-time evidence columns", async () => {
  await withTicketRows(async (rows) => {
    const ticket = await rows.ticket(1);
    const task = await rows.task();
    const link = await rows.link(ticket, task, "primary");
    const report = await rows.report(ticket, 1);
    const request = await rows.request(ticket, link, 1, "waiting");
    const denied = async (
      table: string,
      column: string,
      value: string,
      id: string,
    ) =>
      (await violation(
        rows.app.query(
          `update bakery.${table} set ${column} = ${value} where id = $1`,
          [id],
        ),
      )).code;
    const uuid = () => `'${crypto.randomUUID()}'::uuid`;

    for (
      const [column, value] of Object.entries({
        authority_principal_id: "null",
        authority_evidence: `'{"forged":true}'::jsonb`,
        pinned_preset:
          `'{"id":"fixed-coding","revision":9,"digest":"${SHA}"}'::jsonb`,
        generation: "99",
        origin: "'poll'",
        ticket_task_link_id: uuid(),
        external_ticket_id: uuid(),
        organization_id: uuid(),
        inbound_event_route_id: "null",
        created_at: "now()",
        id: uuid(),
      })
    ) {
      assertEquals(
        await denied("ticket_requests", column, value, request),
        PG_INSUFFICIENT_PRIVILEGE,
        `ticket_requests.${column} update is denied to bakery_app`,
      );
    }
    assertEquals(
      await denied("ticket_sources", "application_id", uuid(), rows.sourceId),
      PG_INSUFFICIENT_PRIVILEGE,
    );
    assertEquals(
      await denied("external_tickets", "external_ticket_id", "'1'", ticket),
      PG_INSUFFICIENT_PRIVILEGE,
    );
    assertEquals(
      await denied("ticket_task_links", "role", "'reference'", link),
      PG_INSUFFICIENT_PRIVILEGE,
    );
    assertEquals(
      await denied("ticket_readiness_reports", "verdict", "'rejected'", report),
      PG_INSUFFICIENT_PRIVILEGE,
      "a recorded report cannot be rewritten",
    );
    assertEquals(
      (await violation(
        rows.app.query(
          "delete from bakery.ticket_readiness_reports where id = $1",
          [report],
        ),
      )).code,
      PG_INSUFFICIENT_PRIVILEGE,
      "a recorded report cannot be deleted",
    );

    // The columns a lifecycle step and a re-pin rewrite still update.
    await rows.app.query(
      `update bakery.ticket_requests
          set intent = 'plan', source_policy_revision = 2,
              requirements_digest = $2, readiness_report_id = $3,
              disposition = 'suspended', disposition_reason = 'label_withdrawn',
              workflow_run_id = null, pause_requested_at = now(),
              updated_at = now(), version = version + 1
        where id = $1`,
      [request, "c".repeat(64), report],
    );
    const stored = await rows.owner.query<{
      authority_principal_id: string | null;
      authority_evidence: unknown;
      pinned_preset: unknown;
      generation: number;
      origin: string;
      disposition: string;
      readiness_report_id: string | null;
    }>(
      `select authority_principal_id, authority_evidence, pinned_preset,
              generation, origin, disposition, readiness_report_id
         from bakery.ticket_requests where id = $1`,
      [request],
    );
    assertEquals(stored.rows[0], {
      authority_principal_id: rows.adminId,
      authority_evidence: {},
      pinned_preset: { id: "fixed-coding", revision: 1, digest: SHA },
      generation: 1,
      origin: "manual",
      disposition: "suspended",
      readiness_report_id: report,
    });
  });
});

Deno.test("issue 82 schema: paging indexes order sources and tickets newest first", async () => {
  await withFixture(async (f) => {
    const indexes = await f.pgDatabase.query<
      { name: string; definition: string }
    >(
      `select indexname as name, indexdef as definition from pg_indexes
        where schemaname = 'bakery' and indexname = any($1::text[])
        order by indexname`,
      [[
        "external_tickets_org_page_idx",
        "external_tickets_source_page_idx",
        "ticket_sources_page_idx",
      ]],
    );
    assertEquals(
      Object.fromEntries(indexes.rows.map((row) => [row.name, row.definition])),
      {
        external_tickets_org_page_idx:
          "CREATE INDEX external_tickets_org_page_idx ON bakery.external_tickets USING btree (organization_id, created_at DESC, id DESC)",
        external_tickets_source_page_idx:
          "CREATE INDEX external_tickets_source_page_idx ON bakery.external_tickets USING btree (organization_id, ticket_source_id, created_at DESC, id DESC)",
        ticket_sources_page_idx:
          "CREATE INDEX ticket_sources_page_idx ON bakery.ticket_sources USING btree (organization_id, created_at DESC, id DESC)",
      },
      "an unfiltered ticket page and a per-source page each have an ordered index",
    );
  });
});

Deno.test("issue 82 schema: the route pointer has an index that leads with its column, so receipt retention does not scan the requests", async () => {
  await withFixture(async (f) => {
    const found = await f.pgDatabase.query<{ definition: string }>(
      `select indexdef as definition from pg_indexes
        where schemaname = 'bakery' and tablename = 'ticket_requests'
          and indexname = 'ticket_requests_route_idx'`,
    );
    assertEquals(
      found.rows.map((row) => row.definition),
      [
        "CREATE INDEX ticket_requests_route_idx ON bakery.ticket_requests USING btree (organization_id, inbound_event_route_id) WHERE (inbound_event_route_id IS NOT NULL)",
      ],
      "the foreign key to the route is indexed by organization and route",
    );
    // The lookup the set-null action runs for each deleted route can use it:
    // with a sequential scan ruled out, the planner has no other way in.
    const plan = await withPgTransaction(f.pgDatabase, async (transaction) => {
      await transaction.query("set local enable_seqscan = off");
      const explained = await transaction.query<{ "QUERY PLAN": string }>(
        `explain update bakery.ticket_requests set inbound_event_route_id = null
          where organization_id = $1 and inbound_event_route_id = $2`,
        [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ],
      );
      return explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    assert(
      plan.includes("ticket_requests_route_idx"),
      `the route lookup uses the route index: ${plan}`,
    );
  });
});

// Delete actions of every foreign key on the five tables: `c` cascade, `a` no
// action, `n` set null. Organization and parent-ticket keys cascade; keys to
// tables owned elsewhere never delete a ticket row on their own.
const CASCADE_KEYS = [
  "ticket_sources_organization_fk",
  "external_tickets_organization_fk",
  "external_tickets_source_fk",
  "ticket_task_links_organization_fk",
  "ticket_task_links_ticket_fk",
  "ticket_readiness_reports_organization_fk",
  "ticket_readiness_reports_ticket_fk",
  "ticket_requests_organization_fk",
  "ticket_requests_ticket_fk",
];
const NO_ACTION_KEYS = [
  "ticket_sources_connection_fk",
  "ticket_sources_resource_fk",
  "ticket_sources_application_fk",
  "ticket_sources_repository_fk",
  "ticket_task_links_task_fk",
  "ticket_requests_link_fk",
  "ticket_requests_authority_principal_fk",
  "ticket_requests_report_fk",
  "ticket_requests_run_fk",
];
const SET_NULL_KEYS = ["ticket_requests_route_fk"];

Deno.test("issue 82 schema: every foreign key keeps its delete action", async () => {
  await withFixture(async (f) => {
    const keys = await f.pgDatabase.query<{ name: string; action: string }>(
      `select con.conname as name, con.confdeltype::text as action
         from pg_constraint as con
         join pg_class as tbl on tbl.oid = con.conrelid
         join pg_namespace as ns on ns.oid = tbl.relnamespace
        where ns.nspname = 'bakery' and tbl.relname = any($1::text[])
          and con.contype = 'f'`,
      [TABLES],
    );
    const expected = Object.fromEntries([
      ...CASCADE_KEYS.map((name) => [name, "c"]),
      ...NO_ACTION_KEYS.map((name) => [name, "a"]),
      ...SET_NULL_KEYS.map((name) => [name, "n"]),
    ]);
    assertEquals(
      Object.fromEntries(keys.rows.map((row) => [row.name, row.action])),
      expected,
    );
  });
});

async function ticketRowCounts(
  database: PgTransactionClient,
  organizationId: string,
): Promise<Record<typeof TABLES[number], number>> {
  const counts = {} as Record<typeof TABLES[number], number>;
  for (const table of TABLES) {
    const result = await database.query<{ count: string }>(
      `select count(*) from bakery.${table} where organization_id = $1`,
      [organizationId],
    );
    counts[table] = Number(result.rows[0].count);
  }
  return counts;
}

Deno.test("issue 82 schema: deleting an organization removes the rows of all five tables", async () => {
  await withTicketRows(async (rows) => {
    const ticket = await rows.ticket(1);
    const task = await rows.task();
    const link = await rows.link(ticket, task, "primary");
    const report = await rows.report(ticket, 1);
    await rows.request(ticket, link, 1, "waiting", report);
    const oneEach = {
      ticket_sources: 1,
      external_tickets: 1,
      ticket_task_links: 1,
      ticket_readiness_reports: 1,
      ticket_requests: 1,
    };
    assertEquals(
      await ticketRowCounts(rows.owner, rows.organizationId),
      oneEach,
    );

    // The organization is the fixture's shared one, so the delete runs in a
    // transaction that is rolled back once the counts are read.
    const rollback = new Error("roll back the organization delete");
    const observed: { counts?: Awaited<ReturnType<typeof ticketRowCounts>> } =
      {};
    try {
      await withPgTransaction(rows.owner, async (transaction) => {
        await transaction.query(
          "delete from bakery.organizations where id = $1",
          [rows.organizationId],
        );
        observed.counts = await ticketRowCounts(
          transaction,
          rows.organizationId,
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    assertEquals(observed.counts, {
      ticket_sources: 0,
      external_tickets: 0,
      ticket_task_links: 0,
      ticket_readiness_reports: 0,
      ticket_requests: 0,
    }, "the organization delete reached every ticket table");
    assertEquals(
      await ticketRowCounts(rows.owner, rows.organizationId),
      oneEach,
      "the rolled-back delete left the fixture's rows in place",
    );
  });
});
