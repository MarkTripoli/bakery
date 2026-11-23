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
  // No leading \b: `artifact_preview_grants` must match too.
  /preview_(?:grants|sessions|access)\b/,
  /(?:knowledge|execution)\/previews(?:\/|\.ts|")/,
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

Deno.test("the rail sees every way a preview could be read", () => {
  const reads: [string, string][] = [
    ["the previews table", "select 1 from bakery.previews p"],
    ["run preview grants", "select 1 from bakery.preview_grants g"],
    ["run preview sessions", "select 1 from bakery.preview_sessions s"],
    ["artifact preview grants", "select 1 from bakery.artifact_preview_grants"],
    [
      "artifact preview sessions",
      "select 1 from bakery.artifact_preview_sessions",
    ],
    [
      "the execution previews module",
      'import { x } from "../execution/previews.ts";',
    ],
    [
      "the knowledge previews module",
      'import { x } from "../knowledge/previews/store.ts";',
    ],
  ];
  for (const [what, line] of reads) {
    assertEquals(previewReads("x.ts", line), ["x.ts:1"], what);
  }
  assertEquals(previewReads("x.ts", "select 1 from bakery.deployments d"), []);
});
