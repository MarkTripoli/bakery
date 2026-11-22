/**
 * The plan of an undo of a step's writes (chapter 25 section 17.6, O48, #448
 * slice S5): pure, so its ordering, its mapping from each write to its
 * reversal and its conflict rules are tested without a database.
 *
 * The rules, and why:
 * - Newest first. Each write is reversed against the state the writes after it
 *   left, so reversing in the opposite order walks the tree back exactly.
 * - All or nothing. Any entry someone else changed after (or between) the
 *   step's writes refuses the whole undo, naming every such entry. Reverting
 *   only the rest would leave a tree nobody asked for; refusing everything
 *   lets the person resolve the named entries and undo cleanly.
 * - A later change is found by the entry's row version: every write records
 *   the version before and after it, and any change by anyone else (a new
 *   version, a rename, a move, a trash or a restore) bumps it.
 */

import { StepWriteOp } from "./agent-file-scope.ts";

/** One recorded write of the step not yet undone, as bakery.step_write_set holds it. */
export type RecordedWrite = Readonly<{
  id: string;
  entryId: string;
  op: StepWriteOp;
  previousVersionId: string | null;
  newVersionId: string | null;
  previousParentId: string | null;
  previousName: string | null;
  entryVersionBefore: number | null;
  entryVersionAfter: number;
}>;

/** An entry the step wrote, as it is now. */
export type EntryNow = Readonly<{
  id: string;
  /** Where it is, for naming it in a refusal. */
  path: string;
  kind: "file" | "folder";
  version: number;
  /** Missing or purged: nothing is left to revert. */
  gone: boolean;
  parentId: string | null;
  trashed: boolean;
  trashParentId: string | null;
  /** The ids of the folder's children not in trash; empty for a file. */
  liveChildIds: readonly string[];
}>;

export const UndoAction = Object.freeze(
  {
    /** A file or folder the step created goes to trash. */
    Trash: "trash",
    /** A new version gives way to the version before it. */
    SetVersion: "set_version",
    /** A move is moved back to the folder and name it had. */
    MoveBack: "move_back",
    /** An entry the step trashed is restored. */
    Restore: "restore",
  } as const,
);
export type UndoAction = typeof UndoAction[keyof typeof UndoAction];

export type UndoStep = Readonly<{
  writeId: string;
  entryId: string;
  action: UndoAction;
  /** SetVersion: the version made current again. */
  versionId?: string;
  /** MoveBack: the folder and name it goes back to. */
  parentId?: string;
  name?: string;
}>;

export const UndoConflict = Object.freeze(
  {
    /** Someone else changed the entry after, or between, the step's writes. */
    ChangedSinceStep: "changed_since_step",
    /** The entry no longer exists, or was purged. */
    EntryGone: "entry_gone",
    /** The version the put replaced was removed by retention. */
    PreviousVersionGone: "previous_version_gone",
    /** The folder a move came from is gone. */
    PreviousParentGone: "previous_parent_gone",
    /** A folder the step made holds something the undo leaves in it. */
    FolderNotEmpty: "folder_not_empty",
  } as const,
);
export type UndoConflict = typeof UndoConflict[keyof typeof UndoConflict];

export type UndoPlan =
  | Readonly<{ ok: true; steps: readonly UndoStep[] }>
  | Readonly<{
    ok: false;
    conflicts: readonly Readonly<
      { entryId: string; path: string; reason: UndoConflict }
    >[];
  }>;

