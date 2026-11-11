import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  allRuleEntries,
  commitsEntry,
  openRepositoryRulesFixture,
  overrideOf,
  profileBody,
  ruleDigest,
  titleEntry,
} from "../helpers/repository-rules-fixture.ts";
import {
  allTableCounts,
  archiveRepository,
  previewOrganizationPath,
  previewRepositoryPath,
  profileWith,
  recordStatements,
  referenceImpact,
  seedBulkRepositories,
  seedInactiveProfile,
  seedProfile,
  writeStatementsOf,
} from "../helpers/repository-rule-preview-fixture.ts";
import type { OrganizationRepositoryRules } from "../../packages/contracts/src/repository-rules.ts";

type Item = {
  repositoryId: string;
  applicationId: string;
  repositoryName: string;
  status: string;
  unsupported: boolean;
  supersededRules: string[];
  reactivatedRules: string[];
};
type OrganizationPreview = {
  organizationId: string;
  currentRevision: number;
  draftRevision: number;
  draftDigest: string;
  counts: Record<string, number>;
  items: Item[];
  nextCursor: string | null;
};

const magicRequire = (binding: string | null, locked = false) => ({
  ruleKey: "code.magicNumbers",
  enabled: true,
  mode: "require",
  options: { checkBinding: binding, allowedNumbers: [0, 1], excludedPaths: [] },
  locked,
});

function problemShape(body: Record<string, unknown>) {
  const { instance: _i, requestId: _r, traceId: _t, ...stable } = body;
  return stable;
}

