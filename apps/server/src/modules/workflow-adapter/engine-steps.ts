/**
 * Steps the engine settles itself, over time (docs/technical-design/25-one-engine.md,
 * "One engine": the core names no pack). A pack hands the engine a runner for
 * the actions it owns; the engine calls it between two short transactions and
 * records what it answered. The core knows only these three answers.
 */

/** What the engine knows about the step it hands over. */
export type EngineStepRequest = Readonly<{
  organizationId: string;
  runId: string;
  taskId: string;
  repositoryId: string | null;
  requestedBy: string;
  traceId: string;
  stepKey: string;
  iteration: number;
  action: string;
  input: unknown;
  /** The step's own row, which a pack may key what it holds for the step by. */
  runStepId: string;
  /**
   * The step's per-call cost ceiling in US dollars (`limits.maxCostUsd`), as a
   * decimal of at most six places; null when the step names none. A runner that
   * can spend money holds it before anything is sent.
   */
  costCeilingUsd: string | null;
}>;

/** Done, refused with a stable code, or not yet (the engine looks again later). */
export type EngineStepResult =
  | Readonly<{ kind: "completed"; output: unknown }>
  | Readonly<{ kind: "failed"; code: string; message: string }>
  | Readonly<{ kind: "pending" }>;

export type EngineStepRunner = Readonly<{
  /** Whether this runner owns the action. */
  handles(action: string): boolean;
  /**
   * Runs the step. It must be safe to call again for the same step key after any
   * crash: the key is the one effect key of the step end to end.
   */
  run(request: EngineStepRequest): Promise<EngineStepResult>;
  /**
   * Called once when the engine ends a step it did not settle (it waited past
   * its limit, or the run was canceled or ended while the step was pending).
   * A runner that holds something for the step ends it here, as unknown, never
   * as free. Absent, nothing is held. It must be safe to call for any step.
   */
  abandon?(request: EngineStepRequest): Promise<void>;
}>;

/**
 * One runner over several: each action goes to the runner that owns it, so a pack
 * (delivery) and the neutral kernel (tool.call) can each hand the engine theirs.
 */
export function composeEngineStepRunners(
  runners: readonly EngineStepRunner[],
): EngineStepRunner {
  return {
    handles: (action) => runners.some((runner) => runner.handles(action)),
    run(request) {
      const owner = runners.find((runner) => runner.handles(request.action));
      if (owner === undefined) {
        return Promise.resolve({
          kind: "failed",
          code: "ENGINE_STEP_UNAVAILABLE",
          message: "No runner owns this step's action.",
        });
      }
      return owner.run(request);
    },
    async abandon(request) {
      await runners.find((runner) => runner.handles(request.action))
        ?.abandon?.(request);
    },
  };
}
