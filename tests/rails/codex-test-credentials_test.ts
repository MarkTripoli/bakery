import { assert, assertEquals } from "@std/assert";
import { join, posix } from "node:path";
import { CODEX_TEST_AUTH_DIR_ENV } from "../helpers/codex-harness.ts";

// #207: nothing in the tests may reach the operator's own Codex login except
// through the one door in tests/helpers/codex-harness.ts, which requires an
// explicit opt-in (BAKERY_TEST_CODEX_AUTH_DIR) naming a dedicated directory.
// The gate's behavior is covered in tests/unit/codex-test-credential-gate_test.ts;
// this rail is read-only, like its lane. The scan is textual: it cannot tell code
// from a string that merely mentions a name (a test title that says "CODEX_HOME"
// is flagged like a read of it), so a file that only talks about these names is
// allowed by name below, with its reason. Comments are not code and are ignored.

const REPO = new URL("../../", import.meta.url).pathname;

Deno.test("the real gate, run with no opt-in, skips without reading the login or starting anything", async () => {
  // A subprocess that may read the repository and nothing else and may run no
  // program. HOME and the other login variables name directories outside that
  // read grant, so the runtime itself fails the process on any read of them or
  // any spawn. Nothing is created: the paths need not exist.
  const sentinel = "/nonexistent-operator-sentinel";
  const helper = new URL("tests/helpers/codex-harness.ts", `file://${REPO}`);
  const code = `import { codexHarnessAvailable } from ${
    JSON.stringify(helper.href)
  };\nconsole.log(JSON.stringify(await codexHarnessAvailable()));`;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--config=${join(REPO, "deno.json")}`,
      "--allow-env",
      `--allow-read=${REPO}`,
      "-",
    ],
    env: {
      HOME: sentinel,
      CODEX_HOME: `${sentinel}/.codex`,
      BAKERY_CODEX_AUTH_SOURCE_DIR: `${sentinel}/.codex`,
      [CODEX_TEST_AUTH_DIR_ENV]: "",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const script = child.stdin.getWriter();
  await script.write(new TextEncoder().encode(code));
  await script.close();
  const output = await child.output();
  const stderr = new TextDecoder().decode(output.stderr);
  assert(output.success, `the gate touched something it may not: ${stderr}`);
  const said = JSON.parse(new TextDecoder().decode(output.stdout));
  assert(typeof said === "string", "the gate must skip, not pass");
  assert(said.includes(CODEX_TEST_AUTH_DIR_ENV), said);
});

// --- nothing else in the tests may reach the operator's login

const SCANNED = /\.(ts|tsx|mjs|js)$/;

/**
 * Drops comments, so a decoy in one cannot satisfy or hide a match. It is a
 * small scanner and not a regex because a comment marker inside a string, a
 * template or a regular expression is not a comment: a string such as `"x/*y"`
 * must not swallow the code after it. Anything it cannot scan to the end throws, so a
 * confusing file is reported instead of passing unread.
 */
export function withoutComments(source: string): string {
  const n = source.length;
  const out: string[] = [];
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`cannot scan source: ${what}`);
  };
  const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
  const REGEX_KEYWORDS = new Set([
    "return",
    "typeof",
    "case",
    "in",
    "of",
    "delete",
    "void",
    "throw",
    "new",
    "else",
    "do",
    "yield",
    "await",
  ]);

  function startsRegex(): boolean {
    let j = i - 1;
    while (j >= 0 && /\s/.test(source[j]!)) j--;
    if (j < 0) return true;
    if (REGEX_AFTER.has(source[j]!)) return true;
    let k = j;
    while (k >= 0 && /[A-Za-z_$]/.test(source[k]!)) k--;
    return k < j && REGEX_KEYWORDS.has(source.slice(k + 1, j + 1));
  }

  function template(): void {
    while (i < n) {
      const c = source[i]!;
      if (c === "\\") {
        out.push(source.slice(i, i + 2));
        i += 2;
      } else if (c === "`") {
        out.push(c);
        i++;
        return;
      } else if (c === "$" && source[i + 1] === "{") {
        out.push("${");
        i += 2;
        code(true);
      } else {
        out.push(c);
        i++;
      }
    }
    fail("unterminated template literal");
  }

  function code(inExpression: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = source[i]!;
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        while (i < n && source[i] !== "\n") i++;
      } else if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end < 0) fail("unterminated block comment");
        out.push(source.slice(i, end + 2).replace(/[^\n]/g, " "));
        i = end + 2;
      } else if (c === '"' || c === "'") {
        const start = i++;
        while (i < n && source[i] !== c) {
          if (source[i] === "\n") fail("unterminated string");
          i += source[i] === "\\" ? 2 : 1;
        }
        if (i >= n) fail("unterminated string");
        out.push(source.slice(start, ++i));
      } else if (c === "`") {
        out.push(c);
        i++;
        template();
      } else if (c === "/" && startsRegex()) {
        const start = i++;
        let inClass = false;
        while (i < n && (source[i] !== "/" || inClass)) {
          if (source[i] === "\n") fail("unterminated regular expression");
          if (source[i] === "\\") i++;
          else if (source[i] === "[") inClass = true;
          else if (source[i] === "]") inClass = false;
          i++;
        }
        if (i >= n) fail("unterminated regular expression");
        i++;
        while (i < n && /[a-z]/.test(source[i]!)) i++;
        out.push(source.slice(start, i));
      } else if (c === "{") {
        depth++;
        out.push(c);
        i++;
      } else if (c === "}") {
        if (inExpression && depth === 0) {
          out.push(c);
          i++;
          return;
        }
        depth--;
        out.push(c);
        i++;
      } else {
        out.push(c);
        i++;
      }
    }
    if (inExpression) fail("unterminated template expression");
  }

  code(false);
  return out.join("");
}

