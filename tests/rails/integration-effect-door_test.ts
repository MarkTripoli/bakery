import { assertEquals } from "@std/assert";
import { extname, join, relative } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const productionRoots = ["apps", "packages", "scripts"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const skipDirectories = new Set(["node_modules", "dist", "build", ".next"]);
/** The only two production files allowed to call a handler's `invoke`. */
const doorFiles = new Set([
  "apps/server/src/modules/catalog/integration-invoke.ts",
  "apps/server/src/modules/effects/dispatch.ts",
]);

/**
 * Integration handlers are `DefinedAction` objects (packages/integration-sdk)
 * reached as `action.handler`; their `invoke` is the raw provider call.
 */
const bypassPatterns: readonly RegExp[] = [
  /\bhandler\w*\s*\??\.\s*invoke\b/g,
  /\.handler\s*\??\.?\s*\[\s*["'`]invoke["'`]\s*\]/g,
  /\bhandlers?\s*(?:\[[^\]]*\]|\.\w+)\s*\??\.\s*invoke\b/g,
  /\{[^{}]*\binvoke\b[^{}]*\}\s*=/g,
  /\{[^{}]*\bhandler\s*:\s*\{[^{}]*\binvoke\b/g,
  /\bimport\s*(?:type\s*)?\{[^}]*\b(?:rawInvoke|invokeRaw|invokeProvider|invokeHandler)\b[^}]*\}\s*from/g,
];

function stripComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(
    /\/\/[^\n]*/g,
    blank,
  );
}

/** Names bound to a handler: `const h = x.handler`, `{ handler }`, `{ handler: h }`. */
function handlerAliases(code: string): Set<string> {
  const names = new Set<string>();
  for (
    const m of code.matchAll(
      /\b(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?\.\s*handler\b(?!\s*\.\s*\w)/g,
    )
  ) names.add(m[1]!);
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*[^;]+/g)) {
    for (const part of m[1]!.split(",")) {
      const t = part.trim();
      const alias = /^handler\s*:\s*(\w+)/.exec(t)?.[1] ??
        (/^handler\b/.test(t) ? "handler" : undefined);
      if (alias) names.add(alias);
    }
  }
  return names;
}

export function integrationDoorViolations(
  path: string,
  source: string,
): string[] {
  if (doorFiles.has(path)) return [];
  const code = stripComments(source);
  const lines = new Set<number>();
  const lineOf = (index: number | undefined) =>
    code.slice(0, index).split("\n").length;
  for (const pattern of bypassPatterns) {
    for (const match of code.matchAll(pattern)) lines.add(lineOf(match.index));
  }
  for (const name of handlerAliases(code)) {
    for (
      const match of code.matchAll(
        new RegExp(`\\b${name}\\s*\\??\\.\\s*invoke\\b`, "g"),
      )
    ) lines.add(lineOf(match.index));
  }
  return [...lines].sort((x, y) => x - y).map((n) => `${path}:${n}`);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      if (!skipDirectories.has(entry.name)) {
        files.push(...await sourceFiles(path));
      }
    } else if (entry.isFile && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(path) ||
    /[._]test\.[cm]?[jt]sx?$/.test(path);
}

Deno.test("integration handler invoke is only called by the effect ledger door", async () => {
  const violations: string[] = [];
  let scanned = 0;
  for (const directory of productionRoots) {
    for (const path of await sourceFiles(join(root, directory))) {
      const repositoryPath = relative(root, path);
      if (isTestPath(repositoryPath)) continue;
      scanned++;
      violations.push(
        ...integrationDoorViolations(
          repositoryPath,
          await Deno.readTextFile(path),
        ),
      );
    }
  }
  assertEquals(scanned > 0, true);
  assertEquals(violations, []);
});

Deno.test("door files still contain the handler invoke the rail allows", async () => {
  for (const path of doorFiles) {
    const source = await Deno.readTextFile(join(root, path));
    assertEquals(
      /\.handler\.invoke\(/.test(stripComments(source)),
      true,
      `${path} no longer calls handler.invoke; rail is stale`,
    );
  }
});

Deno.test("door rail flags synthetic bypasses and allows the door", () => {
  const bypasses = [
    "await action.handler.invoke(ctx, args);",
    "const {handler}=action; handler.invoke(ctx, a);",
    "const {handler:h}=action; h.invoke(ctx, a);",
    "const h=action.handler; h.invoke(ctx, a);",
    "const {handler:{invoke}}=action;",
    "action.handler /* c */ .invoke(ctx, a);",
    "handler.invoke.bind(handler);",
    "await handler.invoke(ctx, a);",
    "await action.handler?.invoke(ctx, args);",
    'await action.handler["invoke"](ctx, args);',
    "const { invoke } = action.handler;",
    "await def.handlers[key].invoke(ctx, args);",
    'import { rawInvoke } from "./provider.ts";',
  ];
  for (const snippet of bypasses) {
    assertEquals(
      integrationDoorViolations("apps/server/src/example.ts", snippet).length >
        0,
      true,
      snippet,
    );
  }
  assertEquals(
    integrationDoorViolations(
      "apps/server/src/modules/effects/dispatch.ts",
      "action.handler.invoke(ctx, args)",
    ),
    [],
  );
  assertEquals(
    integrationDoorViolations(
      "apps/worker/src/x.ts",
      "await state.preparedSecretInvoker.invoke(a, b)",
    ),
    [],
  );
});
