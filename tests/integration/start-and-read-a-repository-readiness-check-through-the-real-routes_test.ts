import { assertEquals } from "@std/assert";
import { openCoordinationFixture } from "../helpers/coordination-fixture.ts";
import { configDigest } from "../../apps/web/src/pages/projects/repository-state.ts";

/**
 * The repository page's readiness check, through the REAL production routes
 * (#65): what starting and reading a check answers in the cases the page's
 * words rest on. Pinned: only an administrator may start one (403 otherwise);
 * a repository with no version in use, or an archived one, is a 409 (the page
 * offers neither); an unknown repository or check is a 404 (the page shows
 * "could not be loaded", never a result). The fixture has no worker, so the
 * start of a check on a ready repository answers 503 here; that is not pinned.
 */

Deno.test("starting and reading a readiness check through the real routes", async () => {
  const fx = await openCoordinationFixture();
  try {
    const cookieAdmin = await fx.cookieFor(fx.admin);
    const call = async (
      method: string,
      path: string,
      options: { body?: unknown; key?: string; cookie?: string } = {},
    ) => {
      const headers: Record<string, string> = {
        cookie: options.cookie ?? cookieAdmin,
        origin: fx.publicBaseUrl,
        "Bakery-Organization-Id": fx.organizationId,
      };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (method !== "GET") {
        headers["Idempotency-Key"] = options.key ?? crypto.randomUUID();
      }
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
      return { status: response.status, json, text: text.slice(0, 200) };
    };
    const owner = fx.owner;
    const makeRepo = async (
      name: string,
      profile: boolean,
      archived = false,
    ) => {
      const repositoryId = crypto.randomUUID();
      const suffix = crypto.randomUUID().slice(0, 8);
      await owner`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch, version
        ) values (${repositoryId}, ${fx.organizationId}, ${fx.applicationId}, ${crypto.randomUUID()},
          ${`owner/${name}-${suffix}`}, 'bakery-owner', ${`${name}-${suffix}`}, 'main', 1)`;
      if (profile) {
        const config = {
          schemaVersion: 1,
          workflow: { kind: "fixed" },
          branches: { base: "main", allowedPatterns: ["main"] },
          worktree: { root: "." },
        };
        const profileId = crypto.randomUUID();
        await owner`
          insert into bakery.repository_profiles (
            id, organization_id, repository_id, revision, config, digest, created_by, version
          ) values (${profileId}, ${fx.organizationId}, ${repositoryId}, 1,
            ${owner.json(config as never)}, ${await configDigest(
          config,
        )}, ${fx.admin.principalId}, 1)`;
        await owner`
          update bakery.repositories set active_profile_id = ${profileId}, version = 2
           where organization_id = ${fx.organizationId} and id = ${repositoryId}`;
      }
      if (archived) {
        await owner`update bakery.repositories set archived_at = now()
           where organization_id = ${fx.organizationId} and id = ${repositoryId}`;
      }
      return repositoryId;
    };
    const ok = await makeRepo("ok", true);
    const noProfile = await makeRepo("noprofile", false);
    const archived = await makeRepo("archived", true, true);
    const start = (id: string, cookie?: string) =>
      call("POST", `/v1/repositories/${id}/onboarding-runs`, {
        body: {},
        cookie,
      });
    assertEquals((await start(noProfile)).status, 409);
    assertEquals((await start(archived)).status, 409);
    assertEquals((await start(crypto.randomUUID())).status, 404);
    const member = await fx.cookieFor(fx.developer);
    assertEquals((await start(ok, member)).status, 403);
    assertEquals(
      (await call("GET", `/v1/repository-onboardings/${crypto.randomUUID()}`))
        .status,
      404,
    );
    assertEquals(
      (await call(
        "GET",
        `/v1/repository-profile-observations/${crypto.randomUUID()}`,
      ))
        .status,
      404,
    );
  } finally {
    await fx.close();
  }
});
