import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import {
  HANDOFF_MANIFEST_MAX_BYTES,
  HandoffManifestSchema,
} from "../../apps/server/src/modules/execution/handoff-manifest.ts";
import {
  computeSafeBoundary,
  createHandoffManifest,
} from "../../apps/server/src/modules/execution/handoff-manifests.ts";

// #33 slice 1: the manifest is a record, never the authority. These pin what
// the server checks against its own rows, what it overwrites (the safe boundary
// and the pending effects), and how a repeated or different write behaves.

const ORG = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const STEP = "44444444-4444-4444-8444-444444444444";
const ATTEMPT = "55555555-5555-4555-8555-555555555555";
const SESSION = "66666666-6666-4666-8666-666666666666";
const AGENT = "77777777-7777-4777-8777-777777777777";
const WORKFLOW = "88888888-8888-4888-8888-888888888888";
const REPO = "99999999-9999-4999-8999-999999999999";
const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EFFECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);

const ref = { artifactId: ARTIFACT, versionId: VERSION, sha256: SHA };

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    mode: "fresh_session",
    taskId: TASK,
    runId: RUN,
    runStepId: STEP,
    sourceSessionId: SESSION,
    agentVersionId: AGENT,
    workflowVersionId: WORKFLOW,
    harness: "codex",
    harnessVersion: "codex-1.2.3",
    repository: {
      repositoryId: REPO,
      commitSha: COMMIT,
      baseSha: COMMIT,
      worktreeId: "wt-1",
      workspaceManifest: ref,
      uncommittedPatch: null,
      binaryChanges: [],
      captureStatus: "complete",
    },
    goal: "Finish the step.",
    decisions: ["Use the pinned plan."],
    context: {
      conversationId: CONVERSATION,
      throughConversationSequence: "42",
      artifactRefs: [ref],
      packDigest: SHA,
    },
    tests: [{
      command: "deno test",
      result: "passed",
      evidenceVersionId: VERSION,
    }],
    pendingEffects: [],
    nextAction: "Run the tests again.",
    checkpoint: { sequence: "10", digest: SHA, safeBoundary: true },
    grants: { scopeDigest: SHA, recheckOnResume: true },
    ...overrides,
  };
}

type World = {
  effects?: Array<{ id: string; status: string }>;
  artifactSha?: string;
  sessionConversation?: string;
  existing?: { requestDigest: string } | null;
};

function fake(world: World = {}) {
  const inserted: Array<readonly unknown[]> = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("from bakery.job_attempts a")) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            run_step_id: STEP,
            run_id: RUN,
            task_id: TASK,
            workflow_version_id: WORKFLOW,
            agent_version_id: AGENT,
            repository_id: REPO,
          }],
        });
      }
      if (sql.includes("from bakery.agent_sessions")) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            conversation_id: world.sessionConversation ?? CONVERSATION,
            agent_version_id: AGENT,
            harness: "codex",
          }],
        });
      }
      if (sql.includes("from bakery.artifact_versions v")) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: VERSION,
            artifact_id: ARTIFACT,
            sha256: world.artifactSha ?? SHA,
          }],
        });
      }
      if (sql.includes("from bakery.external_effects")) {
        return Promise.resolve({
          rowCount: (world.effects ?? []).length,
          rows: world.effects ?? [],
        });
      }
      if (sql.includes("insert into bakery.handoff_manifests")) {
        if (world.existing) return Promise.resolve({ rowCount: 0, rows: [] });
        inserted.push(values);
        return Promise.resolve({
          rowCount: 1,
          rows: [row(values)],
        });
      }
      if (sql.includes("from bakery.handoff_manifests")) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            ...row(inserted[0] ?? []),
            request_digest: world.existing!.requestDigest,
          }],
        });
      }
      throw new Error("unexpected query: " + sql.slice(0, 60));
    },
  } as unknown as PgTransactionClient;
  return { transaction, inserted };
}

function row(values: readonly unknown[]) {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    organization_id: ORG,
    task_id: values[1] ?? TASK,
    run_id: values[2] ?? RUN,
    run_step_id: values[3] ?? STEP,
    source_attempt_id: ATTEMPT,
    source_fence: String(values[5] ?? "3"),
    mode: values[6] ?? "fresh_session",
    digest: values[7] ?? SHA,
    safe_boundary: values[9] ?? true,
    status: "pending",
    manifest: JSON.parse(String(values[10] ?? "{}")),
    created_at: new Date("2026-11-20T00:00:00Z"),
  };
}

const attempt = {
  id: ATTEMPT,
  job_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  fence: "3",
  last_event_seq: "12",
};

