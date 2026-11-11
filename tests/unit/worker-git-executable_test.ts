import { readdir, readFile } from "node:fs/promises";
import { assert, assertEquals } from "@std/assert";
import { workerRunExecutables } from "../../apps/worker/src/config.ts";
import { GIT_EXECUTABLE } from "../../apps/worker/src/git-executable.ts";

// The worker's --allow-run grant names git by absolute path, and Deno matches
// the path a command resolves to. A bare `git` resolves through PATH, so on a
// host whose PATH lists /bin before /usr/bin it becomes /bin/git, misses the
// grant and fails with NotCapable (issues #97 and #102). Granting the bare name
// instead would let whichever git comes first on PATH run, which is the wider
// grant the narrow list exists to avoid. So the worker spawns the one path it
// is granted, and this file keeps the grant and every spawn on that one name.
//
// The scan below looks at string literals, not at spawn calls: a spawn call can
// be written around (a constant, a variable, a copied flag), a literal cannot.
// It is a tripwire for accidents. It cannot see a name built at run time
// ("g" + "it"); the case that runs the worker under its production grants
// (tests/unit/run-deterministic-checks-bound-to-candidate-and-metadata_test.ts)
// is what fails when a bare git is actually spawned on a /bin-first host.

const workerSource = new URL("../../apps/worker/src/", import.meta.url);
const constantModule = "git-executable.ts";

async function* sources(
  directory: URL,
): AsyncGenerator<{ name: string; text: string }> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory()) yield* sources(child);
    else if (entry.name.endsWith(".ts")) {
      yield {
        name: child.pathname.slice(workerSource.pathname.length),
        text: await readFile(child, "utf8"),
      };
    }
  }
}

/** One string or template literal, as the code means it (comments excluded). */
type Literal = {
  readonly quote: '"' | "'" | "`";
  /** Its text; each `${...}` in a template is a single \u0001. */
  readonly text: string;
};

const HOLE = "\u0001";

/** Characters after which a `/` starts a regular expression and not a division. */
const REGEX_PRECEDES = new Set("(,=:[!&|?{};+-*%<>~^".split(""));

function decodeEscape(source: string, at: number): [string, number] {
  const next = source[at + 1];
  const hex = (digits: number) => {
    const code = source.slice(at + 2, at + 2 + digits);
    return /^[0-9a-fA-F]+$/.test(code) && code.length === digits
      ? [String.fromCharCode(parseInt(code, 16)), at + 2 + digits] as [
        string,
        number,
      ]
      : undefined;
  };
  if (next === "x") return hex(2) ?? ["x", at + 2];
  if (next === "u") {
    if (source[at + 2] === "{") {
      const end = source.indexOf("}", at + 3);
      const code = end > 0 ? source.slice(at + 3, end) : "";
      if (/^[0-9a-fA-F]{1,6}$/.test(code)) {
        return [String.fromCodePoint(parseInt(code, 16)), end + 1];
      }
    }
    return hex(4) ?? ["u", at + 2];
  }
  const simple: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    "0": "\0",
  };
  return [simple[next ?? ""] ?? next ?? "", at + 2];
}

/**
 * The string and template literals of a TypeScript source, with comments and
 * regular expressions skipped. `balanced` is false when the scanner ended
 * inside a string, template, comment or regex, which means it lost track and
 * its answer cannot be trusted.
 */