Deno.test("organization rule preview classifies every repository and writes nothing", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId, organizationBId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminB = { cookie: f.cookies.adminB, organizationId: organizationBId };
  const pathA = previewOrganizationPath(organizationAId);
  const preview = (
    body: Record<string, unknown>,
    options: Record<string, unknown> = adminA,
    path = pathA,
  ) => send("POST", path, { ...options, body });
  const publish = async (
    options: typeof adminA,
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
    return await response.json() as { revision: number; digest: string };
  };

  try {
    const emptyOrganization = await f.seedRepository(organizationAId);
    await test.step("an organization with no published revision previews from revision 0", async () => {
      const response = await preview({
        expectedRevision: 0,
        entries: [commitsEntry(true)],
      });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json() as OrganizationPreview;
      assertEquals(body.organizationId, organizationAId);
      assertEquals(body.currentRevision, 0);
      assertEquals(body.draftRevision, 1);
      assertEquals(body.counts, {
        repositories: 1,
        inherited: 1,
        overridden: 0,
        newlyLocked: 0,
        unsupported: 0,
      });
      assertEquals(body.items.map((item) => item.repositoryId), [
        emptyOrganization.repositoryId,
      ]);
      assertEquals(body.nextCursor, null);
    });

    // Current revision 1 for organization A: commits and title unlocked,
    // magic numbers required with a checker binding.
    await publish(adminA, 0, [
      commitsEntry(false),
      titleEntry(72),
      magicRequire("magic.check"),
    ]);
    // Organization B has its own repositories, overrides and a lock that must
    // never leak into A's counts.
    await publish(adminB, 0, [commitsEntry(true), titleEntry(72)]);
    const repoB = await f.seedRepository(organizationBId);
    await seedProfile(
      f,
      organizationBId,
      repoB.repositoryId,
      profileWith([overrideOf(titleEntry(80))], ["magic.check"]),
    );

    const repos = {
      noProfile: emptyOrganization,
      plain: await f.seedRepository(organizationAId),
      commitsOverride: await f.seedRepository(organizationAId),
      titleOverride: await f.seedRepository(organizationAId),
      both: await f.seedRepository(organizationAId),
      archived: await f.seedRepository(organizationAId),
      withCommand: await f.seedRepository(organizationAId),
      otherCommand: await f.seedRepository(organizationAId),
      inactiveNewer: await f.seedRepository(organizationAId),
    };
    await seedProfile(
      f,
      organizationAId,
      repos.plain.repositoryId,
      profileWith(),
    );
    await seedProfile(
      f,
      organizationAId,
      repos.commitsOverride.repositoryId,
      profileWith([overrideOf({ ...commitsEntry(false), mode: "warn" })]),
    );
    await seedProfile(
      f,
      organizationAId,
      repos.titleOverride.repositoryId,
      profileWith([overrideOf(titleEntry(80))]),
    );
    await seedProfile(
      f,
      organizationAId,
      repos.both.repositoryId,
      profileWith([
        overrideOf({ ...commitsEntry(false), mode: "warn" }),
        overrideOf(titleEntry(90)),
      ]),
    );
    await seedProfile(
      f,
      organizationAId,
      repos.archived.repositoryId,
      profileWith([overrideOf({ ...commitsEntry(false), mode: "warn" })]),
    );
    await archiveRepository(f, organizationAId, repos.archived.repositoryId);
    await seedProfile(
      f,
      organizationAId,
      repos.withCommand.repositoryId,
      profileWith(undefined, ["magic.check"]),
    );
    await seedProfile(
      f,
      organizationAId,
      repos.otherCommand.repositoryId,
      profileWith(undefined, ["lint.check"]),
    );

    // The ACTIVE profile (no overrides, has the checker command) decides; a
    // newer INACTIVE revision with an override and another command must not.
    await seedProfile(
      f,
      organizationAId,
      repos.inactiveNewer.repositoryId,
      profileWith(undefined, ["magic.check"]),
    );
    await seedInactiveProfile(
      f,
      organizationAId,
      repos.inactiveNewer.repositoryId,
      profileWith(
        [overrideOf({ ...commitsEntry(false), mode: "warn" })],
        ["lint.check"],
      ),
      2,
    );

    // Draft: lock commits.semantic (new lock), keep the rest.
    const draftEntries = [
      commitsEntry(true),
      titleEntry(72),
      magicRequire("magic.check"),
    ];

    await test.step("AC1: counts and statuses match the resolver for every repository", async () => {
      const before = await allTableCounts(f);
      const response = await preview({
        expectedRevision: 1,
        entries: draftEntries,
      });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json() as OrganizationPreview;
      const current: OrganizationRepositoryRules = {
        revision: 1,
        entries: [
          commitsEntry(false),
          titleEntry(72),
          magicRequire("magic.check"),
        ] as never,
      };
      const draft: OrganizationRepositoryRules = {
        revision: 2,
        entries: draftEntries as never,
      };
      const expected = await referenceImpact(
        f,
        organizationAId,
        current,
        draft,
      );
      assertEquals(body.counts, expected.counts);
      assertEquals(body.items, expected.items);
      assertEquals(body.currentRevision, 1);
      assertEquals(body.draftRevision, 2);
      // Hand-checked: 8 active repositories (the archived one is excluded).
      assertEquals(body.counts, {
        repositories: 8,
        inherited: 5,
        overridden: 1,
        newlyLocked: 2,
        unsupported: 6,
      });
      const byId = new Map(body.items.map((item) => [item.repositoryId, item]));
      const statusOf = (key: keyof typeof repos) =>
        byId.get(repos[key].repositoryId)?.status;
      assertEquals(statusOf("noProfile"), "inherited");
      assertEquals(statusOf("plain"), "inherited");
      assertEquals(statusOf("commitsOverride"), "newly_locked");
      assertEquals(statusOf("titleOverride"), "overridden");
      assertEquals(statusOf("both"), "newly_locked");
      assertEquals(statusOf("withCommand"), "inherited");
      assertEquals(statusOf("otherCommand"), "inherited");
      assertEquals(statusOf("inactiveNewer"), "inherited");
      assertEquals(
        byId.get(repos.inactiveNewer.repositoryId)?.unsupported,
        false,
      );
      assertEquals(
        byId.get(repos.inactiveNewer.repositoryId)?.supersededRules,
        [],
      );
      assertEquals(byId.has(repos.archived.repositoryId), false);
      assertEquals(
        byId.get(repos.commitsOverride.repositoryId)?.supersededRules,
        ["commits.semantic"],
      );
      assertEquals(
        byId.get(repos.both.repositoryId)?.supersededRules,
        ["commits.semantic"],
      );
      // Unsupported follows the repository's own active fixed policy.
      assertEquals(
        byId.get(repos.withCommand.repositoryId)?.unsupported,
        false,
      );
      assertEquals(
        byId.get(repos.otherCommand.repositoryId)?.unsupported,
        true,
      );
      assertEquals(byId.get(repos.noProfile.repositoryId)?.unsupported, true);
      // Nothing reached organization B.
      assert(
        !body.items.some((item) => item.repositoryId === repoB.repositoryId),
      );
      assertEquals(await allTableCounts(f), before);
    });

    await test.step("the draft digest equals the digest publication stores", async () => {
      const response = await preview({
        expectedRevision: 1,
        entries: draftEntries,
      });
      const body = await response.json() as OrganizationPreview;
      assertEquals(body.draftDigest, await ruleDigest(2, draftEntries));
      const published = await publish(adminA, 1, draftEntries);
      assertEquals(published.revision, 2);
      assertEquals(published.digest, body.draftDigest);
      // The preview described exactly the revision that was then published.
      const stale = await preview({
        expectedRevision: 1,
        entries: draftEntries,
      });
      assertEquals(stale.status, 412);
    });

    await test.step("key order and defaults do not change the digest, only content does", async () => {
      const reordered = draftEntries.map((entry) =>
        Object.fromEntries(Object.entries(entry).reverse())
      );
      const a =
        await (await preview({ expectedRevision: 2, entries: draftEntries }))
          .json() as OrganizationPreview;
      const b =
        await (await preview({ expectedRevision: 2, entries: reordered }))
          .json() as OrganizationPreview;
      assertEquals(a.draftDigest, b.draftDigest);
      const c = await (await preview({
        expectedRevision: 2,
        entries: [commitsEntry(false), ...draftEntries.slice(1)],
      })).json() as OrganizationPreview;
      assertNotEquals(a.draftDigest, c.draftDigest);
      assertEquals(a.draftRevision, 3);
    });

    await test.step("a lock removed by the draft reactivates the saved override", async () => {
      // Current revision 2 locks commits.semantic; the saved commits override
      // is superseded now and would be effective again without the lock.
      const body = await (await preview({
        expectedRevision: 2,
        entries: [
          commitsEntry(false),
          titleEntry(72),
          magicRequire("magic.check"),
        ],
      })).json() as OrganizationPreview;
      const byId = new Map(body.items.map((item) => [item.repositoryId, item]));
      assertEquals(
        byId.get(repos.commitsOverride.repositoryId)?.status,
        "overridden",
      );
      assertEquals(
        byId.get(repos.commitsOverride.repositoryId)?.supersededRules,
        [],
      );
      assertEquals(byId.get(repos.both.repositoryId)?.status, "overridden");
      for (const key of ["commitsOverride", "both"] as const) {
        assertEquals(
          byId.get(repos[key].repositoryId)?.reactivatedRules,
          ["commits.semantic"],
          key,
        );
      }
      // An override that was never superseded is not "reactivated".
      assertEquals(
        byId.get(repos.titleOverride.repositoryId)?.reactivatedRules,
        [],
      );
      // A lock that stays does not count as new.
      const kept = await (await preview({
        expectedRevision: 2,
        entries: [
          commitsEntry(true),
          titleEntry(99),
          magicRequire("magic.check"),
        ],
      })).json() as OrganizationPreview;
      assertEquals(kept.counts.newlyLocked, 0);
      const keptById = new Map(
        kept.items.map((item) => [item.repositoryId, item]),
      );
      assertEquals(
        keptById.get(repos.commitsOverride.repositoryId)?.status,
        "inherited",
      );
      assertEquals(
        keptById.get(repos.commitsOverride.repositoryId)?.supersededRules,
        ["commits.semantic"],
      );
    });

    await test.step("stale and future expectedRevision answer 412 and write nothing", async () => {
      const before = await allTableCounts(f);
      for (const expectedRevision of [0, 1, 3, 99]) {
        const response = await preview({
          expectedRevision,
          entries: draftEntries,
        });
        assertEquals(response.status, 412, String(expectedRevision));
        assertEquals(
          (await response.json() as { code: string }).code,
          "PRECONDITION_FAILED",
        );
      }
      assertEquals(await allTableCounts(f), before);
    });

    await test.step("an invalid draft is refused with a typed 422 before any scan", async () => {
      const before = await allTableCounts(f);
      const duplicate = await preview({
        expectedRevision: 2,
        entries: [commitsEntry(true), commitsEntry(false)],
      });
      assertEquals(duplicate.status, 422);
      const body = await duplicate.json() as {
        code: string;
        issues?: Array<{ path: unknown[] }>;
      };
      assertEquals(body.code, "UNPROCESSABLE");
      assertEquals(body.issues?.[0].path, ["entries", 1, "ruleKey"]);
      assertEquals(await allTableCounts(f), before);
    });

    await test.step("organization B previews its own data only", async () => {
      const body = await (await preview(
        { expectedRevision: 1, entries: [commitsEntry(true)] },
        adminB,
        previewOrganizationPath(organizationBId),
      )).json() as OrganizationPreview;
      assertEquals(body.organizationId, organizationBId);
      assertEquals(body.counts.repositories, 1);
      assertEquals(body.items.map((item) => item.repositoryId), [
        repoB.repositoryId,
      ]);
      assertEquals(body.items[0].status, "overridden");
    });
  } finally {
    await f.close();
  }
});

