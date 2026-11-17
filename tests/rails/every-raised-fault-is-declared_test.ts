import { assertEquals } from "@std/assert";

/**
 * The fifth hand-maintained surface: the fault codes a server raise can use.
 *
 * Four rails already compare the catalogue to the code for routes, worker
 * events, fault declarations and worker-action schemas. This one closes the
 * other direction of the fault surface - a code the server raises but never
 * declared is a caller told nothing about a failure it can receive.
 *
 * The check is deliberately asymmetric. Every code raised MUST be declared.
 * A declared code that nothing currently raises is left alone: a fault may be
 * raised from a constant, from a different module, or reserved for a path that
 * is not written yet, and failing on those would make the rail cry wolf until
 * someone deleted a legitimate declaration.
 */

const root = new URL("../../", import.meta.url);

async function* serverSources(): AsyncGenerator<string> {
  const base = new URL("apps/server/src/", root);
  async function* walk(dir: URL): AsyncGenerator<string> {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) yield* walk(child);
      else if (entry.name.endsWith(".ts")) yield await Deno.readTextFile(child);
    }
  }
  yield* walk(base);
}

/** Every `code: "X"` passed to a `new StandardError(...)` in the server. */
function raisedFaults(text: string): string[] {
  return [
    ...text.matchAll(
      /new StandardError\(\{?[^}]*?code:\s*"([A-Z][A-Z0-9_]+)"/gs,
    ),
  ].map((match) => match[1]);
}

Deno.test("every fault the server raises is a declared fault", async () => {
  const spec = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/transport-schemas.json", root),
    ),
  ) as { faults: Record<string, unknown> };
  const declared = new Set(Object.keys(spec.faults));
  const raised = new Set<string>();
  for await (const text of serverSources()) {
    for (const code of raisedFaults(text)) raised.add(code);
  }
  // A sanity floor: if the walk or the pattern breaks, this fails rather than
  // passing an empty set and reporting that the server raises no faults.
  assertEquals(raised.size > 20, true, "the raise scan found too few codes");
  assertEquals(
    [...raised].filter((code) => !declared.has(code)).sort(),
    [],
    "fault codes raised by the server but absent from transport-schemas.json",
  );
});

Deno.test("every fault a catalogue action names is a declared fault", async () => {
  // The catalogue's per-action `errors` lists are written by hand, so they can
  // name a code that does not exist - a caller reading them would write a
  // handler for an impossible response.
  const spec = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/transport-schemas.json", root),
    ),
  ) as { faults: Record<string, unknown> };
  const declared = new Set(Object.keys(spec.faults));
  const catalog = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/api-catalog.json", root),
    ),
  ) as { actions: { action: string; errors?: string[] | null }[] };
  const dangling: string[] = [];
  let references = 0;
  for (const entry of catalog.actions) {
    for (const code of entry.errors ?? []) {
      references += 1;
      if (!declared.has(code)) dangling.push(`${entry.action} -> ${code}`);
    }
  }
  assertEquals(references > 1000, true, "the catalogue names too few errors");
  assertEquals(dangling.sort(), []);
});
