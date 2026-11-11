/**
 * Issue 82 e2e lane: ticket sources, the request guard and the registered
 * functions on the shipped server process, real Postgres and real Inngest
 * (`upStack`). The stack holds no GitHub App credentials and the server's
 * GitHub origin is the constant https://api.github.com, so this lane proves
 * the honest paths: operations answer and persist, a request for a ticket with
 * no usable credentials fails closed and writes nothing, the database floor
 * and the run guard hold, both functions register, and a signed delivery is
 * accepted but admits nothing. The positive admission path rests on the
 * integration lane with the fake GitHub, and live GitHub stays open under G3.
 */
import { assert, assertEquals } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { defaultTicketSourcePolicy } from "../../../packages/contracts/src/ticket-admission.ts";
import { upStack } from "../../e2e/helpers/stack.ts";
import { presetRunBody } from "../fixed-coding-preset.ts";
import { deliveryRequest } from "../github-intake/signed-delivery.ts";
import {
  addViewer,
  createTask,
  delay,
  KEY_FILE_IN_CONTAINER,
  KEY_ID,
  REQUIREMENTS_DIGEST,
  sealWebhookSecret,
  seedAuthority,
  seedPrimaryLink,
  seedRequest,
  seedTicket,
  type Session,
  signedInAdmin,
  sourceBody,
  stackCall,
  writeCounts,
} from "./e2e-seed.ts";

type Problem = { code: string; reason?: string };

const WEBHOOK_SECRET = "ticket-e2e-webhook-secret-test-only";
const FUNCTIONS = [
  "bakery-server-bakery-ticket-intake",
  "bakery-server-bakery-ticket-poll",
];