Deno.test("organization preview pages are complete, stable and bound to their draft, principal and organization", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminAB_A = {
    cookie: f.cookies.adminAB,
    organizationId: organizationAId,
  };
  const adminAB_B = {
    cookie: f.cookies.adminAB,
    organizationId: organizationBId,
  };
  const pathA = previewOrganizationPath(organizationAId);
  const preview = (
    body: Record<string, unknown>,
    options: Record<string, unknown> = adminA,
    path = pathA,
  ) => send("POST", path, { ...options, body });
  const draft = [commitsEntry(true), titleEntry(72)];
  try {
    const publishA = await send("POST", f.versionsPath(organizationAId), {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      body: {
        expectedRevision: 0,
        entries: [commitsEntry(false), titleEntry(72)],
      },
    });
    assertEquals(publishA.status, 201);
    await send("POST", f.versionsPath(organizationBId), {
      cookie: f.cookies.adminB,
      organizationId: organizationBId,
      idempotencyKey: crypto.randomUUID(),
      body: { expectedRevision: 0, entries: [titleEntry(72)] },
    });
    // 240 bare repositories plus 30 with overrides/commands, one archived tail.
    await seedBulkRepositories(f, organizationAId, 240);
    await seedBulkRepositories(f, organizationBId, 50, "other");
    const withOverrides: Array<{ repositoryId: string }> = [];
    for (let index = 0; index < 30; index++) {
      const repo = await f.seedRepository(organizationAId);
      withOverrides.push(repo);
      await seedProfile(
        f,
        organizationAId,
        repo.repositoryId,
        profileWith(
          index % 2 === 0
            ? [overrideOf({ ...commitsEntry(false), mode: "warn" })]
            : [overrideOf(titleEntry(80))],
          index % 3 === 0 ? ["magic.check"] : undefined,
        ),
      );
    }
    const current = {
      revision: 1,
      entries: [commitsEntry(false), titleEntry(72)] as never,
    } as OrganizationRepositoryRules;
    const draftRules = {
      revision: 2,
      entries: draft as never,
    } as OrganizationRepositoryRules;
    const expected = await referenceImpact(
      f,
      organizationAId,
      current,
      draftRules,
    );
    assertEquals(expected.counts.repositories, 270);

    const walk = async (
      limit: number | undefined,
      count: { pages: number },
    ) => {
      const items: Item[] = [];
      let cursor: string | undefined;
      let counts: Record<string, number> | undefined;
      for (;;) {
        const response = await preview({
          expectedRevision: 1,
          entries: draft,
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        assertEquals(response.status, 200, await response.clone().text());
        const body = await response.json() as OrganizationPreview;
        count.pages++;
        // Counts cover all repositories on every page, not just this page.
        if (counts) assertEquals(body.counts, counts);
        counts = body.counts;
        items.push(...body.items);
        if (!body.nextCursor) break;
        assert(body.items.length === (limit ?? 25));
        cursor = body.nextCursor;
      }
      return { items, counts: counts! };
    };

    await test.step("counts cover every repository while the page is small", async () => {
      const pages = { pages: 0 };
      const small = await walk(7, pages);
      assertEquals(small.counts, expected.counts);
      assertEquals(small.items, expected.items);
      assertEquals(pages.pages, Math.ceil(270 / 7));
      const first =
        await (await preview({ expectedRevision: 1, entries: draft, limit: 1 }))
          .json() as OrganizationPreview;
      assertEquals(first.items.length, 1);
      assertEquals(first.counts, expected.counts);
      assert(first.nextCursor);
    });

    await test.step("default and maximum page sizes walk the same complete ordered set", async () => {
      for (const limit of [undefined, 25, 100]) {
        const pages = { pages: 0 };
        const all = await walk(limit, pages);
        assertEquals(
          all.items.map((item) => item.repositoryId),
          expected.items.map((item) => item.repositoryId),
        );
        assertEquals(pages.pages, Math.ceil(270 / (limit ?? 25)));
        const ids = all.items.map((item) => item.repositoryId);
        assertEquals(ids, [...ids].sort());
        assertEquals(new Set(ids).size, ids.length);
      }
      // 270 repositories fit exactly in 2.7 pages of 100; an exact multiple has a null last cursor.
      const exact = await (await preview({
        expectedRevision: 1,
        entries: draft,
        limit: 100,
      }))
        .json() as OrganizationPreview;
      assertEquals(exact.items.length, 100);
    });

    await test.step("a walk stays stable while repositories are added and archived mid-way", async () => {
      const firstPage = await (await preview({
        expectedRevision: 1,
        entries: draft,
        limit: 50,
      }))
        .json() as OrganizationPreview;
      const seen = firstPage.items.map((item) => item.repositoryId);
      // New repositories appear on both sides of the cursor.
      await seedBulkRepositories(f, organizationAId, 5, "late");
      await f.owner`
        update bakery.repositories set archived_at = now()
         where id = ${firstPage.items[0].repositoryId}`;
      let cursor = firstPage.nextCursor;
      while (cursor) {
        const page = await (await preview({
          expectedRevision: 1,
          entries: draft,
          limit: 50,
          cursor,
        })).json() as OrganizationPreview;
        for (const item of page.items) {
          assert(!seen.includes(item.repositoryId), "no repeated row");
          assert(item.repositoryId > seen.at(-1)!, "strictly after the cursor");
          seen.push(item.repositoryId);
        }
        cursor = page.nextCursor;
      }
      assertEquals(seen, [...seen].sort());
      // 270 + 5 late - 1 archived, minus the archived head already shown.
      assertEquals(seen.length >= 270, true);
    });

    await test.step("cursors are rejected for another draft, principal, organization or forgery", async () => {
      const own = await (await preview(
        { expectedRevision: 1, entries: draft, limit: 3 },
        adminAB_A,
      )).json() as OrganizationPreview;
      assert(own.nextCursor);
      const invalid = async (response: Response | Promise<Response>) => {
        const resolved = await response;
        assertEquals(resolved.status, 400);
        assertEquals(
          (await resolved.json() as { code: string }).code,
          "INVALID_CURSOR",
        );
      };
      // Same principal, same organization, same draft: accepted.
      const ok = await preview(
        {
          expectedRevision: 1,
          entries: draft,
          limit: 3,
          cursor: own.nextCursor,
        },
        adminAB_A,
      );
      assertEquals(ok.status, 200);
      // A different draft (one option changed) cannot reuse the cursor.
      await invalid(preview(
        {
          expectedRevision: 1,
          entries: [commitsEntry(true), titleEntry(73)],
          limit: 3,
          cursor: own.nextCursor,
        },
        adminAB_A,
      ));
      // A different principal in the same organization.
      await invalid(preview(
        {
          expectedRevision: 1,
          entries: draft,
          limit: 3,
          cursor: own.nextCursor,
        },
        adminA,
      ));
      // The same principal against another organization they also administer.
      await invalid(preview(
        {
          expectedRevision: 1,
          entries: draft,
          limit: 3,
          cursor: own.nextCursor,
        },
        adminAB_B,
        previewOrganizationPath(organizationBId),
      ));
      // Forged: flip a character in the payload and in the signature.
      const [payload, signature] = own.nextCursor.split(".");
      const flip = (value: string) =>
        value.slice(0, 5) + (value[5] === "A" ? "B" : "A") + value.slice(6);
      for (
        const forged of [
          `${flip(payload)}.${signature}`,
          `${payload}.${flip(signature)}`,
          payload,
          `${payload}.${signature}.x`,
          "",
          "not-a-cursor",
          "a".repeat(600),
        ]
      ) {
        await invalid(preview(
          { expectedRevision: 1, entries: draft, limit: 3, cursor: forged },
          adminAB_A,
        ));
      }
      // A cursor minted by another listing never works here.
      const versions = await (await send(
        "GET",
        `${f.versionsPath(organizationAId)}?limit=1`,
        adminAB_A,
      ))
        .json() as { nextCursor: string | null };
      if (versions.nextCursor) {
        await invalid(preview(
          { expectedRevision: 1, entries: draft, cursor: versions.nextCursor },
          adminAB_A,
        ));
      }
    });

    await test.step("limits are validated", async () => {
      for (const limit of [0, 101, -1, 1.5, "10", null]) {
        const response = await preview({
          expectedRevision: 1,
          entries: draft,
          limit,
        });
        assertEquals(response.status, 400, JSON.stringify(limit));
      }
    });

    await test.step("a page is built from a bounded number of statements", async () => {
      const recorder = recordStatements(runtime);
      try {
        const response = await preview({
          expectedRevision: 1,
          entries: draft,
          limit: 100,
        });
        assertEquals(response.status, 200);
        await response.arrayBuffer();
      } finally {
        recorder.restore();
      }
      const scans = recorder.statements.filter((sql) =>
        sql.includes("from bakery.repositories")
      );
      // 276 repositories => one 1000-row batch, never one query per repository.
      assertEquals(scans.length, 1, scans.join("\n---\n"));
      assert(
        recorder.statements.length < 25,
        `${recorder.statements.length} statements`,
      );
      assertEquals(
        writeStatementsOf(recorder.statements),
        [],
        "a preview issues no write statement",
      );
    });
  } finally {
    await f.close();
  }
});

Deno.test("repository rule preview resolves, reports lock conflicts and evaluates samples", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminB = { cookie: f.cookies.adminB, organizationId: organizationBId };
  const repoA = await f.seedRepository(organizationAId);
  const repoB = await f.seedRepository(organizationBId);
  const noProfile = await f.seedRepository(organizationAId);
  const preview = (
    repositoryId: string,
    body: Record<string, unknown>,
    options: Record<string, unknown> = adminA,
  ) => send("POST", previewRepositoryPath(repositoryId), { ...options, body });
  const publishRules = async (revision: number, entries: unknown[]) => {
    const response = await send("POST", f.versionsPath(organizationAId), {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      body: { expectedRevision: revision, entries },
    });
    assertEquals(response.status, 201, await response.clone().text());
  };
  const publishProfile = async (
    revision: number,
    config: Record<string, unknown>,
    expectedOrganizationRevision?: number,
  ) => {
    const version = (await runtime.query<{ version: number }>(
      "select version from bakery.repositories where organization_id = $1 and id = $2",
      [organizationAId, repoA.repositoryId],
    )).rows[0].version;
    return await send("POST", f.profilesPath(repoA.repositoryId), {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      headers: { "If-Match": `"${version}"` },
      body: await profileBody(revision, config, expectedOrganizationRevision),
    });
  };
  try {
    await test.step("revision 0, no active profile: effective rules are the overrides alone", async () => {
      const before = await allTableCounts(f);
      const response = await preview(noProfile.repositoryId, {
        overrides: { entries: [overrideOf(commitsEntry(false))] },
      });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json() as {
        repositoryId: string;
        profileId: string | null;
        profileRevision: number | null;
        organizationRevision: number;
        conflicts: unknown[];
        effective: {
          entries: Array<{ provenance: string }>;
          digest: string;
          organizationRevision: number;
        };
        sampleResults: unknown[];
      };
      assertEquals(body.repositoryId, noProfile.repositoryId);
      assertEquals(body.profileId, null);
      assertEquals(body.profileRevision, null);
      assertEquals(body.organizationRevision, 0);
      assertEquals(body.conflicts, []);
      assertEquals(body.effective.entries.map((entry) => entry.provenance), [
        "repository_only",
      ]);
      assertEquals(body.effective.organizationRevision, 0);
      assertEquals(body.sampleResults, []);
      assertEquals(await allTableCounts(f), before);
    });

    // Organization A revision 1: commits locked, title open, description open.
    await publishRules(0, [
      commitsEntry(true),
      titleEntry(72),
      {
        ruleKey: "changeRequest.description",
        enabled: true,
        mode: "require",
        options: {
          template:
            "## Summary\n<!-- say it -->\n## Verification\n- [ ] tests\n",
          requiredSections: ["Summary", "Verification"],
        },
        locked: false,
      },
    ]);
    // Organization B's lock history must not matter to A.
    await send("POST", f.versionsPath(organizationBId), {
      ...adminB,
      idempotencyKey: crypto.randomUUID(),
      body: {
        expectedRevision: 0,
        entries: [commitsEntry(true), titleEntry(72)],
      },
    });

    await test.step("AC3: each lock conflict is listed and publication refuses the same keys", async () => {
      const proposed = [
        overrideOf({ ...commitsEntry(false), mode: "warn" }),
        overrideOf(titleEntry(80)),
      ];
      const response = await preview(repoA.repositoryId, {
        overrides: { entries: proposed },
      });
      assertEquals(response.status, 200);
      const body = await response.json() as {
        conflicts: Array<{ ruleKey: string; reason: string }>;
        effective: unknown;
        sampleResults: unknown[];
        organizationRevision: number;
      };
      assertEquals(body.conflicts, [
        { ruleKey: "commits.semantic", reason: "replaces_locked_rule" },
      ]);
      assertEquals(body.effective, null);
      assertEquals(body.sampleResults, []);
      assertEquals(body.organizationRevision, 1);
      // Disabling the locked rule is a different reason.
      const disabled = await (await preview(repoA.repositoryId, {
        overrides: {
          entries: [{ ...overrideOf(commitsEntry(false)), enabled: false }],
        },
      })).json() as { conflicts: Array<{ ruleKey: string; reason: string }> };
      assertEquals(disabled.conflicts, [
        { ruleKey: "commits.semantic", reason: "disables_locked_rule" },
      ]);
      // Publication of the same overrides is refused naming the same rule keys.
      const refused = await publishProfile(
        1,
        { ...profileWith(proposed) },
        1,
      );
      assertEquals(refused.status, 422);
      const refusal = await refused.json() as {
        issues: Array<{ code: string; message: string }>;
      };
      assertEquals(refusal.issues.map((issue) => issue.code), [
        "replaces_locked_rule",
      ]);
      assert(refusal.issues[0].message.includes("commits.semantic"));
      const disabledRefused = await publishProfile(
        1,
        profileWith([{ ...overrideOf(commitsEntry(false)), enabled: false }]),
        1,
      );
      assertEquals(disabledRefused.status, 422);
      assertEquals(
        (await disabledRefused.json() as { issues: Array<{ code: string }> })
          .issues.map((issue) => issue.code),
        ["disables_locked_rule"],
      );
    });

    await test.step("a conflict-free preview equals the effective read after publishing the same overrides", async () => {
      const proposed = [overrideOf(titleEntry(80))];
      const response = await preview(repoA.repositoryId, {
        overrides: { entries: proposed },
      });
      const body = await response.json() as {
        conflicts: unknown[];
        effective: { digest: string; entries: unknown[] };
        profileId: string | null;
      };
      assertEquals(body.conflicts, []);
      assertEquals(body.profileId, null);
      const published = await publishProfile(1, profileWith(proposed), 1);
      assertEquals(published.status, 201, await published.clone().text());
      const profile = await published.json() as {
        id: string;
        revision: number;
      };
      const effective =
        await (await send("GET", f.effectivePath(repoA.repositoryId), adminA))
          .json() as {
            digest: string;
            entries: unknown[];
          };
      assertEquals(effective.digest, body.effective.digest);
      assertEquals(effective.entries, body.effective.entries);
      // The preview now reports the active profile it computed against.
      const again = await (await preview(repoA.repositoryId, {
        overrides: { entries: [] },
      })).json() as {
        profileId: string;
        profileRevision: number;
      };
      assertEquals(again.profileId, profile.id);
      assertEquals(again.profileRevision, 1);
    });

    await test.step("the preview resolves against the ACTIVE profile, not the latest published", async () => {
      // Publish a second profile revision that is NOT activated: a plain
      // publication on a repository whose active profile has overrides
      // activates, so insert an inactive row directly.
      const inactive = crypto.randomUUID();
      await f.owner`
        insert into bakery.repository_profiles (
          id, organization_id, repository_id, revision, config, digest, created_by
        ) values (
          ${inactive}, ${organizationAId}, ${repoA.repositoryId}, 99,
          ${f.owner.json(profileWith([]) as never)}, ${"b".repeat(64)},
          ${f.adminA.principalId}
        )`;
      const body = await (await preview(repoA.repositoryId, {
        overrides: { entries: [] },
      })).json() as {
        profileId: string;
        profileRevision: number;
      };
      assertNotEquals(body.profileId, inactive);
      assertEquals(body.profileRevision, 1);
    });

    await test.step("sample text is evaluated rule by rule and never claims what it did not compute", async () => {
      const response = await preview(repoA.repositoryId, {
        overrides: { entries: [] },
        sample: {
          commitMessages: ["feat: ok", "bad message"],
          pullRequestTitle: "feat(api): add preview",
          pullRequestDescription: "## Summary\nDid it.\n\n## Verification\n",
        },
      });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json() as {
        sampleResults: Array<{
          ruleKey: string;
          mode: string | null;
          status: string;
          appliesTo: string | null;
          evaluated: number;
          findings: Array<{ code: string; message: string }>;
        }>;
      };
      const byKey = Object.fromEntries(
        body.sampleResults.map((result) => [result.ruleKey, result]),
      );
      assertEquals(Object.keys(byKey), [
        "commits.semantic",
        "changeRequest.semanticTitle",
        "changeRequest.description",
        "code.magicNumbers",
        "code.magicStrings",
      ]);
      assertEquals(byKey["commits.semantic"].status, "fail");
      assertEquals(byKey["commits.semantic"].appliesTo, "all_commits");
      assertEquals(byKey["commits.semantic"].evaluated, 2);
      assertEquals(byKey["commits.semantic"].findings.map(({ code }) => code), [
        "separator_missing",
      ]);
      assertEquals(byKey["changeRequest.semanticTitle"].status, "pass");
      assertEquals(byKey["changeRequest.description"].status, "fail");
      assertEquals(
        byKey["changeRequest.description"].findings.map(({ code }) => code),
        ["section_empty"],
      );
      assertEquals(byKey["code.magicNumbers"].status, "not_evaluated");
      assertEquals(byKey["code.magicNumbers"].findings[0].code, "rule_absent");
      assertEquals(byKey["code.magicStrings"].status, "not_evaluated");
      assert(!JSON.stringify(body).includes("bad message"));
    });

    await test.step("a sample without text for a rule leaves it not_evaluated", async () => {
      const body = await (await preview(repoA.repositoryId, {
        overrides: { entries: [] },
        sample: { pullRequestTitle: "feat(api): ok" },
      })).json() as {
        sampleResults: Array<{ ruleKey: string; status: string }>;
      };
      assertEquals(
        body.sampleResults.map((result) => result.status),
        [
          "not_evaluated",
          "pass",
          "not_evaluated",
          "not_evaluated",
          "not_evaluated",
        ],
      );
    });

    await test.step("duplicate rule keys are a 422 on both routes, like publication", async () => {
      const duplicate = [
        overrideOf(titleEntry(80)),
        overrideOf(titleEntry(90)),
      ];
      const previewed = await preview(repoA.repositoryId, {
        overrides: { entries: duplicate },
      });
      assertEquals(previewed.status, 422, await previewed.clone().text());
      const issues = await previewed.json() as {
        code: string;
        issues: Array<{ path: unknown[] }>;
      };
      assertEquals(issues.code, "UNPROCESSABLE");
      assertEquals(issues.issues[0].path, [
        "overrides",
        "entries",
        1,
        "ruleKey",
      ]);
      const version = (await runtime.query<{ version: number }>(
        "select version from bakery.repositories where organization_id = $1 and id = $2",
        [organizationAId, repoA.repositoryId],
      )).rows[0].version;
      const published = await send("POST", f.profilesPath(repoA.repositoryId), {
        ...adminA,
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": `"${version}"` },
        body: {
          revision: 2,
          config: profileWith(duplicate),
          digest: "a".repeat(64),
          expectedOrganizationRulesRevision: 1,
        },
      });
      assertEquals(published.status, 422);
      const organization = await send(
        "POST",
        previewOrganizationPath(organizationAId),
        {
          ...adminA,
          body: {
            expectedRevision: 1,
            entries: [titleEntry(72), titleEntry(73)],
          },
        },
      );
      assertEquals(organization.status, 422);
    });

    await test.step("unknown, foreign and archived repositories answer one identical 404", async () => {
      const shapes: unknown[] = [];
      const archived = await f.seedRepository(organizationAId);
      await archiveRepository(f, organizationAId, archived.repositoryId);
      for (
        const id of [
          crypto.randomUUID(),
          repoB.repositoryId,
          archived.repositoryId,
        ]
      ) {
        const response = await preview(id, { overrides: { entries: [] } });
        assertEquals(response.status, 404);
        shapes.push(problemShape(await response.json()));
      }
      assertEquals(shapes[1], shapes[0]);
      assertEquals(shapes[2], shapes[0]);
      assertEquals(
        (await preview("not-a-uuid", { overrides: { entries: [] } })).status >=
          400,
        true,
      );
    });

    await test.step("another organization racing ahead with locks never reaches this preview", async () => {
      // B is at revision 1 here; take it to revision 3 with locked rules.
      for (const revision of [1, 2]) {
        const more = await send("POST", f.versionsPath(organizationBId), {
          ...adminB,
          idempotencyKey: crypto.randomUUID(),
          body: {
            expectedRevision: revision,
            entries: [
              commitsEntry(true),
              {
                ...titleEntry(70 + revision),
                locked: true,
                explanation: "B-ONLY-TEXT",
              },
            ],
          },
        });
        assertEquals(more.status, 201, await more.clone().text());
      }
      const response = await preview(repoA.repositoryId, {
        overrides: { entries: [overrideOf(titleEntry(85))] },
      });
      const text = await response.text();
      const body = JSON.parse(text) as {
        organizationRevision: number;
        conflicts: unknown[];
        effective: { organizationRevision: number };
      };
      assertEquals(body.organizationRevision, 1);
      assertEquals(body.effective.organizationRevision, 1);
      assertEquals(body.conflicts, []);
      assert(!text.includes("B-ONLY-TEXT"));
    });

    await test.step("a repository preview leaves every table untouched", async () => {
      const before = await allTableCounts(f);
      const recorder = recordStatements(runtime);
      for (
        const body of [
          { overrides: { entries: [overrideOf(titleEntry(90))] } },
          { overrides: { entries: [overrideOf(commitsEntry(false))] } },
          {
            overrides: { entries: [] },
            sample: { commitMessages: ["feat: x"] },
          },
        ]
      ) {
        assertEquals((await preview(repoA.repositoryId, body)).status, 200);
      }
      recorder.restore();
      assert(recorder.statements.length > 0, "the recorder saw the preview");
      assertEquals(writeStatementsOf(recorder.statements), []);
      assertEquals(await allTableCounts(f), before);
    });
  } finally {
    await f.close();
  }
});

