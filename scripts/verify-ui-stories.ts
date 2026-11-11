import { parseComponentCatalog } from "../packages/ui/catalog/schema.ts";
import { wholeArtboardBindingIssues } from "../packages/ui/scripts/paper-whole-artboard.mjs";
import type { WholeArtboardBinding } from "../packages/ui/scripts/paper-whole-artboard.d.mts";
import { loadAdditionalPaperBaselines } from "./ui-paper-manifests.ts";

type CatalogRequiredCase = {
  wholeArtboardCapture?: WholeArtboardBinding;
  id: string;
  variants?: string[];
  states?: string[];
};
type CatalogEntry = {
  requiredCaseCoverage?: "partitioned";
  id: string;
  name: string;
  level: string;
  requiredCases: CatalogRequiredCase[];
  status: "specified" | "implemented";
  storyTitle: string;
  variants?: string[];
  states?: string[];
  themes?: string[];
  layoutProfiles?: string[];
  pointerProfiles?: string[];
  coverage?: CoveragePlan;
};

type CoveragePlan = {
  automated: Record<string, string[]>;
  notApplicable: Record<string, string>;
  visualContexts: string[];
};

export type EvidenceSuite = {
  id: string;
  path: string;
  testTitle: string;
  description: string;
  dimensions: Array<"state" | "theme" | "layout" | "pointer">;
  coveredIdentifiers?: string[];
  source?: string | null;
};

type SpecimenPaperBaseline = {
  id: string;
  reference: "specimen";
  frameId: string;
  pageId: string;
  catalogId: string;
  requiredStoryCase: string;
};
type DesignPaperBaseline = {
  wholeArtboardCapture?: WholeArtboardBinding;
  sourceProfile?: string;
  sourceDigest?: string;
  catalogId?: string;
  requiredStoryCase?: string;
  id: string;
  reference: "design";
  frameId: string;
  pageId: string;
  design: {
    screen: string;
    state: string;
    theme: "light" | "dark";
    device: "desktop" | "phone";
  };
  imagePath: string;
  imageSha256: string;
  viewport: { width: number; height: number };
  artboard: { width: number; height: number };
  image: { width: number; height: number };
  comparisonRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
    candidateOrigin?: "main";
    measure?: string;
  };
  dpr: number;
  theme: "light" | "dark";
  pointer: "fine" | "coarse";
  locale: string;
  direction: string;
  browser: string;
  os: string;
  fontDigests: Record<string, string>;
  candidate: {
    route?: string;
    session?: "anonymous" | "authenticated";
    storyId?: string;
    args?: Record<string, string>;
  };
};

type PaperBaseline = SpecimenPaperBaseline | DesignPaperBaseline;

type PaperSpecimenRecord = {
  id: string;
  paper: {
    fileId: string;
    pageId: string;
    frameId: string;
  };
};

export type PaperSpecimensManifest = {
  schemaVersion: number;
  specimens: PaperSpecimenRecord[];
};

export type PaperBaselineManifest = {
  schemaVersion: number;
  source?: { fileId?: string };
  sourceProfiles?: Record<
    string,
    { source: { manifestPath: string; pageId: string; digest: string } }
  >;
  cases: PaperBaseline[];
  reference?: {
    hidden?: string[];
    overrides?: Record<string, Record<string, string>>;
    capabilities?: "core";
    derived?: string[];
  };
  excluded?: Array<{ screen: string; state: string; reason: string }>;
};

export type PaperManifestScreen = {
  id: string;
  state: string;
  theme: string;
  device: string;
  width: number;
  height: number;
  nodeId: string;
  pageId: string;
};

export type PaperManifest = {
  screens: PaperManifestScreen[];
};

export type StoryIndexEntry = {
  id: string;
  importPath?: string;
  title?: string;
  type?: string;
};

export type RuntimeContext = {
  viewport: { width: number; height: number };
  dpr: number;
  theme: "light" | "dark";
  storedPreference: "system" | "light" | "dark";
  pointer: "fine" | "coarse";
  locale: "en-US" | "en-XA";
  direction: "ltr" | "rtl";
  timezone: string;
  reducedMotion: "no-preference" | "reduce";
  zoom: 1 | 2;
  interaction: "load" | "keyboard-focus";
};

export type SemanticCoverage = {
  variants: string[];
  states: string[];
};

export type RuntimeCase = {
  wholeArtboardCapture?: WholeArtboardBinding;
  args?: Record<string, string>;
  id: string;
  catalogId: string;
  requiredCaseId: string;
  storyId: string;
  context: string;
  paperBaselineId?: string;
  semanticCoverage?: SemanticCoverage;
  assertions?: Array<"axe" | "containment" | "focus" | "target-size">;
};

export type RuntimeManifest = {
  schemaVersion: number;
  contexts: Record<string, RuntimeContext>;
  cases: RuntimeCase[];
};

type Catalog = {
  entries: CatalogEntry[];
  evidenceSuites?: EvidenceSuite[];
};

type StoryBinding = {
  id: string;
  source: string;
  title: string;
  storyId?: string;
  sourceExists?: boolean;
  requiredCases?: string[];
};

const root = new URL("..", import.meta.url);

function storyIndexEntries(index: {
  entries: Record<string, StoryIndexEntry> | StoryIndexEntry[];
}): StoryIndexEntry[] {
  return Array.isArray(index.entries)
    ? index.entries
    : Object.values(index.entries);
}

function sourcePath(importPath: string) {
  if (importPath.startsWith("/")) return importPath;
  return new URL(importPath, new URL("packages/ui/", root)).pathname;
}

function sourceWithoutComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (comment) => comment.replace(/[^\r\n]/g, " "),
  );
}