function create(raw: unknown, world: World = {}) {
  const { transaction, inserted } = fake(world);
  return {
    inserted,
    promise: createHandoffManifest(transaction, {
      organizationId: ORG,
      attempt,
      rawManifest: raw,
    }),
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await assertRejects(() => promise, StandardError);
  return (error as StandardError).code;
}

Deno.test("a well-formed manifest parses, and an unknown field is refused", () => {
  assertEquals(HandoffManifestSchema.safeParse(manifest()).success, true);
  assertEquals(
    HandoffManifestSchema.safeParse({ ...manifest(), transcript: "x" }).success,
    false,
  );
  assertEquals(
    HandoffManifestSchema.safeParse(
      manifest({ grants: { scopeDigest: SHA, recheckOnResume: false } }),
    ).success,
    false,
  );
});

Deno.test("the safe boundary is false past the journal or while an effect is unsettled", () => {
  const base = {
    checkpointSequence: "10",
    lastEventSeq: "12",
    effectStates: [] as string[],
  };
  assertEquals(computeSafeBoundary(base), true);
  assertEquals(
    computeSafeBoundary({ ...base, effectStates: ["confirmed", "failed"] }),
    true,
  );
  for (const state of ["prepared", "submitted", "uncertain"]) {
    assertEquals(
      computeSafeBoundary({ ...base, effectStates: [state] }),
      false,
      state,
    );
  }
  assertEquals(
    computeSafeBoundary({ ...base, checkpointSequence: "13" }),
    false,
  );
  assertEquals(
    computeSafeBoundary({ ...base, checkpointSequence: "12" }),
    true,
  );
});

Deno.test("the server's safe boundary and effect list replace the source's claims", async () => {
  // The source claims a safe boundary and lists no effects; the ledger holds an
  // uncertain one, so neither claim survives.
  const { promise, inserted } = create(manifest(), {
    effects: [{ id: EFFECT, status: "uncertain" }, {
      id: "x",
      status: "confirmed",
    }],
  });
  const result = await promise;
  assertEquals(result.kind, "created");
  const stored = JSON.parse(String(inserted[0][10]));
  assertEquals(stored.checkpoint.safeBoundary, false);
  assertEquals(stored.pendingEffects, [{
    effectId: EFFECT,
    state: "uncertain",
  }]);
  assertEquals(inserted[0][9], false);
  // The digest covers what was stored; a retry is compared on what was sent.
  assert(/^[0-9a-f]{64}$/.test(String(inserted[0][7])));
  assert(/^[0-9a-f]{64}$/.test(String(inserted[0][8])));
  assert(inserted[0][7] !== inserted[0][8]);
});

Deno.test("a clean ledger and a checkpoint inside the journal store a true boundary", async () => {
  const { promise, inserted } = create(
    manifest({
      checkpoint: { sequence: "10", digest: SHA, safeBoundary: false },
    }),
  );
  await promise;
  assertEquals(
    JSON.parse(String(inserted[0][10])).checkpoint.safeBoundary,
    true,
  );
  assertEquals(inserted[0][5], "3");
});

Deno.test("an identifier that disagrees with the server's rows is refused", async () => {
  const other = "12121212-1212-4212-8212-121212121212";
  const cases: Array<[string, Record<string, unknown>]> = [
    ["run step", { runStepId: other }],
    ["run", { runId: other }],
    ["task", { taskId: other }],
    ["workflow version", { workflowVersionId: other }],
    ["repository", {
      repository: { ...manifest().repository, repositoryId: other },
    }],
  ];
  for (const [label, overrides] of cases) {
    assertEquals(
      await code(create(manifest(overrides)).promise),
      "UNPROCESSABLE",
      label,
    );
  }
  // A session whose conversation is not the manifest's.
  assertEquals(
    await code(create(manifest(), { sessionConversation: other }).promise),
    "UNPROCESSABLE",
  );
});

Deno.test("an artifact reference with a digest the server does not hold is refused", async () => {
  assertEquals(
    await code(create(manifest(), { artifactSha: "c".repeat(64) }).promise),
    "UNPROCESSABLE",
  );
});

Deno.test("a manifest over the inline bound is refused as too large, never truncated", async () => {
  const big = manifest({
    decisions: Array.from({ length: 32 }, () => "x".repeat(1000)),
    goal: "g".repeat(4000),
    nextAction: "n".repeat(2000),
  });
  assert(
    new TextEncoder().encode(JSON.stringify(big)).byteLength <
      HANDOFF_MANIFEST_MAX_BYTES + 40_000,
  );
  const padded = {
    ...big,
    tests: Array.from(
      { length: 64 },
      () => ({
        command: "c".repeat(1000),
        result: "passed",
        evidenceVersionId: null,
      }),
    ),
  };
  assertEquals(await code(create(padded).promise), "BODY_TOO_LARGE");
});

Deno.test("the same manifest replays; a different one for the same attempt conflicts", async () => {
  const first = create(manifest());
  const created = await first.promise;
  assertEquals(created.kind, "created");
  const requestDigest = String(first.inserted[0][8]);
  const replay = await create(manifest(), { existing: { requestDigest } })
    .promise;
  assertEquals(replay.kind, "replayed");
  assertEquals(
    await code(
      create(manifest(), { existing: { requestDigest: "f".repeat(64) } })
        .promise,
    ),
    "STATE_CONFLICT",
  );
});
