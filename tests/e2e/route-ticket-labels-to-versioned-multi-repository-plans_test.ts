/**
 * #31 e2e lane: label routing rules on the shipped server process with real
 * Postgres and Inngest (`upStack`). The stack holds no provider App
 * credentials, so this lane proves what needs no provider read: the rule set
 * is read and replaced through the real HTTP stack under If-Match, a change
 * advances the source's policy revision once and persists the rules with an
 * audit row, an unbound role or a repository outside the application is
 * refused, a Viewer learns nothing and a Developer cannot replace, and a
 * request sent with the revision the rules moved past is refused (412). The
 * admission, plan and child-task paths rest on the integration lane with the
 * in-memory provider reader.
 */
import { assertEquals } from "@std/assert";
import { defaultTicketSourcePolicy } from "../../packages/contracts/src/ticket-admission.ts";
import { upStack } from "./helpers/stack.ts";
import {
  addViewer,
  REQUIREMENTS_DIGEST,
  seedAuthority,
  seedTicket,
  type Session,
  signedInAdmin,
  sourceBody,
  stackCall,
} from "../helpers/ticket-admission/e2e-seed.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";

type Problem = { code: string; issues?: { code: string }[] };
type RuleSet = {
  policyRevision: number;
  version: number;
  rules: { id: string; labelId: string; labelName: string; version: number }[];
};

Deno.test(
  "#31 e2e: routing rules are read and replaced under If-Match on a real stack",
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    const stack = await upStack("ticket-routing");
    const owner = openPgDatabase(stack.ownerDatabaseUrl);
    try {
      const admin = await signedInAdmin(stack);
      const authority = await seedAuthority(stack, owner, admin);
      const org = authority.organizationId;
      const { applicationId, repositoryId } = authority.repository;
      // stackCall, plus explicit precondition and idempotency headers.
      const send = (
        who: Session,
        method: string,
        path: string,
        body?: unknown,
        extra: Record<string, string> = {},
      ) => {
        if (Object.keys(extra).length === 0) {
          return stackCall(stack, who, method, path, body);
        }
        const headers = new Headers({
          cookie: who.cookie,
          "Bakery-Organization-Id": who.organizationId,
          origin: stack.origin,
          "content-type": "application/json",
          ...extra,
        });
        return stack.fetch(
          new Request(`${stack.origin}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
      };
      const created = await send(
        admin,
        "POST",
        "/v1/ticket-sources",
        sourceBody(authority, {
          ...defaultTicketSourcePolicy(),
          workflow: { builtIn: "fixed-coding" },
        }),
      );
      assertEquals(created.status, 201, await created.clone().text());
      const source = await created.json() as { id: string; version: number };
      const path = `/v1/ticket-sources/${source.id}/routing-rules`;
      await stack.psql(
        `insert into bakery.repository_role_bindings (
           organization_id, application_id, repository_id, role, alias
         ) values ($1::uuid, $2::uuid, $3::uuid, 'backend', 'e2e-backend')`,
        [org, applicationId, repositoryId],
      );
      const rules = [{
        labelId: "9001",
        labelName: "backend",
        repositoryId,
        role: "backend",
      }];

      await t.step(
        "an empty set reads back with the source version",
        async () => {
          const empty = await send(admin, "GET", path);
          assertEquals(empty.status, 200, await empty.clone().text());
          const set = await empty.json() as RuleSet;
          assertEquals([set.rules.length, set.policyRevision, set.version], [
            0,
            1,
            source.version,
          ]);
        },
      );

      await t.step(
        "replace needs If-Match and advances the revision once",
        async () => {
          const unconditional = await send(admin, "PUT", path, { rules }, {
            "Idempotency-Key": crypto.randomUUID(),
          });
          assertEquals(unconditional.status, 428);
          const stale = await send(admin, "PUT", path, { rules }, {
            "Idempotency-Key": crypto.randomUUID(),
            "If-Match": `"v${source.version + 7}"`,
          });
          assertEquals(stale.status, 412);
          const saved = await send(admin, "PUT", path, { rules }, {
            "Idempotency-Key": crypto.randomUUID(),
            "If-Match": `"v${source.version}"`,
          });
          assertEquals(saved.status, 200, await saved.clone().text());
          const set = await saved.json() as RuleSet;
          assertEquals(set.policyRevision, 2);
          assertEquals(set.rules.map((r) => [r.labelId, r.labelName]), [[
            "9001",
            "backend",
          ]]);
          const stored = await stack.psql<
            { n: number; audits: number; revision: number }
          >(
            `select (select count(*)::int from bakery.ticket_routing_rules
                    where organization_id = $1::uuid) as n,
                  (select count(*)::int from bakery.audit_events
                    where organization_id = $1::uuid
                      and operation = 'ticketRoutingRules.replace') as audits,
                  (select policy_revision from bakery.ticket_sources
                    where id = $2::uuid) as revision`,
            [org, source.id],
          );
          assertEquals(stored, [{ n: 1, audits: 1, revision: 2 }]);
        },
      );

      await t.step(
        "an unbound role is refused and a Viewer learns nothing",
        async () => {
          const current = await (await send(admin, "GET", path))
            .json() as RuleSet;
          const unbound = await send(admin, "PUT", path, {
            rules: [{ ...rules[0], role: "frontend" }],
          }, {
            "Idempotency-Key": crypto.randomUUID(),
            "If-Match": `"v${current.version}"`,
          });
          assertEquals(unbound.status, 422);
          assertEquals(
            ((await unbound.json()) as Problem).issues?.[0]?.code,
            "routing_role_unbound",
          );
          const viewer = await addViewer(stack, admin);
          assertEquals((await send(viewer, "GET", path)).status, 404);
        },
      );

      await t.step(
        "a request on the old revision is refused with 412",
        async () => {
          const ticketId = await seedTicket(stack, authority, source.id, 31);
          const response = await send(
            admin,
            "POST",
            `/v1/external-tickets/${ticketId}/requests`,
            {
              intent: "plan",
              expectedSourcePolicyRevision: 1,
              requirementsDigest: REQUIREMENTS_DIGEST,
            },
            { "Idempotency-Key": crypto.randomUUID() },
          );
          assertEquals(response.status, 412, await response.clone().text());
        },
      );
    } finally {
      try {
        await closePgDatabase(owner);
      } finally {
        await stack.down();
      }
    }
  },
);
