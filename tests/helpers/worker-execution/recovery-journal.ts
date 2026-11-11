import * as issue39 from "./recovery-case-imports.ts";

const {
  assertEquals,
  assertRejects,
  EventSpool,
  WorkerApiClient,
  WorkerRequestError,
  WorkerSupervisor,
  RegistrationStore,
  ackPayload,
  journalTuple,
  localAssignment,
  heartbeatResponse,
  observeRun,
  protocolResponse,
  recoverySleep,
  supervisorConfig,
  waitForCondition,
} = issue39;
type WorkerResultRequest = issue39.WorkerResultRequest;

const assert: typeof issue39.assert = issue39.assert;
type AckPayload = issue39.AckPayload;
// Cases are imported from the issue entrypoint.
for (const kind of ["event", "result"] as const) {
  Deno.test(
    `released ${kind} spool data replays exactly after restart`,
    async () => {
      const directory = await Deno.makeTempDir({
        prefix: `issue39-${kind}-replay-`,
      });
      try {
        const assignment = localAssignment();
        const workerSessionId = assignment.workerSessionId ??
          crypto.randomUUID();
        const workerSessionGeneration = String(
          assignment.workerSessionGeneration ?? "1",
        );
        const store = new RegistrationStore(`${directory}/registration.json`);
        await store.saveRegistered("credential", {
          workerHostId: assignment.workerHostId,
          principalId: crypto.randomUUID(),
          status: "registered",
          registrationGeneration: 1,
          workerSessionId,
          workerSessionGeneration,
        });
        await store.saveActiveAssignment({
          assignment,
          nextLocalSeq: "2",
          ackedLocalSeq: "0",
        });
        const spool = await EventSpool.open({
          path: `${directory}/spool.json`,
          maxRecords: 20,
          maxBytes: 20_000,
        });
        const eventId = crypto.randomUUID();
        const eventType = "job.accepted";
        const eventPayload = {
          acceptedAt: "2026-09-20T00:00:01.000Z",
        };
        const resultStatus = "completed" as const;
        const resultValue = {
          headSha: "head",
          baseSha: "base",
          sessionId: assignment.attemptId,
          artifacts: [],
        };
        if (kind === "event") {
          await spool.enqueueEvent({
            attemptId: assignment.attemptId,
            leaseToken: assignment.leaseToken,
            fence: assignment.fence,
            localSeq: "1",
            eventId,
            eventType,
            payload: eventPayload,
          });
        } else {
          await spool.enqueueResult({
            attemptId: assignment.attemptId,
            leaseToken: assignment.leaseToken,
            fence: assignment.fence,
            localSeq: "1",
            eventId,
            status: resultStatus,
            result: resultValue,
          });
        }

        let phase: "commit" | "released" | "replay" = "commit";
        let committedBody: Record<string, unknown> | undefined;
        let committedAck: AckPayload | undefined;
        let replayedBody: Record<string, unknown> | undefined;
        let mutationCount = 0;
        let replayStatus: number | undefined;
        const firstClient = new WorkerApiClient({
          baseUrl: "http://127.0.0.1:8788",
          credential: "credential",
          fetcher: (input, init) =>
            Promise.resolve().then(() => {
              const path = new URL(String(input)).pathname;
              if (path.endsWith("/heartbeat")) {
                return heartbeatResponse(
                  assignment.workerHostId,
                  [],
                  [],
                  workerSessionId,
                  workerSessionGeneration,
                  [],
                );
              }
              const body = JSON.parse(String(init?.body)) as Record<
                string,
                unknown
              >;
              if (phase === "commit") {
                mutationCount++;
                committedBody = body;
                committedAck = ackPayload(init);
                throw new Error("LOST_ACK_AFTER_SERVER_COMMIT");
              }
              throw new Error("HOLD_JOURNAL_UNTIL_RESTART");
            }),
        });
        if (kind === "event") {
          await assertRejects(
            () =>
              firstClient.postEvents(assignment.attemptId, {
                leaseToken: assignment.leaseToken,
                fence: assignment.fence,
                events: [{
                  eventId,
                  localSeq: "1",
                  eventType,
                  payload: eventPayload,
                }],
                workerSessionId,
                workerSessionGeneration,
              }),
            WorkerRequestError,
            "WORKER_NETWORK_ERROR",
          );
        } else {
          const resultRequest = {
            leaseToken: assignment.leaseToken,
            fence: assignment.fence,
            localSeq: "1",
            status: resultStatus,
            result: resultValue,
            workerSessionId,
            workerSessionGeneration,
          } as unknown as WorkerResultRequest;
          await assertRejects(
            () =>
              firstClient.postResult(
                assignment.attemptId,
                resultRequest,
                eventId,
              ),
            WorkerRequestError,
            "WORKER_NETWORK_ERROR",
          );
        }
        phase = "released";

        const firstSupervisor = new WorkerSupervisor({
          config: supervisorConfig(directory),
          client: firstClient,
          registrationStore: store,
          spool,
          sleep: recoverySleep,
        });
        const firstRun = observeRun(firstSupervisor.run());
        await waitForCondition(async () => {
          const state = await store.load();
          return state?.activeAssignments?.[assignment.attemptId] ===
              undefined &&
            spool.hasRecord(assignment.attemptId, "1");
        }, "RELEASED_JOURNAL_NOT_RETAINED");
        firstSupervisor.requestStop("TEST_RESTART");
        await firstRun;
        assertEquals(mutationCount, 1);
        assert(committedBody);

        const reopenedSpool = await EventSpool.open({
          path: `${directory}/spool.json`,
          maxRecords: 20,
          maxBytes: 20_000,
        });
        assertEquals(reopenedSpool.records().length, 1);

        phase = "replay";
        const restartClient = new WorkerApiClient({
          baseUrl: "http://127.0.0.1:8788",
          credential: "credential",
          fetcher: (input, init) =>
            Promise.resolve().then(() => {
              const path = new URL(String(input)).pathname;
              if (path.endsWith("/heartbeat")) {
                return heartbeatResponse(
                  assignment.workerHostId,
                  [],
                  [],
                  crypto.randomUUID(),
                  "2",
                  [],
                );
              }
              replayedBody = JSON.parse(String(init?.body)) as Record<
                string,
                unknown
              >;
              replayStatus = 200;
              if (!committedAck) throw new Error("SAVED_ACK_MISSING");
              return protocolResponse(committedAck, {
                headers: { "Idempotent-Replayed": "true" },
              });
            }),
        });
        const restarted = new WorkerSupervisor({
          config: supervisorConfig(directory),
          client: restartClient,
          registrationStore: new RegistrationStore(
            `${directory}/registration.json`,
          ),
          spool: reopenedSpool,
          sleep: recoverySleep,
        });
        const restartedRun = observeRun(restarted.run());
        await waitForCondition(
          () => reopenedSpool.records().length === 0,
          "REPLAYED_JOURNAL_NOT_ACKNOWLEDGED",
        );
        restarted.requestStop("TEST_COMPLETE");
        await restartedRun;

        assertEquals(replayStatus, 200);
        assert(replayedBody);
        assertEquals(
          journalTuple(kind, replayedBody),
          journalTuple(kind, committedBody),
        );
        assertEquals(
          (await new RegistrationStore(`${directory}/registration.json`).load())
            ?.activeAssignments,
          undefined,
        );
        assertEquals(
          (await new RegistrationStore(`${directory}/registration.json`).load())
            ?.releaseMarkers,
          undefined,
        );
        assertEquals(reopenedSpool.attemptIds(), []);
        assertEquals(reopenedSpool.journalState(assignment.attemptId), {
          nextLocalSeq: "1",
          ackedLocalSeq: "0",
        });
      } finally {
        await Deno.remove(directory, { recursive: true }).catch(() =>
          undefined
        );
      }
    },
  );
}