export function stringLiterals(
  source: string,
): { literals: Literal[]; balanced: boolean } {
  const literals: Literal[] = [];
  // Open templates: the brace depth inside each `${`, innermost last.
  const templates: Array<{ text: string; depth: number }> = [];
  let previous = "";
  let index = 0;

  const readTemplate = (start: number, text = ""): void => {
    let at = start;
    while (at < source.length) {
      const char = source[at];
      if (char === "\\") {
        const [decoded, next] = decodeEscape(source, at);
        text += decoded;
        at = next;
      } else if (char === "`") {
        literals.push({ quote: "`", text });
        previous = "`";
        index = at + 1;
        return;
      } else if (char === "$" && source[at + 1] === "{") {
        templates.push({ text: text + HOLE, depth: 0 });
        previous = "{";
        index = at + 2;
        return;
      } else {
        text += char;
        at += 1;
      }
    }
    index = source.length + 1; // ran off the end inside a template
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end + 1;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return { literals, balanced: false };
      index = end + 2;
    } else if (char === '"' || char === "'") {
      let text = "";
      let at = index + 1;
      let closed = false;
      while (at < source.length) {
        const here = source[at];
        if (here === "\\") {
          const [decoded, after] = decodeEscape(source, at);
          text += decoded;
          at = after;
        } else if (here === char) {
          closed = true;
          break;
        } else if (here === "\n") {
          break;
        } else {
          text += here;
          at += 1;
        }
      }
      if (!closed) return { literals, balanced: false };
      literals.push({ quote: char, text });
      previous = char;
      index = at + 1;
    } else if (char === "`") {
      readTemplate(index + 1);
    } else if (char === "{" && templates.length > 0) {
      templates[templates.length - 1].depth += 1;
      previous = "{";
      index += 1;
    } else if (char === "}" && templates.length > 0) {
      const open = templates[templates.length - 1];
      if (open.depth === 0) {
        templates.pop();
        readTemplate(index + 1, open.text);
      } else {
        open.depth -= 1;
        previous = "}";
        index += 1;
      }
    } else if (
      char === "/" && (previous === "" || REGEX_PRECEDES.has(previous) ||
        /\b(?:return|typeof|case|in|of|void|delete|throw|new)$/.test(
          source.slice(Math.max(0, index - 8), index).trimEnd(),
        ))
    ) {
      // A regular expression: skip to its closing slash, outside a class.
      let at = index + 1;
      let inClass = false;
      let closed = false;
      while (at < source.length && source[at] !== "\n") {
        const here = source[at];
        if (here === "\\") at += 2;
        else if (here === "[") {
          inClass = true;
          at += 1;
        } else if (here === "]") {
          inClass = false;
          at += 1;
        } else if (here === "/" && !inClass) {
          closed = true;
          break;
        } else at += 1;
      }
      if (!closed) return { literals, balanced: false };
      previous = "/";
      index = at + 1;
      while (/[a-z]/.test(source[index] ?? "")) index += 1;
    } else {
      if (!/\s/.test(char)) previous = char;
      index += 1;
    }
  }
  return {
    literals,
    balanced: templates.length === 0 && index <= source.length,
  };
}

/** A flag that grants `git` by its bare name: `--allow-run=...,git,...`. */
const bareGitGrant = /allow-run=(?:[^,\s]*,)*git(?=,|$)/;

/**
 * What in `source` would spawn or grant git by a name found on PATH: any
 * literal that is exactly `git`, and any `--allow-run=` list naming it.
 */
export function bareGitFindings(source: string): string[] {
  const { literals, balanced } = stringLiterals(source);
  const findings: string[] = [];
  if (!balanced) findings.push("the scanner lost track of the source");
  for (const { quote, text } of literals) {
    if (text === "git") findings.push(`a ${quote}git${quote} literal`);
    else if (bareGitGrant.test(text)) {
      findings.push(`a run grant naming git: ${text.slice(0, 60)}`);
    }
  }
  return findings;
}

Deno.test("the git the worker is granted is the absolute path it is told to spawn", () => {
  assert(GIT_EXECUTABLE.startsWith("/"), "a path, never a name found on PATH");
  const granted = workerRunExecutables("/usr/bin/deno", "/usr/bin/claude");
  assert(granted.includes(GIT_EXECUTABLE));
  assertEquals(granted.includes("git"), false, "no grant by bare name");
  // Without a harness the worker is granted no git at all, as before.
  assertEquals(
    workerRunExecutables("/usr/bin/deno").includes(GIT_EXECUTABLE),
    false,
  );
});

