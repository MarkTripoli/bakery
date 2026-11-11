/** Synthetic presentation fixtures. No real credentials, endpoint, or runnable release. */
export const workerEnrollmentStates = [
  "start",
  "listening",
  "connected",
  "ready",
  "loading",
  "empty",
  "error",
  "forbidden",
  "conflict",
  "stale",
  "offline",
  "reconnecting",
  "expired",
  "revoked",
  "unavailable",
  "unproved",
  "worstcase",
] as const;
export type WorkerEnrollmentState = typeof workerEnrollmentStates[number];
export type WorkerEnrollmentStage = "start" | "listening" | "connected";
export type WorkerEnrollmentFixture = Readonly<{
  id: string;
  source: "synthetic-fixture";
  state: WorkerEnrollmentState;
  stage: WorkerEnrollmentStage;
}>;
const stages: Record<WorkerEnrollmentState, WorkerEnrollmentStage> = {
  "start": "start",
  "listening": "listening",
  "connected": "connected",
  "ready": "connected",
  "loading": "start",
  "empty": "start",
  "error": "connected",
  "forbidden": "start",
  "conflict": "connected",
  "stale": "connected",
  "offline": "listening",
  "reconnecting": "listening",
  "expired": "start",
  "revoked": "start",
  "unavailable": "start",
  "unproved": "start",
  "worstcase": "connected",
};
export const workerEnrollmentFixtures = Object.freeze(Object.fromEntries(
  workerEnrollmentStates.map((state) => [
    state,
    Object.freeze({
      id: `worker-enrollment-${state}`,
      source: "synthetic-fixture" as const,
      state,
      stage: stages[state],
    }),
  ]),
)) as Readonly<Record<WorkerEnrollmentState, WorkerEnrollmentFixture>>;
/** Approved prototype artwork only. Never execute or attach a copy handler. */
export const workerEnrollmentPlaceholder =
  "npx \\\n  @bakery/worker@VERIFIED_VERSION \\\n  setup --server \\\n  https://bakery.example";

/** List facts are approved prototype samples, not operational worker records. */
export const workerListStates = [
  "ready",
  "loading",
  "empty",
  "error",
  "forbidden",
  "conflict",
  "stale",
  "offline",
  "reconnecting",
  "expired",
  "revoked",
  "unavailable",
  "unproved",
  "worstcase",
] as const;
export type WorkerListState = typeof workerListStates[number];
export type WorkerListRow = Readonly<
  { id: "web" | "mac" | "build"; online: boolean }
>;
const workerListRows: readonly WorkerListRow[] = Object.freeze([
  Object.freeze({ id: "web", online: true }),
  Object.freeze({ id: "mac", online: true }),
  Object.freeze({ id: "build", online: false }),
]);
export type WorkerListFixture = Readonly<{
  id: string;
  source: "synthetic-fixture";
  state: WorkerListState;
  rows: readonly WorkerListRow[];
}>;
export const workerListFixtures = Object.freeze(Object.fromEntries(
  workerListStates.map((state) => [
    state,
    Object.freeze({
      id: `worker-list-${state}`,
      source: "synthetic-fixture" as const,
      state,
      rows: state === "ready" || state === "worstcase"
        ? workerListRows
        : Object.freeze([]),
    }),
  ]),
)) as Readonly<Record<WorkerListState, WorkerListFixture>>;

/** Synthetic read-only detail. No credential, API, or maintenance authority. */
export const workerDetailStates = [
  "ready",
  "loading",
  "empty",
  "error",
  "forbidden",
  "conflict",
  "stale",
  "offline",
  "reconnecting",
  "expired",
  "revoked",
  "unavailable",
  "unproved",
  "worstcase",
] as const;
export type WorkerDetailState = typeof workerDetailStates[number];
/** Values copied from the approved artwork, never observed host facts. */
const detailIllustration = Object.freeze(
  {
    daemon: "0.8.0 → 0.8.1",
    harnesses: [
      {
        name: "codex",
        installed: "0.153.4",
        tested: "0.153.4",
        latest: "0.153.4",
        update: false,
      },
      {
        name: "claude",
        installed: "2.1.258",
        tested: "2.1.263",
        latest: "2.1.263",
        update: true,
      },
      {
        name: "pi",
        installed: "0.85.1",
        tested: "0.85.1",
        latest: "0.85.1",
        update: false,
      },
    ],
  } as const,
);
export type WorkerDetailFixture = Readonly<{
  id: string;
  source: "synthetic-fixture";
  state: WorkerDetailState;
  capabilities: "unproved";
  harnesses: "unproved";
  maintenance: "unavailable";
  illustration: typeof detailIllustration;
}>;
export const workerDetailFixtures = Object.freeze(Object.fromEntries(
  workerDetailStates.map((state) => [
    state,
    Object.freeze({
      id: `worker-detail-${state}`,
      source: "synthetic-fixture" as const,
      state,
      capabilities: "unproved" as const,
      harnesses: "unproved" as const,
      maintenance: "unavailable" as const,
      illustration: detailIllustration,
    }),
  ]),
)) as Readonly<Record<WorkerDetailState, WorkerDetailFixture>>;
