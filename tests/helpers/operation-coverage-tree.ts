import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import {
  type CoverageLedger,
  createdTables,
  droppedTables,
} from "./operation-coverage.ts";

/** Reads the real repository for the coverage checks. */

const root = new URL("../../", import.meta.url);

/** A repository-relative path as a file URL. */
function url(path: string): URL {
  return new URL(path, root);
}

/** Repository-relative text, or null when the file does not exist. */
export function readRepoText(path: string): string | null {
  try {
    return Deno.readTextFileSync(url(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** Every file under a directory whose name satisfies the predicate. */
function walk(
  dir: string,
  keep: (name: string) => boolean,
  out: string[] = [],
): string[] {
  for (const entry of Deno.readDirSync(url(dir))) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(path, keep, out);
    } else if (keep(entry.name)) {
      out.push(path);
    }
  }
  return out.sort();
}

/** The approved operation catalog's action names. */
export function catalogActions(): string[] {
  const catalog = JSON.parse(
    readRepoText("docs/technical-design/api-catalog.json") ?? "{}",
  ) as { actions: { action: string }[] };
  return catalog.actions.map((entry) => entry.action);
}

/** The action names the shared registry serves. */
export function registeredActions(): string[] {
  return [...(implementedActions as readonly string[])];
}

/** The logical data model's table names. */
export function modeledTables(): string[] {
  const model = JSON.parse(
    readRepoText("docs/technical-design/data-model.json") ?? "{}",
  ) as { tables: { name: string }[] };
  return model.tables.map((table) => table.name);
}

/**
 * Tables the migrations create and never drop, each with the first migration
 * that creates it.
 */
export function migratedTables(): Record<string, string> {
  const created: Record<string, string> = {};
  const dropped = new Set<string>();
  const files = [
    ...walk("apps", (name) => name.endsWith(".sql")),
    ...walk("packages", (name) => name.endsWith(".sql")),
  ].filter((path) => path.includes("/migrations/"));
  for (const path of files) {
    const sql = readRepoText(path) ?? "";
    for (const table of createdTables(sql)) created[table] ??= path;
    for (const table of droppedTables(sql)) dropped.add(table);
  }
  for (const table of dropped) delete created[table];
  return created;
}

/** Server source that is not a test, by repository-relative path. */
export function serverSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (
    const path of walk(
      "apps/server/src",
      (name) => name.endsWith(".ts") && !name.endsWith("_test.ts"),
    )
  ) {
    out[path] = readRepoText(path) ?? "";
  }
  return out;
}

/** Every test file under tests/, by repository-relative path. */
export function testSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of walk("tests", (name) => name.endsWith("_test.ts"))) {
    out[path] = readRepoText(path) ?? "";
  }
  return out;
}

export const LEDGER_PATH = "docs/technical-design/operation-coverage.json";

/** The committed coverage ledger. */
export function loadLedger(): CoverageLedger {
  const text = readRepoText(LEDGER_PATH);
  if (text === null) throw new Error(`${LEDGER_PATH} is missing`);
  return JSON.parse(text) as CoverageLedger;
}
