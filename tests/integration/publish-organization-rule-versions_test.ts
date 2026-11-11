import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../apps/server/src/platform/postgres-errors.ts";
import {
  allRuleEntries,
  commitsEntry,
  databaseCount,
  openRepositoryRulesFixture,
  ruleDigest,
  ruleFactCounts,
  titleEntry,
} from "../helpers/repository-rules-fixture.ts";

function problemShape(body: Record<string, unknown>) {
  const { instance: _i, requestId: _r, traceId: _t, ...stable } = body;
  return stable;
}

type RuleVersion = {
  id?: string;
  organizationId: string;
  revision: number;
  entries: unknown[];
  digest: string;
  createdAt: string | null;
  createdBy: string | null;
};

Deno.test("publish and read immutable organization rule versions through the mounted API", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const rulesA = f.rulesPath(organizationAId);
  const versionsA = f.versionsPath(organizationAId);
  const publish = (
    expectedRevision: number,
    entries: unknown[],
    key: string = crypto.randomUUID(),
    body: Record<string, unknown> = { expectedRevision, entries },
  ) =>
    send("POST", versionsA, {
      cookie: f.cookies.adminA,
      organizationId: organizationAId,
      idempotencyKey: key,
      body,
    });
  const expectNoFacts = async (
    request: () => Promise<Response> | Response,
    expectedStatus: number,
  ): Promise<Response> => {
    const before = await ruleFactCounts(runtime, organizationAId);
    const response = await request();
    assertEquals(response.status, expectedStatus);
    assertEquals(await ruleFactCounts(runtime, organizationAId), before);
    return response;
  };

  try {
    await test.step("AC1: no published revision reads as the canonical empty baseline", async () => {
      const unauthenticated = await send("GET", rulesA, {
        organizationId: organizationAId,
      });
      assertEquals(unauthenticated.status, 401);
      const response = await send("GET", rulesA, {
        cookie: f.cookies.adminA,
        organizationId: organizationAId,
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("etag"), null);
      const body = await response.json() as RuleVersion;
      assertEquals(body, {
        organizationId: organizationAId,
        revision: 0,
        entries: [],
        digest: await ruleDigest(0, []),
        createdAt: null,
        createdBy: null,
      });
      const list = await send("GET", versionsA, {
        cookie: f.cookies.adminA,
        organizationId: organizationAId,
      });
      assertEquals(list.status, 200);
      assertEquals(await list.json(), { items: [], nextCursor: null });
    });

    await test.step("AC4: developers cannot read, list or publish", async () => {
      // A denied read answers like a missing resource; a denied write is 403.
      const options = {
        cookie: f.cookies.developerA,
        organizationId: organizationAId,
      };
      assertEquals((await send("GET", rulesA, options)).status, 404);
      assertEquals((await send("GET", versionsA, options)).status, 404);
      await expectNoFacts(
        () =>
          send("POST", versionsA, {
            ...options,
            idempotencyKey: crypto.randomUUID(),
            body: { expectedRevision: 0, entries: [commitsEntry()] },
          }),
        403,
      );
    });

    const first = [commitsEntry(true)];
    let firstBody: RuleVersion;
    let firstText = "";
    await test.step("AC2: publish at expectedRevision 0 stores row, digest, author, audit and event", async () => {
      const key = "rules-publish-1";
      const created = await publish(0, first, key);
      assertEquals(created.status, 201);
      firstText = await created.text();
      firstBody = JSON.parse(firstText) as RuleVersion;
      assertEquals(firstBody.revision, 1);
      assertEquals(firstBody.organizationId, organizationAId);
      assertEquals(firstBody.createdBy, f.adminA.principalId);
      assertEquals(firstBody.entries, first);
      assertEquals(firstBody.digest, await ruleDigest(1, first));
      assertEquals(await ruleFactCounts(runtime, organizationAId), {
        versions: 1,
        audit: 1,
        events: 1,
        outbox: 0,
      });
      const event = await runtime.query<
        { payload: { resourceId: string; resourceVersion: number } }
      >(
        `select payload from bakery.domain_events
          where organization_id = $1 and event_type = 'repositoryRules.published'`,
        [organizationAId],
      );
      assertEquals(event.rows[0]?.payload, {
        resourceId: firstBody.id,
        resourceVersion: 1,
      });
      const stored = await runtime.query<{ config: unknown; digest: string }>(
        `select config, digest from bakery.organization_repository_rule_versions
          where organization_id = $1 and revision = 1`,
        [organizationAId],
      );
      assertEquals(stored.rows[0]?.config, { revision: 1, entries: first });
      assertEquals(stored.rows[0]?.digest, firstBody.digest);

      const replay = await publish(0, first, key);
      assertEquals(replay.status, 201);
      assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
      assertEquals(await replay.text(), firstText);
      assertEquals(
        (await ruleFactCounts(runtime, organizationAId)).versions,
        1,
      );

      const mismatch = await expectNoFacts(
        () => publish(0, [titleEntry()], key),
        422,
      );
      assertEquals(
        (await mismatch.json() as { code: string }).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );

      const read = await send("GET", rulesA, {
        cookie: f.cookies.adminA,
        organizationId: organizationAId,
      });
      const current = await read.json() as RuleVersion;
      assertEquals(current.revision, 1);
      assertEquals(current.entries, first);
      assertEquals(current.digest, firstBody.digest);
      assertEquals(current.createdBy, f.adminA.principalId);
    });

    await test.step("stale, malformed and key-less publications write nothing", async () => {
      const stale = await expectNoFacts(() => publish(0, first), 412);
      assertEquals(
        (await stale.json() as { code: string }).code,
        "PRECONDITION_FAILED",
      );
      await expectNoFacts(
        () =>
          send("POST", versionsA, {
            cookie: f.cookies.adminA,
            organizationId: organizationAId,
            body: { expectedRevision: 1, entries: first },
          }),
        428,
      );
      const duplicateKey = await expectNoFacts(
        () => publish(1, [commitsEntry(), commitsEntry(false)]),
        422,
      );
      assertEquals(
        (await duplicateKey.json() as { code: string }).code,
        "UNPROCESSABLE",
      );
      await expectNoFacts(
        () => publish(1, [{ ruleKey: "commits.semantic", enabled: true }]),
        400,
      );
      await expectNoFacts(
        () => publish(1, [{ ...commitsEntry(), ruleKey: "unknown.rule" }]),
        400,
      );
      await expectNoFacts(
        () =>
          publish(1, first, crypto.randomUUID(), {
            expectedRevision: -1,
            entries: first,
          }),
        400,
      );
      await expectNoFacts(
        () =>
          publish(1, first, crypto.randomUUID(), {
            expectedRevision: 1,
            revision: 9,
            entries: first,
          }),
        400,
      );
    });

    await test.step("revision 2 replaces the whole entry list", async () => {
      const second = [commitsEntry(false), titleEntry(100)];
      const created = await publish(1, second);
      assertEquals(created.status, 201);
      const body = await created.json() as RuleVersion;
      assertEquals(body.revision, 2);
      assertEquals(body.entries, second);
      assertEquals(body.digest, await ruleDigest(2, second));
    });

    await test.step("AC3: concurrent publications at one expected revision commit once", async () => {
      let requests: [
        Promise<Response> | Response,
        Promise<Response> | Response,
      ];
      await withPgTransaction(runtime, async (transaction) => {
        await transaction.query(
          `select pg_advisory_xact_lock(
             hashtextextended('bakery:organization:' || $1::text, 0)
           )`,
          [organizationAId],
        );
        const a = publish(2, [titleEntry(80)], "concurrent-a");
        await new Promise((resolve) => setTimeout(resolve, 150));
        const b = publish(2, [titleEntry(90)], "concurrent-b");
        await new Promise((resolve) => setTimeout(resolve, 150));
        requests = [a, b];
      });
      const responses = await Promise.all(requests!);
      assertEquals(responses.map(({ status }) => status).sort(), [201, 412]);
      assertEquals(
        await databaseCount(
          runtime,
          "select count(*) from bakery.organization_repository_rule_versions where organization_id = $1 and revision = 3",
          [organizationAId],
        ),
        1,
      );
      assertEquals(
        (await ruleFactCounts(runtime, organizationAId)).versions,
        3,
      );
      assertEquals((await ruleFactCounts(runtime, organizationAId)).audit, 3);
      assertEquals((await ruleFactCounts(runtime, organizationAId)).events, 3);
    });

    await test.step("AC5: list is newest first, cursor-stable and digest-verifiable", async () => {
      const listOptions = {
        cookie: f.cookies.adminA,
        organizationId: organizationAId,
      };
      const page1 = await send("GET", `${versionsA}?limit=2`, listOptions);
      assertEquals(page1.status, 200);
      const one = await page1.json() as {
        items: RuleVersion[];
        nextCursor: string | null;
      };
      assertEquals(one.items.map(({ revision }) => revision), [3, 2]);
      assert(one.nextCursor);

      // A newer revision published between pages must not disturb the cursor.
      const fourth = await publish(3, [titleEntry(120)]);
      assertEquals(fourth.status, 201);

      const page2 = await send(
        "GET",
        `${versionsA}?limit=2&cursor=${encodeURIComponent(one.nextCursor)}`,
        listOptions,
      );
      assertEquals(page2.status, 200);
      const two = await page2.json() as {
        items: RuleVersion[];
        nextCursor: string | null;
      };
      assertEquals(two.items.map(({ revision }) => revision), [1]);
      assertEquals(two.nextCursor, null);

      const all = await send("GET", versionsA, listOptions);
      const everything = (await all.json() as { items: RuleVersion[] }).items;
      assertEquals(everything.map(({ revision }) => revision), [4, 3, 2, 1]);
      for (const item of everything) {
        assertEquals(
          item.digest,
          await ruleDigest(item.revision, item.entries),
        );
        assertEquals(item.organizationId, organizationAId);
      }

      const foreign = await send(
        "GET",
        `${f.versionsPath(organizationBId)}?limit=2&cursor=${
          encodeURIComponent(one.nextCursor)
        }`,
        {
          cookie: f.cookies.adminB,
          organizationId: organizationBId,
        },
      );
      assertEquals(foreign.status, 400);
      assertEquals(
        (await foreign.json() as { code: string }).code,
        "INVALID_CURSOR",
      );
      const forged = await send(
        "GET",
        `${versionsA}?cursor=${encodeURIComponent(one.nextCursor + "x")}`,
        listOptions,
      );
      assertEquals(forged.status, 400);
      const tooMany = await send("GET", `${versionsA}?limit=101`, listOptions);
      assertEquals(tooMany.status, 400);
    });

    await test.step("rows are immutable for the application role", async () => {
      for (const privilege of ["UPDATE", "DELETE"]) {
        const result = await runtime.query<{ allowed: boolean }>(
          `select has_table_privilege(
             current_user,
             'bakery.organization_repository_rule_versions',
             $1
           ) as allowed`,
          [privilege],
        );
        assertEquals(result.rows[0]?.allowed, false);
      }
    });

    await test.step("every rule key publishes and loose options are rejected", async () => {
      const entries = allRuleEntries();
      let revision = 4;
      for (const entry of entries) {
        const created = await publish(revision, [entry]);
        assertEquals(created.status, 201, entry.ruleKey);
        const body = await created.json() as RuleVersion;
        revision += 1;
        assertEquals(body.revision, revision);
        assertEquals(body.entries, [entry]);
        assertEquals(body.digest, await ruleDigest(revision, [entry]));
      }
      const all = await publish(revision, entries);
      assertEquals(all.status, 201);
      assertEquals((await all.json() as RuleVersion).entries, entries);
      revision += 1;
      const [first] = entries;
      await expectNoFacts(
        () =>
          publish(revision, [
            { ...first, options: { ...first.options, surprise: true } },
          ]),
        400,
      );
      await expectNoFacts(
        () =>
          publish(revision, [
            { ...first, options: { ...first.options, maxSubjectLength: "x" } },
          ]),
        400,
      );
    });

    await test.step("AC4: another organization cannot read or publish by path", async () => {
      const unknown = crypto.randomUUID();
      const optionsB = {
        cookie: f.cookies.adminB,
        organizationId: organizationBId,
      };
      const unknownRead = await send("GET", f.rulesPath(unknown), optionsB);
      const crossRead = await send("GET", rulesA, optionsB);
      assertEquals(unknownRead.status, 404);
      assertEquals(crossRead.status, 404);
      assertEquals(
        problemShape(await crossRead.json()),
        problemShape(await unknownRead.json()),
      );

      const crossList = await send("GET", versionsA, optionsB);
      const unknownList = await send("GET", f.versionsPath(unknown), optionsB);
      assertEquals(crossList.status, 404);
      assertEquals(
        problemShape(await crossList.json()),
        problemShape(await unknownList.json()),
      );

      const before = await ruleFactCounts(runtime, organizationAId);
      const body = { expectedRevision: 4, entries: [titleEntry()] };
      const crossPublish = await send("POST", versionsA, {
        ...optionsB,
        idempotencyKey: crypto.randomUUID(),
        body,
      });
      const unknownPublish = await send("POST", f.versionsPath(unknown), {
        ...optionsB,
        idempotencyKey: crypto.randomUUID(),
        body,
      });
      assertEquals(crossPublish.status, 404);
      assertEquals(
        problemShape(await crossPublish.json()),
        problemShape(await unknownPublish.json()),
      );
      assertEquals(await ruleFactCounts(runtime, organizationAId), before);
      assertEquals(
        (await ruleFactCounts(runtime, organizationBId)).versions,
        0,
      );

      const orgBRead = await send(
        "GET",
        f.rulesPath(organizationBId),
        optionsB,
      );
      assertEquals((await orgBRead.json() as RuleVersion).revision, 0);
    });

    const maxRevision = async (organizationId: string) =>
      await databaseCount(
        runtime,
        "select coalesce(max(revision), 0) as count from bakery.organization_repository_rule_versions where organization_id = $1",
        [organizationId],
      );
    const optionsB = {
      cookie: f.cookies.adminB,
      organizationId: organizationBId,
    };
    const publishB = (expectedRevision: number, key = crypto.randomUUID()) =>
      send("POST", f.versionsPath(organizationBId), {
        ...optionsB,
        idempotencyKey: key,
        body: { expectedRevision, entries: [titleEntry()] },
      });

    await test.step("revision checks only see the caller's own organization", async () => {
      const aMax = await maxRevision(organizationAId);
      assert(aMax >= 2);
      const aBefore = await ruleFactCounts(runtime, organizationAId);
      // Organization A already holds revisions; B's first publication is still 0 -> 1.
      const staleForB = await publishB(aMax);
      assertEquals(staleForB.status, 412);
      const first = await publishB(0);
      assertEquals(first.status, 201);
      const body = await first.json() as RuleVersion;
      assertEquals(body.revision, 1);
      assertEquals(body.organizationId, organizationBId);
      assertEquals(body.createdBy, f.adminB.principalId);
      assertEquals(await maxRevision(organizationBId), 1);
      assertEquals(await ruleFactCounts(runtime, organizationAId), aBefore);
      // A's next stale publication is unaffected by B's rows.
      assertEquals((await publish(1, [titleEntry()])).status, 412);
    });

    await test.step("publication waits on the organization lock and resumes after release", async () => {
      const expected = await maxRevision(organizationAId);
      let pending: Promise<Response> | Response;
      await withPgTransaction(runtime, async (transaction) => {
        await transaction.query(
          `select pg_advisory_xact_lock(
             hashtextextended('bakery:organization:' || $1::text, 0)
           )`,
          [organizationAId],
        );
        pending = publish(expected, [titleEntry(77)]);
        const settled = await Promise.race([
          Promise.resolve(pending).then(() => "settled"),
          new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
        ]);
        assertEquals(settled, "waiting");
        assertEquals(await maxRevision(organizationAId), expected);
      });
      const response = await pending!;
      assertEquals(response.status, 201);
      assertEquals(
        (await response.json() as RuleVersion).revision,
        expected + 1,
      );
    });

    await test.step("the unique constraint rejects a duplicate revision for the application role", async () => {
      const error = await runtime.query(
        `insert into bakery.organization_repository_rule_versions (
           id, organization_id, revision, config, digest
         ) values ($1, $2, 1, '{}'::jsonb, 'x')`,
        [crypto.randomUUID(), organizationAId],
      ).then(() => undefined, (cause: unknown) => cause);
      assertEquals(postgresErrorCode(error), POSTGRES_UNIQUE_VIOLATION);
    });

    await test.step("a role removed while a publication waits for the lock is refused", async () => {
      const expected = await maxRevision(organizationAId);
      const before = await ruleFactCounts(runtime, organizationAId);
      let pending: Promise<Response> | Response;
      await withPgTransaction(runtime, async (transaction) => {
        await transaction.query(
          `select pg_advisory_xact_lock(
             hashtextextended('bakery:organization:' || $1::text, 0)
           )`,
          [organizationAId],
        );
        pending = send("POST", versionsA, {
          cookie: f.cookies.demotableA,
          organizationId: organizationAId,
          idempotencyKey: crypto.randomUUID(),
          body: { expectedRevision: expected, entries: [titleEntry(66)] },
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await f.owner`
          update bakery.organization_memberships
             set role = 'developer'
           where organization_id = ${organizationAId}
             and principal_id = ${f.demotableA.principalId}`;
      });
      assertEquals((await pending!).status, 403);
      assertEquals(await ruleFactCounts(runtime, organizationAId), before);
    });

    await test.step("text PostgreSQL cannot store is rejected before any write", async () => {
      const [, , description] = allRuleEntries();
      for (
        const template of ["bad\u0000text", "lone\ud800surrogate"]
      ) {
        const entry = {
          ...description,
          options: { ...description.options, template },
        };
        const expected = await maxRevision(organizationAId);
        await expectNoFacts(() => publish(expected, [entry]), 400);
      }
    });

    await test.step("a list cursor is bound to its organization for the same principal", async () => {
      const inA = await send("GET", `${versionsA}?limit=1`, {
        cookie: f.cookies.adminAB,
        organizationId: organizationAId,
      });
      assertEquals(inA.status, 200);
      const cursor = (await inA.json() as { nextCursor: string | null })
        .nextCursor;
      assert(cursor);
      const inB = await send(
        "GET",
        `${f.versionsPath(organizationBId)}?limit=1&cursor=${
          encodeURIComponent(cursor)
        }`,
        { cookie: f.cookies.adminAB, organizationId: organizationBId },
      );
      assertEquals(inB.status, 400);
      assertEquals(
        (await inB.json() as { code: string }).code,
        "INVALID_CURSOR",
      );
    });
  } finally {
    await f.close();
  }
});
