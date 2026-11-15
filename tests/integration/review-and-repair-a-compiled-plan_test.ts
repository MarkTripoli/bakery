import { registerPlanCases } from "../helpers/review-repair/plan-cases.ts";
import {
  loopFixtureCloseStep,
  shareLoopFixture,
} from "../helpers/review-repair/loop-world.ts";

// #397. A compiled plan's review.independent result goes through the same
// finalizer as a flat run's: the report is verified against the job's pins, the
// reviewer is held independent of every implementing session, the cycle,
// findings and decision are recorded, and `$delivery` resolves from the rows.
// The plan's own `repeat` runs each repair; the finalizer appends nothing.
shareLoopFixture();
registerPlanCases();
loopFixtureCloseStep("plan review cases");