Deno.test("no worker source names git bare, or repeats the path", async () => {
  const bare: string[] = [];
  const repeatsPath: string[] = [];
  const lostTrack: string[] = [];
  let scanned = 0;
  for await (const { name, text } of sources(workerSource)) {
    scanned += 1;
    if (name === constantModule) continue;
    const { balanced } = stringLiterals(text);
    if (!balanced) lostTrack.push(name);
    for (const finding of bareGitFindings(text)) {
      bare.push(`${name}: ${finding}`);
    }
    if (text.includes(GIT_EXECUTABLE)) repeatsPath.push(name);
  }
  assert(scanned > 20, "the scan must actually see the worker sources");
  assertEquals(lostTrack, [], "the scanner lost track in these files");
  assertEquals(bare, [], "these name `git` where PATH would resolve it");
  assertEquals(
    repeatsPath,
    [],
    "these write the path out again instead of using GIT_EXECUTABLE",
  );
});

Deno.test("the scan flags a bare git however it is held, spawned or granted", () => {
  const forbidden: Array<[string, string]> = [
    // Spawned directly or through the shared seam.
    ['new Deno.Command("git", {', "double quotes"],
    ["new Deno.Command('git', {", "single quotes"],
    ["new Deno.Command(`git`, {", "a template"],
    ['new Deno.Command(\n    "git",', "a line break"],
    ['runGit(defaultGitSpawn, "git", cwd, args, 1);', "runGit"],
    ['defaultGitSpawn("git", { args: [], cwd })', "the default spawn"],
    ['startGitProcess("git", { args: [], cwd })', "the process starter"],
    ['spawnInOwnProcessGroup("git", args)', "the group spawn"],
    // Held somewhere first: the evasions a call-site match cannot see.
    ['const GIT = "git";', "a constant"],
    ["let name = 'git'; run(name);", "a variable"],
    ['const tools = ["sh", "git", "node"];', "a list element"],
    ['const tool = { executable: "git" };', "an object property"],
    ["export default `git`;", "an exact template"],
    ['const big = { a: { b: ["x", "git"] } };', "nested"],
    ['const g = "g\\x69t";', "a hex escape"],
    ['const g = "\\u0067it";', "a unicode escape"],
    ['const g = "\\u{67}it";', "a code point escape"],
    ["const g = `${x}`; const h = 'git';", "after a template"],
    ['const g = `${`${"git"}`}`;', "inside nested templates"],
    ['const g = `a ${f({ b: "git" })} c`;', "inside a template expression"],
    // Copied grants.
    ['const flag = "--allow-run=git";', "a grant of only git"],
    ['const flag = "--allow-run=zip,git";', "a grant ending in git"],
    [
      'const flag = "--allow-run=git,/usr/bin/git";',
      "a grant starting with git",
    ],
    [
      'const flag = "--allow-run=zip,git,/usr/bin/setsid";',
      "git in the middle",
    ],
    ["const flag = `--allow-run=${deno},git`;", "a template grant"],
    [
      "const flag = `--allow-run=${deno},/usr/bin/kill,git,${x}`;",
      "holes around it",
    ],
    ['args.push("--allow-run=node,git");', "pushed"],
  ];
  for (const [source, how] of forbidden) {
    assert(bareGitFindings(source).length > 0, `missed: ${how}: ${source}`);
  }
});

