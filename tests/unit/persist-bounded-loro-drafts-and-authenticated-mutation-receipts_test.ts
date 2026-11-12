import { assertEquals, assertRejects } from "@std/assert";
import { LoroDoc } from "loro-crdt";
import {
  applyDraftEditCandidate,
  createDraftSliceCandidate,
  createInitialDraftCandidate,
  DRAFT_LIMITS,
  DraftCandidateError,
} from "../../apps/server/src/modules/knowledge/drafts.ts";

async function edit(
  currentState: Uint8Array,
  sourceState: Uint8Array,
  start: number,
  end: number,
  expectedText: string,
  replacement: string,
) {
  const range = await createDraftSliceCandidate(sourceState, start, end);
  assertEquals(range.text, expectedText);
  return await applyDraftEditCandidate(currentState, sourceState, {
    mutationId: crypto.randomUUID(),
    startCursor: range.startCursor,
    endCursor: range.endCursor,
    expectedText,
    expectedDigest: range.textDigest,
    replacement,
  });
}

Deno.test("empty drafts export a real body root that supports the first slice", async () => {
  const initial = await createInitialDraftCandidate("");
  const imported = new LoroDoc();
  const status = imported.import(initial.state);
  assertEquals(status.pending, null);
  assertEquals(imported.getShallowValue(), { body: "cid:root-body:Text" });
  assertEquals(imported.getText("body").toString(), "");

  const selected = await createDraftSliceCandidate(initial.state, 0, 0);
  assertEquals(selected.text, "");
});

Deno.test("guarded Loro edits preserve disjoint stable ranges from one checkpoint", async () => {
  const initial = await createInitialDraftCandidate("alpha beta gamma");
  const first = await edit(
    initial.state,
    initial.state,
    0,
    5,
    "alpha",
    "ALPHA",
  );
  const second = await edit(
    first.state,
    initial.state,
    11,
    16,
    "gamma",
    "GAMMA",
  );
  assertEquals(second.text, "ALPHA beta GAMMA");
  assertEquals(second.update.length > 0, true);
  assertEquals(second.update.length <= DRAFT_LIMITS.updateBytes, true);
  assertEquals(second.state.length <= DRAFT_LIMITS.stateBytes, true);
});

Deno.test("changed and deleted guarded targets fail without a candidate", async () => {
  const initial = await createInitialDraftCandidate("left target right");
  const changed = await edit(
    initial.state,
    initial.state,
    5,
    11,
    "target",
    "changed",
  );
  await assertRejects(
    () => edit(changed.state, initial.state, 5, 11, "target", "again"),
    DraftCandidateError,
    "CURRENT_TARGET_CHANGED",
  );
  const deleted = await edit(
    initial.state,
    initial.state,
    5,
    11,
    "target",
    "",
  );
  await assertRejects(
    () => edit(deleted.state, initial.state, 5, 11, "target", "again"),
    DraftCandidateError,
  );
});

Deno.test("expected digest and UTF-16 surrogate boundaries are enforced", async () => {
  const initial = await createInitialDraftCandidate("a😀b");
  await assertRejects(
    () => createDraftSliceCandidate(initial.state, 2, 3),
    DraftCandidateError,
    "UTF16_SURROGATE_SPLIT",
  );
  const range = await createDraftSliceCandidate(initial.state, 1, 3);
  await assertRejects(
    () =>
      applyDraftEditCandidate(initial.state, initial.state, {
        mutationId: crypto.randomUUID(),
        startCursor: range.startCursor,
        endCursor: range.endCursor,
        expectedText: range.text,
        expectedDigest: "0".repeat(64),
        replacement: "x",
      }),
    DraftCandidateError,
    "EXPECTED_DIGEST_INVALID",
  );
  await assertRejects(
    () => createInitialDraftCandidate("\ud800"),
    DraftCandidateError,
    "UNPAIRED_SURROGATE",
  );
});

Deno.test("malformed, oversized, wrong-root, and pending Loro bytes fail closed", async () => {
  const initial = await createInitialDraftCandidate("body");
  const range = await createDraftSliceCandidate(initial.state, 0, 4);
  const input = {
    mutationId: crypto.randomUUID(),
    startCursor: range.startCursor,
    endCursor: range.endCursor,
    expectedText: range.text,
    expectedDigest: range.textDigest,
    replacement: "safe",
  };
  await assertRejects(
    () =>
      applyDraftEditCandidate(new Uint8Array([1, 2, 3]), initial.state, input),
    DraftCandidateError,
    "LORO_IMPORT_INVALID",
  );
  await assertRejects(
    () =>
      applyDraftEditCandidate(
        new Uint8Array(DRAFT_LIMITS.stateBytes + 1),
        initial.state,
        input,
      ),
    DraftCandidateError,
    "STATE_SIZE_INVALID",
  );

  const wrongRoot = new LoroDoc();
  wrongRoot.getText("other").insert(0, "body");
  wrongRoot.commit();
  await assertRejects(
    () =>
      applyDraftEditCandidate(
        wrongRoot.export({ mode: "snapshot" }),
        initial.state,
        input,
      ),
    DraftCandidateError,
    "LORO_ROOT_INVALID",
  );

  const base = new LoroDoc();
  base.getText("body").insert(0, "seed");
  base.commit();
  const fork = base.fork();
  const from = fork.version();
  fork.getText("body").push("later");
  fork.commit();
  const pending = fork.export({ mode: "update", from });
  await assertRejects(
    () => applyDraftEditCandidate(pending, initial.state, input),
    DraftCandidateError,
    "LORO_PENDING_DEPENDENCIES",
  );
});

Deno.test("body, replacement, update, state, and metadata budgets remain fixed", async () => {
  assertEquals(DRAFT_LIMITS, {
    replacementBytes: 65_536,
    updateBytes: 65_536,
    bodyBytes: 1_048_576,
    stateBytes: 16_777_216,
    metadataBytes: 8_192,
    queuedMutations: 100,
    workerMemoryBytes: 268_435_456,
    processDataBytes: 1_073_741_824,
    processCpuSeconds: 2,
    processHeapMegabytes: 192,
    processWasmPages: 4_096,
    workerTasks: 32,
    workerRuntimeMs: 1_000,
    workerKillMs: 100,
    staleAttempts: 3,
  });
  await assertRejects(
    () => createInitialDraftCandidate("x".repeat(DRAFT_LIMITS.bodyBytes + 1)),
    DraftCandidateError,
    "BODY_TOO_LARGE",
  );
});