function sourceMetadata(source: string) {
  const uncommented = sourceWithoutComments(source);
  const parameters = uncommented.match(
    /\bparameters\s*:\s*\{([\s\S]*?)\}/m,
  )?.[1] ?? "";
  const catalogId = parameters.match(
    /\bcatalogId\s*:\s*["']([^"']+)["']/,
  )?.[1];
  const requiredCases = parameters.match(
    /\brequiredCases\s*:\s*\[([^\]]*)\]/,
  )?.[1]
    ?.match(/["']([^"']+)["']/g)
    ?.map((value) => value.slice(1, -1)) ?? [];
  return { catalogId, requiredCases };
}

function publicExportDeclarations(source: string) {
  const uncommented = sourceWithoutComments(source);
  const declarations: Array<{ path: string; names: string[] | null }> = [];
  const pattern =
    /(?:^|\n)\s*export\s+(?:\*\s+from\s+["']([^"']+)["']|\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'])\s*;?/g;
  for (const match of uncommented.matchAll(pattern)) {
    const names = match[2]
      ? match[2].split(",").map((item) => item.trim()).filter(Boolean)
        .filter((item) => !item.startsWith("type "))
        .map((item) => (item.match(/^(\w+)/)?.[1] ?? item))
      : null;
    // Catalog identity is the module, not the file name, so a specifier that
    // names the file with its source extension matches the same entry.
    const path = (match[1] ?? match[3]).replace(/\.(?:ts|tsx|js|jsx|mjs)$/, "");
    declarations.push({ path, names });
  }
  return declarations;
}

function validateContexts(
  contexts: Record<string, RuntimeContext>,
): string[] {
  const errors: string[] = [];
  const widths = new Set<number>();
  const pointerWidths = new Map<string, Set<number>>();
  for (const [id, context] of Object.entries(contexts)) {
    const paperContext = id.startsWith("paper-");
    if (
      !context.viewport ||
      (!paperContext && ![320, 744, 1280].includes(context.viewport.width)) ||
      (paperContext && ![390, 1440].includes(context.viewport.width))
    ) {
      errors.push(`${id} uses an unsupported viewport width`);
    } else {
      if (!paperContext) {
        widths.add(context.viewport.width);
        const pointerSet = pointerWidths.get(context.pointer) ?? new Set();
        pointerSet.add(context.viewport.width);
        pointerWidths.set(context.pointer, pointerSet);
      }
    }
    if (!Number.isFinite(context.dpr) || context.dpr <= 0) {
      errors.push(`${id} has an invalid DPR`);
    }
    if (!context.theme || !["light", "dark"].includes(context.theme)) {
      errors.push(`${id} has an invalid resolved theme`);
    }
    if (
      !context.storedPreference ||
      !["system", "light", "dark"].includes(context.storedPreference)
    ) {
      errors.push(`${id} has an invalid stored preference`);
    }
    if (!context.pointer || !["fine", "coarse"].includes(context.pointer)) {
      errors.push(`${id} has an invalid pointer context`);
    }
    if (!context.locale || !["en-US", "en-XA"].includes(context.locale)) {
      errors.push(`${id} has an unsupported locale`);
    }
    if (!context.direction || !["ltr", "rtl"].includes(context.direction)) {
      errors.push(`${id} has an invalid direction`);
    }
    if (!context.timezone) errors.push(`${id} has no timezone`);
    if (
      !context.reducedMotion ||
      !["no-preference", "reduce"].includes(context.reducedMotion)
    ) {
      errors.push(`${id} has an invalid reduced-motion context`);
    }
    if (![1, 2].includes(context.zoom)) {
      errors.push(`${id} has an invalid zoom`);
    }
    if (
      !context.interaction ||
      !["load", "keyboard-focus"].includes(context.interaction)
    ) {
      errors.push(`${id} has an invalid interaction context`);
    }
  }
  if (
    widths.size !== 3 || ![320, 744, 1280].every((width) => widths.has(width))
  ) {
    errors.push("runtime contexts must cover 320, 744, and 1280 pixel widths");
  }
  for (const pointer of ["fine", "coarse"]) {
    if ((pointerWidths.get(pointer)?.size ?? 0) < 2) {
      errors.push(
        `${pointer} pointer coverage must be independent of viewport width`,
      );
    }
  }
  if (!Object.values(contexts).some((context) => context.theme === "light")) {
    errors.push("runtime contexts must cover light theme");
  }
  if (!Object.values(contexts).some((context) => context.theme === "dark")) {
    errors.push("runtime contexts must cover dark theme");
  }
  for (const interaction of ["keyboard-focus", "load"]) {
    if (
      !Object.values(contexts).some((context) =>
        context.interaction === interaction
      )
    ) {
      errors.push(`runtime contexts must cover ${interaction}`);
    }
  }
  if (!Object.values(contexts).some((context) => context.zoom === 2)) {
    errors.push("runtime contexts must cover 200 percent zoom");
  }
  if (
    !Object.values(contexts).some((context) =>
      context.reducedMotion === "reduce"
    )
  ) {
    errors.push("runtime contexts must cover reduced motion");
  }
  if (!Object.values(contexts).some((context) => context.locale === "en-XA")) {
    errors.push("runtime contexts must cover the deterministic pseudo-locale");
  }
  if (!Object.values(contexts).some((context) => context.direction === "rtl")) {
    errors.push("runtime contexts must cover RTL");
  }
  return errors;
}

function sameValues(left: string[] | undefined, right: string[] | undefined) {
  const leftValues = [...new Set(left ?? [])].sort();
  const rightValues = [...new Set(right ?? [])].sort();
  return leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

export function validateCatalogSemantics(catalog: Catalog): string[] {
  const errors: string[] = [];

  for (const entry of catalog.entries) {
    if (!entry.variants?.length) {
      errors.push(`${entry.id} has no approved semantic variants`);
    }
    if (!entry.states?.length) {
      errors.push(`${entry.id} has no approved semantic states`);
    }
    if (entry.requiredCaseCoverage === "partitioned") {
      for (const dimension of ["variants", "states"] as const) {
        const observed = entry.requiredCases.flatMap((item) =>
          item[dimension] ?? []
        );
        if (!sameValues(observed, entry[dimension])) {
          errors.push(
            `${entry.id} partition does not cover exactly the approved ${dimension}`,
          );
        }
        for (const item of entry.requiredCases) {
          if (
            !item[dimension]?.length ||
            item[dimension]?.some((value) => !entry[dimension]?.includes(value))
          ) {
            errors.push(
              `${entry.id} required case ${item.id} has invalid partition ${dimension}`,
            );
          }
        }
      }
      continue;
    }
    for (const requiredCase of entry.requiredCases) {
      if (!sameValues(requiredCase.variants, entry.variants)) {
        errors.push(
          `${entry.id} required case ${requiredCase.id} does not cover every approved variant`,
        );
      }
      if (!sameValues(requiredCase.states, entry.states)) {
        errors.push(
          `${entry.id} required case ${requiredCase.id} does not cover every approved state`,
        );
      }
    }
  }
  return errors;
}
function semanticCoverageIssues(
  runtimeCase: RuntimeCase,
  requiredCase: CatalogRequiredCase,
): string[] {
  const coverage = runtimeCase.semanticCoverage as unknown as Record<
    string,
    unknown
  >;
  const errors: string[] = [];
  for (const field of ["variants", "states"] as const) {
    const values = coverage?.[field];
    if (!Array.isArray(values) || values.length === 0) {
      errors.push(
        `${runtimeCase.id} semanticCoverage.${field} must be a non-empty array`,
      );
      continue;
    }
    const canonical = new Set(requiredCase[field] ?? []);
    if (
      values.some((value) => typeof value !== "string" || !canonical.has(value))
    ) {
      errors.push(
        `${runtimeCase.id} semanticCoverage.${field} must be a subset of ${runtimeCase.catalogId} ${runtimeCase.requiredCaseId} ${field}`,
      );
    }
  }
  return errors;
}

export function validateRuntimeManifest(
  manifest: RuntimeManifest,
  catalog: Catalog,
  indexEntries: StoryIndexEntry[],
  requireMatrix = true,
): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) {
    errors.push("Unsupported runtime case schema version");
  }
  if (!manifest.contexts || !manifest.cases) {
    return ["Runtime manifest must contain contexts and cases"];
  }
  errors.push(...validateContexts(manifest.contexts));
  errors.push(...validateCatalogSemantics(catalog));
  const catalogById = new Map(
    catalog.entries.map((entry) => [entry.id, entry]),
  );
  const storiesById = new Map(indexEntries.map((entry) => [entry.id, entry]));
  const seenCaseIds = new Set<string>();
  const seenPaperIds = new Set<string>();
  const covered = new Set<string>();
  const casesByContext = new Map<string, number>();
  for (const runtimeCase of manifest.cases) {
    if (!/^[-a-zA-Z0-9.]+$/.test(runtimeCase.id)) {
      errors.push(`invalid runtime case ID ${runtimeCase.id}`);
    }
    if (seenCaseIds.has(runtimeCase.id)) {
      errors.push(`runtime case ${runtimeCase.id} is duplicated`);
    }
    seenCaseIds.add(runtimeCase.id);
    const catalogEntry = catalogById.get(runtimeCase.catalogId);
    if (!catalogEntry) {
      errors.push(
        `${runtimeCase.id} binds unknown catalog ID ${runtimeCase.catalogId}`,
      );
    } else {
      if (
        !catalogEntry.requiredCases.some((entry) =>
          entry.id === runtimeCase.requiredCaseId
        )
      ) {
        errors.push(
          `${runtimeCase.id} maps unknown required case ${runtimeCase.requiredCaseId}`,
        );
      }
      covered.add(`${runtimeCase.catalogId}:${runtimeCase.requiredCaseId}`);
      const story = storiesById.get(runtimeCase.storyId);
      if (!story || story.type !== "story") {
        errors.push(
          `${runtimeCase.id} references unknown Storybook story ${runtimeCase.storyId}`,
        );
      } else if (story.title !== catalogEntry.storyTitle) {
        errors.push(
          `${runtimeCase.id} uses ${JSON.stringify(story.title)}, expected ${
            JSON.stringify(catalogEntry.storyTitle)
          }`,
        );
      }
    }
    if (runtimeCase.semanticCoverage !== undefined) {
      if (!runtimeCase.paperBaselineId) {
        errors.push(
          `${runtimeCase.id} semanticCoverage requires paperBaselineId`,
        );
      } else if (catalogEntry) {
        const requiredCase = catalogEntry.requiredCases.find((entry) =>
          entry.id === runtimeCase.requiredCaseId
        );
        if (requiredCase) {
          if (
            JSON.stringify(requiredCase.wholeArtboardCapture) !==
              JSON.stringify(runtimeCase.wholeArtboardCapture)
          ) {
            errors.push(
              `${runtimeCase.id} whole-artboard catalog/runtime binding differs`,
            );
          }
          errors.push(...semanticCoverageIssues(runtimeCase, requiredCase));
        }
      }
    }
    if (!manifest.contexts[runtimeCase.context]) {
      errors.push(
        `${runtimeCase.id} references unknown context ${runtimeCase.context}`,
      );
    }
    casesByContext.set(
      runtimeCase.context,
      (casesByContext.get(runtimeCase.context) ?? 0) + 1,
    );
    if (runtimeCase.paperBaselineId) {
      if (seenPaperIds.has(runtimeCase.paperBaselineId)) {
        errors.push(
          `Paper baseline ${runtimeCase.paperBaselineId} is linked more than once`,
        );
      }
      seenPaperIds.add(runtimeCase.paperBaselineId);
    }
    for (const assertion of runtimeCase.assertions ?? []) {
      if (
        !new Set(["axe", "containment", "focus", "target-size"]).has(assertion)
      ) {
        errors.push(`${runtimeCase.id} has unknown assertion ${assertion}`);
      }
    }
  }
  for (const contextId of Object.keys(manifest.contexts)) {
    if (!casesByContext.has(contextId)) {
      errors.push(`missing runtime case for ${contextId}`);
    }
  }
  if (requireMatrix) {
    for (const entry of catalog.entries) {
      for (const requiredCase of entry.requiredCases) {
        if (!covered.has(`${entry.id}:${requiredCase.id}`)) {
          errors.push(`${entry.id} has no runtime case for ${requiredCase.id}`);
        }
      }
    }
  }
  return errors;
}

