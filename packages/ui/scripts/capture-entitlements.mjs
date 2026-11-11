// Captures the APP side (the candidate) of the entitlements Paper parity gate: one
// route screenshot per case of entitlements-baselines.json, through the same
// capture as the enterprise manifest (capture-enterprise.mjs, which is
// manifest-name driven) under the same hermetic fontconfig. Output lands in
// artifacts/ui-baseline/entitlements/runtime, beside (never over) the auth and
// enterprise captures; compare-paper.mjs --manifest entitlements reads it back.
//
//   node scripts/capture-entitlements.mjs --all --web-base-url http://127.0.0.1:5173
//   node scripts/capture-entitlements.mjs --changed --web-base-url ...
import { captureEnterpriseCases } from "./capture-enterprise.mjs";

export const captureEntitlementsCases = (options = {}) =>
  captureEnterpriseCases({ ...options, manifestName: "entitlements" });

if (import.meta.main) await captureEntitlementsCases();
