import type { Cutoff } from "../../../apps/server/src/modules/backups/cutoff-rules.ts";

/**
 * What the server answers to the runner's cutoff request (backupRunner.cutoff):
 * the database clock at the moment the installation was quiet, and a census of
 * the external effects that could still reach a provider at that moment.
 */
export type CutoffView = {
  readonly runId: string;
  readonly cutoffAt: string;
  readonly effectsTotal: number;
  readonly effectsPrepared: number;
  readonly effectsSubmitted: number;
  readonly effectsUncertain: number;
  readonly effectsByOperation: readonly {
    readonly operation: string;
    readonly count: number;
  }[];
  readonly effectsDigest: string;
};

/** The cutoff as the manifest records it: a database cutoff with its census. */
export function cutoffFromView(view: CutoffView): Cutoff {
  return {
    at: view.cutoffAt,
    source: "database",
    effects: {
      total: view.effectsTotal,
      prepared: view.effectsPrepared,
      submitted: view.effectsSubmitted,
      uncertain: view.effectsUncertain,
      byOperation: view.effectsByOperation.map((entry) => ({
        operation: entry.operation,
        count: entry.count,
      })),
      digest: view.effectsDigest,
    },
  };
}
