/**
 * The order this module exists to enforce: bytes, then the index.
 *
 * Every test below either checks that a step can trust the index it finds, or
 * checks that a fault refuses to publish an index over bytes that are not the
 * ones admission pinned. The one test that does not touch the filesystem is the
 * empty case; everything else writes a real directory, because the claim being
 * tested is about a real directory.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ContextDocument,
  type ContextInputEntry,
} from "../../apps/worker/src/context-document.ts";
import {
  materializeContext,
  type PinnedInputBytes,
} from "../../apps/worker/src/context-materialize.ts";
import { sha256Hex } from "../../apps/worker/src/harness-common.ts";

const encoder = new TextEncoder();

async function scratchDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "context-materialize-" });
  return dir;
}

function entry(
  slot: string,
  path: string,
  digest: string,
  sizeBytes: number,
): ContextInputEntry {
  return { slot, path, digest, sizeBytes, mediaType: "text/plain" };
}

function documentWith(
  contextDir: string,
  inputs: readonly ContextInputEntry[],
): ContextDocument {
  return {
    runId: "run-1",
    stepKey: "implement",
    goal: "Change the thing the brief describes.",
    outputs: ["patch"],
    inputs,
    contextDir,
    outputDir: "/tmp/out",
  };
}

async function pinned(
  slot: string,
  path: string,
  text: string,
): Promise<PinnedInputBytes> {
  const bytes = encoder.encode(text);
  return {
    entry: entry(slot, path, await sha256Hex(bytes), bytes.length),
    bytes,
  };
}

Deno.test("a clean materialisation writes every byte and the index last", async () => {
  const dir = await scratchDir();
  try {
    const brief = await pinned("brief", "brief", "the brief");
    const notes = await pinned("notes", "docs/notes.md", "some notes");
    const result = await materializeContext(
      dir,
      documentWith(dir, [brief.entry, notes.entry]),
      [brief, notes],
    );
    assertEquals(result.faults, []);
    assertEquals(
      await Deno.readTextFile(`${dir}/brief`),
      "the brief",
    );
    assertEquals(
      await Deno.readTextFile(`${dir}/docs/notes.md`),
      "some notes",
    );
    // The index exists, and it is the one that names these files.
    const index = await Deno.readTextFile(`${dir}/CONTEXT.md`);
    assert(index.includes("brief"));
    assert(index.includes("docs/notes.md"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the index is written after the bytes it names", async () => {
  // The ordering is the module's whole reason to exist, and asserting the
  // finished directory cannot show it: both orders end with every file present.
  // So this watches the writes instead. If CONTEXT.md is ever written before the
  // last input, a step that finds an index is holding a promise about bytes that
  // are not there yet - and "it appeared a moment later" is not something a step
  // can wait for.
  const dir = await scratchDir();
  try {
    const seen: string[] = [];
    const write = Deno.writeFile;
    const writeText = Deno.writeTextFile;
    Deno.writeFile = (async (path: string | URL, data: Uint8Array) => {
      seen.push(String(path).split("/").pop() ?? "");
      return await write(path, data);
    }) as typeof Deno.writeFile;
    Deno.writeTextFile = (async (path: string | URL, data: string) => {
      seen.push(String(path).split("/").pop() ?? "");
      return await writeText(path, data);
    }) as typeof Deno.writeTextFile;
    try {
      const brief = await pinned("brief", "brief", "the brief");
      const notes = await pinned("notes", "docs/notes.md", "some notes");
      const result = await materializeContext(
        dir,
        documentWith(dir, [brief.entry, notes.entry]),
        [brief, notes],
      );
      assertEquals(result.faults, []);
    } finally {
      Deno.writeFile = write;
      Deno.writeTextFile = writeText;
    }
    assertEquals(seen, ["brief", "notes.md", "CONTEXT.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bytes that do not match the pin write nothing at all", async () => {
  const dir = await scratchDir();
  try {
    const good = await pinned("brief", "brief", "the brief");
    // A pin that claims a digest the bytes do not have: the writer must compare
    // what it is about to write, not what it was told to write.
    const lying: PinnedInputBytes = {
      entry: entry("plan", "plan", await sha256Hex(encoder.encode("x")), 4),
      bytes: encoder.encode("plan"),
    };
    const result = await materializeContext(
      dir,
      documentWith(dir, [good.entry, lying.entry]),
      [good, lying],
    );
    assertEquals(result.faults.map((fault) => fault.reason), [
      "context_input_digest_mismatch",
    ]);
    const mismatch = result.faults[0];
    if (mismatch.reason !== "context_input_digest_mismatch") {
      throw new Error("expected a digest mismatch");
    }
    assertEquals(mismatch.slot, "plan");
    assertEquals(mismatch.declared, lying.entry.digest);
    assert(mismatch.actual !== mismatch.declared);
    // Nothing was written: not the good input, and not the index. A directory
    // holding half a step's inputs is worse than one holding none, because the
    // step cannot tell which half it is missing.
    assertEquals([...Deno.readDirSync(dir)], []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a path that could leave the context directory is refused", async () => {
  const dir = await scratchDir();
  try {
    const climbing = await pinned("brief", "../escape", "the brief");
    const result = await materializeContext(
      dir,
      documentWith(dir, [climbing.entry]),
      [climbing],
    );
    assertEquals(result.faults, [{
      reason: "context_input_path_unsafe",
      slot: "brief",
      path: "../escape",
    }]);
    assertEquals([...Deno.readDirSync(dir)], []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("two slots cannot share one path", async () => {
  const dir = await scratchDir();
  try {
    const first = await pinned("brief", "same", "one");
    const second = await pinned("plan", "same", "two");
    const result = await materializeContext(
      dir,
      documentWith(dir, [first.entry, second.entry]),
      [first, second],
    );
    assertEquals(result.faults, [{
      reason: "context_input_path_repeated",
      slot: "plan",
      path: "same",
    }]);
    // The first slot was written before the repeat was found; that is fine
    // because no index was published, so nothing claims the directory is
    // complete. What must not exist is CONTEXT.md.
    assertEquals(
      Deno.readDirSync(dir).some((entry) => entry.name === "CONTEXT.md"),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a step with no inputs still gets an index", async () => {
  const dir = await scratchDir();
  try {
    const result = await materializeContext(
      dir,
      documentWith(dir, []),
      [],
    );
    assertEquals(result.faults, []);
    const index = await Deno.readTextFile(`${dir}/CONTEXT.md`);
    assert(index.includes("implement"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
