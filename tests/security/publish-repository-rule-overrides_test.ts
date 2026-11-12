import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import {
  allRuleEntries,
  baseProfileConfig,
  commitsEntry,
  openRepositoryRulesFixture,
  overrideOf,
  profileBody,
  profileFactCounts,
  titleEntry,
} from "../helpers/repository-rules-fixture.ts";

function problemShape(body: Record<string, unknown>) {
  const { instance: _i, requestId: _r, traceId: _t, ...stable } = body;
  return stable;
}

const titleOverride = (maxSubjectLength: number) => ({
  ...overrideOf(titleEntry(maxSubjectLength)),
  mode: "require",
});

Deno.test("repository rule overrides and effective reads hold tenant isolation and role limits", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { runtime, organizationAId, organizationBId } = f;
  // Override publications are guarded by the repository If-Match (they
  // activate the profile), so profile POSTs carry repoA's current version.
  const send: typeof f.send = async (method, path, options = {}) => {
    if (
      method === "POST" && path.endsWith("/profiles") &&
      !options.headers?.["If-Match"]
    ) {
      const version = (await runtime.query<{ version: number }>(
        "select version from bakery.repositories where organization_id = $1 and id = $2",
        [organizationAId, repoA.repositoryId],
      )).rows[0].version;
      options = {
        ...options,
        headers: { ...options.headers, "If-Match": `"${version}"` },
      };
    }
    return await f.send(method, path, options);
  };
  const repoA = await f.seedRepository(organizationAId);
  const repoB = await f.seedRepository(organizationBId);
  const unknownRepository = crypto.randomUUID();
  const unknownOrganization = crypto.randomUUID();
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminB = { cookie: f.cookies.adminB, organizationId: organizationBId };
  const counts = () =>
    profileFactCounts(runtime, organizationAId, repoA.repositoryId);
  const publishRules = async (
    options: { cookie: string; organizationId: string },
    expectedRevision: number,
    entries: unknown[],
  ) => {
    const response = await send(
      "POST",
      f.versionsPath(options.organizationId),
      {
        ...options,
        idempotencyKey: crypto.randomUUID(),
        body: { expectedRevision, entries },
      },
    );
    assertEquals(response.status, 201, await response.clone().text());
  };
  const publish = async (
    repositoryId: string,
    revision: number,
    config: Record<string, unknown>,
    expected: number | undefined,
    options: Record<string, unknown>,
    idempotencyKey: string = crypto.randomUUID(),
  ) =>
    send("POST", f.profilesPath(repositoryId), {
      ...options,
      idempotencyKey,
      body: await profileBody(revision, config, expected),
    });
  const withOverrides = (entries: unknown[]) => ({
    ...baseProfileConfig,
    repositoryRules: { entries },
  });

  try {
    // Organization A: one revision, nothing locked. Organization B: three
    // revisions ending with a locked commits rule, so a read that forgot its
    // organization predicate would see revision 3 and a lock.
    await publishRules(adminA, 0, [commitsEntry(false), titleEntry(72)]);
    await publishRules(adminB, 0, [titleEntry(72)]);
    await publishRules(adminB, 1, [titleEntry(73)]);
    await publishRules(adminB, 2, [commitsEntry(true), titleEntry(74)]);
    const first = await publish(
      repoA.repositoryId,
      1,
      { ...baseProfileConfig },
      undefined,
      adminA,
    );
    assertEquals(first.status, 201);
    const baseline = await counts();

    await test.step("organization locks and revisions never cross tenants", async () => {
      const read = await send(
        "GET",
        f.effectivePath(repoA.repositoryId),
        adminA,
      );
      assertEquals(read.status, 200);
      const body = await read.json() as {
        organizationRevision: number;
        entries: Array<{ ruleKey: string; provenance: string }>;
      };
      assertEquals(body.organizationRevision, 1);
      assertEquals(
        body.entries.map(({ provenance }) => provenance),
        ["inherited", "inherited"],
      );
      // B locks commits.semantic at revision 3; A's override of it is allowed
      // against A's own revision 1.
      const overridden = await publish(
        repoA.repositoryId,
        2,
        withOverrides([overrideOf(commitsEntry(false))]),
        1,
        adminA,
      );
      assertEquals(overridden.status, 201, await overridden.clone().text());
      // And B's revision number is not A's: expecting B's 3 is stale for A.
      const wrong = await publish(
        repoA.repositoryId,
        3,
        withOverrides([titleOverride(80)]),
        3,
        adminA,
      );
      assertEquals(wrong.status, 412);
      // Organization B sees its own rules for its own repository.
      const readB = await send(
        "GET",
        f.effectivePath(repoB.repositoryId),
        adminB,
      );
      assertEquals(readB.status, 200);
      assertEquals(
        (await readB.json() as { organizationRevision: number })
          .organizationRevision,
        3,
      );
    });
    const afterIsolation = await counts();
    assertEquals(afterIsolation.profiles, baseline.profiles + 1);

    await test.step("a foreign repository id answers exactly like an unknown one", async () => {
      const body = await profileBody(
        9,
        withOverrides([titleOverride(70)]),
        3,
      );
      const cases: Array<
        [string, (id: string) => Promise<Response> | Response]
      > = [
        ["read", (id) => send("GET", f.effectivePath(id), adminB)],
        [
          "publish",
          (id) =>
            send("POST", f.profilesPath(id), {
              ...adminB,
              idempotencyKey: crypto.randomUUID(),
              body,
            }),
        ],
      ];
      for (const [label, call] of cases) {
        const foreign = await call(repoA.repositoryId);
        const unknown = await call(unknownRepository);
        assertEquals(foreign.status, 404, label);
        assertEquals(unknown.status, 404, label);
        assertEquals(
          problemShape(await foreign.json()),
          problemShape(await unknown.json()),
          label,
        );
      }
      assertEquals(await counts(), afterIsolation);
    });

    await test.step("a foreign or unknown repository answers 404 before any missing-If-Match 428", async () => {
      const before = await counts();
      const body = await profileBody(9, withOverrides([titleOverride(70)]), 1);
      const call = (repositoryId: string, options: Record<string, unknown>) =>
        f.send("POST", f.profilesPath(repositoryId), {
          ...options,
          idempotencyKey: crypto.randomUUID(),
          body,
        });
      const foreign = await call(repoA.repositoryId, adminB);
      const unknown = await call(unknownRepository, adminB);
      const inOrgUnknown = await call(unknownRepository, adminA);
      assertEquals(foreign.status, 404);
      assertEquals(unknown.status, 404);
      assertEquals(inOrgUnknown.status, 404);
      assertEquals(
        problemShape(await foreign.json()),
        problemShape(await unknown.json()),
      );
      // Restoring (no key) without If-Match is equally a 404 for them.
      const restoreBody = await profileBody(9, { ...baseProfileConfig });
      const restore = await f.send("POST", f.profilesPath(repoB.repositoryId), {
        ...adminA,
        idempotencyKey: crypto.randomUUID(),
        body: restoreBody,
      });
      assertEquals(restore.status, 404);
      assertEquals(await counts(), before);
    });

    await test.step("the fixed-policy missing-If-Match 428 reveals nothing about the repository", async () => {
      const before = await counts();
      const body = await profileBody(9, {
        ...baseProfileConfig,
        fixedPolicy: {
          schemaVersion: 1,
          commands: [{ id: "test.required", argv: ["pnpm", "test"] }],
          allowedEffects: ["artifact_only"],
          lockedConfiguration: {
            branches: true,
            worktree: true,
            checker: true,
          },
          decisions: [{ commandId: "test.required", mode: "require" }],
        },
      });
      const call = (repositoryId: string, options: Record<string, unknown>) =>
        f.send("POST", f.profilesPath(repositoryId), {
          ...options,
          idempotencyKey: crypto.randomUUID(),
          body,
        });
      const own = await call(repoA.repositoryId, adminA);
      const unknown = await call(unknownRepository, adminA);
      const foreign = await call(repoA.repositoryId, adminB);
      for (const response of [own, unknown, foreign]) {
        assertEquals(response.status, 428);
      }
      const shapes = [
        problemShape(await own.json()),
        problemShape(await unknown.json()),
        problemShape(await foreign.json()),
      ];
      assertEquals(shapes[0], shapes[1]);
      assertEquals(shapes[0], shapes[2]);
      assertEquals(await counts(), before);
    });

    await test.step("a non-member header answers exactly like an unknown organization", async () => {
      const header = { cookie: f.cookies.adminB };
      const body = await profileBody(9, withOverrides([titleOverride(70)]), 1);
      const cases: Array<
        [string, (organizationId: string) => Promise<Response> | Response]
      > = [
        [
          "read",
          (organizationId) =>
            send("GET", f.effectivePath(repoA.repositoryId), {
              ...header,
              organizationId,
            }),
        ],
        [
          "publish",
          (organizationId) =>
            send("POST", f.profilesPath(repoA.repositoryId), {
              ...header,
              organizationId,
              idempotencyKey: crypto.randomUUID(),
              body,
            }),
        ],
      ];
      for (const [label, call] of cases) {
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
      assertEquals(await counts(), afterIsolation);
    });

    await test.step("one principal in both organizations is scoped by the organization header", async () => {
      const both = (organizationId: string) => ({
        cookie: f.cookies.adminAB,
        organizationId,
      });
      assertEquals(
        (await send(
          "GET",
          f.effectivePath(repoA.repositoryId),
          both(organizationAId),
        )).status,
        200,
      );
      const crossed = await send(
        "GET",
        f.effectivePath(repoA.repositoryId),
        both(organizationBId),
      );
      const unknown = await send(
        "GET",
        f.effectivePath(unknownRepository),
        both(organizationBId),
      );
      assertEquals(crossed.status, 404);
      assertEquals(
        problemShape(await crossed.json()),
        problemShape(await unknown.json()),
      );
      const publishCrossed = await publish(
        repoA.repositoryId,
        9,
        withOverrides([titleOverride(70)]),
        3,
        both(organizationBId),
      );
      assertEquals(publishCrossed.status, 404);
      assertEquals(await counts(), afterIsolation);
    });

    await test.step("viewer, guest and inactive members cannot publish overrides and only a viewer reads", async () => {
      const cases: Array<[string, string, number, number]> = [
        // Viewers hold every Developer-minimum `:read` key by platform design,
        // exactly like repositoryProfile:read; they still cannot publish.
        ["viewer", f.cookies.viewerA, 200, 403],
        ["guest", f.cookies.guestA, 404, 404],
        ["inactive", f.cookies.inactiveA, 404, 404],
      ];
      for (const [label, cookie, readStatus, writeStatus] of cases) {
        const options = { cookie, organizationId: organizationAId };
        assertEquals(
          (await send("GET", f.effectivePath(repoA.repositoryId), options))
            .status,
          readStatus,
          label,
        );
        assertEquals(
          (await publish(
            repoA.repositoryId,
            3,
            withOverrides([titleOverride(70)]),
            1,
            options,
          )).status,
          writeStatus,
          label,
        );
      }
      assertEquals(await counts(), afterIsolation);
    });

    await test.step("a developer reads but cannot publish overrides or reach admin rule reads", async () => {
      const developer = {
        cookie: f.cookies.developerA,
        organizationId: organizationAId,
      };
      assertEquals(
        (await send("GET", f.effectivePath(repoA.repositoryId), developer))
          .status,
        200,
      );
      const denied = await publish(
        repoA.repositoryId,
        3,
        withOverrides([titleOverride(70)]),
        1,
        developer,
      );
      assertEquals(denied.status, 403);
      // The Admin organization read keeps its own, higher permission.
      assertEquals(
        (await send("GET", f.rulesPath(organizationAId), developer)).status,
        404,
      );
      assertEquals(await counts(), afterIsolation);
    });

    await test.step("real access tokens: scope decides, other organizations stay 404", async () => {
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
            ${f.adminA.principalId}, 'rule overrides security',
            ${secret.slice(0, 12)}, ${await sha256Hex(secret)}, ${scopes},
            ${new Date(Date.now() + 3_600_000)}
          )`;
        return `Bearer ${secret}`;
      };
      const tokens = {
        read: await mint(["bakery:read"]),
        operate: await mint(["bakery:operate"]),
        admin: await mint(["bakery:admin"]),
      };
      const fake = `Bearer bky_${"x".repeat(43)}`;
      const before = await counts();
      const nextRevision = before.profiles + 1;
      const request = async (authorization: string, revision: number) =>
        await send("POST", f.profilesPath(repoA.repositoryId), {
          organizationId: organizationAId,
          authorization,
          idempotencyKey: crypto.randomUUID(),
          body: await profileBody(
            revision,
            withOverrides([titleOverride(77)]),
            1,
          ),
        });
      for (const label of ["read", "operate", "admin"] as const) {
        assertEquals(
          (await send("GET", f.effectivePath(repoA.repositoryId), {
            organizationId: organizationAId,
            authorization: tokens[label],
          })).status,
          200,
          label,
        );
      }
      for (const label of ["read", "operate"] as const) {
        const denied = await request(tokens[label], nextRevision);
        assertEquals(denied.status, 403, label);
        assertEquals(
          (await denied.json() as { code: string }).code,
          "INSUFFICIENT_SCOPE",
          label,
        );
      }
      assertEquals(await counts(), before);
      const allowed = await request(tokens.admin, nextRevision);
      assertEquals(allowed.status, 201, await allowed.clone().text());
      assertEquals((await counts()).profiles, before.profiles + 1);
      // A token of organization A cannot reach organization B's repository.
      for (const authorization of Object.values(tokens)) {
        const foreign = await send("GET", f.effectivePath(repoB.repositoryId), {
          organizationId: organizationAId,
          authorization,
        });
        const unknown = await send("GET", f.effectivePath(unknownRepository), {
          organizationId: organizationAId,
          authorization,
        });
        assertEquals(foreign.status, 404);
        assertEquals(
          problemShape(await foreign.json()),
          problemShape(await unknown.json()),
        );
      }
      // An unauthenticated bearer never reaches either operation.
      for (
        const response of [
          await send("GET", f.effectivePath(repoA.repositoryId), {
            organizationId: organizationAId,
            authorization: fake,
          }),
          await request(fake, nextRevision + 1),
        ]
      ) {
        assertEquals(response.status, 401);
        assertEquals(
          (await response.json() as { code: string }).code,
          "AUTH_INVALID",
        );
      }
    });

    await test.step("a demoted admin cannot replay an earlier override publication", async () => {
      const options = {
        cookie: f.cookies.replayA,
        organizationId: organizationAId,
      };
      const key = "replay-after-demotion";
      const config = withOverrides([titleOverride(61)]);
      const revision = (await counts()).profiles + 1;
      const created = await publish(
        repoA.repositoryId,
        revision,
        config,
        1,
        options,
        key,
      );
      assertEquals(created.status, 201, await created.clone().text());
      const after = await counts();
      await f.owner`
        update bakery.organization_memberships set role = 'developer'
         where organization_id = ${organizationAId}
           and principal_id = ${f.replayA.principalId}`;
      const replay = await publish(
        repoA.repositoryId,
        revision,
        config,
        1,
        options,
        key,
      );
      assertEquals(replay.status, 403);
      assertEquals(replay.headers.get("Idempotent-Replayed"), null);
      assertEquals(await counts(), after);
    });

    await test.step("malformed and smuggled input is refused before any write", async () => {
      const before = await counts();
      const revision = before.profiles + 1;
      const good = overrideOf(titleEntry(70));
      const bad: Array<[string, unknown[]]> = [
        ["lock flag", [{ ...good, locked: true }]],
        ["unknown key", [{ ...good, extra: 1 }]],
        ["unknown rule", [{ ...good, ruleKey: "bogus.rule" }]],
        ["duplicate rule", [good, good]],
        ["NUL text", [{ ...good, explanation: "bad\u0000text" }]],
        ["lone surrogate", [{ ...good, explanation: "lone\ud800text" }]],
        ["loose options", [{
          ...good,
          options: { ...(good.options as Record<string, unknown>), extra: 1 },
        }]],
      ];
      for (const [label, entries] of bad) {
        const response = await send(
          "POST",
          f.profilesPath(repoA.repositoryId),
          {
            ...adminA,
            idempotencyKey: crypto.randomUUID(),
            body: {
              revision,
              config: withOverrides(entries),
              digest: "0".repeat(64),
              expectedOrganizationRulesRevision: 1,
            },
          },
        );
        assert(
          response.status === 400 || response.status === 422,
          `${label}: ${response.status}`,
        );
      }
      for (
        const smuggled of [{ organizationId: organizationBId }, {
          createdBy: f.adminB.principalId,
        }]
      ) {
        const response = await send(
          "POST",
          f.profilesPath(repoA.repositoryId),
          {
            ...adminA,
            idempotencyKey: crypto.randomUUID(),
            body: {
              ...(await profileBody(revision, withOverrides([good]), 1)),
              ...smuggled,
            },
          },
        );
        assertEquals(response.status, 400, JSON.stringify(smuggled));
      }
      for (const expected of [-1, 1.5, "1"]) {
        const response = await send(
          "POST",
          f.profilesPath(repoA.repositoryId),
          {
            ...adminA,
            idempotencyKey: crypto.randomUUID(),
            body: {
              ...(await profileBody(revision, withOverrides([good]), 1)),
              expectedOrganizationRulesRevision: expected,
            },
          },
        );
        assertEquals(response.status, 400, String(expected));
      }
      assertEquals(await counts(), before);
      const notUuid = await send("GET", f.effectivePath("not-a-uuid"), adminA);
      assert(notUuid.status >= 400 && notUuid.status < 500);
    });

    await test.step("unauthenticated and cross-origin requests are refused", async () => {
      assertEquals(
        (await send("GET", f.effectivePath(repoA.repositoryId), {
          organizationId: organizationAId,
        })).status,
        401,
      );
      const before = await counts();
      const crossOrigin = await f.fixture.app.fetch(
        new Request(
          `http://untrusted.example${f.profilesPath(repoA.repositoryId)}`,
          {
            method: "POST",
            headers: {
              cookie: f.cookies.adminA,
              "Bakery-Organization-Id": organizationAId,
              "Idempotency-Key": crypto.randomUUID(),
              "content-type": "application/json",
              origin: "http://untrusted.example",
            },
            body: JSON.stringify(
              await profileBody(99, withOverrides([titleOverride(70)]), 1),
            ),
          },
        ),
      );
      assert(crossOrigin.status >= 400 && crossOrigin.status < 500);
      assertEquals(await counts(), before);
    });

    await test.step("the effective read exposes only this repository and organization", async () => {
      const response = await send(
        "GET",
        f.effectivePath(repoA.repositoryId),
        adminA,
      );
      const body = await response.json() as Record<string, unknown>;
      // Each field is this repository's or its organization's own:
      // - checkers: derived only from the resolved entries (this repository's
      //   profile over its organization's baseline) and this repository's
      //   active-profile command ids; it carries rule keys, never ids.
      // - providerProtection: a constant state plus whether this repository's
      //   own connection (organization predicate) is enabled; no ids.
      // - repositoryVersion: this repository row's version.
      assertEquals(Object.keys(body).sort(), [
        "checkers",
        "digest",
        "entries",
        "organizationRevision",
        "profileId",
        "profileRevision",
        "providerProtection",
        "repositoryId",
        "repositoryVersion",
        "supersededOverrides",
      ]);
      assertEquals(
        Object.keys(body.checkers as object).sort(),
        ["state", "unavailableRuleKeys"],
      );
      assertEquals(
        Object.keys(body.providerProtection as object).sort(),
        ["reason", "state"],
      );
      assertEquals(typeof body.repositoryVersion, "number");
      const text = JSON.stringify(body);
      assert(!text.includes(repoB.repositoryId));
      assert(!text.includes(organizationBId));
      assert(!text.includes(f.adminA.principalId));
      assertEquals(allRuleEntries().length, 5);
    });
  } finally {
    await f.close();
  }
});
