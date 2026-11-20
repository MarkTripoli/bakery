import { assertEquals } from "@std/assert";

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

async function* sources(directory: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) yield* sources(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

Deno.test("no test closes only the auth fixture inside a repository rules fixture", async () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for await (const path of sources(root)) {
      const text = await Deno.readTextFile(path);
      if (
        text.includes("openRepositoryRulesFixture(") &&
        /\.fixture\.close\(\)/.test(text)
      ) offenders.push(path);
    }
  }
  assertEquals(
    offenders,
    [],
    "close the shared fixture with its own close(), which resets the database",
  );
});
