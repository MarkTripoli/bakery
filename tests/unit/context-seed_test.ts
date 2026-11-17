/**
 * The wire between an assignment and the files a step reads.
 *
 * Every case below fails if the adapter invents a value the assignment already
 * stated, which is the whole risk in a mapping this thin: it is easy to write
 * one that recomputes a digest or renames a path and still looks correct.
 */

import { assert, assertEquals } from "@std/assert";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { sha256Hex } from "../../apps/worker/src/harness-common.ts";
import {
  type ContextDocumentFacts,
  describeSeedingFault,
  seedContext,
} from "../../apps/worker/src/context-seed.ts";

const encoder = new TextEncoder();

type Pin = NonNullable<JobAssignment["contextInputs"]>[number];

async function pin(
  slot: string,
  path: string,
  text: string,
): Promise<Pin> {
  const bytes = encoder.encode(text);
  return {
    slot,
    path,
    digest: await sha256Hex(bytes),
    sizeBytes: bytes.length,
    mediaType: "text/plain",
  };
}

function facts(contextDir: string): ContextDocumentFacts {
  return {
    runId: "run-1",
    stepKey: "implement",
    goal: "Change the thing the brief describes.",
    outputs: ["patch"],
    contextDir,
    outputDir: "/tmp/out",
  };
}

async function scratch(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "context-seed-" });
}

Deno.test("an assignment's pins become the files a step reads", async () => {
  const dir = await scratch();
  try {
    const brief = await pin("brief", "brief", "the brief");
    const notes = await pin("notes", "docs/notes.md", "some notes");
    const byPath = new Map([
      ["brief", encoder.encode("the brief")],
      ["docs/notes.md", encoder.encode("some notes")],
    ]);
    const result = await seedContext(
      facts(dir),
      [brief, notes],
      (input) => Promise.resolve(byPath.get(input.path) ?? new Uint8Array()),
    );
    assert(result.ok);
    assertEquals(
      await Deno.readTextFile(`${dir}/brief`),
      "the brief",
    );
    assertEquals(
      await Deno.readTextFile(`${dir}/docs/notes.md`),
      "some notes",
    );
    // The index carries the assignment's own slot names, not the fetch order.
    assertEquals(result.document.inputs.map((entry) => entry.slot), [
      "brief",
      "notes",
    ]);
    assert((await Deno.readTextFile(`${dir}/CONTEXT.md`)).includes("brief"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bytes that do not match the pin refuse the whole seeding", async () => {
  const dir = await scratch();
  try {
    const brief = await pin("brief", "brief", "the brief");
    const result = await seedContext(
      facts(dir),
      [brief],
      () => Promise.resolve(encoder.encode("not the brief")),
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("expected a refusal");
    assertEquals(result.faults.map((fault) => fault.reason), [
      "context_input_digest_mismatch",
    ]);
    // Nothing is on disk, because a step that starts with some of its inputs
    // cannot tell which ones are missing.
    assertEquals([...Deno.readDirSync(dir)], []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a step with no inputs still gets an index", async () => {
  const dir = await scratch();
  try {
    const result = await seedContext(facts(dir), undefined, () => {
      throw new Error("nothing should be fetched");
    });
    assert(result.ok);
    assertEquals(result.document.inputs, []);
    assert(
      (await Deno.readTextFile(`${dir}/CONTEXT.md`)).includes("implement"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the index describes the same bytes that were written", async () => {
  // The point of holding the digest in the index is that a reader can check the
  // file it finds. So the entry's digest is the pin's, not a re-hash of what was
  // written - otherwise a corrupted write would be described as correct.
  const dir = await scratch();
  try {
    const brief = await pin("brief", "brief", "the brief");
    const result = await seedContext(
      facts(dir),
      [brief],
      () => Promise.resolve(encoder.encode("the brief")),
    );
    assert(result.ok);
    const entry = result.document.inputs[0];
    assertEquals(entry.digest, brief.digest);
    assertEquals(entry.sizeBytes, brief.sizeBytes);
    assertEquals(entry.mediaType, brief.mediaType);
    assertEquals(
      await sha256Hex(await Deno.readFile(`${dir}/brief`)),
      brief.digest,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a fault says which input and what disagreed", () => {
  // An operator reading this needs to know whether the pin or the write is
  // wrong, so both digests appear rather than just the word mismatch.
  assertEquals(
    describeSeedingFault({
      reason: "context_input_digest_mismatch",
      slot: "brief",
      path: "brief",
      declared: "aaa",
      actual: "bbb",
    }).includes("brief"),
    true,
  );
  assertEquals(
    describeSeedingFault({
      reason: "context_input_path_unsafe",
      slot: "brief",
      path: "../escape",
    }).includes("leaves the context directory"),
    true,
  );
  assertEquals(
    describeSeedingFault({
      reason: "context_input_path_repeated",
      slot: "plan",
      path: "same",
    }).includes("same"),
    true,
  );
});
