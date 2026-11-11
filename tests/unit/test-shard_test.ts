import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type ShardFile,
  shardFiles,
  testFilePattern,
} from "../../scripts/ci/test-shard.ts";

const file = (name: string, bytes: number): ShardFile => ({
  path: `tests/lane/${name}`,
  bytes,
});

const files: ShardFile[] = [
  file("a_test.ts", 10),
  file("b_test.ts", 20),
  file("c_test.ts", 30),
  file("d_test.ts", 40),
];

const pathsOf = (shard: readonly string[]): string[] => [...shard].sort();

Deno.test("test shards partition every test file exactly once", () => {
  const shards = [0, 1].map((index) => shardFiles(files, index, 2));
  assertEquals(
    pathsOf([...shards[0], ...shards[1]]),
    pathsOf(files.map((entry) => entry.path)),
    "every file is assigned to exactly one shard",
  );
  const overlap = shards[0].filter((path) => shards[1].includes(path));
  assertEquals(overlap, [], "no file appears in both shards");
});

Deno.test("test shards balance the heaviest file away from the rest", () => {
  // Alphabetical parity puts the 40-byte file with the 10-byte one and leaves
  // 50 bytes against 30. Heaviest-first greedy gives 40 against 60 — and the
  // gate's wall clock is its slowest shard, not its total.
  const heavy = [
    file("heavy_test.ts", 400),
    file("light_a_test.ts", 10),
    file("light_b_test.ts", 10),
    file("light_c_test.ts", 10),
  ];
  const shards = [0, 1].map((index) => shardFiles(heavy, index, 2));
  const heaviest = shards.filter((shard) =>
    shard.includes("tests/lane/heavy_test.ts")
  );
  assertEquals(heaviest.length, 1, "the heavy file lands in one shard");
  assertEquals(
    heaviest[0].length,
    1,
    "the heavy file is alone in its shard when it outweighs everything else",
  );
  assertEquals(shards.flat().length, heavy.length);
});

Deno.test("test shards stay deterministic and cover three shards", () => {
  const first = [0, 1, 2].map((index) => shardFiles(files, index, 3));
  const second = [0, 1, 2].map((index) => shardFiles(files, index, 3));
  assertEquals(first, second, "the partition is stable across runs");
  assertEquals(
    pathsOf(first.flat()),
    pathsOf(files.map((entry) => entry.path)),
  );
  assertEquals(shardFiles(files, 0, 1).length, files.length);
});

Deno.test("test shard selection fails closed on an unknown shard", () => {
  for (const [index, total] of [[2, 2], [-1, 2], [0, 0], [0, -1], [0.5, 2]]) {
    assertThrows(() => shardFiles(files, index, total), Error, "test shard:");
  }
});

Deno.test("shard discovery matches Deno's default test file pattern", () => {
  // A shard that selects fewer files than the lane would silently drops
  // coverage, so the pattern is pinned against Deno's own discovery rule.
  for (
    const name of [
      "access-bindings_test.ts",
      "projects-onboarding-page_test.tsx",
      "widget.test.ts",
      "test.ts",
      "worker_test.mjs",
      "helper_test.mts",
    ]
  ) {
    assert(testFilePattern.test(name), `${name} is a test file`);
  }
  for (
    const name of [
      "browser-gates.node.mjs",
      "runner-label-policy.node.mjs",
      "contract-shard.ts",
      "test-helpers.ts",
      "latest.ts",
      "test.tsx.bak",
    ]
  ) {
    assert(!testFilePattern.test(name), `${name} is not a test file`);
  }
  assert(
    testFilePattern.test("tests/unit/projects-onboarding-page_test.tsx"),
    "the .tsx unit test is discovered",
  );
});

Deno.test("the live gate shards the contract and unit lanes", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/ci.yml");
  const policy = JSON.parse(
    await Deno.readTextFile("scripts/ci/required-checks.json"),
  ) as { lanes: Array<{ lane: string; job: string }> };
  // The contract suite is heavy-tailed on the gate runner (one file is 66s
  // against a mass of seconds), so it takes three shards; the unit lane two.
  const expectedShards: Array<[prefix: string, root: string, total: number]> = [
    ["fast / contract descriptions", "tests/contract", 3],
    ["fast / focused unit", "tests/unit", 2],
  ];
  for (const [prefix, laneRoot, total] of expectedShards) {
    const shards = policy.lanes.filter((lane) => lane.job.startsWith(prefix));
    assertEquals(shards.length, total, `${prefix} declares ${total} lanes`);
    for (let index = 0; index < total; index++) {
      assert(
        workflow.includes(`test-shard.ts ${laneRoot} ${index} ${total}`),
        `ci.yml selects shard ${index} of ${total} of ${laneRoot}`,
      );
    }
  }
  assert(
    workflow.includes("test:contract -- ${{ steps.shard.outputs.files }}"),
    "the contract shard feeds its file list to the lane",
  );
  assert(
    workflow.includes("test:unit -- ${{ steps.shard.outputs.files }}"),
    "the unit shard feeds its file list to the lane",
  );
});
