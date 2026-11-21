import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import type { StorageSettings } from "../api/client.ts";
import { ORGANIZATIONS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  DEFAULTED_FIELDS,
  FIELD_RULES,
  type FieldProblem,
  fieldText,
  PAUSED_SHARE,
  sizeWords,
  STORAGE_FIELDS,
  type StorageDraft,
  type StorageField,
  usedShare,
  WARNING_SHARE,
} from "./storage/storage-display.ts";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

/** The id of a field's input, so the container can focus the first one in error. */
export const storageFieldId = (field: StorageField): string =>
  `organization-storage-${field}`;

const LABEL: Readonly<Record<StorageField, MessageKey>> = {
  organizationQuotaBytes: "organizationStorage.field.organization.label",
  projectQuotaBytes: "organizationStorage.field.project.label",
  personalQuotaBytes: "organizationStorage.field.personal.label",
  maxFileBytes: "organizationStorage.field.file.label",
  stepWriteBytes: "organizationStorage.field.stepBytes.label",
  stepWriteFiles: "organizationStorage.field.stepFiles.label",
  workingVersionsKept: "organizationStorage.field.versions.label",
  trashRetentionDays: "organizationStorage.field.trash.label",
  scratchRetentionDays: "organizationStorage.field.scratch.label",
};
const HELP: Readonly<Record<StorageField, MessageKey>> = {
  organizationQuotaBytes: "organizationStorage.field.organization.help",
  projectQuotaBytes: "organizationStorage.field.project.help",
  personalQuotaBytes: "organizationStorage.field.personal.help",
  maxFileBytes: "organizationStorage.field.file.help",
  stepWriteBytes: "organizationStorage.field.stepBytes.help",
  stepWriteFiles: "organizationStorage.field.stepFiles.help",
  workingVersionsKept: "organizationStorage.field.versions.help",
  trashRetentionDays: "organizationStorage.field.trash.help",
  scratchRetentionDays: "organizationStorage.field.scratch.help",
};
const LIMITS: readonly StorageField[] = STORAGE_FIELDS.slice(0, 4);
const AGENT: readonly StorageField[] = STORAGE_FIELDS.slice(4, 6);
const KEPT: readonly StorageField[] = STORAGE_FIELDS.slice(6);

