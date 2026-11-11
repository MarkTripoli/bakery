import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as UI from "@bakery/ui";
import { createBakeryApiClient } from "./api/client.ts";
import { ApiProvider } from "./api/context.tsx";
import { ServerPresentation } from "./app/server-presentation.tsx";
import { QueryScopeProvider } from "./app/query-scope-context.tsx";
import {
  SessionProvider,
  useSessionController,
} from "./app/session-context.tsx";
import { I18nProvider, useI18n } from "./i18n/I18nProvider.tsx";
import { router } from "./router.tsx";
import { createReportedQueryClient } from "./app/query-client.ts";
import {
  initializeBrowserMonitoring,
  reportApplicationError,
} from "./telemetry.ts";

const queryClient = createReportedQueryClient((failure) =>
  reportApplicationError(failure.error, {
    source: failure.source,
    operation: failure.operation,
  })
);
const apiClient = createBakeryApiClient();

/** Reads the session singleton the tree just created and hands it to the router. */
function RoutedApplication() {
  const session = useSessionController();
  return (
    <RouterProvider router={router} context={{ api: apiClient, session }} />
  );
}

function Application() {
  const { direction, locale } = useI18n();
  return (
    <UI.ThemeProvider direction={direction} locale={locale}>
      <QueryClientProvider client={queryClient}>
        <QueryScopeProvider queryClient={queryClient}>
          <ApiProvider client={apiClient}>
            <SessionProvider api={apiClient}>
              <ServerPresentation />
              <RoutedApplication />
            </SessionProvider>
          </ApiProvider>
        </QueryScopeProvider>
      </QueryClientProvider>
    </UI.ThemeProvider>
  );
}

createRoot(
  document.getElementById("root")!,
  initializeBrowserMonitoring(router),
).render(
  <StrictMode>
    <I18nProvider>
      <Application />
    </I18nProvider>
  </StrictMode>,
);
