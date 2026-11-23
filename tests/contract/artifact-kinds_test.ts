import { assert, assertEquals } from "@std/assert";
import {
  artifactKindDefinitionBytes,
  artifactKindDefinitionDefects,
  ArtifactKindDefinitionSchema,
  FACT_TYPES,
  factValueMatchesType,
  MAX_KIND_RULES,
  PLATFORM_RULE_TYPES,
  refusesArtifactKindPublication,
  validateArtifactKindDocument,
} from "../../packages/contracts/src/artifact-kinds.ts";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  ArtifactKindImplementedAction,
  artifactKindImplementedActions,
  implementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  type ArtifactKindsActionHandlers,
  createArtifactKindsActionRegistry,
} from "../../apps/server/src/modules/artifact-kinds/actions.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

const expectedActions = [
  "artifactKindVersions.create",
  "artifactKindVersions.list",
  "artifactKinds.get",
  "artifactKinds.list",
].sort();

function brief(overrides: Record<string, unknown> = {}) {
  return {
    key: "brief",
    name: "Brief",
    description: "The written statement of what a piece of work is for.",
    text: true,
    facts: [{
      name: "wordCount",
      type: "integer",
      required: true,
      description: "Number of words in the brief.",
    }],
    rules: [{
      type: "maxLength",
      severity: "require",
      options: { value: 20000 },
    }],
    ...overrides,
  };
}

Deno.test("the kind registry implements exactly the four catalog actions", () => {
  const unavailable = () => Promise.reject(new Error("not called"));
  const registry = createArtifactKindsActionRegistry(
    {} as PgDatabase,
    {
      listKinds: unavailable,
      getKind: unavailable,
      publishVersion: unavailable,
      listVersions: unavailable,
    } as unknown as ArtifactKindsActionHandlers,
  );
  assertEquals(
    registry.list().map(({ name }) => name).sort(),
    expectedActions,
  );
  assertEquals([...artifactKindImplementedActions].sort(), expectedActions);
  assertEquals(
    Object.values(ArtifactKindImplementedAction).sort(),
    expectedActions,
  );
  // Every registered action is declared implemented, so a route cannot exist
  // that the implemented-action registry does not know about.
  for (const action of expectedActions) {
    assert(implementedActions.includes(action as never), action);
  }
});

Deno.test("the catalog declares the kind operations under the design paths", () => {
  const entries = catalogActions.filter(({ action }) =>
    expectedActions.includes(action)
  );
  assertEquals(entries.length, 4);
  const byAction = Object.fromEntries(
    entries.map((entry) => [entry.action, entry]),
  );
  assertEquals(
    byAction["artifactKinds.list"]?.path,
    "/v1/organizations/{id}/artifact-kinds",
  );
  assertEquals(
    byAction["artifactKinds.get"]?.path,
    "/v1/organizations/{id}/artifact-kinds/{key}",
  );
  assertEquals(
    byAction["artifactKindVersions.create"]?.path,
    "/v1/organizations/{id}/artifact-kinds/{key}/versions",
  );
  assertEquals(
    byAction["artifactKindVersions.list"]?.path,
    "/v1/organizations/{id}/artifact-kinds/{key}/versions",
  );
  for (const entry of entries) {
    assertEquals(entry.organizationContext, "required_authenticated_context");
    assertEquals(
      (entry as { organizationIdParam?: string }).organizationIdParam,
      "id",
    );
  }
  assertEquals(byAction["artifactKinds.list"]?.access, "Developer");
  assertEquals(byAction["artifactKinds.get"]?.access, "Developer");
  assertEquals(byAction["artifactKindVersions.list"]?.access, "Developer");
  // Publishing is an administrative act: a kind is what every author and run
  // depends on, so writing one is not a developer action.
  assertEquals(byAction["artifactKindVersions.create"]?.access, "Admin");
  assertEquals(
    byAction["artifactKindVersions.create"]?.permission,
    "artifactKind:manage",
  );
  assertEquals(
    byAction["artifactKinds.list"]?.permission,
    "artifactKind:read",
  );
  assertEquals(
    byAction["artifactKindVersions.create"]?.event,
    "artifactKinds.published",
  );
});

