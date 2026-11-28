import type { MessageArguments, MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  providerRoutesListQueryOptions,
  workerComponentsListQueryOptions,
  workerProviderBindingsListQueryOptions,
  workerQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { MACHINES_HOME, WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { agentRows, paidPerUse } from "./machine-agents.ts";
import {
  agentChoosable,
  createRefusal,
  type DraftError,
  type DraftField,
  EMPTY_DRAFT,
  type ModelDraft,
  validateDraft,
} from "./machine-models.ts";
import { codingAgents } from "./machine-state.ts";

type Say = (key: string, arguments_?: MessageArguments) => string;

/** The value that opens the free-text provider field. */
const ANOTHER_PROVIDER = "__another__";

/**
 * Adding a model to a machine (#70 slice 4): the coding agent that will use it, the model's own
 * details, and how it is paid, which is read from the agent's sign-in and cannot be edited here.
 * A model's details cannot be changed after it is added: that is said before the person saves.
 */
export function MachineModelNewPage(
  { machineId }: { readonly machineId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const say: Say = (key, arguments_) =>
    translate(key as MessageKey, arguments_);
  useRestoreOrganizationScope();
  const worker = useQuery(workerQueryOptions(api, scope, machineId));
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";
  const bindings = useQuery({
    ...workerProviderBindingsListQueryOptions(api, scope, machineId),
    enabled: isAdmin,
  });
  const components = useQuery(
    workerComponentsListQueryOptions(api, scope, machineId),
  );
  const routes = useQuery({
    ...providerRoutesListQueryOptions(api, scope),
    enabled: isAdmin,
  });

  const [draft, setDraft] = useState<ModelDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Partial<Record<DraftField, DraftError>>>(
    {},
  );
  const [failed, setFailed] = useState<"failed" | "changed" | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = agentRows(
    codingAgents(worker.data?.capabilities),
    bindings.data?.items ?? [],
    components.data?.items ?? [],
  );
  // The providers the person can pick: those this machine's sign-ins and the existing models already use.
  const providers = [
    ...new Set([
      ...(bindings.data?.items ?? []).map((binding) => binding.provider),
      ...(routes.data?.items ?? []).map((route) => route.provider),
    ]),
  ].filter((name) => name !== "").sort();
  const other = draft.provider === ANOTHER_PROVIDER;
  const chosen = rows.find((row) => row.agent === draft.agent) ?? null;
  const machineName = worker.data?.name ?? machineId;

  const set = (patch: Partial<ModelDraft>) => {
    setDraft({ ...draft, ...patch });
    setFailed(null);
  };
  const fieldError = (field: DraftField): string | undefined => {
    const error = errors[field];
    return error === undefined
      ? undefined
      : say(`machines.models.new.error.${field === "agent" ? "agent" : error}`);
  };
  const back = () =>
    void navigate({
      to: "/machines/$machineId/models",
      params: { machineId },
      search: {},
    });

  const submit = async () => {
    // "Another provider" sends the typed name; any other choice sends the one picked.
    const result = validateDraft(
      { ...draft, provider: other ? "" : draft.provider },
      rows,
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (!scope.organizationId) return;
    setSaving(true);
    const created = await api.providerRoutes.create({
      organizationId: scope.organizationId,
      input: result.input,
      idempotencyKey: crypto.randomUUID(),
    });
    setSaving(false);
    if (created.ok) {
      await queryClient.invalidateQueries({
        queryKey: [
          "protected",
          scope.sessionGeneration,
          scope.organizationId ?? "none",
          "providerRoutes.list",
        ],
      });
      void navigate({
        to: "/machines/$machineId/models",
        params: { machineId },
        search: { added: true },
      });
      return;
    }
    const refusal = createRefusal(
      created.error.kind === "problem" ? created.error.problem : null,
    );
    if (refusal.kind === "field") {
      setErrors({ [refusal.field]: refusal.error });
    } else {
      setFailed(refusal.kind);
    }
  };

  // Nothing is drawn from a guess: until the role, the machine and (for an administrator) its coding-agent
  // sign-ins are read, the page says it is loading, and when one of them cannot be read it says so, instead
  // of showing every agent as not signed in.
  const unreadable = access.isError || worker.isError ||
    (isAdmin && (bindings.isError || components.isError));
  const reading = access.isPending || worker.isPending ||
    (isAdmin && (bindings.isLoading || components.isLoading));
  const content = unreadable
    ? (
      <UI.ErrorState
        title={say("machines.models.new.loadFailed")}
        description=""
        action={
          <UI.Button
            variant="secondary"
            onClick={() => {
              void access.refetch();
              void worker.refetch();
              if (isAdmin) {
                void bindings.refetch();
                void components.refetch();
              }
            }}
          >
            {say("machines.models.retry")}
          </UI.Button>
        }
      />
    )
    : reading
    ? (
      <UI.AlertBanner tone="information">
        {say("machines.loading")}
      </UI.AlertBanner>
    )
    : !isAdmin
    ? (
      <UI.EmptyState
        span="column"
        title={say("machines.models.new.forbidden")}
        description=""
        action={
          <UI.Button variant="secondary" onClick={back}>
            {say("machines.models.new.back")}
          </UI.Button>
        }
      />
    )
    : (
      <form
        data-testid="machine-model-new"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <UI.Stack gap="spacious">
          <UI.SettingsSection
            title={say("machines.models.new.agentSection")}
            variant="stack"
          >
            <UI.Text variant="muted">
              {say("machines.models.new.agentHelp")}
            </UI.Text>
            <UI.Stack
              gap="compact"
              role="radiogroup"
              aria-label={say("machines.models.new.agentSection")}
            >
              {rows.map((row) => (
                <UI.Stack key={row.agent} gap="compact">
                  <UI.PresetOption
                    name="machine-model-agent"
                    value={row.agent}
                    checked={draft.agent === row.agent}
                    disabled={!agentChoosable(row)}
                    unavailable={!agentChoosable(row)}
                    onChange={() => set({ agent: row.agent })}
                    title={say(`machines.agent.${row.agent}`)}
                    description={agentChoosable(row)
                      ? undefined
                      : say("machines.models.new.agentNotSignedIn")}
                  />
                  {!agentChoosable(row)
                    ? (
                      <UI.Inline variant="flow">
                        <UI.Button
                          variant="secondary"
                          onClick={() =>
                            void navigate({
                              to: "/machines/$machineId",
                              params: { machineId },
                              search: { signIn: row.agent },
                            })}
                        >
                          {say("machines.models.new.signInAgent", {
                            agent: say(`machines.agent.${row.agent}`),
                          })}
                        </UI.Button>
                      </UI.Inline>
                    )
                    : null}
                </UI.Stack>
              ))}
            </UI.Stack>
            {errors.agent
              ? (
                <UI.Text variant="error" role="alert">
                  {fieldError("agent")}
                </UI.Text>
              )
              : null}
          </UI.SettingsSection>
          <UI.SettingsSection
            title={say("machines.models.new.modelSection")}
            variant="stack"
          >
            <UI.Combobox
              id="machine-model-provider"
              width="short"
              label={say("machines.models.new.provider")}
              required
              error={errors.provider && !other
                ? fieldError("provider")
                : undefined}
              value={draft.provider}
              onChange={(event) => set({ provider: event.target.value })}
              options={[
                { value: "", label: "" },
                ...providers.map((name) => ({ value: name, label: name })),
                {
                  value: ANOTHER_PROVIDER,
                  label: say("machines.models.new.anotherProvider"),
                },
              ]}
            />
            {other
              ? (
                <UI.Field
                  width="short"
                  label={say("machines.models.new.providerName")}
                  htmlFor="machine-model-provider-name"
                  error={fieldError("provider")}
                  required
                >
                  <UI.TextInput
                    id="machine-model-provider-name"
                    name="providerName"
                    type="text"
                    autoComplete="off"
                    invalid={errors.provider !== undefined}
                    value={draft.otherProvider}
                    onChange={(otherProvider) => set({ otherProvider })}
                  />
                </UI.Field>
              )
              : null}
            <UI.Field
              width="short"
              label={say("machines.models.new.model")}
              hint={say("machines.models.new.modelHelp")}
              htmlFor="machine-model-name"
              error={fieldError("model")}
              required
            >
              <UI.TextInput
                id="machine-model-name"
                name="model"
                type="text"
                autoComplete="off"
                invalid={errors.model !== undefined}
                value={draft.model}
                onChange={(model) => set({ model })}
              />
            </UI.Field>
            <UI.Field
              label={say("machines.models.new.endpoint")}
              htmlFor="machine-model-endpoint"
              error={fieldError("endpoint")}
              required
            >
              <UI.TextInput
                id="machine-model-endpoint"
                name="endpoint"
                type="text"
                autoComplete="off"
                inputMode="url"
                invalid={errors.endpoint !== undefined}
                value={draft.endpoint}
                onChange={(endpoint) => set({ endpoint })}
              />
            </UI.Field>
            <UI.Field
              width="short"
              label={say("machines.models.new.region")}
              hint={say("machines.models.new.regionHelp")}
              htmlFor="machine-model-region"
              error={fieldError("region")}
            >
              <UI.TextInput
                id="machine-model-region"
                name="region"
                type="text"
                autoComplete="off"
                invalid={errors.region !== undefined}
                value={draft.region}
                onChange={(region) => set({ region })}
              />
            </UI.Field>
          </UI.SettingsSection>
          <UI.SettingsSection
            title={say("machines.models.new.paidSection")}
            variant="stack"
          >
            {chosen === null ? null : (
              <UI.Text>
                {say(
                  paidPerUse(chosen)
                    ? "machines.agents.paidPerUse"
                    : "machines.models.new.paidBySubscription",
                  { agent: say(`machines.agent.${chosen.agent}`) },
                )}
              </UI.Text>
            )}
            {(chosen === null ? rows.some(paidPerUse) : paidPerUse(chosen))
              ? null
              : (
                <UI.Text variant="muted">
                  {say("machines.agents.apiKeyLater")}
                </UI.Text>
              )}
          </UI.SettingsSection>
          <UI.InlineNotice tone="information">
            {say("machines.models.new.fixedNotice")}
          </UI.InlineNotice>
          {failed === "failed"
            ? (
              <UI.InlineNotice tone="error" role="alert">
                {say("machines.models.new.failed")}
              </UI.InlineNotice>
            )
            : failed === "changed"
            ? (
              <UI.InlineNotice tone="warning" role="status">
                {say("machines.models.new.changed")}
              </UI.InlineNotice>
            )
            : null}
          <UI.Inline variant="end">
            <UI.Button variant="secondary" onClick={back}>
              {say("machines.models.new.cancel")}
            </UI.Button>
            <UI.Button variant="primary" type="submit" loading={saving}>
              {saving
                ? say("machines.models.new.submitting")
                : say("machines.models.new.submit")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    );

  return (
    <>
      <ShellActiveNavigation id="machines" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={say("shell.navigation.breadcrumb")}
          items={[
            { href: WORK_HOME, label: say("shell.navigation.workspace") },
            { href: MACHINES_HOME, label: say("shell.navigation.machines") },
            { href: `${MACHINES_HOME}/${machineId}`, label: machineName },
            { label: say("machines.models.new.title") },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="machine-model-new-page" variant="form">
        <UI.PageHeader
          flush
          variant="list"
          title={say("machines.models.new.title")}
        />
        {isAdmin
          ? (
            <UI.Text variant="muted">
              {say("machines.models.new.intro")}
            </UI.Text>
          )
          : null}
        {content}
      </UI.SettingsContent>
    </>
  );
}
