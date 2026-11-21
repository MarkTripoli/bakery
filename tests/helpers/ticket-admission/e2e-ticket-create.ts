/**
 * Issue 32 e2e lane: remote ticket creation on the shipped server process and
 * real Postgres (`upStack`), with the real integration gate behind the route.
 * The stack holds no GitHub App credentials, so this lane proves the honest
 * paths: the route refuses a caller without the exact grant and writes
 * nothing, and a granted caller's creation fails closed: no issue is reported
 * as created and no effect is confirmed. The positive path (the issue exists,
 * a lost response is found again by its marker) rests on the integration lane
 * with the fake GitHub, and live GitHub stays open under G3.
 */
import { assert, assertEquals } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { defaultTicketSourcePolicy } from "../../../packages/contracts/src/ticket-admission.ts";
import { upStack } from "../../e2e/helpers/stack.ts";
import {
  addViewer,
  seedAuthority,
  signedInAdmin,
  sourceBody,
  stackCall,
} from "./e2e-seed.ts";

type Problem = { code: string };

Deno.test(
  "issue 32 e2e: creating a remote ticket needs the exact grant and fails closed without GitHub credentials",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upStack("tickets");
    const owner = openPgDatabase(stack.ownerDatabaseUrl);
    try {
      const admin = await signedInAdmin(stack);
      const authority = await seedAuthority(stack, owner, admin);
      const org = authority.organizationId;
      const created = await stackCall(
        stack,
        admin,
        "POST",
        "/v1/ticket-sources",
        sourceBody(authority, defaultTicketSourcePolicy()),
      );
      assertEquals(created.status, 201, await created.clone().text());
      const sourceId = (await created.json() as { id: string }).id;
      const path = `/v1/ticket-sources/${sourceId}/tickets`;
      const issue = { title: "Add a status page", body: "Show uptime." };
      const effects = async () =>
        (await stack.psql<{ total: number; confirmed: number }>(
          `select count(*)::int as total,
                  count(*) filter (where status = 'confirmed')::int as confirmed
             from bakery.external_effects where organization_id = $1`,
          [org],
        ))[0];
      const before = await effects();

      // No grant: the Admin's role alone does not admit, and nothing is written.
      const refused = await stackCall(stack, admin, "POST", path, issue);
      assertEquals(
        [refused.status, (await refused.json() as Problem).code],
        [403, "AUTH_FORBIDDEN"],
      );
      // A Viewer is refused whatever grants exist.
      const viewer = await addViewer(stack, admin);
      const asViewer = await stackCall(stack, viewer, "POST", path, issue);
      assert([403, 404].includes(asViewer.status), String(asViewer.status));
      assertEquals(await effects(), before);

      // With the grant, the call reaches the real gate, which has no usable
      // credentials: it must not report a created issue.
      await stack.psql(
        `insert into bakery.integration_grants (
           id, organization_id, connection_id, subject_type,
           subject_principal_id, direction, capability, action_version,
           resource_id, granted_by
         ) values (gen_random_uuid(), $1, $2, 'principal', $3, 'out_of_bakery',
                   'github.issue.create', 1, $4, $3)`,
        [
          org,
          authority.connectionId,
          authority.principalId,
          authority.resourceId,
        ],
      );
      const granted = await stackCall(stack, admin, "POST", path, issue);
      const text = await granted.text();
      const receipt = granted.status === 202
        ? JSON.parse(text) as { status: string }
        : null;
      assert(
        receipt === null || receipt.status !== "submitted" ||
          (await effects()).confirmed === 0,
        text,
      );
      assertEquals((await effects()).confirmed, before.confirmed, text);
    } finally {
      await closePgDatabase(owner);
      await stack.down();
    }
  },
);
