import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { openAuthFixture } from "../helpers/auth.ts";
import { cleanupSeededOrganizations } from "../helpers/coordinator-turns.ts";
import {
  addMember,
  type Fixture,
  request,
  type Seed,
  seedOrganization,
  seedTask,
} from "../helpers/durable-questions.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import {
  createFileFactsHandler,
  createFileSearchHandler,
  createLibraryFolderHandler,
  listLibraryFolder,
  nameMatch,
} from "../../apps/server/src/modules/knowledge/file-search.ts";
import {
  projectArtifactEntry,
  type StorageQuery,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";

// #453 (slice F10): permission-aware search over the file tree and the
// read-only library mirror.

const SECRET = "file-search-test-cursor-secret-0123456789";

async function withFixture(
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await openAuthFixture();
  try {
    await work(fixture);
  } finally {
    try {
      await cleanupSeededOrganizations(fixture);
    } finally {
      await fixture.close();
    }
  }
}

const db = (fixture: Fixture): StorageQuery => ({
  query: async <Row>(sql: string, params: unknown[] = []) => ({
    rows: (await fixture.pgDatabase.query(sql, params))
      .rows as unknown as Row[],
  }),
});

const hex = () =>
  (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "").slice(0, 64);

type Made = { artifactId: string; versionId: string };

/** A projected file: an artifact with one current version and a tree entry. */
async function file(
  fixture: Fixture,
  seed: Seed,
  taskId: string,
  options: {
    name: string;
    kind?: string;
    mediaType?: string;
    metadata?: Record<string, string>;
    authorId?: string;
  },
): Promise<Made> {
  const artifact = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifacts (organization_id, task_id, artifact_type, name)
     values ($1, $2, $3, $4) returning id`,
    [seed.organizationId, taskId, options.kind ?? "plan", options.name],
  );
  const version = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_versions (
       organization_id, artifact_id, task_id, author_id, revision, content,
       sha256, size_bytes, media_type, metadata
     ) values ($1, $2, $3, $4, 1, $5, $6, 3, $7, $8::jsonb) returning id`,
    [
      seed.organizationId,
      artifact.rows[0].id,
      taskId,
      options.authorId ?? seed.principalId,
      new Uint8Array([1, 2, 3]),
      hex(),
      options.mediaType ?? "text/markdown",
      JSON.stringify(options.metadata ?? {}),
    ],
  );
  await fixture.pgDatabase.query(
    `update bakery.artifacts set current_version_id = $3
      where organization_id = $1 and id = $2`,
    [seed.organizationId, artifact.rows[0].id, version.rows[0].id],
  );
  await projectArtifactEntry(db(fixture), {
    organizationId: seed.organizationId,
    artifactId: artifact.rows[0].id,
  });
  return { artifactId: artifact.rows[0].id, versionId: version.rows[0].id };
}

type Scopes = readonly string[] | undefined;

/** Runs the real search against the real database as a given caller. */
async function search(
  fixture: Fixture,
  seed: Seed,
  input: Record<string, unknown>,
  options: { library?: boolean; scopes?: Scopes; admin?: boolean } = {},
) {
  const handler = createFileSearchHandler(
    SECRET,
    () => options.library ?? true,
    () => options.admin ?? true,
  );
  return await withPgTransaction(fixture.pgDatabase, (transaction) =>
    handler(
      {
        authority: {
          organizationId: seed.organizationId,
          subject: { principalId: seed.principalId },
        },
        transaction,
        ...(options.scopes === undefined
          ? {}
          : { sessionScopes: options.scopes }),
      } as unknown as ActionContext,
      input as never,
    ));
}

/** Runs the real facts list against the real database as a given caller. */
async function facts(
  fixture: Fixture,
  seed: Seed,
  input: Record<string, unknown> = {},
  options: { scopes?: Scopes; admin?: boolean } = {},
) {
  const handler = createFileFactsHandler(() => options.admin ?? true);
  return await withPgTransaction(fixture.pgDatabase, (transaction) =>
    handler(
      {
        authority: {
          organizationId: seed.organizationId,
          subject: { principalId: seed.principalId },
        },
        transaction,
        ...(options.scopes === undefined
          ? {}
          : { sessionScopes: options.scopes }),
      } as unknown as ActionContext,
      input as never,
    ));
}

