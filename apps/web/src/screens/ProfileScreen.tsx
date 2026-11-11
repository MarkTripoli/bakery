import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

export type ProfileField =
  | "name"
  | "firstName"
  | "lastName"
  | "title"
  | "image";

/** What the person is editing: every field is text, `""` means cleared. */
export type ProfileDraft = Readonly<Record<ProfileField, string>>;

/** Exported so the container can move focus to the control a failure names. */
export const PROFILE_FIELD_IDS: Readonly<Record<ProfileField, string>> = {
  name: "profile-name",
  firstName: "profile-first-name",
  lastName: "profile-last-name",
  title: "profile-title",
  image: "profile-image",
};

export type ProfileScreenProps = {
  /** Shared async state; `null` renders the settled screen. */
  readonly async: SecurityAsyncKind | null;
  /** The name the page and avatar show; the saved name, not the draft. */
  readonly displayName: string;
  readonly email: string;
  /** The saved photo URL, or empty. A photo that fails to load shows initials. */
  readonly image: string;
  /** Only `true` shows the Verified badge; never guessed. */
  readonly emailVerified: boolean;
  readonly draft: ProfileDraft;
  /** Already-translated validation message per field. */
  readonly errors: Readonly<Partial<Record<ProfileField, string>>>;
  /** A save succeeded and nothing has changed since. */
  readonly saved: boolean;
  /** A save failed for a reason other than a conflict. */
  readonly saveFailed: boolean;
  readonly dirty: boolean;
  readonly pending: boolean;
  /** Opens Account & security, where the email is changed. */
  readonly onChangeEmail: () => void;
  readonly onChange: (field: ProfileField, value: string) => void;
  readonly onSave: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/settings/profile`: the person's own name, job title and photo, shared
 * across organizations, with the sign-in email shown read-only. Built from
 * catalog components in the `personal` settings layout.
 */
export function ProfileScreen(
  {
    async,
    dirty,
    displayName,
    draft,
    email,
    emailVerified,
    image,
    errors,
    onChange,
    onChangeEmail,
    onRefresh,
    onReload,
    onRetry,
    onSave,
    pending,
    saved,
    saveFailed,
  }: ProfileScreenProps,
) {
  const { translate } = useI18n();
  const field = (
    name: ProfileField,
    options: {
      readonly autoComplete: string;
      readonly placeholder?: string;
      readonly inputMode?: "text" | "url";
      readonly required?: boolean;
    },
  ) => (
    <UI.TextInput
      autoComplete={options.autoComplete}
      describedBy={errors[name]
        ? `${PROFILE_FIELD_IDS[name]}-error`
        : undefined}
      disabled={false}
      id={PROFILE_FIELD_IDS[name]}
      inputMode={options.inputMode}
      invalid={Boolean(errors[name])}
      name={name}
      onChange={(value) => onChange(name, value)}
      placeholder={options.placeholder}
      required={options.required}
      type="text"
      value={draft[name]}
    />
  );
  return (
    <UI.SettingsContent data-testid="profile-settings" variant="personal">
      <UI.AuthHeading
        description={translate("profile.description")}
        title={translate("profile.title")}
      />
      <SecurityAsyncBoundary
        emptyDescription={translate("profile.empty.description")}
        emptyTitle={translate("profile.empty.title")}
        kind={async}
        onRefresh={onRefresh}
        onReload={onReload}
        onRetry={onRetry}
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <UI.Stack gap="standard">
            <UI.Identity
              avatar={{
                alt: displayName,
                size: "large",
                src: image === "" ? undefined : image,
              }}
              detail={translate("profile.account")}
              name={displayName}
              showType={false}
              type="person"
            />
            {saved
              ? (
                <UI.InlineNotice tone="success">
                  {translate("profile.saved")}
                </UI.InlineNotice>
              )
              : null}
            {saveFailed
              ? (
                <UI.InlineNotice tone="error">
                  {translate("profile.saveError")}
                </UI.InlineNotice>
              )
              : null}
            <UI.Field
              error={errors.name}
              htmlFor={PROFILE_FIELD_IDS.name}
              label={translate("profile.displayName")}
              layout="inline"
            >
              {field("name", { autoComplete: "name", required: true })}
            </UI.Field>
            <UI.Field
              htmlFor={PROFILE_FIELD_IDS.firstName}
              label={translate("profile.nameDetails")}
              layout="inline"
              note={translate("profile.optional")}
            >
              <UI.Inline
                aria-label={translate("profile.nameDetails")}
                role="group"
                variant="split"
              >
                <UI.Field
                  error={errors.firstName}
                  htmlFor={PROFILE_FIELD_IDS.firstName}
                  label={translate("profile.firstName")}
                >
                  {field("firstName", { autoComplete: "given-name" })}
                </UI.Field>
                <UI.Field
                  error={errors.lastName}
                  htmlFor={PROFILE_FIELD_IDS.lastName}
                  label={translate("profile.lastName")}
                >
                  {field("lastName", { autoComplete: "family-name" })}
                </UI.Field>
              </UI.Inline>
            </UI.Field>
            <UI.Field
              error={errors.title}
              htmlFor={PROFILE_FIELD_IDS.title}
              label={translate("profile.jobTitle")}
              layout="inline"
              note={translate("profile.optional")}
            >
              {field("title", {
                autoComplete: "organization-title",
                placeholder: translate("profile.jobTitlePlaceholder"),
              })}
            </UI.Field>
            <UI.Field
              error={errors.image}
              hint={translate("profile.photoHint")}
              htmlFor={PROFILE_FIELD_IDS.image}
              label={translate("profile.photoUrl")}
              layout="inline"
              note={translate("profile.optional")}
            >
              {field("image", {
                autoComplete: "photo",
                inputMode: "url",
                placeholder: translate("profile.photoPlaceholder"),
              })}
            </UI.Field>
            <UI.Field
              label={translate("profile.email")}
              layout="inline"
            >
              <UI.Inline gap="standard">
                <UI.Text data-testid="profile-email">{email}</UI.Text>
                {emailVerified
                  ? (
                    <UI.Badge tone="success">
                      {translate("profile.emailVerified")}
                    </UI.Badge>
                  )
                  : null}
                <UI.Button onClick={onChangeEmail} variant="secondary">
                  {translate("profile.changeEmail")}
                </UI.Button>
              </UI.Inline>
            </UI.Field>
            <UI.Inline gap="compact">
              <UI.Button
                disabled={isDisconnected(async) || !dirty}
                loading={pending}
                type="submit"
              >
                {translate(
                  pending ? "auth.common.pendingAction" : "profile.save",
                )}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        </form>
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}
