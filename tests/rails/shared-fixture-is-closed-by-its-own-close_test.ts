import { assertEquals, assertNotEquals } from "@std/assert";
import { readdir, readFile } from "node:fs/promises";

/**
 * A shared fixture that resets the database in its own `close()` must be closed
 * with that `close()`.
 *
 * `openRepositoryRulesFixture` wraps the auth fixture and resets the database
 * when it closes. A test that closed only the wrapped auth fixture
 * (`fixture.fixture.close()`) left the nine identities it had created in the
 * database, and every later test that opened the auth fixture refused the
 * database as being in the legacy-bootstrap state: one defect that showed up as
 * a block of unrelated failures in another test file's lane run.
 */

const ROOTS = ["tests/integration", "tests/security", "tests/e2e"] as const;

/** Every `.ts` file under a root; a root that does not exist yields none. */
async function sources(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.endsWith(".ts")).map((entry) =>
    `${root}/${entry}`
  );
}

Deno.test("no test closes only the auth fixture inside a repository rules fixture", async () => {
  const offenders: string[] = [];
  let usingTheRulesFixture = 0;
  for (const root of ROOTS) {
    for (const path of await sources(root)) {
      const text = await readFile(path, "utf8");
      if (!text.includes("openRepositoryRulesFixture(")) continue;
      usingTheRulesFixture += 1;
      if (/\.fixture\.close\(\)/.test(text)) offenders.push(path);
    }
  }
  assertNotEquals(
    usingTheRulesFixture,
    0,
    "the rail scanned no test that opens a repository rules fixture, so it proves nothing",
  );
  assertEquals(
    offenders,
    [],
    "close the shared fixture with its own close(), which resets the database",
  );
});