async function libraryItems(fixture: Fixture, seed: Seed, tag: string) {
  const org = seed.organizationId;
  const q = (sql: string, params: unknown[]) =>
    fixture.pgDatabase.query(sql, params);
  await q(
    `insert into bakery.skills (id, organization_id, slug, name, enabled)
     values ($1, $2, $3, $4, true), ($5, $2, $6, $7, false)`,
    [
      crypto.randomUUID(),
      org,
      `${tag}-skill`,
      `${tag} Skill`,
      crypto.randomUUID(),
      `${tag}-off`,
      `${tag} Disabled Skill`,
    ],
  );
  await q(
    `insert into bakery.agent_definitions (id, organization_id, slug, name, enabled)
     values ($1, $2, $3, $4, true)`,
    [crypto.randomUUID(), org, `${tag}-agent`, `${tag} Agent`],
  );
  const flow = crypto.randomUUID();
  const version = crypto.randomUUID();
  await q(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled)
     values ($1, $2, $3, $4, true), ($5, $2, $6, $7, true)`,
    [
      flow,
      org,
      `${tag}-flow`,
      `${tag} Workflow`,
      crypto.randomUUID(),
      `${tag}-draft`,
      `${tag} Draft Workflow`,
    ],
  );
  await q(
    `insert into bakery.workflow_versions (
       id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
       digest, status, created_by, version
     ) values ($1, $2, $3, 1, '', '{}'::jsonb, $4, 'published', $5, 1)`,
    [version, org, flow, hex(), seed.principalId],
  );
  await q(
    `update bakery.workflow_definitions set active_version_id = $3
      where organization_id = $1 and id = $2`,
    [org, flow, version],
  );
}

Deno.test("AC: search finds files by name, with the matched range and the full path", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "search-name");
    const taskId = await seedTask(fixture, seed);
    await file(fixture, seed, taskId, { name: "Release Plan.md" });
    await file(fixture, seed, taskId, { name: "notes.txt", kind: "note" });

    const page = await search(fixture, seed, { query: "PLAN" });
    assertEquals(page.items.length, 1);
    const hit = page.items[0];
    assertEquals(hit.source, "files");
    assertEquals(hit.name, "Release Plan.md");
    assertEquals([hit.nameMatchStart, hit.nameMatchLength], [8, 4]);
    assert(hit.path.startsWith("/projects/"), hit.path);
    assert(hit.path.endsWith("/Release Plan.md"), hit.path);
    assertEquals(hit.kind, "plan");
    assertEquals(hit.mediaType, "text/markdown");
    assertEquals(hit.mediaGroup, "text");
    assertEquals(hit.producerKind, "person");
    assertEquals(hit.producerId, seed.principalId);
    assert(hit.versionId !== null && hit.entryId !== null);

    // A wildcard typed by the caller is matched literally.
    assertEquals((await search(fixture, seed, { query: "%" })).items.length, 0);
    assertEquals(nameMatch("Ünï Plan", "plan"), { start: 4, length: 4 });
  }));

Deno.test("AC: search filters by kind, media type and group, producer and a metadata fact", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "search-filters");
    const taskId = await seedTask(fixture, seed);
    await file(fixture, seed, taskId, {
      name: "a.md",
      kind: "plan",
      metadata: { risk: "high" },
    });
    await file(fixture, seed, taskId, {
      name: "b.json",
      kind: "report",
      mediaType: "application/json",
      metadata: { risk: "low" },
    });
    await file(fixture, seed, taskId, {
      name: "c.png",
      kind: "image",
      mediaType: "image/png",
    });
    const names = async (input: Record<string, unknown>) =>
      (await search(fixture, seed, input)).items.map((hit) => hit.name).sort();

    assertEquals(await names({ kind: "plan" }), ["a.md"]);
    assertEquals(await names({ mediaType: "application/json" }), ["b.json"]);
    assertEquals(await names({ mediaGroup: "data" }), ["b.json"]);
    assertEquals(await names({ mediaGroup: "image" }), ["c.png"]);
    assertEquals(await names({ mediaGroup: "text" }), ["a.md"]);
    assertEquals(await names({ producerId: seed.principalId }), [
      "a.md",
      "b.json",
      "c.png",
    ]);
    assertEquals(await names({ producerId: crypto.randomUUID() }), []);
    assertEquals(await names({ factKey: "risk", factValue: "high" }), ["a.md"]);
    assertEquals(await names({ factKey: "risk", factValue: "none" }), []);
    // Filters combine.
    assertEquals(
      await names({ kind: "report", factKey: "risk", factValue: "low" }),
      ["b.json"],
    );
    assertEquals(await names({ kind: "plan", mediaGroup: "data" }), []);
  }));

Deno.test("AC: a path limits the search to a folder, and a path that is not one finds nothing", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "search-path");
    const taskA = await seedTask(fixture, seed);
    const taskB = await seedTask(fixture, seed);
    const a = await file(fixture, seed, taskA, { name: "in-a.md" });
    await file(fixture, seed, taskB, { name: "in-b.md" });
    void a;
    const folderOf = async (task: string) =>
      (await fixture.pgDatabase.query<{ path: string }>(
        `select '/projects/' || application.slug || '/artifacts/' || folder.name as path
           from bakery.storage_entries folder
           join bakery.tasks t on folder.system_key = 'task:' || t.id::text
           join bakery.applications application on application.id = t.application_id
          where folder.organization_id = $1 and t.id = $2`,
        [seed.organizationId, task],
      )).rows[0].path;
    const pathA = await folderOf(taskA);
    const pathB = await folderOf(taskB);

    const inA = await search(fixture, seed, { path: pathA });
    assertEquals(inA.items.map((hit) => hit.name), ["in-a.md"]);
    assertEquals(
      (await search(fixture, seed, { path: pathB })).items.map((hit) =>
        hit.name
      ),
      ["in-b.md"],
    );
    // A file path, a missing path and a bad path.
    assertEquals(
      (await search(fixture, seed, { path: `${pathA}/in-a.md` })).items,
      [],
    );
    assertEquals(
      (await search(fixture, seed, { path: "/nowhere/at/all" })).items,
      [],
    );
    await assertRejects(() =>
      search(fixture, seed, { path: "/projects/../x" })
    );
  }));

Deno.test("AC: the library mirror lists published items at /library/<section>/<slug>, read only", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "search-library");
    await libraryItems(fixture, seed, "mir");

    const all = await search(fixture, seed, { query: "mir" });
    const paths = all.items.map((hit) => hit.path).sort();
    assertEquals(paths, [
      "/library/agents/mir-agent",
      "/library/skills/mir-skill",
      "/library/workflows/mir-flow",
    ]);
    // A disabled skill and a workflow with no version in use are not published.
    assert(all.items.every((hit) => hit.source === "library"));
    // A library hit carries the id of the catalog item it mirrors, so a page can
    // open the item itself; a file hit has none.
    assert(
      all.items.every((hit) => typeof hit.itemId === "string"),
      "every library hit carries its catalog item's id",
    );
    assert(
      all.items.every((hit) => hit.entryId === null && hit.versionId === null),
    );
    assertEquals(
      all.items.map((hit) => hit.kind).sort(),
      ["agent", "skill", "workflow"],
    );

    // A section path and a kind each narrow it; a files-only filter excludes it.
    assertEquals(
      (await search(fixture, seed, { path: "/library/workflows" })).items.map((
        hit,
      ) => hit.path),
      ["/library/workflows/mir-flow"],
    );
    assertEquals(
      (await search(fixture, seed, { query: "mir", kind: "agent" })).items.map((
        hit,
      ) => hit.name),
      ["mir Agent"],
    );
    assertEquals(
      (await search(fixture, seed, { query: "mir", mediaGroup: "text" })).items,
      [],
    );
  }));

Deno.test("AC: reading files never reveals the library, and session scopes only narrow", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "search-permission");
    const taskId = await seedTask(fixture, seed);
    await libraryItems(fixture, seed, "perm");
    await file(fixture, seed, taskId, { name: "perm-notes.md" });

    // The caller may read files but not the library.
    const noLibrary = await search(fixture, seed, { query: "perm" }, {
      library: false,
    });
    assertEquals(noLibrary.items.map((hit) => hit.source), ["files"]);

    // An agent session holds scopes; each surface needs its own.
    const filesOnly = await search(fixture, seed, { query: "perm" }, {
      scopes: ["artifacts.read"],
    });
    assertEquals(filesOnly.items.map((hit) => hit.source), ["files"]);
    const libraryOnly = await search(fixture, seed, { query: "perm" }, {
      scopes: ["library.read"],
    });
    assert(
      libraryOnly.items.length > 0 &&
        libraryOnly.items.every((hit) => hit.source === "library"),
    );
    assertEquals(
      (await search(fixture, seed, { query: "perm" }, { scopes: [] })).items,
      [],
    );
  }));

Deno.test("AC: a search never counts or lists another organization's files or library", () =>
  withFixture(async (fixture) => {
    const mine = await seedOrganization(fixture, "search-mine");
    const theirs = await seedOrganization(fixture, "search-theirs");
    const theirTask = await seedTask(fixture, theirs);
    await file(fixture, theirs, theirTask, { name: "shared-name.md" });
    await libraryItems(fixture, theirs, "shared");

    assertEquals((await search(fixture, mine, { query: "shared" })).items, []);
    assertEquals((await search(fixture, mine, { kind: "plan" })).items, []);
    // Their own search sees them, so the empty answer above is isolation.
    assert(
      (await search(fixture, theirs, { query: "shared" })).items.length >= 2,
    );
  }));

Deno.test("AC: pages are keyset-ordered across files and library, and a cursor is bound to its filters", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "search-pages");
    const taskId = await seedTask(fixture, seed);
    for (const name of ["pg-1.md", "pg-2.md", "pg-3.md"]) {
      await file(fixture, seed, taskId, { name });
    }
    await libraryItems(fixture, seed, "pg");

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await search(fixture, seed, {
        query: "pg",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      assert(result.items.length <= 2);
      seen.push(...result.items.map((hit) => hit.path));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    assertEquals(new Set(seen).size, seen.length, "no hit is repeated");
    assertEquals(seen.length, 6);

    const first = await search(fixture, seed, { query: "pg", limit: 2 });
    assert(first.nextCursor);
    // The same cursor against a different search is refused.
    await assertRejects(() =>
      search(fixture, seed, {
        query: "other",
        limit: 2,
        cursor: first.nextCursor,
      })
    );
  }));

Deno.test("AC: a search needs a filter, and a fact needs both a key and a value", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "search-input");
    await assertRejects(() => search(fixture, seed, {}));
    await assertRejects(() => search(fixture, seed, { factKey: "risk" }));
    await assertRejects(() => search(fixture, seed, { factValue: "high" }));
  }));

Deno.test("AC: the /library folder lists only sections that have a published item, and its items by name", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "library-list");
    const empty = await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        listLibraryFolder(transaction, {
          organizationId: seed.organizationId,
          principalId: seed.principalId,
        }),
    );
    // A new organization may already hold built-in library items, so every
    // count below is relative to this baseline.
    const count = async (section: string) =>
      (await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          listLibraryFolder(transaction, {
            organizationId: seed.organizationId,
            principalId: seed.principalId,
            section,
          }),
      ))?.length ?? 0;
    const before = {
      skills: await count("skills"),
      agents: await count("agents"),
      workflows: await count("workflows"),
      kinds: await count("kinds"),
    };
    assert(empty !== undefined);

    await libraryItems(fixture, seed, "lst");
    const list = (section?: string) =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          listLibraryFolder(transaction, {
            organizationId: seed.organizationId,
            principalId: seed.principalId,
            ...(section === undefined ? {} : { section }),
          }),
      );

    const sections = await list();
    const names = sections?.map((child) => child.name) ?? [];
    for (const name of ["skills", "agents", "workflows"]) {
      assert(names.includes(name), `${name} has a published item`);
    }
    assert(sections?.every((child) => child.type === "folder"));

    // Each section gains exactly the published items this test seeded: a skill
    // and a workflow with a version in use; the disabled skill and the draft
    // workflow are not shown.
    const workflows = await list("workflows");
    assertEquals(workflows?.length, before.workflows + 1);
    assert(
      workflows?.some((child) => child.path === "/library/workflows/lst-flow"),
    );
    assert(!workflows?.some((child) => child.path.endsWith("lst-draft")));
    assertEquals((await list("skills"))?.length, before.skills + 1);
    assert(
      !(await list("skills"))?.some((child) => child.name.includes("Disabled")),
    );
    assertEquals((await list("agents"))?.length, before.agents + 1);
    // A section the mirror does not have, and one that is empty for this org.
    assertEquals(await list("nonsense"), undefined);
    assertEquals((await list("kinds"))?.length, before.kinds);

    // Another organization lists none of it.
    const other = await seedOrganization(fixture, "library-list-other");
    const theirs = await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        listLibraryFolder(transaction, {
          organizationId: other.organizationId,
          principalId: other.principalId,
          section: "workflows",
        }),
    );
    assert(
      !theirs?.some((child) => child.path === "/library/workflows/lst-flow"),
      "another organization lists none of it",
    );
  }));

Deno.test("AC: GET /v1/files/search serves the contract, library included, and refuses a search with no filter", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "search-route");
    await fixture.pgDatabase.query(
      `insert into bakery.agent_definitions (id, organization_id, slug, name, enabled)
       values ($1, $2, 'route-agent', 'Route Agent', true)`,
      [crypto.randomUUID(), seed.organizationId],
    );
    const response = await request(
      fixture,
      seed,
      "/v1/files/search?query=route",
    );
    assertEquals(response.status, 200, await response.clone().text());
    const page = await response.json() as {
      items: { source: string; path: string; name: string }[];
      nextCursor: string | null;
    };
    assertEquals(page.items.map((hit) => [hit.source, hit.path]), [
      ["library", "/library/agents/route-agent"],
    ]);
    assertEquals(page.nextCursor, null);

    const none = await request(fixture, seed, "/v1/files/search");
    assertEquals(none.status, 422, await none.clone().text());
    assert((await none.text()).includes("file_search_needs_a_filter"));
  }));

Deno.test("AC: through the route, a member with artifact:read but not library:read searches files and never sees the library", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "route-permission");
    await libraryItems(fixture, seed, "perm");
    // A custom role that can read files and nothing else.
    const reader = await addMember(fixture, seed, "files-only", "guest");
    const roleId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organization_roles
         (id, organization_id, key, name, permissions, created_by_principal_id)
       values ($1, $2, 'files-only', 'Files only', $3, $4)`,
      [roleId, seed.organizationId, ["artifact:read"], seed.principalId],
    );
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set custom_role_id = $3
        where organization_id = $1 and principal_id = $2`,
      [seed.organizationId, reader.principalId, roleId],
    );
    const names = async (identity: { cookie: string }) => {
      const response = await request(
        fixture,
        { cookie: identity.cookie, organizationId: seed.organizationId },
        "/v1/files/search?query=perm",
      );
      assertEquals(response.status, 200, await response.clone().text());
      return (await response.json() as {
        items: { source: string; path: string }[];
      }).items.map((hit) => `${hit.source}:${hit.path}`);
    };

    // The organization's owner can read the library, so the items are there to
    // be found: this is what the files-only member must not see.
    const owner = await names(seed);
    assert(
      owner.some((hit) => hit.startsWith("library:/library/agents/perm-agent")),
      `the owner finds the library items: ${owner}`,
    );
    assertEquals(
      (await names(reader)).filter((hit) => hit.startsWith("library:")),
      [],
    );
  }));

Deno.test("AC: the /library section list never shows another organization's sections", () =>
  withFixture(async (fixture) => {
    const mine = await seedOrganization(fixture, "sections-mine");
    const theirs = await seedOrganization(fixture, "sections-theirs");
    const sectionsOf = async (seed: Seed) =>
      (await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          listLibraryFolder(transaction, {
            organizationId: seed.organizationId,
            principalId: seed.principalId,
          }),
      ))?.map((child) => child.name) ?? [];

    const before = await sectionsOf(mine);
    // The other organization publishes sections this one has none of.
    await libraryItems(fixture, theirs, "other");
    const theirSections = await sectionsOf(theirs);
    const foreign = theirSections.filter((name) => !before.includes(name));
    assert(
      foreign.length > 0,
      "the other organization must add a section this one lacks",
    );

    assertEquals(await sectionsOf(mine), before);
  }));

type LibraryPage = {
  items: { type: string; path: string; name: string; kind: string | null }[];
  nextCursor: string | null;
};

Deno.test("AC: GET /v1/files/library browses /library by section, pages with a cursor bound to the path, and refuses what it should", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "library-route");
    // Five skills a second apart, so the keyset order is unambiguous.
    for (let i = 0; i < 5; i++) {
      await fixture.pgDatabase.query(
        `insert into bakery.skills (id, organization_id, slug, name, enabled, created_at)
         values ($1, $2, $3, $4, true, $5)`,
        [
          crypto.randomUUID(),
          seed.organizationId,
          `walk-${i}`,
          `Walk ${i}`,
          new Date(Date.UTC(2026, 10, 1, 12, 0, i)),
        ],
      );
    }
    const get = (query: string) =>
      request(fixture, seed, `/v1/files/library${query}`);
    const page = async (query: string) => {
      const response = await get(query);
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json() as LibraryPage;
    };

    // The root lists the sections that hold a published item, as folders.
    const root = await page("");
    assert(root.items.every((entry) => entry.type === "folder"));
    assert(root.items.some((entry) => entry.path === "/library/skills"));
    assertEquals(root.nextCursor, null);
    // A small limit never cuts the section list.
    assertEquals((await page("?limit=1")).items.length, root.items.length);

    // A section pages through its items with no gap and no repeat.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const next: LibraryPage = await page(
        `?path=/library/skills&limit=2${
          cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
        }`,
      );
      assert(next.items.length <= 2);
      seen.push(...next.items.map((entry) => entry.path));
      cursor = next.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    const walked = seen.filter((path) => path.includes("/walk-"));
    assertEquals(
      walked,
      [0, 1, 2, 3, 4].map((i) => `/library/skills/walk-${i}`),
    );
    assertEquals(new Set(seen).size, seen.length, "no item is listed twice");
    assert(pages >= 3, "the section took several pages");

    // A cursor belongs to its path: it is refused on another folder.
    const first = await page("?path=/library/skills&limit=1");
    assert(first.nextCursor !== null);
    const reused = await get(
      `?path=/library/agents&limit=1&cursor=${
        encodeURIComponent(first.nextCursor!)
      }`,
    );
    assertEquals(reused.status, 400, await reused.clone().text());

    // Only /library and its sections exist.
    for (
      const path of [
        "/library/nonsense",
        "/elsewhere",
        "/library/skills/walk-1",
      ]
    ) {
      const missing = await get(`?path=${encodeURIComponent(path)}`);
      assertEquals(
        missing.status,
        404,
        `${path}: ${await missing.clone().text()}`,
      );
    }
  }));

Deno.test("AC: /v1/files/library needs library:read, and an agent session the library.read scope", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "library-route-permission");
    await libraryItems(fixture, seed, "gate");
    // A member who can read files and nothing else.
    const reader = await addMember(
      fixture,
      seed,
      "files-only-library",
      "guest",
    );
    const roleId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organization_roles
         (id, organization_id, key, name, permissions, created_by_principal_id)
       values ($1, $2, 'files-only-lib', 'Files only', $3, $4)`,
      [roleId, seed.organizationId, ["artifact:read"], seed.principalId],
    );
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set custom_role_id = $3
        where organization_id = $1 and principal_id = $2`,
      [seed.organizationId, reader.principalId, roleId],
    );
    const denied = await request(
      fixture,
      { cookie: reader.cookie, organizationId: seed.organizationId },
      "/v1/files/library",
    );
    // Refused as not found: the platform never confirms a route the caller may not use.
    assertEquals(denied.status, 404, await denied.clone().text());
    assert(!(await denied.text()).includes("gate-agent"));

    // A session scoped to files only is refused; one with library.read is not.
    const handler = createLibraryFolderHandler(SECRET);
    const call = (scopes: Scopes) =>
      withPgTransaction(fixture.pgDatabase, (transaction) =>
        handler(
          {
            authority: {
              organizationId: seed.organizationId,
              subject: { principalId: seed.principalId },
            },
            transaction,
            ...(scopes === undefined ? {} : { sessionScopes: scopes }),
          } as unknown as ActionContext,
          { path: "/library" },
        ));
    await assertRejects(() => call(["artifacts.read"]));
    assert((await call(["library.read"])).items.length > 0);
    assert((await call(undefined)).items.length > 0);
  }));

Deno.test("AC: a library entry carries its catalog item's id, and a personal skill is listed to its owner only", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "library-personal");
    const colleague = await addMember(fixture, seed, "library-personal-b");
    const org = seed.organizationId;
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.skills
         (id, organization_id, slug, name, enabled, scope, owner_principal_id)
       values ($1, $2, 'lp-mine', 'LP Mine', true, 'personal', $3),
              ($4, $2, 'lp-theirs', 'LP Theirs', true, 'personal', $5),
              ($6, $2, 'lp-shared', 'LP Shared', true, 'organization', null)`,
      [
        mine,
        org,
        seed.principalId,
        theirs,
        colleague.principalId,
        crypto.randomUUID(),
      ],
    );
    const list = (principalId: string) =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          listLibraryFolder(transaction, {
            organizationId: org,
            principalId,
            section: "skills",
          }),
      );
    const asOwner = await list(seed.principalId);
    const asColleague = await list(colleague.principalId);
    const slugs = (entries: typeof asOwner) =>
      (entries ?? []).map((entry) => entry.path.split("/").at(-1));
    assert(slugs(asOwner).includes("lp-mine"), "the owner sees their own");
    assert(slugs(asOwner).includes("lp-shared"));
    assert(
      !slugs(asOwner).includes("lp-theirs"),
      "a colleague's personal skill is not listed",
    );
    assert(slugs(asColleague).includes("lp-theirs"));
    assert(
      !slugs(asColleague).includes("lp-mine"),
      "the owner's personal skill is not listed to a colleague",
    );
    // Each item carries the id of the catalog row it mirrors; a folder has none.
    const ownMirror = (asOwner ?? []).find((entry) =>
      entry.path.endsWith("/lp-mine")
    );
    assertEquals(ownMirror?.id, mine);
    const sections = await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        listLibraryFolder(transaction, {
          organizationId: org,
          principalId: seed.principalId,
        }),
    );
    assert(
      sections?.every((entry) => entry.type === "folder" && entry.id === null),
    );
    // A search through the mirror hides it too.
    const found = await search(
      fixture,
      { ...seed, principalId: colleague.principalId } as Seed,
      { query: "lp " },
    );
    const foundNames = found.items.map((hit) => hit.name);
    assert(foundNames.includes("LP Theirs"));
    assert(!foundNames.includes("LP Mine"), "search does not reveal it either");
    assert(foundNames.includes("LP Shared"));
  }));

