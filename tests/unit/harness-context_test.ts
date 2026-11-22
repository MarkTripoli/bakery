/**
 * What a coding harness does with the inputs a step declared (#527).
 *
 * Each case names the rule it holds: a step without pins is untouched, pinned
 * bytes become files plus an index in the prompt, a byte that is not the pinned
 * byte refuses the attempt, and a harness with no way to read the pins refuses
 * rather than starting without them.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import type { WorkerContextInput } from "../../apps/worker/src/client.ts";
import { sha256Hex } from "../../apps/worker/src/harness-common.ts";
import { prepareHarnessContext } from "../../apps/worker/src/harness-context.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";

const encoder = new TextEncoder();

type Pin = NonNullable<JobAssignment["contextInputs"]>[number];

async function pinned(
  slot: string,
  path: string,
  text: string,
): Promise<{ pin: Pin; served: WorkerContextInput }> {
  const bytes = encoder.encode(text);
  const digest = await sha256Hex(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    pin: {
      slot,
      path,
      digest,
      sizeBytes: bytes.length,
      mediaType: "text/markdown",
    },
    served: {
      artifactVersionId: crypto.randomUUID(),
      artifactId: crypto.randomUUID(),
      digest,
      sizeBytes: bytes.length,
      mediaType: "text/markdown",
      contentBase64: btoa(binary),
    },
  };
}

function withPins(pins: readonly Pin[]): JobAssignment {
  return { ...localAssignment(), contextInputs: [...pins] } as JobAssignment;
}

async function scratch(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "harness-context-" });
}

Deno.test("a step with no pinned inputs is left exactly as it was", async () => {
  const root = await scratch();
  try {
    let reads = 0;
    const result = await prepareHarnessContext({
      assignment: localAssignment(),
      attemptRoot: root,
      goal: "Implement the plan.",
      workDir: "/work",
      readAttemptContext: () => {
        reads++;
        return Promise.resolve([]);
      },
    });
    assertEquals(result, { ok: true, promptSection: "" });
    assertEquals(reads, 0, "nothing is read for a step with no pins");
    assertEquals([...Deno.readDirSync(root)], [], "no directory is created");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("pinned inputs become files and an index that names every slot", async () => {
  const root = await scratch();
  try {
    const plan = await pinned("plan", "plan.md", "# The plan");
    const brief = await pinned("brief", "brief.md", "# The brief");
    const result = await prepareHarnessContext({
      assignment: withPins([plan.pin, brief.pin]),
      attemptRoot: root,
      goal: "Implement the plan.",
      workDir: "/work",
      readAttemptContext: () => Promise.resolve([plan.served, brief.served]),
    });
    assert(result.ok);
    assertEquals(result.contextDir, `${root}/context`);
    assertEquals(
      await Deno.readTextFile(`${root}/context/plan.md`),
      "# The plan",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/context/brief.md`),
      "# The brief",
    );
    for (const { pin } of [plan, brief]) {
      assert(result.promptSection.includes(pin.slot), `${pin.slot} named`);
      assert(result.promptSection.includes(pin.path), `${pin.path} named`);
      assert(result.promptSection.includes(pin.digest), `${pin.slot} digest`);
    }
    assert(
      result.promptSection.includes(`${root}/context`),
      "the prompt says where the directory is",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bytes that are not the pinned bytes refuse the attempt", async () => {
  const root = await scratch();
  try {
    const plan = await pinned("plan", "plan.md", "# The plan");
    const swapped = {
      ...plan.served,
      contentBase64: btoa("# Some other plan"),
    };
    const result = await prepareHarnessContext({
      assignment: withPins([plan.pin]),
      attemptRoot: root,
      goal: "Implement the plan.",
      workDir: "/work",
      readAttemptContext: () => Promise.resolve([swapped]),
    });
    assertFalse(result.ok);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.code, "CONTEXT_UNMATERIALIZABLE");
    assertEquals(result.retryable, false);
    assert(result.detail.includes("plan"), "the fault names the slot");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("pins with no reader refuse the attempt instead of starting without them", async () => {
  const plan = await pinned("plan", "plan.md", "# The plan");
  const result = await prepareHarnessContext({
    assignment: withPins([plan.pin]),
    attemptRoot: "/never-created",
    goal: "Implement the plan.",
    workDir: "/work",
  });
  assertFalse(result.ok);
  if (result.ok) throw new Error("unreachable");
  assertEquals(result.code, "CONTEXT_READER_MISSING");
  assertEquals(result.retryable, false);
});

Deno.test("a reader that cannot reach the server is a retryable fault", async () => {
  const root = await scratch();
  try {
    const plan = await pinned("plan", "plan.md", "# The plan");
    const result = await prepareHarnessContext({
      assignment: withPins([plan.pin]),
      attemptRoot: root,
      goal: "Implement the plan.",
      workDir: "/work",
      readAttemptContext: () => Promise.reject(new Error("connection reset")),
    });
    assertFalse(result.ok);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.code, "CONTEXT_UNREADABLE");
    assertEquals(result.retryable, true);
    assert(result.detail.includes("connection reset"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
