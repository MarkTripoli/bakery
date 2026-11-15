import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  evaluateRunControlCapabilities,
  readRunControlCapabilities,
} from "../../apps/server/src/modules/execution/control.ts";

const activeAttempt = {
  attemptStatus: "running",
  jobStatus: "running",
  fence: "7",
  currentFence: "7",
  workerSessionId: "worker-session",
  hostSessionId: "worker-session",
  leaseLive: true,
  sessionCurrent: true,
  adapterCapabilities: ["steer", "follow_up"],
};

Deno.test("control capability read reports the four admitted actions", () => {
  assertEquals(
    evaluateRunControlCapabilities("run-1", "running", activeAttempt),
    {
      runId: "run-1",
      actions: [
        { action: "pause", canRequest: true, reason: "allowed" },
        { action: "resume", canRequest: true, reason: "allowed" },
        { action: "cancel", canRequest: true, reason: "allowed" },
        { action: "interrupt", canRequest: true, reason: "allowed" },
      ],
    },
  );
});

Deno.test("resume mirrors worker-scoped admission while other actions fail closed", () => {
  assertEquals(
    evaluateRunControlCapabilities("run-1", "running", {
      ...activeAttempt,
      workerSessionId: null,
      leaseLive: false,
      sessionCurrent: false,
    }),
    {
      runId: "run-1",
      actions: [
        { action: "pause", canRequest: false, reason: "authority_unavailable" },
        { action: "resume", canRequest: true, reason: "allowed" },
        {
          action: "cancel",
          canRequest: false,
          reason: "authority_unavailable",
        },
        {
          action: "interrupt",
          canRequest: false,
          reason: "authority_unavailable",
        },
      ],
    },
  );
});

Deno.test("missing attempts use run terminal status for the reason", () => {
  assertEquals(
    evaluateRunControlCapabilities("run-1", "completed"),
    {
      runId: "run-1",
      actions: [
        { action: "pause", canRequest: false, reason: "already_terminal" },
        { action: "resume", canRequest: false, reason: "already_terminal" },
        { action: "cancel", canRequest: false, reason: "already_terminal" },
        { action: "interrupt", canRequest: false, reason: "already_terminal" },
      ],
    },
  );
});

Deno.test("control capability read rejects non-workflow kinds like command admission", async () => {
  for (const kind of ["skill_import", "unknown-kind"]) {
    const transaction = {
      query() {
        return Promise.resolve({
          rows: [{ kind, status: "running", ...activeAttempt }],
        });
      },
    };
    const error = await assertRejects(() =>
      readRunControlCapabilities(
        transaction as never,
        "organization-1",
        "run-1",
      )
    );
    assertEquals(error instanceof StandardError, true);
    if (error instanceof StandardError) {
      assertEquals(error.code, "STATE_CONFLICT");
      assertEquals(error.params, { reason: "run_kind_unsupported" });
    }
  }
});

Deno.test("control capability read uses one snapshot statement", async () => {
  const queries: Array<readonly unknown[]> = [];
  const transaction = {
    query(_sql: string, values: readonly unknown[]) {
      queries.push(values);
      return Promise.resolve({
        rows: [{
          kind: "workflow",
          status: "running",
          attemptStatus: null,
          jobStatus: null,
          fence: null,
          currentFence: null,
          workerSessionId: null,
          hostSessionId: null,
          leaseLive: null,
          sessionCurrent: null,
        }],
      });
    },
  };

  const result = await readRunControlCapabilities(
    transaction as never,
    "organization-1",
    "run-1",
  );

  assertEquals(queries.length, 1);
  assertEquals(queries[0], ["organization-1", "run-1"]);
  assertEquals(
    result.actions.every((action) =>
      !action.canRequest && action.reason === "no_active_attempt"
    ),
    true,
  );
});

