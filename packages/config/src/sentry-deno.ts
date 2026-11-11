import type { SentryConfig, SentryService } from "./sentry.ts";
import { sentryPrivacyOptions } from "./sentry-privacy.ts";

export type RuntimeMonitoring = {
  readonly capture: (error: unknown) => void;
  readonly span: <T>(
    operation: "queue.process" | "http.client",
    action: () => Promise<T>,
  ) => Promise<T>;
  readonly close: () => Promise<void>;
};

export const disabledMonitoring: RuntimeMonitoring = {
  capture: () => undefined,
  span: (_operation, action) => action(),
  close: () => Promise.resolve(),
};

export async function initializeDenoMonitoring(
  config: SentryConfig | undefined,
  service: Exclude<SentryService, "web">,
  serverUrl: string,
): Promise<RuntimeMonitoring> {
  if (!config?.enabled) return disabledMonitoring;
  const Sentry = await import("@sentry/deno");
  const origin = new URL(serverUrl).origin.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  Sentry.init({
    ...config,
    ...sentryPrivacyOptions(service, config),
    enableOpenTelemetrySetup: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.globalHandlersIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.normalizePathsIntegration(),
      Sentry.denoServeIntegration(),
      Sentry.fetchIntegration(),
    ],
    tracePropagationTargets: [new RegExp(`^${origin}(?:/|$)`)],
    strictTraceContinuation: true,
  });
  const reported = new WeakSet<Error>();
  return {
    capture: (error) => {
      Sentry.getActiveSpan()?.setStatus({ code: 2 });
      let original = error;
      for (
        let depth = 0;
        depth < 4 && original instanceof Error &&
        original.cause instanceof Error;
        depth++
      ) original = original.cause;
      if (original instanceof Error) {
        if (reported.has(original)) return;
        reported.add(original);
      }
      Sentry.captureException(original);
    },
    span: (operation, action) =>
      Sentry.startSpan({ op: operation, name: "Worker operation" }, action),
    close: async () => {
      await Sentry.close(2_000);
    },
  };
}
