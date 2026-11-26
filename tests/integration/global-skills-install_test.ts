import { assert, assertEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";
import {
  bundledSkills,
  bundledSkillUpload,
} from "../../apps/server/src/modules/catalog/bundled-skills/index.ts";
import {
  commitGlobalSkillInstall,
  globalSkillId,
  type GlobalSkillInstallPreparation,
  prepareGlobalSkillInstall,
  storeGlobalSkillInstall,
} from "../../apps/server/src/modules/catalog/global-skills.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { validateLocalSkillVersion } from "../../apps/server/src/modules/catalog/validation.ts";

type Page = { items: { id: string; slug: string; scope: string }[] };

/** Calls the real app as the fixture organization's owner. */
function caller(f: Awaited<ReturnType<typeof openPersonalSkillFixture>>) {
  return (method: string, path: string, body?: unknown, ifMatch?: number) =>
    f.fixture.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers: {
          cookie: f.ownerCookie,
          "Bakery-Organization-Id": f.organizationId,
          "content-type": "application/json",
          origin: authTestOrigin,
          ...(method === "GET"
            ? {}
            : { "Idempotency-Key": crypto.randomUUID() }),
          ...(ifMatch === undefined ? {} : { "If-Match": `"${ifMatch}"` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
}

/**
 * Issue 74: Bakery's own skills are installed into an organization the first
 * time it lists its skills, as that organization's rows (scope global), pinned to
 * the digest of the bundled package, and nobody can change them.
 */
Deno.test("an organization gets Bakery's skills on its first list, once, locked and copyable", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-global-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const call = caller(f);
    const list = async (query = ""): Promise<Page> => {
      const response = await call("GET", `/v1/skills${query}`);
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json() as Page;
    };
    const rows = async (sql: string, params: unknown[] = []) =>
      (await f.fixture.pgDatabase.query<Record<string, unknown>>(sql, params))
        .rows;

    assertEquals(
      (await rows("select 1 from bakery.skills where organization_id = $1", [
        f.organizationId,
      ])).length,
      0,
      "nothing is installed before the first list",
    );

    // Two lists at once on a fresh organization install it exactly once.
    const [a, b] = await Promise.all([list(), list()]);
    assertEquals(a.items.map((s) => s.slug), ["bakery-authoring"]);
    assertEquals(b.items.map((s) => s.slug), ["bakery-authoring"]);
    assertEquals((await list("?scope=global")).items.map((s) => s.scope), [
      "global",
    ]);
    assertEquals((await list("?scope=organization")).items, []);
    await list();
    assertEquals(
      (await rows(
        "select 1 from bakery.skill_versions where organization_id = $1",
        [f.organizationId],
      )).length,
      1,
      "a later list installs nothing more",
    );

    // Bakery is the publisher; the version is the bundled package's digest.
    const [pkg] = await bundledSkills();
    const skill = a.items[0];
    const digest = (await validateLocalSkillVersion(
      await bundledSkillUpload(pkg, skill.id, 1),
      { computeDigest: true },
    )).digest;
    const installed = (await rows(
      `select version.digest, version.status, principal.display_name,
              principal.principal_type, source.publisher,
              skill.active_version_id = version.id as active
         from bakery.skills skill
         join bakery.skill_versions version
           on version.organization_id = skill.organization_id
          and version.skill_id = skill.id
         join bakery.principals principal on principal.id = version.created_by
         join bakery.skill_sources source
           on source.organization_id = skill.organization_id
          and source.id = skill.source_id
        where skill.organization_id = $1`,
      [f.organizationId],
    ))[0];
    assertEquals(installed, {
      digest,
      status: "published",
      display_name: "Bakery",
      principal_type: "service",
      publisher: "Bakery",
      active: true,
    });
    assertEquals(
      skill.id,
      await globalSkillId(f.organizationId, "bakery-authoring"),
    );
    assert(
      skill.id !== await globalSkillId(crypto.randomUUID(), "bakery-authoring"),
      "another organization's copy has another id",
    );

    // Nobody changes it, an Admin included.
    const detail = await (await call("GET", `/v1/skills/${skill.id}`))
      .json() as { version: number };
    const refused = await call("PATCH", `/v1/skills/${skill.id}`, {
      name: "Renamed",
    }, detail.version);
    assertEquals(refused.status, 403, await refused.clone().text());

    // A copy is how it is adapted: it starts from the installed version.
    const copied = await call("POST", `/v1/skills/${skill.id}/copy`, {
      name: "Our authoring guide",
      scope: "organization",
    });
    assertEquals(copied.status, 201, await copied.clone().text());
    assertEquals((await list("?scope=organization")).items.map((s) => s.slug), [
      "our-authoring-guide",
    ]);
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an organization skill that already holds the slug is not replaced by Bakery's", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-global-slug-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "bakery-authoring",
      name: "Ours",
    }, "ours");
    assertEquals(created.status, 201, await created.clone().text());
    const response = await caller(f)("GET", "/v1/skills");
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(
      (await response.json() as Page).items.map((s) => [s.slug, s.scope]),
      [["bakery-authoring", "organization"]],
    );
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("without a skill file store nothing is installed and the list still works", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const response = await caller(f)("GET", "/v1/skills");
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals((await response.json() as Page).items, []);
  } finally {
    await f.close();
  }
});

Deno.test("a skill that takes the slug between the passes is kept, and the list still works", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-global-race-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const database = f.fixture.pgDatabase;
    class PreflightRollback extends Error {}
    let preparation: GlobalSkillInstallPreparation | undefined;
    try {
      await withPgTransaction(database, async (transaction) => {
        preparation = await prepareGlobalSkillInstall({
          transaction,
          organizationId: f.organizationId,
        });
        throw new PreflightRollback();
      });
    } catch (error) {
      if (!(error instanceof PreflightRollback)) throw error;
    }
    assert(preparation !== undefined && preparation.installs.length === 1);
    const proofs = await storeGlobalSkillInstall(
      preparation,
      new SkillFileStore(root),
    );
    // An administrator takes the slug after the preflight, before the commit.
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "bakery-authoring",
      name: "Ours",
    }, "ours-race");
    assertEquals(created.status, 201, await created.clone().text());
    await withPgTransaction(
      database,
      (transaction) =>
        commitGlobalSkillInstall({
          transaction,
          preparation: preparation!,
          proofs,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
    );
    const response = await caller(f)("GET", "/v1/skills");
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(
      (await response.json() as Page).items.map((s) => [s.slug, s.scope]),
      [["bakery-authoring", "organization"]],
    );
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("rolling Bakery's skill back to an earlier package after an upgrade lists that version as active", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-global-rollback-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const call = caller(f);
    const list = async (): Promise<Page> => {
      const response = await call("GET", "/v1/skills");
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json() as Page;
    };
    const activeVersion = async () =>
      (await f.fixture.pgDatabase.query<{ revision: number; digest: string }>(
        `select version.revision, version.digest
           from bakery.skills skill
           join bakery.skill_versions version
             on version.organization_id = skill.organization_id
            and version.id = skill.active_version_id
          where skill.organization_id = $1 and skill.slug = 'bakery-authoring'`,
        [f.organizationId],
      )).rows;

    const [skill] = (await list()).items;
    const [shipped] = await bundledSkills();
    const shippedDigest = (await validateLocalSkillVersion(
      await bundledSkillUpload(shipped, skill.id, 1),
      { computeDigest: true },
    )).digest;
    assertEquals(await activeVersion(), [{
      revision: 1,
      digest: shippedDigest,
    }]);

    const upgraded = Object.freeze({
      ...shipped,
      files: shipped.files.map((file) =>
        Object.freeze({
          ...file,
          content: new TextEncoder().encode(
            new TextDecoder().decode(file.content) + "\nUpgraded.\n",
          ),
        })
      ),
    });
    class PreflightRollback extends Error {}
    let preparation: GlobalSkillInstallPreparation | undefined;
    try {
      await withPgTransaction(f.fixture.pgDatabase, async (transaction) => {
        preparation = await prepareGlobalSkillInstall({
          transaction,
          organizationId: f.organizationId,
          packages: [upgraded],
        });
        throw new PreflightRollback();
      });
    } catch (error) {
      if (!(error instanceof PreflightRollback)) throw error;
    }
    assert(preparation !== undefined && preparation.installs.length === 1);
    const proofs = await storeGlobalSkillInstall(
      preparation,
      new SkillFileStore(root),
    );
    await withPgTransaction(
      f.fixture.pgDatabase,
      (transaction) =>
        commitGlobalSkillInstall({
          transaction,
          preparation: preparation!,
          proofs,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
    );
    const [upgradedVersion] = await activeVersion();
    assertEquals(upgradedVersion.revision, 2);
    assert(upgradedVersion.digest !== shippedDigest);

    const updatedEvents = async () =>
      (await f.fixture.pgDatabase.query<{ aggregate_version: number }>(
        `select aggregate_version from bakery.domain_events
          where organization_id = $1 and aggregate_id = $2
            and event_type = 'skills.updated'`,
        [f.organizationId, skill.id],
      )).rows.length;
    const eventsBeforeRollback = await updatedEvents();
    assertEquals((await list()).items.map((s) => [s.id, s.slug]), [
      [skill.id, "bakery-authoring"],
    ]);
    assertEquals(await updatedEvents(), eventsBeforeRollback + 1);
    assertEquals(await activeVersion(), [{
      revision: 1,
      digest: shippedDigest,
    }]);
    assertEquals((await list()).items.map((s) => s.slug), ["bakery-authoring"]);
    assertEquals(await updatedEvents(), eventsBeforeRollback + 1);
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});
