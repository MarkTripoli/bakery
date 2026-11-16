import { assert, assertEquals } from "@std/assert";
import {
  compileWorkflowDocument,
  decodeWorkflowJson,
  decodeWorkflowYaml,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  WORKFLOW_PRESET_IDS,
  WORKFLOW_PRESETS,
} from "../../packages/contracts/src/workflow-presets.ts";

// #396, chapter 25 section 2 (O1, O2, O12): one interpreter decides what runs
// next, the flat preset executor is frozen, and the engine names no template.
// These rails read source text, so a new violation fails here before review.
// Today's known violations are allow-listed below, each with the backlog issue
// that removes it; an entry that no longer matches fails too, so the lists only
// shrink.

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const join = (...parts: string[]) => parts.join("/");
const relative = (path: string) => path.slice(ROOT.length + 1);
const PRESETS_MODULE = "packages/contracts/src/workflow-presets.ts";

type Allowed = Readonly<{ file: string; line: string; issue: string }>;

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(path);
    } else if (entry.isFile) yield path;
  }
}

async function filesUnder(
  dir: string,
  keep: (rel: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  for await (const path of walk(join(ROOT, dir))) {
    const rel = relative(path);
    if (keep(rel)) out.push(rel);
  }
  return out.sort();
}

const isSource = (rel: string) =>
  rel.endsWith(".ts") && !rel.endsWith("_test.ts") && !rel.endsWith(".d.ts");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every slug a preset is known by: its id and its materialized definition slug. */
const PRESET_SLUGS = [
  ...new Set([
    ...WORKFLOW_PRESET_IDS,
    ...WORKFLOW_PRESETS.flatMap((preset) => [preset.id, preset.slug]),
  ]),
].sort((a, b) => b.length - a.length);

/** A string literal that carries a preset slug as a whole word. */
// A preset slug as a whole word anywhere on a non-comment line: a quote on
// the same line isn't required, so a slug alone on a line inside a multi-line
// template literal is caught too (qa-qa on #470).
const SLUG_IN_STRING = new RegExp(
  `(?<![\\w-])(?:${PRESET_SLUGS.map(escape).join("|")})(?![\\w-])`,
);

/** An import or re-export of a presets module (contracts or server). */
const PRESETS_IMPORT =
  /(?:from\s*|import\s*\(\s*)["'][^"']*workflow-presets(?:\.ts)?["']/;

/** The preset exports of the contracts presets module, read from its source. */
async function presetExportNames(): Promise<string[]> {
  const text = await Deno.readTextFile(join(ROOT, PRESETS_MODULE));
  const names = [
    ...text.matchAll(/export\s+(?:const|function)\s+([A-Za-z_]\w*)/g),
  ].map((match) => match[1]!);
  return names.filter((name) => /preset/i.test(name));
}

const isComment = (line: string) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** Every code line in `files` that names a preset, as `file`/`line` pairs. */
async function presetMentions(files: string[], base = ROOT) {
  const names = await presetExportNames();
  assert(names.length > 0, "the presets module exports no preset names");
  const identifier = new RegExp(`\\b(?:${names.map(escape).join("|")})\\b`);
  const found: { file: string; line: string }[] = [];
  for (const file of files) {
    const lines = (await Deno.readTextFile(join(base, file))).split("\n");
    for (const raw of lines) {
      if (isComment(raw)) continue;
      if (
        SLUG_IN_STRING.test(raw) || PRESETS_IMPORT.test(raw) ||
        identifier.test(raw)
      ) found.push({ file, line: raw.trim() });
    }
  }
  return found;
}

/** Fails on a mention that is not allow-listed and on an allow entry that matches nothing. */
function assertOnlyAllowed(
  found: { file: string; line: string }[],
  allowed: readonly Allowed[],
) {
  const key = (entry: { file: string; line: string }) =>
    `${entry.file}: ${entry.line}`;
  const left = new Map<string, number>();
  for (const entry of allowed) {
    left.set(key(entry), (left.get(key(entry)) ?? 0) + 1);
  }
  const unexpected: string[] = [];
  for (const entry of found) {
    const count = left.get(key(entry)) ?? 0;
    if (count === 0) unexpected.push(key(entry));
    else left.set(key(entry), count - 1);
  }
  const stale = [...left].filter(([, count]) => count > 0).map(([k]) => k);
  assertEquals(unexpected, [], "new code names a preset");
  assertEquals(stale, [], "allow-list entries no longer match: remove them");
}

// --- (a) built-in definitions compile and declare apiVersion

/**
 * Built-ins that are still flat preset specs (`kind: fixed`, no `apiVersion`).
 * #399 republishes both as compiled definitions; #400 deletes the flat path.
 */
// #399 republished `fixed-coding` as a compiled definition; the reviewed
// preset is the last flat built-in until its own republication lands.
// #399 republished both presets as compiled definitions, so there is no flat
// built-in left; a new one would have to be listed here and explained.
const FLAT_BUILT_INS: Readonly<Record<string, string>> = Object.freeze({});

/** Repository files that ship a workflow document, outside tests and docs. */
async function shippedWorkflowDocuments(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of ["apps", "packages"]) {
    for (
      const rel of await filesUnder(
        dir,
        (rel) =>
          /\.(?:ya?ml|json)$/.test(rel) && !rel.includes("/tests/") &&
          !rel.includes("/generated/") && !rel.includes("/locales/"),
      )
    ) {
      const text = await Deno.readTextFile(join(ROOT, rel));
      if (/apiVersion["']?\s*:\s*["']?bakery\.dev\//.test(text)) {
        found.push(rel);
      }
    }
  }
  return found;
}

async function compiles(document: unknown) {
  assert(
    typeof document === "object" && document !== null &&
      typeof (document as { apiVersion?: unknown }).apiVersion === "string",
    "declares no apiVersion",
  );
  const result = await compileWorkflowDocument(document);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
}

Deno.test("every built-in workflow compiles and declares apiVersion, or is a listed flat preset", async () => {
  for (const preset of WORKFLOW_PRESETS) {
    const decoded = decodeWorkflowYaml(preset.sourceYaml);
    assert(decoded.ok, `${preset.id}: source YAML does not decode`);
    const value = decoded.value as Record<string, unknown>;
    const declaresApiVersion = typeof value["apiVersion"] === "string";
    const compiled = declaresApiVersion &&
      (await compileWorkflowDocument(value)).ok;
    if (compiled) {
      assert(
        !(preset.id in FLAT_BUILT_INS),
        `${preset.id} now compiles: remove it from FLAT_BUILT_INS (${
          FLAT_BUILT_INS[preset.id]
        })`,
      );
    } else {
      assert(
        preset.id in FLAT_BUILT_INS,
        `${preset.id} is a new built-in that does not compile with apiVersion; the flat executor is frozen (O1)`,
      );
    }
  }
  for (const id of Object.keys(FLAT_BUILT_INS)) {
    assert(
      WORKFLOW_PRESETS.some((preset) => preset.id === id),
      `${id} is no longer a built-in: remove it from FLAT_BUILT_INS`,
    );
  }
});

Deno.test("every workflow document shipped outside tests compiles and declares apiVersion", async () => {
  for (const rel of await shippedWorkflowDocuments()) {
    const text = await Deno.readTextFile(join(ROOT, rel));
    const decoded = rel.endsWith(".json")
      ? decodeWorkflowJson(text)
      : decodeWorkflowYaml(text);
    assert(decoded.ok, `${rel}: does not decode`);
    try {
      await compiles(decoded.value);
    } catch (error) {
      throw new Error(`${rel}: ${(error as Error).message}`);
    }
  }
});

// --- (b) the engine names no template slug and imports no presets module

/** The compiler, the interpreter, plan-run admission and the split (coordination) code. */
async function engineFiles(): Promise<string[]> {
  return [
    ...await filesUnder("packages/contracts/src/workflow-compiler", isSource),
    ...await filesUnder(
      "packages/contracts/src/workflow-interpreter",
      isSource,
    ),
    ...await filesUnder("apps/server/src/modules/workflow-adapter", isSource),
    ...await filesUnder(
      "apps/server/src/modules/work",
      (rel) =>
        isSource(rel) &&
        /\/(?:plan-run-admission|coordination-[\w-]+)\.ts$/.test(rel),
    ),
  ];
}

/** None today: the engine is clean. Keep it that way. */
const ENGINE_ALLOWED: readonly Allowed[] = Object.freeze([]);

Deno.test("the engine never names a preset slug or imports the presets module", async () => {
  const files = await engineFiles();
  assert(
    files.includes("packages/contracts/src/workflow-interpreter/interpret.ts"),
    "the engine file set lost the interpreter",
  );
  assert(
    files.includes("apps/server/src/modules/work/plan-run-admission.ts"),
    "the engine file set lost plan-run admission",
  );
  assertOnlyAllowed(await presetMentions(files), ENGINE_ALLOWED);
});

// --- (c) ticket admission names no preset

/** Ticket admission today pins fixed-coding by name. */
const TICKET_ALLOWED: readonly Allowed[] = Object.freeze([
  // #399 points ticket admission at the republished fixed-coding definition.
  ...[
    'import { FIXED_CODING_PRESET } from "@bakery/contracts/workflow-presets";',
    'id: FIXED_CODING_PRESET.id as TicketPresetPin["id"],',
    "revision: FIXED_CODING_PRESET.revision,",
    "digest: FIXED_CODING_PRESET.digest,",
    'import { presetAvailability } from "./workflow-presets.ts";',
    "FIXED_CODING_PRESET,",
    "FIXED_CODING_PRESET.defaultBudgetLimitUsd,",
    'presetId: "fixed-coding",',
  ].map((line) => ({
    file: "apps/server/src/modules/work/ticket-admission.ts",
    line,
    issue: "#399",
  })),
  // #407 makes the ticket source policy name a workflow instead of a preset.
  ...[
    'const policyPresetSchema = z.literal("fixed-coding").describe(',
    '"Fixed workflow preset every admission of this source runs; always fixed-coding, the only preset admission runs, even if the workflow preset catalog gains others.",',
    'preset: "fixed-coding",',
    'id: z.literal("fixed-coding").describe(',
    '"Workflow preset id; always fixed-coding, the only preset admission runs.",',
  ].map((line) => ({
    file: "packages/contracts/src/ticket-admission.ts",
    line,
    issue: "#407",
  })),
]);

Deno.test("ticket admission names no preset beyond the listed ones", async () => {
  const files = [
    ...await filesUnder(
      "apps/server/src/modules/work",
      (rel) => isSource(rel) && /\/ticket-[\w-]+\.ts$/.test(rel),
    ),
    ...await filesUnder(
      "apps/server/src/modules/integrations",
      (rel) => isSource(rel) && /\/ticket-[\w-]+\.ts$/.test(rel),
    ),
    "packages/contracts/src/ticket-admission.ts",
  ];
  assert(
    files.includes("apps/server/src/modules/work/ticket-admission.ts"),
    "the ticket file set lost ticket admission",
  );
  assertOnlyAllowed(await presetMentions(files), TICKET_ALLOWED);
});

// --- the scanners themselves bite

Deno.test("the preset scanner finds a slug, an import and a preset name", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kernel-rails-" });
  try {
    await Deno.writeTextFile(
      join(dir, "probe.ts"),
      [
        'import { x } from "@bakery/contracts/workflow-presets";',
        'const a = "fixed-coding-reviewed";',
        "const b = WORKFLOW_PRESETS;",
        "// fixed-coding in a comment is prose",
        'const c = "not-fixed-coding-at-all";',
        // A slug alone on a line inside a multi-line template literal.
        "const d = `",
        "fixed-coding",
        "`;",
        "",
      ].join("\n"),
    );
    const found = await presetMentions(["probe.ts"], dir);
    assertEquals(found.map((entry) => entry.line), [
      'import { x } from "@bakery/contracts/workflow-presets";',
      'const a = "fixed-coding-reviewed";',
      "const b = WORKFLOW_PRESETS;",
      "fixed-coding",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