export function validateCatalogLifecycle(
  catalog: Catalog,
  publicExports: string,
  bindings: StoryBinding[],
  runtime: RuntimeManifest,
  componentSources: ReadonlyMap<string, string> = new Map(),
): string[] {
  const errors: string[] = [];
  const declarations = publicExportDeclarations(publicExports);
  const bindingsById = new Map(
    bindings.map((binding) => [binding.id, binding]),
  );
  for (const entry of catalog.entries) {
    if (entry.status !== "specified" && entry.status !== "implemented") {
      errors.push(`${entry.id} has invalid lifecycle status ${entry.status}`);
      continue;
    }
    if (entry.status !== "implemented") {
      errors.push(
        `${entry.id} is still specified and has no implementation state`,
      );
      continue;
    }
    if (entry.level !== "page") {
      const directory = {
        atom: "atoms",
        molecule: "molecules",
        organism: "organisms",
        template: "templates",
      }[entry.level];
      const exportPath = directory ? `./${directory}/${entry.name}` : null;
      const exports = exportPath
        ? declarations.filter((declaration) => declaration.path === exportPath)
        : [];
      const namedExport = exports.some((declaration) =>
        declaration.names === null || declaration.names.includes(entry.name)
      );
      if (!exportPath || exports.length !== 1 || !namedExport) {
        errors.push(
          `${entry.id} must have exactly one public package export, found ${exports.length}`,
        );
      }
      const componentSource = componentSources.get(entry.id);
      const declarationPattern = new RegExp(
        `\\bexport\\s+(?:(?:default)\\s+)?(?:function|class|const|let)\\s+${entry.name}\\b`,
      );
      if (
        !componentSource ||
        !declarationPattern.test(sourceWithoutComments(componentSource))
      ) {
        errors.push(`${entry.id} has no real source declaration`);
      }
    }
    const binding = bindingsById.get(entry.id);
    if (
      !binding || !binding.source.trim() || !binding.title.trim() ||
      binding.sourceExists !== true || !binding.storyId
    ) {
      errors.push(`${entry.id} has no real Storybook binding`);
    }
    if (
      binding &&
      !sameValues(
        binding.requiredCases,
        entry.requiredCases.map((requiredCase) => requiredCase.id),
      )
    ) {
      errors.push(
        `${entry.id} Storybook binding does not exactly map required cases`,
      );
    }
    for (const requiredCase of entry.requiredCases) {
      const cases = runtime.cases.filter((runtimeCase) =>
        runtimeCase.catalogId === entry.id &&
        runtimeCase.requiredCaseId === requiredCase.id
      );
      if (!cases.length) {
        errors.push(
          `${entry.id} has no runtime coverage for ${requiredCase.id}`,
        );
      } else if (
        binding &&
        cases.some((runtimeCase) => runtimeCase.storyId !== binding.storyId)
      ) {
        errors.push(
          `${entry.id} runtime coverage for ${requiredCase.id} does not use its real Storybook story`,
        );
      }
    }
  }
  for (const runtimeCase of runtime.cases) {
    const binding = bindingsById.get(runtimeCase.catalogId);
    if (binding && runtimeCase.storyId !== binding.storyId) {
      errors.push(
        `${runtimeCase.id} is not bound to the catalog entry's real Storybook story`,
      );
    }
  }
  return errors;
}

