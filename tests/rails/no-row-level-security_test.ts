import { assert, assertThrows } from "@std/assert";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);

const migrationRoots = [
  "apps/server/src/platform/migrations",
  "apps/server/src/modules/auth/migrations",
  "apps/server/src/modules/work/migrations",
  "apps/server/src/modules/projects/migrations",
  "apps/server/src/modules/agents/migrations",
  "apps/server/src/modules/repository-rules/migrations",
  "apps/server/src/modules/integrations/migrations",
  "apps/server/src/modules/delivery/migrations",
];

const rlsPatterns = [
  { pattern: /\bcreate\s+policy\b/i, behavior: "creates an RLS policy" },
  { pattern: /\benable\s+row\s+level\s+security\b/i, behavior: "enables RLS" },
  { pattern: /\bforce\s+row\s+level\s+security\b/i, behavior: "forces RLS" },
] as const;

/**
 * Pure scanner for one migration statement file. Throws an RLS_FORBIDDEN error
 * naming the offending path when the SQL creates a policy or enables/forces
 * row-level security. There is no allowlist: any match fails the rail.
 */
export const assertNoRowLevelSecurity = (path: string, sql: string): void => {
  for (const { pattern, behavior } of rlsPatterns) {
    if (pattern.test(sql)) {
      throw new Error(`RLS_FORBIDDEN: ${path} ${behavior}`);
    }
  }
};

const listSqlFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...await listSqlFiles(path));
    } else if (entry.isFile && entry.name.endsWith(".sql")) {
      files.push(path);
    }
  }
  return files.sort();
};

Deno.test("no migration enables row-level security or defines a policy", async () => {
  const paths: string[] = [];
  for (const migrationRoot of migrationRoots) {
    paths.push(...await listSqlFiles(`${root}${migrationRoot}`));
  }
  assert(paths.length > 0, "expected at least one migration SQL file");
  for (const path of paths) {
    const sql = await Deno.readTextFile(path);
    assertNoRowLevelSecurity(path.slice(root.length), sql);
  }
});

Deno.test("the RLS rail rejects synthetic policy and RLS syntax", () => {
  assertNoRowLevelSecurity(
    "tests/fixtures/clean.sql",
    "create table if not exists bakery.notes (id uuid primary key);",
  );
  for (
    const { path, sql } of [
      {
        path: "tests/fixtures/create-policy.sql",
        sql: "create policy notes_visible on bakery.notes using (true);",
      },
      {
        path: "tests/fixtures/enable-rls.sql",
        sql: "alter table bakery.notes enable row level security;",
      },
      {
        path: "tests/fixtures/force-rls.sql",
        sql: "alter table bakery.notes force row level security;",
      },
    ]
  ) {
    const error = assertThrows(
      () => assertNoRowLevelSecurity(path, sql),
      Error,
      "RLS_FORBIDDEN",
    );
    assert(
      error.message.includes(path),
      `the RLS rail must name the offending path for ${path}`,
    );
  }
});
