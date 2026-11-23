import { assertEquals } from "@std/assert";
import { join } from "node:path";

// #63. A preview is a private look at the run's head at one moment. Release
// health and candidate acceptance are decided from deployment, check and review
// rows pinned to the merged or candidate commit, so a preview of any other SHA
// cannot satisfy either. This rail keeps it that way: the delivery modules
// never read the previews table or import the previews module.

const root = new URL("../..", import.meta.url).pathname;
const deliveryRoot = "apps/server/src/modules/delivery";
const FORBIDDEN = [
  /\bbakery\.previews\b/,
  /\bpreview_(?:grants|sessions|access)\b/,
  /knowledge\/previews/,
];

export function previewReads(path: string, source: string): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (FORBIDDEN.some((pattern) => pattern.test(line))) {
      found.push(`${path}:${index + 1}`);
    }
  });
  return found;
}

Deno.test("the delivery modules never read a preview to decide health or acceptance", async () => {
  const violations: string[] = [];
  let checked = 0;
  for await (const entry of Deno.readDir(join(root, deliveryRoot))) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    checked += 1;
    const path = `${deliveryRoot}/${entry.name}`;
    violations.push(
      ...previewReads(path, await Deno.readTextFile(join(root, path))),
    );
  }
  assertEquals(violations, []);
  if (checked < 10) throw new Error("the delivery modules were not found");
});

Deno.test("the rail sees a read of the previews table", () => {
  assertEquals(
    previewReads("x.ts", "select 1 from bakery.previews p"),
    ["x.ts:1"],
  );
  assertEquals(previewReads("x.ts", "select 1 from bakery.deployments d"), []);
});
