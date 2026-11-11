// Capture artifacts route candidates beside the other Paper manifests.
import { captureEnterpriseCases } from "./capture-enterprise.mjs";

export const captureArtifactsCases = (options = {}) =>
  captureEnterpriseCases({ ...options, manifestName: "artifacts" });

if (import.meta.main) await captureArtifactsCases();