Deno.test("the comment scanner drops comments, keeps strings, and never lets one hide the other", () => {
  const keeps = (source: string, needle: string) =>
    assert(withoutComments(source).includes(needle), `lost ${needle}`);
  const drops = (source: string, needle: string) =>
    assert(!withoutComments(source).includes(needle), `kept ${needle}`);

  // A comment marker inside a string is not a comment: the code after it stays.
  keeps(`const glob = "src/**/*.ts"; reachLogin();`, "reachLogin();");
  keeps(`const glob = 'a/*b'; reachLogin(); const c = "*/";`, "reachLogin();");
  keeps(`const url = "http://x"; reachLogin();`, "reachLogin();");
  keeps("const t = `a/*${1}`; reachLogin(); // end", "reachLogin();");
  keeps("const t = `${ `}` }`; reachLogin();", "reachLogin();");
  keeps(`const re = /["'\\/*]/g; reachLogin();`, "reachLogin();");
  keeps(`const x = a / b; /* c */ reachLogin();`, "reachLogin();");
  keeps(`return /x\\/\\*/.test(s); reachLogin();`, "reachLogin();");
  // A comment, however it hides the pattern, is dropped.
  drops(`// reachLogin();\nother();`, "reachLogin");
  drops(`/* reachLogin(); */ other();`, "reachLogin");
  drops(`other(); // reachLogin();`, "reachLogin");
  drops(`/**\n * reachLogin();\n */\nother();`, "reachLogin");
  // Line numbers survive, and a string that merely looks like a comment stays.
  assertEquals(withoutComments("a\n/* x\ny */\nb").split("\n").length, 4);
  keeps(`const s = "// reachLogin();";`, "reachLogin");
  // Anything it cannot scan to the end is an error, not a pass.
  for (
    const broken of [
      "/* never closed",
      `const s = "never closed`,
      "const t = `never closed",
      "const t = `${ never closed",
      "const r = /never closed",
    ]
  ) {
    let threw = false;
    try {
      withoutComments(broken);
    } catch (error) {
      threw = String(error).includes("cannot scan source");
    }
    assert(threw, `${broken} was accepted`);
  }
});

