import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  NativeExecutorError,
  serializePreparedSkillRoots,
  type WorkerExecutor,
} from "../../apps/worker/src/executor.ts";
import { SkillCache } from "../../apps/worker/src/skill-cache.ts";
import { SkillMaterializer } from "../../apps/worker/src/skill-materializer.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { executeAssignment } from "../../apps/worker/src/supervisor-execution.ts";
import {
  publicationAuthorityForAssignment,
  reconcileSkillMaterializationOwner,
} from "../../apps/worker/src/supervisor-recovery.ts";
import {
  createSupervisorState,
  type SupervisorState,
} from "../../apps/worker/src/supervisor-state.ts";
import type { ActiveAssignment } from "../../apps/worker/src/supervisor-support.ts";
import type {
  JobAssignment,
  PreparedSkillContext,
} from "../../apps/worker/src/types.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { createFakeSkillFixture } from "../helpers/worker-skill-materialization.ts";
import {
  localAssignment,
  supervisorConfig,
} from "../helpers/worker-execution/recovery-support.ts";

const VERSION_ID = "50000000-0000-8000-8000-000000000005";
const DIGEST = "a".repeat(64);

type ExecutionFixture = {
  directory: string;
  assignment: JobAssignment;
  active: ActiveAssignment;
  state: SupervisorState;
  events: string[];
};

async function createExecutionFixture(options: {
  withSkill: boolean;
  mutateAfterPrepare?: (fixture: ExecutionFixture) => void;
  boundaryFailure?: boolean;
}): Promise<ExecutionFixture> {
  const directory = await Deno.makeTempDir({ prefix: "issue279-supervisor-" });
  const base = localAssignment();
  const assignment = {
    ...base,
    skillRefs: options.withSkill
      ? [{ versionId: VERSION_ID, digest: DIGEST }]
      : [],
  } as JobAssignment;
  const store = new RegistrationStore(`${directory}/registration.json`);
  await store.saveRegistered("credential", {
    workerHostId: assignment.workerHostId,
    principalId: crypto.randomUUID(),
    status: "registered",
    registrationGeneration: 1,
    workerSessionId: assignment.workerSessionId!,
    workerSessionGeneration: assignment.workerSessionGeneration!,
  });
  await store.saveActiveAssignment({
    assignment,
    nextLocalSeq: "3",
    ackedLocalSeq: "2",
  });
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: 100,
    maxBytes: 100_000,
  });
  await spool.restoreJournalState(assignment.attemptId, "3", "2");
  const events: string[] = [];
  const runtime: { fixture?: ExecutionFixture } = {};
  const prepared: PreparedSkillContext = Object.freeze({
    owner: Object.freeze({
      workerHostId: assignment.workerHostId,
      workerSessionId: assignment.workerSessionId!,
      workerSessionGeneration: assignment.workerSessionGeneration!,
      jobId: assignment.jobId,
      attemptId: assignment.attemptId,
      fence: assignment.fence,
    }),
    roots: Object.freeze(
      options.withSkill
        ? [Object.freeze({
          organizationId: "10000000-0000-4000-8000-000000000001",
          versionId: VERSION_ID,
          digest: DIGEST,
          workerHostId: assignment.workerHostId,
          workerSessionId: assignment.workerSessionId!,
          workerSessionGeneration: assignment.workerSessionGeneration!,
          jobId: assignment.jobId,
          attemptId: assignment.attemptId,
          fence: assignment.fence,
          rootPath: "/private-attempt-root",
          entryPath: "SKILL.md",
        })]
        : [],
    ),
    release: () => {
      events.push("release");
      return Promise.resolve();
    },
  });
  const executor: WorkerExecutor = {
    execute: (_assignment, _signal, _output, context) => {
      events.push("executor");
      assertEquals(context, options.withSkill ? prepared : undefined);
      if (options.boundaryFailure) {
        return Promise.reject(
          new NativeExecutorError("NATIVE_CGROUP_BOUNDARY_FAILED", true),
        );
      }
      runtime.fixture!.state.stopping = true;
      return Promise.resolve({
        status: "failed",
        fault: { code: "EXPECTED_TEST_FAILURE" },
      });
    },
  };
  const state = createSupervisorState({
    config: supervisorConfig(directory),
    client: new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      fetcher: () => Promise.reject(new Error("UNEXPECTED_REQUEST")),
    }),
    registrationStore: store,
    spool,
    executor,
    skillMaterializer: {
      recover: () => Promise.resolve(),
      prepare: () => {
        events.push("prepare");
        options.mutateAfterPrepare?.(runtime.fixture!);
        return Promise.resolve(prepared);
      },
    },
    sleep: () => Promise.resolve(),
  });
  state.registration = await store.load();
  state.processSessionId = assignment.workerSessionId!;
  state.processSessionGeneration = assignment.workerSessionGeneration!;
  state.processSessionAcquired = true;
  state.freshHeartbeatReady = true;
  state.healthy = true;
  const active: ActiveAssignment = {
    assignment,
    controller: new AbortController(),
    renewalController: new AbortController(),
    leaseSeconds: 45,
    leaseDeadline: performance.now() + 60_000,
    renewalLoopStarted: false,
    terminalAcked: false,
    executionStarted: true,
    restored: false,
  };
  state.active.set(assignment.attemptId, active);
  const authority = publicationAuthorityForAssignment(
    assignment,
    state.processSessionId,
    state.processSessionGeneration,
    active.leaseDeadline,
  );
  assert(authority);
  state.publicationAuthorities.set(assignment.attemptId, authority);
  const fixture = { directory, assignment, active, state, events };
  runtime.fixture = fixture;
  return fixture;
}

