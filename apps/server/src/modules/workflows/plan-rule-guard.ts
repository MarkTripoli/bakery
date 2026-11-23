/**
 * Repository rules read against a compiled plan (issue #398).
 *
 * A `require` rule names a fixed policy command, and the guard asks that the
 * workflow runs it after the last stage that changes the revision. A flat
 * workflow is a list, so the order is the list. A compiled plan has a shape,
 * so the guard asks the same question of every path through it and credits a
 * check only when it runs after the last revision on EVERY path:
 *
 * - a step with an `if` guard may not run: it covers nothing, and a revision
 *   behind a guard may still change the candidate, so it ends coverage;
 * - the two arms of a branch are two paths: only what both cover is credited;
 * - a repeat body runs zero or more times: a check inside it is credited only
 *   for the revisions of the same pass, and a revision inside it ends the
 *   coverage a pass before it started with;
 * - the lanes of a parallel group have no order: a check beside a revision
 *   covers nothing, and checks beside other checks add up.
 *
 * For a plan that is a plain list this is exactly the flat guard's answer (a
 * unit test compares them over every list of up to five stages).
 */
import { REPOSITORY_FIXED_POLICY_ACTION_EFFECTS } from "@bakery/contracts/repository-profile-config";
import type {
  RepositoryRuleStageRequirement,
  RepositoryRuleStageViolation,
} from "@bakery/contracts/repository-rules";
import type {
  WorkflowNode,
  WorkflowValueNode,
} from "@bakery/contracts/workflow-compiler";

/** The only action whose `checks` input runs fixed policy commands. */
const CHECK_ACTION = "quality.check";

const ACTION_EFFECTS: Readonly<Record<string, string | undefined>> =
  REPOSITORY_FIXED_POLICY_ACTION_EFFECTS;

/** The fixed policy commands a path has run since its last revision. */
type Coverage = Readonly<{ all: boolean; ids: ReadonlySet<string> }>;

const NONE: Coverage = Object.freeze({ all: false, ids: new Set<string>() });

const covers = (coverage: Coverage, id: string): boolean =>
  coverage.all || coverage.ids.has(id);

const union = (left: Coverage, right: Coverage): Coverage => ({
  all: left.all || right.all,
  ids: new Set([...left.ids, ...right.ids]),
});

const intersect = (left: Coverage, right: Coverage): Coverage => {
  const ids = new Set<string>();
  for (const id of new Set([...left.ids, ...right.ids])) {
    if (covers(left, id) && covers(right, id)) ids.add(id);
  }
  return { all: left.all && right.all, ids };
};

const same = (left: Coverage, right: Coverage): boolean =>
  left.all === right.all && left.ids.size === right.ids.size &&
  [...left.ids].every((id) => right.ids.has(id));

/**
 * The commands a `quality.check` input runs, as far as admission can tell: a
 * literal list names them, and the reference `$delivery.checkIds` stands for
 * every command of the pinned policy.
 */
function checkCoverage(input: WorkflowValueNode): Coverage {
  if (input.kind !== "object") return NONE;
  const checks = input.fields.checks;
  if (checks === undefined) return NONE;
  if (
    checks.kind === "ref" && checks.root === "delivery" &&
    checks.path.length === 1 && checks.path[0] === "checkIds"
  ) return { all: true, ids: new Set() };
  const names: unknown[] = checks.kind === "literal" &&
      Array.isArray(checks.value)
    ? checks.value
    : checks.kind === "list"
    ? checks.items.map((item) => item.kind === "literal" ? item.value : null)
    : [];
  // The all-checks marker is a separate flag, so a literal "*" is just a name
  // no command has: it can never forge coverage.
  return {
    all: false,
    ids: new Set(
      names.filter((name): name is string => typeof name === "string"),
    ),
  };
}

const changesRevision = (action: string): boolean =>
  ACTION_EFFECTS[action] === "repository_revision";

/** True when any node at any depth runs an action that changes the revision. */
function containsRevision(nodes: readonly WorkflowNode[]): boolean {
  return nodes.some((node) => {
    switch (node.kind) {
      case "action":
        return changesRevision(node.action);
      case "sequence":
        return containsRevision(node.steps);
      case "branch":
        return containsRevision(node.then) || containsRevision(node.else);
      case "repeat":
        return containsRevision(node.steps) ||
          (node.seed.form === "sequence" && containsRevision(node.seed.steps));
      case "parallel":
        return node.lanes.some((lane) => containsRevision(lane.steps));
      case "forEach":
        return containsRevision(node.steps);
      case "wait":
        return false;
    }
  });
}

