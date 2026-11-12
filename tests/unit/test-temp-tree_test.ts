import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { entriesOf, removeTreeSync } from "../../scripts/ci/temp-tree.ts";
import { prefixesOf } from "../../scripts/ci/test-temp-root.ts";

// #242: the helper that removes what tests leave behind has to cope with what
// they leave behind on purpose, and must never reach outside the tree it is given.

async function scratch(run: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "bakery-temp-tree-test-" });
  try {
    await run(dir);
  } finally {
    removeTreeSync(dir);
  }
}

Deno.test("a tree with a locked directory inside it is removed", async () => {
  await scratch(async (dir) => {
    const tree = join(dir, "tree");
    await Deno.mkdir(join(tree, "a", "locked", "deeper"), { recursive: true });
    await Deno.writeTextFile(join(tree, "a", "locked", "deeper", "f"), "x");
    await Deno.writeTextFile(join(tree, "a", "ordinary"), "y");
    await Deno.chmod(join(tree, "a", "locked"), 0o000);
    await Deno.chmod(join(tree, "a"), 0o500);
    removeTreeSync(tree);
    assertEquals(entriesOf(dir), []);
  });
});

Deno.test("a path that is already gone is not an error, and a single file is removed", async () => {
  await scratch(async (dir) => {
    removeTreeSync(join(dir, "never-existed"));
    const file = join(dir, "file");
    await Deno.writeTextFile(file, "x");
    removeTreeSync(file);
    assertEquals(entriesOf(dir), []);
  });
});

Deno.test("a symlink in the tree is removed as a link, and what it points at is left alone", async () => {
  await scratch(async (dir) => {
    const outside = join(dir, "outside");
    await Deno.mkdir(outside);
    await Deno.writeTextFile(join(outside, "keep"), "keep");
    await Deno.chmod(outside, 0o500);
    const tree = join(dir, "tree");
    await Deno.mkdir(tree);
    await Deno.symlink(outside, join(tree, "link"));
    removeTreeSync(tree);
    assertEquals(entriesOf(dir), ["outside"]);
    assertEquals(entriesOf(outside), ["keep"]);
    assertEquals(
      (await Deno.stat(outside)).mode! & 0o777,
      0o500,
      "the link's target was not made accessible",
    );
    await Deno.chmod(outside, 0o700);
  });
});

Deno.test("leaked entries are grouped by their name without the random suffix, most common first, and capped", () => {
  const names = [
    ...Array.from(
      { length: 5 },
      (_, i) => `bakery-coordinator-repo-${"abcdef"[i]}1B2c3D4e5`,
    ),
    "bakery-claude-quota-other-Zz91Qq",
    "bakery-claude-quota-other-Yy82Ww",
    "short",
  ];
  assertEquals(prefixesOf(names), {
    "bakery-coordinator-repo": 5,
    "bakery-claude-quota-other": 2,
    "short": 1,
  });
  const many = Array.from({ length: 40 }, (_, i) => `bakery-p${i}-ab12cd34`);
  assert(Object.keys(prefixesOf(many)).length <= 12);
});
