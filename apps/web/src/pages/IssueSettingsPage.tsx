import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  TicketSourcePersonResponse,
  TicketSourceResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  ticketSourceQueryOptions,
} from "../api/query.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { LeaveGuard } from "./repository-rules/leave-guard.tsx";
import {
  automaticSinceOf,
  badgeOf,
  countsOf,
  formOf,
  isDirty,
  isSavable,
  policyOfForm,
  problemsOf,
  type SettingsForm,
} from "./issues/settings-model.ts";

/** The pages that share one repository's draft. */
const SETTINGS_PATH = "/issues/settings";

/** How many issues the preview reads in one go; the counts rest on these. */
const PREVIEW_ISSUES = 100;

const emptyPerson = (login: string): string => login.trim();

/**
 * One repository's issue settings (#69, slice 1): the switch that takes
 * issues at all, the three labels, what must be true before work starts, how
 * automatic starts are delegated, the read-only workflow, and what the saved
 * settings would count right now.
 *
 * The preview reads the *saved* settings: `ticketSources.preview` evaluates
 * the stored policy and records readiness, so the section asks for the saved
 * settings by name and offers the button only when the draft is saved. The
 * counts then come from one read of the saved issues, and they say when they
 * were read, because an issue's verdict is the last one taken.
 */
