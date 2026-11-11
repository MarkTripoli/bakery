import { z } from "zod";

export const healthStateSchema = z.enum(["ok", "degraded", "unavailable"])
  .describe(
    "Overall service health state used by liveness and readiness responses.",
  );

export const dependencyHealthSchema = z.object({
  name: z.string().min(1).describe(
    "Stable, non-secret dependency name reported by a health check.",
  ),
  state: healthStateSchema.describe(
    "Dependency state after its bounded health check.",
  ),
  reason: z.string().min(1).describe(
    "Safe reason code explaining the dependency state without secret values.",
  ),
}).describe("The safe status of one runtime dependency.");

export const healthResponseSchema = z.object({
  service: z.string().min(1).describe(
    "Stable service identifier that emitted this health response.",
  ),
  state: healthStateSchema.describe("Overall health state of the service."),
  version: z.string().min(1).describe(
    "Application version or development marker for diagnostics.",
  ),
  dependencies: z.array(dependencyHealthSchema).describe(
    "Bounded dependency checks included in readiness responses.",
  ),
}).describe(
  "Versioned health response shared by server and worker HTTP boundaries.",
);

export type HealthState = z.infer<typeof healthStateSchema>;
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