/** How one write is reversed, or why it cannot be. */
export function reversalOf(
  write: RecordedWrite,
): UndoStep | UndoConflict {
  const base = { writeId: write.id, entryId: write.entryId };
  switch (write.op) {
    case StepWriteOp.Put:
      // A put that made the entry is undone by trashing it; one that made a
      // new version, by making the version before it current again.
      if (write.entryVersionBefore === null) {
        return { ...base, action: UndoAction.Trash };
      }
      if (write.previousVersionId === null) {
        return UndoConflict.PreviousVersionGone;
      }
      return {
        ...base,
        action: UndoAction.SetVersion,
        versionId: write.previousVersionId,
      };
    case StepWriteOp.Copy:
    case StepWriteOp.Mkdir:
      return { ...base, action: UndoAction.Trash };
    case StepWriteOp.Move:
      if (write.previousParentId === null || write.previousName === null) {
        return UndoConflict.PreviousParentGone;
      }
      return {
        ...base,
        action: UndoAction.MoveBack,
        parentId: write.previousParentId,
        name: write.previousName,
      };
    case StepWriteOp.Trash:
      return { ...base, action: UndoAction.Restore };
  }
}

/**
 * Plans the undo of the given writes, oldest first as recorded, against the
 * entries as they are now. Returns the reversals newest first, or every
 * conflict when any entry refuses.
 */
export function planStepUndo(
  writes: readonly RecordedWrite[],
  entries: ReadonlyMap<string, EntryNow>,
): UndoPlan {
  const conflicts = new Map<string, UndoConflict>();
  const refuse = (entryId: string, reason: UndoConflict) => {
    if (!conflicts.has(entryId)) conflicts.set(entryId, reason);
  };

  // Per entry: the step's writes must chain, each starting from the version
  // the one before left, and the newest must have left the entry as it is.
  const byEntry = new Map<string, RecordedWrite[]>();
  for (const write of writes) {
    const list = byEntry.get(write.entryId) ?? [];
    list.push(write);
    byEntry.set(write.entryId, list);
  }
  for (const [entryId, list] of byEntry) {
    const now = entries.get(entryId);
    if (now === undefined || now.gone) {
      refuse(entryId, UndoConflict.EntryGone);
      continue;
    }
    if (list[list.length - 1].entryVersionAfter !== now.version) {
      refuse(entryId, UndoConflict.ChangedSinceStep);
      continue;
    }
    for (let k = 1; k < list.length; k++) {
      if (list[k].entryVersionBefore !== list[k - 1].entryVersionAfter) {
        refuse(entryId, UndoConflict.ChangedSinceStep);
        break;
      }
    }
  }

  // Newest first, tracking where each entry ends up, so a folder the step
  // made is trashed only when the reversals after it leave it empty.
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, Set<string>>();
  for (const now of entries.values()) {
    parentOf.set(now.id, now.trashed ? null : now.parentId);
    if (now.kind === "folder") {
      childrenOf.set(now.id, new Set(now.liveChildIds));
    }
  }
  const place = (entryId: string, parentId: string | null) => {
    const from = parentOf.get(entryId);
    if (from) childrenOf.get(from)?.delete(entryId);
    parentOf.set(entryId, parentId);
    if (parentId) childrenOf.get(parentId)?.add(entryId);
  };

  const steps: UndoStep[] = [];
  for (let index = writes.length - 1; index >= 0; index--) {
    const write = writes[index];
    const step = reversalOf(write);
    if (typeof step === "string") {
      refuse(write.entryId, step);
      continue;
    }
    if (
      write.op === StepWriteOp.Mkdir &&
      (childrenOf.get(write.entryId)?.size ?? 0) > 0
    ) {
      refuse(write.entryId, UndoConflict.FolderNotEmpty);
    }
    switch (step.action) {
      case UndoAction.Trash:
        place(step.entryId, null);
        break;
      case UndoAction.MoveBack:
        place(step.entryId, step.parentId!);
        break;
      case UndoAction.Restore:
        place(
          step.entryId,
          entries.get(step.entryId)?.trashParentId ?? null,
        );
        break;
      case UndoAction.SetVersion:
        break;
    }
    steps.push(step);
  }

  if (conflicts.size > 0) {
    return {
      ok: false,
      conflicts: [...conflicts].map(([entryId, reason]) => ({
        entryId,
        path: entries.get(entryId)?.path ?? entryId,
        reason,
      })),
    };
  }
  return { ok: true, steps };
}
