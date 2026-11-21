import { assert, assertEquals } from "@std/assert";
import {
  admin,
  as,
  close,
  memoryOnlyReader,
  promote,
  readBoth,
  seed,
} from "../helpers/memory-source-fixture.ts";

/**
 * The memory read shape against a reader who may read memory but not artifact
 * versions (#72). Every memory read route is walked, and the whole response is
 * searched for anything that identifies the source: the version, its
 * artifact, its task and its title. The state is judged per reader, so the
 * same memory read by an admin still names its source.
 */
Deno.test("memory reads leak no source identity to a reader without artifact version read", async () => {
  const seeded = await seed();
  try {
    const created = await promote(seeded, "guarded");
    const corrected = await as(
      seeded,
      admin(seeded),
      "POST",
      `/v1/memories/${created.id}/revisions`,
      {
        content: "Corrected.",
        reason: "second revision cites the same source",
        sourceArtifactVersionId: seeded.artifactVersionId,
      },
    );
    assertEquals(corrected.status, 201, await corrected.clone().text());

    const reader = await readBoth(seeded, memoryOnlyReader(seeded), created.id);
    assertEquals(reader.revisions.items.length, 2);
    for (const revision of reader.revisions.items) {
      assertEquals(revision.sourceState, "no_access");
      assertEquals(revision.sourceArtifactVersionId, null);
    }
    assertEquals(reader.entry.sourceState, "no_access");
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

    // The reader cannot reach the source directly either: the artifact read
    // answers as if it did not exist, which is the rule the null id follows.
    const direct = await as(
      seeded,
      memoryOnlyReader(seeded),
      "GET",
      `/v1/artifacts/${seeded.artifactId}/versions`,
    );
    assertEquals(direct.status, 404, await direct.clone().text());

    const owner = await readBoth(seeded, admin(seeded), created.id);
    for (const revision of owner.revisions.items) {
      assertEquals(revision.sourceState, "available");
      assertEquals(revision.sourceArtifactVersionId, seeded.artifactVersionId);
    }
  } finally {
    await close(seeded);
  }
});
