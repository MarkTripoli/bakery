import { z } from "zod";
import { canonicalJson } from "./workflow-compiler/canonical.ts";
import type { ArtifactProbeResult } from "./artifact-probe.ts";

/**
 * The closed set of rule types a kind may compose.
 *
 * This list IS the "no validator code" guarantee (chapter 25 §6, O6). A customer
 * cannot supply a validator: they name one of these platform-supplied types and
 * hand it bounded options. The types themselves are implemented by the platform,
 * run in the publication path, and never travel in a kind definition. Adding one
 * is a platform release, which is what keeps the publication path free of
 * customer logic while still letting a kind say what a document must contain.
 *
 * A type is deliberately coarse. `maxLength` says "this field is text of at most
 * N characters"; it does not say "and it must read like a marketing brief".
 * Anything that needs judgement is a sandboxed check action whose typed output
 * drives control flow (T1), not a validator.
 */
export const PLATFORM_RULE_TYPES = Object.freeze(
  [
    "maxLength",
    "nonEmpty",
    "mediaType",
    "maxBytes",
    "linesAtMost",
    "probedMediaType",
    "maxPixels",
    "maxDurationSeconds",
  ] as const,
);
export type PlatformRuleType = typeof PLATFORM_RULE_TYPES[number];

/**
 * The rule types that read what the sandboxed probe measured (chapter 25
 * section 17.5, O29), not the bytes the publisher sent.
 *
 * They can never run in the publish transaction: the probe runs later, in a
 * sandbox, on the stored bytes. A version under a kind that has any of them is
 * written as staged and becomes current only when the probe answers and these
 * rules pass (`validateProbedArtifactKindDocument`).
 */
export const PROBE_BACKED_RULE_TYPES = Object.freeze(
  ["probedMediaType", "maxPixels", "maxDurationSeconds"] as const,
);
export type ProbeBackedRuleType = typeof PROBE_BACKED_RULE_TYPES[number];

export function isProbeBackedRuleType(
  value: unknown,
): value is ProbeBackedRuleType {
  return typeof value === "string" &&
    (PROBE_BACKED_RULE_TYPES as readonly string[]).includes(value);
}

/** Whether a kind version has any rule only a probe answer can evaluate. */
export function hasProbeBackedRules(
  definition: ArtifactKindDefinition,
): boolean {
  return definition.rules.some((rule) => isProbeBackedRuleType(rule.type));
}

export function isPlatformRuleType(value: unknown): value is PlatformRuleType {
  return typeof value === "string" &&
    (PLATFORM_RULE_TYPES as readonly string[]).includes(value);
}

/**
 * What a rule does with a failure.
 *
 * `require` refuses the publication; `warn` records the finding on the version
 * and lets it through. There is no `guide` here, unlike repository rules: a kind
 * validates a document's contents at publication, and "here is some context" is
 * not a verdict on a document.
 */
export const KIND_RULE_SEVERITIES = Object.freeze(["require", "warn"] as const);
export type KindRuleSeverity = typeof KIND_RULE_SEVERITIES[number];

/**
 * The fact types the engine may read from a published version.
 *
 * Closed for the same reason the rule types are: the interpreter branches on
 * facts, so every fact's shape must be known to the kernel. A kind can name
 * which facts it declares and what each means; it cannot invent a new shape the
 * interpreter would have to guess at (K1: the engine never branches on a name it
 * does not understand).
 */
export const FACT_TYPES = Object.freeze(
  ["string", "integer", "number", "boolean", "timestamp"] as const,
);
export type FactType = typeof FACT_TYPES[number];

/** Upper bounds, so a kind cannot be used to make publication unbounded work. */
export const MAX_KIND_RULES = 20;
export const MAX_KIND_FACTS = 50;
export const MAX_KIND_DEFINITION_BYTES = 65536;

/**
 * Free text must survive PostgreSQL jsonb storage: NUL and lone surrogates are
 * legal JSON string contents but jsonb rejects them, so they are refused here
 * rather than failing as a driver error at insert.
 */
const UNPAIRED_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const artifactKindFreeText = <T extends z.ZodString>(schema: T) =>
  schema.refine(
    (value) => !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value),
    {
      message: "Text must not contain NUL or unpaired surrogate characters.",
    },
  );

/**
 * A kind's stable, human-chosen identifier.
 *
 * Lowercase kebab because it is what a workflow author types in `kind: brief`
 * and what a template names. The UUID is the identity; this is the name the
 * author reads.
 */
