import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence";
import { appendMemorySourceChanged } from "../../apps/server/src/modules/knowledge/memory-source-state.ts";
import { seedRun } from "../helpers/deterministic-checks/run-fixture.ts";
import {
  admin,
  as,
  memoryOnlyReader,
  openSuite,
  promote,
  readBoth,
  type Seeded,
  seedSource,
  type Suite,
} from "../helpers/memory-source-fixture.ts";

/**
 * Reader-relative memory source state and memory events (#72).
 *
 * The source state of a memory is judged for whoever reads it, at read time.
 * These drive the real routes: the same memory is read by an admin, who may
 * read artifact versions, and by a member whose custom role holds memory reads
 * but no artifact version read. A state computed for the writer, or stored at
 * write time, answers the second reader wrong, and the no-access assertions
 * here are the ones that catch it.
 */

async function case1(suite: Suite) {
  const seeded = await seedSource(suite);
  const created = await promote(seeded, "available source");
  assertEquals(created.sourceState, "available");
  const { entry, revisions, list } = await readBoth(
    seeded,
    admin(seeded),
    created.id,
  );
  assertEquals(entry.sourceState, "available");
  assertEquals(revisions.items[0].sourceState, "available");
  assertEquals(
    revisions.items[0].sourceArtifactVersionId,
    seeded.artifactVersionId,
  );
  assertEquals(list.items[0].sourceState, "available");
  // The current revision rides with the entry and the list row: wording, the
  // source's name and version, confidence and expiry, so a list needs no read
  // per row.
  const current = entry.currentRevision;
  assertEquals(current.id, created.currentRevisionId);
  assertEquals(current.body, "Deploys run from main.");
  assertEquals(current.sourceName, "secret-evidence-title");
  assertEquals(current.sourceRevision, 1);
  // The history names who made the wording: the creator's display name,
  // resolved on the server in one query, not left to the page.
  const creator = await seeded.fixture.fixture.pgDatabase.query<
    { display_name: string }
  >("select display_name from bakery.principals where id = $1", [
    current.createdBy,
  ]);
  assert(creator.rows[0].display_name.trim() !== "");
  assertEquals(current.createdByName, creator.rows[0].display_name);
  assertEquals(current.sourceState, entry.sourceState);
  assertEquals(current.confidence, revisions.items[0].confidence);
  assertEquals(current, revisions.items[0]);
  assertEquals(list.items[0].currentRevision, current);
}

async function case2(suite: Suite) {
  const seeded = await seedSource(suite);
  const created = await promote(seeded, "deleted source");
  assertEquals(created.sourceState, "available");
  await seeded.fixture.owner`update bakery.artifact_versions
    set content = null, blob_id = null, purged_at = now(), purge_policy = 'test'
    where id = ${seeded.artifactVersionId}`;
  const { entry, revisions, list } = await readBoth(
    seeded,
    admin(seeded),
    created.id,
  );
  assertEquals(entry.sourceState, "deleted");
  assertEquals(revisions.items[0].sourceState, "deleted");
  assertEquals(
    revisions.items[0].sourceArtifactVersionId,
    seeded.artifactVersionId,
  );
  assertEquals(list.items[0].sourceState, "deleted");
  // A purged version is still a document this reader can name; the state says
  // its content is gone.
  assertEquals(entry.currentRevision.sourceState, "deleted");
  assertEquals(entry.currentRevision.sourceName, "secret-evidence-title");
  assertEquals(entry.currentRevision.sourceRevision, 1);
}

