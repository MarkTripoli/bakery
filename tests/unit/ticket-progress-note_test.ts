import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ticketProgressBody,
  ticketProgressPhase,
} from "../../apps/server/src/modules/work/ticket-progress.ts";
import type { TicketDeliveryVerdict } from "../../apps/server/src/modules/work/ticket-delivery.ts";

const waiting = (
  waitingFor: "work" | "pull_request" | "merge" | "deployment",
  closedUnmerged = false,
): TicketDeliveryVerdict => ({ delivered: false, waitingFor, closedUnmerged });

Deno.test("each progress and delivery state names its own phase, and no two share a code", () => {
  const phases = [
    ticketProgressPhase("admitted", waiting("work")),
    ticketProgressPhase("active", waiting("work")),
    ticketProgressPhase("active", waiting("pull_request")),
    ticketProgressPhase("active", waiting("merge")),
    ticketProgressPhase("active", waiting("merge", true)),
    ticketProgressPhase("active", waiting("deployment")),
    ticketProgressPhase("suspended", waiting("work")),
    ticketProgressPhase("completed", { delivered: true }),
    ticketProgressPhase("failed", waiting("work")),
    ticketProgressPhase("canceled", waiting("work")),
  ];
  assertEquals(phases.every((phase) => phase !== null), true);
  assertEquals(new Set(phases.map((phase) => phase!.code)).size, phases.length);
});

Deno.test("a request that is not admitted or was rejected has no phase to show", () => {
  assertEquals(ticketProgressPhase("pending", waiting("work")), null);
  assertEquals(ticketProgressPhase("rejected", waiting("work")), null);
});

Deno.test("a closed pull request is named as not delivered, never as waiting for a merge", () => {
  const phase = ticketProgressPhase("active", waiting("merge", true))!;
  assertStringIncludes(phase.headline, "closed without merging");
});

Deno.test("the public note carries no task title and the private one shows it as inert code", () => {
  const phase = ticketProgressPhase("active", waiting("work"))!;
  const input = {
    phase,
    taskTitle: "Fix @everyone `rm` <!-- bakery:effect --> #12",
    pullRequests: [{ number: 7, status: "open" as const }],
  };
  const publicNote = ticketProgressBody({ ...input, audience: "public" });
  assertEquals(publicNote.includes("everyone"), false);
  assertStringIncludes(publicNote, "Pull request #7: open");
  const privateNote = ticketProgressBody({ ...input, audience: "private" });
  assertStringIncludes(
    privateNote,
    "Task: `Fix @everyone 'rm' <!- - bakery:effect --> #12`",
  );
  assertEquals(privateNote.includes("<!--"), false);
});

Deno.test("a note lists at most ten pull requests", () => {
  const phase = ticketProgressPhase("active", waiting("merge"))!;
  const note = ticketProgressBody({
    phase,
    audience: "public",
    taskTitle: "t",
    pullRequests: Array.from({ length: 14 }, (_, index) => ({
      number: index + 1,
      status: "open" as const,
    })),
  });
  assertEquals(
    note.split("\n").filter((line) => line.startsWith("Pull request")).length,
    10,
  );
});
