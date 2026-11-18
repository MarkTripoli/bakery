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
      const fault = faults[0];
      if (fault.reason !== "context_input_digest_mismatch") {
        throw new Error(`expected a digest mismatch, got ${fault.reason}`);
      }
      assertEquals(fault.slot, "brief");
      assertEquals(fault.path, "brief/notes.md");
      assertEquals(fault.declared, declared);
      assertEquals(
        fault.actual,
        await sha256Hex(new TextEncoder().encode("what was written")),
      );
      assert(fault.actual !== fault.declared);
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

Deno.test("an unsafe path is refused as unsafe, not as a mismatch", async () => {
  // The reader refuses an unsafe path itself rather than trusting its caller.
  // The fault must not masquerade as a digest mismatch, because the bytes were
  // never read and there is no `actual` to report.
  //
  // `read` staying false is the assertion that matters here: it proves the
  // guard fires BEFORE any I/O rather than during it. A reader that read the
  // file and then rejected the path would have already left the directory.
  let read = false;
  const faults = await verifyContextDocument({
    contextDir: "/nonexistent",
    document: documentFor("/nonexistent", [{
      slot: "escape",
      path: "../outside.md",
      digest: "a".repeat(64),
      sizeBytes: 9,
      mediaType: "text/markdown",
    }]),
    read: () => {
      read = true;
      return Promise.resolve(new Uint8Array());
    },
  });
  assertEquals(read, false);
  assertEquals(faults, [{
    reason: "context_input_path_unsafe",
    slot: "escape",
    path: "../outside.md",
  }]);
});

Deno.test("an unreadable file throws rather than reporting a mismatch", async () => {
  // Reading can throw; mismatching cannot. A caller must be able to tell "the
  // index lies" from "the host is broken", and the two must not share a word.
  await withContextDir({}, async (dir) => {
    const document = documentFor(dir, [{
      slot: "missing",
      path: "absent.md",
      digest: "a".repeat(64),
      sizeBytes: 4,
      mediaType: "text/markdown",
    }]);
    let threw = false;
    try {
      await verifyContextDocument({ contextDir: dir, document });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
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
