import { assert, assertEquals } from "@std/assert";
import { openAuthFixture } from "../helpers/auth.ts";
import { cleanupSeededOrganizations } from "../helpers/coordinator-turns.ts";
import {
  type Fixture,
  type Seed,
  seedOrganization,
  seedTask,
} from "../helpers/durable-questions.ts";
import {
  ensureOrganizationTree,
  ensureWorkItemFolder,
  pinStoragePath,
  projectArtifactEntry,
  resolveStoragePath,
  type StorageQuery,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";
import { storageEntriesBackfill } from "../../apps/server/src/modules/knowledge/migrations/data/0232_storage_entries.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../packages/persistence/src/postgres.ts";
import { readDatabaseConfig } from "../../packages/config/src/env.ts";

// #444 (slice F2): entries, the default layout, and existing artifacts shown
// under their work items with no data moved.

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

/** Runs one statement as the owner role, which may rename and move entries. */
async function asOwner(sql: string, params: unknown[]): Promise<void> {
  const database = openDatabase(
    readDatabaseConfig(Deno.env.toObject(), "owner").url,
    1,
  );
  try {
    await database.unsafe(sql, params as never[]);
  } finally {
    await closeDatabase(database);
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

/** An artifact with one current version, written the way publication does. */
async function artifact(
  fixture: Fixture,
  seed: Seed,
  taskId: string,
  name: string,
  artifactType = "plan",
) {
  const inserted = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifacts (organization_id, task_id, artifact_type, name)
     values ($1, $2, $3, $4) returning id`,
    [seed.organizationId, taskId, artifactType, name],
  );
  const artifactId = inserted.rows[0].id;
  const sha = hex();
  const version = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_versions (
       organization_id, artifact_id, task_id, author_id, revision, content,
       sha256, size_bytes, media_type
     ) values ($1, $2, $3, $4, 1, $5, $6, 3, 'text/markdown') returning id`,
    [
      seed.organizationId,
      artifactId,
      taskId,
      seed.principalId,
      new Uint8Array([1, 2, 3]),
      sha,
    ],
  );
  await fixture.pgDatabase.query(
    `update bakery.artifacts set current_version_id = $3
      where organization_id = $1 and id = $2`,
    [seed.organizationId, artifactId, version.rows[0].id],
  );
  return { artifactId, versionId: version.rows[0].id, sha };
}

const slugOf = async (fixture: Fixture, seed: Seed) =>
  (await fixture.pgDatabase.query<{ slug: string }>(
    `select slug from bakery.applications where id = $1`,
    [seed.applicationId],
  )).rows[0].slug;

const entryCount = async (fixture: Fixture, seed: Seed) =>
  Number(
    (await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.storage_entries where organization_id = $1`,
      [seed.organizationId],
    )).rows[0].n,
  );

Deno.test("AC: the default layout is made once and repeating it changes nothing", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "tree-default");
    const first = await ensureOrganizationTree(
      db(fixture),
      seed.organizationId,
    );
    assertEquals(
      [...first.keys()],
      [
        "projects",
        "shared",
        "library",
        "users",
        "connections",
        "trash",
        "system",
      ],
    );
    const before = await entryCount(fixture, seed);
    const second = await ensureOrganizationTree(
      db(fixture),
      seed.organizationId,
    );
    assertEquals([...second.entries()], [...first.entries()]);
    assertEquals(await entryCount(fixture, seed), before);

    // The area policies of section 17.1 are on the folders.
    const policies = await fixture.pgDatabase.query<
      { name: string; policy: string; kind: string }
    >(
      `select name, policy, kind from bakery.storage_entries
        where organization_id = $1 and parent_id is null order by name`,
      [seed.organizationId],
    );
    const byName = Object.fromEntries(
      policies.rows.map((row) => [row.name, row.policy]),
    );
    assertEquals(byName.projects, "record");
    assertEquals(byName.shared, "working");
    assertEquals(byName.users, "personal");
    assertEquals(byName.system, "system");
    assert(policies.rows.every((row) => row.kind === "folder"));
  }));

Deno.test("AC: an existing artifact appears under its work item and no data moves", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "tree-project");
    const taskId = await seedTask(fixture, seed);
    const made = await artifact(fixture, seed, taskId, "plan.md");

    // Fingerprint everything projection must not touch.
    const fingerprint = async () =>
      (await fixture.pgDatabase.query<{ digest: string }>(
        `select md5(string_agg(a.id::text || a.name || coalesce(a.current_version_id::text,'')
                  || a.revision::text, ',' order by a.id) || '|' ||
                coalesce((select string_agg(v.id::text || v.sha256 || v.size_bytes::text,
                                            ',' order by v.id)
                            from bakery.artifact_versions v
                           where v.organization_id = $1), '')) as digest
           from bakery.artifacts a where a.organization_id = $1`,
        [seed.organizationId],
      )).rows[0].digest;
    const before = await fingerprint();

    const entryId = await projectArtifactEntry(db(fixture), {
      organizationId: seed.organizationId,
      artifactId: made.artifactId,
    });
    assert(entryId, "an entry was made");
    assertEquals(await fingerprint(), before);

    const slug = await slugOf(fixture, seed);
    const folder = (await fixture.pgDatabase.query<{ name: string }>(
      `select name from bakery.storage_entries
        where organization_id = $1 and system_key = $2`,
      [seed.organizationId, `task:${taskId}`],
    )).rows[0].name;
    const path = `/projects/${slug}/artifacts/${folder}/plan.md`;
    const resolved = await resolveStoragePath(db(fixture), {
      organizationId: seed.organizationId,
      path,
    });
    assertEquals(resolved?.id, entryId);
    assertEquals(resolved?.artifactId, made.artifactId);
    assertEquals(resolved?.kind, "file");

    // The work item's folder carries attachments and runs.
    for (const child of ["attachments", "runs"]) {
      const found = await resolveStoragePath(db(fixture), {
        organizationId: seed.organizationId,
        path: `/projects/${slug}/artifacts/${folder}/${child}`,
      });
      assertEquals(found?.kind, "folder");
    }

    // Projecting again is a no-op.
    const count = await entryCount(fixture, seed);
    assertEquals(
      await projectArtifactEntry(db(fixture), {
        organizationId: seed.organizationId,
        artifactId: made.artifactId,
      }),
      entryId,
    );
    assertEquals(await entryCount(fixture, seed), count);
  }));

Deno.test("AC: two artifacts whose names collide are both kept", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "tree-collide");
    const taskId = await seedTask(fixture, seed);
    const a = await artifact(fixture, seed, taskId, "Plan.md", "plan");
    const b = await artifact(fixture, seed, taskId, "plan.MD", "design");
    const first = await projectArtifactEntry(db(fixture), {
      organizationId: seed.organizationId,
      artifactId: a.artifactId,
    });
    const second = await projectArtifactEntry(db(fixture), {
      organizationId: seed.organizationId,
      artifactId: b.artifactId,
    });
    assert(first && second && first !== second);
    const names = (await fixture.pgDatabase.query<{ name: string }>(
      `select name from bakery.storage_entries
        where organization_id = $1 and artifact_id is not null order by name`,
      [seed.organizationId],
    )).rows.map((row) => row.name);
    assertEquals(names, ["Plan.md", "plan.MD (design)"]);
  }));

Deno.test("AC: the backfill projects every existing artifact once and touches no artifact data", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "tree-backfill");
    const taskId = await seedTask(fixture, seed);
    for (const name of ["a.md", "b.md", "c.md"]) {
      await artifact(fixture, seed, taskId, name);
    }
    assertEquals(await entryCount(fixture, seed), 0);

    const database = openDatabase(
      readDatabaseConfig(Deno.env.toObject(), "owner").url,
      1,
    );
    const connection = await database.reserve();
    try {
      assertEquals(
        await storageEntriesBackfill.run(connection, { maxBatches: 5 }),
        true,
      );
      const files = Number(
        (await fixture.pgDatabase.query<{ n: string }>(
          `select count(*)::text as n from bakery.storage_entries
          where organization_id = $1 and kind = 'file'`,
          [seed.organizationId],
        )).rows[0].n,
      );
      assertEquals(files, 3);
      const total = await entryCount(fixture, seed);
      // A second run finds nothing missing and writes nothing.
      assertEquals(
        await storageEntriesBackfill.run(connection, { maxBatches: 5 }),
        true,
      );
      assertEquals(await entryCount(fixture, seed), total);
    } finally {
      connection.release();
      await closeDatabase(database);
    }
  }));

Deno.test("AC: a path resolves to an entry, and a pin names the version, not the path", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "tree-pin");
    const taskId = await seedTask(fixture, seed);
    const made = await artifact(fixture, seed, taskId, "script.md");
    const entryId = await projectArtifactEntry(db(fixture), {
      organizationId: seed.organizationId,
      artifactId: made.artifactId,
    });
    const slug = await slugOf(fixture, seed);
    const folderId = await ensureWorkItemFolder(db(fixture), {
      organizationId: seed.organizationId,
      taskId,
    });
    const folderName = (await fixture.pgDatabase.query<{ name: string }>(
      `select name from bakery.storage_entries where id = $1`,
      [folderId],
    )).rows[0].name;
    // Case and Unicode form do not matter when resolving.
    const path =
      `/PROJECTS/${slug.toUpperCase()}/Artifacts/${folderName}/Script.MD`;
    const pin = await pinStoragePath(db(fixture), {
      organizationId: seed.organizationId,
      path,
    });
    assert(pin, "the path pins");
    assertEquals(pin.entryId, entryId);
    assertEquals(pin.artifactId, made.artifactId);
    assertEquals(pin.versionId, made.versionId);
    assertEquals(pin.sha256, made.sha);
    assertEquals(pin.label, path);

    // Move the entry to /shared as the owner role would (renames arrive with
    // the working areas): the pin taken before still names the same entry,
    // version and digest, the old path no longer resolves, and the new one pins
    // the same thing. A path is a name, not an identity.
    const shared = (await ensureOrganizationTree(
      db(fixture),
      seed.organizationId,
    )).get("shared")!;
    await asOwner(
      `update bakery.storage_entries set parent_id = $2, name = 'Moved.md',
              name_key = 'moved.md' where id = $1`,
      [entryId, shared],
    );
    assertEquals(
      await resolveStoragePath(db(fixture), {
        organizationId: seed.organizationId,
        path,
      }),
      undefined,
    );
    const moved = await pinStoragePath(db(fixture), {
      organizationId: seed.organizationId,
      path: "/shared/moved.md",
    });
    assertEquals(
      [moved?.entryId, moved?.artifactId, moved?.versionId, moved?.sha256],
      [pin.entryId, pin.artifactId, pin.versionId, pin.sha256],
    );
  }));

Deno.test("AC: a path never resolves another organization's entry", () =>
  withFixture(async (fixture) => {
    const mine = await seedOrganization(fixture, "tree-mine");
    const theirs = await seedOrganization(fixture, "tree-theirs");
    const taskId = await seedTask(fixture, theirs);
    const made = await artifact(fixture, theirs, taskId, "secret.md");
    await projectArtifactEntry(db(fixture), {
      organizationId: theirs.organizationId,
      artifactId: made.artifactId,
    });
    const slug = await slugOf(fixture, theirs);
    const folderName = (await fixture.pgDatabase.query<{ name: string }>(
      `select name from bakery.storage_entries
        where organization_id = $1 and system_key = $2`,
      [theirs.organizationId, `task:${taskId}`],
    )).rows[0].name;
    const path = `/projects/${slug}/artifacts/${folderName}/secret.md`;

    assertEquals(
      (await resolveStoragePath(db(fixture), {
        organizationId: theirs.organizationId,
        path,
      }))?.kind,
      "file",
    );
    // The same path in another organization resolves to nothing, and so does a
    // pin; an entry of theirs is never reachable by an id of mine.
    assertEquals(
      await resolveStoragePath(db(fixture), {
        organizationId: mine.organizationId,
        path,
      }),
      undefined,
    );
    assertEquals(
      await pinStoragePath(db(fixture), {
        organizationId: mine.organizationId,
        path,
      }),
      undefined,
    );
  }));

Deno.test("AC: a path-like artifact name becomes nested folders and resolves by that path", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "tree-pathlike");
    const taskId = await seedTask(fixture, seed);
    // The name transcripts really use: output-transcript/<session>/manifest.
    const name = `output-transcript/${crypto.randomUUID()}/manifest`;
    const made = await artifact(fixture, seed, taskId, name, "log");
    const entryId = await projectArtifactEntry(db(fixture), {
      organizationId: seed.organizationId,
      artifactId: made.artifactId,
    });
    const slug = await slugOf(fixture, seed);
    const folder = (await fixture.pgDatabase.query<{ name: string }>(
      `select name from bakery.storage_entries
        where organization_id = $1 and system_key = $2`,
      [seed.organizationId, `task:${taskId}`],
    )).rows[0].name;
    const resolved = await resolveStoragePath(db(fixture), {
      organizationId: seed.organizationId,
      path: `/projects/${slug}/artifacts/${folder}/${name}`,
    });
    assertEquals(resolved?.id, entryId);
    assertEquals(resolved?.name, "manifest");
    // Its parents are folders.
    const parents = await fixture.pgDatabase.query<{ kind: string }>(
      `select kind from bakery.storage_entries
        where id = $1 or id = (select parent_id from bakery.storage_entries where id = $1)`,
      [entryId],
    );
    assertEquals(parents.rows.map((row) => row.kind).sort(), [
      "file",
      "folder",
    ]);
  }));

Deno.test("AC: a name the tree refuses is made safe and kept, never failing the write it rides on", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "tree-odd-names");
    const taskId = await seedTask(fixture, seed);
    const odd = [
      "   ",
      "..",
      "a//b",
      "tab\tname",
      "/leading",
      "trailing/",
      "x".repeat(300),
    ];
    const ids: string[] = [];
    for (const name of odd) {
      const made = await artifact(fixture, seed, taskId, name, "plan");
      const id = await projectArtifactEntry(db(fixture), {
        organizationId: seed.organizationId,
        artifactId: made.artifactId,
      });
      assert(id, `an entry was made for ${JSON.stringify(name.slice(0, 20))}`);
      ids.push(id);
    }
    assertEquals(new Set(ids).size, odd.length);
    // Every artifact has exactly one entry.
    const files = Number(
      (await fixture.pgDatabase.query<{ n: string }>(
        `select count(*)::text as n from bakery.storage_entries
        where organization_id = $1 and kind = 'file'`,
        [seed.organizationId],
      )).rows[0].n,
    );
    assertEquals(files, odd.length);
  }));

Deno.test("AC: renaming an application and reusing its old slug never fails an artifact write", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "tree-slug-reuse");
    const taskA = await seedTask(fixture, seed);
    const slug = await slugOf(fixture, seed);
    const artifactA = await artifact(fixture, seed, taskA, "a.md");
    const entryA = await projectArtifactEntry(db(fixture), {
      organizationId: seed.organizationId,
      artifactId: artifactA.artifactId,
    });
    assert(entryA, "application A's artifact is projected under its slug");

    // A is renamed, and a new application B takes the old slug.
    await asOwner(
      `update bakery.applications set slug = $2 where id = $1`,
      [seed.applicationId, `${slug}-renamed`],
    );
    const applicationB = crypto.randomUUID();
    const conversationB = crypto.randomUUID();
    const taskB = crypto.randomUUID();
    await asOwner(
      `insert into bakery.applications (id, organization_id, slug, name, description)
       values ($1, $2, $3, 'B', '')`,
      [applicationB, seed.organizationId, slug],
    );
    await asOwner(
      `insert into bakery.conversations (id, organization_id, application_id, title, created_by, created_at, updated_at, version)
       values ($1, $2, $3, 'B', $4, now(), now(), 1)`,
      [conversationB, seed.organizationId, applicationB, seed.principalId],
    );
    await asOwner(
      `insert into bakery.tasks (id, organization_id, application_id, conversation_id, title, description, task_type, status, created_by)
       values ($1, $2, $3, $4, 'B work', '', 'feature', 'queued', $5)`,
      [
        taskB,
        seed.organizationId,
        applicationB,
        conversationB,
        seed.principalId,
      ],
    );
    const artifactB = await artifact(fixture, seed, taskB, "b.md");

    // The write that used to throw: B's artifact must still get an entry.
    const entryB = await projectArtifactEntry(db(fixture), {
      organizationId: seed.organizationId,
      artifactId: artifactB.artifactId,
    });
    assert(entryB, "application B's artifact is projected");
    assert(entryB !== entryA);

    // Each project folder is keyed by its application id, so both exist, under
    // different names; the slug is only a display name.
    const folders = await fixture.pgDatabase.query<
      { name: string; systemKey: string }
    >(
      `select name, system_key as "systemKey" from bakery.storage_entries
        where organization_id = $1 and system_key in ($2, $3)
        order by system_key`,
      [
        seed.organizationId,
        `project:${seed.applicationId}`,
        `project:${applicationB}`,
      ],
    );
    assertEquals(folders.rows.length, 2);
    assert(folders.rows[0].name !== folders.rows[1].name);
    const taken = folders.rows.map((row) => row.name.toLowerCase());
    assert(taken.includes(slug.toLowerCase()), "one project keeps the slug");
  }));