Deno.test("a definition carries declarations only and refuses anything else", () => {
  const schema = contractSchemas.ArtifactKindVersionCreate;
  assert(
    schema.safeParse({ expectedRevision: 0, definition: brief() }).success,
  );
  // There is no field in which a customer could put a validator. The transport
  // carries the definition as opaque JSON so the strict definition schema, not
  // the JSON envelope, is the single place that decides what a kind may say.
  for (
    const extra of [
      { validator: "function (doc) { return true }" },
      { script: "return true" },
      { expression: "doc.length > 0" },
      { validatorUrl: "https://example.com/validator.js" },
    ]
  ) {
    assert(
      !ArtifactKindDefinitionSchema.safeParse(brief(extra)).success,
      Object.keys(extra)[0],
    );
  }
  // An unknown rule type is refused rather than ignored: a typo must not publish
  // a kind that silently enforces nothing.
  assert(
    !ArtifactKindDefinitionSchema.safeParse(
      brief({
        rules: [{ type: "customerScript", severity: "require", options: {} }],
      }),
    ).success,
  );
});

Deno.test("the platform rule types are the whole closed set", () => {
  assertEquals(
    [...PLATFORM_RULE_TYPES],
    [
      "maxLength",
      "nonEmpty",
      "mediaType",
      "maxBytes",
      "linesAtMost",
      "probedMediaType",
      "maxPixels",
      "maxDurationSeconds",
    ],
  );
  assertEquals(
    [...FACT_TYPES],
    ["string", "integer", "number", "boolean", "timestamp"],
  );
  // A rule type outside the list cannot be expressed at all.
  for (
    const type of [
      "customerScript",
      "regex",
      "external",
      "exec",
      "shell",
    ]
  ) {
    assert(
      !ArtifactKindDefinitionSchema.safeParse(
        brief({ rules: [{ type, severity: "require", options: {} }] }),
      ).success,
      type,
    );
  }
});

Deno.test("a rule that names no bound, or a bound no rule reads, is refused", () => {
  const missingValue = artifactKindDefinitionDefects(
    ArtifactKindDefinitionSchema.parse(
      brief({
        rules: [{ type: "maxLength", severity: "require", options: {} }],
      }),
    ),
  );
  assertEquals(missingValue.map((defect) => defect.code), [
    "rule_value_required",
  ]);
  const unexpectedValue = artifactKindDefinitionDefects(
    ArtifactKindDefinitionSchema.parse(
      brief({
        rules: [{
          type: "nonEmpty",
          severity: "require",
          options: { value: 3 },
        }],
      }),
    ),
  );
  assertEquals(unexpectedValue.map((defect) => defect.code), [
    "rule_value_unexpected",
  ]);
  const mediaMissing = artifactKindDefinitionDefects(
    ArtifactKindDefinitionSchema.parse(
      brief({
        rules: [{ type: "mediaType", severity: "require", options: {} }],
      }),
    ),
  );
  assertEquals(mediaMissing.map((defect) => defect.code), [
    "rule_media_types_required",
  ]);
});

Deno.test("duplicate fact names and duplicate rule types are refused", () => {
  const duplicateFacts = artifactKindDefinitionDefects(
    ArtifactKindDefinitionSchema.parse(
      brief({
        facts: [
          {
            name: "wordCount",
            type: "integer",
            required: true,
            description: "Words.",
          },
          {
            name: "wordCount",
            type: "integer",
            required: false,
            description: "Words again.",
          },
        ],
      }),
    ),
  );
  assertEquals(duplicateFacts.map((defect) => defect.code), [
    "duplicate_fact_name",
  ]);
  const duplicateRules = artifactKindDefinitionDefects(
    ArtifactKindDefinitionSchema.parse(
      brief({
        rules: [
          { type: "nonEmpty", severity: "require", options: {} },
          { type: "nonEmpty", severity: "warn", options: {} },
        ],
      }),
    ),
  );
  assertEquals(duplicateRules.map((defect) => defect.code), [
    "duplicate_rule_type",
  ]);
});