Deno.test("a waiting run allows only cancel", () => {
  assertEquals(
    evaluateRunControlCapabilities("run-1", "running", undefined, true),
    {
      runId: "run-1",
      actions: [
        { action: "pause", canRequest: false, reason: "no_active_attempt" },
        { action: "resume", canRequest: false, reason: "no_active_attempt" },
        { action: "cancel", canRequest: true, reason: "allowed" },
        { action: "interrupt", canRequest: false, reason: "no_active_attempt" },
      ],
    },
  );
  // A terminal run stays terminal whatever the waiting flag says.
  assertEquals(
    evaluateRunControlCapabilities("run-1", "canceled", undefined, true)
      .actions.every((action) =>
        !action.canRequest && action.reason === "already_terminal"
      ),
    true,
  );
});

Deno.test("control capability read passes the waiting flag from the single statement", async () => {
  const queries: Array<readonly unknown[]> = [];
  const transaction = {
    query(_sql: string, values: readonly unknown[]) {
      queries.push(values);
      return Promise.resolve({
        rows: [{
          kind: "workflow",
          status: "running",
          attemptStatus: null,
          jobStatus: null,
          fence: null,
          currentFence: null,
          workerSessionId: null,
          hostSessionId: null,
          leaseLive: null,
          sessionCurrent: null,
          waitingCancelable: true,
        }],
      });
    },
  };

  const result = await readRunControlCapabilities(
    transaction as never,
    "organization-1",
    "run-1",
  );

  assertEquals(queries.length, 1);
  assertEquals(
    result.actions.map((action) => [action.action, action.canRequest]),
    [["pause", false], ["resume", false], ["cancel", true], [
      "interrupt",
      false,
    ]],
  );
});

const hostB = {
  ...activeAttempt,
  hostSessionId: "worker-session-b",
  workerSessionId: "worker-session-b",
  adapterCapabilities: ["follow_up"],
};

Deno.test("an action can be requested only if it can be requested of every live lane", () => {
  // Host A steers, host B does not: pause and interrupt need both (a resume
  // needs only a follow-up, which both advertise).
  const mixed = evaluateRunControlCapabilities("run-1", "running", [
    activeAttempt,
    hostB,
  ]);
  assertEquals(
    mixed.actions.map((
      action,
    ) => [action.action, action.canRequest, action.reason]),
    [
      ["pause", false, "unsupported"],
      ["resume", true, "allowed"],
      ["cancel", true, "allowed"],
      ["interrupt", false, "unsupported"],
    ],
  );
  // The first refusal in attempt order is the one reported: a lane whose lease
  // lapsed is not hidden behind a lane that is fine.
  const lapsed = evaluateRunControlCapabilities("run-1", "running", [
    activeAttempt,
    { ...activeAttempt, leaseLive: false },
  ]);
  assertEquals(
    lapsed.actions.find((action) => action.action === "pause")?.reason,
    "authority_unavailable",
  );
  // Every lane able: allowed; and one lane is the single-attempt answer.
  assertEquals(
    evaluateRunControlCapabilities("run-1", "running", [
      activeAttempt,
      activeAttempt,
    ]),
    evaluateRunControlCapabilities("run-1", "running", activeAttempt),
  );
});

Deno.test("the control read evaluates every live lane from its one statement", async () => {
  const queries: Array<readonly unknown[]> = [];
  const transaction = {
    query(_sql: string, values: readonly unknown[]) {
      queries.push(values);
      return Promise.resolve({
        rows: [
          { kind: "workflow", status: "running", ...activeAttempt },
          { kind: "workflow", status: "running", ...hostB },
        ],
      });
    },
  };
  const result = await readRunControlCapabilities(
    transaction as never,
    "organization-1",
    "run-1",
  );
  assertEquals(queries.length, 1);
  assertEquals(
    result.actions.map((action) => [action.action, action.canRequest]),
    [["pause", false], ["resume", true], ["cancel", true], [
      "interrupt",
      false,
    ]],
  );
});