async function case3(suite: Suite) {
  const seeded = await seedSource(suite);
  const created = await promote(seeded, "guarded source");
  // Purge it too: a no-access reader must not be able to tell deleted from
  // available, so no_access wins over what the row says.
  await seeded.fixture.owner`update bakery.artifact_versions
    set content = null, blob_id = null, purged_at = now(), purge_policy = 'test'
    where id = ${seeded.artifactVersionId}`;

  const reader = await readBoth(seeded, memoryOnlyReader(seeded), created.id);
  assertEquals(reader.entry.sourceState, "no_access");
  assertEquals(reader.list.items[0].sourceState, "no_access");
  assertEquals(reader.revisions.items[0].sourceState, "no_access");
  assertEquals(reader.revisions.items[0].sourceArtifactVersionId, null);
  // The projection leaks no more than the revision read does: no id, no name,
  // no version number for a reader who may not read artifact versions.
  for (
    const shown of [
      reader.entry.currentRevision,
      reader.list.items[0].currentRevision,
    ]
  ) {
    const revision = shown as Record<string, unknown>;
    assertEquals(revision.sourceState, "no_access");
    assertEquals(revision.sourceArtifactVersionId, null);
    assertEquals(revision.sourceName, null);
    assertEquals(revision.sourceRevision, null);
    assertEquals(revision.body, "Deploys run from main.");
  }
  // Nothing about the source leaks anywhere in any response: not the version
  // id, the artifact id, its task, or its title.
  const everything = JSON.stringify(reader);
  for (
    const secret of [
      seeded.artifactVersionId,
      seeded.artifactId,
      seeded.taskId,
      "secret-evidence-title",
    ]
  ) {
    assert(!everything.includes(secret), `leaked ${secret}`);
  }
  // The memory itself is still readable: the reader is denied the source,
  // not the memory.
  assertEquals(reader.revisions.items[0].body, "Deploys run from main.");

  // Same rows, another reader: the state belongs to the reader.
  const owner = await readBoth(seeded, admin(seeded), created.id);
  assertEquals(owner.entry.sourceState, "deleted");
  assertEquals(
    owner.revisions.items[0].sourceArtifactVersionId,
    seeded.artifactVersionId,
  );
}

/** The invariant, both directions: null id exactly when no_access. */
function assertIdInvariant(
  items: { sourceState: string; sourceArtifactVersionId: string | null }[],
) {
  assert(items.length > 0);
  for (const item of items) {
    if (item.sourceState === "no_access") {
      assertEquals(item.sourceArtifactVersionId, null, JSON.stringify(item));
    } else {
      assert(item.sourceArtifactVersionId !== null, JSON.stringify(item));
    }
  }
}

async function case4(suite: Suite) {
  const seeded = await seedSource(suite);
  const created = await promote(seeded, "mixed states");
  // A second version of the same artifact, cited by a correction, then the
  // first version purged: one page now holds a deleted and an available row.
  const second = crypto.randomUUID();
  const [author] = await seeded.fixture.owner<{ author_id: string }[]>`
    select author_id from bakery.artifact_versions where id = ${seeded.artifactVersionId}`;
  await seeded.fixture
    .owner`insert into bakery.artifact_versions (id, organization_id, artifact_id, task_id, author_id, revision, metadata, content, sha256, size_bytes, media_type)
    values (${second}, ${seeded.organizationId}, ${seeded.artifactId}, ${seeded.taskId}, ${author.author_id}, 2, '{}'::jsonb, ${new Uint8Array(
    [2],
  )}, ${"b".repeat(64)}, 1, 'text/plain')`;
  const corrected = await as(
    seeded,
    admin(seeded),
    "POST",
    `/v1/memories/${created.id}/revisions`,
    {
      content: "Corrected from the second version.",
      reason: "newer evidence",
      sourceArtifactVersionId: second,
    },
  );
  assertEquals(corrected.status, 201, await corrected.clone().text());
  await seeded.fixture.owner`update bakery.artifact_versions
    set content = null, blob_id = null, purged_at = now(), purge_policy = 'test'
    where id = ${seeded.artifactVersionId}`;

  const owner = await readBoth(seeded, admin(seeded), created.id);
  assertEquals(
    owner.revisions.items.map((item: { sourceState: string }) =>
      item.sourceState
    ).sort(),
    ["available", "deleted"],
  );
  assertIdInvariant(owner.revisions.items);

  const reader = await readBoth(seeded, memoryOnlyReader(seeded), created.id);
  assertEquals(
    reader.revisions.items.map((item: { sourceState: string }) =>
      item.sourceState
    ),
    ["no_access", "no_access"],
  );
  assertIdInvariant(reader.revisions.items);
}

async function case5(suite: Suite) {
  const seeded = await seedSource(suite);
  const created = await promote(seeded, "unknown source");
  await seeded.fixture.owner`update bakery.artifact_versions
    set content = null, blob_id = null, purged_at = null
    where id = ${seeded.artifactVersionId}`;
  const { entry, revisions } = await readBoth(
    seeded,
    admin(seeded),
    created.id,
  );
  assertEquals(entry.sourceState, "unknown");
  assertEquals(revisions.items[0].sourceState, "unknown");
  assertIdInvariant(revisions.items);
}

