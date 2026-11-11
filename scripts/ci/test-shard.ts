// Splits a test lane across the pull-request gate's parallel jobs.
//
// The partition is computed from the tree, never hand-listed: every
// `<laneRoot>/*_test.ts` file belongs to exactly one shard by construction, so a
// newly added test joins a shard automatically and an unknown shard index fails
// closed instead of silently running nothing.
//
// Files are assigned greedily, heaviest first, to the shard carrying the least
// weight, where weight is the file's byte size. Alphabetical parity (the first
// thing that comes to mind) is unlucky often enough to matter: it split the
// contract suite into a 65s shard and a 146s shard on the gate runner, and the
// gate's wall clock is set by its slowest lane. Byte size is a crude proxy for
// runtime, but a crude proxy that balances is worth more than an exactly fair
// coin flip that does not.
//
// Usage: test-shard.ts <lane-root> <shard-index> <shard-total>

export type ShardFile = {
  readonly path: string;
  readonly bytes: number;
};

export function shardFiles(
  files: readonly ShardFile[],
  shardIndex: number,
  shardTotal: number,
): string[] {
  if (!Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error("test shard: shard total must be a positive integer");
  }
  if (
    !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardTotal
  ) {
    throw new Error(
      `test shard: shard index ${shardIndex} outside 0..${shardTotal - 1}`,
    );
  }
  const shards: ShardFile[][] = Array.from(
    { length: shardTotal },
    () => [],
  );
  const weights = new Array<number>(shardTotal).fill(0);
  const heaviestFirst = [...files].sort((left, right) =>
    right.bytes - left.bytes || (left.path < right.path ? -1 : 1)
  );
  for (const file of heaviestFirst) {
    let target = 0;
    for (let index = 1; index < shardTotal; index++) {
      if (weights[index] < weights[target]) target = index;
    }
    shards[target].push(file);
    weights[target] += file.bytes;
  }
  return shards[shardIndex].map((file) => file.path).sort();
}

/**
 * Every path Deno's default test discovery matches: a name ending in `_test`,
 * `.test` or bare `test`, followed by a js/ts family extension. The shard must
 * select exactly what the lane would, or a shard split silently drops coverage:
 * `tests/unit/projects-onboarding-page_test.tsx` is four tests that a
 * `_test.ts` glob never sees.
 */
export const testFilePattern = /(^|[_.])test\.(ts|tsx|mts|js|mjs|jsx)$/;

async function collect(laneRoot: string): Promise<ShardFile[]> {
  if (!/^[A-Za-z0-9._/-]+$/.test(laneRoot) || laneRoot.includes("..")) {
    throw new Error(`test shard: unsafe lane root ${laneRoot}`);
  }
  const files: ShardFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile || !testFilePattern.test(entry.name)) continue;
      files.push({ path, bytes: (await Deno.stat(path)).size });
    }
  };
  await walk(laneRoot);
  if (files.length === 0) {
    throw new Error(`test shard: no test files found under ${laneRoot}`);
  }
  return files;
}

if (import.meta.main) {
  const [laneRoot, indexArgument, totalArgument] = Deno.args;
  if (!laneRoot) throw new Error("test shard: a lane root is required");
  const index = Number(indexArgument);
  const total = Number(totalArgument ?? "2");
  const selected = shardFiles(await collect(laneRoot), index, total);
  if (selected.length === 0) {
    throw new Error(`test shard: shard ${index} of ${total} is empty`);
  }
  console.log(selected.join(" "));
}
