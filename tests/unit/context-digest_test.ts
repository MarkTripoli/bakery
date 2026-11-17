import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { verifyContextDocument } from "../../apps/worker/src/context-digest.ts";
import type { ContextDocument } from "../../apps/worker/src/context-document.ts";
import { sha256Hex } from "../../apps/worker/src/harness-common.ts";

/** A throwaway context directory the test owns and removes. */
async function withContextDir(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "context-digest-" });
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      await Deno.mkdir(join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, content);
    }
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function documentFor(
  dir: string,
  inputs: ContextDocument["inputs"],
): ContextDocument {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    stepKey: "implement",
    goal: "Implement the approved plan.",
    outputs: [],
    inputs,
    contextDir: dir,
    outputDir: join(dir, "..", "out"),
  };
}

Deno.test("a directory whose bytes match the index has no faults", async () => {
  const bytes = "the brief";
  await withContextDir({ "brief/notes.md": bytes }, async (dir) => {
    const document = documentFor(dir, [{
      slot: "brief",
      path: "brief/notes.md",
      digest: await sha256Hex(new TextEncoder().encode(bytes)),
      sizeBytes: bytes.length,
      mediaType: "text/markdown",
    }]);
    assertEquals(
      await verifyContextDocument({ contextDir: dir, document }),
      [],
    );
  });
});

Deno.test("bytes that differ from the declaration are refused with both sides", async () => {
  await withContextDir(
    { "brief/notes.md": "what was written" },
    async (dir) => {
      const declared = "a".repeat(64);
      const document = documentFor(dir, [{
        slot: "brief",
        path: "brief/notes.md",
        digest: declared,
        sizeBytes: 16,
        mediaType: "text/markdown",
      }]);
      const faults = await verifyContextDocument({ contextDir: dir, document });
      assertEquals(faults.length, 1);
      assertEquals(faults[0].reason, "context_input_digest_mismatch");
      assertEquals(faults[0].slot, "brief");
      assertEquals(faults[0].path, "brief/notes.md");
      assertEquals(faults[0].declared, declared);
      assertEquals(
        faults[0].actual,
        await sha256Hex(new TextEncoder().encode("what was written")),
      );
      assert(faults[0].actual !== faults[0].declared);
    },
  );
});

Deno.test("the digest the caller holds is not trusted over the disk", async () => {
  // The point of the gate: a caller that computed the digest from the same
  // bytes it wrote would always agree. Here the index claims a digest that the
  // bytes on disk do not have, and the disk wins.
  await withContextDir({ "plan/plan.md": "real bytes" }, async (dir) => {
    const document = documentFor(dir, [{
      slot: "plan",
      path: "plan/plan.md",
      digest: await sha256Hex(new TextEncoder().encode("different bytes")),
      sizeBytes: 10,
      mediaType: "text/markdown",
    }]);
    const faults = await verifyContextDocument({ contextDir: dir, document });
    assertEquals(faults.map((fault) => fault.slot), ["plan"]);
  });
});

Deno.test("every mismatched input is reported, not only the first", async () => {
  await withContextDir(
    { "a/one.md": "one", "b/two.md": "two" },
    async (dir) => {
      const document = documentFor(dir, [
        {
          slot: "a",
          path: "a/one.md",
          digest: "1".repeat(64),
          sizeBytes: 3,
          mediaType: "text/markdown",
        },
        {
          slot: "b",
          path: "b/two.md",
          digest: "2".repeat(64),
          sizeBytes: 3,
          mediaType: "text/markdown",
        },
      ]);
      const faults = await verifyContextDocument({ contextDir: dir, document });
      assertEquals(faults.map((fault) => fault.slot), ["a", "b"]);
    },
  );
});

Deno.test("only the inputs that disagree are named", async () => {
  const good = "matches";
  await withContextDir({ "ok.md": good, "bad.md": "other" }, async (dir) => {
    const document = documentFor(dir, [
      {
        slot: "ok",
        path: "ok.md",
        digest: await sha256Hex(new TextEncoder().encode(good)),
        sizeBytes: good.length,
        mediaType: "text/markdown",
      },
      {
        slot: "bad",
        path: "bad.md",
        digest: await sha256Hex(new TextEncoder().encode("expected")),
        sizeBytes: 5,
        mediaType: "text/markdown",
      },
    ]);
    const faults = await verifyContextDocument({ contextDir: dir, document });
    assertEquals(faults.map((fault) => fault.slot), ["bad"]);
  });
});

Deno.test("a document with no inputs has nothing to verify", async () => {
  await withContextDir({}, async (dir) => {
    const document = documentFor(dir, []);
    assertEquals(
      await verifyContextDocument({ contextDir: dir, document }),
      [],
    );
  });
});