type EventRow = {
  event_type: string;
  aggregate_id: string;
  aggregate_version: number;
  repository_id: string | null;
  payload: Record<string, unknown>;
};

async function memoryEvents(seeded: Seeded): Promise<EventRow[]> {
  return await seeded.fixture.owner<EventRow[]>`
    select event_type, aggregate_id, aggregate_version, repository_id, payload
      from bakery.domain_events
     where organization_id = ${seeded.organizationId}
       -- Scoped to this case's repository: the suite is shared, and every
       -- memory event carries its repository.
       and repository_id = ${seeded.repositoryId}
       and (event_type like 'memor%')
     order by organization_sequence`;
}

async function case6(suite: Suite) {
  const seeded = await seedSource(suite);
  const created = await promote(seeded, "evented");
  const revised = await as(
    seeded,
    admin(seeded),
    "POST",
    `/v1/memories/${created.id}/revisions`,
    {
      content: "Deploys run from release branches.",
      reason: "the process changed",
      sourceArtifactVersionId: seeded.artifactVersionId,
    },
  );
  assertEquals(revised.status, 201, await revised.clone().text());
  const afterRevision = await (await as(
    seeded,
    admin(seeded),
    "GET",
    `/v1/memories/${created.id}`,
  )).json();
  const updated = await as(
    seeded,
    admin(seeded),
    "PATCH",
    `/v1/memories/${created.id}`,
    { subject: "evented, renamed" },
    { "If-Match": `"${afterRevision.version}"` },
  );
  assertEquals(updated.status, 200, await updated.clone().text());
  const finalVersion = (await updated.json()).version;

  // A refused write emits nothing: a second promotion on the same topic
  // conflicts, and no event may claim it happened.
  const refused = await as(seeded, admin(seeded), "POST", "/v1/memories", {
    repositoryId: seeded.repositoryId,
    subject: "evented, renamed",
    content: "x",
    provenance: {
      sourceArtifactVersionId: seeded.artifactVersionId,
      repositoryId: seeded.repositoryId,
      conflictScan: { verdict: "clean", conflictingMemoryIds: [] },
      confidence: 0.9,
      reviewPolicy: "on_source_change",
    },
  });
  assertEquals(refused.status, 409);

  const events = await memoryEvents(seeded);
  assertEquals(
    events.map((event) => [event.event_type, event.aggregate_version]),
    [
      ["memories.created", created.version],
      ["memory.revised", afterRevision.version],
      ["memories.updated", finalVersion],
    ],
  );
  for (const event of events) {
    assertEquals(event.aggregate_id, created.id);
    // Scoped to the repository, so a repository subscriber receives it.
    assertEquals(event.repository_id, seeded.repositoryId);
    // An invalidation only: the reader re-fetches through the routes.
    assertEquals(Object.keys(event.payload).sort(), [
      "resourceId",
      "resourceVersion",
    ]);
    assertEquals(event.payload.resourceId, created.id);
  }
}

async function case7(suite: Suite) {
  const seeded = await seedSource(suite);
  const first = await promote(seeded, "cites the source");
  const second = await promote(seeded, "also cites the source");
  const emitted = await withPgTransaction(
    seeded.fixture.runtime,
    async (transaction) => {
      return await appendMemorySourceChanged(transaction, {
        organizationId: seeded.organizationId,
        versionId: seeded.artifactVersionId,
        traceId: crypto.randomUUID(),
      });
    },
  );
  assertEquals(emitted, 2);
  const changed = (await memoryEvents(seeded)).filter((event) =>
    event.event_type === "memory.source_changed"
  );
  assertEquals(
    changed.map((event) => event.aggregate_id).sort(),
    [first.id, second.id].sort(),
  );
  for (const event of changed) {
    assertEquals(event.repository_id, seeded.repositoryId);
    assertEquals(Object.keys(event.payload).sort(), [
      "resourceId",
      "resourceVersion",
    ]);
  }
}