export type OrganizationStorageScreenProps = {
  /** Shared async state; `null` renders the settled screen. */
  readonly async: SecurityAsyncKind | null;
  readonly organizationName: string;
  /** Admins edit the limits; everyone else sees them read-only. */
  readonly canEdit: boolean;
  /** What is saved; `null` while it loads. */
  readonly settings: StorageSettings | null;
  /** What the Admin has typed. */
  readonly draft: StorageDraft;
  /** The fields whose text cannot be saved, and why. */
  readonly problems: Readonly<Partial<Record<StorageField, FieldProblem>>>;
  /** The organization quota in the draft is below what is stored. */
  readonly belowStored: boolean;
  /** Someone else saved first: the change was not applied. */
  readonly conflict: boolean;
  /** A save succeeded and nothing has changed since. */
  readonly saved: boolean;
  /** A save failed for a reason other than a conflict. */
  readonly saveFailed: boolean;
  readonly pending: boolean;
  /** Nothing differs from what is saved. */
  readonly unchanged: boolean;
  readonly onDraftChange: (field: StorageField, value: string) => void;
  readonly onFieldBlur: (field: StorageField) => void;
  readonly onSave: () => void;
  readonly onReset: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/organization/storage`: how full the organization's storage is, and the
 * limits and retention it is set to. An Admin edits every limit and saves with
 * an optimistic-concurrency version; everyone else reads the same values.
 * Built from catalog components in the `settings` composition, plus the
 * `UsageMeter`.
 */
export function OrganizationStorageScreen(
  props: OrganizationStorageScreenProps,
) {
  const { translate } = useI18n();
  const { async, organizationName, settings } = props;
  return (
    <UI.SettingsContent
      data-page="organization-storage"
      data-testid="organization-storage"
    >
      <UI.AuthHeading
        description={organizationName === ""
          ? translate("organizationStorage.description")
          : `${organizationName} · ${
            translate("organizationStorage.description")
          }`}
        title={translate("organizationStorage.title")}
      />
      <SecurityAsyncBoundary
        emptyAction={
          <RouterLink to={ORGANIZATIONS_PATH}>
            {translate("core.actions.switchOrganization")}
          </RouterLink>
        }
        emptyDescription={translate("organizationStorage.empty.description")}
        emptyTitle={translate("organizationStorage.empty.title")}
        kind={async}
        onRefresh={props.onRefresh}
        onReload={props.onReload}
        onRetry={props.onRetry}
      >
        {settings === null ? <UI.Skeleton shape="row" /> : (
          <>
            <UsedNow settings={settings} />
            {props.canEdit
              ? <EditForm {...props} settings={settings} />
              : <ReadOnly settings={settings} />}
          </>
        )}
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}

function UsedNow({ settings }: { readonly settings: StorageSettings }) {
  const { translate, locale } = useI18n();
  const size = (bytes: number) => {
    const words = sizeWords(bytes, locale);
    return translate(words.key, { value: words.value });
  };
  const reading = translate("organizationStorage.used.reading", {
    used: size(settings.organizationUsedBytes),
    limit: size(settings.organizationQuotaBytes),
  });
  const state = settings.organizationQuotaState;
  const percent = Math.round(usedShare(settings) * 100);
  return (
    <UI.SettingsSection
      data-testid="storage-used"
      title={translate("organizationStorage.used.heading")}
      variant="stack"
    >
      <UI.Inline gap="standard">
        <UI.Heading level="page" rank={3}>{reading}</UI.Heading>
        <UI.Badge
          tone={state === "ok"
            ? "success"
            : state === "warning"
            ? "warning"
            : "danger"}
        >
          {translate(`organizationStorage.state.${state}` as MessageKey)}
        </UI.Badge>
      </UI.Inline>
      <UI.UsageMeter
        label={translate("organizationStorage.meter.label")}
        limit={settings.organizationQuotaBytes}
        marks={[{ at: WARNING_SHARE }, { at: PAUSED_SHARE }]}
        state={state}
        value={settings.organizationUsedBytes}
        valueText={translate("organizationStorage.meter.value", {
          reading,
          percent,
        })}
      />
      <UI.Text variant="muted">
        {translate("organizationStorage.meter.marks", {
          warning: Math.round(WARNING_SHARE * 100),
          paused: Math.round(PAUSED_SHARE * 100),
        })}
      </UI.Text>
      <UI.Text variant="muted">
        {translate("organizationStorage.meter.counts")}
      </UI.Text>
    </UI.SettingsSection>
  );
}

/** The unit beside a field: GB, versions or days. */
function unitWord(
  field: StorageField,
  translate: ReturnType<typeof useI18n>["translate"],
): string {
  const unit = FIELD_RULES[field].unit;
  return unit === "gigabytes"
    ? translate("organizationStorage.unit.gb")
    : unit === "megabytes"
    ? translate("organizationStorage.unit.mb")
    : field === "stepWriteFiles"
    ? translate("organizationStorage.unit.filesWord")
    : field === "workingVersionsKept"
    ? translate("organizationStorage.unit.versionsWord")
    : translate("organizationStorage.unit.daysWord");
}

/** A saved value with its unit, for the read-only list: "100 GB", "20 versions", "30 days". */
function valueWords(
  field: StorageField,
  settings: StorageSettings,
  translate: ReturnType<typeof useI18n>["translate"],
  locale: string,
): string {
  const text = fieldText(field, settings[field]);
  if (FIELD_RULES[field].unit === "megabytes") {
    const words = sizeWords(settings[field], locale);
    return translate(words.key, { value: words.value });
  }
  if (FIELD_RULES[field].unit === "gigabytes") {
    return translate("organizationStorage.unit.gigabytes", { value: text });
  }
  return translate(
    field === "workingVersionsKept"
      ? "organizationStorage.unit.versions"
      : field === "stepWriteFiles"
      ? "organizationStorage.unit.files"
      : "organizationStorage.unit.days",
    { value: Number(text) },
  );
}

function ReadOnly({ settings }: { readonly settings: StorageSettings }) {
  const { translate, locale } = useI18n();
  const rows = (fields: readonly StorageField[]) => (
    <UI.DescriptionList>
      {fields.map((field) => (
        <UI.DescriptionItem
          description={valueWords(field, settings, translate, locale)}
          key={field}
          title={translate(LABEL[field])}
        />
      ))}
    </UI.DescriptionList>
  );
  return (
    <>
      <UI.SettingsSection
        data-testid="storage-limits-readonly"
        title={translate("organizationStorage.limits.heading")}
      >
        {rows(LIMITS)}
      </UI.SettingsSection>
      <UI.SettingsSection
        title={translate("organizationStorage.agent.heading")}
      >
        <UI.Text variant="muted">
          {translate("organizationStorage.agent.description")}
        </UI.Text>
        {rows(AGENT)}
      </UI.SettingsSection>
      <UI.SettingsSection
        title={translate("organizationStorage.kept.heading")}
      >
        {rows(KEPT)}
      </UI.SettingsSection>
      <UI.Text variant="muted">
        {translate("organizationStorage.readOnly")}
      </UI.Text>
    </>
  );
}

function EditForm(
  props: OrganizationStorageScreenProps & {
    readonly settings: StorageSettings;
  },
) {
  const { translate, locale } = useI18n();
  const { async, draft, problems, settings } = props;
  const range = (field: StorageField) => ({
    min: FIELD_RULES[field].min.toLocaleString(locale),
    max: FIELD_RULES[field].max.toLocaleString(locale),
  });
  const message = (field: StorageField) => {
    const problem = problems[field];
    if (problem === undefined) return undefined;
    if (DEFAULTED_FIELDS.includes(field)) {
      return translate(
        problem === "tooLarge"
          ? "organizationStorage.error.range"
          : "organizationStorage.error.positive",
        range(field),
      );
    }
    return problem === "tooLarge" && field === "maxFileBytes"
      ? translate("organizationStorage.error.largestFile", range(field))
      : translate("organizationStorage.error.whole", range(field));
  };
  const field = (name: StorageField) => {
    const error = message(name);
    const warn = name === "organizationQuotaBytes" && props.belowStored &&
      error === undefined;
    const words = sizeWords(settings.organizationUsedBytes, locale);
    return (
      <UI.Stack gap="compact" key={name}>
        <UI.Field
          error={error}
          hint={translate(HELP[name])}
          htmlFor={storageFieldId(name)}
          label={translate(LABEL[name])}
          layout="inline"
        >
          <UI.Inline gap="compact">
            <UI.TextInput
              autoComplete="off"
              describedBy={undefined}
              disabled={isDisconnected(async)}
              id={storageFieldId(name)}
              inputMode="numeric"
              invalid={error !== undefined}
              name={name}
              onBlur={() => props.onFieldBlur(name)}
              onChange={(value) => props.onDraftChange(name, value)}
              placeholder={DEFAULTED_FIELDS.includes(name)
                ? translate("organizationStorage.field.defaultPlaceholder")
                : undefined}
              type="text"
              value={draft[name]}
            />
            <UI.Text variant="muted">{unitWord(name, translate)}</UI.Text>
          </UI.Inline>
        </UI.Field>
        {warn
          ? (
            <UI.InlineNotice tone="warning">
              {translate("organizationStorage.belowStored", {
                used: translate(words.key, { value: words.value }),
              })}
            </UI.InlineNotice>
          )
          : null}
      </UI.Stack>
    );
  };
  return (
    <UI.FormContent>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          props.onSave();
        }}
      >
        <UI.Stack gap="spacious">
          <UI.SettingsSection
            title={translate("organizationStorage.limits.heading")}
            variant="stack"
          >
            {LIMITS.map(field)}
          </UI.SettingsSection>
          <UI.SettingsSection
            title={translate("organizationStorage.agent.heading")}
            variant="stack"
          >
            <UI.Text variant="muted">
              {translate("organizationStorage.agent.description")}
            </UI.Text>
            {AGENT.map(field)}
          </UI.SettingsSection>
          <UI.SettingsSection
            title={translate("organizationStorage.kept.heading")}
            variant="stack"
          >
            {KEPT.map(field)}
          </UI.SettingsSection>
          {props.conflict
            ? (
              <UI.InlineNotice
                action={
                  <UI.Button
                    onClick={props.onReload}
                    type="button"
                    variant="secondary"
                  >
                    {translate("organizationStorage.reload")}
                  </UI.Button>
                }
                tone="error"
              >
                {translate("organizationStorage.conflict")}
              </UI.InlineNotice>
            )
            : null}
          {props.saved
            ? (
              <UI.InlineNotice tone="success">
                {translate("organizationStorage.saved")}
              </UI.InlineNotice>
            )
            : null}
          {props.saveFailed
            ? (
              <UI.InlineNotice tone="error">
                {translate("organizationStorage.saveError")}
              </UI.InlineNotice>
            )
            : null}
          <UI.Inline data-form-actions gap="standard">
            <UI.Button
              disabled={isDisconnected(async) || props.unchanged}
              loading={props.pending}
              type="submit"
            >
              {translate(
                props.pending
                  ? "auth.common.pendingAction"
                  : "organizationStorage.save",
              )}
            </UI.Button>
            <UI.Button
              disabled={isDisconnected(async) || props.pending}
              onClick={props.onReset}
              type="button"
              variant="secondary"
            >
              {translate("organizationStorage.reset")}
            </UI.Button>
          </UI.Inline>
          <UI.Text variant="muted">
            {translate("organizationStorage.appliesNext")}
          </UI.Text>
        </UI.Stack>
      </form>
    </UI.FormContent>
  );
}