export const ArtifactKindKeySchema = z.string().min(1).max(64).regex(
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
).describe(
  "Stable lowercase kebab-case key naming this kind, such as brief or render-cut. Workflow authors and templates refer to a kind by this key, so it is unique among the organization's live kinds.",
);

const FactNameSchema = z.string().min(1).max(64).regex(
  /^[a-z][A-Za-z0-9]*$/,
).describe(
  "Fact name the engine reads from a published version, such as wordCount or durationSeconds. Lower camel case, unique within the kind.",
);

/**
 * One fact a kind declares.
 *
 * `required` is what publication enforces: a required fact must be present on
 * every published version of that kind. An optional fact may be absent, and the
 * engine treats absence as absence rather than a default - a fact nobody
 * measured is not a fact that is zero.
 */
export const ArtifactKindFactSchema = z.object({
  name: FactNameSchema,
  type: z.enum(FACT_TYPES).describe(
    "Value shape the engine may rely on for this fact. integer means a whole number, number allows fractions, timestamp is a UTC instant.",
  ),
  required: z.boolean().describe(
    "Whether every published version of this kind must carry this fact. A missing required fact refuses publication; a missing optional fact is absent, never defaulted.",
  ),
  description: artifactKindFreeText(
    z.string().min(1).max(500).describe(
      "What this fact means, in one sentence of at most 500 characters, so an agent publishing a document knows what to provide and a reader knows how to interpret it.",
    ),
  ),
}).strict().describe(
  "One fact a kind yields from a published version: its name, its closed value shape, whether every version must carry it, and what it means.",
);

/**
 * Options a platform rule type accepts.
 *
 * Each type has exactly one required numeric option, so a rule reads as
 * "maxLength 20000" rather than a bag of settings. Strict, so a typo is a
 * refusal rather than a silently ignored option.
 */
const RuleOptionsSchema = z.object({
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
    .describe(
      "The bound this rule enforces: a character count for maxLength, a byte count for maxBytes, a line count for linesAtMost, a pixel count (width times height) for maxPixels, whole seconds for maxDurationSeconds.",
    ),
  mediaTypes: z.array(
    artifactKindFreeText(
      z.string().min(1).max(255).describe(
        "One IANA media type this rule accepts, exactly as it is recorded on a document, such as image/png.",
      ),
    ),
  ).min(1).max(20).optional().describe(
    "Media types this rule accepts, such as text/markdown or image/png. Required by mediaType (compared with the declared type) and probedMediaType (compared with the type the probe detected from the bytes), and refused by every other rule type.",
  ),
}).strict().describe(
  "Bounded options for one platform rule type: a numeric bound, an accepted media type list, or neither for nonEmpty.",
);

export const ArtifactKindRuleSchema = z.object({
  type: z.enum(PLATFORM_RULE_TYPES).describe(
    "Which platform-supplied rule type this entry composes. The set is closed: a kind names a rule type, never a code path, which is what keeps customer logic out of the publication path.",
  ),
  severity: z.enum(KIND_RULE_SEVERITIES).describe(
    "require refuses a version that fails this rule; warn records the finding and publishes anyway.",
  ),
  options: RuleOptionsSchema,
}).strict().describe(
  "One rule a kind applies at publication: a named platform rule type, its bounded options, and what a failure means.",
);

/**
 * The definition a kind version carries.
 *
 * `rules` and `facts` are the whole content; there is no field anywhere that
 * accepts code, a script, an expression or a URL to fetch one from. That is not
 * an omission - it is the shape O6 requires, and a schema that could not express
 * a validator is a stronger guarantee than one that refuses them.
 */
export const ArtifactKindDefinitionSchema = z.object({
  key: ArtifactKindKeySchema,
  name: artifactKindFreeText(
    z.string().min(1).max(120).describe(
      "Human-readable kind name of at most 120 characters, shown wherever a document's kind is labelled.",
    ),
  ),
  description: artifactKindFreeText(
    z.string().min(1).max(1000).describe(
      "What a document of this kind is for and what it must contain, in at most 1000 characters, so people and agents publish the right thing.",
    ),
  ),
  text: z.boolean().describe(
    "Whether documents of this kind are text. A text kind may be stored inline and read as text; a binary kind is stored in the object store and validated by media type and size.",
  ),
  facts: z.array(ArtifactKindFactSchema).max(MAX_KIND_FACTS).describe(
    `Facts the engine may read from a version of this kind, at most ${MAX_KIND_FACTS}, with unique names.`,
  ),
  rules: z.array(ArtifactKindRuleSchema).max(MAX_KIND_RULES).describe(
    `Rules applied at publication, at most ${MAX_KIND_RULES}.`,
  ),
}).strict().describe(
  "The content of one immutable kind version: its key, name, description, whether it is text, the facts the engine may read, and the platform rule types it composes. It contains declarations only, never executable logic.",
);

