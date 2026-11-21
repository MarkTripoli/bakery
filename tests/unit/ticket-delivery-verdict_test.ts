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
    manuallyConfirmed: false,
    issueClosed: false,
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
      evidence({ pullRequests: [{ status: "closed" }], issueClosed: true }),
    ),
    { delivered: false, waitingFor: "merge", closedUnmerged: true },
  );
});

Deno.test("merged: no pull request at all is not delivery", () => {
  assertEquals(
    ticketDeliveryVerdict("merged", evidence({ issueClosed: true })),
    { delivered: false, waitingFor: "merge", closedUnmerged: false },
  );
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
        evidence({ pullRequests: merged, deployment, issueClosed: true }),
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
        issueClosed: true,
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

Deno.test("manual: finished work waits for a person's confirmation", () => {
  assertEquals(ticketDeliveryVerdict("manual", evidence()), {
    delivered: false,
    waitingFor: "confirmation",
    closedUnmerged: false,
  });
  assertEquals(
    ticketDeliveryVerdict("manual", evidence({ manuallyConfirmed: true })),
    { delivered: true },
  );
});

Deno.test("work that has not finished is never delivered, whatever else is true", () => {
  for (const policy of ["merged", "deployed_healthy", "manual"] as const) {
    assertEquals(
      ticketDeliveryVerdict(
        policy,
        evidence({
          workFinished: false,
          pullRequests: [{ status: "merged" }],
          deployment: { healthy: true },
          manuallyConfirmed: true,
          issueClosed: true,
        }),
      ),
      { delivered: false, waitingFor: "work", closedUnmerged: false },
    );
  }
});
