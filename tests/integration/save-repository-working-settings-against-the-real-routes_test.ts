import { assert, assertEquals } from "@std/assert";
import { deriveRepositoryInspectionConfig } from "../../apps/server/src/modules/projects/repository-inspect.ts";
import { RepositoryProfileConfigSchema } from "../../packages/contracts/src/repository-profile-config.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { openCoordinationFixture } from "../helpers/coordination-fixture.ts";
import {
  type SaveApi,
  saveWorkingSettings,
} from "../../apps/web/src/pages/projects/repository-save.ts";
import {
  configDigest,
  nextRevision,
  settingsProblem,
} from "../../apps/web/src/pages/projects/repository-state.ts";

/**
 * The repository page's working-settings save (#65), through the REAL
 * production routes and a session cookie: the page's own `saveWorkingSettings`
 * runs against an adapter that sends its three calls to `productionApp.fetch`.
 * What it pins is what the page relies on of the server:
 *  - a repository's first version is put in use by the server itself (and moves
 *    the repository's version), so the page must not send its own activation
 *    with the version it held before the save;
 *  - a version whose base is not the default branch is also put in use by the
 *    server, with the same effect;
 *  - an ordinary save is put in use by the page, with the version it just read;
 *  - a version that states `repositoryRules` is refused with 428 (it needs the
 *    rules revision and a precondition the page does not hold), which the page
 *    meets by offering no save for such a repository;
 *  - a control character in a branch is a 400, which the page refuses first.
 */