function meaningfulReason(
  reason: unknown,
  identifier: string,
): reason is string {
  if (typeof reason !== "string") return false;
  const trimmed = reason.trim();
  if (
    trimmed.length < 12 ||
    /^(?:todo|tbd|n\/?a|not applicable)(?:\b|$)/i.test(trimmed)
  ) return false;
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalize(trimmed) !== normalize(identifier);
}

function coverageUniverse(entry: CatalogEntry): Set<string> {
  return new Set([
    ...(entry.themes ?? []).map((theme) => `theme:${theme}`),
    ...(entry.layoutProfiles ?? []).map((layout) => `layout:${layout}`),
    ...(entry.pointerProfiles ?? []).map((pointer) => `pointer:${pointer}`),
  ]);
}

function runtimeExercisesIdentifier(
  _runtimeCase: RuntimeCase,
  context: RuntimeContext | undefined,
  identifier: string,
): boolean {
  if (!context) return false;
  const [dimension, value] = identifier.split(":", 2);
  if (dimension === "theme") return context.theme === value;
  if (dimension === "pointer") return context.pointer === value;
  if (dimension === "layout") {
    const layout = context.viewport.width <= 390
      ? "sheet"
      : context.viewport.width < 1024
      ? "pane"
      : "rail";
    return layout === value;
  }
  return false;
}

