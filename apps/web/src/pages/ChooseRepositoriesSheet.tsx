import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  connectionRepositoriesQueryOptions,
  projectRepositoriesQueryOptions,
  ticketSourcesAllQueryOptions,
} from "../api/query.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  changesOf,
  draftErrors,
  draftOf,
  policyOf,
  type SourceChange,
  type SourceDraft,
  type SourceRow,
  sourceRows,
} from "./issue-sources.ts";

/** What one repository's save did. */
type Outcome = "saved" | "changed" | "failed";

/**
 * Choose where Bakery takes issues from (design-ux, #56): one row per
 * repository Bakery works in, with a switch, and for a repository that is on,
 * the two labels (Start work, On hold). Save makes the changes one repository
 * at a time and says which ones did not go through. Administrators only.
 */
export function ChooseRepositoriesSheet({ onClose }: { onClose: () => void }) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const offline = useConnectivity() === "offline";
  const id = useId();
  const repositories = useQuery(projectRepositoriesQueryOptions(api, scope));
  const connection = useQuery(
    connectionRepositoriesQueryOptions(api, scope, true),
  );
  const sources = useQuery(ticketSourcesAllQueryOptions(api, scope, true));
  const [drafts, setDrafts] = useState<ReadonlyMap<string, SourceDraft>>(
    new Map(),
  );
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(
    new Map(),
  );

  const rows = useMemo(
    () =>
      sourceRows(
        repositories.data?.items ?? [],
        connection.data?.resources ?? [],
        sources.data ?? [],
      ),
    [repositories.data, connection.data, sources.data],
  );
  const draftFor = (row: SourceRow) =>
    drafts.get(row.repository.id) ?? draftOf(row);
  const loading = repositories.isPending || connection.isPending ||
    sources.isPending;
  const loadFailed = repositories.isError || connection.isError ||
    sources.isError;
  const changes = changesOf(rows, drafts);
  const blocked = changes.some((change) =>
    Object.keys(draftErrors(change.draft)).length > 0
  );

  const save = useMutation({
    mutationKey: ["ticketSources.save"],
    mutationFn: async (list: readonly SourceChange[]) => {
      const organizationId = scope.organizationId as string;
      const results = new Map<string, Outcome>();
      for (const change of list) {
        const key = change.row.repository.id;
        try {
          if (change.kind === "create") {
            const result = await api.tickets.createSource({
              organizationId,
              input: {
                connectionId: change.row.resource!.connectionId,
                resourceId: change.row.resource!.id,
                applicationId: change.row.repository.applicationId,
                repositoryId: change.row.repository.id,
                externalContainerId:
                  `${change.row.repository.owner}/${change.row.repository.name}`,
                policy: policyOf(change.draft, null),
              },
              idempotencyKey: crypto.randomUUID(),
            });
            if (!result.ok) throw result.error;
          } else {
            const result = await api.tickets.updateSource({
              organizationId,
              id: change.source.id,
              input: {
                enabled: change.draft.enabled,
                ...(change.draft.enabled
                  ? { policy: policyOf(change.draft, change.source.policy) }
                  : {}),
              },
              version: change.source.version,
              idempotencyKey: crypto.randomUUID(),
            });
            if (!result.ok) throw result.error;
          }
          results.set(key, "saved");
        } catch (error) {
          const status = (error as { problem?: { status?: number } })?.problem
            ?.status;
          results.set(
            key,
            status === 409 || status === 412 ? "changed" : "failed",
          );
        }
      }
      return results;
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
    onSuccess: (results) => {
      setOutcomes(results);
      if ([...results.values()].every((outcome) => outcome === "saved")) {
        onClose();
      } else {
        // What went through is saved; keep what did not, to try again.
        setDrafts((current) => {
          const next = new Map(current);
          for (const [key, outcome] of results) {
            if (outcome === "saved") next.delete(key);
          }
          return next;
        });
      }
    },
  });

  const change = (row: SourceRow, patch: Partial<SourceDraft>) => {
    setOutcomes(new Map());
    setDrafts((current) =>
      new Map(current).set(row.repository.id, { ...draftFor(row), ...patch })
    );
  };

  return (
    <UI.Sheet
      open
      onOpenChange={(open) => !open && !save.isPending && onClose()}
      state={save.isPending ? "submitting" : "open"}
      title={translate("issues.choose.title" as never)}
      variant="side"
    >
      <UI.Stack gap="standard">
        <UI.Text variant="muted">
          {translate("issues.choose.intro" as never)}
        </UI.Text>
        {loading
          ? (
            <UI.Text variant="muted" role="status">
              {translate("issues.choose.loading" as never)}
            </UI.Text>
          )
          : loadFailed
          ? (
            <UI.InlineNotice tone="error">
              {translate("issues.choose.loadFailed" as never)}
            </UI.InlineNotice>
          )
          : rows.length === 0
          ? (
            <UI.Stack gap="compact">
              <UI.Text>{translate("issues.choose.none" as never)}</UI.Text>
              <UI.Button
                variant="secondary"
                onClick={() => void navigate({ to: "/projects" })}
              >
                {translate("issues.choose.openProjects" as never)}
              </UI.Button>
            </UI.Stack>
          )
          : (
            <UI.Stack gap="standard">
              {rows.map((row) => {
                const draft = draftFor(row);
                const errors = draftErrors(draft);
                const name = `${row.repository.owner}/${row.repository.name}`;
                const outcome = outcomes.get(row.repository.id);
                const fieldId = `${id}-${row.repository.id}`;
                return (
                  <UI.Stack gap="compact" key={row.repository.id}>
                    <UI.Heading level="section">{name}</UI.Heading>
                    {row.resource === null
                      ? (
                        <UI.Stack gap="compact">
                          <UI.Text variant="muted">
                            {translate("issues.choose.notOffered" as never)}
                          </UI.Text>
                          <UI.Button
                            variant="quiet"
                            onClick={() =>
                              void navigate({
                                to: "/settings/organization/integrations",
                              })}
                          >
                            {translate(
                              "issues.choose.openIntegrations" as never,
                            )}
                          </UI.Button>
                        </UI.Stack>
                      )
                      : (
                        <UI.Switch
                          checked={draft.enabled}
                          disabled={offline || save.isPending}
                          onChange={(event) =>
                            change(row, { enabled: event.target.checked })}
                        >
                          {translate("issues.choose.switch" as never)}
                        </UI.Switch>
                      )}
                    {draft.enabled && row.resource !== null
                      ? (
                        <UI.Stack gap="compact">
                          <UI.Field
                            label={translate(
                              "issues.choose.startLabel" as never,
                            )}
                            htmlFor={`${fieldId}-start`}
                            required
                            hint={translate("issues.choose.startHelp" as never)}
                            error={errors.start
                              ? translate("issues.choose.labelEmpty" as never)
                              : undefined}
                          >
                            <UI.TextInput
                              id={`${fieldId}-start`}
                              name="startLabel"
                              type="text"
                              autoComplete="off"
                              value={draft.start}
                              invalid={errors.start !== undefined ||
                                errors.same === true}
                              disabled={save.isPending}
                              onChange={(value) =>
                                change(row, { start: value.slice(0, 50) })}
                            />
                          </UI.Field>
                          <UI.Field
                            label={translate(
                              "issues.choose.holdLabel" as never,
                            )}
                            htmlFor={`${fieldId}-hold`}
                            required
                            hint={translate("issues.choose.holdHelp" as never)}
                            error={errors.hold
                              ? translate("issues.choose.labelEmpty" as never)
                              : errors.same
                              ? translate("issues.choose.labelsSame" as never)
                              : undefined}
                          >
                            <UI.TextInput
                              id={`${fieldId}-hold`}
                              name="holdLabel"
                              type="text"
                              autoComplete="off"
                              value={draft.hold}
                              invalid={errors.hold !== undefined ||
                                errors.same === true}
                              disabled={save.isPending}
                              onChange={(value) =>
                                change(row, { hold: value.slice(0, 50) })}
                            />
                          </UI.Field>
                        </UI.Stack>
                      )
                      : null}
                    {outcome === "changed" || outcome === "failed"
                      ? (
                        <UI.InlineNotice tone="error">
                          {translate(
                            (outcome === "changed"
                              ? "issues.choose.changed"
                              : "issues.choose.failed") as never,
                          )}
                        </UI.InlineNotice>
                      )
                      : null}
                  </UI.Stack>
                );
              })}
            </UI.Stack>
          )}
        {offline
          ? (
            <UI.Text variant="caption">
              {translate("issues.card.offline" as never)}
            </UI.Text>
          )
          : null}
        <UI.Inline gap="compact">
          <UI.Button
            variant="secondary"
            disabled={save.isPending}
            onClick={onClose}
          >
            {translate("core.actions.cancel" as never)}
          </UI.Button>
          <UI.Button
            variant="primary"
            disabled={offline || save.isPending || changes.length === 0 ||
              blocked}
            aria-busy={save.isPending || undefined}
            onClick={() => save.mutate(changes)}
          >
            {translate("issues.choose.save" as never)}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    </UI.Sheet>
  );
}
