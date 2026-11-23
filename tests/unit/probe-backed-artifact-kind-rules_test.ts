/**
 * The three rule types only the sandboxed probe can answer (chapter 25 section
 * 17.5, O29): probedMediaType, maxPixels and maxDurationSeconds.
 *
 * Each is judged on what the probe measured, never on what the publisher
 * declared, and never in the publish transaction: `validateArtifactKindDocument`
 * skips them, and `validateProbedArtifactKindDocument` runs only them.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type ArtifactKindDefinition,
  artifactKindDefinitionDefects,
  ArtifactKindDefinitionSchema,
  hasProbeBackedRules,
  validateArtifactKindDocument,
  validateProbedArtifactKindDocument,
} from "../../packages/contracts/src/artifact-kinds.ts";
import type { ArtifactProbeReport } from "../../packages/contracts/src/artifact-probe.ts";

function kind(rules: unknown[]): ArtifactKindDefinition {
  return ArtifactKindDefinitionSchema.parse({
    key: "render",
    name: "Render",
    description: "A rendered still or cut.",
    text: false,
    facts: [],
    rules,
  });
}

const png = (width: number, height: number): ArtifactProbeReport => ({
  status: "described",
  kind: "image",
  mediaType: "image/png",
  byteLength: 100,
  width,
  height,
});

const video = (durationMs?: number): ArtifactProbeReport => ({
  status: "described",
  kind: "video",
  mediaType: "video/mp4",
  byteLength: 100,
  ...(durationMs === undefined ? {} : { durationMs }),
});

const rule = (type: string, options: Record<string, unknown>) => ({
  type,
  severity: "require",
  options,
});

Deno.test("probedMediaType passes the detected type and fails another one", () => {
  const definition = kind([
    rule("probedMediaType", { mediaTypes: ["image/png"] }),
  ]);
  assertEquals(validateProbedArtifactKindDocument(definition, png(2, 2)), []);
  const findings = validateProbedArtifactKindDocument(definition, {
    ...png(2, 2),
    mediaType: "image/gif",
  });
  assertEquals(findings.length, 1);
  assertEquals(findings[0].ruleType, "probedMediaType");
  assertEquals(findings[0].unavailable, false);
  assert(findings[0].message.includes("image/gif"));
});

Deno.test("maxPixels passes at the bound, fails over it, and is unavailable for a non-image", () => {
  const definition = kind([rule("maxPixels", { value: 16 })]);
  assertEquals(validateProbedArtifactKindDocument(definition, png(4, 4)), []);
  const over = validateProbedArtifactKindDocument(definition, png(4, 5));
  assertEquals(over.length, 1);
  assertEquals(over[0].ruleType, "maxPixels");
  assertEquals(over[0].unavailable, false);
  const notImage = validateProbedArtifactKindDocument(definition, video(1000));
  assertEquals(notImage.length, 1);
  assertEquals(notImage[0].unavailable, true);
  // An image the probe could not measure is not a pass either.
  const unmeasured = validateProbedArtifactKindDocument(definition, {
    status: "described",
    kind: "image",
    mediaType: "image/webp",
    byteLength: 10,
  });
  assertEquals(unmeasured[0].unavailable, true);
});

Deno.test("maxDurationSeconds passes at the bound, fails over it, and is unavailable without a duration", () => {
  const definition = kind([rule("maxDurationSeconds", { value: 3 })]);
  assertEquals(validateProbedArtifactKindDocument(definition, video(3000)), []);
  const over = validateProbedArtifactKindDocument(definition, video(3001));
  assertEquals(over.length, 1);
  assertEquals(over[0].ruleType, "maxDurationSeconds");
  assertEquals(over[0].unavailable, false);
  assertEquals(
    validateProbedArtifactKindDocument(definition, video())[0].unavailable,
    true,
  );
  assertEquals(
    validateProbedArtifactKindDocument(definition, png(1, 1))[0].unavailable,
    true,
  );
});

Deno.test("a warn probe-backed rule records its finding at warn severity", () => {
  const definition = kind([{
    type: "maxPixels",
    severity: "warn",
    options: { value: 1 },
  }]);
  const findings = validateProbedArtifactKindDocument(definition, png(2, 2));
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, "warn");
});

Deno.test("the publish-time interpreter never judges a probe-backed rule", () => {
  const definition = kind([
    rule("probedMediaType", { mediaTypes: ["image/png"] }),
    rule("maxPixels", { value: 1 }),
    rule("maxDurationSeconds", { value: 1 }),
    rule("nonEmpty", {}),
  ]);
  assert(hasProbeBackedRules(definition));
  // A declared type the probe rule would refuse is not refused here: the probe
  // has not answered, so the only verdict is the non-probe rules'.
  const findings = validateArtifactKindDocument(definition, {
    content: new Uint8Array([1]),
    mediaType: "application/octet-stream",
    facts: {},
  });
  assertEquals(findings, []);
  // Only probe-backed rules run on the probe answer.
  assertEquals(
    validateProbedArtifactKindDocument(kind([rule("nonEmpty", {})]), png(9, 9)),
    [],
  );
  assertEquals(hasProbeBackedRules(kind([rule("nonEmpty", {})])), false);
});

Deno.test("each probe-backed rule requires exactly its one option", () => {
  const defects = (rules: unknown[]) =>
    artifactKindDefinitionDefects(kind(rules)).map((defect) => defect.code);
  assertEquals(defects([rule("maxPixels", {})]), ["rule_value_required"]);
  assertEquals(defects([rule("maxDurationSeconds", {})]), [
    "rule_value_required",
  ]);
  assertEquals(defects([rule("probedMediaType", {})]), [
    "rule_media_types_required",
  ]);
  assertEquals(
    defects([rule("maxPixels", { value: 4, mediaTypes: ["image/png"] })]),
    ["rule_media_types_unexpected"],
  );
  assertEquals(
    defects([rule("probedMediaType", { mediaTypes: ["image/png"], value: 1 })]),
    ["rule_value_unexpected"],
  );
});
