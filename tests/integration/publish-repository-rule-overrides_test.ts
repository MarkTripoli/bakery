import { assert, assertEquals } from "@std/assert";
import { maxPublishableConfigBytes } from "../../apps/server/src/modules/projects/inspection-budget.ts";
import {
  admitRepositoryProfile,
  enforceRepositoryFixedPolicy,
} from "../../packages/persistence/src/repository-admission.ts";
import { lockOrganization } from "../../apps/server/src/modules/auth/adapters/access-postgres.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { resolveRepositoryRules } from "../../packages/contracts/src/repository-rules.ts";
import {
  allRuleEntries,
  ballastRules,
  baseProfileConfig,
  commitsEntry,
  configBytesWithRules,
  maxFillerChars,
  openRepositoryRulesFixture,
  overrideOf,
  profileBody,
  profileFactCounts,
  ruleDigest,
  titleEntry,
} from "../helpers/repository-rules-fixture.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
  receiveInspectionSource,
} from "../helpers/repository-inspection.ts";

// Fixed-policy admission binds a quality.check to one exact commit.
const CHECK_REVISION = "1".repeat(40);

function problemShape(body: Record<string, unknown>) {
  const { instance: _i, requestId: _r, traceId: _t, ...stable } = body;
  return stable;
}

type Effective = {
  repositoryId: string;
  repositoryVersion: number;
  checkers: { state: string; unavailableRuleKeys: string[] };
  providerProtection: { state: string; reason: string | null };
  profileId: string | null;
  profileRevision: number | null;
  organizationRevision: number;
  entries: Array<{
    ruleKey: string;
    provenance: string;
    organizationRevision: number | null;
    mode: string;
    enabled: boolean;
    options: Record<string, unknown>;
  }>;
  supersededOverrides: Array<{
    ruleKey: string;
    reason: string;
    override: Record<string, unknown>;
  }>;
  digest: string;
};

const magicStringsLocked = () => allRuleEntries()[4];
const titleOverride = (maxSubjectLength: number) => ({
  ...overrideOf(titleEntry(maxSubjectLength)),
  mode: "require",
});

