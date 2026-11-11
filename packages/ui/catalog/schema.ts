import { z } from "zod";

/** Atomic Design levels a catalog entry can have, lowest to highest. */
export const CATALOG_LEVELS = [
  "atom",
  "molecule",
  "organism",
  "template",
  "page",
] as const;

/** Levels that may consume a component: the catalog levels plus the app that imports `@bakery/ui`. */
export const CONSUMER_LEVELS = [...CATALOG_LEVELS, "app"] as const;

export const ACCESSIBLE_NAME_SOURCES = [
  "aria-label",
  "aria-labelledby",
  "content",
  "caption",
  "none",
] as const;

const NonBlankSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Nonblank trimmed text; callers replace this with a field specific description.",
  );

const IdSchema = NonBlankSchema.regex(/^(?:ui|template|page)\.[A-Za-z0-9]+$/)
  .describe(
    "Catalog id of the form ui.name, template.name or page.name.",
  );

const TextListSchema = z
  .array(NonBlankSchema)
  .describe(
    "List of nonblank text items; callers replace this with a field specific description.",
  );

const ProfileListSchema = <const T extends readonly [string, ...string[]]>(
  values: T,
  description: string,
) =>
  z
    .array(z.enum(values).describe("One allowed profile value."))
    .describe(description);

export const CatalogRuleSchema = z
  .object({
    id: NonBlankSchema.describe(
      "Rule id that entries cite in usage.ruleIds, for example ui.semantic-import.",
    ),
    description: NonBlankSchema.describe(
      "What the rule requires of a component or its consumers.",
    ),
    status: z
      .enum(["specified", "implemented"])
      .describe(
        "specified: written down but not yet enforced by a check. implemented: a check enforces it.",
      ),
    implementationIssue: z
      .number()
      .int()
      .positive()
      .describe("GitHub issue number that tracks building the enforcement."),
  })
  .strict()
  .describe("One shared catalog rule that component usage is judged against.");

export const CatalogRequirementSchema = z
  .object({
    id: NonBlankSchema.describe(
      "Requirement id that entries cite in requirementIds, for example theme.paired.",
    ),
    category: NonBlankSchema.describe(
      "Concern the requirement belongs to, for example theme, layout, pointer, a11y or i18n.",
    ),
    description: NonBlankSchema.describe(
      "Observable behavior every entry that cites the requirement must keep.",
    ),
    status: z
      .enum(["specified", "implemented"])
      .describe(
        "specified: written down but not yet enforced by a check. implemented: a check enforces it.",
      ),
    implementationIssue: z
      .number()
      .int()
      .positive()
      .describe("GitHub issue number that tracks building the enforcement."),
  })
  .strict()
  .describe(
    "One cross-cutting requirement that catalog entries must satisfy and prove.",
  );

export const CatalogEvidenceSourceSchema = z
  .object({
    id: NonBlankSchema.describe(
      "Evidence source id that entries cite in evidenceRefs, for example design.components.",
    ),
    path: NonBlankSchema.describe(
      "Repository-relative path of the governing design document.",
    ),
    section: NonBlankSchema.describe(
      "Heading inside the document that governs the entry.",
    ),
    description: NonBlankSchema.describe(
      "What the section decides for the components that cite it.",
    ),
  })
  .strict()
  .describe("A design document section that governs catalog entries.");

export const CatalogEvidenceSuiteSchema = z
  .object({
    id: NonBlankSchema.describe(
      "Suite id that coverage entries cite as suite:<name>, for example suite.storybook.canonical-axe.",
    ),
    path: NonBlankSchema.describe(
      "Repository-relative path of the test file that holds the suite.",
    ),
    testTitle: NonBlankSchema.describe(
      "Title of the test inside the file that the suite runs.",
    ),
    dimensions: ProfileListSchema(
      ["state", "theme", "layout", "pointer"],
      "Coverage dimensions the suite proves: state, theme, layout or pointer.",
    ),
    description: NonBlankSchema.describe(
      "What the suite asserts for every canonical specimen it covers.",
    ),
    coveredIdentifiers: TextListSchema.optional().describe(
      "Entry-specific identifiers the suite covers when it does not run for every entry.",
    ),
  })
  .strict()
  .describe(
    "An automated test suite that supplies evidence for catalog coverage claims.",
  );

