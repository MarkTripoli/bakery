import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import {
  assertRetained,
  retentionFixture,
} from "../helpers/artifact-retention.ts";

for (const mutation of [{ resolved: true }, { deleted: true }]) {
  Deno.test(`open root protects expired content until ${Object.keys(mutation)[0]}`, async () => {
    // Given an expired version on a terminal task with an open root and reply.
    const fixture = await retentionFixture();
    const request = (path: string, method: string, body: unknown) =>
      fixture.app.fetch(
        new Request(`${fixture.config.publicBaseUrl}${path}`, {
          method,
          headers: {
            cookie: fixture.adminCookie,
            "bakery-organization-id": fixture.organizationId,
            "content-type": "application/json",
            origin: fixture.config.publicBaseUrl,
            "idempotency-key": crypto.randomUUID(),
            "if-match": '"2"',
          },
          body: JSON.stringify(body),
        }),
      );
    try {
      const path = `/v1/artifact-versions/${fixture.versionId}/comments`;
      const created = await request(path, "POST", { body: "Review this" });
      assertEquals(created.status, 201);
      const root = contractSchemas.ArtifactComment.parse(await created.json());
      const reply = await request(path, "POST", {
        body: "Remaining reply",
        rootId: root.id,
      });
      assertEquals(reply.status, 201);
      assertEquals(
        await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
        false,
      );
      await assertRetained(fixture);

      // When the root stops protecting the version through the public API.
      const updated = await request(
        `/v1/artifact-comments/${root.id}`,
        "PATCH",
        mutation,
      );
      assertEquals(updated.status, 200);

      // Then collection succeeds despite the retained thread metadata.
      assertEquals(
        await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
        true,
      );
      const content = await fixture.request(
        `/v1/artifact-versions/${fixture.versionId}/content`,
      );
      assertEquals(content.status, 410);
      assertEquals((await content.json()).code, "ARTIFACT_CONTENT_EXPIRED");
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.artifact_comments where organization_id=$1",
        [fixture.organizationId],
      );
      await fixture.closeRetention();
    }
  });
}