export function validateCoveragePlan(
  catalog: Catalog,
  runtime: RuntimeManifest,
  suites: EvidenceSuite[],
): string[] {
  const errors: string[] = [];
  const runtimeById = new Map(runtime.cases.map((runtimeCase) => [
    runtimeCase.id,
    runtimeCase,
  ]));
  const suitesByReference = new Map<string, EvidenceSuite>();
  const seenSuiteIds = new Set<string>();
  const coverageDimensions = new Set(["state", "theme", "layout", "pointer"]);
  for (const suite of suites) {
    if (seenSuiteIds.has(suite.id)) {
      errors.push(`evidence suite ${suite.id} is duplicated`);
    }
    seenSuiteIds.add(suite.id);
    const reference = suite.id.startsWith("suite.")
      ? `suite:${suite.id.slice("suite.".length)}`
      : suite.id;
    suitesByReference.set(reference, suite);
    if (!suite.path.trim() || suite.source == null) {
      errors.push(`evidence suite ${suite.id} path ${suite.path} is absent`);
    } else if (
      !suite.testTitle.trim() || !suite.source.includes(suite.testTitle)
    ) {
      errors.push(
        `evidence suite ${suite.id} test title ${
          JSON.stringify(suite.testTitle)
        } is absent from ${suite.path}`,
      );
    }
    if (!suite.description.trim()) {
      errors.push(`evidence suite ${suite.id} has a blank description`);
    }
    if (!Array.isArray(suite.dimensions) || suite.dimensions.length === 0) {
      errors.push(`evidence suite ${suite.id} declares no covered dimensions`);
    } else {
      for (const dimension of suite.dimensions) {
        if (!coverageDimensions.has(dimension)) {
          errors.push(
            `evidence suite ${suite.id} declares unknown dimension ${dimension}`,
          );
        }
      }
    }
  }

  for (const entry of catalog.entries) {
    const coverage = entry.coverage;
    if (!coverage) {
      errors.push(`${entry.id} has no coverage plan`);
      continue;
    }
    const universe = coverageUniverse(entry);
    const classifications = new Map<string, number>();
    const classify = (identifier: string) => {
      classifications.set(
        identifier,
        (classifications.get(identifier) ?? 0) + 1,
      );
    };

    for (
      const [identifier, references] of Object.entries(
        coverage.automated ?? {},
      )
    ) {
      classify(identifier);
      if (!Array.isArray(references) || references.length === 0) {
        errors.push(
          `${entry.id} ${identifier} has an empty automated reference list`,
        );
        continue;
      }
      for (const reference of references) {
        if (reference.startsWith("runtime:")) {
          const runtimeCase = runtimeById.get(
            reference.slice("runtime:".length),
          );
          if (!runtimeCase) {
            errors.push(
              `${entry.id} ${identifier} references unknown runtime case ${reference}`,
            );
          } else if (runtimeCase.catalogId !== entry.id) {
            errors.push(
              `${entry.id} ${identifier} references runtime case ${reference} owned by ${runtimeCase.catalogId}`,
            );
          } else if (
            !runtimeExercisesIdentifier(
              runtimeCase,
              runtime.contexts[runtimeCase.context],
              identifier,
            )
          ) {
            errors.push(
              `${entry.id} ${identifier} references runtime case ${reference} which does not exercise that value`,
            );
          }
        } else if (reference.startsWith("suite:")) {
          const suite = suitesByReference.get(reference);
          if (!suite) {
            errors.push(
              `${entry.id} ${identifier} references unknown evidence suite ${reference}`,
            );
          } else {
            const dimension = identifier.split(
              ":",
              1,
            )[0] as EvidenceSuite["dimensions"][number];
            if (!suite.dimensions?.includes(dimension)) {
              errors.push(
                `${entry.id} ${identifier} references evidence suite ${reference} which does not declare the ${dimension} dimension`,
              );
            } else if (!suite.coveredIdentifiers?.includes(identifier)) {
              errors.push(
                `${entry.id} ${identifier} references evidence suite ${reference} which does not cover that value`,
              );
            }
          }
        } else {
          errors.push(
            `${entry.id} ${identifier} has unsupported evidence reference ${reference}`,
          );
        }
      }
    }

    for (
      const [identifier, reason] of Object.entries(
        coverage.notApplicable ?? {},
      )
    ) {
      classify(identifier);
      if (!meaningfulReason(reason, identifier)) {
        errors.push(
          `${entry.id} ${identifier} has an unreasoned not-applicable disposition`,
        );
      }
    }

    for (const identifier of universe) {
      const count = classifications.get(identifier) ?? 0;
      if (count !== 1) {
        errors.push(`${entry.id} ${identifier} is classified ${count} times`);
      }
    }
    for (const identifier of classifications.keys()) {
      if (!universe.has(identifier)) {
        errors.push(`${entry.id} classifies unknown identifier ${identifier}`);
      }
    }

    if (
      !Array.isArray(coverage.visualContexts) ||
      coverage.visualContexts.length === 0
    ) {
      errors.push(`${entry.id} has no visual context`);
    }
    for (const context of coverage.visualContexts ?? []) {
      if (
        !runtime.cases.some((runtimeCase) =>
          runtimeCase.catalogId === entry.id && runtimeCase.context === context
        )
      ) {
        errors.push(
          `${entry.id} visual context ${context} has no runtime case`,
        );
      }
    }
  }
  return errors;
}