Deno.test("AC: the facts list gives each key and value by kind with its file count, within the caller's reach", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "facts-mine");
    const other = await seedOrganization(fixture, "facts-theirs");
    const taskId = await seedTask(fixture, seed);
    await file(fixture, seed, taskId, {
      name: "a.md",
      kind: "plan",
      metadata: { risk: "high", team: "web" },
    });
    await file(fixture, seed, taskId, {
      name: "b.md",
      kind: "plan",
      metadata: { risk: "high" },
    });
    await file(fixture, seed, taskId, {
      name: "c.md",
      kind: "plan",
      metadata: { risk: "low" },
    });
    await file(fixture, seed, taskId, {
      name: "d.json",
      kind: "report",
      metadata: { risk: "low" },
    });
    await file(fixture, seed, taskId, { name: "e.png", kind: "image" });
    const theirTask = await seedTask(fixture, other);
    await file(fixture, other, theirTask, {
      name: "x.md",
      kind: "plan",
      metadata: { secret: "yes" },
    });

    const rows = (await facts(fixture, seed)).items.map((row) =>
      [row.kind, row.key, row.value, row.files].join("|")
    );
    assertEquals(rows, [
      "plan|risk|high|2",
      "plan|risk|low|1",
      "plan|team|web|1",
      "report|risk|low|1",
    ]);
    // One kind.
    assertEquals(
      (await facts(fixture, seed, { kind: "report" })).items.map((row) =>
        row.key
      ),
      ["risk"],
    );
    assertEquals((await facts(fixture, seed, { kind: "image" })).items, []);
    // Nothing of another organization, and theirs is theirs.
    assert(!rows.some((row) => row.includes("secret")));
    assertEquals(
      (await facts(fixture, other)).items.map((row) => row.key),
      ["secret"],
    );
    // An agent session needs the artifacts.read scope.
    assertEquals(
      (await facts(fixture, seed, {}, { scopes: ["library.read"] })).items,
      [],
    );
    assertEquals(
      (await facts(fixture, seed, {}, { scopes: ["artifacts.read"] })).items
        .length,
      4,
    );
  }));

