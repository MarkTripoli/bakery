import { assertEquals } from "@std/assert";
import {
  createSupervisorPhaseTracker,
  supervisorChildTimeoutMessage,
  supervisorPhaseLine,
} from "../helpers/supervisor-e2e-phase.ts";

Deno.test("a phase line carries the test, the phase and whole elapsed milliseconds", () => {
  assertEquals(
    supervisorPhaseLine("stack-restart", "first-claim", 1234.6),
    "SUPERVISOR_E2E_PHASE:stack-restart:first-claim:1235",
  );
});

Deno.test("the tracker reports no phase until the child prints one", () => {
  const phases = createSupervisorPhaseTracker();

  assertEquals(phases.last(), "none");
  phases.push("running 2 tests\nsome child output\n");
  assertEquals(phases.last(), "none");
});

Deno.test("the tracker keeps the last complete phase line across chunk boundaries", () => {
  const phases = createSupervisorPhaseTracker();

  phases.push(
    "noise\nSUPERVISOR_E2E_PHASE:stack-restart:stack-up:900\nSUPERVISOR_E2E_PH",
  );
  assertEquals(phases.last(), "stack-restart:stack-up:900");

  phases.push("ASE:stack-restart:first-claim:5100\r\nlater output\n");
  assertEquals(phases.last(), "stack-restart:first-claim:5100");

  phases.push("SUPERVISOR_E2E_PHASE:stack-restart:restart-server:61000");
  assertEquals(
    phases.last(),
    "stack-restart:first-claim:5100",
    "an unfinished line is not a boundary yet",
  );

  phases.push("\n");
  assertEquals(phases.last(), "stack-restart:restart-server:61000");
});

Deno.test("the tracker ignores text that only resembles a phase line", () => {
  const phases = createSupervisorPhaseTracker();

  phases.push(
    "xSUPERVISOR_E2E_PHASE:a:b:1\nSUPERVISOR_E2E_PHASE:a:b:1 trailing\n",
  );

  assertEquals(phases.last(), "none");
});

Deno.test("a timeout message names the budget, the elapsed time and the last phase", () => {
  assertEquals(
    supervisorChildTimeoutMessage(
      180_000,
      180_003.4,
      "stack-restart:restart-server:61000",
    ),
    "SUPERVISOR_E2E_CHILD_TIMEOUT:180000:180003:stack-restart:restart-server:61000",
  );
  assertEquals(
    supervisorChildTimeoutMessage(180_000, 180_000, "none"),
    "SUPERVISOR_E2E_CHILD_TIMEOUT:180000:180000:none",
  );
});