export const CatalogUsageAlternativeSchema = z
  .object({
    when: NonBlankSchema.describe(
      "Condition under which this component is the wrong choice, phrased as a situation, for example navigating to another page.",
    ),
    use: IdSchema.describe(
      "Catalog id of the component to use instead; must be an existing catalog entry.",
    ),
  })
  .strict()
  .describe(
    "Structured do-not-use-when rule: a situation and the component that serves it better.",
  );

export const CatalogUsageSchema = z
  .object({
    whenToUse: NonBlankSchema.describe(
      "One sentence naming the job the component is for.",
    ),
    whenNotToUse: NonBlankSchema.describe(
      "Prose naming misuse of the component and what to reach for instead.",
    ),
    ruleIds: z
      .array(NonBlankSchema)
      .min(1)
      .describe(
        "Ids of catalog rules that govern this component; each must exist in the top-level rules list.",
      ),
    alternatives: z
      .array(CatalogUsageAlternativeSchema)
      .describe(
        "Situations where another catalog component should be used instead; empty when none applies.",
      ),
    replacesElements: z
      .array(NonBlankSchema.regex(/^[a-z][a-z0-9]*$/))
      .describe(
        "Intrinsic lowercase HTML tags that app code must not write by hand because this component renders them; empty when no raw tag maps to the component.",
      ),
    allowedLevels: ProfileListSchema(
      CONSUMER_LEVELS,
      "Consumer levels that may import the component; never lower than the component's own level, matching the atomic direction rule.",
    ).min(1),
  })
  .strict()
  .describe(
    "Guidance for choosing the component: when to use it, when not, what it replaces and who may import it.",
  );

export const CatalogPaperFrameSchema = z
  .object({
    fileId: NonBlankSchema.describe(
      "Paper file id that owns the frame; the design source of truth.",
    ),
    pageId: NonBlankSchema.describe(
      "Paper page id inside the file that holds the frame.",
    ),
    frameId: NonBlankSchema.describe(
      "Paper artboard node id of the specimen frame.",
    ),
    name: NonBlankSchema.describe(
      "Paper artboard name as shown in Paper, for example B exact · ui.statusBadge · 1440×960.",
    ),
    variant: NonBlankSchema.optional().describe(
      "Variant, layout or screen state the frame depicts when the frame name carries one, for example rail fine.",
    ),
  })
  .strict()
  .describe(
    "One Paper artboard that shows the component as designed, linked for reference and audit.",
  );

export const CatalogA11ySchema = z
  .object({
    role: NonBlankSchema.optional().describe(
      "ARIA role of the component's root, explicit or implied by its native element; omitted when it adds none.",
    ),
    accessibleName: z
      .enum(ACCESSIBLE_NAME_SOURCES)
      .describe(
        "Where the accessible name comes from: an aria-label or aria-labelledby the caller supplies, the visible content, a caption, or none when the component is not named.",
      ),
    keyboard: TextListSchema.describe(
      "Keyboard interactions the component implements or inherits from its native element; empty for non-interactive components.",
    ),
    targetSize: NonBlankSchema.optional().describe(
      "Minimum pointer target the CSS enforces, for example min-block-size var(--target-min); omitted for non-interactive components.",
    ),
    notes: NonBlankSchema.optional().describe(
      "One sentence of accessibility detail that the other fields cannot carry.",
    ),
  })
  .strict()
  .describe(
    "Accessibility facts read from the component source, not guidance a caller may override.",
  );

export const CatalogWholeArtboardCaptureSchema = z
  .object({
    contractVersion: z
      .literal("paper-k0-whole-artboard-v1")
      .describe(
        "Whole-artboard capture contract version the case is bound to.",
      ),
    targetSelector: NonBlankSchema.describe(
      "CSS selector of the complete artwork element captured against the Paper artboard.",
    ),
    qualificationSelector: NonBlankSchema.describe(
      "CSS selector of the outer qualification text the capture must show.",
    ),
  })
  .strict()
  .describe(
    "Explicit registration of the complete artwork and its outer qualification for a paired whole-artboard capture.",
  );

