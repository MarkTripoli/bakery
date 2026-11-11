import { assertEquals } from "@std/assert";
import { extname, join, relative } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const productionRoots = ["apps/server/src", "packages", "scripts"] as const;
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
]);
const authRoot = "apps/server/src/modules/auth/";

export function rawRoleViolations(path: string, source: string): string[] {
  if (path.startsWith(authRoot)) return [];
  const violations: string[] = [];
  const patterns = [
    /\bOrganizationRole\.[A-Za-z]+/g,
    /\broleSatisfies\s*\(/g,
    /\b(?:actor|authority|member|membership)\w*\.role\s*(?:===|!==)\s*(?:OrganizationRole\.[A-Za-z]+|["'](?:admin|developer|viewer|guest)["'])/g,
    /(?:OrganizationRole\.[A-Za-z]+|["'](?:admin|developer|viewer|guest)["'])\s*(?:===|!==)\s*\b(?:actor|authority|member|membership)\w*\.role/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      violations.push(
        `${path}:${source.slice(0, match.index).split("\n").length}`,
      );
    }
  }
  return violations;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) files.push(...await sourceFiles(path));
    else if (entry.isFile && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

Deno.test("authorization outside auth uses permission keys", async () => {
  const violations: string[] = [];
  for (const directory of productionRoots) {
    for (const path of await sourceFiles(join(root, directory))) {
      const repositoryPath = relative(root, path);
      violations.push(
        ...rawRoleViolations(repositoryPath, await Deno.readTextFile(path)),
      );
    }
  }
  assertEquals(violations, []);
});

Deno.test("raw role rail rejects role helpers and comparisons", () => {
  const fixtures = [
    "OrganizationRole.Admin",
    "roleSatisfies(actor.role, minimum)",
    'membership.role === "developer"',
    '"guest" !== authority.role',
  ];
  for (const fixture of fixtures) {
    assertEquals(
      rawRoleViolations("apps/server/src/example.ts", fixture).length,
      1,
    );
  }
  assertEquals(
    rawRoleViolations(
      "apps/server/src/modules/auth/application/authorize.ts",
      'actor.role === "admin"',
    ),
    [],
  );
  assertEquals(
    rawRoleViolations("apps/server/src/example.ts", "input.role === undefined"),
    [],
  );
});
