import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { ApplicationResponse, RepositoryResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  connectionRepositoriesQueryOptions,
  effectiveAccessQueryOptions,
  projectApplicationsPagesQueryOptions,
  projectRepositoriesQueryOptions,
} from "../api/query.ts";
import { asyncKindForError, isForbiddenFailure } from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { focusAfterPaint, usePagedFocus } from "../app/focus.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import {
  ApplicationDialog,
  type ApplicationDraft,
} from "./projects/ApplicationDialog.tsx";
import {
  AddRepositoryDialog,
  type AddRepositoryDraft,
} from "./projects/AddRepositoryDialog.tsx";
import { ProjectRows } from "./projects/ProjectRows.tsx";
import {
  candidates as candidatesOf,
  hasArchived,
  sections,
} from "./projects/project-state.ts";
import {
  type ProjectFailure,
  projectFailure,
  useProjectMutations,
} from "./projects/useProjectMutations.ts";

type Dialog =
  | { readonly kind: "add" }
  | {
    readonly kind: "application";
    readonly application: ApplicationResponse | null;
  }
  | { readonly kind: "archive"; readonly application: ApplicationResponse }
  | null;

/**
 * The applications Bakery works for and the repositories in each, with what
 * is missing for a repository named in a sentence and one button on every row.
 * Administrators add applications and repositories here; everyone else reads.
 */
