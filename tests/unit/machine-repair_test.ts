import { assertEquals } from "@std/assert";
import { issueRepair } from "../../apps/web/src/pages/machine-repair.ts";

const conflict = {
  ok: false,
  error: { kind: "problem", problem: { status: 409 } },
};
const issued = { ok: true, data: { enrollmentId: "second" } };

function world(
  pending: { targetWorkerHostId: string; state: string }[],
  first: unknown = conflict,
) {
  const calls: string[] = [];
  let issues = 0;
  const api = {
    workers: {
      repairEnrollment: () => {
        calls.push("issue");
        issues += 1;
        return Promise.resolve(issues === 1 ? first : issued);
      },
    },
    workerEnrollments: {
      list: () => {
        calls.push("list");
        return Promise.resolve({
          ok: true,
          data: {
            items: pending.map((item, index) => ({
              ...item,
              enrollmentId: `e${index}`,
              version: 3,
            })),
          },
        });
      },
      cancel: (options: { id: string; version?: number }) => {
        calls.push(`cancel ${options.id} ${options.version}`);
        return Promise.resolve({ ok: true, data: {} });
      },
    },
  } as unknown as Parameters<typeof issueRepair>[0];
  return { api, calls };
}

Deno.test("a pending code for this machine is canceled and a new one issued", async () => {
  const { api, calls } = world([
    { targetWorkerHostId: "other", state: "pending" },
    { targetWorkerHostId: "m1", state: "expired" },
    { targetWorkerHostId: "m1", state: "pending" },
  ]);
  assertEquals(await issueRepair(api, "org", "m1"), issued as never);
  assertEquals(calls, ["issue", "list", "cancel e2 3", "issue"]);
});

Deno.test("a conflict with no pending code for this machine is passed on", async () => {
  const { api, calls } = world([
    { targetWorkerHostId: "other", state: "pending" },
  ]);
  assertEquals(await issueRepair(api, "org", "m1"), conflict as never);
  assertEquals(calls, ["issue", "list"]);
});

Deno.test("a first code that works reads and cancels nothing", async () => {
  const { api, calls } = world([], issued);
  assertEquals(await issueRepair(api, "org", "m1"), issued as never);
  assertEquals(calls, ["issue"]);
});
