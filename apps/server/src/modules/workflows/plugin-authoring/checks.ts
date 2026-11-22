import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  parsePluginManifest,
  PLUGIN_SDK_VERSION,
  type PluginInstallCapability,
  type PluginManifest,
  PluginManifestError,
  satisfiesSdkRange,
  SdkRangeSyntaxError,
} from "@bakery/contracts/plugin-sdk";
import { HOST_OWNED_FILES } from "@bakery/contracts/plugin-authoring-kit";

/**
 * The deterministic checks an authored plugin package must pass (#45, B14.04).
 *
 * A generator writes the package; nothing it writes decides whether the package
 * is acceptable. Every check here reads the files and a policy the runner built
 * from the authorized request, and the same list runs, in the same order, on
 * every attempt. A check never stops the others: a repair attempt gets every
 * diagnostic at once, and the report always names every check id, so two
 * attempts can be compared check for check.
 */

/** The checks, in the order they run. Never shortened for an attempt. */
export const PLUGIN_PACKAGE_CHECK_IDS = Object.freeze(
  [
    "file_tree",
    "manifest",
    "authority",
    "isolation",
    "typecheck",
    "build",
  ] as const,
);
export type PluginPackageCheckId = typeof PLUGIN_PACKAGE_CHECK_IDS[number];

export const PLUGIN_PACKAGE_LIMITS = Object.freeze({
  maxFiles: 64,
  maxTotalBytes: 1024 * 1024,
  maxPathLength: 200,
  typecheckTimeoutMs: 60_000,
  maxDiagnostics: 40,
});

/** The files a package must carry. */
export const REQUIRED_PACKAGE_FILES = Object.freeze([
  "manifest.json",
  "plugin.json",
  "job.ts",
]);

export type PluginPackageFiles = Readonly<Record<string, string>>;

export type PluginPackageDiagnostic = Readonly<{
  check: PluginPackageCheckId;
  code: string;
  message: string;
  path?: string;
}>;

export type PluginPackageCheckOutcome = Readonly<{
  id: PluginPackageCheckId;
  status: "passed" | "failed" | "skipped";
  diagnosticCount: number;
}>;

/**
 * What the runner decided before any file was generated. Built only by
 * `freezeAuthoringPolicy`; a generator never sees or supplies it.
 */
export type PluginAuthoringPolicy = Readonly<{
  authorizedCapabilities: readonly PluginInstallCapability[];
}>;

export function freezeAuthoringPolicy(
  authorizedCapabilities: readonly PluginInstallCapability[],
): PluginAuthoringPolicy {
  return Object.freeze({
    authorizedCapabilities: Object.freeze([...new Set(authorizedCapabilities)]),
  });
}

export type PluginBundle = Readonly<{
  bytes: Uint8Array;
  digest: string;
}>;

export type PluginPackageCheckResult = Readonly<{
  ok: boolean;
  diagnostics: readonly PluginPackageDiagnostic[];
  report: Readonly<{
    checks: readonly PluginPackageCheckOutcome[];
    sdkVersion: string;
    filesDigest: string;
    /**
     * Where the typecheck ran: host_isolated is the server's own Deno in a
     * fresh directory holding only the package and the host files, with its
     * own empty config and cache, no remote, npm or lock file and an empty
     * environment. The server has no containment runtime; jobs get that one.
     */
    typecheckMode: "host_isolated";
  }>;
  manifest: PluginManifest | null;
  sdkRange: string | null;
  bundle: PluginBundle | null;
}>;

/** Names the host's own typecheck config uses, which a package may not ship. */
const HOST_CONFIG_NAMES: ReadonlySet<string> = new Set([
  "deno.json",
  "deno.jsonc",
  "package.json",
  "node_modules",
  "import_map.json",
]);

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCE_FILE = /\.(?:ts|js|mjs|mts|tsx|jsx)$/;

/**
 * Tokens a job's source may not contain. The scan is defense in depth: the
 * runtime has no network, files or environment whatever the source says, and
 * the typecheck runs offline. The list names every way the kit's own runner
 * reaches the host, and the reflective spellings that would rebuild one.
 */
const FORBIDDEN_TOKENS: readonly Readonly<
  { pattern: RegExp; label: string }
