/**
 * Linear's workflow states, as the engine's ticket status.
 *
 * Linear gives a team any number of states, each with a `type` from a closed set:
 * triage, backlog, unstarted, started, completed, canceled. A team names its own
 * states ("In Review", "Blocked on Legal") and reorders them, so the name is the
 * label and the position is the rank - but the *type* is what a status trigger
 * fires on, because "moved into started" means the same thing on every team while
 * "moved into In Review" means nothing on a team that has no such state.
 *
 * The engine's `TicketSnapshot.status` already separates `label` from `rank` for
 * exactly this reason, so this module is the whole translation: no provider state
 * name reaches the engine as a decision, and no engine vocabulary reaches Linear.
 */

/**
 * The state types Linear documents, in the order a workflow runs.
 *
 * The order is the fallback rank and it is deliberately the documented pipeline
 * order rather than alphabetical: a team that never reordered its states gets the
 * order Linear shows, which is the order people describe their work in.
 */
export const LINEAR_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;

export type LinearStateType = (typeof LINEAR_STATE_TYPES)[number];

/**
 * What a status trigger can ask about a transition.
 *
 * `entered` and `left` are the two that matter: "the ticket moved into completed"
 * is a trigger a workflow can hang work off, and "the ticket left started" is the
 * one that says a run it opened is now stale. `changed` is offered because a
 * provider-agnostic trigger that only fires on the typed half would silently miss
 * a move between two states of the same type, and that move is visible to people.
 */
export type StatusTrigger =
  | { kind: "entered"; type: LinearStateType }
  | { kind: "left"; type: LinearStateType }
  | { kind: "changed" };

/**
 * One state as Linear returns it.
 *
 * `position` is the team's own ordering and may be sparse or duplicated after a
 * reorder; that is why it is a rank rather than an index.
 */
export type LinearWorkflowState = {
  id: string;
  name: string;
  type: string;
  position?: number | null;
};

/** A state resolved into the three things the engine stores. */
export type LinearStatus = {
  id: string;
  label: string;
  /** 0 for triage through 5 for canceled, so grouping is stable across teams. */
  rank: number;
};

/**
 * The status type, or `undefined` for a type Linear did not document.
 *
 * Undefined rather than a default because a new Linear state type must not be
 * silently folded into "unstarted": the ticket would report a status nobody chose,
 * and the trigger built on it would fire on the wrong move. The caller refuses the
 * state instead, which surfaces as a provider defect with the provider's own word
 * for it.
 */
export function stateTypeOf(
  state: LinearWorkflowState,
): LinearStateType | undefined {
  const found = LINEAR_STATE_TYPES.find((type) => type === state.type);
  return found;
}

/**
 * The engine's status for a Linear state.
 *
 * `rank` comes from the documented type, not the team's `position`: a team with
 * eleven states has positions 0-10 in a column that the engine compares across
 * providers, and two teams' position 3 would mean different things. The team's
 * ordering is preserved by the label, which is what a person reads.
 *
 * Returns `undefined` for an undocumented type, matching `stateTypeOf`.
 */
export function statusOf(state: LinearWorkflowState): LinearStatus | undefined {
  const type = stateTypeOf(state);
  if (type === undefined) return undefined;
  return {
    id: state.id,
    label: state.name,
    rank: LINEAR_STATE_TYPES.indexOf(type),
  };
}

/**
 * Whether a transition between two Linear states satisfies a trigger.
 *
 * A trigger is matched on types, so it survives a team renaming or adding states.
 * A move within one type therefore cannot satisfy `entered` or `left`: the type did
 * not change, and reporting that it did would fire work on a cosmetic edit. That
 * move *is* a `changed`, which is the trigger to use when the states themselves
 * matter.
 *
 * `from` is absent when the ticket is new, and an absent `from` satisfies `entered`
 * for the state it is created in - also for `triage`, because triage is where a
 * Linear ticket is created when the team has it enabled. It never satisfies `left`.
 */
export function statusTriggerFires(
  trigger: StatusTrigger,
  transition: { from?: LinearWorkflowState | null; to: LinearWorkflowState },
): boolean {
  const to = stateTypeOf(transition.to);
  if (to === undefined) return false;
  const from = transition.from ? stateTypeOf(transition.from) : undefined;
  switch (trigger.kind) {
    case "changed":
      // A rename or a move between two states of one type is still a change the
      // engine may want to hear about, so this compares identity rather than type.
      return transition.from ? transition.from.id !== transition.to.id : true;
    case "entered":
      return trigger.type === to && from !== to;
    case "left":
      return trigger.type === from && from !== to;
  }
}