export const CatalogRequiredCaseSchema = z
  .object({
    id: NonBlankSchema.describe(
      "Case id unique inside the entry, for example contract or defaultDesktop.",
    ),
    description: NonBlankSchema.describe(
      "What the case exercises across the required contexts.",
    ),
    variants: TextListSchema.describe(
      "Variants the case renders; a subset of the entry variants.",
    ),
    states: TextListSchema.describe(
      "States the case renders; a subset of the entry states.",
    ),
    baselineIds: TextListSchema.describe(
      "Paper baseline case ids that score this case; empty when no Paper golden exists.",
    ),
    wholeArtboardCapture: CatalogWholeArtboardCaptureSchema.optional(),
  })
  .strict()
  .describe(
    "One storybook case an entry must render to prove its variants and states.",
  );

export const CatalogCoverageSchema = z
  .object({
    automated: z
      .record(
        NonBlankSchema,
        z
          .array(NonBlankSchema)
          .describe("Runtime case or suite ids that prove the dimension."),
      )
      .describe(
        "Map from a coverage dimension such as theme:dark to the runtime cases or suites that prove it.",
      ),
    notApplicable: z
      .record(NonBlankSchema, NonBlankSchema)
      .describe(
        "Map from a coverage dimension to the reason it does not apply to the component.",
      ),
    visualContexts: z
      .array(NonBlankSchema)
      .describe("Named render contexts captured as visual evidence."),
  })
  .strict()
  .describe(
    "How an entry proves each theme, layout and pointer dimension, or why one does not apply.",
  );

export const CatalogEntrySchema = z
  .object({
    id: IdSchema.describe(
      "Stable catalog id; the first segment matches the level, for example ui for atoms through organisms.",
    ),
    name: NonBlankSchema.describe(
      "Exported component name from @bakery/ui, or the page example name.",
    ),
    description: NonBlankSchema.describe(
      "One sentence stating what the component renders and the behavior it owns.",
    ),
    level: z
      .enum(CATALOG_LEVELS)
      .describe("Atomic Design level of the component."),
    owner: NonBlankSchema.describe("Person accountable for the entry."),
    storyTitle: NonBlankSchema.describe(
      "Storybook title that binds the component's canonical stories.",
    ),
    usage: CatalogUsageSchema,
    paper: z
      .array(CatalogPaperFrameSchema)
      .describe(
        "Paper specimen frames for this component; empty only with paperAbsentReason.",
      ),
    paperAbsentReason: NonBlankSchema.optional().describe(
      "What was searched in Paper and when, required when paper is empty and forbidden otherwise.",
    ),
    a11y: CatalogA11ySchema,
    tokens: z
      .array(NonBlankSchema.regex(/^--[a-z0-9-]+$/))
      .describe(
        "CSS custom properties the component's styles use, derived from packages/ui/src CSS; sorted and unique.",
      ),
    variants: TextListSchema.describe("Public variants the component offers."),
    states: TextListSchema.describe("Observable states the component has."),
    themes: ProfileListSchema(
      ["light", "dark"],
      "Themes the component must render in.",
    ),
    layoutProfiles: ProfileListSchema(
      ["sheet", "pane", "rail"],
      "Layout profiles the component must reflow across.",
    ),
    pointerProfiles: ProfileListSchema(
      ["coarse", "fine"],
      "Pointer profiles the component must support.",
    ),
    requirementIds: z
      .array(NonBlankSchema)
      .describe(
        "Ids of catalog requirements that apply to this component; each must exist in the top-level requirements list.",
      ),
    requiredCases: z
      .array(CatalogRequiredCaseSchema)
      .min(1)
      .describe("Storybook cases the entry must render."),
    requiredCaseCoverage: z
      .literal("partitioned")
      .optional()
      .describe(
        "Set to partitioned when each required case proves its own variant and state subset instead of the entry's full lists.",
      ),
    evidenceRefs: z
      .array(NonBlankSchema)
      .min(1)
      .describe(
        "Ids of evidence sources that govern the entry; each must exist in the top-level evidenceSources list.",
      ),
    status: z
      .enum(["specified", "implemented"])
      .describe(
        "specified: the design exists but the component does not. implemented: the component ships.",
      ),
    coverage: CatalogCoverageSchema,
  })
  .strict()
  .describe(
    "One reusable component: its identity, Paper specimens, usage guidance, accessibility facts, tokens and proof obligations.",
  );

