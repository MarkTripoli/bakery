import { assertEquals } from "@std/assert";
import {
  type TicketDeliveryEvidence,
  ticketDeliveryVerdict,
} from "../../apps/server/src/modules/work/ticket-delivery.ts";

function evidence(
  overrides: Partial<TicketDeliveryEvidence> = {},
): TicketDeliveryEvidence {
  return {
    workFinished: true,
    pullRequests: [],
    deployment: null,
    ...overrides,
  };
}

Deno.test("merged: finished work with a merged pull request is delivered", () => {
  assertEquals(
    ticketDeliveryVerdict(
      "merged",
      evidence({ pullRequests: [{ status: "merged" }] }),
    ),
    { delivered: true },
  );
});

Deno.test("merged: an open pull request is not delivery", () => {
  assertEquals(
    ticketDeliveryVerdict(
      "merged",
      evidence({ pullRequests: [{ status: "open" }] }),
    ),
    { delivered: false, waitingFor: "merge", closedUnmerged: false },
  );
});

Deno.test("merged: a pull request closed unmerged is named, never delivery", () => {
  assertEquals(
    ticketDeliveryVerdict(
      "merged",
      evidence({ pullRequests: [{ status: "closed" }] }),
    ),
    { delivered: false, waitingFor: "merge", closedUnmerged: true },
  );
});

Deno.test("merged: finished work that registered no pull request is delivered, there was nothing to merge", () => {
  assertEquals(ticketDeliveryVerdict("merged", evidence()), {
    delivered: true,
  });
  // Work still running is not delivered, pull request or not.
  assertEquals(
    ticketDeliveryVerdict("merged", evidence({ workFinished: false })),
    { delivered: false, waitingFor: "work", closedUnmerged: false },
  );
});

Deno.test("merged: any pull request that is not merged still holds the work", () => {
  for (
    const pullRequests of [[{ status: "open" as const }], [{
      status: "closed" as const,
    }]]
  ) {
    assertEquals(
      ticketDeliveryVerdict("merged", evidence({ pullRequests })),
      {
        delivered: false,
        waitingFor: "merge",
        closedUnmerged: pullRequests[0].status === "closed",
      },
    );
  }
});

Deno.test("deployed_healthy: no pull request is still not delivery until a release is healthy", () => {
  assertEquals(ticketDeliveryVerdict("deployed_healthy", evidence()), {
    delivered: false,
    waitingFor: "merge",
    closedUnmerged: false,
  });
});

Deno.test("merged: a replacement merged after one closed unmerged is delivered", () => {
  assertEquals(
    ticketDeliveryVerdict(
      "merged",
      evidence({ pullRequests: [{ status: "closed" }, { status: "merged" }] }),
    ),
    { delivered: true },
  );
});

Deno.test("merged: one merged and one still open is not delivered yet", () => {
  assertEquals(
    ticketDeliveryVerdict(
      "merged",
      evidence({ pullRequests: [{ status: "merged" }, { status: "open" }] }),
    ),
    { delivered: false, waitingFor: "merge", closedUnmerged: false },
  );
});

Deno.test("deployed_healthy: a merge without healthy release evidence is not delivery", () => {
  const merged = [{ status: "merged" as const }];
  for (const deployment of [null, { healthy: false }]) {
    assertEquals(
      ticketDeliveryVerdict(
        "deployed_healthy",
        evidence({ pullRequests: merged, deployment }),
      ),
      { delivered: false, waitingFor: "deployment", closedUnmerged: false },
    );
  }
});

Deno.test("deployed_healthy: a closed issue or an unmerged pull request never counts", () => {
  assertEquals(
    ticketDeliveryVerdict(
      "deployed_healthy",
      evidence({
        pullRequests: [{ status: "closed" }],
        deployment: { healthy: true },
      }),
    ),
    { delivered: false, waitingFor: "merge", closedUnmerged: true },
  );
});

Deno.test("deployed_healthy: a merge and healthy release evidence is delivered", () => {
  assertEquals(
    ticketDeliveryVerdict(
      "deployed_healthy",
      evidence({
        pullRequests: [{ status: "merged" }],
        deployment: { healthy: true },
      }),
    ),
    { delivered: true },
  );
});

Deno.test("task: finished work is delivered with no pull request, a running one is not", () => {
  assertEquals(ticketDeliveryVerdict("task", evidence()), { delivered: true });
  // Pull requests, open or closed, do not hold back a task policy.
  assertEquals(
    ticketDeliveryVerdict(
      "task",
      evidence({ pullRequests: [{ status: "open" }, { status: "closed" }] }),
    ),
    { delivered: true },
  );
  assertEquals(
    ticketDeliveryVerdict("task", evidence({ workFinished: false })),
    { delivered: false, waitingFor: "work", closedUnmerged: false },
  );
});

Deno.test("work that has not finished is never delivered, whatever else is true", () => {
  for (const policy of ["task", "merged", "deployed_healthy"] as const) {
    assertEquals(
      ticketDeliveryVerdict(
        policy,
        evidence({
          workFinished: false,
          pullRequests: [{ status: "merged" }],
          deployment: { healthy: true },
        }),
      ),
      { delivered: false, waitingFor: "work", closedUnmerged: false },
    );
  }
});