async function runExecution(fixture: ExecutionFixture): Promise<string[]> {
  const fatal: string[] = [];
  await executeAssignment(
    fixture.state,
    fixture.assignment,
    fixture.active.controller.signal,
    {
      failFatal: (reason) => fatal.push(reason),
      startLeaseRenewal: () => fixture.events.push("renewal"),
    },
    () => Promise.resolve(),
  );
  return fatal;
}

Deno.test("supervisor prepares after renewal, rechecks final authority, and releases only settled execution roots", async () => {
  const valid = await createExecutionFixture({ withSkill: true });
  try {
    assertEquals(await runExecution(valid), []);
    assertEquals(valid.events, ["renewal", "prepare", "executor", "release"]);
  } finally {
    await Deno.remove(valid.directory, { recursive: true });
  }

  const mutations: Array<{
    name: string;
    mutate: (fixture: ExecutionFixture) => void;
  }> = [
    {
      name: "cancel",
      mutate: (fixture) => fixture.active.controller.abort(),
    },
    {
      name: "fence",
      mutate: (fixture) => {
        fixture.active.assignment = {
          ...fixture.active.assignment,
          fence: "2",
        };
      },
    },
    {
      name: "session",
      mutate: (fixture) => {
        fixture.state.processSessionGeneration = "2";
      },
    },
    {
      name: "revocation",
      mutate: (fixture) => {
        fixture.active.publicationRevoked = true;
      },
    },
  ];
  for (const mutation of mutations) {
    const denied = await createExecutionFixture({
      withSkill: true,
      mutateAfterPrepare: mutation.mutate,
    });
    try {
      assertEquals(await runExecution(denied), [], mutation.name);
      assertEquals(
        denied.events,
        ["renewal", "prepare", "release"],
        mutation.name,
      );
    } finally {
      await Deno.remove(denied.directory, { recursive: true });
    }
  }
});

Deno.test("empty pins preserve executor behavior and boundary uncertainty retains prepared roots", async () => {
  const empty = await createExecutionFixture({ withSkill: false });
  try {
    assertEquals(await runExecution(empty), []);
    assertEquals(empty.events, ["renewal", "executor"]);
  } finally {
    await Deno.remove(empty.directory, { recursive: true });
  }

  const uncertain = await createExecutionFixture({
    withSkill: true,
    boundaryFailure: true,
  });
  try {
    assertEquals(await runExecution(uncertain), [
      "NATIVE_CGROUP_BOUNDARY_FAILED",
    ]);
    assertEquals(uncertain.events, ["renewal", "prepare", "executor"]);
    assertEquals(uncertain.active.boundaryFailure, true);
  } finally {
    await Deno.remove(uncertain.directory, { recursive: true });
  }
});

Deno.test("startup cache reconciliation uses persisted assignment and termination evidence, never PID state", () => {
  const assignment = localAssignment();
  const owner = {
    workerHostId: assignment.workerHostId,
    workerSessionId: assignment.workerSessionId!,
    workerSessionGeneration: assignment.workerSessionGeneration!,
    jobId: assignment.jobId,
    attemptId: assignment.attemptId,
    fence: assignment.fence,
  };
  const registration = {
    version: 1 as const,
    workerCredential: "credential",
    workerHostId: assignment.workerHostId,
    workerSessionId: assignment.workerSessionId,
    workerSessionGeneration: assignment.workerSessionGeneration,
    activeAssignments: {
      [assignment.attemptId]: {
        assignment,
        nextLocalSeq: "3",
        ackedLocalSeq: "2",
      },
    },
  };
  const base = {
    owner,
    registration,
    terminationEvidence: new Map<string, unknown>(),
    processSessionAcquired: true,
    healthy: true,
  };
  assertEquals(reconcileSkillMaterializationOwner(base), "active");
  assertEquals(
    reconcileSkillMaterializationOwner({
      ...base,
      registration: {
        ...registration,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "2",
        activeAssignments: {
          [assignment.attemptId]: {
            ...registration.activeAssignments[assignment.attemptId],
            assignment: {
              ...assignment,
              workerSessionId: crypto.randomUUID(),
              workerSessionGeneration: "2",
            },
          },
        },
      },
    }),
    "unknown",
  );
  assertEquals(
    reconcileSkillMaterializationOwner({
      ...base,
      terminationEvidence: new Map([[assignment.attemptId, {
        status: "unknown",
      }]]),
    }),
    "unknown",
  );
  assertEquals(
    reconcileSkillMaterializationOwner({
      ...base,
      registration: { ...registration, activeAssignments: {} },
    }),
    "stale",
  );
});

Deno.test("native context serialization exposes only validated independent attempt roots", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "issue279-native-roots-",
  });
  try {
    const fixture = await createFakeSkillFixture();
    const materializer = new SkillMaterializer(
      new SkillCache(directory),
      fixture.client,
    );
    const prepared = await materializer.prepare(
      fixture.request,
      new AbortController().signal,
    );
    try {
      const serialized = await serializePreparedSkillRoots(
        directory,
        fixture.request.assignment,
        prepared,
      );
      assert(serialized);
      assertEquals(
        JSON.parse(serialized),
        prepared.roots.map((root) => root.rootPath),
      );
      assert(serialized.includes("/attempts/"));
      assertEquals(serialized.includes("/objects/"), false);

      const entry = `${prepared.roots[0].rootPath}/${
        prepared.roots[0].entryPath
      }`;
      await Deno.chmod(entry, 0o644);
      await assertRejects(
        () =>
          serializePreparedSkillRoots(
            directory,
            fixture.request.assignment,
            prepared,
          ),
        NativeExecutorError,
        "PREPARED_SKILL_ROOT_INVALID",
      );
      await Deno.chmod(entry, 0o600);
    } finally {
      await prepared.release();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