Deno.test("AC: the facts list leaves out /system for anyone but an Admin, and is bounded", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "facts-system");
    const taskId = await seedTask(fixture, seed);
    const open = await file(fixture, seed, taskId, {
      name: "open.md",
      kind: "plan",
      metadata: { visible: "yes" },
    });
    const hidden = await file(fixture, seed, taskId, {
      name: "hidden.md",
      kind: "plan",
      metadata: { audit: "internal" },
    });
    void open;
    // Move one file under the /system folder.
    // The organization may already have its /system folder; use it if so.
    const existing = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.storage_entries
        where organization_id = $1 and parent_id is null and name_key = 'system'`,
      [seed.organizationId],
    );
    const rootId = existing.rows[0]?.id ?? (await fixture.pgDatabase.query<
      { id: string }
    >(
      `insert into bakery.storage_entries
         (organization_id, name, name_key, kind, policy, system_key)
       values ($1, 'system', 'system', 'folder', 'system', 'system') returning id`,
      [seed.organizationId],
    )).rows[0].id;
    await fixture.pgDatabase.query(
      "update bakery.storage_entries set parent_id = $3 where organization_id = $1 and artifact_id = $2",
      [seed.organizationId, hidden.artifactId, rootId],
    );
    const keys = async (admin: boolean) =>
      (await facts(fixture, seed, {}, { admin })).items.map((row) => row.key)
        .sort();
    assertEquals(await keys(true), ["audit", "visible"]);
    assertEquals(await keys(false), ["visible"]);

    // At most 50 keys of a kind, however many a file carries.
    const many = Object.fromEntries(
      Array.from(
        { length: 60 },
        (_, n) => ["key-" + String(n).padStart(2, "0"), "v"],
      ),
    );
    await file(fixture, seed, taskId, {
      name: "many.md",
      kind: "wide",
      metadata: many,
    });
    const wide = (await facts(fixture, seed, { kind: "wide" })).items;
    assertEquals(wide.length, 50);
    assertEquals(wide[0].key, "key-00");
  }));

Deno.test("AC: GET /v1/files/facts serves the contract and needs the file read permission", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "facts-route");
    const taskId = await seedTask(fixture, seed);
    await file(fixture, seed, taskId, {
      name: "r.md",
      kind: "plan",
      metadata: { risk: "high" },
    });
    const response = await request(fixture, seed, "/v1/files/facts?kind=plan");
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(await response.json(), {
      items: [{ kind: "plan", key: "risk", value: "high", files: 1 }],
      nextCursor: null,
    });
    // A member whose role cannot read files cannot list their facts.
    const blocked = await addMember(fixture, seed, "no-files", "guest");
    const roleId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organization_roles
         (id, organization_id, key, name, permissions, created_by_principal_id)
       values ($1, $2, 'no-files', 'No files', $3, $4)`,
      [roleId, seed.organizationId, ["library:read"], seed.principalId],
    );
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set custom_role_id = $3
        where organization_id = $1 and principal_id = $2`,
      [seed.organizationId, blocked.principalId, roleId],
    );
    const denied = await request(
      fixture,
      { cookie: blocked.cookie, organizationId: seed.organizationId },
      "/v1/files/facts",
    );
    assert(
      denied.status === 403 || denied.status === 404,
      String(denied.status),
    );
  }));
