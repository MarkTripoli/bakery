import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { classifyArtifactMedia } from "../../apps/server/src/modules/knowledge/media.ts";
import { WorkerRequestError } from "../../apps/worker/src/client.ts";
import {
  executeTaskBrief,
  type PublishArtifact,
  publishFailureOutcome,
  renderTaskBrief,
  taskBriefArtifactName,
} from "../../apps/worker/src/task-brief.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";

const profile = {
  id: crypto.randomUUID(),
  revision: 3,
  digest: "a".repeat(64),
  baseSha: null,
};
const repositoryId = crypto.randomUUID();
const decoder = new TextDecoder();

async function bytesDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

const HOSTILE_DESCRIPTION = [
  "<form action=x><script>alert(1)</script></form>",
  "<!doctype html><html onload=x>",
  "tag & ampersand > angle",
  "ctl \u0001 \u000b \u007f \u0008 \u000c",
  "tab\there\nline\rbreak",
  'quote " backslash \\ emoji \u{1F600} euro €',
].join("\n");

function input(title: string, description: string) {
  return {
    brief: { title, description, taskType: "feature" },
    repositoryId,
  };
}

function forbiddenByte(byte: number): boolean {
  return byte === 0x3c || byte === 0x3e || byte === 0x26 || byte === 0x7f ||
    (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
}

Deno.test("task brief rendering is byte-stable and round-trips", () => {
  const first = renderTaskBrief(
    input("<script>", HOSTILE_DESCRIPTION),
    profile,
  );
  const second = renderTaskBrief(
    input("<script>", HOSTILE_DESCRIPTION),
    profile,
  );
  assertEquals(first.bytes, second.bytes);
  assertEquals(first.mediaType, "application/json");
  const parsed = JSON.parse(decoder.decode(first.bytes));
  assertEquals(parsed, {
    schema: "bakery.task-brief/v1",
    title: "<script>",
    taskType: "feature",
    description: HOSTILE_DESCRIPTION,
    repositoryId,
    profile: { id: profile.id, revision: 3, digest: profile.digest },
    baseSha: null,
  });
  // Keys are sorted, so the canonical text is independent of insertion order.
  const keys = Object.keys(parsed);
  assertEquals(keys, [...keys].sort());
});

Deno.test("task brief bytes hold no tag opener, DEL or C0 control byte", () => {
  const rendered = renderTaskBrief(
    input("<!doctype html><form>", HOSTILE_DESCRIPTION),
    profile,
  );
  const offenders = [...rendered.bytes].filter(forbiddenByte);
  assertEquals(offenders, []);
  const text = decoder.decode(rendered.bytes);
  for (
    const escape of [
      "\\u003c",
      "\\u003e",
      "\\u0026",
      "\\u007f",
      "\\u0001",
      "\\u000b",
      "\\u0008",
      "\\u000c",
    ]
  ) assert(text.includes(escape), `missing ${escape}`);
  // Tab, line feed and carriage return use the standard short JSON escapes.
  for (const escape of ["\\t", "\\n", "\\r"]) assert(text.includes(escape));
});

Deno.test("tag-like briefs pass the server media sniffer as safe JSON", () => {
  for (
    const tag of [
      "<form>",
      "<script>",
      "<!doctype html>",
      "<svg onload=x>",
      "<html><body>",
    ]
  ) {
    const rendered = renderTaskBrief(input(tag, tag.repeat(5000)), profile);
    assert(rendered.bytes.byteLength > 4096);
    assert(!rendered.bytes.subarray(0, 4096).includes(0x3c));
    const decision = classifyArtifactMedia({
      declaredType: rendered.mediaType,
      content: rendered.bytes,
    });
    assert(decision !== null, `rejected ${tag}`);
    assertEquals(decision.safety, "safe");
  }
});

async function assignment(): Promise<JobAssignment> {
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  return {
    jobId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    leaseToken: "lease",
    fence: "4",
    action: "task.brief",
    skillRefs: [],
    input: {
      ...input("Title", "Body"),
      repositoryProfile: {
        organizationId: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        repositoryId,
        id: profile.id,
        revision: profile.revision,
        digest: await sha256Hex(canonicalJson(config)),
        config,
        observationId: null,
        observationDigest: null,
        baseSha: null,
      },
    },
  } as unknown as JobAssignment;
}

Deno.test("executeTaskBrief publishes once with a fenced key and returns the artifact", async () => {
  const value = await assignment();
  const requests: Parameters<PublishArtifact>[0][] = [];
  const outcome = await executeTaskBrief(
    value,
    new AbortController().signal,
    async (request) => {
      requests.push(request);
      return {
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: await bytesDigest(request.bytes),
      };
    },
  );
  assertEquals(outcome.status, "completed");
  assertEquals(requests.length, 1);
  assertEquals(requests[0].idempotencyKey, `brief:${value.jobId}:4`);
  assertEquals(requests[0].name, taskBriefArtifactName(value.jobId, 4));
  assertEquals(requests[0].mediaType, "application/json");
  assertEquals(requests[0].artifactType, "plan");
  assert(
    outcome.status === "completed" &&
      (outcome.result as { artifact: { sha256: string } }).artifact.sha256 ===
        await bytesDigest(requests[0].bytes),
  );
});

Deno.test("executeTaskBrief rejects a returned digest that differs from the bytes", async () => {
  const outcome = await executeTaskBrief(
    await assignment(),
    new AbortController().signal,
    () =>
      Promise.resolve({
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: "0".repeat(64),
      }),
  );
  assertEquals(outcome.status, "failed");
  assert(
    outcome.status === "failed" &&
      (outcome.fault as { code: string }).code ===
        "TASK_BRIEF_ARTIFACT_DIGEST_MISMATCH",
  );
});

Deno.test("executeTaskBrief yields canceled with proven termination before publishing", async () => {
  const controller = new AbortController();
  controller.abort();
  let published = false;
  const outcome = await executeTaskBrief(
    await assignment(),
    controller.signal,
    () => {
      published = true;
      return Promise.reject(new Error("must not publish"));
    },
  );
  assertEquals(published, false);
  assertEquals(outcome.status, "canceled");
  const cancellation = (outcome as { cancellation: Record<string, unknown> })
    .cancellation;
  assertEquals(cancellation.processExited, true);
  assertEquals(cancellation.cleanupStatus, "complete");
  assertEquals(cancellation.terminationStatus, "confirmed");
});

Deno.test("executeTaskBrief faults on an invalid input instead of publishing", async () => {
  const value = await assignment();
  (value.input as Record<string, unknown>).brief = { title: "" };
  const outcome = await executeTaskBrief(
    value,
    new AbortController().signal,
    () => Promise.reject(new Error("must not publish")),
  );
  assertEquals(outcome.status, "failed");
  assert(
    outcome.status === "failed" &&
      (outcome.fault as { code: string }).code === "TASK_BRIEF_INPUT_INVALID",
  );
});

Deno.test("executeTaskBrief propagates a publish failure to the supervisor", async () => {
  await assertRejects(
    async () =>
      await executeTaskBrief(
        await assignment(),
        new AbortController().signal,
        () => Promise.reject(new Error("publish failure propagates")),
      ),
    Error,
    "publish failure propagates",
  );
});

Deno.test("publish failures map to canceled, a retryable fault, or propagate", () => {
  const live = new AbortController().signal;
  const aborted = AbortSignal.abort();
  assertEquals(
    publishFailureOutcome(new Error("x"), aborted).status,
    "canceled",
  );
  const transient = publishFailureOutcome(
    new WorkerRequestError("WORKER_NETWORK_ERROR", null, true),
    live,
  );
  assertEquals(transient.status, "failed");
  assert(transient.status === "failed");
  const fault = transient.fault as { retryable: boolean; code: string };
  // The engine never re-admits the step, so the fault must not claim it will.
  assertEquals(fault.retryable, false);
  assertEquals(fault.code, "DEPENDENCY_UNAVAILABLE");
  for (const code of ["LEASE_EXPIRED", "LEASE_FENCED"]) {
    const lease = new WorkerRequestError(code, 409, true);
    try {
      publishFailureOutcome(lease, live);
      throw new Error("expected throw");
    } catch (error) {
      assertEquals(error, lease);
    }
  }
  const fatal = new WorkerRequestError("WORKER_HTTP_409", 409, false);
  try {
    publishFailureOutcome(fatal, live);
    throw new Error("expected throw");
  } catch (error) {
    assertEquals(error, fatal);
  }
});

Deno.test("brief artifact names are unique per job and fence", () => {
  assertEquals(taskBriefArtifactName("j", "3"), "task-brief-j-3.json");
  assert(taskBriefArtifactName("j", "1") !== taskBriefArtifactName("j", "3"));
});

Deno.test("task brief renders the approved plan and stays byte-stable", () => {
  const withPlan = {
    brief: {
      title: "t",
      description: "d",
      taskType: "feature",
      approvedPlan: {
        planRevisionId: crypto.randomUUID(),
        revision: 2,
        digest: "e".repeat(64),
        title: "Plan",
        steps: [{ id: "s1", title: "Step", detail: "<do it>" }],
      },
    },
    repositoryId,
  };
  const first = renderTaskBrief(withPlan, profile);
  assertEquals(first.bytes, renderTaskBrief(withPlan, profile).bytes);
  const parsed = JSON.parse(decoder.decode(first.bytes));
  assertEquals(parsed.approvedPlan, withPlan.brief.approvedPlan);
  assertEquals(forbiddenByteCount(first.bytes), 0);
});

function forbiddenByteCount(bytes: Uint8Array): number {
  return [...bytes].filter(forbiddenByte).length;
}
