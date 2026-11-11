import { statfs } from "node:fs/promises";
import {
  type ArtifactStorageConfig,
  readArtifactStorageConfig,
} from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";

export type StorageCapacity = {
  readonly state:
    | "normal"
    | "warning"
    | "paused"
    | "unavailable"
    | "unmonitored";
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedPercent: number;
};

export function capacityFromBlocks(
  blocks: number,
  available: number,
  blockSize: number,
  config: Pick<ArtifactStorageConfig, "warnPercent" | "pausePercent">,
): StorageCapacity {
  if (
    ![blocks, available, blockSize].every(Number.isSafeInteger) ||
    blocks <= 0 || blockSize <= 0 || available < 0 || available > blocks ||
    !Number.isSafeInteger(blocks * blockSize)
  ) {
    return {
      state: "unavailable",
      totalBytes: 0,
      availableBytes: 0,
      usedPercent: 0,
    };
  }
  const usedPercent = (blocks - available) / blocks * 100;
  return {
    state: usedPercent >= config.pausePercent
      ? "paused"
      : usedPercent >= config.warnPercent
      ? "warning"
      : "normal",
    totalBytes: blocks * blockSize,
    availableBytes: available * blockSize,
    usedPercent,
  };
}

export async function readStorageCapacity(
  config = readArtifactStorageConfig(),
): Promise<StorageCapacity> {
  if (config.dataDirectory === undefined) {
    return {
      state: "unmonitored",
      totalBytes: 0,
      availableBytes: 0,
      usedPercent: 0,
    };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const stats = await Promise.race([
      statfs(config.dataDirectory),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new StandardError({ code: "DEPENDENCY_TIMEOUT" })),
          1000,
        );
      }),
    ]);
    return capacityFromBlocks(stats.blocks, stats.bavail, stats.bsize, config);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      state: "unavailable",
      totalBytes: 0,
      availableBytes: 0,
      usedPercent: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function assertArtifactWriteCapacity(capacity: StorageCapacity): void {
  if (capacity.state === "paused" || capacity.state === "unavailable") {
    throw new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { retryAfterSeconds: 60 },
    });
  }
}
