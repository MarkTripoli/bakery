import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { RepositoryProfileResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  applicationQueryOptions,
  effectiveAccessQueryOptions,
  integrationConnectionQueryOptions,
  repositoryProfilesListQueryOptions,
  repositoryQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { PROJECTS_HOME, WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { useCursorPages } from "./projects-onboarding/useCursorPages.ts";
import { WorkingSettingsSheet } from "./projects/WorkingSettingsSheet.tsx";
import {
  activeProfile,
  branchesOf,
  setupBadge,
} from "./projects/repository-state.ts";

/** Versions are read a page at a time; the page wants every one so the next number is right. */
const PROFILE_PAGE = 100;

/**
 * One repository (design-ux, #65): a header with what is known about its
 * setup and a list of the steps that make Bakery ready to work in it. The
 * connection and the working settings are shown here; the readiness check is
 * still the earlier page until its own slice.
 */
export function RepositoryPage(
  { repositoryId }: { readonly repositoryId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const offline = useConnectivity() === "offline";
  const phone = useShellViewport() === "phone";
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const canManage = access.data?.role === "admin";
  const repository = useQuery(repositoryQueryOptions(api, scope, repositoryId));
  const application = useQuery({
    ...applicationQueryOptions(
      api,
      scope,
      repository.data?.applicationId ?? "",
    ),
    enabled: repository.data !== undefined,
  });
  const connection = useQuery({
    ...integrationConnectionQueryOptions(
      api,
      scope,
      repository.data?.integrationConnectionId ?? "",
    ),
    enabled: repository.data !== undefined,
  });
  const profilesQuery = useQuery({
    ...repositoryProfilesListQueryOptions(api, scope, repositoryId, {
      limit: PROFILE_PAGE,
    }),
    enabled: repository.data !== undefined,
  });
  const profiles = useCursorPages<RepositoryProfileResponse>(
    profilesQuery,
    `${scope.sessionGeneration}:${
      scope.organizationId ?? "none"
    }:${repositoryId}`,
    useCallback((cursor) =>
      queryClient.fetchQuery(
        repositoryProfilesListQueryOptions(api, scope, repositoryId, {
          cursor,
          limit: PROFILE_PAGE,
        }),
      ), [api, queryClient, scope, repositoryId]),
  );
  // Read every version, so the next number and the one in use are right.
  const { hasNext, loadingMore, moreError, loadMore } = profiles;
  useEffect(() => {
    if (hasNext && !loadingMore && !moreError) loadMore();
  }, [hasNext, loadingMore, moreError, loadMore]);

  const [sheet, setSheet] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const openSheet = () => {
    opener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setSheet(true);
  };
  const closeSheet = () => {
    setSheet(false);
    focusAfterPaint(() => opener.current);
  };

  const current = repository.data;
  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          {
            href: PROJECTS_HOME,
            label: translate("projects.list.title" as never),
          },
          {
            label: current === undefined
              ? translate("projects.repository.breadcrumb" as never)
              : `${current.owner}/${current.name}`,
          },
        ]}
      />
    </ShellSlot>
  );
  const title = current === undefined
    ? translate("projects.repository.breadcrumb" as never)
    : `${current.owner}/${current.name}`;

  const loadFailure = repository.isError
    ? repository.error
    : profilesQuery.isError
    ? profilesQuery.error
    : undefined;
  if (current === undefined || loadFailure !== undefined) {
    const notFound = failureStatus(loadFailure) === 404;
    const forbidden = isForbiddenFailure(loadFailure);
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="repository-page" variant="wide">
          <UI.PageHeader variant="list" flush title={title} />
          {loadFailure === undefined
            ? (
              <UI.Stack gap="standard" aria-busy="true">
                <UI.Text variant="muted" role="status">
                  {translate("projects.repository.loading" as never)}
                </UI.Text>
                <UI.Skeleton shape="row" />
                <UI.Skeleton shape="row" />
              </UI.Stack>
            )
            : notFound || forbidden
            ? (
              <UI.EmptyState
                title={translate(
                  (notFound
                    ? "projects.repository.notFound.title"
                    : "projects.repository.forbidden.title") as never,
                )}
                description={translate(
                  (notFound
                    ? "projects.repository.notFound.description"
                    : "projects.repository.forbidden.description") as never,
                )}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => void navigate({ to: PROJECTS_HOME })}
                  >
                    {translate("projects.repository.back" as never)}
                  </UI.Button>
                }
                variant="firstUse"
              />
            )
            : (
              <UI.ErrorState
                title={translate(
                  (asyncKindForError(loadFailure) === "offline"
                    ? "library.offlineTitle"
                    : "projects.repository.error.title") as never,
                )}
                description={translate(
                  (asyncKindForError(loadFailure) === "offline"
                    ? "library.offlineDescription"
                    : "projects.repository.error.description") as never,
                )}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => {
                      void repository.refetch();
                      void profilesQuery.refetch();
                    }}
                  >
                    {translate("projects.repository.error.retry" as never)}
                  </UI.Button>
                }
              />
            )}
        </UI.SettingsContent>
      </>
    );
  }

  const badge = setupBadge(current);
  const active = activeProfile(current, profiles.items);
  const archived = current.archivedAt !== null;
  const status = (value: "done" | "todo" | "unknown") =>
    translate(`projects.repository.status.${value}` as never);
  const account = connection.data?.label ?? "";
  const connectionWorks = connection.data?.status === "enabled";

  // The next action of the setup: at the end of the step's line, label-wide;
  // full width in the step's detail only on a phone.
  const choose = (
    <UI.Button
      variant="primary"
      disabled={profiles.state !== "ready" || archived}
      onClick={openSheet}
    >
      {translate("projects.repository.step.settings.choose" as never)}
    </UI.Button>
  );
  return (
    <>
      {breadcrumbs}
      <UI.SettingsContent data-testid="repository-page" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={title}
          subtitle={
            <UI.Stack gap="compact">
              <UI.Text variant="muted">
                {translate("projects.repository.subtitle" as never, {
                  application: application.data?.name ?? "",
                  branch: current.defaultBranch,
                })}
              </UI.Text>
              {badge === null ? null : (
                <UI.Inline gap="compact">
                  <UI.Badge tone="neutral">
                    {translate(`projects.list.badge.${badge}` as never)}
                  </UI.Badge>
                </UI.Inline>
              )}
            </UI.Stack>
          }
          actions={
            <UI.Button
              variant="secondary"
              onClick={() =>
                void navigate({
                  to: "/projects/repositories/$repositoryId/rules",
                  params: { repositoryId: current.id },
                })}
            >
              {translate("projects.repository.rules" as never)}
            </UI.Button>
          }
        />
        <UI.Stack gap="spacious">
          {access.isSuccess && !canManage
            ? (
              <UI.InlineNotice tone="information">
                {translate("projects.repository.adminOnly" as never)}
              </UI.InlineNotice>
            )
            : null}
          {archived
            ? (
              <UI.InlineNotice tone="information">
                {translate("projects.repository.archivedNotice" as never)}
              </UI.InlineNotice>
            )
            : null}
          <UI.ListSection
            flush
            title={translate("projects.repository.setup.title" as never)}
            variant="list"
          >
            <UI.StepList
              label={translate("projects.repository.setup.label" as never)}
              data-testid="repository-setup"
            >
              <UI.StepItem
                data-testid="setup-connection"
                status={connection.isError
                  ? "unknown"
                  : connection.data === undefined
                  ? "running"
                  : connectionWorks
                  ? "done"
                  : "failed"}
                statusLabel={connection.isError
                  ? status("unknown")
                  : connectionWorks
                  ? status("done")
                  : status("todo")}
                title={translate(
                  "projects.repository.step.connection.title" as never,
                )}
                summary={connection.isError
                  ? translate(
                    "projects.repository.step.connection.unknown" as never,
                  )
                  : connection.data === undefined
                  ? undefined
                  : translate(
                    (connectionWorks
                      ? "projects.repository.step.connection.done"
                      : "projects.repository.step.connection.problem") as never,
                    { account },
                  )}
                action={connection.isError || (connection.data !== undefined &&
                    !connectionWorks)
                  ? (
                    <UI.Button
                      variant="text"
                      onClick={() =>
                        void navigate({
                          to: "/settings/organization/integrations",
                        })}
                    >
                      {translate(
                        "projects.repository.step.connection.open" as never,
                      )}
                    </UI.Button>
                  )
                  : undefined}
              />
              <UI.StepItem
                data-testid="setup-settings"
                status={active === null ? "running" : "done"}
                statusLabel={status(active === null ? "todo" : "done")}
                title={translate(
                  "projects.repository.step.settings.title" as never,
                )}
                summary={active === null
                  ? translate("projects.repository.step.settings.todo" as never)
                  : translate(
                    "projects.repository.step.settings.done" as never,
                    {
                      branches: branchesOf(active.config).join(", "),
                      version: active.revision,
                    },
                  )}
                action={active === null
                  ? phone ? undefined : choose
                  : (
                    <UI.Button
                      variant="text"
                      disabled={profiles.state !== "ready" || archived}
                      onClick={openSheet}
                    >
                      {translate(
                        "projects.repository.step.settings.change" as never,
                      )}
                    </UI.Button>
                  )}
              >
                {active === null && phone ? choose : undefined}
              </UI.StepItem>
              <UI.StepItem
                data-testid="setup-check"
                status="upcoming"
                statusLabel={status("todo")}
                title={translate(
                  "projects.repository.step.check.title" as never,
                )}
                summary={translate(
                  (active === null
                    ? "projects.repository.step.check.blocked"
                    : "projects.repository.step.check.todo") as never,
                )}
                action={active === null ? undefined : (
                  <UI.Button
                    variant="text"
                    onClick={() =>
                      void navigate({
                        to: "/projects/onboarding",
                        search: {
                          application: current.applicationId,
                          repository: current.id,
                          profile: undefined,
                        },
                      })}
                  >
                    {translate("projects.repository.step.check.open" as never)}
                  </UI.Button>
                )}
              />
            </UI.StepList>
          </UI.ListSection>
          <UI.Text variant="muted">
            {translate("projects.repository.setup.footnote" as never)}
          </UI.Text>
        </UI.Stack>
        {sheet
          ? (
            <WorkingSettingsSheet
              repository={current}
              profiles={profiles.items}
              active={active}
              canManage={canManage}
              offline={offline}
              onClose={closeSheet}
            />
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}
