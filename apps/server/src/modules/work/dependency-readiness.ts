/** Admission status a run takes from its prerequisite tasks. */
export type DependencyReadiness = {
  status: "queued" | "blocked";
  reason: string | null;
};

/**
 * The one readiness rule: a run is queued only when every prerequisite task is
 * completed, else blocked with `dependency_incomplete`. Admission applies it to
 * the statuses it reads; dependency release re-applies it to the current ones.
 */
export function resolveDependencyReadiness(
  dependencies: readonly { status: string }[],
): DependencyReadiness {
  const ready = dependencies.every((dependency) =>
    dependency.status === "completed"
  );
  return {
    status: ready ? "queued" : "blocked",
    reason: ready ? null : "dependency_incomplete",
  };
}
