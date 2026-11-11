import { type Handler, Hono } from "hono";
import {
  type DependencyHealth,
  type HealthResponse,
  healthResponseSchema,
} from "./health.ts";

export type HealthDependency = {
  name: string;
  check: (signal?: AbortSignal) => Promise<boolean> | boolean;
};

export type HealthAppOptions = {
  service: string;
  version: string;
  config: {
    environment?: string;
    missingConfig: readonly string[];
    invalidConfig?: readonly string[];
  };
  dependencies?: readonly HealthDependency[];
  dependencyTimeoutMs?: number;
  timers?: HealthTimers;
};

export type HealthTimers = {
  setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

async function checkDependency(
  dependency: HealthDependency,
  timeoutMs: number,
  timers: HealthTimers,
): Promise<DependencyHealth> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const result = await Promise.race([
      Promise.resolve(dependency.check(controller.signal)),
      new Promise<never>((_, reject) => {
        timeoutHandle = timers.setTimeout(
          () => {
            controller.abort("health-check-timeout");
            reject(new Error("timeout"));
          },
          timeoutMs,
        );
      }),
    ]);
    return {
      name: dependency.name,
      state: result ? "ok" : "unavailable",
      reason: result ? "AVAILABLE" : "DEPENDENCY_UNAVAILABLE",
    };
  } catch {
    return {
      name: dependency.name,
      state: "unavailable",
      reason: "DEPENDENCY_UNAVAILABLE",
    };
  } finally {
    if (timeoutHandle !== undefined) timers.clearTimeout(timeoutHandle);
    if (!controller.signal.aborted) controller.abort("health-check-finished");
  }
}

export async function readiness(
  options: HealthAppOptions,
): Promise<HealthResponse> {
  const dependencies: DependencyHealth[] = [];
  if (options.config.missingConfig.length > 0) {
    dependencies.push({
      name: "configuration",
      state: "unavailable",
      reason: "CONFIGURATION_MISSING",
    });
  } else if ((options.config.invalidConfig ?? []).length > 0) {
    dependencies.push({
      name: "configuration",
      state: "unavailable",
      reason: "CONFIGURATION_INVALID",
    });
  } else if ((options.dependencies ?? []).length === 0) {
    dependencies.push({
      name: "runtime",
      state: "unavailable",
      reason: "DEPENDENCY_CHECKS_MISSING",
    });
  }
  const timers: HealthTimers = options.timers ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const dependencyResults = await Promise.all(
    (options.dependencies ?? []).map((dependency) =>
      checkDependency(dependency, options.dependencyTimeoutMs ?? 250, timers)
    ),
  );
  dependencies.push(...dependencyResults);
  const response = {
    service: options.service,
    state: dependencies.some((dependency) => dependency.state !== "ok")
      ? "unavailable"
      : "ok",
    version: options.version,
    dependencies,
  } satisfies HealthResponse;
  return healthResponseSchema.parse(response);
}

export function createHealthApp(options: HealthAppOptions): Hono {
  const app = new Hono();
  const live: Handler = (context) =>
    context.json(
      {
        service: options.service,
        state: "ok",
        version: options.version,
        dependencies: [],
      } satisfies HealthResponse,
    );
  const ready: Handler = async (context) => {
    const response = await readiness(options);
    return context.json(response, response.state === "ok" ? 200 : 503);
  };
  app.get("/health/live", live);
  app.get("/livez", live);
  app.get("/health/ready", ready);
  app.get("/readyz", ready);
  // A caller that did not choose a probe gets the stronger one: readiness is the
  // only answer that can report ill health, and liveness here is a static 200.
  app.get("/health", ready);
  return app;
}
