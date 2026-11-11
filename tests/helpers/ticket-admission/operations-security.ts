import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  OrganizationRole,
  PrincipalType,
} from "../../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import type { OrganizationActor } from "../../../apps/server/src/modules/auth/application/authority.ts";
import { authorizeTicketAdmission } from "../../../apps/server/src/modules/work/ticket-request-command.ts";
import {
  bearerCall,
  createServiceAccount,
  mintToken,
} from "../access-tokens.ts";
import {
  cleanupSeededOrganizations,
  seedOrganization,
} from "../coordinator-turns.ts";
import { addMember } from "../durable-questions.ts";
import {
  EXECUTE_LABEL,
  insertBareTask,
  type TicketFixture,
  withTicketFixture,
} from "./fixtures.ts";
import {
  type Problem,
  read,
  sourceBody,
  type SourceView,
  ticketCall,
} from "./operations-http.ts";

/*
 * Issue 82 operation security: who may read and who may change ticket sources,
 * that another organization sees nothing, that a token's scopes narrow what a
 * principal may do, that a body cannot choose its organization or principal,
 * and that issue text stays out of logs, audit rows and events.
 */

const SOURCES = "/v1/ticket-sources";

/** Every ticket operation as [method, path, body]. */
function operations(sourceId: string, ticketId: string) {
  const ticket = `/v1/external-tickets/${ticketId}`;
  return {
    /**
     * Operations a Developer may perform, with the status they answer when
     * the body is stale or names nothing: authorized, yet they change nothing.
     */
    memberWrites: [
      [
        "POST",
        `${ticket}/readiness-checks`,
        { expectedSourcePolicyRevision: 9 },
        412,
      ],
      [
        "POST",
        `${ticket}/links`,
        { taskId: crypto.randomUUID(), role: "reference" },
        404,
      ],
      [
        "POST",
        `${ticket}/requests`,
        {
          intent: "plan",
          expectedSourcePolicyRevision: 9,
          requirementsDigest: "0".repeat(64),
        },
        412,
      ],
    ] as const,
    reads: [
      ["GET", SOURCES],
      ["GET", `${SOURCES}/${sourceId}`],
      ["GET", "/v1/external-tickets"],
      ["GET", `/v1/external-tickets/${ticketId}`],
    ] as const,
    writes: [
      ["PATCH", `${SOURCES}/${sourceId}`, { enabled: false }],
      ["POST", `${SOURCES}/${sourceId}/previews`, {}],
      ["POST", `${SOURCES}/${sourceId}/syncs`, {}],
    ] as const,
  };
}

/** A source with one recorded ticket, so every route has an id to name. */
async function seededSource(fx: TicketFixture) {
  const sourceId = await fx.insertSource();
  fx.reader.setIssue({ number: 1, labels: [] });
  await read(
    await ticketCall(fx, "POST", `${SOURCES}/${sourceId}/previews`, {
      body: {},
    }),
    201,
  );
  const ticket = await fx.owner.query<{ id: string }>(
    `select id from bakery.external_tickets where ticket_source_id = $1`,
    [sourceId],
  );
  return { sourceId, ticketId: ticket.rows[0].id };
}

function seedFor(fx: TicketFixture) {
  return {
    organizationId: fx.organizationId,
    principalId: fx.adminId,
    cookie: fx.f.adminCookie,
    applicationId: fx.applicationId,
    repositoryId: fx.repositoryId,
    conversationId: "",
    agentVersionId: "",
  };
}

