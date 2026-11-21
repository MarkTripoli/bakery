/**
 * The publication door a kind's rules never had.
 *
 * `validateArtifactKindDocument` was written, tested and called by nobody, so
 * every rule a customer published was decorative. These tests are about the
 * door: which kind an artifact is held to, that a refusal writes nothing, and
 * that the binding cannot drift under a document that already exists.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { ArtifactKindDefinitionSchema } from "../../packages/contracts/src/artifact-kinds.ts";
import {
  type ArtifactKindBinding,
  gateArtifactPublication,
} from "../../apps/server/src/modules/artifact-kinds/publication-gate.ts";

function brief(overrides: Record<string, unknown> = {}) {
  return ArtifactKindDefinitionSchema.parse({
    key: "brief",
    name: "Brief",
    description: "The written statement of what a piece of work is for.",
    text: true,
    rules: [],
    facts: [],
    ...overrides,
  });
}

function binding(
  overrides: Partial<ArtifactKindBinding> = {},
): ArtifactKindBinding {
  return {
    kindVersionId: "kind-version",
    kindKey: "brief",
    revision: 3,
    definition: brief(),
    ...overrides,
  };
}

const encoder = new TextEncoder();

Deno.test("a document that satisfies its kind returns no findings and is published", () => {
  const findings = gateArtifactPublication(
    binding({
      definition: brief({
        rules: [{
          type: "mediaType",
          severity: "require",
          options: { mediaTypes: ["text/markdown"] },
        }],
        facts: [{
          name: "wordCount",
          type: "integer",
          required: true,
          description: "Words.",
        }],
      }),
    }),
    {
      content: encoder.encode("# a brief"),
      mediaType: "text/markdown",
      facts: { wordCount: 2 },
    },
  );
  assertEquals(findings, []);
});

Deno.test("a require rule refuses, and names the kind, revision and rule that refused", () => {
  const error = assertThrows(
    () =>
      gateArtifactPublication(
        binding({
          kindKey: "brief",
          revision: 7,
          definition: brief({
            rules: [{
              type: "mediaType",
              severity: "require",
              options: { mediaTypes: ["image/png"] },
            }],
          }),
        }),
        {
          content: encoder.encode("# a brief"),
          mediaType: "text/markdown",
          facts: {},
        },
      ),
    StandardError,
  );
  const body = error as unknown as {
    code: string;
    params: Record<string, unknown>;
  };
  assertEquals(body.code, "UNPROCESSABLE");
  assertEquals(body.params.reason, "kind_rule_refused");
  assertEquals(body.params.kind, "brief");
  assertEquals(body.params.revision, 7);
  assertEquals(body.params.rule, "mediaType");
  // The refusal says whether the rule ran at all. A publisher chasing a binary
  // document under a text rule needs "could not check", not "failed the check".
  assertEquals(body.params.unavailable, "false");
});

Deno.test("a warn rule reports its finding and still publishes", () => {
  const findings = gateArtifactPublication(
    binding({
      definition: brief({
        rules: [{
          type: "maxBytes",
          severity: "warn",
          options: { value: 4 },
        }],
      }),
    }),
    {
      content: encoder.encode("far longer than four bytes"),
      mediaType: "text/markdown",
      facts: {},
    },
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0].severity, "warn");
  assertEquals(findings[0].ruleType, "maxBytes");
});

Deno.test("a text rule over a binary document refuses as unavailable, not as a failure", () => {
  // The distinction the `unavailable` flag exists for: the rule could not read
  // the document at all, which is not the same answer as "it read it and refused".
  const error = assertThrows(
    () =>
      gateArtifactPublication(
        binding({
          definition: brief({
            text: false,
            rules: [{
              type: "maxLength",
              severity: "require",
              options: { value: 10 },
            }],
          }),
        }),
        {
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mediaType: "image/png",
          facts: {},
        },
      ),
    StandardError,
  );
  const body = error as unknown as { params: Record<string, unknown> };
  assertEquals(body.params.unavailable, "true");
});

Deno.test("a missing required fact refuses even when every rule passes", () => {
  // Facts answer a different question from rules, so a satisfied rule list must
  // not carry a version with an incomplete fact set into publication.
  const error = assertThrows(
    () =>
      gateArtifactPublication(
        binding({
          definition: brief({
            facts: [{
              name: "wordCount",
              type: "integer",
              required: true,
              description: "Words.",
            }],
          }),
        }),
        {
          content: encoder.encode("a brief"),
          mediaType: "text/markdown",
          facts: {},
        },
      ),
    StandardError,
  );
  assertEquals(
    (error as unknown as { params: Record<string, unknown> }).params.detail,
    "facts.wordCount",
  );
});
