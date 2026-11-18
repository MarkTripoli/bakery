import { type ReactNode, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { createBakeryApiClient } from "../api/client.ts";
import { ApiProvider } from "../api/context.tsx";
import {
  QueryScopeProvider,
  useQueryScopeController,
} from "../app/query-scope-context.tsx";
import {
  SessionProvider,
  useSessionController,
} from "../app/session-context.tsx";
import { draftKey } from "../pages/task-conversation/draft.ts";
import { useShellViewport } from "../app/responsive.ts";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { TasksPage } from "../pages/TasksPage.tsx";
import { TaskCoordinationPage } from "../pages/task-coordination/TaskCoordinationPage.tsx";
import {
  type ConversationState,
  type CoordinationState,
  e06Fetch,
  FIXTURE_REFERENCES,
  type FixtureWorld,
  ORGANIZATION_ID,
  PRIYA_ID,
  QUESTION_ID,
  TASK_ID,
} from "./e06-fixture-data.ts";

/** Holds the children back until the fixture session and organization exist. */
function FixtureReady({ children }: { children: ReactNode }) {
  const session = useSessionController();
  const scope = useQueryScopeController();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void session.refresh().then(() => {
      if (!alive) return;
      scope.setIdentity(ORGANIZATION_ID);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [session, scope]);
  return ready ? children : null;
}

/**
 * Renders production pages over a private query cache and an API client whose
 * transport answers from Paper p-18-0 frame data (read only).
 */
function FixtureWorld(
  { children, world }: { children: ReactNode; world: FixtureWorld },
) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      }),
    [],
  );
  // The frames show the composer on "Ask agent"; seed that private draft.
  useMemo(() => {
    try {
      globalThis.localStorage.setItem(
        draftKey(ORGANIZATION_ID, PRIYA_ID, TASK_ID),
        JSON.stringify({
          body: "",
          intent: "ask",
          sendId: null,
          sendBody: null,
        }),
      );
    } catch {
      // Storage is optional; the composer then starts on its default.
    }
  }, []);
  const api = useMemo(
    () => createBakeryApiClient({ fetchImpl: e06Fetch(world) }),
    [world],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <QueryScopeProvider queryClient={queryClient}>
        <ApiProvider client={api}>
          <SessionProvider api={api}>
            <FixtureReady>{children}</FixtureReady>
          </SessionProvider>
        </ApiProvider>
      </QueryScopeProvider>
    </QueryClientProvider>
  );
}

const lastSegment = () =>
  useRouterState({
    select: (router) => router.location.pathname.split("/").at(-1) ?? "default",
  });

export function TaskConversationFixture() {
  const state = lastSegment() as ConversationState;
  const phone = useShellViewport() === "phone";
  const world = useMemo(() => ({ conversation: state, phone }), [state, phone]);
  return (
    <FixtureWorld world={world}>
      <ShellActiveNavigation id="work" />
      <TasksPage
        taskId={TASK_ID}
        references={FIXTURE_REFERENCES}
        questionDefaults={{ [QUESTION_ID]: "payments" }}
      />
    </FixtureWorld>
  );
}

export function TaskCoordinationFixture() {
  const state = lastSegment() as CoordinationState;
  const world = useMemo(() => ({ coordination: state }), [state]);
  return (
    <FixtureWorld world={world}>
      <ShellActiveNavigation id="work" />
      <TaskCoordinationPage
        taskId={TASK_ID}
        references={FIXTURE_REFERENCES}
        // Paper p-18-0 draws no origin or digest, so its scored states hide
        // them; the stale, workflow and ticket states show them (no Paper
        // frame exists for those; the route reference's rationale records them).
        provenance={state === "stale" || state === "workflow" ||
          state === "ticket"}
      />
    </FixtureWorld>
  );
}
