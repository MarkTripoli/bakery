import * as UI from "@bakery/ui";
import {
  type InstallationSettingsUpdate,
  InstallationSettingsUpdateSchema,
} from "@bakery/contracts/installation-settings";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type InstallationSettingsScreenProps = {
  readonly draft: InstallationSettingsUpdate | null;
  readonly state: UI.InstallationSettingsFormProps["state"];
  readonly saved: boolean;
  readonly dirty: boolean;
  readonly changedLabel: string;
  readonly onChange: (draft: InstallationSettingsUpdate) => void;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onReload: () => void;
};

export function InstallationSettingsScreen(
  {
    draft,
    state,
    saved,
    dirty,
    changedLabel,
    onChange,
    onSave,
    onDiscard,
    onReload,
  }: InstallationSettingsScreenProps,
) {
  const { translate } = useI18n();
  const update = (patch: Partial<InstallationSettingsUpdate>) => {
    if (!draft) return;
    const parsed = InstallationSettingsUpdateSchema.safeParse({
      ...draft,
      ...patch,
    });
    if (parsed.success) onChange(parsed.data);
  };
  const notice = state === "conflict"
    ? translate("settings.installation.conflict")
    : state === "forbidden"
    ? translate("settings.installation.forbidden")
    : state === "error"
    ? translate(
      draft ? "settings.installation.error" : "settings.installation.loadError",
    )
    : state === "loading"
    ? translate("settings.installation.loading")
    : saved
    ? translate("settings.installation.saved")
    : undefined;
  return (
    <UI.SettingsContent data-testid="installation-settings">
      <UI.InstallationSettingsForm
        title={translate("settings.installation.title")}
        description={translate("settings.installation.description")}
        groups={draft
          ? [{
            id: "registration",
            title: translate("settings.installation.registration"),
            description: translate(
              "settings.installation.registration.description",
            ),
            value: draft.registrationMode,
            onChange: (registrationMode) =>
              update({
                registrationMode: registrationMode === "closed"
                  ? "closed"
                  : "invitation",
              }),
            choices: [
              {
                value: "invitation",
                label: translate("settings.installation.invitation"),
                description: translate(
                  "settings.installation.invitation.description",
                ),
              },
              {
                value: "open",
                label: translate("settings.installation.open"),
                description: translate(
                  "settings.installation.open.description",
                ),
                disabled: true,
                disabledHint: translate(
                  "settings.installation.open.unavailable",
                ),
              },
              {
                value: "closed",
                label: translate("settings.installation.closed"),
                description: translate(
                  "settings.installation.closed.description",
                ),
              },
            ],
          }, {
            id: "organizations",
            title: translate("settings.installation.organizations"),
            description: translate(
              "settings.installation.organizations.description",
            ),
            value: draft.organizationCreationPolicy,
            onChange: (organizationCreationPolicy) =>
              update({
                organizationCreationPolicy:
                  organizationCreationPolicy === "any_user"
                    ? "any_user"
                    : "installation_admins",
              }),
            choices: [
              {
                value: "any_user",
                label: translate("settings.installation.anyUser"),
                description: translate(
                  "settings.installation.anyUser.description",
                ),
              },
              {
                value: "installation_admins",
                label: translate("settings.installation.administrators"),
                description: translate(
                  "settings.installation.administrators.description",
                ),
              },
            ],
          }]
          : []}
        state={state}
        notice={notice}
        noticeTitle={translate(
          state === "conflict"
            ? "settings.installation.conflictTitle"
            : "settings.installation.errorTitle",
        )}
        keepEditingLabel={translate("settings.installation.keepEditing")}
        retryLabel={translate("settings.installation.retry")}
        noticeAction={state === "conflict" || (state === "error" && !draft)
          ? (
            <UI.Button onClick={onReload}>
              {translate(
                state === "conflict"
                  ? "settings.installation.reload"
                  : "settings.installation.retry",
              )}
            </UI.Button>
          )
          : undefined}
        changedLabel={changedLabel}
        dirty={dirty}
        saveLabel={translate("settings.installation.save")}
        discardLabel={translate("settings.installation.discard")}
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </UI.SettingsContent>
  );
}
