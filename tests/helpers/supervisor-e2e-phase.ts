const PHASE_LINE = /(?:^|\s)SUPERVISOR_E2E_PHASE:(\S+)$/;

/**
 * The line the supervisor e2e child prints at each boundary of its tests. The
 * parent keeps the last one so a timeout names where the child was.
 */
export function supervisorPhaseLine(
  test: string,
  phase: string,
  elapsedMs: number,
): string {
  return `SUPERVISOR_E2E_PHASE:${test}:${phase}:${Math.round(elapsedMs)}`;
}

/** Remembers the last phase line in output that arrives in arbitrary chunks. */
export function createSupervisorPhaseTracker(): {
  readonly push: (chunk: string) => void;
  readonly last: () => string;
} {
  let pending = "";
  let last = "none";
  return {
    push(chunk) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = PHASE_LINE.exec(line.trimEnd());
        if (match) last = match[1];
      }
    },
    last: () => last,
  };
}

export function supervisorChildTimeoutMessage(
  budgetMs: number,
  elapsedMs: number,
  lastPhase: string,
): string {
  return `SUPERVISOR_E2E_CHILD_TIMEOUT:${budgetMs}:${
    Math.round(elapsedMs)
  }:${lastPhase}`;
}
