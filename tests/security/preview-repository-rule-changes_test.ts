import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import {
  commitsEntry,
  openRepositoryRulesFixture,
  overrideOf,
  titleEntry,
} from "../helpers/repository-rules-fixture.ts";
import {
  allTableCounts,
  archiveRepository,
  previewOrganizationPath,
  previewRepositoryPath,
  profileWith,
  seedProfile,
} from "../helpers/repository-rule-preview-fixture.ts";

const B_MARKER = "B-TENANT-MARKER-7f3";

function problemShape(body: Record<string, unknown>) {
  const { instance: _i, requestId: _r, traceId: _t, ...stable } = body;
  return stable;
}

Deno.test("rule previews hold tenant isolation, role limits and token scope", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId, organizationBId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminB = { cookie: f.cookies.adminB, organizationId: organizationBId };
  const unknownOrganization = crypto.randomUUID();
  const draft = { expectedRevision: 1, entries: [commitsEntry(true)] };
  const orgPreview = (
    organizationId: string,
    options: Record<string, unknown>,
    body: unknown = draft,
  ) =>
    send("POST", previewOrganizationPath(organizationId), {
      ...options,
      body,
    });
  const repoPreview = (
    repositoryId: string,
    options: Record<string, unknown>,
    body: unknown = { overrides: { entries: [] } },
  ) => send("POST", previewRepositoryPath(repositoryId), { ...options, body });
  try {
    for (const [options, revision] of [[adminA, 0], [adminB, 0]] as const) {
      const published = await send(
        "POST",
        f.versionsPath(options.organizationId),
        {
          ...options,
          idempotencyKey: crypto.randomUUID(),
          body: {
            expectedRevision: revision,
            entries: [commitsEntry(false), titleEntry(72)],
          },
        },
      );
      assertEquals(published.status, 201);
    }
    // Organization B races ahead (revisions 2 and 3, locking commits) so a
    // read of "the latest revision" that forgot its organization would see
    // B's revision 3 and B's lock while previewing A.
    for (const revision of [1, 2] as const) {
      const more = await send("POST", f.versionsPath(organizationBId), {
        ...adminB,
        idempotencyKey: crypto.randomUUID(),
        body: {
          expectedRevision: revision,
          entries: revision === 1
            ? [commitsEntry(false), titleEntry(73)]
            : [commitsEntry(true), {
              ...titleEntry(74),
              locked: true,
              explanation: B_MARKER,
            }, {
              ruleKey: "changeRequest.description",
              enabled: true,
              mode: "require",
              options: {
                template: `## ${B_MARKER}\n`,
                requiredSections: [B_MARKER],
              },
              locked: true,
            }],
        },
      });
      assertEquals(more.status, 201, await more.clone().text());
    }
    const repoA = await f.seedRepository(organizationAId);
    const repoB = await f.seedRepository(organizationBId);
    const archivedA = await f.seedRepository(organizationAId);
    await seedProfile(
      f,
      organizationAId,
      repoA.repositoryId,
      profileWith([overrideOf({ ...commitsEntry(false), mode: "warn" })]),
    );
    await seedProfile(
      f,
      organizationBId,
      repoB.repositoryId,
      profileWith([overrideOf({ ...commitsEntry(false), mode: "warn" })]),
    );
    await archiveRepository(f, organizationAId, archivedA.repositoryId);
    const baseline = await allTableCounts(f);
    const sameAsBaseline = async (label: string) =>
      assertEquals(await allTableCounts(f), baseline, label);

    await test.step("a repository preview resolves against its own organization's rules only", async () => {
      const everything = JSON.stringify(
        await (await repoPreview(repoA.repositoryId, adminA, {
          overrides: {
            entries: [
              overrideOf({ ...commitsEntry(false), mode: "warn" }),
              overrideOf(titleEntry(80)),
            ],
          },
          sample: { pullRequestTitle: "feat(api): ok" },
        })).clone().json(),
      );
      const body = JSON.parse(everything) as {
        organizationRevision: number;
        conflicts: unknown[];
        effective: {
          organizationRevision: number;
          entries: Array<{
            ruleKey: string;
            provenance: string;
            organizationRevision: number | null;
            explanation?: string;
          }>;
          supersededOverrides: unknown[];
        };
      };
      // B is at revision 3 and locks commits, title and description; A is at 1
      // with nothing locked, so A's overrides apply and nothing of B shows.
      assertEquals(body.organizationRevision, 1);
      assertEquals(body.conflicts, []);
      assertEquals(body.effective.organizationRevision, 1);
      assertEquals(body.effective.supersededOverrides, []);
      assertEquals(
        body.effective.entries.map(({ ruleKey, provenance }) => [
          ruleKey,
          provenance,
        ]),
        [
          ["commits.semantic", "repository_override"],
          ["changeRequest.semanticTitle", "repository_override"],
        ],
      );
      assert(
        body.effective.entries.every((entry) =>
          entry.organizationRevision === 1
        ),
      );
      for (
        const foreign of [
          B_MARKER,
          organizationBId,
          repoB.repositoryId,
        ]
      ) assert(!everything.includes(foreign), foreign);
      // And B's preview of its own repository sees B's lock, not A's rules.
      const mine = await (await repoPreview(repoB.repositoryId, adminB, {
        overrides: { entries: [overrideOf(titleEntry(80))] },
      })).json() as {
        organizationRevision: number;
        conflicts: Array<{ ruleKey: string }>;
      };
      assertEquals(mine.organizationRevision, 3);
      assertEquals(mine.conflicts.map(({ ruleKey }) => ruleKey), [
        "changeRequest.semanticTitle",
      ]);
    });

    await test.step("a preview sees only its own organization's revision, rules and repositories", async () => {
      const a = await orgPreview(organizationAId, adminA, {
        expectedRevision: 1,
        entries: [commitsEntry(true)],
      });
      assertEquals(a.status, 200, await a.clone().text());
      const bodyA = await a.json() as {
        currentRevision: number;
        counts: Record<string, number>;
        items: Array<{ repositoryId: string; status: string }>;
      };
      assertEquals(bodyA.currentRevision, 1);
      // B's lock at revision 3 must not hide A's newly introduced lock.
      assertEquals(bodyA.counts, {
        repositories: 1,
        inherited: 0,
        overridden: 0,
        newlyLocked: 1,
        unsupported: 0,
      });
      assertEquals(bodyA.items.map((item) => item.repositoryId), [
        repoA.repositoryId,
      ]);
      // B's revision number is not A's.
      assertEquals(
        (await orgPreview(organizationAId, adminA, {
          expectedRevision: 3,
          entries: [commitsEntry(true)],
        })).status,
        412,
      );
      const b = await orgPreview(organizationBId, adminB, {
        expectedRevision: 3,
        entries: [commitsEntry(true)],
      });
      assertEquals(b.status, 200, await b.clone().text());
      const bodyB = await b.json() as typeof bodyA;
      assertEquals(bodyB.currentRevision, 3);
      assertEquals(bodyB.counts.repositories, 1);
      assertEquals(bodyB.items.map((item) => item.repositoryId), [
        repoB.repositoryId,
      ]);
      // B's saved override was already superseded by its own lock.
      assertEquals(bodyB.items[0].status, "inherited");
      const stale = await orgPreview(organizationBId, adminB, {
        expectedRevision: 1,
        entries: [commitsEntry(true)],
      });
      assertEquals(stale.status, 412);
    });

    await test.step("the organization preview answers a foreign or unknown organization identically", async () => {
      const foreign = await orgPreview(organizationAId, adminB);
      const unknown = await orgPreview(unknownOrganization, adminB);
      assertEquals(foreign.status, 404);
      assertEquals(unknown.status, 404);
      assertEquals(
        problemShape(await foreign.json()),
        problemShape(await unknown.json()),
      );
      assertEquals(
        foreign.headers.get("content-type"),
        unknown.headers.get("content-type"),
      );
      // A member of B sending A's id in the organization header too.
      const header = {
        cookie: f.cookies.adminB,
        organizationId: organizationAId,
      };
      const spoofed = await orgPreview(organizationAId, header);
      const spoofedUnknown = await orgPreview(unknownOrganization, {
        ...header,
        organizationId: unknownOrganization,
      });
      assertEquals(spoofed.status, 404);
      assertEquals(
        problemShape(await spoofed.json()),
        problemShape(await spoofedUnknown.json()),
      );
      // The same person administering both organizations: the path still
      // decides, never the other membership.
      const mixed = await orgPreview(organizationBId, {
        cookie: f.cookies.adminAB,
        organizationId: organizationAId,
      });
      assert(mixed.status >= 400 && mixed.status < 500);
      const mixedUnknown = await orgPreview(unknownOrganization, {
        cookie: f.cookies.adminAB,
        organizationId: organizationAId,
      });
      assertEquals(mixed.status, mixedUnknown.status);
      assertEquals(
        problemShape(await mixed.json()),
        problemShape(await mixedUnknown.json()),
      );
      await sameAsBaseline("cross-tenant organization preview");
    });

    await test.step("the repository preview answers foreign, unknown and archived repositories identically", async () => {
      const shapes: unknown[] = [];
      for (
        const id of [
          repoB.repositoryId,
          crypto.randomUUID(),
          archivedA.repositoryId,
        ]
      ) {
        const response = await repoPreview(id, adminA);
        assertEquals(response.status, 404, id);
        shapes.push(problemShape(await response.json()));
      }
      assertEquals(shapes[1], shapes[0]);
      assertEquals(shapes[2], shapes[0]);
      // And the mirror image: B's admin against A's repository.
      const mirror = await repoPreview(repoA.repositoryId, adminB);
      assertEquals(mirror.status, 404);
      assertEquals(problemShape(await mirror.json()), shapes[0]);
      // Same person in both organizations: the active organization decides.
      const bothInA = await repoPreview(repoB.repositoryId, {
        cookie: f.cookies.adminAB,
        organizationId: organizationAId,
      });
      assertEquals(bothInA.status, 404);
      assertEquals(problemShape(await bothInA.json()), shapes[0]);
      await sameAsBaseline("cross-tenant repository preview");
    });

    await test.step("non-admin roles are refused like the neighbouring Admin read and learn nothing", async () => {
      const cases: Array<[string, string]> = [
        ["developer", f.cookies.developerA],
        ["viewer", f.cookies.viewerA],
        ["guest", f.cookies.guestA],
        ["inactive", f.cookies.inactiveA],
      ];
      for (const [label, cookie] of cases) {
        const options = { cookie, organizationId: organizationAId };
        // A preview is a POST dry run: it is refused exactly like the
        // neighbouring Admin publication for the same role (403 for a member,
        // 404 for a guest or inactive member), never as a read.
        const publication = await send(
          "POST",
          f.versionsPath(organizationAId),
          {
            ...options,
            idempotencyKey: crypto.randomUUID(),
            body: { expectedRevision: 1, entries: [titleEntry()] },
          },
        );
        const organization = await orgPreview(organizationAId, options);
        assertEquals(organization.status, publication.status, label);
        assertEquals(
          problemShape(await organization.json()),
          problemShape(await publication.json()),
          label,
        );
        assert([403, 404].includes(organization.status), label);
        const repository = await repoPreview(repoA.repositoryId, options);
        assert([403, 404].includes(repository.status), `${label} repo`);
        const repositoryUnknown = await repoPreview(
          crypto.randomUUID(),
          options,
        );
        // A non-admin cannot tell a real repository from a missing one.
        assertEquals(repository.status, repositoryUnknown.status, label);
        assertEquals(
          problemShape(await repository.json()),
          problemShape(await repositoryUnknown.json()),
          label,
        );
      }
      await sameAsBaseline("non-admin roles");
    });

    await test.step("unauthenticated, cross-origin and header-less requests are refused", async () => {
      assertEquals(
        (await send("POST", previewOrganizationPath(organizationAId), {
          organizationId: organizationAId,
          body: draft,
        })).status,
        401,
      );
      assertEquals(
        (await send("POST", previewRepositoryPath(repoA.repositoryId), {
          organizationId: organizationAId,
          body: { overrides: { entries: [] } },
        })).status,
        401,
      );
      const crossOrigin = await f.fixture.app.fetch(
        new Request(
          `http://untrusted.example${previewOrganizationPath(organizationAId)}`,
          {
            method: "POST",
            headers: {
              cookie: f.cookies.adminA,
              "Bakery-Organization-Id": organizationAId,
              "content-type": "application/json",
              origin: "http://untrusted.example",
            },
            body: JSON.stringify(draft),
          },
        ),
      );
      assert(crossOrigin.status >= 400 && crossOrigin.status < 500);
      // A session without the organization header cannot pick an organization.
      const noHeader = await send(
        "POST",
        previewOrganizationPath(organizationAId),
        {
          cookie: f.cookies.adminA,
          body: draft,
        },
      );
      assert(noHeader.status >= 400 && noHeader.status < 500);
      await sameAsBaseline("unauthenticated");
    });

    await test.step("real access tokens: organization routes are browser-only, repository routes honor scope", async () => {
      const mint = async (
        scopes: string[],
        principalId: string,
        organizationId: string,
      ) => {
        const body = btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
        ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
        const secret = `bky_${body}`;
        await f.owner`
          insert into bakery.access_tokens (
            organization_id, principal_id, created_by_principal_id, name,
            prefix, secret_sha256, scopes, expires_at
          ) values (
            ${organizationId}, ${principalId}, ${principalId},
            'rule previews security', ${secret.slice(0, 12)},
            ${await sha256Hex(secret)}, ${scopes},
            ${new Date(Date.now() + 3_600_000)}
          )`;
        return `Bearer ${secret}`;
      };
      const adminTokens = {
        admin: await mint(
          ["bakery:admin"],
          f.adminA.principalId,
          organizationAId,
        ),
        read: await mint(
          ["bakery:read"],
          f.adminA.principalId,
          organizationAId,
        ),
        operate: await mint(
          ["bakery:operate"],
          f.adminA.principalId,
          organizationAId,
        ),
        fake: `Bearer bky_${"x".repeat(43)}`,
      };
      const developerToken = await mint(
        ["bakery:admin"],
        f.developerA.principalId,
        organizationAId,
      );
      const tokenB = await mint(
        ["bakery:admin"],
        f.adminB.principalId,
        organizationBId,
      );
      const afterMint = await allTableCounts(f);
      for (const [label, authorization] of Object.entries(adminTokens)) {
        const organization = await orgPreview(organizationAId, {
          organizationId: organizationAId,
          authorization,
        });
        assertEquals(organization.status, 401, `org ${label}`);
        assertEquals(
          (await organization.json() as { code: string }).code,
          "AUTH_INVALID",
        );
      }
      const outcome = async (response: Response) => {
        const body = await response.json() as {
          code?: string;
          requiredScopes?: string[];
        };
        return {
          status: response.status,
          code: body.code,
          requiredScopes: body.requiredScopes,
        };
      };
      const repoWith = (
        repositoryId: string,
        organizationId: string,
        authorization: string,
      ) => repoPreview(repositoryId, { organizationId, authorization });
      // `repositoryRule:preview` has the verb "preview": the shared scope rule
      // covers every non-`manage` verb with `bakery:operate`, so operate and
      // admin tokens preview (a dry run that writes nothing); read does not.
      const sent = {
        read: await outcome(
          await repoWith(repoA.repositoryId, organizationAId, adminTokens.read),
        ),
        fake: await outcome(
          await repoWith(repoA.repositoryId, organizationAId, adminTokens.fake),
        ),
      };
      assertEquals(sent.read, {
        status: 403,
        code: "INSUFFICIENT_SCOPE",
        requiredScopes: ["bakery:operate"],
      });
      assertEquals(sent.fake, {
        status: 401,
        code: "AUTH_INVALID",
        requiredScopes: undefined,
      });
      for (const label of ["operate", "admin"] as const) {
        const ok = await repoWith(
          repoA.repositoryId,
          organizationAId,
          adminTokens[label],
        );
        assertEquals(ok.status, 200, label);
        const body = await ok.json() as { repositoryId: string };
        assertEquals(body.repositoryId, repoA.repositoryId);
      }
      // An admin-scope token minted for a developer-role principal is not an Admin.
      const asDeveloper = await outcome(
        await repoWith(repoA.repositoryId, organizationAId, developerToken),
      );
      const unknownAsDeveloper = await outcome(
        await repoWith(crypto.randomUUID(), organizationAId, developerToken),
      );
      assertEquals(asDeveloper, unknownAsDeveloper);
      assertEquals(asDeveloper.status, 403);
      assertEquals(asDeveloper.code, "AUTH_FORBIDDEN");
      // An organization B admin token cannot read A's repository.
      const foreign = await repoWith(
        repoA.repositoryId,
        organizationBId,
        tokenB,
      );
      const unknown = await repoWith(
        crypto.randomUUID(),
        organizationBId,
        tokenB,
      );
      assertEquals(foreign.status, 404);
      assertEquals(
        problemShape(await foreign.json()),
        problemShape(await unknown.json()),
      );
      // The token's organization is fixed: A's token naming B's header is the
      // exact 404 of an unknown resource, never a leak of B's repository.
      const mismatch = await repoWith(
        repoB.repositoryId,
        organizationBId,
        adminTokens.admin,
      );
      const mismatchUnknown = await repoWith(
        crypto.randomUUID(),
        organizationBId,
        adminTokens.admin,
      );
      assertEquals(mismatch.status, 404);
      assertEquals(mismatch.status, mismatchUnknown.status);
      assertEquals(
        problemShape(await mismatch.json()),
        problemShape(await mismatchUnknown.json()),
      );
      assertEquals(await allTableCounts(f), afterMint, "tokens");
    });

    await test.step("a bot with only a repositoryProfiles.create grant cannot preview", async () => {
      const authorization = await f.createGrantOnlyBot();
      const response = await repoPreview(repoA.repositoryId, {
        organizationId: organizationAId,
        authorization,
      });
      assertEquals(response.status, 403);
      assertEquals(
        (await response.clone().json() as { code: string }).code,
        "AUTH_FORBIDDEN",
      );
      await response.arrayBuffer();
    });
  } finally {
    await f.close();
  }
});

