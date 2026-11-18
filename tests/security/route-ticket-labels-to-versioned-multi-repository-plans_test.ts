/**
 * #31 security lane: the tenancy and role paths of label routing. The rule
 * reads follow the source reads (Developer yes, viewer and guest learn
 * nothing); replacing rules is an Admin's; a rule can never name another
 * organization's repository; another organization finds nothing.
 */
import { assertEquals } from "@std/assert";
import {
  cleanupSeededOrganizations,
  seedOrganization,
} from "../helpers/coordinator-turns.ts";
import { addMember } from "../helpers/durable-questions.ts";
import {
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  type Problem,
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";

const SOURCES = "/v1/ticket-sources";

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

async function ruleCount(fx: TicketFixture, sourceId: string) {
  const result = await fx.owner.query<{ n: number }>(
    `select count(*)::int as n from bakery.ticket_routing_rules
      where ticket_source_id = $1`,
    [sourceId],
  );
  return result.rows[0].n;
}

Deno.test("#31 security: Developers read the rules, only Admins replace them, viewers and guests learn nothing", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const path = `${SOURCES}/${sourceId}/routing-rules`;
    const body = {
      rules: [{
        labelId: "9001",
        labelName: "backend",
        repositoryId: fx.repositoryId,
        role: "a",
      }],
    };
    await fx.owner.query(
      `insert into bakery.repository_role_bindings (
         organization_id, application_id, repository_id, role, alias
       ) values ($1, $2, $3, 'a', 'fixture-a')`,
      [fx.organizationId, fx.applicationId, fx.repositoryId],
    );
    try {
      const viewer = await addMember(
        fx.f,
        seedFor(fx),
        "route-viewer",
        "viewer",
      );
      const guest = await addMember(fx.f, seedFor(fx), "route-guest", "guest");
      assertEquals(
        (await ticketCall(fx, "GET", path, { cookie: fx.f.developerCookie }))
          .status,
        200,
      );
      for (const cookie of [viewer.cookie, guest.cookie]) {
        assertEquals(
          (await ticketCall(fx, "GET", path, { cookie })).status,
          404,
        );
      }
      for (const cookie of [fx.f.developerCookie, viewer.cookie]) {
        const response = await ticketCall(fx, "PUT", path, {
          cookie,
          body,
          ifMatch: 1,
        });
        assertEquals(response.status, 403, await response.text());
      }
      const hidden = await ticketCall(fx, "PUT", path, {
        cookie: guest.cookie,
        body,
        ifMatch: 1,
      });
      assertEquals(hidden.status, 404);
      assertEquals(await ruleCount(fx, sourceId), 0);
      await read(await ticketCall(fx, "PUT", path, { body, ifMatch: 1 }), 200);
      assertEquals(await ruleCount(fx, sourceId), 1);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  }));

Deno.test("#31 security: a rule cannot name another organization's repository, and another organization finds no rules", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    const path = `${SOURCES}/${sourceId}/routing-rules`;
    try {
      const other = await seedOrganization(fx.f, "route-tenant", {
        role: "admin",
        agent: false,
      });
      // The other organization's repository id is refused like an unknown one.
      const refused = await read<Problem>(
        await ticketCall(fx, "PUT", path, {
          body: {
            rules: [{
              labelId: "9001",
              labelName: "backend",
              repositoryId: other.repositoryId,
              role: "backend",
            }],
          },
          ifMatch: 1,
        }),
        422,
      );
      assertEquals(refused.issues?.[0]?.code, "routing_repository_unavailable");
      const asOther = {
        cookie: other.cookie,
        organizationId: other.organizationId,
      };
      assertEquals((await ticketCall(fx, "GET", path, asOther)).status, 404);
      const replace = await ticketCall(fx, "PUT", path, {
        ...asOther,
        body: {
          rules: [{
            labelId: "9001",
            labelName: "backend",
            repositoryId: other.repositoryId,
            role: "backend",
          }],
        },
        ifMatch: 1,
      });
      assertEquals(replace.status, 404);
      assertEquals(await ruleCount(fx, sourceId), 0);
      const source = await fx.owner.query<{ version: number }>(
        "select version from bakery.ticket_sources where id = $1",
        [sourceId],
      );
      assertEquals(source.rows[0].version, 1);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  }));