Deno.test("repository rule overrides publish, resolve and follow organization revisions", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const versionsA = f.versionsPath(organizationAId);
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const repo = await f.seedRepository(organizationAId);
  const second = await f.seedRepository(organizationAId);
  const profiles = f.profilesPath(repo.repositoryId);
  const counts = () =>
    profileFactCounts(runtime, organizationAId, repo.repositoryId);
  const publishRules = async (expectedRevision: number, entries: unknown[]) => {
    const response = await send("POST", versionsA, {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      body: { expectedRevision, entries },
    });
    assertEquals(response.status, 201, await response.clone().text());
  };
  const repositoryVersion = async (repositoryId = repo.repositoryId) =>
    (await runtime.query<{ version: number }>(
      "select version from bakery.repositories where organization_id = $1 and id = $2",
      [organizationAId, repositoryId],
    )).rows[0].version;
  /**
   * `ifMatch` undefined sends the repository's current version (required
   * whenever the publication activates); null sends no header.
   */
  const createProfile = async (
    revision: number,
    repositoryRules: unknown | undefined,
    expectedOrganizationRulesRevision?: number,
    options: Record<string, unknown> = adminA,
    ifMatch?: string | null,
    extraConfig: Record<string, unknown> = {},
  ) =>
    send("POST", profiles, {
      ...options,
      idempotencyKey: crypto.randomUUID(),
      ...(ifMatch === null ? {} : {
        headers: {
          "If-Match": ifMatch ?? `"${await repositoryVersion()}"`,
        },
      }),
      body: await profileBody(
        revision,
        {
          ...baseProfileConfig,
          ...extraConfig,
          ...(repositoryRules === undefined ? {} : { repositoryRules }),
        },
        expectedOrganizationRulesRevision,
      ),
    });
  const created = async (
    revision: number,
    repositoryRules: unknown | undefined,
    expectedOrganizationRulesRevision?: number,
  ) => {
    const response = await createProfile(
      revision,
      repositoryRules,
      expectedOrganizationRulesRevision,
    );
    assertEquals(response.status, 201, await response.clone().text());
    return await response.json() as { id: string; revision: number };
  };
  const effective = async (
    repositoryId = repo.repositoryId,
    options: Record<string, unknown> = adminA,
  ) => {
    const response = await send("GET", f.effectivePath(repositoryId), options);
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json();
    contractSchemas.RepositoryEffectiveRules.parse(body);
    return body as Effective;
  };
  const entry = (body: Effective, ruleKey: string) =>
    body.entries.find((candidate) => candidate.ruleKey === ruleKey);
  const orgRevisionAfter = async () =>
    (await (await send("GET", f.rulesPath(organizationAId), adminA)).json() as {
      revision: number;
    }).revision;

  try {
    let p1: { id: string };
    await test.step("AC1: inherited read with no profile, then with an override-free profile", async () => {
      assertEquals(
        (await send("GET", f.effectivePath(repo.repositoryId), {
          organizationId: organizationAId,
        })).status,
        401,
      );
      const empty = await effective();
      assertEquals(empty, {
        repositoryId: repo.repositoryId,
        profileId: null,
        profileRevision: null,
        organizationRevision: 0,
        entries: [],
        supersededOverrides: [],
        digest: (await resolveRepositoryRules(null, { entries: [] })).digest,
        repositoryVersion: await repositoryVersion(),
        // No rule needs a checker; the fixture repository has no enabled
        // provider connection, so protection is unknown, never "not configured".
        checkers: { state: "not_required", unavailableRuleKeys: [] },
        providerProtection: {
          state: "unknown",
          reason: "provider_not_connected",
        },
      });
      // The read carries the repository version as the activation validator.
      const read = await send(
        "GET",
        f.effectivePath(repo.repositoryId),
        adminA,
      );
      assertEquals(read.headers.get("etag"), `"v${await repositoryVersion()}"`);
      await read.body?.cancel();
      await publishRules(0, [commitsEntry(false), titleEntry(72)]);
      const inherited = await effective();
      assertEquals(inherited.profileId, null);
      assertEquals(inherited.organizationRevision, 1);
      assertEquals(
        inherited.entries.map((
          e,
        ) => [e.ruleKey, e.provenance, e.organizationRevision]),
        [
          ["commits.semantic", "inherited", 1],
          ["changeRequest.semanticTitle", "inherited", 1],
        ],
      );
      p1 = await created(1, undefined);
      const withProfile = await effective();
      assertEquals(withProfile.profileId, p1.id);
      assertEquals(withProfile.profileRevision, 1);
      assertEquals(withProfile.entries, inherited.entries);
      assertEquals(withProfile.digest, inherited.digest);
    });

    let p2: { id: string };
    await test.step("AC2: an override wins, only the active profile counts, and it follows later organization revisions", async () => {
      const before = await counts();
      p2 = await created(
        2,
        { entries: [titleOverride(90), overrideOf(allRuleEntries()[3])] },
        1,
      );
      const after = await counts();
      assertEquals(after.profiles, before.profiles + 1);
      assertEquals(after.audit, before.audit + 1);
      assertEquals(after.events, before.events + 1);
      // Overrides activate on publication (mirrors fixedPolicy), so the read
      // resolves them at once; the repository moved to the new profile.
      assertEquals(after.activeProfileId, p2.id);
      assertEquals(
        after.repositoryVersion,
        (before.repositoryVersion ?? 0) + 1,
      );
      // The audit row records the organization revision validated against.
      const auditRows = await runtime.query<
        { resource_id: string; details: Record<string, unknown> }
      >(
        `select resource_id, details from bakery.audit_events
          where organization_id = $1 and operation = 'repositoryProfiles.create'
          order by created_at`,
        [organizationAId],
      );
      assertEquals(
        auditRows.rows.map((row) => [row.resource_id, row.details]),
        [[p1.id, {}], [p2.id, { organizationRulesRevision: 1 }]],
      );
      const body = await effective();
      assertEquals(body.profileId, p2.id);
      assertEquals(body.profileRevision, 2);
      assertEquals(
        entry(body, "changeRequest.semanticTitle")?.provenance,
        "repository_override",
      );
      assertEquals(
        entry(body, "changeRequest.semanticTitle")?.options.maxSubjectLength,
        90,
      );
      assertEquals(entry(body, "changeRequest.semanticTitle")?.mode, "require");
      assertEquals(
        entry(body, "changeRequest.semanticTitle")?.organizationRevision,
        1,
      );
      assertEquals(
        entry(body, "code.magicNumbers")?.provenance,
        "repository_only",
      );
      assertEquals(
        entry(body, "code.magicNumbers")?.organizationRevision,
        null,
      );
      assertEquals(entry(body, "commits.semantic")?.provenance, "inherited");
      assertEquals(
        body.entries.map((e) => e.ruleKey),
        [
          "commits.semantic",
          "changeRequest.semanticTitle",
          "code.magicNumbers",
        ],
      );

      await publishRules(1, [
        { ...commitsEntry(false), mode: "warn" },
        titleEntry(100),
      ]);
      const followed = await effective();
      assertEquals(followed.organizationRevision, 2);
      assertEquals(entry(followed, "commits.semantic")?.mode, "warn");
      assertEquals(
        entry(followed, "commits.semantic")?.organizationRevision,
        2,
      );
      assertEquals(
        entry(followed, "changeRequest.semanticTitle")?.options
          .maxSubjectLength,
        90,
      );
      assert(followed.digest !== body.digest);

      // Restore: the next revision without the override, activated.
      // The active profile carries overrides, so omitting the field is the
      // restore: it activates itself (and requires If-Match, see AC5).
      const p3 = await created(3, undefined);
      assertEquals((await effective()).profileId, p3.id);
      const restored = await effective();
      assertEquals(restored.profileId, p3.id);
      assertEquals(
        entry(restored, "changeRequest.semanticTitle")?.provenance,
        "inherited",
      );
      assertEquals(
        entry(restored, "changeRequest.semanticTitle")?.options
          .maxSubjectLength,
        100,
      );
      assertEquals(entry(restored, "code.magicNumbers"), undefined);
      // The earlier revision stays immutable with its override.
      const stored = await runtime.query<
        { config: { repositoryRules?: unknown } }
      >(
        "select config from bakery.repository_profiles where organization_id = $1 and id = $2",
        [organizationAId, p2.id],
      );
      assert(stored.rows[0].config.repositoryRules !== undefined);
    });

    await test.step("AC3: a lock conflict is a typed 422 naming every rule key and writes nothing", async () => {
      await publishRules(2, [
        { ...commitsEntry(true), mode: "warn" },
        titleEntry(100),
        magicStringsLocked(),
      ]);
      const before = await counts();
      const orgBefore = await orgRevisionAfter();
      const overrides = {
        entries: [
          overrideOf({ ...magicStringsLocked(), enabled: false }),
          titleOverride(95),
          overrideOf(commitsEntry(false)),
        ],
      };
      const response = await createProfile(4, overrides, 3);
      assertEquals(response.status, 422);
      const problem = await response.json() as {
        code: string;
        issues?: Array<{ path: unknown[]; code: string; message: string }>;
      };
      assertEquals(problem.code, "UNPROCESSABLE");
      const issues = problem.issues ?? [];
      assertEquals(
        issues.map(({ path, code }) => [path, code]),
        [
          [
            ["config", "repositoryRules", "entries", 2, "ruleKey"],
            "replaces_locked_rule",
          ],
          [
            ["config", "repositoryRules", "entries", 0, "ruleKey"],
            "disables_locked_rule",
          ],
        ],
      );
      assert(issues[0].message.includes("commits.semantic"));
      assert(issues[1].message.includes("code.magicStrings"));
      assertEquals(await counts(), before);
      assertEquals(await orgRevisionAfter(), orgBefore);
      // An unlocked rule alone is still publishable at the same revision number.
      const ok = await created(4, { entries: [titleOverride(95)] }, 3);
      assertEquals((await effective()).profileId, ok.id);
    });

    await test.step("AC4: a new organization lock supersedes the override and a later unlock restores it", async () => {
      const profileId = (await effective()).profileId;
      await publishRules(3, [
        { ...commitsEntry(true), mode: "warn" },
        { ...titleEntry(100), locked: true },
        magicStringsLocked(),
      ]);
      const locked = await effective();
      assertEquals(locked.profileId, profileId);
      assertEquals(locked.organizationRevision, 4);
      const title = entry(locked, "changeRequest.semanticTitle");
      assertEquals(title?.provenance, "locked_by_organization");
      assertEquals(title?.options.maxSubjectLength, 100);
      assertEquals(locked.supersededOverrides.length, 1);
      assertEquals(
        locked.supersededOverrides[0].ruleKey,
        "changeRequest.semanticTitle",
      );
      assertEquals(
        locked.supersededOverrides[0].reason,
        "locked_by_organization",
      );
      assertEquals(
        (locked.supersededOverrides[0].override.options as {
          maxSubjectLength: number;
        })
          .maxSubjectLength,
        95,
      );
      // Superseded overrides are excluded from the digest: a repository
      // without any override resolves to the same digest.
      const other = await effective(second.repositoryId);
      assertEquals(other.profileId, null);
      assertEquals(other.profileRevision, null);
      assertEquals(other.supersededOverrides, []);
      assertEquals(other.digest, locked.digest);

      await publishRules(4, [
        { ...commitsEntry(true), mode: "warn" },
        titleEntry(100),
        magicStringsLocked(),
      ]);
      const unlocked = await effective();
      assertEquals(unlocked.profileId, profileId);
      assertEquals(unlocked.organizationRevision, 5);
      assertEquals(
        entry(unlocked, "changeRequest.semanticTitle")?.provenance,
        "repository_override",
      );
      assertEquals(
        entry(unlocked, "changeRequest.semanticTitle")?.options
          .maxSubjectLength,
        95,
      );
      assertEquals(unlocked.supersededOverrides, []);
    });

    await test.step("AC5: stale organization revision, missing precondition and stale profile revision write nothing", async () => {
      const before = await counts();
      for (const stale of [4, 6, 0]) {
        const response = await createProfile(5, {
          entries: [titleOverride(80)],
        }, stale);
        assertEquals(response.status, 412, String(stale));
      }
      const missing = await createProfile(5, { entries: [titleOverride(80)] });
      assertEquals(missing.status, 428);
      // Overrides activate the profile, so the repository If-Match is required
      // (like fixedPolicy): missing -> 428, stale -> 412, both before any write.
      const noIfMatch = await createProfile(
        5,
        { entries: [titleOverride(80)] },
        5,
        adminA,
        null,
      );
      assertEquals(noIfMatch.status, 428);
      const staleIfMatch = await createProfile(
        5,
        { entries: [titleOverride(80)] },
        5,
        adminA,
        `"${(await repositoryVersion()) + 1}"`,
      );
      assertEquals(staleIfMatch.status, 412);
      // A stale profile revision keeps the endpoint's existing contract.
      for (const staleProfileRevision of [4, 9]) {
        const response = await createProfile(
          staleProfileRevision,
          { entries: [titleOverride(80)] },
          5,
        );
        assertEquals(response.status, 409, String(staleProfileRevision));
        const problem = await response.json() as {
          code: string;
          reason?: string;
        };
        assertEquals(problem.code, "STATE_CONFLICT");
        assertEquals(problem.reason, "revision_not_next");
      }
      assertEquals(await counts(), before);
    });

    await test.step("AC5: publication holds the organization lock; override-free publication does not", async () => {
      const before = await counts();
      let pending: Promise<Response> | Response;
      let free: Response | undefined;
      await withPgTransaction(runtime, async (transaction) => {
        await lockOrganization(transaction, organizationAId);
        pending = createProfile(5, { entries: [titleOverride(85)] }, 5);
        const settled = await Promise.race([
          Promise.resolve(pending).then(() => "settled"),
          new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
        ]);
        assertEquals(settled, "waiting");
        assertEquals((await counts()).profiles, before.profiles);
        // Without overrides the shared lock is never requested.
        free = await send("POST", f.profilesPath(second.repositoryId), {
          ...adminA,
          idempotencyKey: crypto.randomUUID(),
          body: await profileBody(1, { ...baseProfileConfig }),
        });
      });
      assertEquals(free!.status, 201);
      assertEquals((await pending!).status, 201);
      assertEquals((await counts()).profiles, before.profiles + 1);
    });

    await test.step("AC5: two concurrent publications at one revision commit exactly one", async () => {
      const before = await counts();
      let requests: Array<Promise<Response> | Response> = [];
      await withPgTransaction(runtime, async (transaction) => {
        await lockOrganization(transaction, organizationAId);
        requests = [
          createProfile(6, { entries: [titleOverride(91)] }, 5),
          createProfile(6, { entries: [titleOverride(92)] }, 5),
        ];
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const statuses = (await Promise.all(requests)).map(({ status }) =>
        status
      );
      // The winner activates and bumps the repository version, so the loser's
      // If-Match is stale by the time it holds the repository lock.
      assertEquals(statuses.sort(), [201, 412]);
      const after = await counts();
      assertEquals(after.profiles, before.profiles + 1);
      assertEquals(after.audit, before.audit + 1);
      assertEquals(after.events, before.events + 1);
    });

    await test.step("a concurrent restore and override publication commit exactly one", async () => {
      const before = await counts();
      let requests: Array<Promise<Response> | Response> = [];
      const version = `"${await repositoryVersion()}"`;
      await withPgTransaction(runtime, async (transaction) => {
        await lockOrganization(transaction, organizationAId);
        requests = [
          // Restore: no key while the active profile carries overrides.
          createProfile(7, undefined, undefined, adminA, version),
          createProfile(
            7,
            { entries: [titleOverride(93)] },
            5,
            adminA,
            version,
          ),
        ];
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const statuses = (await Promise.all(requests)).map(({ status }) =>
        status
      );
      assertEquals(statuses.sort(), [201, 412]);
      const after = await counts();
      assertEquals(after.profiles, before.profiles + 1);
      assertEquals(
        after.repositoryVersion,
        (before.repositoryVersion ?? 0) + 1,
      );
    });

    await test.step("AC5: a publisher demoted while waiting for the lock is refused", async () => {
      const before = await counts();
      let pending: Promise<Response> | Response;
      await withPgTransaction(runtime, async (transaction) => {
        await lockOrganization(transaction, organizationAId);
        pending = createProfile(8, { entries: [titleOverride(70)] }, 5, {
          cookie: f.cookies.demotableA,
          organizationId: organizationAId,
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await f.owner`
          update bakery.organization_memberships
             set role = 'developer'
           where organization_id = ${organizationAId}
             and principal_id = ${f.demotableA.principalId}`;
      });
      assertEquals((await pending!).status, 403);
      assertEquals(await counts(), before);
    });

    await test.step("AC6: another organization and developers cannot publish overrides, without leaking existence", async () => {
      const before = await counts();
      const adminB = {
        cookie: f.cookies.adminB,
        organizationId: organizationBId,
      };
      const body = await profileBody(
        8,
        {
          ...baseProfileConfig,
          repositoryRules: { entries: [titleOverride(70)] },
        },
        0,
      );
      const call = (repositoryId: string) =>
        send("POST", f.profilesPath(repositoryId), {
          ...adminB,
          idempotencyKey: crypto.randomUUID(),
          headers: { "If-Match": '"1"' },
          body,
        });
      const foreign = await call(repo.repositoryId);
      const unknown = await call(crypto.randomUUID());
      assertEquals(foreign.status, 404);
      assertEquals(unknown.status, 404);
      assertEquals(
        problemShape(await foreign.json()),
        problemShape(await unknown.json()),
      );
      const readForeign = await send(
        "GET",
        f.effectivePath(repo.repositoryId),
        adminB,
      );
      const readUnknown = await send(
        "GET",
        f.effectivePath(crypto.randomUUID()),
        adminB,
      );
      assertEquals(readForeign.status, 404);
      assertEquals(
        problemShape(await readForeign.json()),
        problemShape(await readUnknown.json()),
      );
      const developer = {
        cookie: f.cookies.developerA,
        organizationId: organizationAId,
      };
      const denied = await createProfile(
        8,
        { entries: [titleOverride(70)] },
        5,
        developer,
      );
      assertEquals(denied.status, 403);
      // A developer may read the effective rules of an organization repository.
      assertEquals(
        (await send("GET", f.effectivePath(repo.repositoryId), developer))
          .status,
        200,
      );
      assertEquals(await counts(), before);
    });

    await test.step("a read never observes an uncommitted organization publication and sees it once committed", async () => {
      // Proves read-committed visibility only; the single-statement shape of
      // the read is covered by review of the SQL, not by this test.
      const current = await orgRevisionAfter();
      const entries = [
        { ...commitsEntry(false), mode: "guide" },
        titleEntry(100),
      ];
      const before = await effective();
      assertEquals(before.organizationRevision, current);
      let during: Effective | undefined;
      await withPgTransaction(runtime, async (transaction) => {
        await transaction.query(
          `insert into bakery.organization_repository_rule_versions (
             id, organization_id, revision, config, digest
           ) values ($1, $2, $3, $4::jsonb, $5)`,
          [
            crypto.randomUUID(),
            organizationAId,
            current + 1,
            JSON.stringify({ revision: current + 1, entries }),
            await ruleDigest(current + 1, entries),
          ],
        );
        during = await effective();
      });
      assertEquals(during!.organizationRevision, current);
      assertEquals(during!.digest, before.digest);
      const after = await effective();
      assertEquals(after.organizationRevision, current + 1);
      assertEquals(entry(after, "commits.semantic")?.mode, "guide");
      assertEquals(
        entry(after, "commits.semantic")?.organizationRevision,
        current + 1,
      );
    });

    await test.step("a config that could never be onboarded is refused at publication, counting multi-byte bytes", async () => {
      const big = await f.seedRepository(organizationAId);
      const ceiling = maxPublishableConfigBytes();
      const rulesFor = ballastRules;
      const under = maxFillerChars(ceiling);
      // The filler capacity (32 paths of 200 chars) must reach the ceiling.
      assert(under < 32 * 200);
      assert(configBytesWithRules(rulesFor(under)) <= ceiling);
      assert(configBytesWithRules(rulesFor(under + 1)) > ceiling);
      const publishBig = async (revision: number, chars: number) =>
        send("POST", f.profilesPath(big.repositoryId), {
          ...adminA,
          idempotencyKey: crypto.randomUUID(),
          headers: {
            "If-Match": `"${await repositoryVersion(big.repositoryId)}"`,
          },
          body: await profileBody(
            revision,
            {
              ...baseProfileConfig,
              repositoryRules: { entries: rulesFor(chars) },
            },
            await orgRevisionAfter(),
          ),
        });
      const bigCounts = () =>
        profileFactCounts(runtime, organizationAId, big.repositoryId);
      const before = await bigCounts();
      const refused = await publishBig(1, under + 1);
      assertEquals(refused.status, 422);
      const problem = await refused.json() as {
        issues?: Array<{ path: unknown[]; code: string }>;
      };
      assertEquals(problem.issues?.[0]?.path, ["config", "repositoryRules"]);
      assertEquals(problem.issues?.[0]?.code, "repository_rules_too_large");
      assertEquals(await bigCounts(), before);
      const accepted = await publishBig(1, under);
      assertEquals(accepted.status, 201, await accepted.clone().text());
    });

    await test.step("an unparsable stored active profile answers like admission, not a 500", async () => {
      const broken = await f.seedRepository(organizationAId);
      const profileId = crypto.randomUUID();
      await f.owner`
        insert into bakery.repository_profiles (
          id, organization_id, application_id, repository_id, revision, config, digest, created_by
        ) values (
          ${profileId}, ${organizationAId}, ${broken.applicationId},
          ${broken.repositoryId}, 1, '{"garbage":true}'::jsonb, ${
        "0".repeat(64)
      }, ${f.adminA.principalId}
        )`;
      await f.owner`
        update bakery.repositories set active_profile_id = ${profileId}
         where organization_id = ${organizationAId} and id = ${broken.repositoryId}`;
      const response = await send(
        "GET",
        f.effectivePath(broken.repositoryId),
        adminA,
      );
      assertEquals(response.status, 409);
      const problem = await response.json() as {
        code: string;
        reason?: string;
      };
      assertEquals(problem.code, "STATE_CONFLICT");
      assertEquals(problem.reason, "configuration_profile_unavailable");
    });
    await test.step("rules-only activation over a strict-v1 profile needs repository:manage and keeps the baseline", async () => {
      const bot = await f.createGrantOnlyBot();
      const botPublish = async (
        revision: number,
        config: Record<string, unknown>,
        expectedOrganizationRulesRevision?: number,
      ) =>
        await send("POST", profiles, {
          organizationId: organizationAId,
          authorization: bot,
          idempotencyKey: crypto.randomUUID(),
          headers: { "If-Match": `"${await repositoryVersion()}"` },
          body: await profileBody(
            revision,
            config,
            expectedOrganizationRulesRevision,
          ),
        });
      const changedBaseline = {
        branches: { base: "main", allowedPatterns: ["*"] },
        agentBindings: {
          "harness.implement": "11111111-1111-4111-8111-111111111111",
        },
      };
      const orgRevision = await orgRevisionAfter();
      const before = await counts();
      const next = () => before.profiles + 1;
      // The permission check precedes the If-Match comparisons: a stale or
      // missing If-Match tells the grant-only principal nothing (403), while an
      // Admin still gets 412 / 428.
      const ruleConfig = {
        ...baseProfileConfig,
        repositoryRules: { entries: [titleOverride(59)] },
      };
      for (
        const ifMatchHeader of [
          { "If-Match": '"999"' } as Record<string, string>,
          {} as Record<string, string>,
        ]
      ) {
        const leaked = await send("POST", profiles, {
          organizationId: organizationAId,
          authorization: bot,
          idempotencyKey: crypto.randomUUID(),
          headers: ifMatchHeader,
          body: await profileBody(next(), ruleConfig, orgRevision),
        });
        assertEquals(leaked.status, 403, JSON.stringify(ifMatchHeader));
      }
      assertEquals(
        (await createProfile(
          next(),
          { entries: [titleOverride(59)] },
          orgRevision,
          adminA,
          '"999"',
        )).status,
        412,
      );
      assertEquals(
        (await createProfile(
          next(),
          { entries: [titleOverride(59)] },
          orgRevision,
          adminA,
          null,
        )).status,
        428,
      );
      assertEquals(await counts(), before);
      // Sonnet's sequence: the grant-only principal cannot activate.
      const denied = await botPublish(
        next(),
        {
          ...baseProfileConfig,
          ...changedBaseline,
          repositoryRules: { entries: [] },
        },
        orgRevision,
      );
      assertEquals(denied.status, 403);
      assertEquals(await counts(), before);
      // An Admin (both permissions) is refused for changing the baseline...
      const retained = await createProfile(
        next(),
        { entries: [] },
        orgRevision,
        adminA,
        undefined,
        changedBaseline,
      );
      assertEquals(retained.status, 422);
      const problem = await retained.json() as {
        issues?: Array<{ code: string; message: string }>;
      };
      assertEquals(
        problem.issues?.[0]?.code,
        "repository_rules_must_retain_config",
      );
      assert(problem.issues![0].message.includes("branches"));
      assert(problem.issues![0].message.includes("agentBindings"));
      assertEquals(await counts(), before);
      // ...and allowed when only the rules change.
      const rulesOnly = await createProfile(
        next(),
        { entries: [titleOverride(61)] },
        orgRevision,
      );
      assertEquals(rulesOnly.status, 201, await rulesOnly.clone().text());
      const ruleProfile = await rulesOnly.json() as { id: string };
      assertEquals((await counts()).activeProfileId, ruleProfile.id);

      // Restore (omit the field over active overrides): the bot is denied.
      const afterRules = await counts();
      const botRestore = await botPublish(afterRules.profiles + 1, {
        ...baseProfileConfig,
      });
      assertEquals(botRestore.status, 403);
      const botRestoreNoHeader = await send("POST", profiles, {
        organizationId: organizationAId,
        authorization: bot,
        idempotencyKey: crypto.randomUUID(),
        body: await profileBody(afterRules.profiles + 1, {
          ...baseProfileConfig,
        }),
      });
      assertEquals(botRestoreNoHeader.status, 403);
      assertEquals(
        (await createProfile(
          afterRules.profiles + 1,
          undefined,
          undefined,
          adminA,
          null,
        )).status,
        428,
      );
      assertEquals(await counts(), afterRules);
      const adminRestore = await createProfile(
        afterRules.profiles + 1,
        undefined,
      );
      assertEquals(adminRestore.status, 201, await adminRestore.clone().text());
      const restored = await adminRestore.json() as {
        id: string;
        revision: number;
      };
      const restoredId = restored.id;
      assertEquals((await counts()).activeProfileId, restoredId);

      // A plain publication by the bot (no key, no active overrides) is the
      // unchanged inactive write and needs no repository:manage.
      const afterRestore = await counts();
      const plain = await botPublish(afterRestore.profiles + 1, {
        ...baseProfileConfig,
        ...changedBaseline,
      });
      assertEquals(plain.status, 201, await plain.clone().text());
      assertEquals((await counts()).activeProfileId, restoredId);
      // The effective read follows the ACTIVE profile, not the newest one.
      const latest = await plain.json() as { id: string; revision: number };
      assert(latest.revision > restored.revision);
      const read = await effective();
      assertEquals(read.profileId, restoredId);
      assertEquals(read.profileRevision, restored.revision);
    });

    await test.step("a grant revoked while a rules publication waits for the lock is refused", async () => {
      const bot = await f.createGrantOnlyBot(["repositories.update"]);
      const principalId = f.botPrincipalIds.get(bot)!;
      const botRules = async (revision: number, size: number) =>
        await send("POST", profiles, {
          organizationId: organizationAId,
          authorization: bot,
          idempotencyKey: crypto.randomUUID(),
          headers: { "If-Match": `"${await repositoryVersion()}"` },
          body: await profileBody(
            revision,
            {
              ...baseProfileConfig,
              repositoryRules: { entries: [titleOverride(size)] },
            },
            await orgRevisionAfter(),
          ),
        });
      // Control: both exact grants are honoured while they are live.
      const control = await botRules((await counts()).profiles + 1, 58);
      assertEquals(control.status, 201, await control.clone().text());
      const before = await counts();
      let pending: Promise<Response> | Response;
      await withPgTransaction(runtime, async (transaction) => {
        await lockOrganization(transaction, organizationAId);
        pending = botRules(before.profiles + 1, 57);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await f.owner`
          update bakery.permission_grants set revoked_at = now()
           where organization_id = ${organizationAId}
             and principal_id = ${principalId}
             and capability = 'repositories.update'`;
      });
      assertEquals((await pending!).status, 403);
      assertEquals(await counts(), before);
    });

    await test.step("an unparsable active profile fails closed for rules-only activation only", async () => {
      const broken = await f.seedRepository(organizationAId);
      const profileId = crypto.randomUUID();
      await f.owner`
        insert into bakery.repository_profiles (
          id, organization_id, application_id, repository_id, revision, config, digest, created_by
        ) values (
          ${profileId}, ${organizationAId}, ${broken.applicationId},
          ${broken.repositoryId}, 1, '{"garbage":true}'::jsonb, ${
        "0".repeat(64)
      },
          ${f.adminA.principalId}
        )`;
      await f.owner`
        update bakery.repositories set active_profile_id = ${profileId}
         where organization_id = ${organizationAId} and id = ${broken.repositoryId}`;
      const brokenCounts = () =>
        profileFactCounts(runtime, organizationAId, broken.repositoryId);
      const before = await brokenCounts();
      const withKey = await send("POST", f.profilesPath(broken.repositoryId), {
        ...adminA,
        idempotencyKey: crypto.randomUUID(),
        headers: {
          "If-Match": `"${await repositoryVersion(broken.repositoryId)}"`,
        },
        body: await profileBody(
          2,
          { ...baseProfileConfig, repositoryRules: { entries: [] } },
          await orgRevisionAfter(),
        ),
      });
      assertEquals(withKey.status, 409);
      const problem = await withKey.json() as { code: string; reason?: string };
      assertEquals(problem.code, "STATE_CONFLICT");
      assertEquals(problem.reason, "configuration_profile_unavailable");
      assertEquals(await brokenCounts(), before);
      // No key: today's behaviour (written, not activated).
      const plain = await send("POST", f.profilesPath(broken.repositoryId), {
        ...adminA,
        idempotencyKey: crypto.randomUUID(),
        body: await profileBody(2, { ...baseProfileConfig }),
      });
      assertEquals(plain.status, 201, await plain.clone().text());
      assertEquals((await brokenCounts()).activeProfileId, profileId);
    });
  } finally {
    await f.close();
  }
});

Deno.test("observed v2 repositories: overrides and their restore activate, plain publication is unchanged", async () => {
  const f = await openRepositoryRulesFixture();
  const harness = await openRepositoryInspectionHarness(
    { authDb: f.fixture.pgDatabase, appPg: f.runtime },
    { organizationId: f.organizationAId, principalId: f.adminA.principalId },
  );
  try {
    const rules = await f.send("POST", f.versionsPath(f.organizationAId), {
      cookie: f.cookies.adminA,
      organizationId: f.organizationAId,
      idempotencyKey: crypto.randomUUID(),
      body: {
        expectedRevision: 0,
        entries: [commitsEntry(false), titleEntry(72)],
      },
    });
    assertEquals(rules.status, 201);
    const path = (repositoryId: string) => `/v1/repositories/${repositoryId}`;
    const repoJson = async (repositoryId: string) =>
      await (await harness.memberRequest("GET", path(repositoryId))).json() as {
        version: number;
        activeProfileId: string | null;
      };
    const ifMatch = async (repositoryId: string) =>
      `"${(await repoJson(repositoryId)).version}"`;
    const activeProfile = async (repositoryId: string) =>
      (await repoJson(repositoryId)).activeProfileId;
    const publishProfile = async (
      repositoryId: string,
      revision: number,
      config: Record<string, unknown>,
      expectedOrganizationRulesRevision?: number,
      headers: Record<string, string> = {},
    ) =>
      await harness.memberRequest(
        "POST",
        `${path(repositoryId)}/profiles`,
        await profileBody(revision, config, expectedOrganizationRulesRevision),
        f.organizationAId,
        headers,
      );
    const countRows = async (repositoryId: string) =>
      (await f.runtime.query<{ profiles: string; updates: string }>(
        `select
           (select count(*) from bakery.repository_profiles
             where organization_id = $1 and repository_id = $2) as profiles,
           (select count(*) from bakery.domain_events
             where organization_id = $1 and event_type = 'repositories.updated'
               and aggregate_id = $2) as updates`,
        [f.organizationAId, repositoryId],
      )).rows[0];
    const effective = async (repositoryId: string) => {
      const body = await (await harness.memberRequest(
        "GET",
        `${path(repositoryId)}/rules`,
      )).json();
      contractSchemas.RepositoryEffectiveRules.parse(body);
      return body as Effective;
    };
    const title = (body: Effective) =>
      body.entries.find(({ ruleKey }) =>
        ruleKey === "changeRequest.semanticTitle"
      );
    const inspect = async (repositoryId: string) => {
      await harness.onboard(repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      await harness.start(assignment);
      const receipt = await receiveInspectionSource(harness, assignment);
      const report = await harness.report(assignment.input, receipt);
      const result = await harness.result(assignment, report);
      assertEquals(result.status, 200, await result.clone().text());
      const snapshot = await harness.snapshot(repositoryId, assignment.jobId);
      assertEquals(snapshot.active_profile_id, assignment.input.profile.id);
      const v2 = (snapshot.profiles as Array<{
        id: string;
        config: { schemaVersion: number; repositoryRules?: unknown };
      }>).find(({ id }) => id === assignment.input.profile.id)!;
      assertEquals(v2.config.schemaVersion, 2);
      return { assignment, v2 };
    };
    const withRules = (entries: unknown[]) => ({
      ...baseProfileConfig,
      repositoryRules: { entries },
    });
    const overrides88 = { entries: [titleOverride(88)] };

    // ---- Repository 1: overrides, onboarding, restore ----------------------
    const repository = await harness.createRepository();
    const repoId = repository.repositoryId;
    const first = await publishProfile(
      repoId,
      2,
      withRules(overrides88.entries),
      1,
      {
        "If-Match": await ifMatch(repoId),
      },
    );
    assertEquals(first.status, 201, await first.clone().text());
    const profile2 = await first.json() as { id: string };
    // Overrides activate on publication (mirrors fixedPolicy).
    assertEquals(await activeProfile(repoId), profile2.id);

    const onboarded = await inspect(repoId);
    assertEquals(onboarded.assignment.input.baseline.profileId, profile2.id);
    assertEquals(onboarded.v2.config.repositoryRules, overrides88);
    const observed = await effective(repoId);
    assertEquals(observed.profileId, onboarded.assignment.input.profile.id);
    assertEquals(title(observed)?.provenance, "repository_override");
    assertEquals(title(observed)?.options.maxSubjectLength, 88);
    const observedId = onboarded.assignment.input.profile.id;
    const revisionAfterObserved = onboarded.assignment.input.profile.revision;

    // (c) Restore refusals write nothing: omitted field and explicit empty
    // entries both need the repository If-Match while the active profile
    // carries overrides (428 missing, 412 stale).
    const beforeRefusals = await countRows(repoId);
    const refusals: Array<[string, Response]> = [
      [
        "omitted, no If-Match",
        await publishProfile(repoId, revisionAfterObserved + 1, {
          ...baseProfileConfig,
        }),
      ],
      [
        "omitted, stale",
        await publishProfile(
          repoId,
          revisionAfterObserved + 1,
          { ...baseProfileConfig },
          undefined,
          { "If-Match": '"1"' },
        ),
      ],
      [
        "empty, no If-Match",
        await publishProfile(
          repoId,
          revisionAfterObserved + 1,
          withRules([]),
          1,
        ),
      ],
      [
        "empty, stale",
        await publishProfile(
          repoId,
          revisionAfterObserved + 1,
          withRules([]),
          1,
          { "If-Match": '"1"' },
        ),
      ],
    ];
    assertEquals(
      refusals.map(([, response]) => response.status),
      [428, 412, 428, 412],
    );
    assertEquals(await countRows(repoId), beforeRefusals);
    assertEquals(await activeProfile(repoId), observedId);

    // (a) Restore by omitting the field: activates, organization entry returns.
    const restoreOmitted = await publishProfile(
      repoId,
      revisionAfterObserved + 1,
      { ...baseProfileConfig },
      undefined,
      { "If-Match": await ifMatch(repoId) },
    );
    assertEquals(
      restoreOmitted.status,
      201,
      await restoreOmitted.clone().text(),
    );
    const restored = await restoreOmitted.json() as { id: string };
    assertEquals(await activeProfile(repoId), restored.id);
    const afterRestore = await countRows(repoId);
    assertEquals(
      Number(afterRestore.updates),
      Number(beforeRefusals.updates) + 1,
    );
    const inherited = await effective(repoId);
    assertEquals(inherited.profileId, restored.id);
    assertEquals(title(inherited)?.provenance, "inherited");
    assertEquals(title(inherited)?.options.maxSubjectLength, 72);
    assertEquals(inherited.supersededOverrides, []);

    // Overrides again, immediately effective; onboarding carries them.
    const published99 = await publishProfile(
      repoId,
      revisionAfterObserved + 2,
      withRules([titleOverride(99)]),
      1,
      { "If-Match": await ifMatch(repoId) },
    );
    assertEquals(published99.status, 201, await published99.clone().text());
    const profile99 = await published99.json() as { id: string };
    assertEquals(await activeProfile(repoId), profile99.id);
    const immediate = await effective(repoId);
    assertEquals(title(immediate)?.options.maxSubjectLength, 99);
    const second = await inspect(repoId);
    assertEquals(second.assignment.input.baseline.profileId, profile99.id);
    assertEquals(second.v2.config.repositoryRules, {
      entries: [titleOverride(99)],
    });
    const settled = await effective(repoId);
    assertEquals(settled.profileId, second.assignment.input.profile.id);
    assertEquals(title(settled)?.options.maxSubjectLength, 99);
    assertEquals(settled.digest, immediate.digest);

    // (b) Restore with an explicit empty entries list from the observed v2.
    const beforeEmpty = await countRows(repoId);
    const restoreEmpty = await publishProfile(
      repoId,
      second.assignment.input.profile.revision + 1,
      withRules([]),
      1,
      { "If-Match": await ifMatch(repoId) },
    );
    assertEquals(restoreEmpty.status, 201, await restoreEmpty.clone().text());
    const emptied = await restoreEmpty.json() as { id: string };
    assertEquals(await activeProfile(repoId), emptied.id);
    assertEquals(
      Number((await countRows(repoId)).updates),
      Number(beforeEmpty.updates) + 1,
    );
    const afterEmpty = await effective(repoId);
    assertEquals(title(afterEmpty)?.provenance, "inherited");
    assertEquals(afterEmpty.digest, inherited.digest);

    // ---- Repository 2: observed v2 WITHOUT overrides -----------------------
    const plainRepository = await harness.createRepository();
    const plainId = plainRepository.repositoryId;
    const plainV2 = await inspect(plainId);
    assertEquals("repositoryRules" in plainV2.v2.config, false);
    const plainObserved = plainV2.assignment.input.profile.id;
    const plainRevision = plainV2.assignment.input.profile.revision;
    // (d) No key, active profile has no overrides: unchanged (not
    // activated, no If-Match required).
    const plain = await publishProfile(plainId, plainRevision + 1, {
      ...baseProfileConfig,
    });
    assertEquals(plain.status, 201, await plain.clone().text());
    assertEquals(await activeProfile(plainId), plainObserved);
    // (e) An explicit empty `repositoryRules` is a statement about overrides:
    // it requires the If-Match and activates even with nothing to override.
    const emptyCountBefore = await countRows(plainId);
    const emptyNoIfMatch = await publishProfile(
      plainId,
      plainRevision + 2,
      withRules([]),
      1,
    );
    assertEquals(emptyNoIfMatch.status, 428);
    assertEquals(await countRows(plainId), emptyCountBefore);
    const emptyActivated = await publishProfile(
      plainId,
      plainRevision + 2,
      withRules([]),
      1,
      {
        "If-Match": await ifMatch(plainId),
      },
    );
    assertEquals(
      emptyActivated.status,
      201,
      await emptyActivated.clone().text(),
    );
    assertEquals(
      await activeProfile(plainId),
      (await emptyActivated.json() as { id: string }).id,
    );
    assertEquals(
      Number((await countRows(plainId)).updates),
      Number(emptyCountBefore.updates) + 1,
    );

    // ---- Repository 3: a config at the publish ceiling really onboards -----
    const maximal = await harness.createRepository();
    const maximalId = maximal.repositoryId;
    const ceilingRules = ballastRules(
      maxFillerChars(maxPublishableConfigBytes()),
    );
    const maximalPublished = await publishProfile(
      maximalId,
      2,
      withRules(ceilingRules),
      1,
      { "If-Match": await ifMatch(maximalId) },
    );
    assertEquals(
      maximalPublished.status,
      201,
      await maximalPublished.clone().text(),
    );
    const maximalV2 = await inspect(maximalId);
    assertEquals(
      (maximalV2.v2.config.repositoryRules as { entries: unknown[] }).entries
        .length,
      ceilingRules.length,
    );
  } finally {
    await harness.close();
    await f.close();
  }
});

const fixedPolicyDraft = {
  schemaVersion: 1 as const,
  commands: [
    { id: "format.guide", argv: ["pnpm", "fmt"] },
    { id: "lint.warn", argv: ["pnpm", "lint"] },
    { id: "test.required", argv: ["pnpm", "test", "--filter", "policy"] },
  ],
  allowedEffects: [
    "artifact_only",
    "repository_revision",
    "evidence_only",
    "projection_only",
  ] as const,
  lockedConfiguration: { branches: true, worktree: true, checker: true },
  decisions: [
    { commandId: "format.guide", mode: "guide" as const },
    { commandId: "lint.warn", mode: "warn" as const },
    { commandId: "test.required", mode: "require" as const },
  ],
};

Deno.test("rules-only activation retains the observed baseline and fixed policy", async () => {
  const f = await openRepositoryRulesFixture();
  const harness = await openRepositoryInspectionHarness(
    { authDb: f.fixture.pgDatabase, appPg: f.runtime },
    { organizationId: f.organizationAId, principalId: f.adminA.principalId },
  );
  try {
    const rules = await f.send("POST", f.versionsPath(f.organizationAId), {
      cookie: f.cookies.adminA,
      organizationId: f.organizationAId,
      idempotencyKey: crypto.randomUUID(),
      body: {
        expectedRevision: 0,
        entries: [commitsEntry(false), titleEntry(72)],
      },
    });
    assertEquals(rules.status, 201);
    const path = (repositoryId: string) => `/v1/repositories/${repositoryId}`;
    const repoJson = async (repositoryId: string) =>
      await (await harness.memberRequest("GET", path(repositoryId))).json() as {
        version: number;
        activeProfileId: string | null;
      };
    const ifMatch = async (repositoryId: string) =>
      `"${(await repoJson(repositoryId)).version}"`;
    const publish = async (
      repositoryId: string,
      revision: number,
      config: Record<string, unknown>,
      headers?: Record<string, string>,
      expectedOrganizationRulesRevision: number | undefined = 1,
    ) =>
      await harness.memberRequest(
        "POST",
        `${path(repositoryId)}/profiles`,
        await profileBody(revision, config, expectedOrganizationRulesRevision),
        f.organizationAId,
        headers ?? { "If-Match": await ifMatch(repositoryId) },
      );
    const snapshotOf = async (repositoryId: string) =>
      (await f.runtime.query<Record<string, string | number | null>>(
        `select
           (select count(*) from bakery.repository_profiles
             where organization_id = $1 and repository_id = $2)::int as profiles,
           (select version from bakery.repositories
             where organization_id = $1 and id = $2) as version,
           (select active_profile_id from bakery.repositories
             where organization_id = $1 and id = $2) as active,
           (select count(*) from bakery.audit_events
             where organization_id = $1
               and operation = 'repositoryProfiles.create')::int as audit,
           (select count(*) from bakery.domain_events
             where organization_id = $1
               and event_type in ('repository.profile_created', 'repositories.updated')
               and aggregate_id in (
                 $2, (select id from bakery.repository_profiles
                       where organization_id = $1 and repository_id = $2 limit 1)
               ))::int as events`,
        [f.organizationAId, repositoryId],
      )).rows[0];
    const inspect = async (repositoryId: string) => {
      await harness.onboard(repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      await harness.start(assignment);
      const receipt = await receiveInspectionSource(harness, assignment);
      const report = await harness.report(assignment.input, receipt);
      const result = await harness.result(assignment, report);
      assertEquals(result.status, 200, await result.clone().text());
      return assignment;
    };
    const effective = async (repositoryId: string) => {
      const body = await (await harness.memberRequest(
        "GET",
        `${path(repositoryId)}/rules`,
      )).json();
      contractSchemas.RepositoryEffectiveRules.parse(body);
      return body as Effective;
    };
    const admitted = async (
      repositoryId: string,
      applicationId: string,
    ) => {
      const row = (await f.runtime.query<
        { id: string; revision: number; digest: string; config: unknown }
      >(
        `select p.id, p.revision, p.digest, p.config
           from bakery.repository_profiles p
           join bakery.repositories r
             on r.organization_id = p.organization_id and r.active_profile_id = p.id
          where r.organization_id = $1 and r.id = $2`,
        [f.organizationAId, repositoryId],
      )).rows[0];
      return await withPgTransaction(
        f.runtime,
        (transaction) =>
          admitRepositoryProfile(transaction, {
            organizationId: f.organizationAId,
            applicationId,
            repositoryId,
          }, row),
      );
    };
    const rulesConfig = (extra: Record<string, unknown> = {}) => ({
      ...baseProfileConfig,
      ...extra,
      repositoryRules: { entries: [titleOverride(91)] },
    });
    const refusedCode = async (response: Response) => {
      assertEquals(response.status, 422, await response.clone().text());
      const problem = await response.json() as {
        issues?: Array<{ path: unknown[]; code: string; message: string }>;
      };
      assertEquals(problem.issues?.[0]?.path, ["config"]);
      assertEquals(
        problem.issues?.[0]?.code,
        "repository_rules_must_retain_config",
      );
      return problem.issues![0].message;
    };

    // ---- Observed active profile with a fixed policy ---------------------
    const fixed = await harness.createRepository(false, {
      profileConfig: { ...baseProfileConfig, fixedPolicy: fixedPolicyDraft },
      profileHeaders: { "If-Match": '"1"' },
    });
    const fixedAssignment = await inspect(fixed.repositoryId);
    const observedFixedId = fixedAssignment.input.profile.id;
    const observedFixedRevision = fixedAssignment.input.profile.revision;
    const requiredCheck = async () => {
      const profile = await admitted(fixed.repositoryId, fixed.applicationId);
      enforceRepositoryFixedPolicy(profile, "quality.check", {
        checks: ["test.required"],
        revision: CHECK_REVISION,
      });
      let refused = false;
      try {
        enforceRepositoryFixedPolicy(profile, "quality.check", {
          checks: ["lint.warn"],
          revision: CHECK_REVISION,
        });
      } catch {
        refused = true;
      }
      assertEquals(
        refused,
        true,
        "a run omitting test.required must stay refused",
      );
    };
    await requiredCheck();

    // (1) Rules without the fixed policy would drop it: refused, nothing written.
    const before = await snapshotOf(fixed.repositoryId);
    const dropped = await publish(
      fixed.repositoryId,
      observedFixedRevision + 1,
      rulesConfig(),
    );
    assert((await refusedCode(dropped)).includes("fixedPolicy"));
    assertEquals(await snapshotOf(fixed.repositoryId), before);
    assertEquals(
      (await repoJson(fixed.repositoryId)).activeProfileId,
      observedFixedId,
    );
    await requiredCheck();
    // An explicit empty list states `repositoryRules`, so it activates and is
    // guarded the same way.
    const emptyStated = await publish(
      fixed.repositoryId,
      observedFixedRevision + 1,
      { ...baseProfileConfig, repositoryRules: { entries: [] } },
    );
    assert((await refusedCode(emptyStated)).includes("fixedPolicy"));
    assertEquals(await snapshotOf(fixed.repositoryId), before);
    // Omitting the key while the active profile has no overrides is the
    // unchanged plain publication: written, not activated.
    const omitted = await publish(
      fixed.repositoryId,
      observedFixedRevision + 1,
      { ...baseProfileConfig },
    );
    assertEquals(omitted.status, 201);
    assertEquals(
      (await repoJson(fixed.repositoryId)).activeProfileId,
      observedFixedId,
    );
    const afterPlain = await snapshotOf(fixed.repositoryId);
    const nextRevision = observedFixedRevision + 2;

    // (6) With its own fixedPolicy the request is the existing fixed-policy
    // path: no retention guard, including an unchanged-strength draft change.
    const changedDraft = {
      ...fixedPolicyDraft,
      commands: fixedPolicyDraft.commands.map((command) =>
        command.id === "test.required"
          ? { ...command, argv: [...command.argv, "changed"] }
          : command
      ),
    };
    // (2) Identical draft + baseline + rules: activated, override effective.
    const retained = await publish(
      fixed.repositoryId,
      nextRevision,
      rulesConfig({ fixedPolicy: fixedPolicyDraft }),
    );
    assertEquals(retained.status, 201, await retained.clone().text());
    const retainedId = (await retained.json() as { id: string }).id;
    assertEquals(
      (await repoJson(fixed.repositoryId)).activeProfileId,
      retainedId,
    );
    const afterRetained = await effective(fixed.repositoryId);
    assertEquals(afterRetained.profileId, retainedId);
    assertEquals(
      afterRetained.entries.find(({ ruleKey }) =>
        ruleKey === "changeRequest.semanticTitle"
      )?.provenance,
      "repository_override",
    );
    assert(afterPlain.profiles !== undefined);
    // Re-inspection derives the observed profile again; fixed-policy
    // enforcement survives it.
    await inspect(fixed.repositoryId);
    await requiredCheck();
    const changed = await publish(
      fixed.repositoryId,
      nextRevision + 2,
      rulesConfig({ fixedPolicy: changedDraft }),
    );
    assertEquals(changed.status, 201, await changed.clone().text());

    // ---- Observed active profile WITHOUT a fixed policy -------------------
    const plain = await harness.createRepository();
    const plainAssignment = await inspect(plain.repositoryId);
    const plainRevision = plainAssignment.input.profile.revision;
    const plainBefore = await snapshotOf(plain.repositoryId);
    const changedBaselines: Array<[string, Record<string, unknown>, string]> = [
      [
        "branches",
        { branches: { base: "main", allowedPatterns: ["release/*"] } },
        "branches",
      ],
      [
        "worktree",
        { worktree: { root: ".other/worktrees" } },
        "worktree",
      ],
      [
        "agentBindings",
        {
          agentBindings: {
            "harness.implement": "11111111-1111-4111-8111-111111111111",
          },
        },
        "agentBindings",
      ],
    ];
    for (const [label, change, field] of changedBaselines) {
      const message = await refusedCode(
        await publish(
          plain.repositoryId,
          plainRevision + 1,
          rulesConfig(change),
        ),
      );
      assert(message.includes(field), label);
      assertEquals(await snapshotOf(plain.repositoryId), plainBefore, label);
    }
    // (3) Every changed field is named, and only the changed ones.
    const everything = await refusedCode(
      await publish(
        plain.repositoryId,
        plainRevision + 1,
        rulesConfig({
          branches: { base: "main", allowedPatterns: ["release/*"] },
          worktree: { root: ".other/worktrees" },
          agentBindings: {
            "harness.implement": "11111111-1111-4111-8111-111111111111",
          },
        }),
      ),
    );
    for (const field of ["branches", "worktree", "agentBindings"]) {
      assert(everything.includes(field));
    }
    assert(!everything.includes("fixedPolicy"));
    assertEquals(await snapshotOf(plain.repositoryId), plainBefore);
    // A rules publication that retains the baseline is accepted and activated.
    const accepted = await publish(
      plain.repositoryId,
      plainRevision + 1,
      rulesConfig(),
    );
    assertEquals(accepted.status, 201, await accepted.clone().text());
    assertEquals(
      (await repoJson(plain.repositoryId)).activeProfileId,
      (await accepted.json() as { id: string }).id,
    );

    // (4) The service-account scenario and Opus's two-step sequence on an
    // observed fixed-policy repository.
    const fixed2 = await harness.createRepository(false, {
      profileConfig: { ...baseProfileConfig, fixedPolicy: fixedPolicyDraft },
      profileHeaders: { "If-Match": '"1"' },
    });
    const fixed2Assignment = await inspect(fixed2.repositoryId);
    const authorization = await f.createGrantOnlyBot();
    const botPublish = async (
      revision: number,
      config: Record<string, unknown>,
      expected: number | undefined,
    ) =>
      await f.send("POST", f.profilesPath(fixed2.repositoryId), {
        organizationId: f.organizationAId,
        authorization,
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": await ifMatch(fixed2.repositoryId) },
        body: await profileBody(revision, config, expected),
      });
    const fixed2Revision = fixed2Assignment.input.profile.revision;
    const botBefore = await snapshotOf(fixed2.repositoryId);
    // Rules without the fixed policy: the grant-only bot is denied outright.
    assertEquals(
      (await botPublish(fixed2Revision + 1, rulesConfig(), 1)).status,
      403,
    );
    assertEquals(await snapshotOf(fixed2.repositoryId), botBefore);
    // Step 1 (fixed-policy path): republishing the same draft over the
    // observed profile activates it. That activation now needs
    // `repository:manage` like PATCH: the create-only bot is denied (403,
    // nothing written; before this change it got 201), an Admin succeeds.
    const botStepOne = await botPublish(
      fixed2Revision + 1,
      { ...baseProfileConfig, fixedPolicy: fixedPolicyDraft },
      undefined,
    );
    assertEquals(botStepOne.status, 403);
    assertEquals(await snapshotOf(fixed2.repositoryId), botBefore);
    const stepOne = await publish(
      fixed2.repositoryId,
      fixed2Revision + 1,
      { ...baseProfileConfig, fixedPolicy: fixedPolicyDraft },
    );
    assertEquals(stepOne.status, 201, await stepOne.clone().text());
    const stepOneId = (await stepOne.json() as { id: string }).id;
    assertEquals(
      (await repoJson(fixed2.repositoryId)).activeProfileId,
      stepOneId,
    );
    // Step 2: dropping the fixed policy through a rules publication. The bot
    // is denied (403); an Admin is refused (422); nothing is written.
    const stepTwoBefore = await snapshotOf(fixed2.repositoryId);
    const stepTwoConfig = {
      ...baseProfileConfig,
      repositoryRules: { entries: [] },
    };
    assertEquals(
      (await botPublish(fixed2Revision + 2, stepTwoConfig, 1)).status,
      403,
    );
    assert(
      (await refusedCode(
        await publish(fixed2.repositoryId, fixed2Revision + 2, stepTwoConfig),
      )).includes("fixedPolicy"),
    );
    assertEquals(await snapshotOf(fixed2.repositoryId), stepTwoBefore);
    // The active profile still carries the fixed policy, and a run omitting
    // the required check is still not admitted.
    const stillFixed =
      (await f.runtime.query<{ config: { fixedPolicy?: unknown } }>(
        `select p.config from bakery.repository_profiles p
         join bakery.repositories r
           on r.organization_id = p.organization_id and r.active_profile_id = p.id
        where r.organization_id = $1 and r.id = $2`,
        [f.organizationAId, fixed2.repositoryId],
      )).rows[0].config.fixedPolicy;
    assert(stillFixed !== undefined);
    let admissible = true;
    try {
      const profile = await admitted(fixed2.repositoryId, fixed2.applicationId);
      enforceRepositoryFixedPolicy(profile, "quality.check", {
        checks: ["lint.warn"],
        revision: CHECK_REVISION,
      });
    } catch {
      admissible = false;
    }
    assertEquals(admissible, false, "omitting test.required must stay refused");

    // The pre-existing weakening: a create-only bot posting the same fixed
    // policy with every decision downgraded to "guide". Denied, nothing
    // written, the active profile unchanged; an Admin may still publish it.
    const fixed3 = await harness.createRepository(false, {
      profileConfig: { ...baseProfileConfig, fixedPolicy: fixedPolicyDraft },
      profileHeaders: { "If-Match": '"1"' },
    });
    const fixed3Assignment = await inspect(fixed3.repositoryId);
    const weaker = {
      ...fixedPolicyDraft,
      decisions: fixedPolicyDraft.decisions.map((decision) => ({
        ...decision,
        mode: "guide" as const,
      })),
    };
    const weakBefore = await snapshotOf(fixed3.repositoryId);
    const botWeaken = await f.send(
      "POST",
      f.profilesPath(fixed3.repositoryId),
      {
        organizationId: f.organizationAId,
        authorization,
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": await ifMatch(fixed3.repositoryId) },
        body: await profileBody(
          fixed3Assignment.input.profile.revision + 1,
          { ...baseProfileConfig, fixedPolicy: weaker },
        ),
      },
    );
    assertEquals(botWeaken.status, 403);
    assertEquals(await snapshotOf(fixed3.repositoryId), weakBefore);
    assertEquals(
      (await repoJson(fixed3.repositoryId)).activeProfileId,
      fixed3Assignment.input.profile.id,
    );
    // Missing or stale If-Match does not get the bot past the 403 either.
    const botNoHeader = await f.send(
      "POST",
      f.profilesPath(fixed3.repositoryId),
      {
        organizationId: f.organizationAId,
        authorization,
        idempotencyKey: crypto.randomUUID(),
        headers: { "If-Match": '"999"' },
        body: await profileBody(
          fixed3Assignment.input.profile.revision + 1,
          { ...baseProfileConfig, fixedPolicy: weaker },
        ),
      },
    );
    assertEquals(botNoHeader.status, 403);
    const adminWeaken = await publish(
      fixed3.repositoryId,
      fixed3Assignment.input.profile.revision + 1,
      { ...baseProfileConfig, fixedPolicy: weaker },
    );
    assertEquals(adminWeaken.status, 201, await adminWeaken.clone().text());

    // The default-branch-mismatch auto-activation is a replacing activation
    // too: Admin republishes the draft, Admin moves the default branch, then
    // a create-only bot posts a profile on the new branch without the fixed
    // policy (no If-Match needed on this path). Denied, nothing written.
    const fixed4 = await harness.createRepository(false, {
      profileConfig: { ...baseProfileConfig, fixedPolicy: fixedPolicyDraft },
      profileHeaders: { "If-Match": '"1"' },
    });
    const fixed4Assignment = await inspect(fixed4.repositoryId);
    const draftRepublished = await publish(
      fixed4.repositoryId,
      fixed4Assignment.input.profile.revision + 1,
      { ...baseProfileConfig, fixedPolicy: fixedPolicyDraft },
    );
    assertEquals(
      draftRepublished.status,
      201,
      await draftRepublished.clone().text(),
    );
    const moved = await harness.memberRequest(
      "PATCH",
      path(fixed4.repositoryId),
      { defaultBranch: "develop" },
      f.organizationAId,
      { "If-Match": await ifMatch(fixed4.repositoryId) },
    );
    assertEquals(moved.status, 200, await moved.clone().text());
    const developConfig = {
      ...baseProfileConfig,
      branches: { base: "develop", allowedPatterns: ["feature/*"] },
    };
    const developRevision = fixed4Assignment.input.profile.revision + 2;
    const mismatchBefore = await snapshotOf(fixed4.repositoryId);
    const activeBefore = (await repoJson(fixed4.repositoryId)).activeProfileId;
    const botDevelop = await f.send(
      "POST",
      f.profilesPath(fixed4.repositoryId),
      {
        organizationId: f.organizationAId,
        authorization,
        idempotencyKey: crypto.randomUUID(),
        body: await profileBody(developRevision, developConfig),
      },
    );
    assertEquals(botDevelop.status, 403);
    assertEquals(await snapshotOf(fixed4.repositoryId), mismatchBefore);
    assertEquals(
      (await repoJson(fixed4.repositoryId)).activeProfileId,
      activeBefore,
    );
    const adminDevelop = await harness.memberRequest(
      "POST",
      `${path(fixed4.repositoryId)}/profiles`,
      await profileBody(developRevision, developConfig),
      f.organizationAId,
    );
    assertEquals(adminDevelop.status, 201, await adminDevelop.clone().text());
    assertEquals(
      (await repoJson(fixed4.repositoryId)).activeProfileId,
      (await adminDevelop.json() as { id: string }).id,
    );

    // A first profile on a repository with no active profile is not a
    // replacement: the create-only bot still activates it (pre-existing).
    const empty = await f.seedRepository(f.organizationAId);
    const first = await f.send("POST", f.profilesPath(empty.repositoryId), {
      organizationId: f.organizationAId,
      authorization,
      idempotencyKey: crypto.randomUUID(),
      body: await profileBody(1, { ...baseProfileConfig }),
    });
    assertEquals(first.status, 201, await first.clone().text());
    assertEquals(
      (await repoJson(empty.repositoryId)).activeProfileId,
      (await first.json() as { id: string }).id,
    );
  } finally {
    await harness.close();
    await f.close();
  }
});
