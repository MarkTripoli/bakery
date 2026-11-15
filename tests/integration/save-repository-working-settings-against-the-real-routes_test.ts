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
  folderOf,
  nextRevision,
  settingsProblem,
} from "../../apps/web/src/pages/projects/repository-state.ts";
import { overrideOf, titleEntry } from "../helpers/repository-rules-fixture.ts";

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
 *  - a version in use that carries rules of its own is saved with
 *    `keepRepositoryRules` and the repository version as If-Match: the server
 *    copies the rules into the new version, puts it in use itself, and refuses
 *    a save that changes anything but the branches (422) or is stale (412);
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
            ifMatch: o.ifMatch as string | undefined,
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
      over: { folder?: string; repositoryVersion?: number } = {},
    ) => {
      const repository =
        (await request("GET", `/v1/repositories/${repositoryId}`))
          .json as {
            id: string;
            defaultBranch: string;
            version: number;
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
        repository: over.repositoryVersion === undefined
          ? repository
          : { ...repository, version: over.repositoryVersion },
        previous: previous as never,
        revision: nextRevision(
          listed.items as never,
          (repository as { nextProfileRevision?: number }).nextProfileRevision,
        ),
        branches,
        // The sheet starts from the version in use's folder and keeps it.
        folder: over.folder ?? folderOf(previous?.config),
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

    // A repository with rules of its own: the page's save keeps them
    // (`keepRepositoryRules`, the repository version as If-Match). The server
    // copies the rules into the new version and puts it in use itself.
    const rules = {
      entries: [{ ...overrideOf(titleEntry(72)), mode: "require" }],
    };
    const withRules = await makeRepo("rules", {
      profile: config({ repositoryRules: rules }),
    });
    const rulesResult = await save(withRules, ["feature/*", "hotfix/*"]);
    assert(rulesResult.ok, JSON.stringify(rulesResult));
    assertEquals(rulesResult.putInUseBy, "server");
    assertEquals(await activeOf(withRules), rulesResult.profile.id);
    const keptConfig = rulesResult.profile.config as Record<string, unknown>;
    assertEquals(
      (keptConfig.branches as { allowedPatterns: string[] }).allowedPatterns,
      ["feature/*", "hotfix/*"],
    );
    assertEquals(keptConfig.repositoryRules, rules);
    assertEquals(
      (keptConfig.worktree as { root: string }).root,
      ".bakery/worktrees",
    );
    // The carried version carries them on: a second save keeps them again.
    const again = await save(withRules, ["feature/*"]);
    assert(again.ok, JSON.stringify(again));
    assertEquals(again.putInUseBy, "server");
    assertEquals(
      (again.profile.config as Record<string, unknown>).repositoryRules,
      rules,
    );
    // Nothing but the branches may change: a different folder is a 422.
    const folderRefused = await save(withRules, ["feature/*"], {
      folder: "elsewhere",
    });
    assertEquals(folderRefused.ok, false);
    assertEquals(
      !folderRefused.ok && folderRefused.step === "create" &&
        (folderRefused.error as { problem: { status: number } }).problem
          .status,
      422,
    );
    // A stale repository version is a 412, and nothing is saved.
    const staleRefused = await save(withRules, ["feature/*"], {
      repositoryVersion: 1,
    });
    assertEquals(staleRefused.ok, false);
    assertEquals(
      !staleRefused.ok && staleRefused.step === "create" &&
        (staleRefused.error as { problem: { status: number } }).problem.status,
      412,
    );
    assertEquals(await activeOf(withRules), again.profile.id);
    // An explicit "no rules" (`entries: []`) carries nothing: the server does
    // not put the new version in use, so the page does, and nothing states rules.
    const noEntries = await makeRepo("no-entries", {
      profile: config({ repositoryRules: { entries: [] } }),
    });
    const noEntriesResult = await save(noEntries, ["feature/*", "hotfix/*"]);
    assert(noEntriesResult.ok, JSON.stringify(noEntriesResult));
    assertEquals(noEntriesResult.putInUseBy, "page");
    assertEquals(await activeOf(noEntries), noEntriesResult.profile.id);

    // A fixed policy fixes what a *publication* may change, not which recorded
    // version a person may put in use: the server allows switching to a version
    // with other branches, so the page keeps "Use version" on those rows
    // (design-ux, #475 review). A policy that also carried rules still refuses
    // to publish new branches (the sheet's fixed-branches view).
    const policyFixed = await makeRepo("policy-fixed", {
      profile: config({
        fixedPolicy: {
          lockedConfiguration: {
            branches: true,
            worktree: true,
            checker: true,
          },
        },
      }),
    });
    const otherBranches = crypto.randomUUID();
    const otherConfig = config();
    (otherConfig.branches as { allowedPatterns: string[] }).allowedPatterns = [
      "recorded/*",
    ];
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, application_id, repository_id, revision, config,
        digest, created_by, version
      ) values (${otherBranches}, ${fx.organizationId}, ${fx.applicationId},
        ${policyFixed}, 2, ${owner.json(otherConfig as never)},
        ${await configDigest(otherConfig)}, ${fx.admin.principalId}, 1)`;
    const fixedNow = (await request("GET", `/v1/repositories/${policyFixed}`))
      .json as { version: number };
    const usedUnderPolicy = await request(
      "PATCH",
      `/v1/repositories/${policyFixed}`,
      {
        body: { activeProfileId: otherBranches },
        ifMatch: `"${fixedNow.version}"`,
      },
    );
    assertEquals(
      usedUnderPolicy.status,
      200,
      JSON.stringify(usedUnderPolicy.json),
    );
    assertEquals(await activeOf(policyFixed), otherBranches);
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
