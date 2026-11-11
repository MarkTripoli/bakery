import { registerContractCases } from "../helpers/review-repair/contract-cases.ts";
import { registerDecisionCases } from "../helpers/review-repair/decision-cases.ts";
import { registerIndependenceCases } from "../helpers/review-repair/independence-cases.ts";
import { registerPinsCases } from "../helpers/review-repair/pins-cases.ts";
import { registerPresetCases } from "../helpers/review-repair/preset-cases.ts";
import { registerReportCases } from "../helpers/review-repair/report-cases.ts";
import { registerWorkerCheckoutCases } from "../helpers/review-repair/worker-checkout-cases.ts";
import { registerWorkerRepairCases } from "../helpers/review-repair/worker-repair-cases.ts";
import { registerWorkerReportCases } from "../helpers/review-repair/worker-report-cases.ts";
import { registerWorkerReviewerCases } from "../helpers/review-repair/worker-reviewer-cases.ts";
import { registerWorkerWiringCases } from "../helpers/review-repair/worker-wiring-cases.ts";

// Issue #94 (B10.03). Phase 1 holds the contract, vocabulary, fingerprint,
// byte budget and loop-shape rules. Phase 2 adds the pure decision layer: the
// review pins, the report verification, the independence rule and the bounded
// delivery decision. Phase 3 holds the engine and preset side: the delivery
// references, on-demand repair steps, frozen loop bounds and the reviewed
// preset. Phase 5 holds the worker: the read-only reviewer, repair in the
// harness adapters and the scripted paths.
registerContractCases();
registerPinsCases();
registerReportCases();
registerIndependenceCases();
registerDecisionCases();
registerPresetCases();
registerWorkerReviewerCases();
registerWorkerRepairCases();
registerWorkerReportCases();
registerWorkerCheckoutCases();
registerWorkerWiringCases();