export function IssueSettingsPage({ sourceId }: { sourceId: string }) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const offline = useConnectivity() === "offline";
  const id = useId();
  const source = useQuery(ticketSourceQueryOptions(api, scope, sourceId));
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";
  const principals = useQuery({
    queryKey: protectedQueryKey(scope, "principals.list", {}),
    queryFn: async ({ signal }) => {
      const result = await api.principals.list({
        organizationId: scope.organizationId ?? "",
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    enabled: Boolean(scope.organizationId),
    retry: false,
  });

  const saved: TicketSourceResponse | null = source.data ?? null;
  const [draft, setDraft] = useState<SettingsForm | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [previewCounts, setPreviewCounts] = useState<
    ReturnType<
      typeof countsOf
    > | null
  >(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [personLogin, setPersonLogin] = useState("");
  const [personProblem, setPersonProblem] = useState<
    "notFound" | "cannotTrigger" | null
  >(null);
  const [confirming, setConfirming] = useState(false);
  const [showingIssues, setShowingIssues] = useState(false);

  const shown = draft ?? (saved === null ? null : formOf(saved));
  const dirty = shown !== null && isDirty(shown, saved);
  const problems = shown === null ? {} : problemsOf(shown);
  const savable = shown !== null && isSavable(shown) && dirty;

  const edit = (change: Partial<SettingsForm>) => {
    if (shown === null) return;
    setDraft({ ...shown, ...change });
    setSavedNotice(false);
    setConflict(false);
  };

  const save = useMutation({
    mutationFn: async (form: SettingsForm) => {
      if (saved === null) throw new Error("no source");
      const result = await api.tickets.updateSource({
        organizationId: scope.organizationId ?? "",
        id: saved.id,
        input: { enabled: form.enabled, policy: policyOfForm(form) },
        version: saved.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(
        ticketSourceQueryOptions(api, scope, sourceId).queryKey,
        updated,
      );
      setDraft(null);
      setSavedNotice(true);
      setConflict(false);
      setPreviewCounts(null);
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
    onError: (error) => {
      const status = (error as { problem?: { status?: number } })?.problem
        ?.status;
      setConflict(status === 409 || status === 412);
    },
  });

  const preview = useMutation({
    mutationFn: async () => {
      const receipt = await api.tickets.preview({
        organizationId: scope.organizationId ?? "",
        sourceId,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!receipt.ok) throw receipt.error;
      const issues = await api.tickets.list({
        organizationId: scope.organizationId ?? "",
        sourceId,
        limit: PREVIEW_ISSUES,
      });
      if (!issues.ok) throw issues.error;
      return countsOf(issues.data.items);
    },
    onSuccess: (counts) => {
      setPreviewCounts(counts);
      setPreviewFailed(false);
    },
    onError: () => {
      setPreviewCounts(null);
      setPreviewFailed(true);
    },
  });

  const lookup = useMutation({
    mutationFn: async (login: string) => {
      const result = await api.tickets.lookupPerson({
        organizationId: scope.organizationId ?? "",
        sourceId,
        login,
      });
      if (!result.ok) throw result.error;
      return result.data as TicketSourcePersonResponse;
    },
    onSuccess: (person) => {
      if (!person.canTrigger) {
        setPersonProblem("cannotTrigger");
        return;
      }
      if (shown === null) return;
      setPersonProblem(null);
      setPersonLogin("");
      edit({
        people: [
          ...shown.people,
          { id: person.externalUserId, login: person.login },
        ],
      });
    },
    onError: (error) => {
      const status = (error as { problem?: { status?: number } })?.problem
        ?.status;
      setPersonProblem(status === 404 ? "notFound" : "cannotTrigger");
    },
  });

  const members = useMemo(
    () =>
      (principals.data?.items ?? []).map((member) => ({
        label: member.displayName,
        value: member.id,
      })),
    [principals.data],
  );

  const since = automaticSinceOf(saved);
  const badge = badgeOf(saved);
  const labelsDisabled = !isAdmin || save.isPending;

  return (
    <>
      <UI.Stack gap="spacious" data-testid="issue-settings-page">
        <UI.PageHeader
          flush
          title={translate("issues.settings.page.title")}
          subtitle={translate("issues.settings.page.subtitle")}
          variant="titled"
        />
        {isAdmin === false
          ? (
            <UI.InlineNotice tone="information">
              {translate("issues.settings.adminOnly")}
            </UI.InlineNotice>
          )
          : null}
        {source.isPending
          ? <UI.Skeleton shape="surface" />
          : source.isError
          ? (
            <UI.ErrorState
              title={translate("issues.settings.page.error.title")}
              description={translate("issues.settings.page.error.description")}
              action={
                <UI.Button
                  onClick={() => void source.refetch()}
                  type="button"
                  variant="secondary"
                >
                  {translate("issues.settings.page.error.retry")}
                </UI.Button>
              }
            />
          )
          : shown === null || saved === null
          ? (
            <UI.EmptyState
              title={translate("issues.settings.page.missing.title")}
              description={translate(
                "issues.settings.page.missing.description",
              )}
              action={
                <UI.Button
                  onClick={() => void navigate({ to: SETTINGS_PATH })}
                  type="button"
                  variant="secondary"
                >
                  {translate("issues.settings.page.missing.back")}
                </UI.Button>
              }
              variant="firstUse"
            />
          )
          : (
            <>
              {savedNotice
                ? (
                  <UI.AlertBanner tone="success">
                    {translate("issues.settings.saved")}
                  </UI.AlertBanner>
                )
                : null}
              {conflict
                ? (
                  <UI.InlineNotice
                    tone="error"
                    action={
                      <UI.Button
                        onClick={() => void source.refetch()}
                        type="button"
                        variant="secondary"
                      >
                        {translate("issues.settings.conflict.reload")}
                      </UI.Button>
                    }
                  >
                    {translate("issues.settings.conflict.body")}
                  </UI.InlineNotice>
                )
                : null}

              <UI.Stack gap="standard" data-testid="issue-settings-taking">
                <UI.Badge
                  tone={badge === "working"
                    ? "success"
                    : badge === "reconnecting"
                    ? "danger"
                    : badge === "trouble"
                    ? "warning"
                    : "neutral"}
                >
                  {translate(`issues.settings.badge.${badge}` as never)}
                </UI.Badge>
                <UI.Switch
                  checked={shown.enabled}
                  disabled={labelsDisabled}
                  onChange={(event) =>
                    edit({ enabled: event.currentTarget.checked })}
                >
                  {translate("issues.settings.taking.label")}
                </UI.Switch>
                <UI.Text variant="muted">
                  {translate(
                    shown.enabled
                      ? "issues.settings.taking.on"
                      : "issues.settings.taking.off",
                  )}
                </UI.Text>
              </UI.Stack>

              <UI.Stack gap="standard" data-testid="issue-settings-labels">
                <UI.Heading level="section">
                  {translate("issues.settings.labels.title")}
                </UI.Heading>
                <UI.Field
                  error={problems.start === undefined ? undefined : translate(
                    `issues.settings.labels.problem.${problems.start}` as never,
                  )}
                  hint={translate("issues.settings.labels.start.hint")}
                  htmlFor={`${id}-start`}
                  label={translate("issues.settings.labels.start")}
                  required
                  state={problems.start === undefined ? "default" : "invalid"}
                >
                  <UI.TextInput
                    autoComplete="off"
                    disabled={labelsDisabled}
                    id={`${id}-start`}
                    invalid={problems.start !== undefined}
                    name="startLabel"
                    onChange={(value) => edit({ start: value.slice(0, 50) })}
                    type="text"
                    value={shown.start}
                  />
                </UI.Field>
                <UI.Checkbox
                  checked={shown.planOnly}
                  disabled={labelsDisabled}
                  onChange={(event) =>
                    edit({ planOnly: event.currentTarget.checked })}
                >
                  {translate("issues.settings.labels.planOnly.use")}
                </UI.Checkbox>
                {shown.planOnly
                  ? (
                    <UI.Field
                      error={problems.planOnlyLabel === undefined
                        ? undefined
                        : translate(
                          `issues.settings.labels.problem.${problems.planOnlyLabel}` as never,
                        )}
                      hint={translate("issues.settings.labels.planOnly.hint")}
                      htmlFor={`${id}-plan-only`}
                      label={translate("issues.settings.labels.planOnly")}
                      note={translate("issues.settings.labels.optional")}
                      state={problems.planOnlyLabel === undefined
                        ? "default"
                        : "invalid"}
                    >
                      <UI.TextInput
                        autoComplete="off"
                        disabled={labelsDisabled}
                        id={`${id}-plan-only`}
                        invalid={problems.planOnlyLabel !== undefined}
                        name="planOnlyLabel"
                        onChange={(value) =>
                          edit({ planOnlyLabel: value.slice(0, 50) })}
                        type="text"
                        value={shown.planOnlyLabel}
                      />
                    </UI.Field>
                  )
                  : null}
                <UI.Field
                  error={problems.hold === undefined ? undefined : translate(
                    `issues.settings.labels.problem.${problems.hold}` as never,
                  )}
                  hint={translate("issues.settings.labels.hold.hint")}
                  htmlFor={`${id}-hold`}
                  label={translate("issues.settings.labels.hold")}
                  required
                  state={problems.hold === undefined ? "default" : "invalid"}
                >
                  <UI.TextInput
                    autoComplete="off"
                    disabled={labelsDisabled}
                    id={`${id}-hold`}
                    invalid={problems.hold !== undefined}
                    name="holdLabel"
                    onChange={(value) => edit({ hold: value.slice(0, 50) })}
                    type="text"
                    value={shown.hold}
                  />
                </UI.Field>
                {problems.sameLabels
                  ? (
                    <UI.Text role="alert" variant="muted">
                      {translate("issues.settings.labels.same")}
                    </UI.Text>
                  )
                  : null}
                <UI.Text variant="muted">
                  {translate("issues.settings.labels.plainText")}
                </UI.Text>
              </UI.Stack>

              <UI.Stack gap="standard" data-testid="issue-settings-before">
                <UI.Heading level="section">
                  {translate("issues.settings.before.title")}
                </UI.Heading>
                <UI.Checkbox
                  checked={shown.requireAcceptanceCriteria}
                  disabled={labelsDisabled}
                  onChange={(event) =>
                    edit({
                      requireAcceptanceCriteria: event.currentTarget.checked,
                    })}
                >
                  {translate("issues.settings.before.criteria")}
                </UI.Checkbox>
                <UI.Text variant="muted">
                  {translate("issues.settings.before.criteria.hint")}
                </UI.Text>
                <UI.Stack gap="compact" role="radiogroup">
                  <UI.PresetOption
                    checked={shown.approval === "human_approval"}
                    description={translate(
                      "issues.settings.before.human.description",
                    )}
                    disabled={labelsDisabled}
                    name={`${id}-approval`}
                    onChange={() => edit({ approval: "human_approval" })}
                    title={translate("issues.settings.before.human")}
                  />
                  <UI.PresetOption
                    checked={shown.approval === "automatic"}
                    description={translate(
                      "issues.settings.before.automatic.description",
                    )}
                    disabled={labelsDisabled}
                    name={`${id}-approval`}
                    onChange={() => edit({ approval: "automatic" })}
                    title={translate("issues.settings.before.automatic")}
                  />
                </UI.Stack>
              </UI.Stack>

              <UI.Stack gap="standard" data-testid="issue-settings-automatic">
                <UI.Heading level="section">
                  {translate("issues.settings.automatic.title")}
                </UI.Heading>
                <UI.Switch
                  checked={shown.automatic}
                  disabled={labelsDisabled}
                  onChange={(event) => {
                    if (event.currentTarget.checked) {
                      setConfirming(true);
                      return;
                    }
                    edit({ automatic: false });
                  }}
                >
                  {translate("issues.settings.automatic.switch", {
                    label: shown.start,
                  })}
                </UI.Switch>
                {shown.automatic
                  ? (
                    <>
                      {since === null
                        ? (
                          <UI.Text variant="muted">
                            {translate("issues.settings.automatic.unsaved")}
                          </UI.Text>
                        )
                        : (
                          <UI.Text variant="muted">
                            {translate("issues.settings.automatic.since", {
                              date: new Date(since).toLocaleDateString(),
                            })}
                          </UI.Text>
                        )}
                      <UI.Stack gap="compact">
                        <UI.Text variant="strong">
                          {translate("issues.settings.automatic.people")}
                        </UI.Text>
                        {shown.people.length === 0
                          ? (
                            <UI.Text variant="muted">
                              {translate(
                                "issues.settings.automatic.people.none",
                              )}
                            </UI.Text>
                          )
                          : (
                            <UI.Inline gap="compact">
                              {shown.people.map((person) => (
                                <UI.Inline gap="compact" key={person.id}>
                                  <UI.Badge>
                                    {person.login ?? person.id}
                                  </UI.Badge>
                                  <UI.IconButton
                                    disabled={labelsDisabled}
                                    label={translate(
                                      "issues.settings.automatic.people.remove",
                                      { login: person.login ?? person.id },
                                    )}
                                    onClick={() =>
                                      edit({
                                        people: shown.people.filter((one) =>
                                          one.id !== person.id
                                        ),
                                      })}
                                  >
                                    ×
                                  </UI.IconButton>
                                </UI.Inline>
                              ))}
                            </UI.Inline>
                          )}
                        <UI.Inline gap="compact" variant="end">
                          <UI.Field
                            htmlFor={`${id}-person`}
                            label={translate(
                              "issues.settings.automatic.people.placeholder",
                            )}
                          >
                            <UI.TextInput
                              autoComplete="off"
                              disabled={labelsDisabled || lookup.isPending}
                              id={`${id}-person`}
                              invalid={personProblem !== null}
                              name="personLogin"
                              onChange={setPersonLogin}
                              type="text"
                              value={personLogin}
                            />
                          </UI.Field>
                          <UI.Button
                            disabled={labelsDisabled || lookup.isPending ||
                              emptyPerson(personLogin) === ""}
                            onClick={() =>
                              lookup.mutate(emptyPerson(personLogin))}
                            type="button"
                            variant="secondary"
                          >
                            {translate("issues.settings.automatic.people.add")}
                          </UI.Button>
                        </UI.Inline>
                        {personProblem === null
                          ? (
                            <UI.Text variant="muted">
                              {translate(
                                "issues.settings.automatic.people.hint",
                              )}
                            </UI.Text>
                          )
                          : (
                            <UI.Text role="alert" variant="muted">
                              {translate(
                                `issues.settings.automatic.people.problem.${personProblem}` as never,
                              )}
                            </UI.Text>
                          )}
                      </UI.Stack>
                      <UI.Combobox
                        disabled={labelsDisabled}
                        label={translate("issues.settings.automatic.runsAs")}
                        onChange={(event) =>
                          edit({ principalId: event.currentTarget.value })}
                        options={members}
                        value={shown.principalId ?? ""}
                      />
                      <UI.Text variant="muted">
                        {translate("issues.settings.automatic.runsAs.hint")}
                      </UI.Text>
                    </>
                  )
                  : null}
              </UI.Stack>

              <UI.Stack gap="compact" data-testid="issue-settings-workflow">
                <UI.Heading level="section">
                  {translate("issues.settings.workflow.title")}
                </UI.Heading>
                <UI.Text>
                  {translate("issues.settings.workflow.standard")}
                </UI.Text>
                <UI.Text variant="muted">
                  {translate("issues.settings.workflow.hint")}
                </UI.Text>
              </UI.Stack>

              <UI.Stack gap="standard" data-testid="issue-settings-preview">
                <UI.Heading level="section">
                  {translate("issues.settings.preview.title")}
                </UI.Heading>
                <UI.Text variant="muted">
                  {dirty
                    ? translate("issues.settings.preview.saveFirst")
                    : translate("issues.settings.preview.saved")}
                </UI.Text>
                <UI.Inline gap="compact">
                  <UI.Button
                    disabled={offline || dirty || preview.isPending}
                    onClick={() => preview.mutate()}
                    type="button"
                    variant="secondary"
                  >
                    {translate("issues.settings.preview.run")}
                  </UI.Button>
                  {previewCounts === null ? null : (
                    <UI.Button
                      onClick={() => setShowingIssues(true)}
                      type="button"
                      variant="outline"
                    >
                      {translate("issues.settings.preview.seeIssues")}
                    </UI.Button>
                  )}
                </UI.Inline>
                {preview.isPending
                  ? <UI.Skeleton shape="row" />
                  : previewFailed
                  ? (
                    <UI.InlineNotice tone="warning">
                      {translate("issues.settings.preview.unavailable")}
                    </UI.InlineNotice>
                  )
                  : previewCounts === null
                  ? null
                  : (
                    <UI.Stack gap="compact">
                      <UI.Inline gap="spacious">
                        <UI.Stack gap="tight">
                          <UI.DataText>
                            {String(previewCounts.canStart)}
                          </UI.DataText>
                          <UI.Text variant="muted">
                            {translate("issues.settings.preview.canStart")}
                          </UI.Text>
                        </UI.Stack>
                        <UI.Stack gap="tight">
                          <UI.DataText>
                            {String(previewCounts.waiting)}
                          </UI.DataText>
                          <UI.Text variant="muted">
                            {translate("issues.settings.preview.waiting")}
                          </UI.Text>
                        </UI.Stack>
                        <UI.Stack gap="tight">
                          <UI.DataText>
                            {String(previewCounts.cannotStart)}
                          </UI.DataText>
                          <UI.Text variant="muted">
                            {translate("issues.settings.preview.cannotStart")}
                          </UI.Text>
                        </UI.Stack>
                      </UI.Inline>
                      <UI.Text variant="muted">
                        {previewCounts.evaluatedAt === null
                          ? translate("issues.settings.preview.neverRead")
                          : translate("issues.settings.preview.readAt", {
                            time: new Date(previewCounts.evaluatedAt)
                              .toLocaleString(),
                          })}
                      </UI.Text>
                      <UI.Text variant="muted">
                        {translate("issues.settings.preview.nothingStarts")}
                      </UI.Text>
                    </UI.Stack>
                  )}
              </UI.Stack>

              {showingIssues && previewCounts !== null
                ? (
                  <UI.Sheet
                    onOpenChange={setShowingIssues}
                    open
                    title={translate("issues.settings.preview.sheetTitle")}
                  >
                    <UI.Stack gap="compact">
                      <UI.Text variant="muted">
                        {translate("issues.settings.preview.sheetBody")}
                      </UI.Text>
                      <UI.Button
                        onClick={() =>
                          void navigate({
                            to: "/issues",
                            search: { choose: undefined },
                          })}
                        type="button"
                        variant="secondary"
                      >
                        {translate("issues.settings.preview.seeIssues")}
                      </UI.Button>
                    </UI.Stack>
                  </UI.Sheet>
                )
                : null}

              {dirty
                ? (
                  <UI.DraftBar
                    detail={translate("issues.settings.draft.detail")}
                    primaryAction={
                      <UI.Button
                        disabled={!savable || offline || save.isPending}
                        onClick={() => save.mutate(shown)}
                        type="button"
                      >
                        {translate("issues.settings.draft.save")}
                      </UI.Button>
                    }
                    secondaryAction={
                      <UI.Button
                        onClick={() => setDraft(null)}
                        type="button"
                        variant="outline"
                      >
                        {translate("issues.settings.draft.discard")}
                      </UI.Button>
                    }
                    summary={translate("issues.settings.draft.summary")}
                  />
                )
                : null}
              <LeaveGuard
                copy={{
                  title: "issues.settings.leave.title",
                  body: "issues.settings.leave.body",
                  stay: "issues.settings.leave.stay",
                  confirm: "issues.settings.leave.confirm",
                }}
                count={dirty ? 1 : 0}
                discard={() => setDraft(null)}
                path={SETTINGS_PATH}
              />
            </>
          )}
      </UI.Stack>
      {confirming && shown !== null
        ? (
          <UI.AlertDialog
            cancelAction={
              <UI.Button
                onClick={() => setConfirming(false)}
                type="button"
                variant="secondary"
              >
                {translate("issues.settings.automatic.confirm.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                onClick={() => {
                  setConfirming(false);
                  edit({ automatic: true });
                }}
                type="button"
                variant="destructive"
              >
                {translate("issues.settings.automatic.confirm.confirm")}
              </UI.Button>
            }
            onOpenChange={(open) => !open && setConfirming(false)}
            open
            title={translate("issues.settings.automatic.confirm.title")}
          >
            <UI.Text>
              {translate("issues.settings.automatic.confirm.body", {
                label: shown.start,
                member: members.find((one) =>
                  one.value === shown.principalId
                )?.label ?? translate("issues.settings.automatic.noMember"),
              })}
            </UI.Text>
          </UI.AlertDialog>
        )
        : null}
    </>
  );
}