Deno.test("the page's save sequence against the real routes", async () => {
  const fx = await openCoordinationFixture();
  try {
    const cookie = await fx.cookieFor(fx.admin);
    const request = async (
      method: string,
      path: string,
      options: { body?: unknown; ifMatch?: string; key?: string } = {},
    ) => {
      const headers: Record<string, string> = {
        cookie,
        origin: fx.publicBaseUrl,
        "Bakery-Organization-Id": fx.organizationId,
      };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (method !== "GET") {
        headers["Idempotency-Key"] = options.key ?? crypto.randomUUID();
      }
      if (options.ifMatch) headers["If-Match"] = options.ifMatch;
      const response = await fx.productionApp.fetch(
        new Request(`http://test${path}`, {
          method,
          headers,
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        }),
      );
      const text = await response.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text);
      } catch { /* not json */ }
      return { status: response.status, json };
    };
    const result = <T>(reply: { status: number; json: unknown }) =>
      reply.status >= 200 && reply.status < 300
        ? { ok: true as const, data: reply.json as T }
        : {
          ok: false as const,
          error: { kind: "problem", problem: { status: reply.status } },
        };
    const api = {
      createRepositoryProfile: async (o: Record<string, unknown>) =>
        result(
          await request("POST", `/v1/repositories/${o.repositoryId}/profiles`, {
            body: o.input,
            key: o.idempotencyKey as string,
          }),
        ),
      getRepository: async (o: Record<string, unknown>) =>
        result(await request("GET", `/v1/repositories/${o.id}`)),
      updateRepository: async (o: Record<string, unknown>) =>
        result(
          await request("PATCH", `/v1/repositories/${o.id}`, {
            body: o.input,
            ifMatch: o.ifMatch as string,
            key: o.idempotencyKey as string,
          }),
        ),
    } as unknown as SaveApi;

    const owner = fx.owner;
    const makeRepo = async (
      name: string,
      options: {
        defaultBranch?: string;
        profile?: Record<string, unknown> | null;
      } = {},
    ) => {
      const repositoryId = crypto.randomUUID();
      const suffix = crypto.randomUUID().slice(0, 8);
      await owner`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch, version
        ) values (${repositoryId}, ${fx.organizationId}, ${fx.applicationId}, ${crypto.randomUUID()},
          ${`owner/${name}-${suffix}`}, 'bakery-owner', ${`${name}-${suffix}`},
          ${options.defaultBranch ?? "main"}, 1)`;
      if (options.profile) {
        const profileId = crypto.randomUUID();
        await owner`
          insert into bakery.repository_profiles (
            id, organization_id, repository_id, revision, config, digest, created_by, version
          ) values (${profileId}, ${fx.organizationId}, ${repositoryId}, 1,
            ${owner.json(options.profile as never)}, ${await configDigest(
          options.profile,
        )}, ${fx.admin.principalId}, 1)`;
        await owner`
          update bakery.repositories set active_profile_id = ${profileId}, version = 2
           where organization_id = ${fx.organizationId} and id = ${repositoryId}`;
      }
      return repositoryId;
    };
    const config = (extra: Record<string, unknown> = {}, base = "main") => ({
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      branches: { base, allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
      ...extra,
    });
    const save = async (
      repositoryId: string,
      branches: string[],
    ) => {
      const repository =
        (await request("GET", `/v1/repositories/${repositoryId}`))
          .json as {
            id: string;
            defaultBranch: string;
            activeProfileId: string | null;
          };
      const listed = (await request(
        "GET",
        `/v1/repositories/${repositoryId}/profiles?limit=100`,
      )).json as { items: { id: string; revision: number; config: unknown }[] };
      const previous = listed.items.find((item) =>
        item.id === repository.activeProfileId
      ) ?? null;
      return await saveWorkingSettings(api, {
        organizationId: fx.organizationId,
        repository,
        previous: previous as never,
        revision: nextRevision(
          listed.items as never,
          (repository as { nextProfileRevision?: number }).nextProfileRevision,
        ),
        branches,
        folder: "",
        createKey: crypto.randomUUID(),
        useKey: () => crypto.randomUUID(),
      });
    };
    const activeOf = async (repositoryId: string) =>
      (await request("GET", `/v1/repositories/${repositoryId}`)).json
        ?.activeProfileId;

    // An ordinary save: the page puts the version in use, with the version it read.
    const usual = await makeRepo("usual", { profile: config() });
    const usualResult = await save(usual, ["feature/*", "release/*"]);
    assert(usualResult.ok, JSON.stringify(usualResult));
    assertEquals(usualResult.putInUseBy, "page");
    assertEquals(await activeOf(usual), usualResult.profile.id);

    // The first version of a repository: the server puts it in use itself.
    const first = await makeRepo("first", { profile: null });
    const firstResult = await save(first, ["main"]);
    assert(firstResult.ok, JSON.stringify(firstResult));
    assertEquals(firstResult.putInUseBy, "server");
    assertEquals(await activeOf(first), firstResult.profile.id);

    // A version whose base is not the repository's default branch: the same.
    const renamed = await makeRepo("renamed", {
      defaultBranch: "trunk",
      profile: config({}, "main"),
    });
    const renamedResult = await save(renamed, ["trunk"]);
    assert(renamedResult.ok, JSON.stringify(renamedResult));
    assertEquals(renamedResult.putInUseBy, "server");
    assertEquals(await activeOf(renamed), renamedResult.profile.id);

    // A repository with rules of its own: the server wants the rules revision and
    // a precondition (428), so the page offers no save for it.
    const withRules = await makeRepo("rules", {
      profile: config({ repositoryRules: { entries: [] } }),
    });
    const rulesResult = await save(withRules, ["feature/*", "hotfix/*"]);
    assertEquals(rulesResult.ok, false);
    assertEquals(
      !rulesResult.ok && rulesResult.step === "create" &&
        (rulesResult.error as { problem: { status: number } }).problem.status,
      428,
    );

    // A control character in a branch is a 400, and the page refuses it first.
    assertEquals(settingsProblem(["main\u0000x"], ""), "characters");
    const control = await makeRepo("control", { profile: config() });
    const controlResult = await save(control, ["main\u0000x"]);
    assertEquals(
      !controlResult.ok && controlResult.step === "create" &&
        (controlResult.error as { problem: { status: number } }).problem.status,
      400,
    );

    // #65: the Versions list shows what a person saved or what a passing
    // check put in use; a failed check's candidate is stored but not listed.
    const checked = await makeRepo("checked", { profile: config() });
    const candidate = async (
      revision: number,
      readiness: "eligible" | "blocked",
    ) => {
      const profileId = crypto.randomUUID();
      const candidateConfig = config({}, "main");
      (candidateConfig.branches as { allowedPatterns: string[] })
        .allowedPatterns = [`check-${revision}/*`];
      const digest = await configDigest(candidateConfig);
      await owner`
        insert into bakery.repository_profiles (
          id, organization_id, application_id, repository_id, revision, config,
          digest, created_by, version
        ) values (${profileId}, ${fx.organizationId}, ${fx.applicationId},
          ${checked}, ${revision}, ${owner.json(candidateConfig as never)},
          ${digest}, ${fx.admin.principalId}, 1)`;
      await owner`
        insert into bakery.repository_profile_observations (
          organization_id, application_id, repository_id, profile_id,
          profile_revision, profile_digest, observation_digest, observed_at,
          source_mapping_revision, source_mapping_digest, base_sha, payload,
          readiness
        ) values (${fx.organizationId}, ${fx.applicationId}, ${checked},
          ${profileId}, ${revision}, ${digest}, ${"c".repeat(64)}, now(), '1',
          ${"d".repeat(64)}, ${"e".repeat(40)}, ${owner.json({} as never)},
          ${readiness})`;
      return profileId;
    };
    const failed = await candidate(2, "blocked");
    const passed = await candidate(3, "eligible");
    const versions = (await request(
      "GET",
      `/v1/repositories/${checked}/profiles?limit=100`,
    )).json as { items: { id: string; revision: number }[] };
    assertEquals(versions.items.map((item) => item.revision), [3, 1]);
    assertEquals(versions.items[0].id, passed);
    assert(
      !versions.items.some((item) => item.id === failed),
      "a failed check's candidate is not a listed version",
    );
    // #65 (PM decision): after a check, a person can still change branches
    // and switch versions. Put the passed check's version in use first.
    await owner`
      update bakery.repositories set active_profile_id = ${passed},
        version = version + 1
       where organization_id = ${fx.organizationId} and id = ${checked}`;
    const repositoryNow = async () =>
      (await request("GET", `/v1/repositories/${checked}`)).json as {
        version: number;
        activeProfileId: string;
      };
    // A branches save from the page supersedes the check-made version.
    const afterCheck = await save(checked, ["feature/*", "after-check/*"]);
    assert(afterCheck.ok, JSON.stringify(afterCheck));
    assertEquals(await activeOf(checked), afterCheck.profile.id);
    // "Use another version" back to the passed check's version works.
    const back = await request("PATCH", `/v1/repositories/${checked}`, {
      body: { activeProfileId: passed },
      ifMatch: `"${(await repositoryNow()).version}"`,
    });
    assertEquals(back.status, 200, JSON.stringify(back.json));
    assertEquals(await activeOf(checked), passed);
    // ...and away from it again, while it is the version in use.
    const away = await request("PATCH", `/v1/repositories/${checked}`, {
      body: { activeProfileId: afterCheck.profile.id },
      ifMatch: `"${(await repositoryNow()).version}"`,
    });
    assertEquals(away.status, 200, JSON.stringify(away.json));
    // A failed check's candidate never becomes the version in use.
    const refused = await request("PATCH", `/v1/repositories/${checked}`, {
      body: { activeProfileId: failed },
      ifMatch: `"${(await repositoryNow()).version}"`,
    });
    assertEquals(refused.status, 422, JSON.stringify(refused.json));
    assertEquals(
      (refused.json as { issues: { code: string }[] }).issues[0].code,
      "profile_check_not_passed",
    );
    // #65 with a REAL check-made config (schema 2, carrying checkPolicy, as
    // deriveRepositoryInspectionConfig produces it): the page's branches save
    // drops the check-only evidence and publishes a person's version.
    const observedRepo = await makeRepo("observed", { profile: null });
    const observedConfig = deriveRepositoryInspectionConfig(
      RepositoryProfileConfigSchema.parse(config()),
      {
        organizationId: fx.organizationId,
        applicationId: fx.applicationId,
        repositoryId: observedRepo,
        source: {
          mappingRevision: "rev-1",
          mappingDigest: "a".repeat(64),
          baseSha: "b".repeat(40),
          manifestDigest: await sha256Hex(canonicalJson([])),
        },
        entries: [],
      },
    );
    assertEquals(observedConfig.schemaVersion, 2);
    assert(
      "checkPolicy" in observedConfig,
      "a check-made config carries checkPolicy",
    );
    const observedId = crypto.randomUUID();
    const observedDigest = await configDigest(observedConfig);
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, application_id, repository_id, revision, config,
        digest, created_by, version
      ) values (${observedId}, ${fx.organizationId}, ${fx.applicationId},
        ${observedRepo}, 1, ${owner.json(observedConfig as never)},
        ${observedDigest}, ${fx.admin.principalId}, 1)`;
    await owner`
      insert into bakery.repository_profile_observations (
        organization_id, application_id, repository_id, profile_id,
        profile_revision, profile_digest, observation_digest, observed_at,
        source_mapping_revision, source_mapping_digest, base_sha, payload,
        readiness
      ) values (${fx.organizationId}, ${fx.applicationId}, ${observedRepo},
        ${observedId}, 1, ${observedDigest}, ${"c".repeat(64)}, now(), 'rev-1',
        ${"a".repeat(64)}, ${"b".repeat(40)}, ${owner.json({} as never)},
        'eligible')`;
    await owner`
      update bakery.repositories set active_profile_id = ${observedId},
        version = version + 1
       where organization_id = ${fx.organizationId} and id = ${observedRepo}`;
    const observedSave = await save(observedRepo, ["feature/*", "after/*"]);
    assert(observedSave.ok, JSON.stringify(observedSave));
    assertEquals(await activeOf(observedRepo), observedSave.profile.id);
    const savedConfig = observedSave.profile.config as Record<string, unknown>;
    assertEquals(savedConfig.schemaVersion, 1);
    assertEquals("checkPolicy" in savedConfig, false);
    // qa2's case: a failed check's candidate holds the TOP revision. The list
    // hides it, so the page takes the next revision from the server's
    // nextProfileRevision; a save from max(listed) + 1 would be a 409.
    const topFailed = await makeRepo("top-failed", { profile: config() });
    {
      const profileId = crypto.randomUUID();
      const candidateConfig = config();
      (candidateConfig.branches as { allowedPatterns: string[] })
        .allowedPatterns = ["top-failed/*"];
      const digest = await configDigest(candidateConfig);
      await owner`
        insert into bakery.repository_profiles (
          id, organization_id, application_id, repository_id, revision, config,
          digest, created_by, version
        ) values (${profileId}, ${fx.organizationId}, ${fx.applicationId},
          ${topFailed}, 2, ${owner.json(candidateConfig as never)}, ${digest},
          ${fx.admin.principalId}, 1)`;
      await owner`
        insert into bakery.repository_profile_observations (
          organization_id, application_id, repository_id, profile_id,
          profile_revision, profile_digest, observation_digest, observed_at,
          source_mapping_revision, source_mapping_digest, base_sha, payload,
          readiness
        ) values (${fx.organizationId}, ${fx.applicationId}, ${topFailed},
          ${profileId}, 2, ${digest}, ${"c".repeat(64)}, now(), '1',
          ${"d".repeat(64)}, ${"e".repeat(40)}, ${owner.json({} as never)},
          'blocked')`;
    }
    const topRead = (await request("GET", `/v1/repositories/${topFailed}`))
      .json as { nextProfileRevision: number };
    assertEquals(topRead.nextProfileRevision, 3);
    const topSave = await save(topFailed, ["feature/*", "after-failed/*"]);
    assert(topSave.ok, JSON.stringify(topSave));
    assertEquals(topSave.profile.revision, 3);
    assertEquals(await activeOf(topFailed), topSave.profile.id);
    // It is still stored, for audit and the check result.
    assertEquals(
      (await owner`select count(*)::int as n from bakery.repository_profiles
        where id = ${failed}`)[0].n,
      1,
    );
  } finally {
    await fx.close();
  }
});
