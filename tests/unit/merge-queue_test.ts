import { assertEquals } from "@std/assert";
import type { PgDatabase } from "@bakery/persistence";
import type { Inngest } from "inngest";
import type { GitHubAppClient } from "../../apps/server/src/modules/integrations/github-app.ts";
import type { InstallationTokenBroker } from "../../apps/server/src/modules/integrations/token-broker.ts";
import type { MergeAttempt } from "../../apps/server/src/modules/delivery/merge-attempts.ts";
import {
  createMergeQueueWorkflow,
  entryOutcome,
} from "../../apps/server/src/modules/delivery/merge-queue.ts";

/**
 * #57 slice 2: what one dispatch means for its queue entry, and the shape of
 * the consumer. An unknown outcome must never become merged or blocked.
 */

function attempt(state: MergeAttempt["state"]): MergeAttempt {
  return {
    id: crypto.randomUUID(),
    pullRequestId: crypto.randomUUID(),
    providerNumber: 12,
    repositoryId: crypto.randomUUID(),
    baseBranch: "main",
    expectedHeadSha: "a".repeat(40),
    state,
    providerStatus: null,
    mergedSha: state === "merged" ? "b".repeat(40) : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    settledAt: state === "unknown" ? null : "2026-01-01T00:00:01.000Z",
  };
}

Deno.test("a merged attempt merges the entry", () => {
  assertEquals(entryOutcome({ kind: "attempt", attempt: attempt("merged") }), {
    status: "merged",
  });
});

Deno.test("a merge GitHub refused blocks the entry and says so", () => {
  assertEquals(entryOutcome({ kind: "attempt", attempt: attempt("refused") }), {
    status: "blocked",
    reason: "github_refused",
  });
});

Deno.test("an unknown outcome leaves the entry merging, never merged or blocked", () => {
  assertEquals(entryOutcome({ kind: "attempt", attempt: attempt("unknown") }), {
    status: "merging",
  });
});

Deno.test("a refusal before anything was sent blocks with its own reason", () => {
  for (
    const reason of [
      "not_open",
      "head_moved",
      "base_moved",
      "checks_not_passed",
    ] as const
  ) {
    assertEquals(entryOutcome({ kind: "refused", reason }), {
      status: "blocked",
      reason,
    });
  }
});

type Captured = {
  config: Record<string, unknown>;
  handler: (context: unknown) => Promise<unknown>;
};

function register(): Captured {
  let captured: Captured | undefined;
  const client = {
    createFunction(config: unknown, handler: unknown) {
      captured = {
        config: config as Record<string, unknown>,
        handler: handler as Captured["handler"],
      };
      return captured;
    },
  } as unknown as Inngest;
  createMergeQueueWorkflow({
    client,
    database: {} as PgDatabase,
    github: {} as GitHubAppClient,
    broker: {} as InstallationTokenBroker,
  });
  return captured!;
}

Deno.test("the consumer listens for queued merges, one run per entry", () => {
  const { config } = register();
  assertEquals(config.id, "bakery-merge-queue");
  assertEquals(config.triggers, [{ event: "bakery/merge.queued.v1" }]);
  assertEquals(config.concurrency, [{
    key: "event.data.payload.mergeEntryId",
    limit: 1,
  }]);
  assertEquals(typeof config.onFailure, "function");
});

Deno.test("an event without an organization or entry is ignored, not worked", async () => {
  const { handler } = register();
  const step = {
    run: () => {
      throw new Error("nothing may run for a malformed event");
    },
  };
  for (
    const data of [
      undefined,
      null,
      {},
      { organizationId: crypto.randomUUID() },
      { organizationId: crypto.randomUUID(), payload: {} },
      { payload: { mergeEntryId: crypto.randomUUID() } },
    ]
  ) {
    assertEquals(await handler({ event: { data }, step }), {
      kind: "ignored",
    });
  }
});
