import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import {
  commitsEntry,
  openRepositoryRulesFixture,
  ruleFactCounts,
  titleEntry,
} from "../helpers/repository-rules-fixture.ts";

function problemShape(body: Record<string, unknown>) {
  const { instance: _i, requestId: _r, traceId: _t, ...stable } = body;
  return stable;
}

Deno.test("organization rule versions hold tenant isolation and role limits", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const rulesA = f.rulesPath(organizationAId);
  const versionsA = f.versionsPath(organizationAId);
  const unknownOrganization = crypto.randomUUID();
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminB = { cookie: f.cookies.adminB, organizationId: organizationBId };
  try {
    const seeded = await send("POST", versionsA, {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      body: { expectedRevision: 0, entries: [commitsEntry()] },
    });
    assertEquals(seeded.status, 201);
    const baseline = await ruleFactCounts(runtime, organizationAId);

    await test.step("cross-tenant path access answers as an unknown organization", async () => {
      const cases: Array<
        [string, (organizationId: string) => Promise<Response> | Response]
      > = [
        ["get", (id) => send("GET", f.rulesPath(id), adminB)],
        ["list", (id) => send("GET", f.versionsPath(id), adminB)],
        [
          "publish",
          (id) =>
            send("POST", f.versionsPath(id), {
              ...adminB,
              idempotencyKey: crypto.randomUUID(),
              body: { expectedRevision: 1, entries: [titleEntry()] },
            }),
        ],
      ];
      for (const [label, call] of cases) {
        const foreign = await call(organizationAId);
        const unknown = await call(unknownOrganization);
        assertEquals(foreign.status, 404, label);
        assertEquals(unknown.status, 404, label);
        assertEquals(
          problemShape(await foreign.json()),
          problemShape(await unknown.json()),
          label,
        );
      }
      assertEquals(await ruleFactCounts(runtime, organizationAId), baseline);
    });

    await test.step("a non-member answers exactly like an unknown organization", async () => {
      const header = {
        cookie: f.cookies.adminB,
        organizationId: organizationAId,
      };
      const body = { expectedRevision: 1, entries: [titleEntry()] };
      const calls: Array<
        [string, (organizationId: string) => Promise<Response> | Response]
      > = [
        [
          "get",
          (id) =>
            send("GET", f.rulesPath(id), { ...header, organizationId: id }),
        ],
        [
          "list",
          (id) =>
            send("GET", f.versionsPath(id), { ...header, organizationId: id }),
        ],
        [
          "publish",
          (id) =>
            send("POST", f.versionsPath(id), {
              ...header,
              organizationId: id,
              idempotencyKey: crypto.randomUUID(),
              body,
            }),
        ],
      ];
      for (const [label, call] of calls) {
        const member = await call(organizationAId);
        const unknown = await call(unknownOrganization);
        assertEquals(member.status, 404, label);
        assertEquals(unknown.status, 404, label);
        assertEquals(
          problemShape(await member.json()),
          problemShape(await unknown.json()),
          label,
        );
      }
      assertEquals(await ruleFactCounts(runtime, organizationAId), baseline);
    });

    await test.step("viewer, guest and inactive members cannot read, list or publish", async () => {
      const body = { expectedRevision: 1, entries: [titleEntry()] };
      const cases: Array<[string, string, number, number]> = [
        ["viewer", f.cookies.viewerA, 404, 403],
        ["guest", f.cookies.guestA, 404, 404],
        ["inactive", f.cookies.inactiveA, 404, 404],
      ];
      for (const [label, cookie, readStatus, writeStatus] of cases) {
        const options = { cookie, organizationId: organizationAId };
        assertEquals(
          (await send("GET", rulesA, options)).status,
          readStatus,
          label,
        );
        assertEquals(
          (await send("GET", versionsA, options)).status,
          readStatus,
          label,
        );
        assertEquals(
          (await send("POST", versionsA, {
            ...options,
            idempotencyKey: crypto.randomUUID(),
            body,
          })).status,
          writeStatus,
          label,
        );
      }
      assertEquals(await ruleFactCounts(runtime, organizationAId), baseline);
    });

    await test.step("real access tokens of every scope never reach these operations", async () => {
      const mint = async (scopes: string[]) => {
        const body = btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
        ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
        const secret = `bky_${body}`;
        await f.owner`
          insert into bakery.access_tokens (
            organization_id, principal_id, created_by_principal_id, name,
            prefix, secret_sha256, scopes, expires_at
          ) values (
            ${organizationAId}, ${f.adminA.principalId},
            ${f.adminA.principalId}, 'rule versions security',
            ${secret.slice(0, 12)}, ${await sha256Hex(secret)}, ${scopes},
            ${new Date(Date.now() + 3_600_000)}
          )`;
        return secret;
      };
      const tokens = {
        admin: await mint(["bakery:admin"]),
        read: await mint(["bakery:read"]),
        operate: await mint(["bakery:operate"]),
        fake: `bky_${"x".repeat(43)}`,
      };
      for (const [label, secret] of Object.entries(tokens)) {
        const authorization = `Bearer ${secret}`;
        for (
          const response of [
            await send("GET", rulesA, {
              organizationId: organizationAId,
              authorization,
            }),
            await send("GET", versionsA, {
              organizationId: organizationAId,
              authorization,
            }),
            await send("POST", versionsA, {
              organizationId: organizationAId,
              authorization,
              idempotencyKey: crypto.randomUUID(),
              body: { expectedRevision: 1, entries: [titleEntry()] },
            }),
          ]
        ) {
          assertEquals(response.status, 401, label);
          assertEquals(
            (await response.json() as { code: string }).code,
            "AUTH_INVALID",
            label,
          );
        }
      }
      assertEquals(await ruleFactCounts(runtime, organizationAId), baseline);
    });

    await test.step("organization B never sees organization A revisions", async () => {
      const read = await send("GET", f.rulesPath(organizationBId), adminB);
      assertEquals((await read.json() as { revision: number }).revision, 0);
      const list = await send("GET", f.versionsPath(organizationBId), adminB);
      assertEquals(await list.json(), { items: [], nextCursor: null });
    });

    await test.step("a developer cannot escalate to publish or read", async () => {
      const developer = {
        cookie: f.cookies.developerA,
        organizationId: organizationAId,
      };
      const publish = await send("POST", versionsA, {
        ...developer,
        idempotencyKey: crypto.randomUUID(),
        body: { expectedRevision: 1, entries: [titleEntry()] },
      });
      assertEquals(publish.status, 403);
      assertEquals((await send("GET", rulesA, developer)).status, 404);
      assertEquals((await send("GET", versionsA, developer)).status, 404);
      assertEquals(await ruleFactCounts(runtime, organizationAId), baseline);
    });

    await test.step("callers cannot smuggle revision, organization or author", async () => {
      for (
        const extra of [
          { revision: 9 },
          { organizationId: organizationBId },
          { createdBy: f.adminB.principalId },
          { digest: "0".repeat(64) },
        ]
      ) {
        const response = await send("POST", versionsA, {
          ...adminA,
          idempotencyKey: crypto.randomUUID(),
          body: { expectedRevision: 1, entries: [titleEntry()], ...extra },
        });
        assertEquals(response.status, 400, JSON.stringify(extra));
      }
      assertEquals(await ruleFactCounts(runtime, organizationAId), baseline);
      const stored = await runtime.query<{ created_by: string }>(
        `select created_by from bakery.organization_repository_rule_versions
          where organization_id = $1`,
        [organizationAId],
      );
      assertEquals(stored.rows.map((row) => row.created_by), [
        f.adminA.principalId,
      ]);
    });

    await test.step("unauthenticated and cross-origin requests are refused", async () => {
      assertEquals(
        (await send("GET", rulesA, { organizationId: organizationAId })).status,
        401,
      );
      const noOrigin = await f.fixture.app.fetch(
        new Request(`http://untrusted.example${versionsA}`, {
          method: "POST",
          headers: {
            cookie: f.cookies.adminA,
            "Bakery-Organization-Id": organizationAId,
            "Idempotency-Key": crypto.randomUUID(),
            "content-type": "application/json",
            origin: "http://untrusted.example",
          },
          body: JSON.stringify({
            expectedRevision: 1,
            entries: [titleEntry()],
          }),
        }),
      );
      assert(noOrigin.status >= 400 && noOrigin.status < 500);
      assertEquals(await ruleFactCounts(runtime, organizationAId), baseline);
    });

    await test.step("malformed path organization ids never reach the database", async () => {
      const response = await send("GET", f.rulesPath("not-a-uuid"), adminA);
      assert(response.status >= 400 && response.status < 500);
      assertEquals(await ruleFactCounts(runtime, organizationAId), baseline);
    });
    await test.step("a demoted admin cannot replay an earlier idempotency key", async () => {
      const options = {
        cookie: f.cookies.replayA,
        organizationId: organizationAId,
        idempotencyKey: "replay-after-demotion",
        body: { expectedRevision: 1, entries: [titleEntry(90)] },
      };
      const created = await send("POST", versionsA, options);
      assertEquals(created.status, 201);
      const after = await ruleFactCounts(runtime, organizationAId);
      await f.owner`
        update bakery.organization_memberships set role = 'developer'
         where organization_id = ${organizationAId}
           and principal_id = ${f.replayA.principalId}`;
      const replay = await send("POST", versionsA, options);
      assertEquals(replay.status, 403);
      assertEquals(replay.headers.get("Idempotent-Replayed"), null);
      assertEquals(await ruleFactCounts(runtime, organizationAId), after);
    });
  } finally {
    await f.close();
  }
});
