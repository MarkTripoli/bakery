/**
 * #448 slice S5: the plan of an undo of a step's writes (section 17.6, O48):
 * newest first, each operation mapped to its reversal, and any entry changed
 * by someone else after the step refuses the whole undo by name.
 */

import { assertEquals } from "@std/assert";
import { StepWriteOp } from "../../apps/server/src/modules/knowledge/agent-file-scope.ts";
import {
  type EntryNow,
  planStepUndo,
  type RecordedWrite,
  reversalOf,
  UndoAction,
  UndoConflict,
} from "../../apps/server/src/modules/knowledge/step-write-undo.ts";

const folder = "folder";
const fileA = "file-a";
const fileB = "file-b";
const home = "home";

function write(
  id: string,
  entryId: string,
  op: StepWriteOp,
  versions: { before: number | null; after: number },
  extra: Partial<RecordedWrite> = {},
): RecordedWrite {
  return {
    id,
    entryId,
    op,
    previousVersionId: null,
    newVersionId: null,
    previousParentId: null,
    previousName: null,
    entryVersionBefore: versions.before,
    entryVersionAfter: versions.after,
    ...extra,
  };
}

function entry(
  id: string,
  version: number,
  extra: Partial<EntryNow> = {},
): EntryNow {
  return {
    id,
    path: "/shared/" + id,
    kind: "file",
    version,
    gone: false,
    parentId: home,
    trashed: false,
    trashParentId: null,
    liveChildIds: [],
    ...extra,
  };
}

const entries = (...list: EntryNow[]) =>
  new Map(list.map((item) => [item.id, item]));

Deno.test("each operation maps to its reversal", () => {
  assertEquals(
    reversalOf(write("w", fileA, StepWriteOp.Put, { before: null, after: 2 })),
    { writeId: "w", entryId: fileA, action: UndoAction.Trash },
  );
  assertEquals(
    reversalOf(
      write("w", fileA, StepWriteOp.Put, { before: 2, after: 3 }, {
        previousVersionId: "v1",
        newVersionId: "v2",
      }),
    ),
    {
      writeId: "w",
      entryId: fileA,
      action: UndoAction.SetVersion,
      versionId: "v1",
    },
  );
  assertEquals(
    reversalOf(write("w", fileA, StepWriteOp.Copy, { before: null, after: 2 })),
    { writeId: "w", entryId: fileA, action: UndoAction.Trash },
  );
  assertEquals(
    reversalOf(
      write("w", folder, StepWriteOp.Mkdir, { before: null, after: 1 }),
    ),
    { writeId: "w", entryId: folder, action: UndoAction.Trash },
  );
  assertEquals(
    reversalOf(
      write("w", fileA, StepWriteOp.Move, { before: 2, after: 3 }, {
        previousParentId: home,
        previousName: "a.md",
      }),
    ),
    {
      writeId: "w",
      entryId: fileA,
      action: UndoAction.MoveBack,
      parentId: home,
      name: "a.md",
    },
  );
  assertEquals(
    reversalOf(write("w", fileA, StepWriteOp.Trash, { before: 2, after: 3 })),
    { writeId: "w", entryId: fileA, action: UndoAction.Restore },
  );
});

Deno.test("a put whose previous version retention removed cannot be reverted", () => {
  assertEquals(
    reversalOf(write("w", fileA, StepWriteOp.Put, { before: 2, after: 3 })),
    UndoConflict.PreviousVersionGone,
  );
});

Deno.test("an agent's put, new version and mkdir revert newest first", () => {
  const writes = [
    write("1", folder, StepWriteOp.Mkdir, { before: null, after: 1 }),
    write("2", fileA, StepWriteOp.Put, { before: null, after: 2 }, {
      newVersionId: "a1",
    }),
    write("3", fileB, StepWriteOp.Put, { before: 4, after: 5 }, {
      previousVersionId: "b1",
      newVersionId: "b2",
    }),
  ];
  const plan = planStepUndo(
    writes,
    entries(
      entry(folder, 1, { kind: "folder", liveChildIds: [fileA] }),
      entry(fileA, 2, { parentId: folder }),
      entry(fileB, 5),
    ),
  );
  assertEquals(plan, {
    ok: true,
    steps: [
      {
        writeId: "3",
        entryId: fileB,
        action: UndoAction.SetVersion,
        versionId: "b1",
      },
      { writeId: "2", entryId: fileA, action: UndoAction.Trash },
      { writeId: "1", entryId: folder, action: UndoAction.Trash },
    ],
  });
});

Deno.test("a later edit by someone else refuses the whole undo, naming the entry", () => {
  const plan = planStepUndo(
    [
      write("1", fileA, StepWriteOp.Put, { before: null, after: 2 }),
      write("2", fileB, StepWriteOp.Put, { before: 4, after: 5 }, {
        previousVersionId: "b1",
      }),
    ],
    // A person wrote fileB again: its version moved past what the step left.
    entries(entry(fileA, 2), entry(fileB, 6)),
  );
  assertEquals(plan, {
    ok: false,
    conflicts: [{
      entryId: fileB,
      path: "/shared/" + fileB,
      reason: UndoConflict.ChangedSinceStep,
    }],
  });
});

Deno.test("an edit between two of the step's writes is found too", () => {
  const plan = planStepUndo(
    [
      write("1", fileA, StepWriteOp.Put, { before: null, after: 2 }),
      // Someone made version 3; the step's next put started from it.
      write("2", fileA, StepWriteOp.Put, { before: 3, after: 4 }, {
        previousVersionId: "a2",
      }),
    ],
    entries(entry(fileA, 4)),
  );
  assertEquals(plan.ok, false);
  if (!plan.ok) {
    assertEquals(plan.conflicts.map((item) => item.reason), [
      UndoConflict.ChangedSinceStep,
    ]);
  }
});

Deno.test("a folder the step made is trashed only when the undo leaves it empty", () => {
  const writes = [
    write("1", folder, StepWriteOp.Mkdir, { before: null, after: 1 }),
  ];
  // A person put a file in the agent's folder.
  const kept = planStepUndo(
    writes,
    entries(entry(folder, 1, { kind: "folder", liveChildIds: ["theirs"] })),
  );
  assertEquals(kept.ok, false);
  if (!kept.ok) {
    assertEquals(kept.conflicts[0].reason, UndoConflict.FolderNotEmpty);
  }
  // The step's own file, put and then trashed inside it, leaves it empty.
  const emptied = planStepUndo(
    [
      ...writes,
      write("2", fileA, StepWriteOp.Put, { before: null, after: 2 }),
      write("3", fileA, StepWriteOp.Trash, { before: 2, after: 3 }),
    ],
    entries(
      entry(folder, 1, { kind: "folder", liveChildIds: [] }),
      entry(fileA, 3, {
        parentId: "trash",
        trashed: true,
        trashParentId: folder,
      }),
    ),
  );
  assertEquals(
    emptied.ok ? emptied.steps.map((step) => step.action) : emptied,
    [UndoAction.Restore, UndoAction.Trash, UndoAction.Trash],
  );
});

Deno.test("a gone entry refuses the undo; nothing left to undo plans nothing", () => {
  const gone = planStepUndo(
    [write("1", fileA, StepWriteOp.Put, { before: null, after: 2 })],
    entries(entry(fileA, 2, { gone: true })),
  );
  assertEquals(gone.ok ? null : gone.conflicts[0].reason, "entry_gone");
  assertEquals(planStepUndo([], new Map()), { ok: true, steps: [] });
});
