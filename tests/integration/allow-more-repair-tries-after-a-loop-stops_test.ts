import { registerAllowanceCases } from "../helpers/review-repair/allowance-cases.ts";
import {
  loopFixtureCloseStep,
  shareLoopFixture,
} from "../helpers/review-repair/loop-world.ts";

// #62. A loop that ran out of tries can be allowed more, once per stop, only
// when it stopped for that reason, and never past what a workflow can hold.
shareLoopFixture();
registerAllowanceCases();
loopFixtureCloseStep("allow more repair tries");
