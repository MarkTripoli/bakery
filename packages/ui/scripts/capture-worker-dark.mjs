// Capture worker-dark story candidates beside the other Paper manifests.
import { captureSiteStoryCases } from "./capture-site-stories.mjs";

export const captureWorkerDarkCases = (options = {}) =>
  captureSiteStoryCases({ ...options, manifestName: "worker-dark" });

if (import.meta.main) await captureWorkerDarkCases();