export const CatalogCompositionRequirementSchema = z
  .object({
    anyOf: z
      .array(IdSchema)
      .min(1)
      .describe(
        "Catalog ids of which at least one must be used. An id may name a component that ships on a later branch and is not in the catalog yet, which can never be rendered, so it fills no slot; at least one id of each slot must be an existing catalog entry.",
      ),
  })
  .strict()
  .describe("One slot of a composition that any listed component can fill.");

export const CatalogCompositionPaperSchema = z
  .object({
    pageId: NonBlankSchema.describe("Paper page id that holds the frame."),
    frameId: NonBlankSchema.describe("Paper artboard node id of the frame."),
  })
  .strict()
  .describe("A Paper frame that shows the composition as designed.");

export const CatalogCompositionSchema = z
  .object({
    id: NonBlankSchema.regex(/^[a-z][a-z0-9-]*$/).describe(
      "Kebab-case composition id, for example work-queue.",
    ),
    description: NonBlankSchema.describe(
      "What screen or region the composition builds and why its parts belong together.",
    ),
    appliesTo: z
      .array(NonBlankSchema)
      .min(1)
      .describe(
        "Where the composition applies: catalog ids, or app module globs containing / or * that match files which build the screen.",
      ),
    requires: z
      .array(CatalogCompositionRequirementSchema)
      .describe(
        "Slots the composition must fill; each slot lists the components that may fill it.",
      ),
    forbids: z
      .array(IdSchema)
      .describe(
        "Catalog ids that must not appear in code the composition applies to.",
      ),
    paper: z
      .array(CatalogCompositionPaperSchema)
      .describe("Paper frames that show the composition."),
  })
  .strict()
  .describe(
    "A rule for assembling several catalog components into one recognizable screen pattern.",
  );

const LEVEL_RANK: Record<(typeof CONSUMER_LEVELS)[number], number> = {
  atom: 0,
  molecule: 1,
  organism: 2,
  template: 3,
  page: 4,
  app: 5,
};

function isGlob(value: string): boolean {
  return value.includes("/") || value.includes("*");
}

