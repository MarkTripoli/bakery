import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence";
import { appendMemorySourceChanged } from "../../apps/server/src/modules/knowledge/memory-source-state.ts";
import {
  admin,
  as,
  close,
  memoryOnlyReader,
  promote,
  readBoth,
  seed,
  type Seeded,
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

Deno.test("an available source reads as available, with its id, on every read", async () => {
  const seeded = await seed();
  try {
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
  } finally {
    await close(seeded);
  }
});

Deno.test("a purged source reads as deleted after the write, not as it was written", async () => {
  const seeded = await seed();
  try {
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
  } finally {
    await close(seeded);
  }
});

Deno.test("a reader without artifact version read sees no_access and no source identity", async () => {
  const seeded = await seed();
  try {
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
  } finally {
    await close(seeded);
  }
});

Deno.test("a source that is neither purged nor holding bytes reads as unknown", async () => {
  const seeded = await seed();
  try {
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
  } finally {
    await close(seeded);
  }
});

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
       and (event_type like 'memor%')
     order by organization_sequence`;
}

Deno.test("every memory write emits its content-free event in the same transaction", async () => {
  const seeded = await seed();
  try {
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
  } finally {
    await close(seeded);
  }
});

Deno.test("removing a cited source emits memory.source_changed for each memory that cites it", async () => {
  const seeded = await seed();
  try {
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
  } finally {
    await close(seeded);
  }
});
