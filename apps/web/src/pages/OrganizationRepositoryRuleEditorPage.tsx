import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import type { MessageKey, Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import { organizationRepositoryRulesQueryOptions } from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { useRulesDraft } from "./repository-rules/draft.ts";
import { focusAfterPaint } from "./repository-rules/focus.ts";
import { LeaveGuard } from "./repository-rules/leave-guard.tsx";
import {
  blankEntry,
  type FieldError,
  fromForm,
  OPTION_FIELDS,
  type OptionField,
  type OptionForm,
  toForm,
} from "./repository-rules/options.ts";
import {
  isRuleKey,
  RULE_NAME,
  type RuleEntry,
  summarize,
} from "./repository-rules/presentation.ts";
import { useRulesScope } from "./repository-rules/use-rules-scope.ts";

const LIST_PAGE = "/settings/organization/repository-rules";
const MODES = ["guide", "warn", "require"] as const;
/** The fields that carry a hint line under them. */
const FIELDS_WITH_HINT = new Set([
  "types",
  "maxSubjectLength",
  "requiredSections",
  "writingGuidance",
  "allowedNumbers",
  "allowedLiterals",
  "excludedPaths",
  "checkBinding",
]);

/** The translated label of one of a field's fixed choices. */
function choiceLabel(
  translate: Translator,
  fieldId: string,
  value: string,
): string {
  return translate(
    `settings.repositoryRules.editor.option.${fieldId}.${value}` as MessageKey,
  );
}

function OptionInput(
  { error, field, form, onChange, translate }: {
    error: FieldError | undefined;
    field: OptionField;
    form: OptionForm;
    onChange: (id: string, value: string) => void;
    translate: Translator;
  },
) {
  const id = useId();
  const label = translate(
    `settings.repositoryRules.editor.option.${field.id}` as MessageKey,
  );
  const hintKey =
    `settings.repositoryRules.editor.option.${field.id}.hint` as MessageKey;
  const hint = FIELDS_WITH_HINT.has(field.id) ? translate(hintKey) : undefined;
  const value = form[field.id] ?? "";
  const message = error ? translate(error.key, error.values) : undefined;
  // The message has an id so the control can point at it: it is read on focus.
  const messageId = `${id}-error`;
  const shownMessage = message
    ? <span id={messageId}>{message}</span>
    : undefined;

  if (field.kind === "choice") {
    return (
      <UI.Stack gap="tight">
        <UI.Text>{label}</UI.Text>
        <UI.SegmentedControl
          aria-label={label}
          name={field.id}
          onChange={(next) => onChange(field.id, next)}
          options={field.values.map((choice) => ({
            label: choiceLabel(translate, field.id, choice),
            value: choice,
          }))}
          value={value}
        />
      </UI.Stack>
    );
  }
  if (field.kind === "text" && field.multiline) {
    return (
      <UI.Field
        error={shownMessage}
        hint={hint}
        htmlFor={id}
        label={label}
        state={message ? "invalid" : "default"}
        variant="textarea"
      >
        <textarea
          aria-describedby={message ? messageId : undefined}
          aria-invalid={message ? true : undefined}
          id={id}
          name={field.id}
          onChange={(event) => onChange(field.id, event.target.value)}
          value={value}
        />
      </UI.Field>
    );
  }
  return (
    <UI.Field
      error={shownMessage}
      hint={hint}
      htmlFor={id}
      label={label}
      state={message ? "invalid" : "default"}
    >
      <UI.TextInput
        autoComplete="off"
        describedBy={message ? messageId : undefined}
        id={id}
        inputMode={field.kind === "integer" ? "numeric" : "text"}
        invalid={Boolean(message)}
        name={field.id}
        onChange={(next) => onChange(field.id, next)}
        type="text"
        value={value}
      />
    </UI.Field>
  );
}

/** The editor's form. Mounted once the entry it starts from is known. */
function RuleForm(
  { entry, onApply, onCancel }: {
    entry: RuleEntry;
    onApply: (entry: RuleEntry) => void;
    onCancel: () => void;
  },
) {
  const { translate } = useI18n();
  const [enabled, setEnabled] = useState(entry.enabled);
  const [mode, setMode] = useState<string>(entry.mode);
  const [canOverride, setCanOverride] = useState(!entry.locked);
  const [form, setForm] = useState<OptionForm>(() => toForm(entry));
  const [errors, setErrors] = useState<Record<string, FieldError>>({});
  const formRef = useRef<HTMLFormElement>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = fromForm(entry.ruleKey, form);
    if ("errors" in parsed) {
      setErrors(parsed.errors);
      // The first field, in reading order, that the check refused.
      const refused = parsed.errors;
      focusAfterPaint(() =>
        Array.from(
          formRef.current?.querySelectorAll<HTMLInputElement>("[name]") ?? [],
        ).find((control) => control.name in refused)
      );
      return;
    }
    setErrors({});
    onApply(
      {
        ...entry,
        enabled,
        mode,
        locked: !canOverride,
        options: parsed.options,
      } as unknown as RuleEntry,
    );
  };

  return (
    <form noValidate onSubmit={submit} ref={formRef}>
      <UI.Stack>
        <UI.Switch
          checked={enabled}
          name="enabled"
          onChange={(event) => setEnabled(event.target.checked)}
        >
          {translate("settings.repositoryRules.editor.enabled")}
        </UI.Switch>
        <UI.Stack gap="tight">
          <UI.Text>
            {translate("settings.repositoryRules.editor.enforcement")}
          </UI.Text>
          <UI.SegmentedControl
            aria-label={translate(
              "settings.repositoryRules.editor.enforcement",
            )}
            name="mode"
            onChange={setMode}
            options={MODES.map((value) => ({
              label: translate(`settings.repositoryRules.mode.${value}`),
              value,
            }))}
            value={mode}
          />
          <UI.Text variant="muted">
            {translate("settings.repositoryRules.editor.modeHelp")}
          </UI.Text>
        </UI.Stack>
        <UI.Switch
          checked={canOverride}
          name="canOverride"
          onChange={(event) => setCanOverride(event.target.checked)}
        >
          {translate("settings.repositoryRules.editor.canOverride")}
        </UI.Switch>
        {OPTION_FIELDS[entry.ruleKey].map((field) => (
          <OptionInput
            error={errors[field.id]}
            field={field}
            form={form}
            key={field.id}
            onChange={(id, value) =>
              setForm((current) => ({ ...current, [id]: value }))}
            translate={translate}
          />
        ))}
        <UI.Text variant="hint">
          {translate("settings.repositoryRules.editor.applyHint")}
        </UI.Text>
        <UI.Inline variant="end">
          <UI.Button onClick={onCancel} type="button" variant="secondary">
            {translate("settings.repositoryRules.editor.cancel")}
          </UI.Button>
          <UI.Button type="submit">
            {translate("settings.repositoryRules.editor.apply")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    </form>
  );
}

/**
 * `/settings/organization/repository-rules/$ruleKey`: one rule of the
 * organization baseline. Applying puts the edit into the unpublished draft;
 * nothing is sent to the server from here.
 */
export function OrganizationRepositoryRuleEditorPage() {
  const api = useBakeryApi();
  const { translate } = useI18n();
  const navigate = useNavigate();
  const { ruleKey: raw } = useParams({
    from: "/settings/organization/repository-rules/$ruleKey",
  });
  const { scope, waiting } = useRulesScope();
  const rules = useQuery(organizationRepositoryRulesQueryOptions(api, scope));
  const published = rules.isSuccess ? rules.data : undefined;
  const drafts = useRulesDraft(scope, published?.revision, published?.entries);
  const ruleKey = isRuleKey(raw) ? raw : null;
  const refused = rules.isError &&
    (isForbiddenFailure(rules.error) || failureStatus(rules.error) === 404);

  const existing = ruleKey && published
    ? published.entries.find((entry) => entry.ruleKey === ruleKey)
    : undefined;
  const start = ruleKey && published
    ? drafts.draft?.edited[ruleKey] ?? existing ?? blankEntry(ruleKey)
    : null;
  const isNew = Boolean(ruleKey && published && !existing);
  const name = ruleKey ? translate(RULE_NAME[ruleKey]) : "";
  const back = () => void navigate({ to: LIST_PAGE });

  return (
    <>
      <ShellActiveNavigation id="settings" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            { label: translate("shell.states.settingsTitle") },
            {
              href: LIST_PAGE,
              label: translate("shell.navigation.repositoryRules"),
            },
            ...(ruleKey ? [{ label: name }] : []),
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="org-rule-editor">
        <UI.Stack gap="tight">
          <UI.Heading level="page">
            {ruleKey
              ? translate(
                isNew
                  ? "settings.repositoryRules.editor.addTitle"
                  : "settings.repositoryRules.editor.title",
                { rule: name },
              )
              : translate("settings.repositoryRules.title")}
          </UI.Heading>
          {ruleKey ? null : (
            <UI.Text variant="muted">
              {translate("settings.repositoryRules.description")}
            </UI.Text>
          )}
        </UI.Stack>
        {start && !isNew
          ? (
            // The list clamps this line; here it is whole, for keyboard and
            // touch users who cannot open a title tooltip.
            <UI.Text data-testid="org-rule-summary" variant="muted">
              {summarize(start, translate)}
            </UI.Text>
          )
          : null}
        {waiting && refused
          ? (
            <UI.AlertBanner tone="information">
              {translate("settings.repositoryRules.forbidden")}
            </UI.AlertBanner>
          )
          : null}
        {waiting && rules.isPending
          ? (
            <div
              aria-busy="true"
              aria-label={translate("settings.repositoryRules.loading")}
              role="status"
            >
              <UI.Stack gap="compact">
                {[0, 1, 2].map((row) => <UI.Skeleton key={row} shape="row" />)}
              </UI.Stack>
            </div>
          )
          : null}
        {waiting && rules.isError && !refused
          ? (
            <UI.ErrorState
              action={
                <UI.Button
                  loading={rules.isFetching}
                  onClick={() => void rules.refetch()}
                  type="button"
                >
                  {translate("core.actions.retry")}
                </UI.Button>
              }
              title={translate("settings.repositoryRules.loadError")}
            />
          )
          : null}
        {published && !ruleKey
          ? (
            <UI.EmptyState
              action={
                <UI.Button onClick={back} type="button" variant="secondary">
                  {translate("settings.repositoryRules.editor.back")}
                </UI.Button>
              }
              description=""
              title={translate("settings.repositoryRules.editor.notFound")}
            />
          )
          : null}
        {start
          ? (
            <RuleForm
              entry={start}
              key={`${start.ruleKey}:${drafts.draft ? "draft" : "published"}`}
              onApply={(entry) => {
                drafts.apply(entry);
                back();
              }}
              onCancel={back}
            />
          )
          : null}
        <LeaveGuard count={drafts.count} discard={drafts.discard} />
      </UI.SettingsContent>
    </>
  );
}