export function ProjectsPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const offline = useConnectivity() === "offline";
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const canManage = access.data?.role === "admin";
  const applications = useInfiniteQuery(
    projectApplicationsPagesQueryOptions(api, scope),
  );
  const repositories = useQuery(projectRepositoriesQueryOptions(api, scope));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [failure, setFailure] = useState<ProjectFailure | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const mutations = useProjectMutations();

  const applicationItems = useMemo(
    () => applications.data?.pages.flatMap((page) => page.items) ?? [],
    [applications.data],
  );
  const repositoryItems = repositories.data?.items ?? [];
  const groups = sections(applicationItems, repositoryItems, showArchived);
  const empty = applications.isSuccess && applicationItems.length === 0 &&
    repositories.isSuccess && repositoryItems.length === 0;
  // The connection is read when the dialog opens, and on an empty list to say
  // whether GitHub is connected at all.
  const connection = useQuery(
    connectionRepositoriesQueryOptions(
      api,
      scope,
      canManage && (dialog?.kind === "add" || empty),
    ),
  );
  const candidates = useMemo(
    () => candidatesOf(connection.data?.resources ?? [], repositoryItems),
    [connection.data, repositoryItems],
  );
  const githubConnected = (connection.data?.connections.length ?? 0) > 0;

  const paging = usePagedFocus("projects", {
    pending: applications.isFetchingNextPage,
    failed: applications.isFetchNextPageError,
    rowCount: applicationItems.length,
    hasMore: Boolean(applications.hasNextPage),
  });
  useEffect(() => setShowArchived(false), [scope.organizationId]);

  const open = (next: Dialog) => {
    opener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setFailure(null);
    setDialog(next);
  };
  const close = () => {
    setDialog(null);
    focusAfterPaint(() => opener.current);
  };
  const openRepository = (repository: RepositoryResponse) =>
    void navigate({
      to: "/projects/onboarding",
      search: {
        application: repository.applicationId,
        repository: repository.id,
        profile: undefined,
      },
    });

  const addRepository = async (draft: AddRepositoryDraft) => {
    setFailure(null);
    try {
      const applicationId = "id" in draft.application
        ? draft.application.id
        : (await mutations.createApplication.mutateAsync({
          slug: draft.application.create.slug,
          name: draft.application.create.name,
          description: "",
        })).id;
      const created = await mutations.createRepository.mutateAsync({
        applicationId,
        slug: draft.slug,
        integrationConnectionId: draft.candidate.resource.connectionId,
        providerRepoId: draft.candidate.resource.externalId,
        owner: draft.candidate.owner,
        name: draft.candidate.name,
        defaultBranch: draft.branch,
      });
      setDialog(null);
      // Its own page, at the first step left to do.
      openRepository(created);
    } catch (error) {
      setFailure(projectFailure(error));
    }
  };
  const saveApplication = async (
    application: ApplicationResponse | null,
    draft: ApplicationDraft,
  ) => {
    setFailure(null);
    try {
      if (application === null) {
        await mutations.createApplication.mutateAsync({
          slug: draft.slug,
          name: draft.name,
          description: draft.description,
        });
      } else {
        await mutations.updateApplication.mutateAsync({
          application,
          input: { name: draft.name },
        });
      }
      close();
    } catch (error) {
      setFailure(projectFailure(error));
    }
  };
  const archive = async (
    application: ApplicationResponse,
    restore: boolean,
  ) => {
    setFailure(null);
    try {
      await mutations.updateApplication.mutateAsync({
        application,
        input: { archivedAt: restore ? null : new Date().toISOString() },
      });
      if (!restore) close();
    } catch (error) {
      setFailure(projectFailure(error));
    }
  };

  const forbidden = (applications.isError &&
    isForbiddenFailure(applications.error)) ||
    (repositories.isError && isForbiddenFailure(repositories.error));
  // A failed "Load more" keeps the applications already shown; a failed read
  // of the repositories is never shown as "no repositories".
  const applicationsFailed = applications.isError &&
    applicationItems.length === 0;
  const repositoriesFailed = repositories.isError &&
    repositories.data === undefined;
  const loadOffline = (applicationsFailed || repositoriesFailed) &&
    asyncKindForError(
        applicationsFailed ? applications.error : repositories.error,
      ) === "offline";
  const loadFailed = !forbidden && (applicationsFailed || repositoriesFailed);
  const loading = applications.isPending || repositories.isPending;

  const addButton = canManage
    ? (
      <UI.Button
        variant="primary"
        disabled={offline}
        onClick={() => open({ kind: "add" })}
      >
        {translate("projects.list.add.button" as never)}
      </UI.Button>
    )
    : null;
  const newApplicationButton = canManage
    ? (
      <UI.Button
        variant="secondary"
        disabled={offline}
        onClick={() => open({ kind: "application", application: null })}
      >
        {translate("projects.list.application.new" as never)}
      </UI.Button>
    )
    : null;

  return (
    <>
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            {
              href: WORK_HOME,
              label: translate("shell.navigation.workspace"),
            },
            { label: translate("projects.list.title" as never) },
          ]}
        />
      </ShellSlot>
      {!phone && canManage && !empty
        ? (
          <ShellSlot name="actions">
            <UI.Inline gap="compact">
              {newApplicationButton}
              {addButton}
            </UI.Inline>
          </ShellSlot>
        )
        : null}
      <UI.SettingsContent data-testid="projects-page" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("projects.list.title" as never)}
          subtitle={translate("projects.list.description" as never)}
          actions={phone && canManage && !empty
            ? (
              <UI.Stack gap="compact">
                {addButton}
                {newApplicationButton}
              </UI.Stack>
            )
            : null}
        />
        {offline
          ? (
            <UI.InlineNotice tone="information">
              {translate("projects.list.offline" as never)}
            </UI.InlineNotice>
          )
          : null}
        {forbidden
          ? (
            <UI.EmptyState
              title={translate("projects.list.forbidden.title" as never)}
              description={translate(
                "projects.list.forbidden.description" as never,
              )}
              variant="firstUse"
            />
          )
          : loading
          ? (
            <UI.Stack gap="standard" aria-busy="true">
              <UI.Text variant="muted" role="status">
                {translate("projects.list.loading" as never)}
              </UI.Text>
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
            </UI.Stack>
          )
          : loadFailed
          ? (
            <UI.ErrorState
              title={translate(
                (loadOffline
                  ? "projects.list.offlineTitle"
                  : "projects.list.error.title") as never,
              )}
              description={translate(
                (loadOffline
                  ? "projects.list.offlineDescription"
                  : "projects.list.error.description") as never,
              )}
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => {
                    void applications.refetch();
                    void repositories.refetch();
                  }}
                >
                  {translate("projects.list.retry" as never)}
                </UI.Button>
              }
            />
          )
          : empty
          ? connection.isSuccess && !githubConnected
            ? (
              <UI.EmptyState
                title={translate("projects.list.empty.noGithub.title" as never)}
                description={translate(
                  (canManage
                    ? "projects.list.empty.noGithub.description"
                    : "projects.list.empty.adminOnly") as never,
                )}
                action={canManage
                  ? (
                    <UI.Button
                      variant="secondary"
                      onClick={() =>
                        void navigate({
                          to: "/settings/organization/integrations",
                        })}
                    >
                      {translate("projects.list.openIntegrations" as never)}
                    </UI.Button>
                  )
                  : undefined}
                variant="firstUse"
              />
            )
            : (
              <UI.EmptyState
                title={translate("projects.list.empty.title" as never)}
                description={translate(
                  (canManage
                    ? "projects.list.empty.description"
                    : "projects.list.empty.adminOnly") as never,
                )}
                action={addButton ?? undefined}
                variant="firstUse"
              />
            )
          : (
            <UI.Stack gap="spacious" data-paged-list="projects">
              {repositories.data?.truncated
                ? (
                  <UI.InlineNotice tone="warning">
                    {translate("projects.list.truncated" as never)}
                  </UI.InlineNotice>
                )
                : null}
              {groups.map((
                { application, hiddenArchived, repositories: own },
              ) => (
                <div key={application.id} data-application-id={application.id}>
                  <UI.Stack gap="compact">
                    <UI.Inline variant="between" data-trailing-popover="">
                      <UI.Stack gap="tight">
                        <UI.Heading level="section">
                          {application.name}
                          {application.archivedAt !== null
                            ? (
                              <>
                                {" "}
                                <UI.Badge tone="neutral">
                                  {translate(
                                    "projects.list.badge.archived" as never,
                                  )}
                                </UI.Badge>
                              </>
                            )
                            : null}
                        </UI.Heading>
                        <UI.Text variant="muted">
                          {[
                            application.description,
                            translate(
                              "projects.list.application.count" as never,
                              {
                                count: own.length,
                              },
                            ),
                          ].filter((part) =>
                            part !== ""
                          ).join(" · ")}
                        </UI.Text>
                      </UI.Stack>
                      {canManage
                        ? (
                          <UI.Popover
                            label={translate(
                              "projects.list.application.moreNamed" as never,
                              { application: application.name },
                            )}
                            variant="interactive"
                            triggerAppearance="toolbar"
                            trigger={
                              <>
                                {translate(
                                  "projects.list.application.more" as never,
                                )}
                                <UI.VisuallyHidden>
                                  {translate(
                                    "projects.list.application.moreAbout" as never,
                                    { application: application.name },
                                  )}
                                </UI.VisuallyHidden>
                              </>
                            }
                          >
                            <UI.Menu
                              aria-label={translate(
                                "projects.list.application.moreNamed" as never,
                                { application: application.name },
                              )}
                              items={[
                                {
                                  id: "rename",
                                  label: translate(
                                    "projects.list.application.rename" as never,
                                  ),
                                  disabled: offline,
                                },
                                {
                                  id: application.archivedAt === null
                                    ? "archive"
                                    : "restore",
                                  label: translate(
                                    (application.archivedAt === null
                                      ? "projects.list.application.archive"
                                      : "projects.list.application.restore") as never,
                                  ),
                                  disabled: offline,
                                },
                              ]}
                              onSelect={(id) => {
                                if (id === "rename") {
                                  open({ kind: "application", application });
                                } else if (id === "archive") {
                                  open({ kind: "archive", application });
                                } else void archive(application, true);
                              }}
                            />
                          </UI.Popover>
                        )
                        : null}
                    </UI.Inline>
                    {own.length > 0
                      ? (
                        <ProjectRows
                          applicationName={application.name}
                          onOpen={openRepository}
                          phone={phone}
                          repositories={own}
                          translate={translate}
                        />
                      )
                      : (
                        <UI.Text variant="muted">
                          {translate(
                            (hiddenArchived > 0
                              ? "projects.list.application.onlyArchived"
                              : "projects.list.application.noRepositories") as never,
                          )}
                        </UI.Text>
                      )}
                  </UI.Stack>
                </div>
              ))}
              {applications.isFetchNextPageError
                ? (
                  <UI.AlertBanner tone="error">
                    {translate("projects.list.pagination.error" as never)}
                  </UI.AlertBanner>
                )
                : null}
              {applications.hasNextPage
                ? (
                  <UI.Button
                    variant="secondary"
                    data-paged-more="projects"
                    data-paged-retry={applications.isFetchNextPageError
                      ? "projects"
                      : undefined}
                    disabled={applications.isFetchingNextPage}
                    onClick={() => {
                      paging.ask("more", applicationItems.length);
                      void applications.fetchNextPage();
                    }}
                  >
                    {applications.isFetchingNextPage
                      ? translate(
                        "projects.list.pagination.loadingMore" as never,
                      )
                      : applications.isFetchNextPageError
                      ? translate("projects.list.retry" as never)
                      : translate("projects.list.pagination.loadMore" as never)}
                  </UI.Button>
                )
                : null}
              {hasArchived(applicationItems, repositoryItems)
                ? (
                  <UI.Button
                    variant="quiet"
                    aria-pressed={showArchived}
                    onClick={() => setShowArchived(!showArchived)}
                  >
                    {translate(
                      (showArchived
                        ? "projects.list.archived.hide"
                        : "projects.list.archived.show") as never,
                    )}
                  </UI.Button>
                )
                : null}
            </UI.Stack>
          )}
      </UI.SettingsContent>
      {dialog?.kind === "add"
        ? (
          <AddRepositoryDialog
            applications={applicationItems}
            candidates={candidates}
            failure={failure}
            loadFailed={connection.isError}
            loading={connection.isPending}
            pending={mutations.createRepository.isPending ||
              mutations.createApplication.isPending}
            onClose={close}
            onSubmit={(draft) => void addRepository(draft)}
          />
        )
        : null}
      {dialog?.kind === "application"
        ? (
          <ApplicationDialog
            application={dialog.application}
            failure={failure}
            pending={mutations.createApplication.isPending ||
              mutations.updateApplication.isPending}
            onClose={close}
            onSubmit={(draft) =>
              void saveApplication(dialog.application, draft)}
          />
        )
        : null}
      {dialog?.kind === "archive"
        ? (
          <UI.AlertDialog
            open
            onOpenChange={(openState) => !openState && close()}
            state={mutations.updateApplication.isPending
              ? "confirming"
              : "open"}
            title={translate("projects.list.archiveDialog.title" as never, {
              application: dialog.application.name,
            })}
            cancelAction={
              <UI.Button variant="secondary" onClick={close}>
                {translate("core.actions.cancel" as never)}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="primary"
                disabled={mutations.updateApplication.isPending}
                onClick={() => void archive(dialog.application, false)}
              >
                {translate("projects.list.application.archive" as never)}
              </UI.Button>
            }
          >
            <UI.Stack gap="compact">
              <UI.Text>
                {translate("projects.list.archiveDialog.body" as never)}
              </UI.Text>
              <UI.Text variant="muted">
                {translate("projects.list.archiveDialog.restore" as never)}
              </UI.Text>
              {failure !== null
                ? (
                  <UI.InlineNotice tone="error">
                    {translate(`projects.list.failure.${failure}` as never)}
                  </UI.InlineNotice>
                )
                : null}
            </UI.Stack>
          </UI.AlertDialog>
        )
        : null}
    </>
  );
}
