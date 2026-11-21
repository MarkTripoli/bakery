import type {
  AutomationFiringState,
  PlanSeed,
  RealInngestStack,
  SeededAutomation,
} from "../fixtures/real-inngest-stack.ts";
import { delay } from "./real-inngest-workflow.ts";

// Automations on the real Inngest stack (#36): what the tests wait on while the
// real clock, promotion pass and intake consumer do their work.

/**
 * The workflow an automation starts: one worker step as a compiled plan. An
 * automation's version carries no inputs, so the plan names the seeded
 * repository itself instead of reading it from an input.
 */
export const automationPlan = (ids: { repositoryId: string }): PlanSeed => ({
  definition: {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "real-stack-automation-plan",
    description: "One worker step, started by an automation on the real stack.",
    steps: [{
      id: "work",
      uses: "harness.implement",
      with: {
        repositoryId: ids.repositoryId,
        planArtifact: "00000000-0000-4000-8000-0000000000b1",
      },
    }],
  },
});

export const SCHEDULE_EVERY_MINUTE = {
  type: "schedule",
  cron: "* * * * *",
  timezone: "UTC",
} as const;

/**
 * Polls by time until the automation's firings satisfy `ready`. The clock and
 * the promotion pass each run once a minute, so a firing can take two minutes
 * to start on a loaded host.
 */
export async function waitForFirings(
  stack: RealInngestStack,
  automation: SeededAutomation,
  describe: string,
  ready: (firings: readonly AutomationFiringState[]) => boolean,
  timeoutMs = 240_000,
): Promise<readonly AutomationFiringState[]> {
  const deadline = Date.now() + timeoutMs;
  let last: readonly AutomationFiringState[] = [];
  while (Date.now() < deadline) {
    last = await stack.readAutomationFirings(automation);
    if (ready(last)) return last;
    await delay(1_000);
  }
  throw new Error(`${describe}: ${JSON.stringify(last)}`);
}

/** The distinct runs the firings started. */
export const runsOf = (firings: readonly AutomationFiringState[]): string[] => [
  ...new Set(
    firings.flatMap((firing) => firing.runId === null ? [] : [firing.runId]),
  ),
];

export const startedWithRun = (firings: readonly AutomationFiringState[]) =>
  firings.some((firing) =>
    firing.status === "started" && firing.runId !== null
  );
