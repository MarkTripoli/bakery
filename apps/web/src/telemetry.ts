import { readSentryConfig } from "@bakery/config/sentry";
import { sentryPrivacyOptions } from "@bakery/config/sentry-privacy";
import * as Sentry from "@sentry/react";
import type { RootOptions } from "react-dom/client";
import type { router } from "./router.tsx";

export function initializeBrowserMonitoring(
  applicationRouter: typeof router,
): RootOptions {
  const config = readSentryConfig(
    import.meta.env,
    "web",
    import.meta.env.BAKERY_ENV ??
      (import.meta.env.MODE === "test"
        ? "test"
        : import.meta.env.PROD
        ? "production"
        : "development"),
  );
  if (!config.enabled) return {};
  Sentry.init({
    ...config,
    ...sentryPrivacyOptions(
      "web",
      config,
      new Set(Object.keys(applicationRouter.routesByPath)),
    ),
    defaultIntegrations: false,
    integrations: [
      Sentry.globalHandlersIntegration(),
      Sentry.browserApiErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.tanstackRouterBrowserTracingIntegration(applicationRouter, {
        shouldCreateSpanForRequest: (url) => {
          const target = new URL(url, location.origin);
          return target.origin === location.origin &&
            /^\/(?:v1|api)(?:\/|$)/.test(target.pathname);
        },
      }),
    ],
    tracePropagationTargets: [
      /^\/(?:v1|api)(?:\/|$)/,
      new RegExp(
        `^${
          location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        }/(?:v1|api)(?:/|$)`,
      ),
    ],
    strictTraceContinuation: true,
  });
  return {
    onUncaughtError: Sentry.reactErrorHandler(),
    onCaughtError: Sentry.reactErrorHandler(),
    onRecoverableError: Sentry.reactErrorHandler(),
  };
}

/**
 * Reports a data-layer failure the interface already turned into a state.
 * The query client catches these, so the SDK never sees them as exceptions;
 * this forwards the original failure, with the operation that produced it.
 */
export function reportApplicationError(
  error: unknown,
  context: {
    readonly source: "query" | "mutation";
    readonly operation: string;
  },
): void {
  if (!Sentry.getClient()) return;
  Sentry.captureException(error, {
    tags: {
      "bakery.source": context.source,
      "bakery.operation": context.operation,
    },
    // Repeat suppression compares the raw event, before the privacy filter
    // rebuilds it, so the failure identity has to be part of the event itself.
    fingerprint: ["bakery", context.source, context.operation],
  });
}