async function* testFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      yield* testFiles(path);
    } else if (SCANNED.test(entry.name)) yield path;
  }
}

/**
 * Adjacent string literals joined and `${"x"}` inlined, so ".cod" + "ex" is seen
 * as ".codex" and CODEX_${"HOME"} as CODEX_HOME.
 */
export function withLiteralsJoined(source: string): string {
  return source
    .replace(/\$\{\s*(["'])([^"'`$\\]*)\1\s*\}/g, "$2")
    .replace(/(["'`])\s*\+\s*\1/g, "");
}

type Reason = "path" | "variable" | "environment" | "cli";

/** Test or worker code that can start the Codex harness from configuration. */
const ENABLES_CODEX_HARNESS =
  /\b(?:createCodexHarnessExecutor|readWorkerConfig|loadWorkerConfig|BAKERY_CODEX_HARNESS|BAKERY_CODING_HARNESS)\b/;

/** Naming the Codex harness specifically, as opposed to reading worker config in general. */
const NAMES_CODEX_HARNESS =
  /\b(?:createCodexHarnessExecutor|BAKERY_CODEX_HARNESS|BAKERY_CODING_HARNESS)\b/;

/** Running the worker's own main(), which reads HOME for itself. */
const RUNS_WORKER_MAIN = /\bworker\/src\/main\.ts\b/;

/** Running the Codex CLI directly: a command whose program is codex, or a shell line that starts it. */
const RUNS_CODEX_CLI =
  /Deno\.Command\(\s*(?:codexExecutablePath\s*\(\s*\)|harnessExecutablePath\s*\(\s*["'`]codex["'`]\s*\)|["'`](?:[^"'`]*\/)?codex["'`])|\bcodex\s+(?:exec|login|resume|mcp|app)\b/;

/** Reading HOME, or the whole process environment, which hands a child the operator's. */
const READS_ENVIRONMENT =
  /Deno\.env\.toObject\s*\(|\bprocess\.env\b|\bhomedir\s*\(|\buserInfo\s*\(|Deno\.env\.get\(\s*["'`]HOME["'`]/;

/**
 * Every way a test can reach the operator's own Codex login that a source scan
 * can see:
 * - `path`: the literal path segment `.codex` (any spelling that ends up as one
 *   string once adjacent literals are joined), or the removed resolver;
 * - `variable`: a mention of CODEX_HOME or BAKERY_CODEX_AUTH_SOURCE_DIR, which
 *   the worker falls back through before `$HOME/.codex`;
 * - `environment`: a file that can start the Codex harness from configuration
 *   AND reads HOME or the whole process environment (in the file or in a module
 *   it imports), or runs the worker's own main(), without going through
 *   `dedicatedCodexTestAuthSource()`. That is what lets worker code resolve
 *   `$HOME/.codex` for itself; reading HOME on its own is not it;
 * - `cli`: running the Codex CLI itself, without going through the door.
 */
export function operatorLoginReasons(
  source: string,
  importsReadEnvironment = false,
): Reason[] {
  const text = withLiteralsJoined(source);
  const found = new Set<Reason>();
  if (/["'`/]\.codex(?:["'`/]|\b)/.test(text)) found.add("path");
  if (/\boperatorCodexAuthSource\b/.test(text)) found.add("path");
  if (/\b(?:CODEX_HOME|BAKERY_CODEX_AUTH_SOURCE_DIR)\b/.test(text)) {
    found.add("variable");
  }
  const door = /\bdedicatedCodexTestAuthSource\s*\(/.test(text);
  if (
    !door && ENABLES_CODEX_HARNESS.test(text) &&
    (READS_ENVIRONMENT.test(text) || importsReadEnvironment)
  ) found.add("environment");
  if (!door && NAMES_CODEX_HARNESS.test(text) && RUNS_WORKER_MAIN.test(text)) {
    found.add("environment");
  }
  if (!door && RUNS_CODEX_CLI.test(text)) found.add("cli");
  return [...found];
}

/**
 * Whether a file imports (relatively, up to three levels deep, test modules
 * only) a module that reads HOME or the whole process environment. This is the helper-file split:
 * one file reads the environment, the test imports it into the harness. A
 * module that cannot be scanned counts as reading it.
 */
export function importsReadingEnvironment(
  fromPath: string,
  source: string,
  readFile: (repoRelativePath: string) => string | undefined,
  seen: Set<string> = new Set(),
  depth = 0,
): boolean {
  if (depth > 3) return false;
  const specifiers =
    /\b(?:import|export)\b[^;]*?\bfrom\s*["'`](\.{1,2}\/[^"'`]+)["'`]|\bimport\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*\)/g;
  for (const match of source.matchAll(specifiers)) {
    const target = posix.normalize(
      posix.join(posix.dirname(fromPath), match[1] ?? match[2]!),
    );
    // Production code reads the environment as a matter of course (every worker
    // test imports it); the split worth catching is a TEST helper that does.
    if (!target.startsWith("tests/") || seen.has(target)) continue;
    seen.add(target);
    const raw = readFile(target);
    if (raw === undefined) continue;
    let imported: string;
    try {
      imported = withoutComments(raw);
    } catch {
      return true;
    }
    if (READS_ENVIRONMENT.test(withLiteralsJoined(imported))) return true;
    if (
      importsReadingEnvironment(target, imported, readFile, seen, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

// The only places allowed to name it at all, and why.
const ALLOWED: Record<string, string> = {
  "tests/helpers/codex-harness.ts":
    "the one door: it names these only to refuse them as an opt-in",
  "tests/provider/real-cli-conformance_test.ts":
    "has its own explicit opt-in, BAKERY_PROVIDER_REAL_CLI, checked by realHarnessGate",
  "tests/rails/codex-test-credentials_test.ts": "this rail names the patterns",
  "tests/unit/codex-test-credential-gate_test.ts":
    "builds sentinel homes in temporary directories to prove the gate refuses them",
};

// Files that name `.codex` as a path inside a home directory they invent. Each
// says why that is not the operator's.
const MAY_NAME_PATH: Record<string, string> = {
  "tests/helpers/isolated-lane-home.ts":
    "asserts that no .codex exists in the isolated lane HOME; it only checks for absence and reads nothing from it",
  "tests/rails/lane-home-isolation_test.ts":
    "plants .codex/auth.json in a temporary sentinel home to prove the real lane runner starts the lane without it",
  "tests/unit/lane-isolated-environment_test.ts":
    "plants .codex/auth.json in a temporary sentinel home to prove a child in the isolated lane environment cannot see it",
  "tests/provider/harness-credential-isolation_test.ts":
    "plants .codex/auth.json in a temporary home it builds, to prove the harness never copies it",
  "tests/unit/worker-codex-harness-config_test.ts":
    "resolves paths from literal environment maps with fake directories like /home/bakery; touches no real environment",
  "tests/unit/worker-codex-harness_test.ts":
    "builds a temporary 'operator home' with a .codex in it and proves the Codex child never sees it",
};

// Files that mention the two login variables without reading the operator's
// environment for them. Each says what it does with them.
const MAY_NAME_VARIABLES: Record<string, string> = {
  "tests/helpers/isolated-lane-home.ts":
    "asserts CODEX_HOME and BAKERY_CODEX_AUTH_SOURCE_DIR are unset in the lane; it never reads a login through them",
  "tests/rails/lane-home-isolation_test.ts":
    "sets CODEX_HOME and BAKERY_CODEX_AUTH_SOURCE_DIR to a temporary sentinel home in the environment it gives the lane runner, to prove the lane drops them",
  "tests/unit/lane-isolated-environment_test.ts":
    "puts CODEX_HOME and BAKERY_CODEX_AUTH_SOURCE_DIR into a sentinel environment and asserts the isolated environment omits them",
  "tests/e2e/implement-independent-review-and-bounded-repair-loops.child.ts":
    "sets BAKERY_CODEX_AUTH_SOURCE_DIR to ${scratch}/codex-auth, a directory it creates",
  "tests/e2e/run-deterministic-checks-bound-to-candidate-and-metadata.child.ts":
    "sets BAKERY_CODEX_AUTH_SOURCE_DIR to ${scratch}/codex-auth, a directory it creates",
  "tests/helpers/deterministic-checks/runner-cases.ts":
    "sets BAKERY_CODEX_AUTH_SOURCE_DIR to syntheticAuthSource(), a generated stand-in",
  "tests/helpers/harness-conformance.ts":
    "names CODEX_HOME as the variable the harness sets for its child, and probes inside the child's own home",
  "tests/provider/harness-credential-isolation_test.ts":
    "lists the variable names a harness must scrub from a child's environment",
  "tests/security/run-one-real-bounded-codex-harness-through-the-worker_test.ts":
    "reads CODEX_HOME from the environment a child process reported, and asks the door whether it is the login",
  "tests/unit/worker-codex-harness-config_test.ts":
    "feeds literal environment maps to readWorkerConfig; touches no real environment",
  "tests/unit/worker-codex-harness_test.ts":
    "asserts what CODEX_HOME the fake Codex child received",
};

// Files that start the harness from configuration and read HOME. Each says what for.
const MAY_READ_ENVIRONMENT: Record<string, string> = {
  "tests/unit/worker-codex-harness_test.ts":
    "points HOME at a temporary 'operator home' for the test and restores it; the real HOME is never used",
  "tests/helpers/deterministic-checks/runner-cases.ts":
    "runs the worker's main() with the harness enabled, but sets BAKERY_CODEX_AUTH_SOURCE_DIR to syntheticAuthSource(), so main() never falls back to $HOME/.codex",
  "tests/e2e/implement-independent-review-and-bounded-repair-loops.child.ts":
    "the stack helpers it imports pass HOME to the processes they start, but it sets BAKERY_CODEX_AUTH_SOURCE_DIR to ${scratch}/codex-auth, a directory it creates",
  "tests/e2e/run-deterministic-checks-bound-to-candidate-and-metadata.child.ts":
    "the stack helpers it imports pass HOME to the processes they start, but it sets BAKERY_CODEX_AUTH_SOURCE_DIR to ${scratch}/codex-auth, a directory it creates",
};

// Files that run the Codex CLI themselves, or that the pattern takes for it.
const MAY_RUN_CLI: Record<string, string> = {
  "tests/unit/lane-isolated-environment_test.ts":
    "spawns node and git, never a codex binary, in a sentinel environment; the pattern matches because the file also names the sentinel's .codex",
};

const ALLOW_BY_REASON: Record<Reason, Record<string, string>> = {
  path: MAY_NAME_PATH,
  variable: MAY_NAME_VARIABLES,
  environment: MAY_READ_ENVIRONMENT,
  cli: MAY_RUN_CLI,
};

/**
 * What is wrong with one file's raw source. A file the comment scanner cannot
 * read to the end is reported, never skipped: a scan that quietly passes what
 * it could not read proves nothing.
 */
export function offendersOfSource(
  relative: string,
  raw: string,
  readFile?: (repoRelativePath: string) => string | undefined,
): string[] {
  let source: string;
  try {
    source = withoutComments(raw);
  } catch (error) {
    return [`${relative}: ${error instanceof Error ? error.message : error}`];
  }
  // Only a file that can start the harness needs its imports followed.
  const joined = withLiteralsJoined(source);
  const imports = readFile !== undefined &&
      ENABLES_CODEX_HARNESS.test(joined) &&
      !/\bdedicatedCodexTestAuthSource\s*\(/.test(joined)
    ? importsReadingEnvironment(relative, source, readFile)
    : false;
  return offendersOf(relative, source, imports);
}

function offendersOf(
  relative: string,
  source: string,
  importsReadEnvironment: boolean,
): string[] {
  return operatorLoginReasons(source, importsReadEnvironment)
    .filter((reason) => !Object.hasOwn(ALLOW_BY_REASON[reason], relative))
    .map((reason) => `${relative}: ${reason}`);
}

Deno.test("the patterns see every way QA found to reach the login, and nothing harmless", () => {
  const shapes: [string, string][] = [
    ["join with a HOME variable", 'join(home, ".codex")'],
    ["join with HOME read inline", 'join(Deno.env.get("HOME")!, ".codex")'],
    ["a template with another variable name", "`${h}/.codex`"],
    ["HOME plus a slash path", 'HOME + "/.codex"'],
    ["a name split across literals", '".cod" + "ex"'],
    ["a split single-quoted name", "'.co' + 'dex'"],
    [
      "the whole environment, then CODEX_HOME",
      "Deno.env.toObject().CODEX_HOME",
    ],
    ["Node's environment", "process.env.CODEX_HOME"],
    ["the home directory function", 'join(homedir(), ".codex")'],
    ["resolve with a HOME variable", 'resolve(HOME, ".codex")'],
    ["a tilde path", '"~/.codex"'],
    [
      "the old auth-source variable",
      "Deno.env.get('BAKERY_CODEX_AUTH_SOURCE_DIR')",
    ],
    ["CODEX_HOME read directly", 'Deno.env.get("CODEX_HOME")'],
    [
      "the account's home directory handed to the harness",
      "createCodexHarnessExecutor({ authSourceDir: os.userInfo().homedir })",
    ],
    [
      "worker config built from the whole environment",
      "readWorkerConfig(Deno.env.toObject())",
    ],
    [
      "worker config built from process.env",
      "loadWorkerConfig(process.env)",
    ],
    [
      "the harness enabled with HOME read",
      'env: { BAKERY_CODEX_HARNESS: "1", HOME: Deno.env.get("HOME") }',
    ],
    ["the removed resolver", "operatorCodexAuthSource()"],
    [
      "running the CLI as a command",
      'new Deno.Command("codex", { args: ["exec", "--json"] })',
    ],
    [
      "running the CLI through its path helper",
      "new Deno.Command(codexExecutablePath(), { args: [] })",
    ],
    [
      "running the CLI through the generic helper",
      'new Deno.Command(harnessExecutablePath("codex"), { args: [] })',
    ],
    [
      "running the CLI from a shell line",
      'new Deno.Command("sh", { args: ["-c", "codex exec --json prompt"] })',
    ],
    [
      "enabling the harness and running the worker's main()",
      'import { main } from "../../apps/worker/src/main.ts";\nDeno.env.set("BAKERY_CODING_HARNESS", "codex");\nawait main();',
    ],
    [
      "a subprocess of the worker's main with the harness enabled",
      'new Deno.Command(Deno.execPath(), { args: ["run", "apps/worker/src/main.ts"], env: { BAKERY_CODEX_HARNESS: "1" } })',
    ],
    [
      "a variable name built from a template",
      'Deno.env.get(`CODEX_${"HOME"}`)',
    ],
    [
      "a variable name built by concatenation",
      'Deno.env.get("CODEX_" + "HOME")',
    ],
  ];
  for (const [name, code] of shapes) {
    assert(
      operatorLoginReasons(withoutComments(code)).length > 0,
      `not seen: ${name}: ${code}`,
    );
  }
  // The same shapes in a comment are nothing, and ordinary code is nothing.
  for (const [, code] of shapes) {
    assertEquals(operatorLoginReasons(withoutComments(`// ${code}\n`)), []);
  }
  for (
    const harmless of [
      "const config = { codexHarness: { repository: dir } };",
      "assertEquals(plain.codexHarness, undefined);",
      'const harness = "codex"; const exe = codexExecutablePath();',
      "const homeless = 1; const dotted = x.codex.y;",
      'join(scratch, ".git")',
      "const note = `home is ${dir}`;",
      'new Deno.Command("git", { args: ["status"] })',
      'new Deno.Command(Deno.execPath(), { args: ["run", "scripts/run-tests.ts"] })',
      'const title = "the harness runs a fake binary";',
      'const worker = await import("../../apps/worker/src/client.ts");',
    ]
  ) {
    assertEquals(operatorLoginReasons(withoutComments(harmless)), [], harmless);
  }
});

Deno.test("a helper that reads the environment, imported into a harness-enabling test, is seen", () => {
  // The helper-file split: the test reads nothing itself.
  const files: Record<string, string> = {
    "tests/helpers/env.ts": 'export const home = Deno.env.get("HOME");',
    "tests/helpers/deep.ts":
      'import { home } from "./env.ts";\nexport { home };',
    "tests/helpers/clean.ts": "export const dir = '/tmp/x';",
    "tests/helpers/broken.ts": 'export const s = "never closed',
  };
  const read = (path: string) => files[path];
  const test = (imports: string) =>
    importsReadingEnvironment(
      "tests/unit/some_test.ts",
      withoutComments(imports),
      read,
    );
  assert(test('import { home } from "../helpers/env.ts";'), "direct import");
  assert(test('import { home } from "../helpers/deep.ts";'), "two levels");
  assert(test('export * from "../helpers/env.ts";'), "re-export");
  assert(
    test('const m = await import("../helpers/env.ts");'),
    "dynamic import",
  );
  assert(test('import x from "../helpers/broken.ts";'), "unscannable counts");
  assert(!test('import { dir } from "../helpers/clean.ts";'), "clean helper");
  assert(
    !test('import { a } from "@std/assert";'),
    "a package is not followed",
  );
  assert(!test('import { z } from "../helpers/missing.ts";'), "a missing file");
  // And through the whole file check: enabling the harness plus such an import.
  const enabling =
    'import { home } from "../helpers/env.ts";\nreadWorkerConfig({ BAKERY_CODEX_HARNESS: "1", HOME: home });';
  assertEquals(
    offendersOfSource("tests/unit/some_test.ts", enabling, read),
    ["tests/unit/some_test.ts: environment"],
  );
  // The same import without the harness is nothing; with the door it is nothing.
  assertEquals(
    offendersOfSource(
      "tests/unit/some_test.ts",
      'import { home } from "../helpers/env.ts";\nconst x = home;',
      read,
    ),
    [],
  );
  assertEquals(
    offendersOfSource(
      "tests/unit/some_test.ts",
      enabling + "\ndedicatedCodexTestAuthSource();",
      read,
    ),
    [],
  );
});

/** Runs a script in a child with only the permissions given, the way a lane would. */
async function runChild(
  permissions: readonly string[],
  code: string,
): Promise<
  { readonly success: boolean; readonly out: string; readonly err: string }
> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--config=${join(REPO, "deno.json")}`,
      ...permissions,
      "-",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const script = child.stdin.getWriter();
  await script.write(new TextEncoder().encode(code));
  await script.close();
  const output = await child.output();
  return {
    success: output.success,
    out: new TextDecoder().decode(output.stdout).trim(),
    err: new TextDecoder().decode(output.stderr),
  };
}

const ACCOUNT_HOME_SCRIPT = `import { accountHomeDirectory } from ${
  JSON.stringify(
    new URL("tests/helpers/codex-harness.ts", `file://${REPO}`).href,
  )
};\nconsole.log(JSON.stringify(accountHomeDirectory() ?? null));`;

Deno.test("the account home is found under each lane's own sys permissions", async () => {
  // os.userInfo() needs sys:gid, which no lane grants, so it threw there and the
  // check silently did nothing. The lookup must work with exactly these lists
  // (scripts/run-tests.ts): unit, integration and security; rails; provider.
  for (const sys of ["uid,statfs,osRelease", "uid,statfs", "uid"]) {
    const result = await runChild(
      [
        "--allow-env",
        `--allow-read=${REPO},/etc/passwd`,
        `--allow-sys=${sys}`,
      ],
      ACCOUNT_HOME_SCRIPT,
    );
    assert(result.success, `--allow-sys=${sys}: ${result.err}`);
    const home = JSON.parse(result.out);
    assert(
      typeof home === "string" && home.startsWith("/") && home.length > 1,
      `--allow-sys=${sys}: no account home found (${result.out})`,
    );
  }
});

Deno.test("without the permissions to find it, the account home is unknown and the gate refuses", async () => {
  for (
    const [label, permissions] of [
      ["no sys:uid", [
        "--allow-env",
        `--allow-read=${REPO},/etc/passwd`,
        "--allow-sys=statfs",
      ]],
      ["no read of /etc/passwd", [
        "--allow-env",
        `--allow-read=${REPO}`,
        "--allow-sys=uid",
      ]],
    ] as [string, string[]][]
  ) {
    const result = await runChild(permissions, ACCOUNT_HOME_SCRIPT);
    assert(result.success, `${label}: ${result.err}`);
    assertEquals(JSON.parse(result.out), null, label);
  }
});

Deno.test("a file the scanner cannot read is reported, not skipped", () => {
  for (
    const broken of [
      'const s = "never closed',
      "/* never closed",
      "const t = `never closed",
    ]
  ) {
    const found = offendersOfSource("tests/unit/some_test.ts", broken);
    assertEquals(found.length, 1, broken);
    assert(found[0]!.startsWith("tests/unit/some_test.ts: cannot scan source"));
  }
  // And a readable file with a problem is still reported as before.
  assertEquals(
    offendersOfSource("tests/unit/some_test.ts", 'join(home, ".codex")'),
    ["tests/unit/some_test.ts: path"],
  );
  assertEquals(
    offendersOfSource("tests/unit/some_test.ts", "const a = 1;"),
    [],
  );
});

Deno.test("no test file reaches the operator's Codex login except the sanctioned ones", async () => {
  const offenders: string[] = [];
  for await (const path of testFiles(join(REPO, "tests"))) {
    const relative = path.slice(REPO.length);
    if (Object.hasOwn(ALLOWED, relative)) continue;
    offenders.push(
      ...offendersOfSource(
        relative,
        await Deno.readTextFile(path),
        (target) => {
          try {
            return Deno.readTextFileSync(join(REPO, target));
          } catch {
            return undefined;
          }
        },
      ),
    );
  }
  assertEquals(
    offenders,
    [],
    "A test reaches the operator's own Codex login, or reads the environment " +
      "that would let it. Use dedicatedCodexTestAuthSource() from " +
      `tests/helpers/codex-harness.ts, which requires ${CODEX_TEST_AUTH_DIR_ENV}; ` +
      "or, for a file that only passes a variable to a child it spawns, add it " +
      "to MAY_NAME_VARIABLES or MAY_READ_ENVIRONMENT with the reason.",
  );
});

Deno.test("the sanctioned provider test keeps its own opt-in", async () => {
  const source = withoutComments(
    await Deno.readTextFile(
      join(REPO, "tests/provider/real-cli-conformance_test.ts"),
    ),
  );
  assert(
    /await realHarnessGate\(/.test(source),
    "real-cli-conformance_test.ts reads the operator's login and must stay behind realHarnessGate",
  );
});

Deno.test("each real-Codex test file gates on the credential check and uses only the dedicated directory", async () => {
  for (
    const file of [
      "tests/security/run-one-real-bounded-codex-harness-through-the-worker_test.ts",
      "tests/integration/run-one-real-bounded-codex-harness-through-the-worker_test.ts",
      "tests/e2e/run-one-real-bounded-codex-harness-through-the-worker_test.ts",
    ]
  ) {
    const source = withoutComments(await Deno.readTextFile(join(REPO, file)));
    assert(/await codexHarnessAvailable\(\)/.test(source), `${file}: no gate`);
    assert(
      /dedicatedCodexTestAuthSource\(\)/.test(source),
      `${file}: not using the dedicated credential directory`,
    );
    assert(
      /ignore:\s*codexAvailability\s*!==\s*true/.test(source),
      `${file}: the cases are not skipped when the gate says no`,
    );
  }
});
