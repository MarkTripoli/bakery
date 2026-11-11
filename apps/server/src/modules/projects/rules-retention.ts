import type { RepositoryVersionedProfileConfig } from "@bakery/contracts/repository-inspection";
import type { RepositoryProfileConfig } from "@bakery/contracts/repository-profile-config";
import { canonicalJson } from "../../platform/canonical-json.ts";

const BASELINE_FIELDS = [
  "workflow",
  "branches",
  "worktree",
  "agentBindings",
] as const;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

/**
 * Top-level config fields a rules-only publication changed relative to the
 * active profile it would replace. Rule settings must not weaken runtime,
 * branch, worktree, agent or fixed-policy configuration, so the new config
 * has to retain them. The caller only reaches this when the new config has no
 * `fixedPolicy` of its own (a config carrying one takes the fixed-policy path
 * and never gets here), so the fixed policy check is presence only: an active
 * `fixedPolicy` must not be dropped. Returns names only.
 */
export function changedRetainedFields(
  active: RepositoryVersionedProfileConfig,
  next: RepositoryProfileConfig,
): string[] {
  const changed: string[] = BASELINE_FIELDS.filter((field) =>
    !same(active[field], next[field])
  );
  if (active.fixedPolicy !== undefined && next.fixedPolicy === undefined) {
    changed.push("fixedPolicy");
  }
  return changed;
}