export function validateVisualClosure(
  catalog: Catalog,
  runtime: RuntimeManifest,
  baselines: PaperBaselineManifest,
  paperManifest: PaperManifest,
  specimens: PaperSpecimensManifest = { schemaVersion: 1, specimens: [] },
  profileManifests: Record<string, PaperManifest> = {},
  additionalBaselines: readonly PaperBaselineManifest[] = [],
): string[] {
  const errors: string[] = [];
  const bindingManifests = [baselines, ...additionalBaselines];
  for (const manifest of bindingManifests) {
    if (manifest.schemaVersion !== 2) {
      errors.push("Unsupported Paper baseline schema version");
    }
  }
  const bindingCases = bindingManifests.flatMap((manifest) => manifest.cases);
  const seenBaselineIds = new Set<string>();
  for (const baselineCase of bindingCases) {
    if (seenBaselineIds.has(baselineCase.id)) {
      errors.push(`Paper baseline ${baselineCase.id} is duplicated`);
    }
    seenBaselineIds.add(baselineCase.id);
  }

  const specimenCases = baselines.cases.filter((
    baselineCase,
  ): baselineCase is SpecimenPaperBaseline =>
    baselineCase.reference === "specimen"
  );
  if (specimens.schemaVersion !== 1) {
    errors.push("Unsupported Paper specimen schema version");
  }
  const specimensById = new Map<string, PaperSpecimenRecord>();
  for (const specimen of specimens.specimens ?? []) {
    if (specimensById.has(specimen.id)) {
      errors.push(`Paper specimen ${specimen.id} is duplicated`);
    }
    specimensById.set(specimen.id, specimen);
  }
  for (const baseline of specimenCases) {
    const specimen = specimensById.get(baseline.id);
    if (!specimen) {
      errors.push(
        `Paper baseline ${baseline.id} has no matching paper specimen record`,
      );
      continue;
    }
    const paper = specimen.paper;
    if (
      !paper ||
      typeof paper.fileId !== "string" ||
      typeof paper.pageId !== "string" ||
      typeof paper.frameId !== "string"
    ) {
      errors.push(
        `Paper specimen ${specimen.id} lacks fileId, pageId, or frameId`,
      );
      continue;
    }
    if (baselines.source?.fileId !== paper.fileId) {
      errors.push(
        `${baseline.id} source.fileId does not match paper specimen ${specimen.id}`,
      );
    }
    if (baseline.pageId !== paper.pageId) {
      errors.push(
        `${baseline.id} pageId does not match paper specimen ${specimen.id}`,
      );
    }
    if (baseline.frameId !== paper.frameId) {
      errors.push(
        `${baseline.id} frameId does not match paper specimen ${specimen.id}`,
      );
    }
  }
  const baselinesById = new Map(
    bindingCases.map((baseline) => [baseline.id, baseline]),
  );
  const linkedBaselineIds = new Set<string>();
  for (const runtimeCase of runtime.cases) {
    if (!runtimeCase.paperBaselineId) continue;
    if (linkedBaselineIds.has(runtimeCase.paperBaselineId)) {
      errors.push(
        `Paper baseline ${runtimeCase.paperBaselineId} is bound more than once`,
      );
    }
    linkedBaselineIds.add(runtimeCase.paperBaselineId);
    const baseline = baselinesById.get(runtimeCase.paperBaselineId);
    if (!baseline) {
      errors.push(
        `${runtimeCase.id} references missing Paper baseline ${runtimeCase.paperBaselineId}`,
      );
      continue;
    }
    if (
      baseline.catalogId !== runtimeCase.catalogId ||
      baseline.requiredStoryCase !== runtimeCase.requiredCaseId
    ) {
      errors.push(
        `${runtimeCase.id} does not match Paper baseline ${baseline.id}`,
      );
    }
  }
  for (
    const baseline of bindingCases.filter((item) =>
      item.reference === "specimen" || item.candidate.storyId
    )
  ) {
    if (!linkedBaselineIds.has(baseline.id)) {
      errors.push(`Paper baseline ${baseline.id} is orphaned`);
    }
  }
  for (const entry of catalog.entries) {
    for (const context of entry.coverage?.visualContexts ?? []) {
      if (
        !runtime.cases.some((runtimeCase) =>
          runtimeCase.catalogId === entry.id && runtimeCase.context === context
        )
      ) {
        errors.push(
          `${entry.id} visual context ${context} has no runtime case`,
        );
      }
    }
  }

  if (
    baselines.reference?.capabilities !== undefined &&
    baselines.reference.capabilities !== "core"
  ) {
    errors.push('Paper baseline reference.capabilities must be "core"');
  }
  if (
    baselines.reference?.derived !== undefined &&
    baselines.reference.capabilities === undefined
  ) {
    errors.push(
      "Paper baseline reference.derived requires reference.capabilities",
    );
  }
  const designCases = baselines.cases.filter((
    baselineCase,
  ): baselineCase is DesignPaperBaseline =>
    baselineCase.reference === "design"
  );
  const screensByKey = new Map(
    paperManifest.screens.map((screen) => [
      `${screen.id}.${screen.state}.${screen.theme}.${screen.device}`,
      screen,
    ]),
  );
  for (const designCase of designCases) {
    const expectedId =
      `${designCase.design.screen}.${designCase.design.state}.${designCase.design.theme}.${designCase.design.device}`;
    if (designCase.id !== expectedId) {
      errors.push(
        `Paper design case ${designCase.id} id does not match its design fields (expected ${expectedId})`,
      );
    }
    const profile = designCase.sourceProfile;
    const source = profile
      ? baselines.sourceProfiles?.[profile]?.source
      : undefined;
    const profileScreen = profileManifests[profile ?? ""]?.screens.find((
      item,
    ) =>
      `${item.id}.${item.state}.${item.theme}.${item.device}` === expectedId
    );
    const screen = profile
      ? profileScreen && { ...profileScreen, pageId: source?.pageId }
      : screensByKey.get(expectedId);
    if (profile && (!source || source.digest !== designCase.sourceDigest)) {
      errors.push(`${designCase.id} source profile digest does not match`);
    }
    if (!screen) {
      errors.push(
        `Paper design case ${designCase.id} has no matching paper-manifest screen for ${expectedId}`,
      );
    } else {
      if (
        designCase.frameId !== screen.nodeId ||
        designCase.pageId !== screen.pageId
      ) {
        errors.push(
          `${designCase.id} frameId/pageId does not match paper-manifest screen ${expectedId}`,
        );
      }
      if (
        !designCase.artboard ||
        designCase.artboard.width !== screen.width ||
        designCase.artboard.height !== screen.height
      ) {
        errors.push(
          `${designCase.id} artboard dimensions do not match paper-manifest screen ${expectedId}`,
        );
      }
    }
    // `image` is what the committed reference PNG measures. It must equal
    // the Paper frame unless the capability derivation edits this screen
    // (`reference.derived`): omitted blocks may release height, but a derived
    // render is never taller or wider than the artboard it derives from.
    const derived = baselines.reference?.capabilities === "core" &&
      (baselines.reference.derived ?? []).includes(designCase.design.screen);
    if (
      !designCase.image ||
      !Number.isInteger(designCase.image.width) ||
      !Number.isInteger(designCase.image.height)
    ) {
      errors.push(`${designCase.id} lacks recorded image dimensions`);
    } else if (designCase.artboard) {
      if (designCase.image.width !== designCase.artboard.width) {
        errors.push(
          `${designCase.id} image width ${designCase.image.width} differs from artboard width ${designCase.artboard.width}`,
        );
      }
      if (
        derived
          ? designCase.image.height > designCase.artboard.height
          : designCase.image.height !== designCase.artboard.height
      ) {
        errors.push(
          `${designCase.id} image height ${designCase.image.height} ${
            derived ? "exceeds" : "differs from"
          } artboard height ${designCase.artboard.height}`,
        );
      }
    }
    const region = designCase.comparisonRegion;
    if (region !== undefined) {
      const integers = [region.x, region.y, region.width, region.height]
        .every(Number.isInteger);
      const image = designCase.image ?? { width: 0, height: 0 };
      if (
        !integers || region.width <= 0 || region.height <= 0 ||
        region.x < 0 || region.y < 0 ||
        region.x + region.width > image.width ||
        region.y + region.height > image.height
      ) {
        errors.push(
          `${designCase.id} comparison region must be an integer rectangle inside the reference image`,
        );
      }
      if (
        region.candidateOrigin !== undefined &&
        region.candidateOrigin !== "main"
      ) {
        errors.push(
          `${designCase.id} comparison region candidateOrigin must be "main"`,
        );
      }
    }
    errors.push(
      ...wholeArtboardBindingIssues(designCase).map((issue) =>
        `${designCase.id}: ${issue}`
      ),
    );
    const story = designCase.candidate?.storyId;
    if (story) {
      const binding = runtime.cases.find((item) =>
        item.paperBaselineId === designCase.id
      );
      const context = binding && runtime.contexts[binding.context];
      if (
        !binding || binding.storyId !== story ||
        JSON.stringify(binding.wholeArtboardCapture) !==
          JSON.stringify(designCase.wholeArtboardCapture) ||
        JSON.stringify(binding.args) !==
          JSON.stringify(designCase.candidate.args) ||
        JSON.stringify(context?.viewport) !==
          JSON.stringify(designCase.viewport) ||
        context?.pointer !== designCase.pointer
      ) {
        errors.push(
          `${designCase.id} story capture binding does not match runtime case`,
        );
      }
      if (!profile || designCase.comparisonRegion) {
        errors.push(
          `${designCase.id} source-shaped story requires an explicit profile and an unmasked full frame`,
        );
      }
    }
    if (!story && !designCase.candidate?.route?.startsWith("/__fixtures__/")) {
      errors.push(
        `${designCase.id} candidate route must start with /__fixtures__/`,
      );
    }
    if (
      !story &&
      !["anonymous", "authenticated"].includes(
        designCase.candidate?.session ?? "",
      )
    ) {
      errors.push(
        `${designCase.id} candidate session must be anonymous or authenticated`,
      );
    }
    const isPhone = designCase.design.device === "phone";
    const expectedViewport = story
      ? designCase.artboard
      : isPhone
      ? { width: 390, height: 844 }
      : { width: 1440, height: 960 };
    if (
      designCase.viewport?.width !== expectedViewport.width ||
      designCase.viewport?.height !== expectedViewport.height
    ) {
      errors.push(
        `${designCase.id} viewport must be ${expectedViewport.width}x${expectedViewport.height} for device ${designCase.design.device}`,
      );
    }
    const expectedPointer = isPhone ? "coarse" : "fine";
    if (designCase.pointer !== expectedPointer) {
      errors.push(
        `${designCase.id} pointer must be ${expectedPointer} for device ${designCase.design.device}`,
      );
    }
  }

  const designCaseKeys = new Set(
    designCases.map((designCase) =>
      `${designCase.design.screen}.${designCase.design.state}`
    ),
  );
  for (const excluded of baselines.excluded ?? []) {
    const matchesManifest = paperManifest.screens.some((screen) =>
      screen.id === excluded.screen && screen.state === excluded.state
    );
    if (!matchesManifest) {
      errors.push(
        `excluded entry ${excluded.screen}.${excluded.state} does not reference a real paper-manifest screen/state`,
      );
    }
    if (designCaseKeys.has(`${excluded.screen}.${excluded.state}`)) {
      errors.push(
        `excluded entry ${excluded.screen}.${excluded.state} is also present as a design case`,
      );
    }
  }

  return errors;
}

