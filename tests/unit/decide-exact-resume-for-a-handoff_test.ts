import { assertEquals } from "@std/assert";
import {
  decideResume,
  type SourceSession,
} from "../../apps/server/src/modules/execution/handoff-eligibility.ts";
import {
  type HandoffManifest,
  HandoffManifestSchema,
} from "../../apps/server/src/modules/execution/handoff-manifest.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const CHECKPOINT =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOST = "22222222-2222-4222-8222-222222222222";
const REF = {
  artifactId: "33333333-3333-4333-8333-333333333333",
  versionId: "44444444-4444-4444-8444-444444444444",
  sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};

function manifest(overrides: Record<string, unknown> = {}): HandoffManifest {
  return HandoffManifestSchema.parse({
    manifestVersion: 1,
    mode: "exact_harness_resume",
    taskId: "55555555-5555-4555-8555-555555555555",
    runId: "66666666-6666-4666-8666-666666666666",
    runStepId: "77777777-7777-4777-8777-777777777777",
    sourceSessionId: SESSION,
    agentVersionId: "88888888-8888-4888-8888-888888888888",
    workflowVersionId: "99999999-9999-4999-8999-999999999999",
    harness: "claude_code",
    harnessVersion: "claude-1.2.3",
    repository: {
      repositoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      commitSha: COMMIT,
      baseSha: COMMIT,
      worktreeId: "wt-1",
      workspaceManifest: REF,
      uncommittedPatch: null,
      binaryChanges: [],
      captureStatus: "complete",
    },
    goal: "Finish the step.",
    decisions: ["Use the pinned plan."],
    context: {
      conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      throughConversationSequence: "0",
      artifactRefs: [REF],
      packDigest: CHECKPOINT,
    },
    tests: [],
    pendingEffects: [],
    nextAction: "Run the tests again.",
    checkpoint: { sequence: "0", digest: CHECKPOINT, safeBoundary: true },
    grants: { scopeDigest: CHECKPOINT, recheckOnResume: true },
    ...overrides,
  });
}

const NATIVE = {
  nativeSessionId: "native-1",
  checkpointId: CHECKPOINT,
  worktreeRevision: COMMIT,
  harnessVersion: "claude-1.2.3",
  workerHostId: HOST,
};

function session(over: Partial<SourceSession> = {}): SourceSession {
  return { id: SESSION, status: "active", resumeRef: NATIVE, ...over };
}

function decide(
  input: {
    manifest?: HandoffManifest;
    session?: SourceSession | null;
    historyAuthorized?: boolean;
    effectsSettled?: boolean;
    sourceHostId?: string;
  } = {},
) {
  return decideResume({
    manifestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    manifestDigest: CHECKPOINT,
    manifest: input.manifest ?? manifest(),
    session: input.session === undefined ? session() : input.session,
    sourceHostId: input.sourceHostId ?? HOST,
    historyAuthorized: input.historyAuthorized ?? true,
    effectsSettled: input.effectsSettled ?? true,
  });
}

function fresh(decision: ReturnType<typeof decide>) {
  return decision.mode === "fresh_session" ? decision.reason : decision.mode;
}

Deno.test("matching session, host, revision, version and checkpoint with live history resumes exactly", () => {
  const decision = decide();
  assertEquals(decision.mode, "exact_harness_resume");
  if (decision.mode !== "exact_harness_resume") return;
  assertEquals(decision.checkpoint, {
    schemaVersion: 1,
    source: "handoff",
    manifestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    manifestDigest: CHECKPOINT,
    agentSessionId: SESSION,
    nativeSessionId: "native-1",
    checkpointId: CHECKPOINT,
    worktreeRevision: COMMIT,
    harnessVersion: "claude-1.2.3",
    workerHostId: HOST,
    eligible: true,
  });
});

Deno.test("a manifest that did not ask for an exact resume starts fresh", () => {
  assertEquals(
    fresh(decide({ manifest: manifest({ mode: "fresh_session" }) })),
    "exact_resume_not_requested",
  );
});

Deno.test("an unsafe boundary starts fresh even when everything else matches", () => {
  const unsafe = manifest({
    checkpoint: { sequence: "0", digest: CHECKPOINT, safeBoundary: false },
  });
  assertEquals(fresh(decide({ manifest: unsafe })), "boundary_unsafe");
});

Deno.test("a missing, different or inactive source session starts fresh", () => {
  assertEquals(fresh(decide({ session: null })), "session_changed");
  assertEquals(
    fresh(decide({ session: session({ id: crypto.randomUUID() }) })),
    "session_changed",
  );
  assertEquals(
    fresh(decide({ session: session({ status: "closed" }) })),
    "session_changed",
  );
});

Deno.test("native evidence that is absent or incomplete starts fresh", () => {
  assertEquals(
    fresh(decide({ session: session({ resumeRef: null }) })),
    "no_native_evidence",
  );
  assertEquals(
    fresh(decide({ session: session({ resumeRef: [NATIVE] }) })),
    "no_native_evidence",
  );
  for (const key of Object.keys(NATIVE)) {
    const partial: Record<string, unknown> = { ...NATIVE };
    delete partial[key];
    assertEquals(
      fresh(decide({ session: session({ resumeRef: partial }) })),
      "no_native_evidence",
      key,
    );
  }
  assertEquals(
    fresh(
      decide({
        session: session({ resumeRef: { ...NATIVE, nativeSessionId: "" } }),
      }),
    ),
    "no_native_evidence",
  );
});

Deno.test("each piece of native evidence must equal what the manifest recorded", () => {
  const cases: [string, Record<string, unknown>, string?][] = [
    ["checkpoint", {
      checkpointId:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    }],
    ["commit", {
      worktreeRevision: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    }],
    ["harness version", { harnessVersion: "claude-9.9.9" }],
    ["host", { workerHostId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }],
  ];
  for (const [name, change] of cases) {
    assertEquals(
      fresh(
        decide({ session: session({ resumeRef: { ...NATIVE, ...change } }) }),
      ),
      "native_evidence_mismatch",
      name,
    );
  }
  // The host the session recorded must also be the host the source attempt ran on.
  assertEquals(
    fresh(decide({ sourceHostId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" })),
    "native_evidence_mismatch",
  );
});

Deno.test("revoked history starts fresh and only after the evidence matched", () => {
  assertEquals(
    fresh(decide({ historyAuthorized: false })),
    "history_revoked",
  );
  // A mismatch is reported before the history check, so the reason is the first failing one.
  assertEquals(
    fresh(decide({
      historyAuthorized: false,
      session: session({ resumeRef: { ...NATIVE, harnessVersion: "other" } }),
    })),
    "native_evidence_mismatch",
  );
});

Deno.test("an unsettled external effect starts fresh before any native evidence is read", () => {
  assertEquals(
    fresh(decide({ effectsSettled: false })),
    "effects_unresolved",
  );
  // The native history describes work whose outcome is unknown, so even a
  // session that matches in every way is not resumed.
  assertEquals(
    fresh(decide({ effectsSettled: false, session: null })),
    "effects_unresolved",
  );
  // An unsafe boundary is still reported first.
  const unsafe = manifest({
    checkpoint: { sequence: "0", digest: CHECKPOINT, safeBoundary: false },
  });
  assertEquals(
    fresh(decide({ effectsSettled: false, manifest: unsafe })),
    "boundary_unsafe",
  );
});