Deno.test("rule previews reject smuggled, oversized and unstorable input before any work", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId, organizationBId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const orgPath = previewOrganizationPath(organizationAId);
  const repo = await f.seedRepository(organizationAId);
  const repoPath = previewRepositoryPath(repo.repositoryId);
  try {
    const published = await send("POST", f.versionsPath(organizationAId), {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      body: { expectedRevision: 0, entries: [commitsEntry(false)] },
    });
    assertEquals(published.status, 201);
    const baseline = await allTableCounts(f);
    const org = (body: unknown, headers: Record<string, string> = {}) =>
      send("POST", orgPath, { ...adminA, body, headers });
    const repository = (body: unknown) =>
      send("POST", repoPath, { ...adminA, body });
    const valid = { expectedRevision: 1, entries: [commitsEntry(true)] };
    const validRepo = { overrides: { entries: [] } };

    await test.step("organization preview body is strict", async () => {
      const bad: unknown[] = [
        { ...valid, revision: 9 },
        { ...valid, organizationId: organizationBId },
        { ...valid, digest: "0".repeat(64) },
        { ...valid, createdBy: f.adminB.principalId },
        { entries: valid.entries },
        { expectedRevision: 1 },
        { expectedRevision: -1, entries: [] },
        { expectedRevision: 1.5, entries: [] },
        { expectedRevision: "1", entries: [] },
        { expectedRevision: null, entries: [] },
        { expectedRevision: 1, entries: "x" },
        { expectedRevision: 1, entries: null },
        { expectedRevision: 1, entries: [{}] },
        { expectedRevision: 1, entries: [{ ...commitsEntry(), extra: 1 }] },
        {
          expectedRevision: 1,
          entries: [{
            ...commitsEntry(),
            options: { ...commitsEntry().options, extra: 1 },
          }],
        },
        { expectedRevision: 1, entries: Array(6).fill(commitsEntry()) },
        { ...valid, limit: 0 },
        { ...valid, limit: 101 },
        { ...valid, cursor: 5 },
        { ...valid, cursor: "x".repeat(513) },
        [],
        "text",
        null,
      ];
      for (const body of bad) {
        const response = await org(body);
        assertEquals(response.status, 400, JSON.stringify(body)?.slice(0, 120));
        await response.arrayBuffer();
      }
      // Prototype-style keys are rejected rather than merged.
      const proto = await send("POST", orgPath, {
        ...adminA,
        body: undefined,
      });
      assert(proto.status >= 400);
      await proto.arrayBuffer();
      const raw = await f.fixture.app.fetch(
        new Request(`http://localhost${orgPath}`, {
          method: "POST",
          headers: {
            cookie: f.cookies.adminA,
            "Bakery-Organization-Id": organizationAId,
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body:
            '{"expectedRevision":1,"entries":[],"__proto__":{"admin":true}}',
        }),
      );
      assert(raw.status >= 400 && raw.status < 500, String(raw.status));
      await raw.arrayBuffer();
      assertEquals(await allTableCounts(f), baseline);
    });

    await test.step("free text the database cannot store is a 400 at the boundary", async () => {
      for (
        const explanation of [
          "bad\u0000text",
          "lone\ud800surrogate",
          "lone\udc00low",
        ]
      ) {
        const response = await org({
          expectedRevision: 1,
          entries: [{ ...commitsEntry(), explanation }],
        });
        assertEquals(response.status, 400, JSON.stringify(explanation));
        await response.arrayBuffer();
      }
      assertEquals(await allTableCounts(f), baseline);
    });

    await test.step("repository preview body is strict and its sample is bounded", async () => {
      const bad: unknown[] = [
        {},
        { overrides: null },
        { overrides: [] },
        { overrides: { entries: [], extra: 1 } },
        { overrides: { entries: [{ ...commitsEntry(), locked: true }] } },
        { overrides: { entries: Array(6).fill(overrideOf(commitsEntry())) } },
        { ...validRepo, extra: 1 },
        { ...validRepo, repositoryId: crypto.randomUUID() },
        { ...validRepo, sample: null },
        { ...validRepo, sample: "text" },
        { ...validRepo, sample: { extra: "x" } },
        { ...validRepo, sample: { commitMessages: "feat: x" } },
        { ...validRepo, sample: { commitMessages: Array(21).fill("feat: x") } },
        { ...validRepo, sample: { commitMessages: ["x".repeat(2001)] } },
        { ...validRepo, sample: { commitMessages: [1] } },
        { ...validRepo, sample: { pullRequestTitle: "x".repeat(301) } },
        { ...validRepo, sample: { pullRequestDescription: "x".repeat(8001) } },
        { ...validRepo, sample: { pullRequestTitle: 5 } },
        { ...validRepo, sample: { commitMessages: ["a\u0000b"] } },
        { ...validRepo, sample: { commitMessages: ["a\ud800b"] } },
        { ...validRepo, sample: { pullRequestTitle: "a\u0000b" } },
        { ...validRepo, sample: { pullRequestTitle: "a\udc00b" } },
        { ...validRepo, sample: { pullRequestDescription: "a\u0000b" } },
        { ...validRepo, sample: { pullRequestDescription: "a\ud800b" } },
      ];
      for (const body of bad) {
        const response = await repository(body);
        assertEquals(response.status, 400, JSON.stringify(body)?.slice(0, 160));
        await response.arrayBuffer();
      }
      // Bounds themselves are accepted; one past each is not.
      for (
        const body of [
          {
            ...validRepo,
            sample: { commitMessages: Array(20).fill("x".repeat(2000)) },
          },
          { ...validRepo, sample: { pullRequestTitle: "x".repeat(300) } },
          {
            ...validRepo,
            sample: { pullRequestDescription: "x".repeat(8000) },
          },
          {
            ...validRepo,
            sample: {
              commitMessages: [],
              pullRequestTitle: "",
              pullRequestDescription: "",
            },
          },
          { ...validRepo, sample: { pullRequestTitle: "emoji 😀 pair" } },
        ]
      ) {
        const response = await repository(body);
        assertEquals(response.status, 200, JSON.stringify(body).slice(0, 120));
        await response.arrayBuffer();
      }
      assertEquals(await allTableCounts(f), baseline);
    });

    await test.step("megabyte bodies are refused without work", async () => {
      const huge = "x".repeat(1_100_000);
      for (
        const call of [
          () => org({ ...valid, filler: huge }),
          () =>
            repository({
              ...validRepo,
              sample: { pullRequestDescription: huge },
            }),
          () =>
            repository({ ...validRepo, sample: { commitMessages: [huge] } }),
        ]
      ) {
        const response = await call();
        assert(
          response.status === 400 || response.status === 413,
          String(response.status),
        );
        await response.arrayBuffer();
      }
      assertEquals(await allTableCounts(f), baseline);
    });

    await test.step("adversarial sample text finishes quickly and is never reflected", async () => {
      const hostile = [
        "(".repeat(1900),
        "feat(" + "(".repeat(1900),
        "feat" + "!".repeat(1900) + ":",
        "feat: " + " ".repeat(1900) + "x",
        "\n".repeat(1900),
        "<script>alert(1)</script>",
      ];
      const started = performance.now();
      const response = await send("POST", repoPath, {
        ...adminA,
        body: {
          overrides: { entries: [] },
          sample: {
            commitMessages: [...hostile, ...hostile].slice(0, 12),
            pullRequestTitle: "(".repeat(300),
            pullRequestDescription: "# ".repeat(4000),
          },
        },
      });
      assertEquals(response.status, 200);
      const text = await response.text();
      assert(performance.now() - started < 5000);
      assert(!text.includes("<script>"));
      assert(!text.includes("((((((((((((((((("));
      assertEquals(await allTableCounts(f), baseline);
    });

    await test.step("an Idempotency-Key is neither required nor remembered", async () => {
      const key = crypto.randomUUID();
      const first = await send("POST", orgPath, {
        ...adminA,
        idempotencyKey: key,
        body: valid,
      });
      const second = await send("POST", orgPath, {
        ...adminA,
        idempotencyKey: key,
        body: { ...valid, entries: [commitsEntry(false)] },
      });
      assertEquals(first.status, 200);
      // A different body with the same key is not an IDEMPOTENCY_PAYLOAD_MISMATCH: there is no replay layer.
      assertEquals(second.status, 200);
      assertEquals(first.headers.get("Idempotent-Replayed"), null);
      assertEquals(second.headers.get("Idempotent-Replayed"), null);
      await first.arrayBuffer();
      await second.arrayBuffer();
      const withoutKey = await org(valid);
      assertEquals(withoutKey.status, 200);
      await withoutKey.arrayBuffer();
      assertEquals(await allTableCounts(f), baseline);
    });
  } finally {
    await f.close();
  }
});