type Walk = { everCovered: Coverage; revision: boolean };

function fold(
  nodes: readonly WorkflowNode[],
  start: Coverage,
  unconditional: boolean,
  walk: Walk,
): Coverage {
  let state = start;
  for (const node of nodes) state = visit(node, state, unconditional, walk);
  return state;
}

function visit(
  node: WorkflowNode,
  state: Coverage,
  unconditional: boolean,
  walk: Walk,
): Coverage {
  const guarded = node.if !== undefined;
  const certain = unconditional && !guarded;
  let after: Coverage;
  switch (node.kind) {
    case "action":
      if (changesRevision(node.action)) {
        walk.revision = true;
        after = NONE;
      } else if (node.action === CHECK_ACTION) {
        const ran = checkCoverage(node.with);
        if (certain) walk.everCovered = union(walk.everCovered, ran);
        after = union(state, ran);
      } else after = state;
      break;
    case "wait":
      after = state;
      break;
    case "sequence":
      after = fold(node.steps, state, certain, walk);
      break;
    case "branch": {
      // Each arm keeps its own record of what always runs inside it; only what
      // BOTH arms always run is an always-running check of the branch.
      const thenWalk: Walk = { everCovered: NONE, revision: false };
      const elseWalk: Walk = { everCovered: NONE, revision: false };
      const thenAfter = fold(node.then, state, true, thenWalk);
      const elseAfter = fold(node.else, state, true, elseWalk);
      walk.revision = walk.revision || thenWalk.revision || elseWalk.revision;
      if (certain) {
        walk.everCovered = union(
          walk.everCovered,
          intersect(thenWalk.everCovered, elseWalk.everCovered),
        );
      }
      after = intersect(thenAfter, elseAfter);
      break;
    }
    case "repeat": {
      // The seed steps run once; the body runs zero to `max` times.
      const start = node.seed.form === "sequence"
        ? fold(node.seed.steps, state, certain, walk)
        : state;
      let current = start;
      let guaranteed = start;
      for (let pass = 0; pass < node.max; pass += 1) {
        const next = fold(node.steps, current, false, walk);
        guaranteed = intersect(guaranteed, next);
        if (same(next, current)) break;
        current = next;
      }
      after = guaranteed;
      break;
    }
    case "forEach": {
      // The body runs once per item: zero to `max` times.
      let current = state;
      let guaranteed = state;
      for (let pass = 0; pass < node.max; pass += 1) {
        const next = fold(node.steps, current, false, walk);
        guaranteed = intersect(guaranteed, next);
        if (same(next, current)) break;
        current = next;
      }
      after = guaranteed;
      break;
    }
    case "parallel": {
      const lanes = node.lanes.map((lane) =>
        fold(lane.steps, state, certain, walk)
      );
      // A lane that cannot revise cannot undo another lane's checks after its
      // own revision: only the lanes that can revise bound the coverage.
      const revising = lanes.filter((_, index) =>
        containsRevision(node.lanes[index].steps)
      );
      after = revising.length > 0
        ? revising.reduce(intersect)
        : lanes.reduce(union, state);
      break;
    }
  }
  // A guarded node may not run: only what holds with and without it survives.
  return guarded ? intersect(state, after) : after;
}

/**
 * The requirements a plan does not meet, in the same words the flat guard uses:
 * `stage_missing` when no check that always runs covers the command, and
 * `stage_before_revision` when one does but a revision can still come after it.
 * A plan that never changes a revision is not bound.
 */
export function planRuleViolations(
  requirements: readonly RepositoryRuleStageRequirement[],
  steps: readonly WorkflowNode[],
): readonly RepositoryRuleStageViolation[] {
  const walk: Walk = { everCovered: NONE, revision: false };
  const final = fold(steps, NONE, true, walk);
  if (!walk.revision) return [];
  return requirements.flatMap((requirement) =>
    covers(final, requirement.commandId) ? [] : [{
      ...requirement,
      reason: covers(walk.everCovered, requirement.commandId)
        ? "stage_before_revision" as const
        : "stage_missing" as const,
    }]
  );
}