export type ArtifactKindDefinition = z.output<
  typeof ArtifactKindDefinitionSchema
>;
export type ArtifactKindRule = z.output<typeof ArtifactKindRuleSchema>;
export type ArtifactKindFact = z.output<typeof ArtifactKindFactSchema>;

/**
 * The canonical byte length of a definition, after validation.
 *
 * The canonical form is `canonicalJson` (sorted keys, UTF-8) so two callers that
 * built the same definition by different routes measure the same size and hash
 * to the same digest. A kind is stored sorted for exactly that reason: the
 * digest is what makes "is this the same kind as the one that version
 * published" answerable without comparing JSON objects member by member.
 */
export function artifactKindDefinitionBytes(
  definition: ArtifactKindDefinition,
): number {
  return new TextEncoder().encode(canonicalJson(definition)).byteLength;
}

/**
 * Checks the properties a list of rules or facts must hold as a whole.
 *
 * These are cross-item invariants a per-item schema cannot express: duplicate
 * fact names would make "read the fact called wordCount" ambiguous, and two
 * rules of the same type at different severities would make the verdict depend
 * on evaluation order.
 *
 * Returns the defects rather than throwing, so a caller can report all of them
 * at once: an author fixing five problems should not have to publish five times.
 */
export function artifactKindDefinitionDefects(
  definition: ArtifactKindDefinition,
): ReadonlyArray<{
  path: (string | number)[];
  code: string;
  message: string;
}> {
  const defects: Array<{
    path: (string | number)[];
    code: string;
    message: string;
  }> = [];
  const factNames = new Set<string>();
  definition.facts.forEach((fact, index) => {
    if (factNames.has(fact.name)) {
      defects.push({
        path: ["facts", index, "name"],
        code: "duplicate_fact_name",
        message:
          `Fact name ${fact.name} is declared more than once; a fact must be unambiguous for the engine to read it.`,
      });
    }
    factNames.add(fact.name);
  });
  const ruleTypes = new Set<string>();
  definition.rules.forEach((rule, index) => {
    if (ruleTypes.has(rule.type)) {
      defects.push({
        path: ["rules", index, "type"],
        code: "duplicate_rule_type",
        message:
          `Rule type ${rule.type} is declared more than once; declare it once with the severity you mean.`,
      });
    }
    ruleTypes.add(rule.type);
    // Each rule type needs exactly the options it reads. A `mediaType` rule with
    // no list would accept nothing, and a `maxLength` rule with no value would
    // bound nothing - both are author mistakes that would otherwise publish a
    // kind that cannot do what it says.
    const needsValue = rule.type === "maxLength" || rule.type === "maxBytes" ||
      rule.type === "linesAtMost" || rule.type === "maxPixels" ||
      rule.type === "maxDurationSeconds";
    if (needsValue && rule.options.value === undefined) {
      defects.push({
        path: ["rules", index, "options", "value"],
        code: "rule_value_required",
        message: `Rule type ${rule.type} requires options.value.`,
      });
    }
    if (!needsValue && rule.options.value !== undefined) {
      defects.push({
        path: ["rules", index, "options", "value"],
        code: "rule_value_unexpected",
        message: `Rule type ${rule.type} does not read options.value.`,
      });
    }
    const needsMediaTypes = rule.type === "mediaType" ||
      rule.type === "probedMediaType";
    if (needsMediaTypes && !rule.options.mediaTypes) {
      defects.push({
        path: ["rules", index, "options", "mediaTypes"],
        code: "rule_media_types_required",
        message: `Rule type ${rule.type} requires options.mediaTypes.`,
      });
    }
    if (!needsMediaTypes && rule.options.mediaTypes !== undefined) {
      defects.push({
        path: ["rules", index, "options", "mediaTypes"],
        code: "rule_media_types_unexpected",
        message: `Rule type ${rule.type} does not read options.mediaTypes.`,
      });
    }
  });
  return defects;
}

