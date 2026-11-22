import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryTargetConfig } from "@bakery/config";
import type { DeliveryTargets } from "./delivery-steps.ts";
import { createLocalReleaseTarget } from "./local-release-target.ts";

/** How long the target waits for the running app to answer its readiness read. */
const HEALTH_READ_TIMEOUT_MS = 5_000;

/**
 * The deployment target a self-hosted install configures (`BAKERY_DELIVERY_*`):
 * one local directory target for one environment. The built artifact of a commit
 * is the file `<artifactsDir>/<sha>.artifact` that the install's build left
 * there; Bakery never builds, and never runs a command to deploy. Health is the
 * running app's own readiness answer: the revision it serves and its state.
 */
export function createLocalDeliveryTargets(
  config: DeliveryTargetConfig,
): DeliveryTargets {
  return {
    resolve(input) {
      if (
        input.environment !== undefined &&
        input.environment !== config.environment
      ) return null;
      return createLocalReleaseTarget({
        root: config.releaseRoot,
        environment: config.environment,
        artifacts: async (request) => {
          // The commit is a 40 hex digit name; nothing else reaches the path.
          if (!/^[0-9a-f]{40}$/.test(request.headSha)) return null;
          let bytes: Uint8Array;
          try {
            bytes = await readFile(
              join(config.artifactsDir, `${request.headSha}.artifact`),
            );
          } catch (error) {
            if (
              typeof error === "object" && error !== null && "code" in error &&
              error.code === "ENOENT"
            ) return null;
            throw error;
          }
          const digest = `sha256:${
            createHash("sha256").update(bytes).digest("hex")
          }`;
          return { bytes, digest };
        },
        probe: async () => {
          const response = await fetch(config.healthUrl, {
            signal: AbortSignal.timeout(HEALTH_READ_TIMEOUT_MS),
          });
          const body = await response.json() as {
            version?: unknown;
            state?: unknown;
          };
          if (
            !response.ok || typeof body.version !== "string" ||
            typeof body.state !== "string"
          ) throw new Error("HEALTH_READ_INVALID");
          return { version: body.version, state: body.state };
        },
        saveEvidence: input.saveEvidence,
      });
    },
  };
}