export const ComponentCatalogSchema = z
  .object({
    schemaVersion: z
      .literal(1)
      .describe("Catalog format version; bump when the entry shape changes."),
    revision: NonBlankSchema.describe(
      "Opaque digest that identifies the authored catalog revision.",
    ),
    owner: NonBlankSchema.describe("Person accountable for the catalog."),
    rules: z
      .array(CatalogRuleSchema)
      .describe("Shared rules that entries cite by id in usage.ruleIds."),
    requirements: z
      .array(CatalogRequirementSchema)
      .describe(
        "Cross-cutting requirements that entries cite by id in requirementIds.",
      ),
    evidenceSources: z
      .array(CatalogEvidenceSourceSchema)
      .describe("Design document sections that entries cite in evidenceRefs."),
    evidenceSuites: z
      .array(CatalogEvidenceSuiteSchema)
      .describe(
        "Automated suites that coverage maps cite as suite:<name> evidence.",
      ),
    entries: z
      .array(CatalogEntrySchema)
      .describe("Every catalog component; ids and names are unique."),
    compositions: z
      .array(CatalogCompositionSchema)
      .describe(
        "Composition rules that join catalog components into screen patterns.",
      ),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const fail = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const unique = (
      label: string,
      key: string,
      values: string[],
      base: (string | number)[],
    ) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          fail(`duplicate ${label} ${value}`, [...base, index, key]);
        }
        seen.add(value);
      });
    };
    unique("rule id", "id", catalog.rules.map((r) => r.id), ["rules"]);
    unique(
      "requirement id",
      "id",
      catalog.requirements.map((r) => r.id),
      ["requirements"],
    );
    unique(
      "evidence source id",
      "id",
      catalog.evidenceSources.map((r) => r.id),
      ["evidenceSources"],
    );
    unique(
      "evidence suite id",
      "id",
      catalog.evidenceSuites.map((r) => r.id),
      ["evidenceSuites"],
    );
    unique("entry id", "id", catalog.entries.map((e) => e.id), ["entries"]);
    unique("entry name", "name", catalog.entries.map((e) => e.name), [
      "entries",
    ]);
    unique(
      "composition id",
      "id",
      catalog.compositions.map((c) => c.id),
      ["compositions"],
    );

    const ids = new Set(catalog.entries.map((entry) => entry.id));
    const rules = new Set(catalog.rules.map((rule) => rule.id));
    const requirements = new Set(catalog.requirements.map((r) => r.id));
    const sources = new Set(catalog.evidenceSources.map((s) => s.id));
    const unknown = (
      kind: string,
      known: Set<string>,
      value: string,
      path: (string | number)[],
    ) => {
      if (!known.has(value)) fail(`unknown ${kind} ${value}`, path);
    };

    catalog.entries.forEach((entry, index) => {
      const at = (...rest: (string | number)[]) => ["entries", index, ...rest];
      entry.usage.ruleIds.forEach((id, i) =>
        unknown("rule id", rules, id, at("usage", "ruleIds", i))
      );
      entry.requirementIds.forEach((id, i) =>
        unknown("requirement id", requirements, id, at("requirementIds", i))
      );
      entry.evidenceRefs.forEach((id, i) =>
        unknown("evidence source", sources, id, at("evidenceRefs", i))
      );
      entry.usage.alternatives.forEach((alternative, i) => {
        if (!ids.has(alternative.use)) {
          fail(
            `${entry.id} alternative points at unknown catalog id ${alternative.use}`,
            at("usage", "alternatives", i, "use"),
          );
        } else if (alternative.use === entry.id) {
          fail(
            `${entry.id} lists itself as an alternative`,
            at("usage", "alternatives", i, "use"),
          );
        }
      });
      const floor = LEVEL_RANK[entry.level];
      entry.usage.allowedLevels.forEach((level, i) => {
        if (LEVEL_RANK[level] < floor) {
          fail(
            `${entry.id} is ${entry.level} and cannot be imported by ${level}; atomic levels only depend downward`,
            at("usage", "allowedLevels", i),
          );
        }
      });
      const frameIds = new Set<string>();
      entry.paper.forEach((frame, i) => {
        if (frameIds.has(frame.frameId)) {
          fail(
            `${entry.id} lists Paper frame ${frame.frameId} twice`,
            at("paper", i, "frameId"),
          );
        }
        frameIds.add(frame.frameId);
      });
      if (!entry.paper.length && !entry.paperAbsentReason) {
        fail(
          `${entry.id} has no Paper frames and needs paperAbsentReason naming what was searched`,
          at("paperAbsentReason"),
        );
      }
      if (entry.paper.length && entry.paperAbsentReason) {
        fail(
          `${entry.id} has Paper frames, so paperAbsentReason must be omitted`,
          at("paperAbsentReason"),
        );
      }
      if (new Set(entry.tokens).size !== entry.tokens.length) {
        fail(`${entry.id} lists a token twice`, at("tokens"));
      }
    });

    catalog.compositions.forEach((composition, index) => {
      const at = (...rest: (string | number)[]) => [
        "compositions",
        index,
        ...rest,
      ];
      composition.appliesTo.forEach((target, i) => {
        if (!isGlob(target)) {
          unknown("catalog id", ids, target, at("appliesTo", i));
        }
      });
      // Forward ids are allowed only here: a slot may list a component that
      // ships on a later branch, so the same composition text lands on both
      // branches. Each slot must still be satisfiable by a catalog entry.
      composition.requires.forEach((slot, i) => {
        if (!slot.anyOf.some((id) => ids.has(id))) {
          fail(
            `requires slot lists no existing catalog id (${
              slot.anyOf.join(", ")
            })`,
            at("requires", i, "anyOf"),
          );
        }
      });
      composition.forbids.forEach((id, i) =>
        unknown("catalog id", ids, id, at("forbids", i))
      );
    });
  })
  .describe(
    "The whole component catalog: shared rules and requirements, evidence, every component entry and the composition rules that join them.",
  );

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type CatalogComposition = z.infer<typeof CatalogCompositionSchema>;
export type CatalogLevel = (typeof CATALOG_LEVELS)[number];
export type ConsumerLevel = (typeof CONSUMER_LEVELS)[number];
export type ComponentCatalog = z.infer<typeof ComponentCatalogSchema>;

export type ComponentCatalogParse =
  | { success: true; catalog: ComponentCatalog }
  | { success: false; issues: string[] };

/** Parses components.json content; failures come back as flat `path: message` strings. */
export function parseComponentCatalog(value: unknown): ComponentCatalogParse {
  const result = ComponentCatalogSchema.safeParse(value);
  if (result.success) return { success: true, catalog: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) =>
      `${issue.path.join(".") || "(root)"}: ${issue.message}`
    ),
  };
}
