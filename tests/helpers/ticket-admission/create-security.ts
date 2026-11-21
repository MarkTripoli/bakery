import { assert, assertEquals } from "@std/assert";
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
import { type TicketFixture, withTicketFixture } from "./fixtures.ts";
import { type Problem, read, ticketCall } from "./operations-http.ts";

/*
 * Issue 32 security: who may create a ticket in the tracker through a source.
 * The role, the exact grant, the caller's own organization and a token's
 * scopes each refuse on their own, and a refusal sends nothing.
 */

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

Deno.test("issue 32 ops security: creating a remote ticket needs the role, the grant and the caller's own organization", async () => {
  await withTicketFixture(async (fx) => {
    try {
      const sourceId = await fx.insertSource();
      const path = `${SOURCES}/${sourceId}/tickets`;
      const body = { title: "Add a status page", body: "Show uptime." };
      const sent = () => fx.creator.requests.length;
      // The grant is held by the Admin only: nobody else may create, whatever
      // their role, and a read-only token or another organization reaches nothing.
      await fx.grantAction(fx.adminId);
      const viewer = await addMember(
        fx.f,
        seedFor(fx),
        "ticket-viewer",
        "viewer",
      );
      const guest = await addMember(fx.f, seedFor(fx), "ticket-guest", "guest");
      await fx.grantAction(viewer.principalId);
      await fx.grantAction(guest.principalId);
      for (
        const [who, cookie] of [["viewer", viewer.cookie], [
          "guest",
          guest.cookie,
        ]] as const
      ) {
        const response = await ticketCall(fx, "POST", path, { body, cookie });
        assert(
          [403, 404].includes(response.status),
          `${who} ${response.status}`,
        );
      }
      const developer = await ticketCall(fx, "POST", path, {
        body,
        cookie: fx.f.developerCookie,
      });
      assertEquals(developer.status, 403, "a Developer without the grant");
      assertEquals(sent(), 0);

      const other = await seedOrganization(fx.f, "ticket-other", {
        role: "admin",
        agent: false,
      });
      const foreign = await ticketCall(fx, "POST", path, {
        body,
        cookie: other.cookie,
        organizationId: other.organizationId,
      });
      assertEquals(foreign.status, 404, "another organization's source");
      assertEquals(sent(), 0);

      const account = await createServiceAccount(fx.f, "ticket bot", "admin");
      const readOnly = await mintToken(fx.f, account.id, ["bakery:read"]);
      const token = await bearerCall(fx.f, "POST", path, readOnly.secret, {
        body,
      });
      assertEquals(token.status, 403);
      assertEquals((await token.json() as Problem).code, "INSUFFICIENT_SCOPE");
      assertEquals(sent(), 0);

      // Control: the granted Admin does create, so the refusals above are the guard.
      await read(await ticketCall(fx, "POST", path, { body }), 202);
      assertEquals(sent(), 1);
    } finally {
      await cleanupSeededOrganizations(fx.f);
    }
  });
});