Deno.test("a definition is bounded so every publisher computes one digest", () => {
  const definition = ArtifactKindDefinitionSchema.parse(brief());
  assert(artifactKindDefinitionBytes(definition) > 0);
  // The rule count is capped, so a kind cannot be used to make publication do
  // unbounded work.
  const tooMany = Array.from({ length: MAX_KIND_RULES + 1 }, () => ({
    type: "nonEmpty",
    severity: "require",
    options: {},
  }));
  assert(
    !ArtifactKindDefinitionSchema.safeParse(brief({ rules: tooMany })).success,
  );
});

Deno.test("required facts are enforced at publication, optional ones are not", () => {
  const definition = ArtifactKindDefinitionSchema.parse(
    brief({
      facts: [
        {
          name: "wordCount",
          type: "integer",
          required: true,
          description: "Words.",
        },
        {
          name: "note",
          type: "string",
          required: false,
          description: "Optional note.",
        },
      ],
    }),
  );
  const text = new TextEncoder().encode("a short brief");
  const missing = validateArtifactKindDocument(definition, {
    content: text,
    mediaType: "text/markdown",
    facts: {},
  });
  assertEquals(refusesArtifactKindPublication(missing), true);
  assertEquals(missing.map((finding) => finding.path), ["facts.wordCount"]);
  // Absent optional fact is absence, not a default.
  const satisfied = validateArtifactKindDocument(definition, {
    content: text,
    mediaType: "text/markdown",
    facts: { wordCount: 3 },
  });
  assertEquals(satisfied, []);
  // A wrongly typed fact is refused even though it is present: the engine would
  // read it as its declared type, and coercing would be the interpreter guessing.
  const wrongType = validateArtifactKindDocument(definition, {
    content: text,
    mediaType: "text/markdown",
    facts: { wordCount: "three" },
  });
  assertEquals(refusesArtifactKindPublication(wrongType), true);
});

Deno.test("each fact type accepts exactly its own shape", () => {
  for (
    const [type, good, bad] of [
      ["string", "x", 1],
      ["integer", 2, 2.5],
      ["number", 2.5, "2"],
      ["boolean", true, "true"],
      ["timestamp", "2026-01-01T00:00:00Z", "not a date"],
    ] as const
  ) {
    assert(factValueMatchesType(type, good), `${type} accepts ${good}`);
    assert(!factValueMatchesType(type, bad), `${type} refuses ${bad}`);
  }
});

Deno.test("a failing require rule refuses, a failing warn rule does not", () => {
  const text = new TextEncoder().encode("exactly this");
  const tooShort = (severity: "require" | "warn") =>
    ArtifactKindDefinitionSchema.parse(
      brief({
        rules: [{
          type: "maxLength",
          severity,
          options: { value: 3 },
        }],
      }),
    );
  const required = validateArtifactKindDocument(tooShort("require"), {
    content: text,
    mediaType: "text/markdown",
    facts: { wordCount: 2 },
  });
  assertEquals(refusesArtifactKindPublication(required), true);
  const warned = validateArtifactKindDocument(tooShort("warn"), {
    content: text,
    mediaType: "text/markdown",
    facts: { wordCount: 2 },
  });
  // The finding is recorded, and it does not stop the publication.
  assertEquals(warned.length, 1);
  assertEquals(warned[0].severity, "warn");
  assertEquals(refusesArtifactKindPublication(warned), false);
});

Deno.test("a rule that cannot run on a binary document is unavailable, not passing", () => {
  const definition = ArtifactKindDefinitionSchema.parse(
    brief({
      text: false,
      rules: [{
        type: "maxLength",
        severity: "require",
        options: { value: 100 },
      }],
    }),
  );
  const findings = validateArtifactKindDocument(definition, {
    content: new Uint8Array([1, 2, 3]),
    mediaType: "image/png",
    facts: { wordCount: 1 },
  });
  assertEquals(findings.length, 1);
  assertEquals(findings[0].unavailable, true);
  // "We could not check" refuses a require rule: a pass nobody performed is not
  // a pass.
  assertEquals(refusesArtifactKindPublication(findings), true);
});

