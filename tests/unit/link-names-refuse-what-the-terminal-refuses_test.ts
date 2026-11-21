// The names, host names and architectures a machine or an Admin types for
// #70 refuse exactly the characters the link command's own terminal check
// (hasUnsafeCharacter) refuses, for every code point, so the two cannot drift.
import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { hasUnsafeCharacter } from "../../packages/worker-bootstrap/src/pairing.ts";

type Field = { name: string; bounds?: { pattern?: string } };

const FIELDS: Record<string, string[]> = {
  WorkerEnrollmentCreate: ["name"],
  WorkerLinkRequestApprove: ["name"],
  WorkerRegistration: ["name", "architecture"],
  WorkerLinkCodeInspect: ["hostname", "architecture"],
  WorkerLinkRequestCreate: ["hostname", "architecture"],
};

async function patterns(): Promise<string[]> {
  const source = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../docs/technical-design/transport-schemas.json",
        import.meta.url,
      ),
    ),
  );
  const found: string[] = [];
  const walk = (node: unknown, key: string) => {
    if (!node || typeof node !== "object") return;
    const fields = (node as { fields?: Field[] }).fields;
    if (FIELDS[key] && Array.isArray(fields)) {
      for (const name of FIELDS[key]) {
        const field = fields.find((entry) => entry.name === name);
        found.push(field?.bounds?.pattern ?? `missing ${key}.${name}`);
      }
    }
    for (const [child, value] of Object.entries(node)) walk(value, child);
  };
  walk(source, "");
  return found;
}

Deno.test("every #70 name field carries one pattern", async () => {
  const found = await patterns();
  assertEquals(found.length, 8);
  assertEquals(new Set(found).size, 1, found.join("\n"));
});

Deno.test("the pattern refuses exactly what the link command refuses", async () => {
  const [pattern] = await patterns();
  const expression = new RegExp(pattern!, "u");
  const disagree: string[] = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    const text = `a${String.fromCodePoint(code)}b`;
    if (expression.test(text) === hasUnsafeCharacter(text)) {
      disagree.push(code.toString(16));
      if (disagree.length > 20) break;
    }
  }
  assertEquals(disagree, []);
});

Deno.test("the server schema applies the pattern to astral characters", () => {
  const tag = { slots: 1, capabilities: ["git"], name: "a\u{e0041}b" };
  assertEquals(
    contractSchemas.WorkerLinkRequestApprove.safeParse(tag).success,
    false,
  );
  const emoji = {
    slots: 1,
    capabilities: ["git"],
    name: "Build box é 01 \u{1f35e}",
  };
  assertEquals(
    contractSchemas.WorkerLinkRequestApprove.safeParse(emoji).success,
    true,
  );
});
