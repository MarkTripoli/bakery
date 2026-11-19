import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  SESSION_CALL_PATH,
  SESSION_CREDENTIAL_HEADER,
} from "../../apps/server/src/modules/execution/session-routes.ts";

// #401 slice 4: `library.search` offered to a session as a read-scoped tool.
//
// Driven through the real app and the session gateway, because the two ways
// this can be wrong are invisible below it: a search that works but is not
// offered, and a search that is offered but refuses the person it acts for.

type Hit = {
  kind: string;
  id: string;
  name: string;
  description: string | null;
};
type Page = { items: Hit[]; nextCursor: string | null };

Deno.test("a session can search the library as the person it acts for", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    const seeded = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const org = fixture.organizationId;
    await fixture.pgDatabase.query(
      `insert into bakery.skills (id, organization_id, slug, name, description)
       values ($1, $2, 'zebra-planner', 'Zebra Planner', 'Plans stripes')`,
      [crypto.randomUUID(), org],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.agent_definitions (organization_id, slug, name, description)
       values ($1, 'stripe-agent', 'Stripe Agent', 'Paints a ZEBRA')`,
      [org],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.artifacts (organization_id, task_id, artifact_type, name)
       values ($1, $2, 'research', 'zebra notes')`,
      [org, seeded.taskId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.skills (id, organization_id, slug, name, description)
       values ($1, $2, 'unrelated', 'Unrelated', null)`,
      [crypto.randomUUID(), org],
    );

    const assignment = await claimAssignment(fixture, worker) as unknown as {
      attemptId: string;
      sessionCredential: string;
    };
    const search = (args: Record<string, unknown>) =>
      workerRequest(
        fixture,
        worker.credential,
        SESSION_CALL_PATH.replace(":id", assignment.attemptId),
        { tool: "library.search", arguments: args },
        {
          headers: {
            [SESSION_CREDENTIAL_HEADER]: assignment.sessionCredential,
          },
        },
      );
    const page = async (args: Record<string, unknown>) => {
      const response = await search(args);
      const text = await response.text();
      assertEquals(response.status, 200, text);
      return (JSON.parse(text) as { result: Page }).result;
    };
    const names = (hits: Page) => hits.items.map((hit) => hit.name).sort();

    // All three kinds, case-insensitive, name or description.
    const all = await page({ query: "ZeBrA" });
    assertEquals(names(all), ["Stripe Agent", "Zebra Planner", "zebra notes"]);
    assertEquals(
      all.items.map((hit) => hit.kind).sort(),
      ["agent", "artifact", "skill"],
    );
    assertEquals(
      all.items.find((hit) => hit.kind === "artifact")?.description,
      null,
    );

    // The kind filter narrows; a wildcard typed by the caller is literal.
    assertEquals(
      names(await page({ query: "zebra", kind: "skill" })),
      ["Zebra Planner"],
    );
    assertEquals((await page({ query: "%" })).items.length, 0);
    assertEquals((await page({ query: "_" })).items.length, 0);

    // Keyset paging: two pages of one, distinct, then the cursor is bound to
    // its query and cannot be replayed against another.
    const first = await page({ query: "zebra", limit: 1 });
    assertEquals(first.items.length, 1);
    assert(first.nextCursor !== null, "expected a second page");
    const second = await page({
      query: "zebra",
      limit: 1,
      cursor: first.nextCursor,
    });
    assertEquals(second.items.length, 1);
    assertNotEquals(second.items[0].id, first.items[0].id);
    const replayed = await search({
      query: "stripe",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert(
      replayed.status >= 400 && replayed.status < 500,
      `a cursor replayed against another query was served: ${replayed.status}`,
    );
    await replayed.body?.cancel();

    // A person who has lost access gets nothing: the guard is the lists' guard.
    await fixture.pgDatabase.query(
      `delete from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2`,
      [org, fixture.principalId],
    );
    const refused = await search({ query: "zebra" });
    assertEquals(refused.status, 404, await refused.text());
  }));

Deno.test("a session without artifacts.read gets no artifact through search", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    const seeded = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const org = fixture.organizationId;
    await fixture.pgDatabase.query(
      `insert into bakery.skills (id, organization_id, slug, name, description)
       values ($1, $2, 'zebra-planner', 'Zebra Planner', null)`,
      [crypto.randomUUID(), org],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.agent_definitions (organization_id, slug, name, description)
       values ($1, 'zebra-agent', 'Zebra Agent', null)`,
      [org],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.artifacts (organization_id, task_id, artifact_type, name)
       values ($1, $2, 'research', 'zebra notes')`,
      [org, seeded.taskId],
    );
    const assignment = await claimAssignment(fixture, worker) as unknown as {
      attemptId: string;
      sessionCredential: string;
    };
    const search = (args: Record<string, unknown>) =>
      workerRequest(
        fixture,
        worker.credential,
        SESSION_CALL_PATH.replace(":id", assignment.attemptId),
        { tool: "library.search", arguments: args },
        {
          headers: {
            [SESSION_CREDENTIAL_HEADER]: assignment.sessionCredential,
          },
        },
      );
    const kinds = async (args: Record<string, unknown>) => {
      const response = await search(args);
      const text = await response.text();
      assertEquals(response.status, 200, text);
      return (JSON.parse(text) as { result: Page }).result.items
        .map((hit) => hit.kind).sort();
    };

    // With every read scope the session sees all three kinds.
    assertEquals(await kinds({ query: "zebra" }), [
      "agent",
      "artifact",
      "skill",
    ]);

    // A definition narrowed to library.read: skills and agents still answer,
    // artifacts do not, and asking for them by kind is refused outright.
    await fixture.pgDatabase.query(
      `update bakery.session_operation_credentials set scopes = $1
        where attempt_id = $2 and revoked_at is null`,
      [["library.read"], assignment.attemptId],
    );
    assertEquals(await kinds({ query: "zebra" }), ["agent", "skill"]);
    const forbidden = await search({ query: "zebra", kind: "artifact" });
    assertEquals(forbidden.status, 403, await forbidden.text());
  }));

Deno.test("a long query pages without overflowing the cursor", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const org = fixture.organizationId;
    // The longest query the schema allows (200 characters): in ASCII, and in CJK
    // where it is 600 bytes in UTF-8. Both would overflow a cursor that carried
    // the query itself.
    const queries = ["q".repeat(200), "検".repeat(200)];
    for (const [index, query] of queries.entries()) {
      for (let item = 0; item < 3; item += 1) {
        await fixture.pgDatabase.query(
          `insert into bakery.skills (id, organization_id, slug, name)
           values ($1, $2, $3, $4)`,
          [
            crypto.randomUUID(),
            org,
            `long-${index}-${item}`,
            `${query} ${item}`,
          ],
        );
      }
    }
    const assignment = await claimAssignment(fixture, worker) as unknown as {
      attemptId: string;
      sessionCredential: string;
    };
    const search = (args: Record<string, unknown>) =>
      workerRequest(
        fixture,
        worker.credential,
        SESSION_CALL_PATH.replace(":id", assignment.attemptId),
        { tool: "library.search", arguments: args },
        {
          headers: {
            [SESSION_CREDENTIAL_HEADER]: assignment.sessionCredential,
          },
        },
      );
    for (const query of queries) {
      const seen = new Set<string>();
      let cursor: string | null | undefined = undefined;
      for (let pages = 0; pages < 5; pages += 1) {
        const response = await search({
          query,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        const text = await response.text();
        assertEquals(response.status, 200, text);
        const page = (JSON.parse(text) as { result: Page }).result;
        for (const hit of page.items) seen.add(hit.id);
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      // Three matches, one per page, no repeats and no error on the way.
      assertEquals(seen.size, 3);
    }
    // Past the bound a query is refused by the schema, never a 500.
    const tooLong = await search({ query: "検".repeat(1000) });
    assert(
      tooLong.status >= 400 && tooLong.status < 500,
      `a 1000-character query answered ${tooLong.status}`,
    );
    await tooLong.body?.cancel();
  }));