// The recorded `image` dimensions of every design case must be the committed
// PNG's own IHDR width/height: render-paper-references.mjs writes both from
// the same bytes, so a mismatch means the manifest was edited by hand.
export async function validateDesignImages(
  baselines: PaperBaselineManifest,
): Promise<string[]> {
  const errors: string[] = [];
  for (const baselineCase of baselines.cases) {
    if (baselineCase.reference !== "design" || !baselineCase.image) continue;
    let header: Uint8Array;
    try {
      const file = await Deno.open(new URL(baselineCase.imagePath, root));
      header = new Uint8Array(24);
      const read = await file.read(header);
      file.close();
      if (read !== 24) throw new Error("short read");
    } catch {
      errors.push(`${baselineCase.id} reference image is missing`);
      continue;
    }
    const view = new DataView(header.buffer);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (
      width !== baselineCase.image.width ||
      height !== baselineCase.image.height
    ) {
      errors.push(
        `${baselineCase.id} recorded image ${baselineCase.image.width}x${baselineCase.image.height} differs from the committed PNG ${width}x${height}`,
      );
    }
  }
  return errors;
}

export async function verifyStorybookArtifacts(
  indexPath = "packages/ui/storybook-static/index.json",
): Promise<void> {
  const catalogJson: unknown = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/ui-baselines/components.json", root),
    ),
  );
  const catalogSchema = parseComponentCatalog(catalogJson);
  const catalog = catalogJson as Catalog;
  const publicExports = await Deno.readTextFile(
    new URL("packages/ui/src/index.ts", root),
  );
  const exportDeclarations = publicExportDeclarations(publicExports);
  const index = JSON.parse(
    await Deno.readTextFile(new URL(indexPath, root)),
  ) as { entries: Record<string, StoryIndexEntry> | StoryIndexEntry[] };
  const indexEntries = storyIndexEntries(index);
  const bindings: Array<StoryBinding & { requiredCases: string[] }> = [];
  const componentSources = new Map<string, string>();

  for (const entry of indexEntries.filter((entry) => entry.type === "story")) {
    if (!entry.importPath) continue;
    const source = await Deno.readTextFile(sourcePath(entry.importPath));
    const metadata = sourceMetadata(source);
    if (!metadata.catalogId) continue;
    bindings.push({
      id: metadata.catalogId,
      title: entry.title ?? "",
      source: entry.importPath,
      storyId: entry.id,
      sourceExists: true,
      requiredCases: metadata.requiredCases,
    });
  }

  for (const entry of catalog.entries) {
    if (entry.level === "page") continue;
    const directory = {
      atom: "atoms",
      molecule: "molecules",
      organism: "organisms",
      template: "templates",
    }[entry.level];
    if (!directory) continue;
    try {
      componentSources.set(
        entry.id,
        await Deno.readTextFile(
          new URL(
            `packages/ui/src/${directory}/${entry.name}.tsx`,
            root,
          ),
        ),
      );
    } catch {
      componentSources.set(entry.id, "");
    }
  }

  const errors: string[] = [];
  if (!catalogSchema.success) {
    errors.push(
      ...catalogSchema.issues.map((issue) =>
        `components.json violates packages/ui/catalog/schema.ts: ${issue}`
      ),
    );
  }
  if (bindings.length !== catalog.entries.length) {
    errors.push(
      `Storybook must expose ${catalog.entries.length} catalog bindings, found ${bindings.length}`,
    );
  }
  const seenIds = new Set<string>();
  for (const binding of bindings) {
    const catalogEntry = catalog.entries.find((entry) =>
      entry.id === binding.id
    );
    if (!catalogEntry) {
      errors.push(`${binding.source} binds unknown catalog ID ${binding.id}`);
      continue;
    }
    if (seenIds.has(binding.id)) {
      errors.push(`catalog ID ${binding.id} is bound more than once`);
    }
    seenIds.add(binding.id);
    if (binding.title !== catalogEntry.storyTitle) {
      errors.push(
        `${binding.id} uses ${JSON.stringify(binding.title)}, expected ${
          JSON.stringify(catalogEntry.storyTitle)
        }`,
      );
    }
    if (
      !sameValues(
        binding.requiredCases,
        catalogEntry.requiredCases.map((required) => required.id),
      )
    ) {
      errors.push(`${binding.id} does not exactly map required cases`);
    }
    if (
      catalogEntry.level === "page" && !binding.source.includes("/examples/")
    ) {
      errors.push(
        `${binding.id} must remain an application example under src/examples`,
      );
    }
  }

  for (const entry of catalog.entries) {
    if (!seenIds.has(entry.id)) {
      errors.push(`missing Storybook binding for ${entry.id}`);
    }
    if (entry.level !== "page") {
      const directory = {
        atom: "atoms",
        molecule: "molecules",
        organism: "organisms",
        template: "templates",
      }[entry.level];
      const exportPath = `./${directory}/${entry.name}`;
      const publicExportCount = exportDeclarations.filter((declaration) =>
        declaration.path === exportPath
      ).length;
      if (publicExportCount !== 1) {
        errors.push(
          `${entry.id} must have exactly one public package export, found ${publicExportCount}`,
        );
      }
    }
  }

  const runtime = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/ui-baselines/runtime-cases.json", root),
    ),
  ) as RuntimeManifest;
  errors.push(...validateRuntimeManifest(runtime, catalog, indexEntries));
  errors.push(
    ...validateCatalogLifecycle(
      catalog,
      publicExports,
      bindings,
      runtime,
      componentSources,
    ),
  );
  const paperBaselines = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/ui-baselines/paper-baselines.json", root),
    ),
  ) as PaperBaselineManifest;
  const paperManifest = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/auth-mocks/paper-manifest.json", root),
    ),
  ) as PaperManifest;
  const paperSpecimens = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/ui-baselines/paper-specimens.json", root),
    ),
  ) as PaperSpecimensManifest;
  const profileManifests: Record<string, PaperManifest> = {};
  for (
    const [id, profile] of Object.entries(paperBaselines.sourceProfiles ?? {})
  ) {
    profileManifests[id] = JSON.parse(
      await Deno.readTextFile(new URL(profile.source.manifestPath, root)),
    );
  }
  errors.push(
    ...validateVisualClosure(
      catalog,
      runtime,
      paperBaselines,
      paperManifest,
      paperSpecimens,
      profileManifests,
      await loadAdditionalPaperBaselines(),
    ),
    ...await validateDesignImages(paperBaselines),
  );
  const suites = await Promise.all((catalog.evidenceSuites ?? []).map(
    async (suite): Promise<EvidenceSuite> => {
      const safePath = !suite.path.startsWith("/") &&
        !suite.path.split("/").includes("..");
      if (!safePath) return { ...suite, source: null };
      try {
        return {
          ...suite,
          source: await Deno.readTextFile(new URL(suite.path, root)),
        };
      } catch {
        return { ...suite, source: null };
      }
    },
  ));
  errors.push(
    ...new Set(validateCoveragePlan(catalog, runtime, suites)),
  );
  if (errors.length) {
    throw new Error(`UI story verification failed:\n${errors.join("\n")}`);
  }
  console.log(
    `Verified ${bindings.length} canonical Storybook catalog bindings and ${runtime.cases.length} runtime cases.`,
  );
}

if (import.meta.main) await verifyStorybookArtifacts();
