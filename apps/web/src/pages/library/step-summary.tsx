import type { ReactNode } from "react";

/**
 * What goes under a step's name: the spec's sentence for its action, then (on
 * a workflow whose agents are known) the "Agent: {name}, version {n}" line,
 * each on a line of its own. Nothing when neither exists.
 */
export function stepSummary(
  line: string | undefined,
  agent: string | undefined,
): ReactNode {
  if (line === undefined && agent === undefined) return undefined;
  return (
    <>
      {line === undefined ? null : <div data-step-line="action">{line}</div>}
      {agent === undefined ? null : <div data-step-line="agent">{agent}</div>}
    </>
  );
}
