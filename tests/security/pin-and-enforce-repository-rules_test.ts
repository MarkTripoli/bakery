import { assert, assertEquals } from "@std/assert";
import {
  commitsEntry,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";
import { openRepositoryRulesFixture } from "../helpers/repository-rules-fixture.ts";
import {
  apiCall,
  createCodingAgent,
  expectJson,
  presetBilling,
  presetBudgetEnv,
} from "../helpers/fixed-coding-preset.ts";
import {
  closeWorkerScope,
  createWorkerScope,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  countRows,
  expectedPin,
  implementOnlyDefinition,
  numbersRule,
  pinnedRulesOf,
  publishOrganizationRules,
  seedRulesRepository,
  startRun,
  unboundNumbersRule,
} from "../helpers/pinned-rules.ts";

Deno.test("run admission pins only its own organization's rules, even when another organization is ahead and locked", () =>
  withWorkerFixture(async (fixture) => {
    const db = fixture.pgDatabase;
    // Organization B shares the principal but is a distinct tenant.
    const scopeB = await createWorkerScope(fixture, "rules-b", fixture);
    try {
      const entriesA = [titleEntry()];
      await publishOrganizationRules(fixture, fixture, 0, entriesA);
      // B is at a HIGHER revision than A and locks a require rule, so a
      // dropped organization predicate would pick B's rows instead of A's.
      const entriesB = [
        { ...commitsEntry(true), mode: "require" },
        unboundNumbersRule({ locked: true }),
      ];
      await publishOrganizationRules(fixture, scopeB, 0, [titleEntry()]);
      await publishOrganizationRules(fixture, scopeB, 1, [commitsEntry(false)]);
      await publishOrganizationRules(fixture, scopeB, 2, entriesB);
      const repositoryA = await seedRulesRepository(
        fixture,
        fixture,
        "tenant-a",
      );
      const repositoryB = await seedRulesRepository(
        fixture,
        scopeB,
        "tenant-b",
      );
      const runA = await startRun(fixture, fixture, repositoryA);
      const runB = await startRun(fixture, scopeB, repositoryB);
      const pinA = await pinnedRulesOf(db, fixture.organizationId, runA.run.id);
      const pinB = await pinnedRulesOf(db, scopeB.organizationId, runB.run.id);
      assertEquals(
        pinA,
        await expectedPin({ revision: 1, entries: entriesA }, [], {
          id: repositoryA.profileId,
          revision: 1,
        }),
      );
      assertEquals(pinA.organizationRevision, 1);
      assertEquals(
        pinA.entries.map(({ ruleKey }) => ruleKey),
        ["changeRequest.semanticTitle"],
      );
      assertEquals(
        pinB,
        await expectedPin({ revision: 3, entries: entriesB }, [], {
          id: repositoryB.profileId,
          revision: 1,
        }),
      );
      assertEquals(pinB.organizationRevision, 3);
      // B's profile cannot be admitted through A's scope either way: an id of
      // the other tenant is an unknown id (404), not a rules answer.
      const crossed = await apiCall(
        fixture,
        fixture,
        "GET",
        `/v1/repositories/${repositoryB.repositoryId}/rules`,
      );
      assertEquals(crossed.status, 404);
      await crossed.body?.cancel();
      const own = await expectJson<{ organizationRevision: number }>(
        await apiCall(
          fixture,
          fixture,
          "GET",
          `/v1/repositories/${repositoryA.repositoryId}/rules`,
        ),
        200,
      );
      assertEquals(own.organizationRevision, 1);
    } finally {
      await closeWorkerScope(fixture, scopeB);
    }
  }, { env: presetBudgetEnv }));

Deno.test("workflow rule guard reads only the caller's organization; roles and unauthenticated callers never reach it", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const as = (cookie: string, organizationId: string) => ({
    cookie,
    organizationId,
    idempotencyKey: crypto.randomUUID(),
  });
  const adminA = () => as(f.cookies.adminA, organizationAId);
  const adminB = () => as(f.cookies.adminB, organizationBId);
  const publishRules = async (
    who: () => ReturnType<typeof adminA>,
    organizationId: string,
    expectedRevision: number,
    entries: unknown[],
  ) => {
    const response = await send("POST", f.versionsPath(organizationId), {
      ...who(),
      body: { expectedRevision, entries },
    });
    assertEquals(response.status, 201, await response.clone().text());
  };
  const draftIn = async (
    who: () => ReturnType<typeof adminA>,
    slug: string,
    definition: unknown,
  ): Promise<{ workflow: string; draft: string }> => {
    const created = await send("POST", "/v1/workflows", {
      ...who(),
      body: { slug, name: slug, description: "" },
    });
    assertEquals(created.status, 201);
    const workflow = (await created.json() as { id: string }).id;
    const draft = await send("POST", `/v1/workflows/${workflow}/versions`, {
      ...who(),
      body: { definition },
    });
    assertEquals(draft.status, 201);
    return { workflow, draft: (await draft.json() as { id: string }).id };
  };
  const publish = (
    who: ReturnType<typeof adminA>,
    target: { workflow: string; draft: string },
  ) =>
    send(
      "POST",
      `/v1/workflows/${target.workflow}/versions/${target.draft}/publish`,
      { ...who, body: {}, headers: { "If-Match": '"1"' } },
    );

  const agentFor = (
    organizationId: string,
    who: typeof f.adminA,
    cookie: string,
    label: string,
  ) =>
    createCodingAgent(
      f.fixture,
      { organizationId, principalId: who.principalId, adminCookie: cookie },
      label,
      { harness: "codex", billing: presetBilling(label) },
    );
  const definitionA = implementOnlyDefinition(
    await agentFor(organizationAId, f.adminA, f.cookies.adminA, "sec-a"),
  );
  const definitionB = implementOnlyDefinition(
    await agentFor(organizationBId, f.adminB, f.cookies.adminB, "sec-b"),
  );

  try {
    await test.step("another organization's higher-revision require rule does not bind this organization", async () => {
      await publishRules(adminA, organizationAId, 0, [titleEntry()]);
      await publishRules(adminB, organizationBId, 0, [titleEntry()]);
      await publishRules(adminB, organizationBId, 1, [titleEntry()]);
      await publishRules(adminB, organizationBId, 2, [
        numbersRule({ locked: true }),
      ]);
      const target = await draftIn(adminA, "tenant-guard-a", definitionA);
      const published = await publish(adminA(), target);
      assertEquals(published.status, 200, await published.clone().text());
      // B itself is bound by its own rule.
      const own = await draftIn(adminB, "tenant-guard-b", definitionB);
      const refused = await publish(adminB(), own);
      assertEquals(refused.status, 422);
      await refused.body?.cancel();
    });

    await test.step("role matrix is unchanged: only Admin passes, and nobody else learns the rule", async () => {
      await publishRules(adminA, organizationAId, 1, [numbersRule()]);
      const target = await draftIn(adminA, "matrix", definitionA);
      const countBefore = await countRows(
        runtime,
        "select count(*) from bakery.workflow_versions where organization_id = $1",
        [organizationAId],
      );
      const callers: Array<[string, string | undefined, number]> = [
        ["developer", f.cookies.developerA, 403],
        ["viewer", f.cookies.viewerA, 403],
        ["guest", f.cookies.guestA, 404],
        ["unauthenticated", undefined, 401],
      ];
      for (const [name, cookie, status] of callers) {
        const response = await send(
          "POST",
          `/v1/workflows/${target.workflow}/versions/${target.draft}/publish`,
          {
            ...(cookie === undefined ? {} : { cookie }),
            organizationId: organizationAId,
            idempotencyKey: crypto.randomUUID(),
            body: {},
            headers: { "If-Match": '"1"' },
          },
        );
        const text = await response.text();
        assertEquals(response.status, status, `${name}: ${text}`);
        assert(!text.includes("magicNumbers"), `${name} learned the rule key`);
        assert(!text.includes("repository_rule"), `${name} saw the guard`);
      }
      assertEquals(
        await countRows(
          runtime,
          "select count(*) from bakery.workflow_versions where organization_id = $1",
          [organizationAId],
        ),
        countBefore,
      );
      // Admin reaches the guard and is refused with the typed error.
      const admin = await publish(adminA(), target);
      assertEquals(admin.status, 422);
      assert((await admin.text()).includes("code.magicNumbers"));
    });

    await test.step("activation: non-admins get 403 before any rule is evaluated", async () => {
      // A version published when no rule required anything, then a rule appears.
      await publishRules(adminA, organizationAId, 2, []);
      const target = await draftIn(adminA, "matrix-activate", definitionA);
      assertEquals((await publish(adminA(), target)).status, 200);
      await publishRules(adminA, organizationAId, 3, [numbersRule()]);
      const version = (await runtime.query<{ version: number }>(
        `select version from bakery.workflow_definitions
          where organization_id = $1 and id = $2`,
        [organizationAId, target.workflow],
      )).rows[0].version;
      for (
        const [name, cookie, status] of [
          ["developer", f.cookies.developerA, 403],
          ["viewer", f.cookies.viewerA, 403],
        ] as const
      ) {
        const response = await send(
          "POST",
          `/v1/workflows/${target.workflow}/activations`,
          {
            cookie,
            organizationId: organizationAId,
            idempotencyKey: crypto.randomUUID(),
            body: { versionId: target.draft },
            headers: { "If-Match": `"${version}"` },
          },
        );
        const text = await response.text();
        assertEquals(response.status, status, `${name}: ${text}`);
        assert(!text.includes("magicNumbers"), name);
      }
      const admin = await send(
        "POST",
        `/v1/workflows/${target.workflow}/activations`,
        {
          ...adminA(),
          body: { versionId: target.draft },
          headers: { "If-Match": `"${version}"` },
        },
      );
      assertEquals(admin.status, 422);
      await admin.body?.cancel();
    });
  } finally {
    await f.close();
  }
});
