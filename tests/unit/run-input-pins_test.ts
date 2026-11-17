import { assertEquals } from "@std/assert";
import { declaredArtifactVersionIds } from "../../apps/server/src/modules/work/run-input-pins.ts";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "33333333-3333-4333-8333-333333333333";

Deno.test("declared artifact versions are found at any depth and deduplicated", () => {
  const inputs = {
    brief: { artifactVersionId: V1 },
    context: [
      { artifactVersionId: V2 },
      { nested: { deeper: { artifactVersionId: V1 } } },
      { artifactVersionId: V2 },
    ],
  };
  assertEquals(declaredArtifactVersionIds(inputs), [V1, V2]);
});

Deno.test("a version key with a non-string value is not a declaration", () => {
  assertEquals(
    declaredArtifactVersionIds({
      artifactVersionId: 42,
      other: { artifactVersionId: null },
    }),
    [],
  );
});

Deno.test("unrelated keys never read as a declaration", () => {
  assertEquals(
    declaredArtifactVersionIds({
      artifactId: V1,
      artifactVersionID: V2,
      nested: [{ artifact_version_id: V3 }],
    }),
    [],
  );
});

Deno.test("inputs with no declaration pin nothing", () => {
  assertEquals(declaredArtifactVersionIds(undefined), []);
  assertEquals(declaredArtifactVersionIds(null), []);
  assertEquals(declaredArtifactVersionIds("plain string"), []);
  assertEquals(declaredArtifactVersionIds({ description: "no versions" }), []);
});
