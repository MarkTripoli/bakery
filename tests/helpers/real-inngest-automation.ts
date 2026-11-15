import type {
  AutomationFiringState,
  RealInngestStack,
  SeededAutomation,
} from "../fixtures/real-inngest-stack.ts";
import { delay } from "./real-inngest-workflow.ts";

// Automations on the real Inngest stack (#36): what the tests wait on while the
// real clock, promotion pass and intake consumer do their work.

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