>[] = [
  // Any mention, not just a member access: `const d = Deno` is an alias.
  { pattern: /\bDeno\b/, label: "Deno" },
  { pattern: /\bfetch\s*\(/, label: "fetch(" },
  { pattern: /\bXMLHttpRequest\b/, label: "XMLHttpRequest" },
  { pattern: /\bWebSocket\b/, label: "WebSocket" },
  { pattern: /\bEventSource\b/, label: "EventSource" },
  { pattern: /\bprocess\s*\./, label: "process." },
  // Any mention: `(0, eval)("...")` is an indirect call.
  { pattern: /\beval\b/, label: "eval" },
  { pattern: /\bnew\s+Function\b/, label: "new Function" },
  { pattern: /\bFunction\s*\(/, label: "Function(" },
  { pattern: /\bglobalThis\b/, label: "globalThis" },
  { pattern: /\bReflect\b/, label: "Reflect" },
  { pattern: /\bconstructor\b/, label: "constructor" },
  { pattern: /\brequire\s*\(/, label: "require(" },
  { pattern: /\bimport\s*\(/, label: "import(" },
  { pattern: /\bimport\.meta\b/, label: "import.meta" },
  { pattern: /\bWorker\b/, label: "Worker" },
];

/**
 * Comment directives the TypeScript and Deno compilers follow to load another
 * file: any triple-slash directive, and the type and JSX pragmas. A package
 * never needs one (its types come from ./sdk.ts), so each is refused outright
 * rather than resolved, whether written in a line or a block comment.
 */
const COMPILER_DIRECTIVES: readonly Readonly<
  { pattern: RegExp; label: string }
>[] = [
  { pattern: /\/\/\/\s*</, label: "a triple-slash directive" },
  {
    pattern:
      /@(?:deno-types|ts-types|ts-self-types|jsxImportSource|jsxImportSourceTypes|jsxRuntime|jsxFrag|jsx)\b/,
    label: "a compiler pragma",
  },
];

// Whitespace after the keyword is optional: `import{a}from"x"` is valid.
const IMPORT_SPECIFIER =
  /(?:\bimport|\bexport)\s*(?:type\s+)?(?:[^"'`;]*?\bfrom\s*)?["'`]([^"'`]*)["'`]/g;

function diagnostic(
  check: PluginPackageCheckId,
  code: string,
  message: string,
  path?: string,
): PluginPackageDiagnostic {
  return Object.freeze(
    path === undefined
      ? { check, code, message }
      : { check, code, message, path },
  );
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The digest of a set of files: each path and its content, in path order,
 * length-prefixed so two different sets cannot share it.
 */
export function digestFiles(files: PluginPackageFiles): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    hash.update(`${path.length}:${path}${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

/**
 * The bundle: canonical JSON of the sorted files, host files included. The same
 * files always give the same bytes and so the same digest.
 */
export function buildPluginBundle(files: PluginPackageFiles): PluginBundle {
  const complete: Record<string, string> = { ...files, ...HOST_OWNED_FILES };
  const entries = Object.keys(complete).sort().map((path) => [
    path,
    complete[path],
  ]);
  const bytes = new TextEncoder().encode(
    JSON.stringify({ format: "bakery-plugin-bundle/1", files: entries }),
  );
  return Object.freeze({ bytes, digest: sha256Hex(bytes) });
}

/** Reads a bundle back into its files, refusing anything not built above. */
export function readPluginBundle(bytes: Uint8Array): Record<string, string> {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    format?: unknown;
    files?: unknown;
  };
  if (
    parsed.format !== "bakery-plugin-bundle/1" || !Array.isArray(parsed.files)
  ) {
    throw new Error("PLUGIN_BUNDLE_UNREADABLE");
  }
  const files: Record<string, string> = {};
  for (const entry of parsed.files) {
    if (
      !Array.isArray(entry) || entry.length !== 2 ||
      typeof entry[0] !== "string" || typeof entry[1] !== "string" ||
      !safePath(entry[0])
    ) throw new Error("PLUGIN_BUNDLE_UNREADABLE");
    files[entry[0]] = entry[1];
  }
  return files;
}

function safePath(path: string): boolean {
  return path.length > 0 &&
    path.length <= PLUGIN_PACKAGE_LIMITS.maxPathLength &&
    path.split("/").every((segment) =>
      segment !== "." && segment !== ".." && SEGMENT.test(segment)
    );
}

function checkFileTree(files: PluginPackageFiles): PluginPackageDiagnostic[] {
  const out: PluginPackageDiagnostic[] = [];
  const paths = Object.keys(files);
  if (paths.length > PLUGIN_PACKAGE_LIMITS.maxFiles) {
    out.push(diagnostic(
      "file_tree",
      "TOO_MANY_FILES",
      `at most ${PLUGIN_PACKAGE_LIMITS.maxFiles} files`,
    ));
  }
  let total = 0;
  for (const path of paths) {
    const content = files[path];
    total += new TextEncoder().encode(content).byteLength;
    if (!safePath(path)) {
      out.push(diagnostic(
        "file_tree",
        "PATH_UNSAFE",
        "not a relative POSIX path of plain segments",
        path,
      ));
    } else if (
      Object.hasOwn(HOST_OWNED_FILES, path) ||
      HOST_CONFIG_NAMES.has(path.split("/")[0])
    ) {
      out.push(diagnostic(
        "file_tree",
        "PATH_RESERVED",
        "the host supplies this file",
        path,
      ));
    }
  }
  if (total > PLUGIN_PACKAGE_LIMITS.maxTotalBytes) {
    out.push(diagnostic("file_tree", "TOO_LARGE", "more than 1 MiB of files"));
  }
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!Object.hasOwn(files, required)) {
      out.push(diagnostic(
        "file_tree",
        "FILE_MISSING",
        "required file missing",
        required,
      ));
    }
  }
  return out;
}

function checkManifest(
  files: PluginPackageFiles,
): {
  diagnostics: PluginPackageDiagnostic[];
  manifest: PluginManifest | null;
  sdkRange: string | null;
} {
  const out: PluginPackageDiagnostic[] = [];
  let manifest: PluginManifest | null = null;
  let sdkRange: string | null = null;
  const manifestText = files["manifest.json"];
  if (manifestText !== undefined) {
    try {
      manifest = parsePluginManifest(JSON.parse(manifestText));
      if (manifest.pages.length > 0) {
        out.push(diagnostic(
          "manifest",
          "PAGES_NOT_SUPPORTED",
          "a backend plugin declares no pages",
          "manifest.json",
        ));
      }
    } catch (error) {
      if (error instanceof PluginManifestError) {
        out.push(diagnostic(
          "manifest",
          `MANIFEST_${error.code}`,
          error.detail,
          "manifest.json",
        ));
      } else if (error instanceof SyntaxError) {
        out.push(diagnostic(
          "manifest",
          "MANIFEST_NOT_JSON",
          "manifest.json is not JSON",
          "manifest.json",
        ));
      } else throw error;
    }
  }
  const pluginText = files["plugin.json"];
  if (pluginText !== undefined) {
    try {
      const parsed = JSON.parse(pluginText) as Record<string, unknown>;
      const keys = parsed !== null && typeof parsed === "object"
        ? Object.keys(parsed)
        : [];
      if (
        typeof parsed?.sdkRange !== "string" || keys.length !== 1
      ) {
        out.push(diagnostic(
          "manifest",
          "PLUGIN_JSON_INVALID",
          'plugin.json must be exactly {"sdkRange": string}',
          "plugin.json",
        ));
      } else if (!satisfiesSdkRange(parsed.sdkRange, PLUGIN_SDK_VERSION)) {
        out.push(diagnostic(
          "manifest",
          "SDK_INCOMPATIBLE",
          `sdkRange does not accept the host SDK ${sdkVersionText()}`,
          "plugin.json",
        ));
      } else {
        sdkRange = parsed.sdkRange;
      }
    } catch (error) {
      if (error instanceof SdkRangeSyntaxError) {
        out.push(diagnostic(
          "manifest",
          "SDK_RANGE_UNREADABLE",
          error.message,
          "plugin.json",
        ));
      } else if (error instanceof SyntaxError) {
        out.push(diagnostic(
          "manifest",
          "PLUGIN_JSON_INVALID",
          "plugin.json is not JSON",
          "plugin.json",
        ));
      } else throw error;
    }
  }
  return { diagnostics: out, manifest, sdkRange };
}

function checkAuthority(
  manifest: PluginManifest | null,
  policy: PluginAuthoringPolicy,
): PluginPackageDiagnostic[] {
  if (manifest === null) return [];
  const allowed = new Set<string>(policy.authorizedCapabilities);
  return manifest.requestedCapabilities
    .filter((capability) => !allowed.has(capability))
    .map((capability) =>
      diagnostic(
        "authority",
        "AUTHORITY_EXCEEDED",
        `requests ${capability}, which the request did not authorize`,
        "manifest.json",
      )
    );
}

/** Strips comments so a token in a comment neither hides nor fakes a finding. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * The package path a relative specifier names from `importer`, or null when it
 * climbs above the package root.
 */
export function resolveWithinPackage(
  importer: string,
  specifier: string,
): string | null {
  const segments = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.join("/");
}

function checkIsolation(files: PluginPackageFiles): PluginPackageDiagnostic[] {
  const out: PluginPackageDiagnostic[] = [];
  for (const path of Object.keys(files).sort()) {
    if (!SOURCE_FILE.test(path)) continue;
    const source = files[path];
    // Both the raw and the comment-free text are scanned: a token is refused
    // wherever it appears, and stripping comments first would let a string
    // that opens a comment hide code from the scan.
    for (const text of [source, withoutComments(source)]) {
      for (const { pattern, label } of FORBIDDEN_TOKENS) {
        if (
          pattern.test(text) &&
          !out.some((d) => d.path === path && d.message.endsWith(label))
        ) {
          out.push(diagnostic(
            "isolation",
            "ISOLATION_VIOLATION",
            `uses ${label}`,
            path,
          ));
        }
      }
    }
    // Read on the raw source: these live in comments by design, and each one
    // makes the compiler load a file the import scan never sees.
    for (const { pattern, label } of COMPILER_DIRECTIVES) {
      if (pattern.test(source)) {
        out.push(diagnostic(
          "isolation",
          "ISOLATION_VIOLATION",
          `imports through ${label}, which the compiler would follow`,
          path,
        ));
      }
    }
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const resolved = resolveWithinPackage(path, specifier);
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        out.push(diagnostic(
          "isolation",
          "ISOLATION_VIOLATION",
          `imports ${specifier}, which is not a relative file`,
          path,
        ));
      } else if (!SOURCE_FILE.test(specifier)) {
        out.push(diagnostic(
          "isolation",
          "ISOLATION_VIOLATION",
          `imports ${specifier}, which is not a source file`,
          path,
        ));
      } else if (
        resolved === null ||
        (!Object.hasOwn(files, resolved) &&
          !Object.hasOwn(HOST_OWNED_FILES, resolved))
      ) {
        // Resolved against the importer inside the package: a path that
        // climbs out of it, or names no file in it, would make the host's
        // typecheck read a file on the server and echo it in diagnostics.
        out.push(diagnostic(
          "isolation",
          "ISOLATION_VIOLATION",
          `imports ${specifier}, which is not a file in this package`,
          path,
        ));
      }
    }
  }
  return out;
}

/**
 * Type-checks the job with the host's own Deno, offline: no remote, npm, config
 * or lock file, an empty environment and a deadline. The package is written to
 * a fresh directory with the host files beside it and removed afterwards.
 */
async function checkTypes(
  files: PluginPackageFiles,
): Promise<PluginPackageDiagnostic[]> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-plugin-check-" });
  try {
    const complete: Record<string, string> = { ...files, ...HOST_OWNED_FILES };
    for (const [path, content] of Object.entries(complete)) {
      const target = join(dir, ...path.split("/"));
      const parent = target.slice(0, target.lastIndexOf("/"));
      await Deno.mkdir(parent, { recursive: true });
      await Deno.writeTextFile(target, content);
    }
    // The package's own config, so nothing from the host's (an import map,
    // a node_modules directory) can name a file for it.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ nodeModulesDir: "none", imports: {} }),
    );
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command(Deno.execPath(), {
        args: [
          "check",
          "--quiet",
          "--no-remote",
          "--no-npm",
          "--config",
          "deno.json",
          "--no-lock",
          "runner.ts",
        ],
        cwd: dir,
        clearEnv: true,
        env: {
          NO_COLOR: "1",
          HOME: dir,
          DENO_DIR: join(dir, ".deno"),
          DENO_NO_UPDATE_CHECK: "1",
        },
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(PLUGIN_PACKAGE_LIMITS.typecheckTimeoutMs),
      }).output();
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return [diagnostic(
          "typecheck",
          "TYPECHECK_TIMEOUT",
          "deno check did not finish within 60 seconds",
        )];
      }
      throw error;
    }
    if (output.success) return [];
    const text = new TextDecoder().decode(output.stderr) +
      new TextDecoder().decode(output.stdout);
    return typecheckDiagnostics(text, dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

/** One diagnostic per reported error, with the temp directory taken out. */
export function typecheckDiagnostics(
  text: string,
  dir: string,
): PluginPackageDiagnostic[] {
  const cleaned = text.replaceAll(`file://${dir}/`, "").replaceAll(
    `${dir}/`,
    "",
  );
  const blocks = cleaned.split(/\n(?=TS\d+ \[ERROR\]|error: )/).map((block) =>
    block.trim()
  ).filter((block) =>
    /^(TS\d+ \[ERROR\]|error: )/.test(block) &&
    !/^error: Type checking failed/.test(block)
  );
  const out = blocks.slice(0, PLUGIN_PACKAGE_LIMITS.maxDiagnostics).map(
    (block) => {
      const at = /at ([A-Za-z0-9._/-]+):\d+:\d+/.exec(block);
      return diagnostic(
        "typecheck",
        "TYPECHECK_FAILED",
        block.slice(0, 2000),
        at?.[1],
      );
    },
  );
  return out.length > 0 ? out : [
    diagnostic(
      "typecheck",
      "TYPECHECK_FAILED",
      cleaned.trim().slice(0, 2000),
    ),
  ];
}

function sdkVersionText(): string {
  const v = PLUGIN_SDK_VERSION;
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Runs every check, in order, and says what each found. The package is
 * acceptable only when every check passed; the bundle exists only then.
 */
export async function checkPluginPackage(
  files: PluginPackageFiles,
  policy: PluginAuthoringPolicy,
): Promise<PluginPackageCheckResult> {
  const results = new Map<
    PluginPackageCheckId,
    {
      status: "passed" | "failed" | "skipped";
      found: PluginPackageDiagnostic[];
    }
  >();
  const record = (
    id: PluginPackageCheckId,
    found: PluginPackageDiagnostic[],
    skipped = false,
  ) =>
    results.set(id, {
      status: skipped ? "skipped" : found.length === 0 ? "passed" : "failed",
      found,
    });

  const tree = checkFileTree(files);
  record("file_tree", tree);
  const manifest = checkManifest(files);
  record("manifest", manifest.diagnostics);
  record("authority", checkAuthority(manifest.manifest, policy));
  const isolation = checkIsolation(files);
  record("isolation", isolation);
  // A package whose paths are unsafe is never written to disk, and one that
  // imports anything but its own files is never handed to the host's
  // compiler, which would resolve the import on the server and echo what it
  // read in its diagnostics. Either way the typecheck is reported as skipped
  // (and so not passed) rather than run.
  const treeSafe =
    !tree.some((d) =>
      d.code === "PATH_UNSAFE" || d.code === "PATH_RESERVED" ||
      d.code === "TOO_MANY_FILES" || d.code === "TOO_LARGE"
    ) && !isolation.some((d) => d.message.startsWith("imports "));
  if (treeSafe) record("typecheck", await checkTypes(files));
  else record("typecheck", [], true);

  const earlierFailed = [...results.values()].some((r) =>
    r.status !== "passed"
  );
  const bundle = earlierFailed ? null : buildPluginBundle(files);
  record("build", [], earlierFailed);

  const checks = PLUGIN_PACKAGE_CHECK_IDS.map((id) => {
    const result = results.get(id)!;
    return Object.freeze({
      id,
      status: result.status,
      diagnosticCount: result.found.length,
    });
  });
  const diagnostics = PLUGIN_PACKAGE_CHECK_IDS.flatMap((id) =>
    results.get(id)!.found
  );
  return Object.freeze({
    ok: checks.every((check) => check.status === "passed"),
    diagnostics: Object.freeze(diagnostics),
    report: Object.freeze({
      checks: Object.freeze(checks),
      sdkVersion: sdkVersionText(),
      filesDigest: digestFiles(files),
      typecheckMode: "host_isolated",
    }),
    manifest: manifest.manifest,
    sdkRange: manifest.sdkRange,
    bundle,
  });
}
