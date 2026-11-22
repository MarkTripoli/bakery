import { assert, assertEquals } from "@std/assert";
import { call, seedOrganization } from "../helpers/coordinator-turns.ts";
import {
  json,
  PUBLISHABLE,
  refusal,
  runTurn,
  withFixture,
} from "../helpers/definition-authoring.ts";

// Issue #39: the conversation page finds its workflow proposals after a
// reload, in the order they were proposed, with the decider's name.

type Proposal = {
  id: string;
  conversationId: string;
  name: string;
  state: string;
  version: number;
  decidedBy: string | null;
  decidedByName: string | null;
};
type Page = { items: Proposal[]; nextCursor: string | null };

const path = (conversationId: string) =>
  `/v1/conversations/${conversationId}/workflow-definition-proposals`;

Deno.test("a conversation lists its proposals oldest first, paged, naming who decided", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "proposer", { role: "admin" });
    for (const name of ["First flow", "Second flow", "Third flow"]) {
      await runTurn(fixture, seed, [
        { type: "definitionProposal", name, definition: PUBLISHABLE },
      ]);
    }

    const first = await json<Page>(
      await call(fixture, seed, `${path(seed.conversationId)}?limit=2`),
      200,
    );
    assertEquals(first.items.map((item) => item.name), [
      "First flow",
      "Second flow",
    ]);
    assert(first.nextCursor, "a third proposal is on the next page");
    for (const item of first.items) {
      assertEquals(item.conversationId, seed.conversationId);
      assertEquals(item.state, "waiting");
      assertEquals(item.decidedBy, null);
      assertEquals(item.decidedByName, null);
    }
    const second = await json<Page>(
      await call(
        fixture,
        seed,
        `${path(seed.conversationId)}?limit=2&cursor=${
          encodeURIComponent(first.nextCursor)
        }`,
      ),
      200,
    );
    assertEquals(second.items.map((item) => item.name), ["Third flow"]);
    assertEquals(second.nextCursor, null);

    const target = first.items[0];
    const decided = await json<Proposal>(
      await call(
        fixture,
        seed,
        `/v1/workflow-definition-proposals/${target.id}/decisions`,
        {
          method: "POST",
          ifMatch: target.version,
          body: { decision: "reject" },
        },
      ),
      200,
    );
    assertEquals(decided.decidedBy, seed.principalId);
    assertEquals(decided.decidedByName, "proposer");

    const after = await json<Page>(
      await call(fixture, seed, path(seed.conversationId)),
      200,
    );
    assertEquals(after.items.map((item) => item.id)[0], target.id);
    assertEquals(after.items[0].state, "rejected");
    assertEquals(after.items[0].decidedByName, "proposer");
    assertEquals(after.items[1].decidedByName, null);
    const read = await json<Proposal>(
      await call(
        fixture,
        seed,
        `/v1/workflow-definition-proposals/${target.id}`,
      ),
      200,
    );
    assertEquals(read.decidedByName, "proposer");
  }));

Deno.test("another organization and a non-member get 404, as reading the conversation does", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "owner", { role: "admin" });
    await runTurn(fixture, owner, [
      {
        type: "definitionProposal",
        name: "Private flow",
        definition: PUBLISHABLE,
      },
    ]);
    const stranger = await seedOrganization(fixture, "stranger", {
      role: "admin",
    });

    // A member of another organization naming the conversation from there.
    const otherOrg = await refusal(
      await call(fixture, stranger, path(owner.conversationId)),
    );
    assertEquals(otherOrg, { status: 404, code: "RESOURCE_NOT_FOUND" });
    assertEquals(
      (await refusal(
        await call(
          fixture,
          stranger,
          `/v1/conversations/${owner.conversationId}`,
        ),
      )).status,
      404,
    );

    // A person who is not a member of the conversation's organization.
    const nonMember = { ...stranger, organizationId: owner.organizationId };
    const outsider = await refusal(
      await call(fixture, nonMember, path(owner.conversationId)),
    );
    assertEquals(outsider, { status: 404, code: "RESOURCE_NOT_FOUND" });
    assertEquals(
      (await refusal(
        await call(
          fixture,
          nonMember,
          `/v1/conversations/${owner.conversationId}`,
        ),
      )).status,
      404,
    );

    // The owner still sees it, and the stranger's own conversation is empty.
    const own = await json<Page>(
      await call(fixture, owner, path(owner.conversationId)),
      200,
    );
    assertEquals(own.items.map((item) => item.name), ["Private flow"]);
    const theirs = await json<Page>(
      await call(fixture, stranger, path(stranger.conversationId)),
      200,
    );
    assertEquals(theirs, { items: [], nextCursor: null });
  }));