/**
 * A reader who holds artifactVersion:read is still denied a version the artifact
 * version reads would not reach. Here the version names a run step of another
 * task's run, which artifactVersions.list filters out; the memory must say
 * no_access and withhold the id, exactly as it does for a reader with no
 * permission at all.
 */
async function caseUnreachableForAPermittedReader(suite: Suite) {
  const seeded = await seedSource(suite);
  const ownerDb = seeded.fixture.fixture.pgDatabase;
  const otherRun = await seedRun(ownerDb, {
    organizationId: seeded.organizationId,
    principalId: seeded.fixture.adminA.principalId,
  });
  assert(otherRun.taskId !== seeded.taskId, "the run belongs to another task");
  const unreachable = crypto.randomUUID();
  const [author] = await seeded.fixture.owner<{ author_id: string }[]>`
    select author_id from bakery.artifact_versions where id = ${seeded.artifactVersionId}`;
  await seeded.fixture
    .owner`insert into bakery.artifact_versions (id, organization_id, artifact_id, task_id, run_step_id, author_id, revision, metadata, content, sha256, size_bytes, media_type)
    values (${unreachable}, ${seeded.organizationId}, ${seeded.artifactId}, ${seeded.taskId}, ${otherRun.stepId}, ${author.author_id}, 2, '{}'::jsonb, ${new Uint8Array(
    [3],
  )}, ${"c".repeat(64)}, 1, 'text/plain')`;

  // The artifact version reads hide it from this reader: that is the rule the
  // memory's state has to follow.
  const versions = await as(
    seeded,
    admin(seeded),
    "GET",
    `/v1/artifacts/${seeded.artifactId}/versions`,
  );
  assertEquals(versions.status, 200, await versions.clone().text());
  const listed = (await versions.json()).items.map((item: { id: string }) =>
    item.id
  );
  assert(
    listed.includes(seeded.artifactVersionId),
    "the reachable version is listed",
  );
  assert(
    !listed.includes(unreachable),
    "artifactVersions.list hides the unreachable version",
  );

  const response = await as(seeded, admin(seeded), "POST", "/v1/memories", {
    repositoryId: seeded.repositoryId,
    subject: "unreachable source",
    content: "Cited from a version this reader cannot reach.",
    provenance: {
      sourceArtifactVersionId: unreachable,
      repositoryId: seeded.repositoryId,
      conflictScan: { verdict: "clean", conflictingMemoryIds: [] },
      confidence: 0.9,
      reviewPolicy: "on_source_change",
    },
  });
  assertEquals(response.status, 201, await response.clone().text());
  const created = await response.json() as { id: string };

  const { entry, revisions, list } = await readBoth(
    seeded,
    admin(seeded),
    created.id,
  );
  assertEquals(entry.sourceState, "no_access");
  assertEquals(list.items[0].sourceState, "no_access");
  assertEquals(revisions.items[0].sourceState, "no_access");
  assertEquals(revisions.items[0].sourceArtifactVersionId, null);
  assertIdInvariant(revisions.items);
  assert(
    !JSON.stringify({ entry, revisions, list }).includes(unreachable),
    "the unreachable id never appears",
  );
}

// One fixture for the file: one schema reset in and one out, rather than one
// pair per case (see the suite in memory-source-fixture.ts).
Deno.test("memory source state is judged per reader, and every memory write emits its event", async (t) => {
  const suite = await openSuite();
  try {
    await t.step(
      "an available source reads as available, with its id, on every read",
      () => case1(suite),
    );
    await t.step(
      "a purged source reads as deleted after the write, not as it was written",
      () => case2(suite),
    );
    await t.step(
      "a reader without artifact version read sees no_access and no source identity",
      () => case3(suite),
    );
    await t.step(
      "a revision list with mixed states names the id exactly when the state is not no_access",
      () => case4(suite),
    );
    await t.step(
      "a source that is neither purged nor holding bytes reads as unknown",
      () => case5(suite),
    );
    await t.step(
      "every memory write emits its content-free event in the same transaction",
      () => case6(suite),
    );
    await t.step(
      "removing a cited source emits memory.source_changed for each memory that cites it",
      () => case7(suite),
    );
    await t.step(
      "a reader who may read artifact versions sees no_access for a version the artifact reads would not reach",
      () => caseUnreachableForAPermittedReader(suite),
    );
  } finally {
    await suite.close();
  }
});
