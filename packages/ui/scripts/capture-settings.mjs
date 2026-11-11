// Captures the APP side (the candidate) of the settings Paper parity gate: one
// route screenshot per case of settings-baselines.json, through the same
// capture as the enterprise manifest (capture-enterprise.mjs, which is
// manifest-name driven) under the same hermetic fontconfig. Output lands in
// artifacts/ui-baseline/settings/runtime, beside (never over) the auth and
// enterprise captures; compare-paper.mjs --manifest settings reads it back.
//
//   node scripts/capture-settings.mjs --all --web-base-url http://127.0.0.1:5173
//   node scripts/capture-settings.mjs --changed --web-base-url ...
import { captureEnterpriseCases } from "./capture-enterprise.mjs";

export const captureSettingsCases = (options = {}) =>
  captureEnterpriseCases({ ...options, manifestName: "settings" });

if (import.meta.main) await captureSettingsCases();
