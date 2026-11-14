import { registerLoopIntegrationCases } from "../helpers/review-repair/loop-integration-cases.ts";
import { registerLoopReadCases } from "../helpers/review-repair/loop-read-cases.ts";
import { registerMigrationCases } from "../helpers/review-repair/migration-cases.ts";
import { registerPresetIntegrationCases } from "../helpers/review-repair/preset-integration-cases.ts";
import { registerReviewerClaimCases } from "../helpers/review-repair/reviewer-claim-cases.ts";
import { registerStageApprovalCases } from "../helpers/review-repair/stage-approval-cases.ts";
import {
  loopFixtureCloseStep,
  shareLoopFixture,
} from "../helpers/review-repair/loop-world.ts";

// Issue #94 (B10.03). Phase 1 proves migration 0147 against real Postgres:
// three insert-only evidence tables, their keys and the application role's
// grants. Phase 3 proves the reviewed preset through runs.create, engine
// admission and the claim route. Phase 4 proves the review.independent result
// route: cycles, findings and decisions, the appended repair iteration or stop
// step, the delivery gate and the list operations. Phase 6 proves through the
// real findClaimableJob that a review job is leased only to a host enrolled
// with both the model and the reviewer capability.
registerMigrationCases();
registerPresetIntegrationCases();
// #37: the loop cases share one worker fixture per group instead of resetting
// and migrating the database for every case. The read cases between the two
// groups reset the database, so each group closes its fixture first.
shareLoopFixture();
registerLoopIntegrationCases();
loopFixtureCloseStep("loop integration cases");
registerLoopReadCases();
registerReviewerClaimCases();
// #37 with #57 slice 2: a review stage that waits for a person.
registerStageApprovalCases();
loopFixtureCloseStep("reviewer claim and stage approval cases");
