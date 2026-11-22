import { assert, assertEquals } from "@std/assert";
import {
  call,
  type Seed,
  seedOrganization,
} from "../helpers/coordinator-turns.ts";
import {
  json,
  PUBLISHABLE,
  refusal,
  runTurn,
  withFixture,
} from "../helpers/definition-authoring.ts";

// Issue #39: a proposal read or decided by its id answers exactly as its
// conversation does. A caller who cannot reach that conversation gets the
// answer an unknown id gets; a mention grant on it opens the read only.

type Caller = { cookie: string; organizationId: string };
type Proposal = { id: string; version: number; conversationId: string };

const getPath = (id: string) => `/v1/workflow-definition-proposals/${id}`;

function getAs(fixture: Parameters<typeof call>[0], who: Caller, id: string) {
  return call(fixture, who, getPath(id));
}

function decideAs(
  fixture: Parameters<typeof call>[0],
  who: Caller,
  id: string,
  version: number,
) {
  return call(fixture, who, `${getPath(id)}/decisions`, {
    method: "POST",
    ifMatch: version,
    body: { decision: "reject" },
  });
}

async function proposalOf(
  fixture: Parameters<typeof call>[0],
  owner: Seed,
): Promise<Proposal> {
  await runTurn(fixture as never, owner, [
    {
      type: "definitionProposal",
      name: "Guarded flow",
      definition: PUBLISHABLE,
    },
  ]);
  const page = await json<{ items: Proposal[] }>(
    await call(
      fixture,
      owner,
      `/v1/conversations/${owner.conversationId}/workflow-definition-proposals`,
    ),
    200,
  );
  assertEquals(page.items.length, 1);
  return page.items[0];
}

/** get and decide on `id` answer exactly as they do for an id nobody has. */
async function answersAsUnknown(
  fixture: Parameters<typeof call>[0],
  who: Caller,
  proposal: Proposal,
  label: string,
) {
  const unknown = crypto.randomUUID();
  assertEquals(
    await refusal(await getAs(fixture, who, proposal.id)),
    await refusal(await getAs(fixture, who, unknown)),
    `${label}: get`,
  );
  assertEquals(
    await refusal(await decideAs(fixture, who, proposal.id, proposal.version)),
    await refusal(await decideAs(fixture, who, unknown, proposal.version)),
    `${label}: decide`,
  );
}

Deno.test("another organization and a non-member get and decide a proposal as an unknown id", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "owner", { role: "admin" });
    const proposal = await proposalOf(fixture, owner);
    const stranger = await seedOrganization(fixture, "stranger", {
      role: "admin",
    });

    await answersAsUnknown(fixture, stranger, proposal, "another organization");
    assertEquals(
      (await refusal(await getAs(fixture, stranger, proposal.id))).status,
      404,
    );
    const nonMember = { ...stranger, organizationId: owner.organizationId };
    await answersAsUnknown(fixture, nonMember, proposal, "non-member");
    assertEquals(
      (await refusal(await getAs(fixture, nonMember, proposal.id))).status,
      404,
    );

    // Still waiting: none of those calls decided it.
    const read = await json<{ state: string }>(
      await getAs(fixture, owner, proposal.id),
      200,
    );
    assertEquals(read.state, "waiting");
  }));

Deno.test("a proposal whose conversation is out of reach answers as an unknown id, even to an admin", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "scope", { role: "admin" });
    const proposal = await proposalOf(fixture, owner);
    // Archiving the conversation's repository takes the conversation, and so
    // its proposals, out of every reader's reach, as the list already does.
    await fixture.pgDatabase.query(
      `update bakery.repositories set archived_at = now()
        where organization_id = $1 and id = $2`,
      [owner.organizationId, owner.repositoryId],
    );
    await answersAsUnknown(
      fixture,
      owner,
      proposal,
      "out-of-scope conversation",
    );
    assertEquals(await refusal(await getAs(fixture, owner, proposal.id)), {
      status: 404,
      code: "RESOURCE_NOT_FOUND",
    });
    const state = await fixture.pgDatabase.query<{ state: string }>(
      `select state from bakery.workflow_definition_proposals where id = $1`,
      [proposal.id],
    );
    assertEquals(state.rows[0]?.state, "waiting");
  }));

Deno.test("a member whose role cannot read gets a proposal only through a grant on its conversation, and never decides it", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "granter", { role: "admin" });
    const proposal = await proposalOf(fixture, owner);
    const guestSeed = await seedOrganization(fixture, "guest", {
      role: "admin",
      agent: false,
    });
    const roleId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organization_roles
         (id, organization_id, key, name, permissions, created_by_principal_id)
       values ($1, $2, 'files-only', 'Files only', $3, $4)`,
      [roleId, owner.organizationId, ["artifact:read"], owner.principalId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, custom_role_id, status,
         joined_at, created_at, updated_at, version
       ) values ($1, $2, $3, 'guest', $4, 'active', now(), now(), now(), 1)`,
      [
        crypto.randomUUID(),
        owner.organizationId,
        guestSeed.principalId,
        roleId,
      ],
    );
    const guest = {
      cookie: guestSeed.cookie,
      organizationId: owner.organizationId,
    };

    await answersAsUnknown(fixture, guest, proposal, "guest without a grant");

    await fixture.pgDatabase.query(
      `insert into bakery.conversation_access_grants
         (organization_id, conversation_id, principal_id, granted_by)
       values ($1, $2, $3, $4)`,
      [
        owner.organizationId,
        owner.conversationId,
        guestSeed.principalId,
        owner.principalId,
      ],
    );
    const read = await json<Proposal>(
      await getAs(fixture, guest, proposal.id),
      200,
    );
    assertEquals(read.conversationId, owner.conversationId);
    const decided = await refusal(
      await decideAs(fixture, guest, proposal.id, proposal.version),
    );
    assertEquals(
      decided,
      await refusal(
        await decideAs(fixture, guest, crypto.randomUUID(), proposal.version),
      ),
      "a grant never opens deciding",
    );
    assert(decided.status >= 400);
  }));
