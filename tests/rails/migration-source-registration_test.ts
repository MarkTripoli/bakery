import { assert, assertEquals } from "@std/assert";

const root = new URL("../../", import.meta.url);

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* walk(child);
    else if (entry.name.endsWith(".ts")) yield child;
  }
}

/** Every bakery migration source exported by a server module. */
async function moduleSources(): Promise<string[]> {
  const names: string[] = [];
  const modules = new URL("apps/server/src/modules/", root);
  for await (const entry of Deno.readDir(modules)) {
    if (!entry.isDirectory) continue;
    const file = new URL(`${entry.name}/migrations.ts`, modules);
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    for (
      const match of text.matchAll(/export const (\w+BakeryMigrationSource)\b/g)
    ) {
      names.push(match[1]);
    }
  }
  return names.sort();
}

const load = (name: string) => `loadMigrations(${name})`;
const count = (text: string, needle: string) => text.split(needle).length - 1;

Deno.test("module migration sources include every server module", async () => {
  const sources = await moduleSources();
  for (
    const expected of [
      "agentsBakeryMigrationSource",
      "repositoryRulesBakeryMigrationSource",
      "integrationsBakeryMigrationSource",
      "deliveryBakeryMigrationSource",
    ]
  ) assert(sources.includes(expected), expected);
});

Deno.test("every fixed migration list that loads the agents source loads all module sources", async () => {
  const sources = await moduleSources();
  const anchor = load("agentsBakeryMigrationSource");
  const missing: string[] = [];
  let checked = 0;
  for (const dir of ["tests/", "scripts/", "apps/server/src/"]) {
    for await (const file of walk(new URL(dir, root))) {
      const path = file.pathname.slice(root.pathname.length);
      if (path === "tests/rails/migration-source-registration_test.ts") {
        continue;
      }
      const text = await Deno.readTextFile(file);
      const lists = count(text, anchor);
      if (lists === 0) continue;
      checked += 1;
      for (const name of sources) {
        if (count(text, load(name)) < lists) missing.push(`${path}: ${name}`);
      }
    }
  }
  assert(checked >= 18, `expected to inspect the fixtures, saw ${checked}`);
  assertEquals(missing, []);
});