Deno.test("issue 82 ops security: viewers and Developers read but change nothing, guests learn nothing", async () => {
  await withTicketFixture(async (fx) => {
    try {
      const { sourceId, ticketId } = await seededSource(fx);
      const { reads, writes, memberWrites } = operations(sourceId, ticketId);
      const viewer = await addMember(
        fx.f,
        seedFor(fx),
        "ticket-viewer",
        "viewer",
      );
      const guest = await addMember(fx.f, seedFor(fx), "ticket-guest", "guest");
      // Viewers hold the ticket reads the role matrix gives them but not the
      // source reads (a read they lack answers 404): a source policy names the
      // principal Bakery acts as and the GitHub actors that may trigger it.
      // Guests hold none.
      for (const [method, path] of reads) {
        const viewerStatus = path.startsWith(SOURCES) ? 404 : 200;
        const asViewer = await ticketCall(fx, method, path, {
          cookie: viewer.cookie,
        });
        assertEquals(asViewer.status, viewerStatus, `viewer ${method} ${path}`);
        const asDeveloper = await ticketCall(fx, method, path, {
          cookie: fx.f.developerCookie,
        });
        assertEquals(asDeveloper.status, 200, `developer ${method} ${path}`);
        const hidden = await ticketCall(fx, method, path, {
          cookie: guest.cookie,
        });
        assertEquals(hidden.status, 404, `${method} ${path}`);
      }
      const changes = [["POST", SOURCES, sourceBody(fx)], ...writes] as const;
      for (const [method, path, body] of changes) {
        for (const cookie of [fx.f.developerCookie, viewer.cookie]) {
          const response = await ticketCall(fx, method, path, {
            cookie,
            body,
            ifMatch: 1,
          });
          assertEquals(response.status, 403, `${method} ${path}`);
        }
        const hidden = await ticketCall(fx, method, path, {
          cookie: guest.cookie,
          body,
          ifMatch: 1,
        });
        assertEquals(hidden.status, 404, `${method} ${path}`);
      }
      // Readiness, link and request operations are a Developer's; viewers are
      // refused and guests learn nothing.
      for (const [method, path, body, status] of memberWrites) {
        const asDeveloper = await ticketCall(fx, method, path, {
          cookie: fx.f.developerCookie,
          body,
        });
        assertEquals(asDeveloper.status, status, `developer ${path}`);
        const asViewer = await ticketCall(fx, method, path, {
          cookie: viewer.cookie,
          body,
        });
        assertEquals(asViewer.status, 403, `viewer ${path}`);
        const asGuest = await ticketCall(fx, method, path, {
          cookie: guest.cookie,
          body,
        });
        assertEquals(asGuest.status, 404, `guest ${path}`);
      }
      // Nothing changed.
      const source = await read<SourceView>(
        await ticketCall(fx, "GET", `${SOURCES}/${sourceId}`),
        200,
      );
      assertEquals([source.version, source.enabled], [1, true]);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  });
});

Deno.test("issue 82 ops security: another organization sees and changes nothing, whatever id it names", async () => {
  await withTicketFixture(async (fx) => {
    try {
      const { sourceId, ticketId } = await seededSource(fx);
      const other = await seedOrganization(fx.f, "ticket-other", {
        role: "admin",
        agent: false,
      });
      const { reads, writes, memberWrites } = operations(sourceId, ticketId);
      const asOther = {
        cookie: other.cookie,
        organizationId: other.organizationId,
      };
      for (const [method, path] of [...reads.slice(1, 2), ...reads.slice(3)]) {
        const response = await ticketCall(fx, method, path, asOther);
        assertEquals(response.status, 404, `${method} ${path}`);
      }
      for (const [method, path, body] of writes) {
        const response = await ticketCall(fx, method, path, {
          ...asOther,
          body,
          ifMatch: 1,
        });
        assertEquals(response.status, 404, `${method} ${path}`);
      }
      for (const [method, path, body] of memberWrites) {
        const response = await ticketCall(fx, method, path, {
          ...asOther,
          body,
        });
        assertEquals(response.status, 404, `${method} ${path}`);
      }
      // A task of another organization is not found by this organization's link.
      const foreignTask = await insertBareTask({
        owner: fx.owner,
        organizationId: other.organizationId,
        applicationId: other.applicationId,
        adminId: other.principalId,
      });
      const foreignLink = await ticketCall(
        fx,
        "POST",
        `/v1/external-tickets/${ticketId}/links`,
        { body: { taskId: foreignTask, role: "reference" } },
      );
      assertEquals(foreignLink.status, 404);
      // Lists show the caller's own organization only.
      for (const path of [SOURCES, "/v1/external-tickets"]) {
        const page = await read<{ items: unknown[] }>(
          await ticketCall(fx, "GET", path, asOther),
          200,
        );
        assertEquals(page.items, [], path);
      }
      // Naming this organization without belonging to it is refused.
      for (const [method, path] of reads) {
        const response = await ticketCall(fx, method, path, {
          cookie: other.cookie,
        });
        assert([403, 404].includes(response.status), `${method} ${path}`);
      }
      const source = await read<SourceView>(
        await ticketCall(fx, "GET", `${SOURCES}/${sourceId}`),
        200,
      );
      assertEquals([source.version, source.enabled], [1, true]);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  });
});

Deno.test("issue 82 ops security: an access token can do no more than its scopes and its principal allow", async () => {
  await withTicketFixture(async (fx) => {
    const { sourceId, ticketId } = await seededSource(fx);
    const { reads, writes, memberWrites } = operations(sourceId, ticketId);
    const account = await createServiceAccount(fx.f, "ticket bot", "admin");
    const readOnly = await mintToken(fx.f, account.id, ["bakery:read"]);
    for (const [method, path] of reads) {
      const response = await bearerCall(fx.f, method, path, readOnly.secret);
      assertEquals(response.status, 200, `${method} ${path}`);
    }
    for (
      const [method, path, body] of [
        ["POST", SOURCES, sourceBody(fx)],
        ...writes,
      ] as const
    ) {
      const response = await bearerCall(fx.f, method, path, readOnly.secret, {
        body,
        headers: { "If-Match": '"v1"' },
      });
      assertEquals(response.status, 403, `${method} ${path}`);
      assertEquals(
        (await response.json() as Problem).code,
        "INSUFFICIENT_SCOPE",
      );
    }
    for (const [method, path, body] of memberWrites) {
      const response = await bearerCall(fx.f, method, path, readOnly.secret, {
        body,
      });
      assertEquals(response.status, 403, `${method} ${path}`);
      assertEquals(
        (await response.json() as Problem).code,
        "INSUFFICIENT_SCOPE",
      );
    }
    // The operate bundle reaches the Developer operations and not source management.
    const operate = await mintToken(fx.f, account.id, ["bakery:operate"]);
    const [method, path, body, status] = memberWrites[0];
    const allowed = await bearerCall(fx.f, method, path, operate.secret, {
      body,
    });
    assertEquals(allowed.status, status);
    const denied = await bearerCall(
      fx.f,
      "POST",
      `${SOURCES}/${sourceId}/syncs`,
      operate.secret,
      { body: {} },
    );
    assertEquals((await denied.json() as Problem).code, "INSUFFICIENT_SCOPE");
    const adminScoped = await mintToken(fx.f, account.id, ["bakery:admin"]);
    const changed = await read<SourceView>(
      await bearerCall(
        fx.f,
        "PATCH",
        `${SOURCES}/${sourceId}`,
        adminScoped.secret,
        {
          body: { enabled: false },
          headers: { "If-Match": '"v1"' },
        },
      ),
      200,
    );
    assertEquals(changed.enabled, false);
  });
});

Deno.test("issue 82 ops security: a body cannot choose the organization or the acting principal", async () => {
  await withTicketFixture(async (fx) => {
    try {
      const { sourceId, ticketId } = await seededSource(fx);
      const other = await seedOrganization(fx.f, "ticket-forger", {
        role: "admin",
        agent: false,
      });
      const forgeries = {
        organizationId: other.organizationId,
        principalId: other.principalId,
        createdBy: other.principalId,
      };
      const attempts: [string, string, Record<string, unknown>][] = [
        ["POST", SOURCES, { ...sourceBody(fx), ...forgeries }],
        ["PATCH", `${SOURCES}/${sourceId}`, { enabled: false, ...forgeries }],
        ["POST", `${SOURCES}/${sourceId}/previews`, forgeries],
        ["POST", `${SOURCES}/${sourceId}/syncs`, forgeries],
        ...operations(sourceId, ticketId).memberWrites.map((
          [method, path, body],
        ) =>
          [method, path, { ...body, ...forgeries }] as [
            string,
            string,
            Record<string, unknown>,
          ]
        ),
      ];
      for (const [method, path, body] of attempts) {
        const response = await ticketCall(fx, method, path, {
          body,
          ifMatch: 1,
        });
        assert(
          response.status >= 400 && response.status < 500,
          `${method} ${path} ${response.status}`,
        );
      }
      for (
        const table of [
          "ticket_sources",
          "external_tickets",
          "ticket_task_links",
          "ticket_requests",
        ]
      ) {
        const rows = await fx.owner.query(
          `select 1 from bakery.${table} where organization_id = $1`,
          [other.organizationId],
        );
        assertEquals(rows.rows.length, 0, table);
      }
      const audit = await fx.owner.query(
        `select 1 from bakery.audit_events
          where organization_id = $1
            and (operation like 'ticketSources.%'
              or operation like 'ticketReadiness.%'
              or operation like 'ticketTaskLinks.%'
              or operation like 'ticketRequests.%')`,
        [other.organizationId],
      );
      assertEquals(audit.rows.length, 0);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  });
});

Deno.test("issue 82 ops security: issue text stays out of logs, audit rows and events", async () => {
  const marker = `BODY-MARKER-${crypto.randomUUID()}`;
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    for (const number of [1, 2, 3]) {
      fx.reader.setIssue({
        number,
        title: `Title ${marker}`,
        body: `Body ${marker}\n\n## Acceptance criteria\n- ${marker}\n`,
        labels: [EXECUTE_LABEL],
      });
      fx.facts.set(number, `2026-06-01T00:00:0${number}Z`);
    }
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
    }
    try {
      await read(
        await ticketCall(fx, "POST", `${SOURCES}/${sourceId}/previews`, {
          body: {},
        }),
        201,
      );
      // Readiness and request answers, accepted and refused, never echo the text.
      const ticket = await fx.owner.query<
        { id: string; requirements_digest: string }
      >(
        `select id, requirements_digest from bakery.external_tickets
          where ticket_source_id = $1 order by number::int limit 1`,
        [sourceId],
      );
      const { id, requirements_digest: digest } = ticket.rows[0];
      for (
        const [suffix, body] of [
          ["readiness-checks", { expectedSourcePolicyRevision: 1 }],
          ["requests", {
            intent: "start",
            expectedSourcePolicyRevision: 1,
            requirementsDigest: digest,
          }],
        ] as const
      ) {
        const response = await ticketCall(
          fx,
          "POST",
          `/v1/external-tickets/${id}/${suffix}`,
          { body },
        );
        assertNotEquals(response.status, 500, suffix);
        assert(!(await response.text()).includes(marker), suffix);
      }
      fx.reader.failNext("readIssue");
      await read(
        await ticketCall(fx, "POST", `${SOURCES}/${sourceId}/syncs`, {
          body: {},
        }),
        201,
      );
      fx.reader.failNext("listIssues");
      const down = await ticketCall(
        fx,
        "POST",
        `${SOURCES}/${sourceId}/previews`,
        {
          body: {},
        },
      );
      assertNotEquals(down.status, 201);
      assert(!(await down.text()).includes(marker));
    } finally {
      methods.forEach((method, index) => (console[method] = originals[index]));
    }
    assert(lines.every((line) => !line.includes(marker)), "logs");
    for (
      const [table, column] of [["audit_events", "details"], [
        "domain_events",
        "payload",
      ]]
    ) {
      const rows = await fx.owner.query(
        `select 1 from bakery.${table} where organization_id = $1 and ${column}::text like $2`,
        [fx.organizationId, `%${marker}%`],
      );
      assertEquals(rows.rows.length, 0, table);
    }
    // The snapshot is where the text belongs.
    const stored = await fx.owner.query(
      `select 1 from bakery.external_tickets where snapshot::text like $1`,
      [`%${marker}%`],
    );
    assert(stored.rows.length > 0);
  });
});