Deno.test("allRuleEntries drafts preview and publish identically", async () => {
  const f = await openRepositoryRulesFixture();
  const adminA = {
    cookie: f.cookies.adminA,
    organizationId: f.organizationAId,
  };
  try {
    const preview = await f.send(
      "POST",
      previewOrganizationPath(f.organizationAId),
      {
        ...adminA,
        body: { expectedRevision: 0, entries: allRuleEntries() },
      },
    );
    assertEquals(preview.status, 200, await preview.clone().text());
    const previewBody = await preview.json() as OrganizationPreview;
    const published = await f.send("POST", f.versionsPath(f.organizationAId), {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      body: { expectedRevision: 0, entries: allRuleEntries() },
    });
    assertEquals(published.status, 201);
    assertEquals(
      (await published.json() as { digest: string }).digest,
      previewBody.draftDigest,
    );
  } finally {
    await f.close();
  }
});

Deno.test("the preview scan is capped at 20,000 repositories with a typed 422", async () => {
  const f = await openRepositoryRulesFixture();
  const adminA = {
    cookie: f.cookies.adminA,
    organizationId: f.organizationAId,
  };
  const call = () =>
    f.send("POST", previewOrganizationPath(f.organizationAId), {
      ...adminA,
      body: { expectedRevision: 0, entries: [commitsEntry(true)], limit: 100 },
    });
  try {
    await seedBulkRepositories(f, f.organizationAId, 20_000);
    // Exactly at the ceiling: twenty full batches, all counted.
    const at = await call();
    assertEquals(at.status, 200, await at.clone().text());
    const body = await at.json() as OrganizationPreview;
    assertEquals(body.counts.repositories, 20_000);
    assertEquals(body.counts.inherited, 20_000);
    assertEquals(body.items.length, 100);
    // One more repository, and the request is refused instead of unbounded.
    await seedBulkRepositories(f, f.organizationAId, 1, "extra");
    const over = await call();
    assertEquals(over.status, 422);
    const refused = await over.json() as {
      code: string;
      issues: Array<{ path: unknown[]; code: string }>;
    };
    assertEquals(refused.code, "UNPROCESSABLE");
    assertEquals(refused.issues[0].code, "too_many_repositories");
    // Another organization is unaffected by this organization's size.
    const other = await f.send(
      "POST",
      previewOrganizationPath(f.organizationBId),
      {
        cookie: f.cookies.adminB,
        organizationId: f.organizationBId,
        body: { expectedRevision: 0, entries: [commitsEntry(true)] },
      },
    );
    assertEquals(other.status, 200);
    assertEquals(
      (await other.json() as OrganizationPreview).counts.repositories,
      0,
    );
  } finally {
    await f.close();
  }
});
