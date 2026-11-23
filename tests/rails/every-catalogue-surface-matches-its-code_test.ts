import { assert, assertEquals } from "@std/assert";

/**
 * Rails that compare each hand-maintained catalogue surface against the code
 * that actually serves it.
 *
 * Every one of these surfaces is written twice: once as a description a caller
 * navigates by, and once as the table the server switches on. Nothing kept them
 * in step, and the first case of that cost two seats an evening - the worker's
 * attempt context read shipped in #504 and was absent from the catalogue, so a
 * consumer concluded no such route existed and nearly built a second read path
 * beside it.
 *
 * The distinction these rails can and cannot draw matters. A surface that omits
 * a member is detectable by a diff and that is what happens here. A surface that
 * lists a member nothing produces is NOT detectable this way - it is exhaustive
 * and the world is short a writer - which is why a field's writer has to be
 * named when the field is declared, not discovered by whoever fills it.
 *
 * Sources are read as text rather than imported. Importing the server's route
 * table would start its module graph, and a rail that needs a database to
 * enumerate a list of strings is a rail that runs in one lane instead of all of
 * them.
 */

const root = new URL("../../", import.meta.url);

const transportSchemaPath = "docs/technical-design/transport-schemas.json"
  .replace(/^/, "");

async function transport(): Promise<{
  events: Record<string, unknown>;
  workerEvents: Record<string, unknown>;
  faults: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  workerActions: Record<
    string,
    {
      inputSchema?: string | null;
      outputSchema?: string | null;
      schemaSource?: string;
    }
  >;
}> {
  return JSON.parse(
    await Deno.readTextFile(new URL(transportSchemaPath, root)),
  );
}

/** Keys of the string-keyed object literal assigned to `const NAME`. */
function objectLiteralKeys(text: string, name: string): string[] {
  const start = text.indexOf(`const ${name}`);
  if (start === -1) return [];
  const open = text.indexOf("{", start);
  const close = text.indexOf("\n};", open);
  if (open === -1 || close === -1) return [];
  return [...text.slice(open, close).matchAll(/"([^"]+)"\s*:/g)]
    .map((match) => match[1]);
}

Deno.test("every worker event the server accepts is in the schema", async () => {
  // The server refuses an event whose type it does not recognise, so a type
  // accepted in code and absent from the schema is a worker told by its own
  // documentation that a working event is invalid.
  const shared = await Deno.readTextFile(
    new URL("apps/server/src/modules/execution/shared.ts", root),
  );
  const accepted = objectLiteralKeys(shared, "WORKER_EVENT_TYPES");
  assert(accepted.length > 0, "WORKER_EVENT_TYPES was not found");
  const documented = Object.keys((await transport()).workerEvents);
  assertEquals(
    accepted.filter((type) => !documented.includes(type)).sort(),
    [],
    "worker events accepted by the server but absent from transport-schemas.json",
  );
});

Deno.test("every standard fault the server can raise is in the schema", async () => {
  // A fault code is what a caller switches on. One raised in code and absent
  // from the schema is a client told its own handler is impossible.
  const faults = await Deno.readTextFile(
    new URL("packages/contracts/src/faults.ts", root),
  );
  const start = faults.indexOf("export const FAULTS");
  const close = faults.indexOf("\n} as const;", start);
  assert(start !== -1 && close !== -1, "FAULTS was not found");
  const raised = [
    ...faults.slice(start, close).matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm),
  ]
    .map((match) => match[1]);
  assert(raised.length > 0, "FAULTS raised no codes");
  const documented = Object.keys((await transport()).faults);
  assertEquals(
    raised.filter((code) => !documented.includes(code)).sort(),
    [],
    "fault codes raised by the server but absent from transport-schemas.json",
  );
});

Deno.test("every worker action's declared schemas can be found", async () => {
  // A worker action names the schemas it takes and returns, and where those
  // schemas live. Both halves are promises a caller navigates by: a schema name
  // nothing defines, or a `schemaSource` that does not contain the schema it is
  // cited for, sends that caller somewhere that cannot answer them.
  //
  // Schemas legitimately live in either the transport inventory or a design
  // chapter's action registry, so the check is not "is it in this file" - it is
  // "does the source it names actually define it".
  const spec = await transport();
  const known = {
    input: new Set(Object.keys(spec.inputs)),
    output: new Set(Object.keys(spec.outputs)),
  };
  const unresolved: string[] = [];
  for (const [action, entry] of Object.entries(spec.workerActions)) {
    for (const kind of ["input", "output"] as const) {
      const name = kind === "input" ? entry.inputSchema : entry.outputSchema;
      if (!name) continue;
      if (known[kind].has(name)) continue;
      // `schemaSource` is spelled three ways in practice: repo-root relative,
      // chapter-relative, or a bare markdown chapter name followed by a note.
      const source = (entry.schemaSource ?? "").split(" ")[0];
      const candidates = source.startsWith("packages/") ||
          source.startsWith("docs/")
        ? [source]
        : [`docs/technical-design/${source}`];
      let text = "";
      try {
        text = await Deno.readTextFile(new URL(candidates[0], root));
      } catch {
        unresolved.push(
          `${action} ${kind} ${name}: source ${source} unreadable`,
        );
        continue;
      }
      // A mention is not a definition. Naming a schema is exactly what a
      // dangling reference does, so the source must define it - as an
      // inventory key, an exported schema, or a registry table row.
      // The alternatives use RegExp literals rather than a template string so
      // the escaping survives: in a double-quoted string "\\(" collapses to
      // "(", and the group then matches a bare mention - the exact class this
      // check exists to reject. That bug shipped in the first version of this
      // rail and passed its own red-proof, because an invented name is never
      // mentioned at all.
      const defines = new RegExp(
        [
          `"?${name}"?\\s*:\\s*[{\[]`, // an inventory or registry key
          `"?${name}"?\\s*:\\s*[\"'\`]`, // a key mapped to a named schema
          `\\(\`?${name}\`?\\)`, // a named schema in a registry table row
          `export const ${name}\\b`, // an exported schema
          `\\|\\s*\`${name}\`\\s*(\\||$)`, // a table cell naming a definition
        ].join("|"),
      ).test(text);
      if (!defines) {
        unresolved.push(
          `${action} ${kind} ${name}: ${source} mentions but does not define it`,
        );
      }
    }
  }
  assertEquals(unresolved.sort(), []);
});