Deno.test("the scan lets through what is not a bare git", () => {
  const allowed: Array<[string, string]> = [
    ["new Deno.Command(GIT_EXECUTABLE, {", "the constant"],
    ['new Deno.Command("gitleaks", {', "another program"],
    [
      'new Deno.Command("/usr/bin/setsid", { args: ["status"] })',
      "an argument",
    ],
    ['const a = "git status";', "git inside a longer string"],
    ['const a = "digit";', "a word containing it"],
    ['const a = "GIT";', "another case"],
    ["const a = `git ${x}`;", "a template with more than git"],
    ["const a = `${x}`;", "only a hole"],
    ['// new Deno.Command("git", {', "a line comment"],
    ['/* const GIT = "git"; */ const a = 1;', "a block comment"],
    [
      '/**\n * the string "git" in a doc comment\n */\nconst a = 1;',
      "a doc comment",
    ],
    [
      'const url = "http://example.test/git"; // "git"',
      "// inside a string, then a comment",
    ],
    [
      "const re = /[\"'`]git[\"'`]/; const a = 1;",
      "a regular expression naming git",
    ],
    ["const flag = '--allow-run=/usr/bin/git';", "the absolute path grant"],
    [
      "const flag = `--allow-run=${GIT_EXECUTABLE},/usr/bin/node`;",
      "the constant in a grant",
    ],
    ['const flag = "--allow-run=zip,gitleaks,node";', "a different program"],
    [
      'const flag = "--allow-run=/usr/bin/git,/usr/bin/kill";',
      "only absolute paths",
    ],
    ["const a = 10 / 2; const b = 'ok';", "a division"],
    ['const a = (x) / 2 / 3; const b = "ok";', "two divisions"],
    ["const quoted = 'it\\'s';", "an escaped quote"],
  ];
  for (const [source, why] of allowed) {
    assertEquals(bareGitFindings(source), [], `flagged: ${why}: ${source}`);
  }
});

Deno.test("the scanner reads strings, comments, templates and regular expressions without losing track", () => {
  const cases: Array<[string, string[]]> = [
    ['const a = "x"; // "y"\nconst b = \'z\';', ["x", "z"]],
    ['/* "no" */ const a = "yes";', ["yes"]],
    ["const a = `p${q}r`;", [`p${HOLE}r`]],
    ["const a = `${`in`}out`;", ["in", `${HOLE}out`]],
    ['const a = `x${f({ k: "v" })}y`;', ["v", `x${HOLE}y`]],
    ["const a = /'/; const b = 'after';", ["after"]],
    ['const a = /["`]/g; const b = "after";', ["after"]],
    ['const a = x / 2; const b = "after";', ["after"]],
    ['const a = "a\\"b";', ['a"b']],
    ['const a = "tab\\tnl\\n";', ["tab\tnl\n"]],
    ['const a = "//";\nconst b = "c";', ["//", "c"]],
    ['const a = "/*";\nconst b = "c";', ["/*", "c"]],
    ["return /x/.test(s) ? 'y' : 'n';", ["y", "n"]],
  ];
  for (const [source, expected] of cases) {
    const { literals, balanced } = stringLiterals(source);
    assert(balanced, `lost track: ${source}`);
    assertEquals(literals.map((l) => l.text), expected, source);
  }
  // Truncated input is reported as unbalanced, never as a clean result.
  for (
    const broken of [
      'const a = "open',
      "const a = `open",
      "const a = `open ${x",
      "/* never closed",
      "const a = /open",
    ]
  ) {
    assertEquals(stringLiterals(broken).balanced, false, broken);
    assert(
      bareGitFindings(broken).length > 0,
      `a lost scan must be a finding: ${broken}`,
    );
  }
});

Deno.test("the scan reads the whole worker tree and finds nothing in the one file allowed to name git", async () => {
  // git-executable.ts is the only file that may mention a bare git (in its
  // comments); the scanner must see its code as clean, not skip it by luck.
  const text = await readFile(new URL(constantModule, workerSource), "utf8");
  const { balanced, literals } = stringLiterals(text);
  assert(balanced);
  assertEquals(
    literals.map((literal) => literal.text),
    [GIT_EXECUTABLE],
  );
  assertEquals(bareGitFindings(text), []);
});
