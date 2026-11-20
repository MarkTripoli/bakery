import { assertEquals } from "@std/assert";
import {
  RUN_GRANT_ACTIONS,
  RUN_POWER_ACTIONS,
} from "../../apps/server/src/modules/auth/application/run-grants.ts";

/**
 * A run access grant (#456) is observe only. The gate consults grants for these
 * actions and no others, so a new action never becomes reachable by a grant by
 * accident: it has to be added here, in review, with its own refusal test.
 */
Deno.test("a run grant reaches exactly the run, its steps, its task, its delivery evidence and its artifact versions", () => {
  assertEquals(
    Object.entries(RUN_GRANT_ACTIONS).sort(([a], [b]) => a < b ? -1 : 1),
    [
      ["artifactComments.list", "artifactVersion"],
      ["artifactVersions.content", "artifactVersion"],
      ["checks.list", "run"],
      ["outputStreams.transcript", "session"],
      ["runDeliveryDecisions.list", "run"],
      ["runRepairTries.list", "run"],
      ["runReviews.list", "run"],
      ["runSteps.list", "run"],
      ["runs.get", "run"],
      ["sessions.feed", "session"],
      ["tasks.get", "task"],
    ],
  );
});

/**
 * A run power grant (#456 slice 2a) is one expiring right on one question row.
 * The gate consults it for these four actions and no others; approvals.revoke
 * in particular is not a power, so a person asked to approve can never undo an
 * approval. A new action has to be added here, in review, with its own refusal
 * test.
 */
Deno.test("a power grant reaches exactly the get and the one act on its target", () => {
  assertEquals(
    Object.entries(RUN_POWER_ACTIONS).sort(([a], [b]) => a < b ? -1 : 1).map((
      [action, entry],
    ) => [action, entry!.power, entry!.target]),
    [
      ["approvals.decide", "approve", "question"],
      ["approvals.get", "approve", "question"],
      ["artifactComments.create", "review", "artifactVersion"],
      ["questions.answer", "answer", "question"],
      ["questions.get", "answer", "question"],
      ["runSteps.note", "take_over", "step"],
      ["runSteps.takeOver", "take_over", "step"],
      ["sessions.steer", "take_over", "session"],
    ],
  );
});