Deno.test("issue 82 ops security: ticketRequests.create needs task:write and run:write, whatever else grants the action", async () => {
  await withTicketFixture(async (fx) => {
    try {
      const { ticketId } = await seededSource(fx);
      const path = `/v1/external-tickets/${ticketId}/requests`;
      const body = {
        intent: "plan",
        expectedSourcePolicyRevision: 1,
        requirementsDigest: "0".repeat(64),
      };
      // A viewer holding an action grant passes the catalog permission, so only
      // the guard stands between it and a task: it is refused before GitHub is asked.
      const grantee = await addMember(
        fx.f,
        seedFor(fx),
        "ticket-grantee",
        "viewer",
      );
      for (
        const capability of ["ticketRequests.create", "ticketReadiness.create"]
      ) {
        await fx.owner.query(
          `insert into bakery.permission_grants (
             organization_id, principal_id, capability, granted_by_principal_id
           ) values ($1, $2, $3, $4)`,
          [fx.organizationId, grantee.principalId, capability, fx.adminId],
        );
      }
      const asked = fx.reader.calls.length;
      const refused = await ticketCall(fx, "POST", path, {
        cookie: grantee.cookie,
        body,
      });
      assertEquals(refused.status, 403);
      assertEquals((await refused.json() as Problem).code, "AUTH_FORBIDDEN");
      assertEquals(fx.reader.calls.length, asked);
      // The grant itself is live: the readiness grant reaches its handler.
      const granted = await ticketCall(
        fx,
        "POST",
        `/v1/external-tickets/${ticketId}/readiness-checks`,
        { cookie: grantee.cookie, body: { expectedSourcePolicyRevision: 9 } },
      );
      assertEquals(granted.status, 412);
      for (const table of ["ticket_task_links", "ticket_requests"]) {
        const rows = await fx.owner.query(
          `select 1 from bakery.${table} where organization_id = $1`,
          [fx.organizationId],
        );
        assertEquals(rows.rows.length, 0, table);
      }
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  });
});

Deno.test("issue 82 ops security: a link shows the caller a task, so it needs task:read besides the link permission", async () => {
  await withTicketFixture(async (fx) => {
    try {
      const { ticketId } = await seededSource(fx);
      const taskId = await insertBareTask(fx);
      // A custom role on a guest membership holds the link permission alone.
      const roleId = crypto.randomUUID();
      const hold = (permissions: readonly string[]) =>
        fx.owner.query(
          `update bakery.organization_roles set permissions = $3::text[]
            where organization_id = $1 and id = $2`,
          [fx.organizationId, roleId, permissions],
        );
      await fx.owner.query(
        `insert into bakery.organization_roles (
           id, organization_id, key, name, permissions, created_by_principal_id
         ) values ($1, $2, 'linker', 'Linker', '{}'::text[], $3)`,
        [roleId, fx.organizationId, fx.adminId],
      );
      await hold(["ticketTaskLink:write"]);
      const linker = await addMember(
        fx.f,
        seedFor(fx),
        "ticket-linker",
        "guest",
      );
      await fx.owner.query(
        `update bakery.organization_memberships set custom_role_id = $3
          where organization_id = $1 and principal_id = $2`,
        [fx.organizationId, linker.principalId, roleId],
      );
      const link = () =>
        ticketCall(fx, "POST", `/v1/external-tickets/${ticketId}/links`, {
          cookie: linker.cookie,
          body: { taskId, role: "reference" },
        });
      const linksOf = async () =>
        (await fx.owner.query(
          "select 1 from bakery.ticket_task_links where organization_id = $1",
          [fx.organizationId],
        )).rows.length;

      const refused = await link();
      assertEquals(refused.status, 404);
      assertEquals(
        (await refused.json() as Problem).code,
        "RESOURCE_NOT_FOUND",
      );
      assertEquals(await linksOf(), 0, "a refused call writes nothing");
      // The permission is the only difference: with it the same call links.
      await hold(["ticketTaskLink:write", "task:read"]);
      assertEquals((await link()).status, 201);
      assertEquals(await linksOf(), 1);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  });
});

Deno.test("issue 82 ops security: the admission guard checks run:write by itself", () => {
  const actor = (
    permissions: OrganizationActor["customRole"] extends infer Role
      ? Role extends { permissions: infer P } ? P : never
      : never,
  ) =>
    ({
      subject: {
        principalId: crypto.randomUUID(),
        principalType: PrincipalType.Human,
        displayName: "Custom",
      },
      organizationId: crypto.randomUUID(),
      role: OrganizationRole.Guest,
      customRole: { id: crypto.randomUUID(), key: "partial", permissions },
      capabilities: [],
    }) as unknown as OrganizationActor;
  const guard = (holder: OrganizationActor) =>
    authorizeTicketAdmission({ authority: holder } as never);
  guard(actor(["task:write", "run:write"]));
  for (const missing of [["task:write"], ["run:write"]] as const) {
    let code: string | undefined;
    try {
      guard(actor(missing));
    } catch (error) {
      code = (error as StandardError).code;
    }
    assertEquals(code, "AUTH_FORBIDDEN", missing.join());
  }
});
