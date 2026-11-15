import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  RepositoryResponse,
  RoleBindingResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { repositoryRolesListQueryOptions } from "../../api/query.ts";
import { focusAfterPaint } from "../../app/focus.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { useCursorPages } from "../projects-onboarding/useCursorPages.ts";
import { NamesSheet } from "./NamesSheet.tsx";
import { isActive, namesOf } from "./names-state.ts";

/**
 * The names that point at one repository (design-ux, #65): a short card, and a
 * sheet to change them. A name tells agents which repository is meant; it
 * gives no access, and the card says so.
 */
export function NamesCard(
  { repository, canManage }: Readonly<{
    repository: RepositoryResponse;
    canManage: boolean;
  }>,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const query = useQuery({
    ...repositoryRolesListQueryOptions(api, scope, repository.applicationId, {
      limit: 100,
    }),
    enabled: scope.organizationId !== null,
  });
  const roles = useCursorPages<RoleBindingResponse>(
    query,
    `${scope.sessionGeneration}:${
      scope.organizationId ?? "none"
    }:${repository.applicationId}`,
    useCallback((cursor) =>
      queryClient.fetchQuery(
        repositoryRolesListQueryOptions(api, scope, repository.applicationId, {
          cursor,
          limit: 100,
        }),
      ), [api, queryClient, scope, repository.applicationId]),
  );
  // Read every page, so a repository's names are all there.
  const { hasNext, loadingMore, moreError, loadMore } = roles;
  useEffect(() => {
    if (hasNext && !loadingMore && !moreError) loadMore();
  }, [hasNext, loadingMore, moreError, loadMore]);

  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const show = () => {
    opener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    focusAfterPaint(() => opener.current);
  };

  const names = namesOf(roles.items, repository.id);
  const active = names.filter(isActive);
  const archived = repository.archivedAt !== null;

  return (
    <UI.ListSection
      flush
      data-testid="repository-names"
      title={translate("projects.repository.names.title" as never)}
      description={translate("projects.repository.names.intro" as never)}
      variant="list"
    >
      {roles.state === "loading"
        ? (
          <UI.Text variant="muted" role="status">
            {translate("projects.repository.names.loading" as never)}
          </UI.Text>
        )
        : roles.state === "error"
        ? (
          <UI.InlineNotice tone="error" role="alert">
            {translate("projects.repository.names.error" as never)}{" "}
            <UI.Button variant="text" onClick={() => void query.refetch()}>
              {translate("projects.repository.names.retry" as never)}
            </UI.Button>
          </UI.InlineNotice>
        )
        : (
          <UI.Stack gap="compact">
            {active.length === 0
              ? (
                <UI.Text variant="muted">
                  {translate("projects.repository.names.empty" as never)}
                </UI.Text>
              )
              : (
                <UI.Stack
                  gap="compact"
                  role="list"
                  aria-label={translate(
                    "projects.repository.names.listLabel" as never,
                  )}
                >
                  {active.map((binding) => (
                    <div
                      key={binding.id}
                      role="listitem"
                      data-testid={`name-${binding.role}`}
                    >
                      <UI.Stack gap="tight">
                        <UI.Text>{binding.role}</UI.Text>
                        {binding.alias === null
                          ? null
                          : (
                            <UI.Text variant="muted">
                              {translate(
                                "projects.repository.names.also" as never,
                                { others: binding.alias },
                              )}
                            </UI.Text>
                          )}
                      </UI.Stack>
                    </div>
                  ))}
                </UI.Stack>
              )}
            {canManage && !archived
              ? (
                <UI.Inline gap="compact">
                  <UI.Button variant="secondary" onClick={show}>
                    {translate(
                      (active.length === 0
                        ? "projects.repository.names.add"
                        : "projects.repository.names.change") as never,
                    )}
                  </UI.Button>
                </UI.Inline>
              )
              : null}
          </UI.Stack>
        )}
      {open
        ? (
          <NamesSheet
            repository={repository}
            names={names}
            canManage={canManage && !archived}
            onClose={close}
          />
        )
        : null}
    </UI.ListSection>
  );
}
