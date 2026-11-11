import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { commentFixture } from "../helpers/artifact-comments.ts";

Deno.test("comment routes enforce closed contracts, If-Match and bounded bodies", async () => {
  const f = await commentFixture();
  try {
    const root = await f.create("root");
    const path = `/v1/artifact-comments/${root.id}`;
    assertEquals(
      (await f.request(path, { method: "PATCH", body: { resolved: true } }))
        .status,
      428,
    );
    assertEquals(
      (await f.request(path, {
        method: "PATCH",
        version: 1,
        body: { anchor: null },
      })).status,
      400,
    );
    const oversized = await f.request(
      `/v1/artifact-versions/${f.versionId}/comments`,
      { method: "POST", body: { body: "é".repeat(5121) } },
    );
    assertEquals(oversized.status, 400);
    const updated = await f.request(path, {
      method: "PATCH",
      version: 1,
      body: { resolved: true },
    });
    assertEquals(updated.status, 200);
    const result = contractSchemas.ArtifactComment.parse(await updated.json());
    assertEquals(result.status, "resolved");
    assertEquals(result.version, 2);
  } finally {
    await f.cleanup();
  }
});
