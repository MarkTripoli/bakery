/**
 * A step's inputs are sealed, and a step that changed them is caught (#446).
 *
 * Two claims, and the second is the one that matters:
 *
 * - The tree is closed before the step starts: files 0400, directories 0500,
 *   index included. That stops an accidental write and nothing more, because the
 *   step runs as the same user.
 * - After the step ends, the disk is compared against the index the worker wrote.
 *   That is what catches a deliberate write. Without it, an agent could rewrite
 *   its pinned inputs, answer a different question, and the write set would record
 *   an output with no honest input to match it.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  type PinnedInputBytes,
  sealContextDirectory,
} from "../../apps/worker/src/context-materialize.ts";
import { sha256Hex } from "../../apps/worker/src/harness-common.ts";
import type { ContextDocument } from "../../apps/worker/src/context-document.ts";
import {
  describeContextTampering,
  verifyHarnessContext,
} from "../../apps/worker/src/harness-context.ts";

const merge = async (dir: string, entries: PinnedInputBytes[]) => {
  const { materializeContext } = await import(
    "../../apps/worker/src/context-materialize.ts"
  );
  return await materializeContext(dir, documentOf(entries), entries);
};

function documentOf(entries: PinnedInputBytes[]): ContextDocument {
  return {
    runId: "run-1",
    stepKey: "harness",
    goal: "read the plan and answer",
    outputs: [],
    inputs: entries.map((entry) => entry.entry),
    contextDir: "/attempt/context",
    outputDir: "/attempt/work",
  };
}

async function inputAt(
  slot: string,
  path: string,
  text: string,
): Promise<PinnedInputBytes> {
  const bytes = new TextEncoder().encode(text);
  return {
    entry: {
      slot,
      path,
      digest: await sha256Hex(bytes),
      sizeBytes: bytes.length,
      mediaType: "text/markdown",
    },
    bytes,
  };
}

async function withAttempt(work: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "bakery-446-" });
  await Deno.chmod(root, 0o700);
  try {
    await work(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("the context tree is closed to writes before the step starts", async () => {
  await withAttempt(async (root) => {
    const contextDir = join(root, "context");
    const seeded = await merge(contextDir, [
      await inputAt("plan", "plan.md", "# the plan\n"),
      await inputAt("notes", "notes/today.md", "notes\n"),
    ]);
    assertEquals(seeded.faults, []);

    const { stat } = await import("node:fs/promises");
    assertEquals((await stat(join(contextDir, "plan.md"))).mode & 0o777, 0o400);
    assertEquals(
      (await stat(join(contextDir, "notes/today.md"))).mode & 0o777,
      0o400,
    );
    assertEquals(
      (await stat(join(contextDir, "CONTEXT.md"))).mode & 0o777,
      0o400,
    );
    // A directory stays walkable, because removing an attempt walks it. The
    // trade is stated in `sealContextDirectory`: additions are caught after the
    // step rather than prevented.
    assertEquals((await stat(contextDir)).mode & 0o777, 0o700);

    // And writing is refused, not merely unlikely.
    await assertRejects(
      () => Deno.writeTextFile(join(contextDir, "plan.md"), "rewritten\n"),
      Deno.errors.PermissionDenied,
    );
  });
});

Deno.test("a step that rewrote its inputs is caught after it ends", async () => {
  await withAttempt(async (root) => {
    const contextDir = join(root, "context");
    const entry = await inputAt("plan", "plan.md", "# the plan\n");
    const seeded = await merge(contextDir, [entry]);
    assertEquals(seeded.faults, []);

    const context = {
      ok: true as const,
      contextDir,
      document: seeded.document,
      promptSection: "",
    };
    assertEquals(await verifyHarnessContext(context), []);

    // The step opens the door the seal only made stiff, and edits its input.
    await Deno.chmod(contextDir, 0o700);
    await Deno.chmod(join(contextDir, "plan.md"), 0o600);
    await Deno.writeTextFile(
      join(contextDir, "plan.md"),
      "# the plan, revised\n",
    );
    await Deno.chmod(join(contextDir, "plan.md"), 0o400);
    await Deno.chmod(contextDir, 0o500);

    const faults = await verifyHarnessContext(context);
    assertEquals(faults.length, 1);
    assertEquals(faults[0].reason, "context_input_digest_mismatch");
    const description = describeContextTampering(faults);
    assert(
      description.includes("plan.md"),
      `the refusal does not name the file: ${description}`,
    );
    assert(
      description.includes("pinned to"),
      `the refusal does not say what went wrong: ${description}`,
    );
  });
});

Deno.test("an edit to the index alone does not hide an edit to an input", async () => {
  await withAttempt(async (root) => {
    const contextDir = join(root, "context");
    const entry = await inputAt("plan", "plan.md", "# the plan\n");
    const seeded = await merge(contextDir, [entry]);
    const context = {
      ok: true as const,
      contextDir,
      document: seeded.document,
      promptSection: "",
    };
    // A step that rewrites the input and the index to agree with each other is
    // the case the in-memory document exists for.
    await Deno.chmod(contextDir, 0o700);
    for (const name of ["plan.md", "CONTEXT.md"]) {
      await Deno.chmod(join(contextDir, name), 0o600);
    }
    await Deno.writeTextFile(join(contextDir, "plan.md"), "# something else\n");
    await Deno.writeTextFile(
      join(contextDir, "CONTEXT.md"),
      "# rewritten index\n",
    );
    await Deno.chmod(contextDir, 0o500);

    const faults = await verifyHarnessContext(context);
    assert(faults.length > 0, "the disk was trusted over the index");
  });
});

Deno.test("a step with no context has nothing to verify", async () => {
  assertEquals(await verifyHarnessContext({ ok: true, promptSection: "" }), []);
  assertEquals(
    await verifyHarnessContext({
      ok: false,
      code: "CONTEXT_UNREADABLE",
      detail: "",
      status: 503,
      retryable: true,
    }),
    [],
  );
});

Deno.test("sealing an already-sealed tree is harmless", async () => {
  await withAttempt(async (root) => {
    const contextDir = join(root, "context");
    const entry = await inputAt("plan", "plan.md", "# the plan\n");
    await merge(contextDir, [entry]);
    await sealContextDirectory(contextDir, [join(contextDir, "plan.md")]);
    assertEquals(
      (await Deno.stat(join(contextDir, "plan.md"))).mode! & 0o777,
      0o400,
    );
  });
});

Deno.test("a file added beside the inputs is caught, not ignored", async () => {
  await withAttempt(async (root) => {
    const contextDir = join(root, "context");
    const entry = await inputAt("plan", "plan.md", "# the plan\n");
    const seeded = await merge(contextDir, [entry]);
    const context = {
      ok: true as const,
      contextDir,
      document: seeded.document,
      promptSection: "",
    };
    // A directory stays writable so an attempt's root can be removed; this is
    // what that costs, and what the check after the step is for.
    await Deno.writeTextFile(join(contextDir, "extra.md"), "unpinned\n");
    const faults = await verifyHarnessContext(context);
    assertEquals(faults.length, 1);
    assertEquals(faults[0].reason, "context_entry_unexpected");
    assert(
      describeContextTampering(faults).includes("extra.md"),
      "the refusal does not name the added file",
    );
  });
});

Deno.test("a deleted input is caught by name", async () => {
  await withAttempt(async (root) => {
    const contextDir = join(root, "context");
    const entry = await inputAt("plan", "plan.md", "# the plan\n");
    const seeded = await merge(contextDir, [entry]);
    const context = {
      ok: true as const,
      contextDir,
      document: seeded.document,
      promptSection: "",
    };
    await Deno.remove(join(contextDir, "plan.md"));
    const faults = await verifyHarnessContext(context);
    assert(
      faults.some((fault) =>
        fault.reason === "context_entry_missing" && fault.path === "plan.md"
      ),
      `the missing input was not reported: ${JSON.stringify(faults)}`,
    );
  });
});