/**
 * A fact value as published, checked against the declaration that describes it.
 *
 * The check is deliberately total: an unknown fact name is a refusal, not an
 * extra to be stored, because a fact the kind did not declare is one the engine
 * has no reason to read and a reader has no way to interpret.
 */
export function factValueMatchesType(
  type: FactType,
  value: unknown,
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "timestamp":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }
}
/**
 * What a kind found wrong with a version it was asked to validate.
 *
 * Returned rather than thrown so a publisher can report every defect at once:
 * an author fixing five problems should not have to publish five times, and a
 * typed list is what makes the refusal explainable instead of a bare 422.
 */
export type ArtifactKindFinding = Readonly<{
  ruleType: PlatformRuleType;
  severity: KindRuleSeverity;
  path: string;
  message: string;
  /**
   * True when the rule could not evaluate the document at all - a binary
   * document under a `maxLength` rule, say. An unavailable `require` rule
   * refuses, and an unavailable `warn` rule records the finding, because
   * "we could not check" is a different answer from "we checked and it passed".
   */
  unavailable: boolean;
}>;

/**
 * The document a kind validates: the bytes, their media type, and the facts the
 * publisher asserts.
 */
export type ArtifactKindDocument = Readonly<{
  content: Uint8Array;
  mediaType: string;
  facts: Readonly<Record<string, unknown>>;
}>;

/**
 * Runs a kind version's rules and fact declarations over one document.
 *
 * This is the "validation at publication" of O6, and it is a fixed function, not
 * a plug-in: every branch below is a platform rule type, so the code that runs
 * against a customer's document is platform code and the document can only
 * influence it through bytes, a media type and published facts. That is what
 * makes the guarantee real rather than a policy statement.
 *
 * Facts are checked first and separately from rules, because they answer a
 * different question: rules ask "is this document acceptable", facts ask "is the
 * list of things you claim about it true and complete". A version missing a
 * required fact is refused even when it satisfies every rule.
 */
export function validateArtifactKindDocument(
  definition: ArtifactKindDefinition,
  document: ArtifactKindDocument,
): ReadonlyArray<ArtifactKindFinding> {
  const findings: ArtifactKindFinding[] = [];
  for (const fact of definition.facts) {
    const present = Object.hasOwn(document.facts, fact.name);
    const value = document.facts[fact.name];
    if (!present) {
      if (fact.required) {
        findings.push({
          ruleType: "nonEmpty",
          severity: "require",
          path: `facts.${fact.name}`,
          message:
            `Kind ${definition.key} declares ${fact.name} as required, so every published version must carry it.`,
          unavailable: false,
        });
      }
      continue;
    }
    if (!factValueMatchesType(fact.type, value)) {
      // A wrongly typed fact is treated as a required defect whatever the
      // declaration says: the engine would go on to read it as its declared
      // type, and coercing here would be the interpreter guessing (K1).
      findings.push({
        ruleType: "nonEmpty",
        severity: "require",
        path: `facts.${fact.name}`,
        message:
          `Fact ${fact.name} must be a ${fact.type} for kind ${definition.key}.`,
        unavailable: false,
      });
    }
  }
  for (const rule of definition.rules) {
    // A probe-backed rule is not judged here: the publish transaction has no
    // probe answer, and "staged until the probe answers" is its verdict.
    if (isProbeBackedRuleType(rule.type)) continue;
    const finding = applyRule(rule, definition, document);
    if (finding) findings.push(finding);
  }
  return findings;
}

/**
 * Whether a finding list refuses a publication.
 *
 * A single helper because the answer must not differ between the two doors that
 * ask: the publication path and any caller that wants to preview a verdict.
 * Every finding in the list is a defect - the list holds only what failed - so
 * the question is which severities are in it, not what each message says.
 */
export function refusesArtifactKindPublication(
  findings: ReadonlyArray<ArtifactKindFinding>,
): boolean {
  return findings.some((finding) => finding.severity === "require");
}

/**
 * Runs a kind version's probe-backed rules over what the probe measured.
 *
 * Only the probe-backed rules run: the others already ran in the publish
 * transaction on the same bytes. The answer must be a described probe; a probe
 * refusal is handled by the caller, because a refusal says nothing a rule can
 * measure. A measurement the probe did not take (no width for a video, no
 * duration for an image) is `unavailable`, so a `require` rule refuses and a
 * `warn` rule records it: "we could not check" is not a pass.
 */