Deno.test("media type is matched exactly, not by prefix", () => {
  const definition = ArtifactKindDefinitionSchema.parse(
    brief({
      text: false,
      rules: [{
        type: "mediaType",
        severity: "require",
        options: { mediaTypes: ["image/png"] },
      }],
    }),
  );
  const exact = validateArtifactKindDocument(definition, {
    content: new Uint8Array([1]),
    mediaType: "image/png",
    facts: { wordCount: 0 },
  });
  assertEquals(exact, []);
  const parameterised = validateArtifactKindDocument(definition, {
    content: new Uint8Array([1]),
    mediaType: "image/png; charset=binary",
    facts: { wordCount: 0 },
  });
  assertEquals(parameterised.length, 1);
});

Deno.test("line and byte rules count what an editor shows", () => {
  const lines = ArtifactKindDefinitionSchema.parse(
    brief({
      rules: [{
        type: "linesAtMost",
        severity: "require",
        options: { value: 2 },
      }],
    }),
  );
  const withTrailingNewline = new TextEncoder().encode("one\ntwo\n");
  assertEquals(
    validateArtifactKindDocument(lines, {
      content: withTrailingNewline,
      mediaType: "text/markdown",
      facts: { wordCount: 2 },
    }),
    [],
  );
  const bytes = ArtifactKindDefinitionSchema.parse(
    brief({
      rules: [{ type: "maxBytes", severity: "require", options: { value: 3 } }],
    }),
  );
  const findings = validateArtifactKindDocument(bytes, {
    content: new TextEncoder().encode("four"),
    mediaType: "text/markdown",
    facts: { wordCount: 1 },
  });
  assertEquals(findings.length, 1);
});

Deno.test("free text refuses NUL and unpaired surrogates", () => {
  for (const name of ["bad\u0000text", "lone\ud800surrogate"]) {
    assert(
      !ArtifactKindDefinitionSchema.safeParse(brief({ name })).success,
      JSON.stringify(name),
    );
  }
  assert(
    ArtifactKindDefinitionSchema.safeParse(
      brief({ name: "pair \ud83d\ude00" }),
    ).success,
  );
});

Deno.test("the publication lock key is the uniqueness key, not a proxy for it", async () => {
  // QA asked for this to be pinned: the DB enforces one revision per
  // (organization_id, kind_id, revision) via
  // `artifact_kind_versions_revision_unique`, while publication serializes with
  // an advisory lock. Those two agree only while the lock key IS the uniqueness
  // key. A rename, or a second key resolving to one kind, would silently make
  // the lock serialize a different pair of requests than the constraint
  // protects: both publishers pass the expectedRevision check under different
  // locks and collide at insert instead of being ordered.
  const root = new URL("../../", import.meta.url).pathname;
  const source = await Deno.readTextFile(
    `${root}apps/server/src/modules/artifact-kinds/postgres.ts`,
  );
  const sql = await Deno.readTextFile(
    `${root}apps/server/src/modules/artifact-kinds/migrations/bakery/0171_artifact_kinds.sql`,
  );
  const lock =
    /pg_advisory_xact_lock\(\s*hashtextextended\(\$1::text \|\| ':' \|\| \$2::text, 0\)\)/
      .exec(source);
  assert(lock, "publication must serialize with the advisory lock");
  // The lock is taken over (organizationId, kindId) and nothing else...
  const lockArguments =
    /hashtextextended\(\$1::text \|\| ':' \|\| \$2::text, 0\)\)`,\s*\[([^\]]+)\]/
      .exec(source)?.[1] ?? "";
  assert(
    lockArguments.includes("organizationId"),
    `the lock must start from the organization, saw ${lockArguments}`,
  );
  // ...where kindId is the identity the constraint names, or the not-yet-created
  // key while the first revision is being published.
  assert(
    /kindId \?\? `new:\$\{pathKey\}`/.test(lockArguments),
    `the lock's second half must be the kind identity, saw ${lockArguments}`,
  );
  // The constraint must still be exactly (organization_id, kind_id, revision),
  // so the comment above stays true and not merely once true.
  const constraint =
    /artifact_kind_versions_revision_unique\s+unique \(([^)]*)\)/.exec(sql)?.[1]
      ?.replace(/\s+/g, " ") ?? "";
  assertEquals(constraint, "organization_id, kind_id, revision");
});