Deno.test(
  "issue 82 e2e: ticket operations, the run guard and the registered functions on a real stack",
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    const stack = await upStack("tickets");
    const owner = openPgDatabase(stack.ownerDatabaseUrl);
    try {
      const admin = await signedInAdmin(stack);
      const authority = await seedAuthority(stack, owner, admin);
      const org = authority.organizationId;
      const send = (
        who: Session,
        method: string,
        path: string,
        body?: unknown,
      ) => stackCall(stack, who, method, path, body);
      let sourceId = "";
      let policyRevision = 0;

      await t.step(
        "ticketSources create, get and list answer and persist; a Viewer cannot read sources",
        async () => {
          const body = sourceBody(authority, defaultTicketSourcePolicy());
          const created = await send(admin, "POST", "/v1/ticket-sources", body);
          assertEquals(created.status, 201, await created.clone().text());
          const source = await created.json() as {
            id: string;
            policyRevision: number;
            enabled: boolean;
          };
          sourceId = source.id;
          policyRevision = source.policyRevision;
          assertEquals([source.enabled, policyRevision], [true, 1]);

          const fetched = await send(
            admin,
            "GET",
            `/v1/ticket-sources/${sourceId}`,
          );
          assertEquals(fetched.status, 200, await fetched.clone().text());
          assertEquals((await fetched.json() as { id: string }).id, sourceId);
          const listed = await send(admin, "GET", "/v1/ticket-sources");
          assertEquals(listed.status, 200, await listed.clone().text());
          const page = await listed.json() as { items: { id: string }[] };
          assertEquals(page.items.map((item) => item.id), [sourceId]);

          const stored = await stack.psql(
            `select enabled, policy_revision, policy->'automatic'->>'enabled' as automatic,
                    (select count(*)::int from bakery.audit_events
                      where organization_id = $1 and resource_id = $2::text
                        and operation = 'ticketSources.create') as audits
               from bakery.ticket_sources where organization_id = $1 and id = $2::uuid`,
            [org, sourceId],
          );
          assertEquals(stored, [
            {
              enabled: true,
              policy_revision: 1,
              automatic: "false",
              audits: 1,
            },
          ]);

          // A Viewer holds the ticket reads of the role matrix, not the source
          // reads, and changes nothing.
          const viewer = await addViewer(stack, admin);
          for (
            const path of [
              "/v1/ticket-sources",
              `/v1/ticket-sources/${sourceId}`,
            ]
          ) {
            assertEquals((await send(viewer, "GET", path)).status, 404, path);
          }
          const tickets = await send(viewer, "GET", "/v1/external-tickets");
          assertEquals(tickets.status, 200, await tickets.clone().text());
          const refused = await send(
            viewer,
            "POST",
            "/v1/ticket-sources",
            body,
          );
          assertEquals(refused.status, 403);
          const rows = await stack.psql(
            "select 1 from bakery.ticket_sources where organization_id = $1",
            [org],
          );
          assertEquals(rows.length, 1);
        },
      );

      await t.step(
        "ticketRequests.create without usable App credentials fails closed and writes nothing",
        async () => {
          // The registration exists (an installation needs one) but its
          // secrets hold no version, so credentials read null and
          // `mintTicketReadToken` throws DEPENDENCY_UNAVAILABLE.
          const ticketId = await seedTicket(stack, authority, sourceId, 4242);
          const before = await writeCounts(stack, org);
          const response = await send(
            admin,
            "POST",
            `/v1/external-tickets/${ticketId}/requests`,
            {
              intent: "start",
              expectedSourcePolicyRevision: policyRevision,
              requirementsDigest: REQUIREMENTS_DIGEST,
            },
          );
          const text = await response.text();
          assertEquals(
            [response.status, (JSON.parse(text) as Problem).code],
            [503, "DEPENDENCY_UNAVAILABLE"],
            text,
          );
          assertEquals(await writeCounts(stack, org), before);
          const owned = await stack.psql(
            `select 1 from bakery.ticket_task_links where external_ticket_id = $1
             union all select 1 from bakery.ticket_requests where external_ticket_id = $1`,
            [ticketId],
          );
          assertEquals(owned.length, 0);
        },
      );

      await t.step(
        "a suspended request refuses runs.create for its task and not for a task without a link",
        async () => {
          const ticketId = await seedTicket(stack, authority, sourceId, 4243);
          const linkedTask = await createTask(stack, admin, authority);
          const plainTask = await createTask(stack, admin, authority);
          const linkId = await seedPrimaryLink(
            stack,
            authority,
            ticketId,
            linkedTask,
          );
          await seedRequest(stack, authority, {
            ticketId,
            linkId,
            generation: 1,
            disposition: "suspended",
            reason: "principal_inactive",
          });
          const runs = (await writeCounts(stack, org)).runs;
          const body = presetRunBody(authority.repository);

          const refused = await send(
            admin,
            "POST",
            `/v1/tasks/${linkedTask}/runs`,
            body,
          );
          const problem = await refused.json() as Problem;
          assertEquals(
            [refused.status, problem.code, problem.reason],
            [409, "STATE_CONFLICT", "ticket_request_suspended"],
          );
          assertEquals((await writeCounts(stack, org)).runs, runs);

          // The task no request owns passes the ticket guard and is refused
          // later, by the check this stack fails (no funded coding agent is
          // bound to the profile).
          const other = await send(
            admin,
            "POST",
            `/v1/tasks/${plainTask}/runs`,
            body,
          );
          const otherText = await other.text();
          const answer = JSON.parse(otherText) as Problem;
          assertEquals(
            [other.status, answer.code, answer.reason],
            [409, "STATE_CONFLICT", "model_agent_required"],
            otherText,
          );
          assert(!otherText.includes("ticket_request_suspended"), otherText);
        },
      );

      await t.step(
        "the partial unique index refuses a second nonterminal request and accepts a new generation after the first ends",
        async () => {
          const ticketId = await seedTicket(stack, authority, sourceId, 4244);
          const first = await seedPrimaryLink(
            stack,
            authority,
            ticketId,
            await createTask(stack, admin, authority),
          );
          const second = await seedPrimaryLink(
            stack,
            authority,
            ticketId,
            await createTask(stack, admin, authority),
          );
          const waiting = (linkId: string, generation: number) =>
            seedRequest(stack, authority, {
              ticketId,
              linkId,
              generation,
              disposition: "waiting",
            });
          const firstRequest = await waiting(first, 1);
          const refused = await waiting(second, 1).then(
            () => null,
            (error: unknown) => error as { code?: string; constraint?: string },
          );
          assertEquals(
            [refused?.code, refused?.constraint],
            ["23505", "ticket_requests_one_nonterminal_idx"],
          );
          const counts = () =>
            stack.psql(
              `select count(*)::int as total,
                      (count(*) filter (where disposition in ('waiting', 'admitted', 'active', 'suspended')))::int as nonterminal
                 from bakery.ticket_requests where external_ticket_id = $1`,
              [ticketId],
            );
          assertEquals(await counts(), [{ total: 1, nonterminal: 1 }]);

          await stack.psql(
            "update bakery.ticket_requests set disposition = 'completed' where id = $1",
            [firstRequest],
          );
          await waiting(second, 2);
          assertEquals(await counts(), [{ total: 2, nonterminal: 1 }]);
        },
      );

      await t.step(
        "bakery-ticket-intake and bakery-ticket-poll are registered with the real Inngest",
        async () => {
          const deadline = Date.now() + 90_000;
          let slugs: string[] = [];
          while (Date.now() < deadline) {
            const result = await stack.runOneOff([
              "exec",
              "-T",
              "postgres",
              "psql",
              "-U",
              "inngest",
              "-d",
              "inngest",
              "-At",
              "-c",
              `select f.slug from public.functions as f join public.apps as app on app.id = f.app_id
                where app.name = 'bakery-server' and f.slug like 'bakery-server-bakery-ticket-%'
                order by f.slug`,
            ]);
            slugs = result.output.split("\n").map((line) => line.trim()).filter(
              Boolean,
            );
            if (
              result.success && FUNCTIONS.every((slug) => slugs.includes(slug))
            ) break;
            await delay(500);
          }
          for (const slug of FUNCTIONS) {
            assert(
              slugs.includes(slug),
              `${slug} not registered; engine lists ${slugs}`,
            );
          }
        },
      );

      await t.step(
        "a signed issues delivery is accepted with 202 and admits nothing; an unverifiable one is refused",
        async () => {
          await sealWebhookSecret(stack, authority, WEBHOOK_SECRET);
          const payload = JSON.stringify({
            action: "labeled",
            issue: { number: 4245 },
            repository: { id: Number(authority.repositoryExternalId) },
            installation: { id: Number(authority.installationExternalId) },
          });
          const deliver = async (deliveryId: string, signature?: string) =>
            await stack.fetch(
              await deliveryRequest({
                url: `${stack.origin}/v1/webhooks/github`,
                secret: WEBHOOK_SECRET,
                eventName: "issues",
                deliveryId,
                body: payload,
                contentType: "application/json",
                signature,
              }),
            );
          const receiptsOf = (deliveryId: string) =>
            stack.psql(
              `select event_kind, event_action from bakery.inbound_events where external_delivery_id = $1`,
              [deliveryId],
            );

          // The server has no secrets key yet, so it cannot open the stored
          // secret: even a correct signature is refused and nothing is stored.
          const unkeyed = crypto.randomUUID();
          assertEquals((await deliver(unkeyed)).status, 401);
          assertEquals(await receiptsOf(unkeyed), []);

          await stack.restartServer({
            BAKERY_SECRETS_KEY_FILE: KEY_FILE_IN_CONTAINER,
            BAKERY_SECRETS_KEY_ID: KEY_ID,
          });

          const forged = crypto.randomUUID();
          assertEquals(
            (await deliver(forged, `sha256=${"0".repeat(64)}`)).status,
            401,
          );
          assertEquals(await receiptsOf(forged), []);

          const before = await writeCounts(stack, org);
          const deliveryId = crypto.randomUUID();
          const accepted = await deliver(deliveryId);
          assertEquals(accepted.status, 202, await accepted.clone().text());
          const receipt = await accepted.json() as {
            eventId: string;
            taskId: string | null;
          };
          assertEquals(receipt.taskId, null);
          assertEquals(await receiptsOf(deliveryId), [
            { event_kind: "issues", event_action: "labeled" },
          ]);

          // Give the routes a bounded time to leave pending or processing. The
          // outcome (deferred or failed) depends on timing and is not asserted;
          // with no credentials no outcome may create a task or a request.
          for (let attempt = 0; attempt < 30; attempt++) {
            const open = await stack.psql<{ n: number }>(
              `select count(*)::int as n from bakery.inbound_event_routes
                where inbound_event_id = $1 and status in ('pending', 'processing')`,
              [receipt.eventId],
            );
            if (open[0].n === 0) break;
            await delay(500);
          }
          assertEquals(await writeCounts(stack, org), before);
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