export function validateProbedArtifactKindDocument(
  definition: ArtifactKindDefinition,
  probe: Extract<ArtifactProbeResult, { status: "described" }>,
): ReadonlyArray<ArtifactKindFinding> {
  const findings: ArtifactKindFinding[] = [];
  for (const rule of definition.rules) {
    if (!isProbeBackedRuleType(rule.type)) continue;
    const defect = (message: string, unavailable = false) =>
      findings.push({
        ruleType: rule.type,
        severity: rule.severity,
        path: "content",
        message,
        unavailable,
      });
    if (rule.type === "probedMediaType") {
      const accepted = rule.options.mediaTypes ?? [];
      if (!accepted.includes(probe.mediaType)) {
        defect(
          `Kind ${definition.key} accepts ${
            accepted.join(", ")
          }, and the probe found ${probe.mediaType}.`,
        );
      }
      continue;
    }
    const value = rule.options.value ?? 0;
    if (rule.type === "maxPixels") {
      if (
        probe.kind !== "image" || probe.width === undefined ||
        probe.height === undefined
      ) {
        defect(
          `Rule maxPixels needs an image the probe measured, and it found ${probe.kind}.`,
          true,
        );
        continue;
      }
      const pixels = probe.width * probe.height;
      if (pixels > value) {
        defect(
          `Kind ${definition.key} allows at most ${value} pixels, and the image is ${probe.width}x${probe.height} (${pixels}).`,
        );
      }
      continue;
    }
    // maxDurationSeconds: the probe measures whole milliseconds.
    if (
      (probe.kind !== "video" && probe.kind !== "audio") ||
      probe.durationMs === undefined
    ) {
      defect(
        `Rule maxDurationSeconds needs audio or video with a measured duration, and the probe found ${probe.kind}.`,
        true,
      );
      continue;
    }
    if (probe.durationMs > value * 1000) {
      defect(
        `Kind ${definition.key} allows at most ${value} seconds, and the file lasts ${
          probe.durationMs / 1000
        }.`,
      );
    }
  }
  return findings;
}

function applyRule(
  rule: ArtifactKindRule,
  definition: ArtifactKindDefinition,
  document: ArtifactKindDocument,
): ArtifactKindFinding | null {
  const defect = (
    message: string,
    unavailable = false,
  ): ArtifactKindFinding => ({
    ruleType: rule.type,
    severity: rule.severity,
    path: "content",
    message,
    unavailable,
  });
  if (rule.type === "mediaType") {
    const accepted = rule.options.mediaTypes ?? [];
    // `document.mediaType` is compared exactly, including parameters, because a
    // kind that accepts image/png has not thereby accepted image/png; charset=x.
    return accepted.includes(document.mediaType) ? null : defect(
      `Kind ${definition.key} accepts ${accepted.join(", ")}, not ${
        document.mediaType || "(none)"
      }.`,
    );
  }
  if (rule.type === "nonEmpty") {
    return document.content.byteLength > 0
      ? null
      : defect(`Kind ${definition.key} refuses an empty document.`);
  }
  if (!definition.text) {
    // The remaining types read the document as text. A binary document under one
    // is not a pass and not a fail: the rule could not run, and saying which is
    // the whole reason `unavailable` exists.
    return defect(
      `Rule ${rule.type} needs a text document, and kind ${definition.key} is binary.`,
      true,
    );
  }
  const value = rule.options.value ?? 0;
  if (rule.type === "maxBytes") {
    return document.content.byteLength <= value ? null : defect(
      `Kind ${definition.key} allows at most ${value} bytes, and the document is ${document.content.byteLength}.`,
    );
  }
  const text = new TextDecoder().decode(document.content);
  if (rule.type === "maxLength") {
    // Code points, not UTF-16 units: an author counting characters in an editor
    // counts what they see, and a surrogate pair is one character to them.
    const length = [...text].length;
    return length <= value ? null : defect(
      `Kind ${definition.key} allows at most ${value} characters, and the document has ${length}.`,
    );
  }
  // linesAtMost: a trailing newline ends the last line rather than starting an
  // empty one, which is what every editor displays.
  const lines = text.length === 0
    ? 0
    : text.replace(/\n$/, "").split("\n").length;
  return lines <= value ? null : defect(
    `Kind ${definition.key} allows at most ${value} lines, and the document has ${lines}.`,
  );
}
