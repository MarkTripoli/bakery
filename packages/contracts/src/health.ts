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

/**
 * The level of the HTTP API this build serves. It rises by one whenever a
 * change would break a client built against the level before, so a client
 * compares it with the lowest level it supports to say "this server is older
 * than this app". The free-text `version` is for diagnostics only.
 */
export const HEALTH_API_COMPATIBILITY = 1;

// One text for the level and its optional wrapper: the generated contract
// shows the wrapper's, and the schema rail needs the level's own too.
const COMPATIBILITY_DESCRIPTION =
  "API compatibility level of this build, comparable as a number; absent on servers that predate it, which a client treats as older than level 1.";

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
  compatibility: z.number().int().min(1).describe(COMPATIBILITY_DESCRIPTION)
    .optional().describe(COMPATIBILITY_DESCRIPTION),
}).describe(
  "Versioned health response shared by server and worker HTTP boundaries.",
);

export type HealthState = z.infer<typeof healthStateSchema>;
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
