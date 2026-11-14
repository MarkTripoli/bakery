import { useEffect, useRef } from "react";
import * as UI from "@bakery/ui";
import { SECURITY_SETTINGS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import type { SecurityFailure } from "../app/security-failures.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";
import { ActionLink } from "./action-link.tsx";
import { PasswordNotSetNotice } from "./password-not-set.tsx";

export const PASSKEY_RENAME_INPUT_ID = "passkey-rename-name";
export const PASSKEY_REMOVE_PASSWORD_INPUT_ID = "passkey-remove-password";
export const PASSKEY_REMOVE_CODE_INPUT_ID = "passkey-remove-code";

/** One registered passkey as the list renders it. */
export type PasskeyRow = {
  readonly id: string;
  /** Person-chosen label, or the localized "Unnamed passkey". */
  readonly name: string;
  /** Already-formatted "Added …" hint. */
  readonly description: string;
};

export type PasskeysView =
  | { readonly kind: "list" }
  | { readonly kind: "rename"; readonly passkeyId: string }
  | { readonly kind: "remove"; readonly passkeyId: string };

export type PasskeysScreenProps = {
  readonly view: PasskeysView;
  readonly passkeys: readonly PasskeyRow[];
  /** A one-line confirmation of the last change, announced politely. */
  readonly notice: string | null;
  /** Draft name while renaming. */
  readonly nameDraft: string;
  /** Password draft while confirming a removal. */
  readonly passwordDraft: string;
  /** The server asked for the authenticator code before removing a passkey. */
  readonly factorRequired: boolean;
  /** Which code the in-place factor proof takes. */
  readonly codeKind: "totp" | "backup";
  /** The server said the account has no password: the field is not needed. */
  readonly passwordless: boolean;
  /** Swaps between the authenticator code and a backup code. */
  readonly onToggleCodeKind: () => void;
  /** Authenticator code draft while proving the factor in place. */
  readonly codeDraft: string;
  readonly pending: boolean;
  /** Why the last rename or removal did not happen. */
  readonly failure: SecurityFailure | "failed" | null;
  readonly async: SecurityAsyncKind | null;
  /** "Add a passkey": the add-passkey page this link navigates to. */
  readonly addTo: string;
  readonly onRename: (passkeyId: string) => void;
  readonly onRemove: (passkeyId: string) => void;
  readonly onNameChange: (value: string) => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onCodeChange: (value: string) => void;
  /** Passwordless accounts: ends the session and returns to sign-in. */
  readonly onSignOutThenSignIn: () => void;
  readonly onSubmitRename: () => void;
  readonly onSubmitRemove: () => void;
  /** Leaves rename/remove and returns to the list. */
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/settings/security/passkeys` presenter — Paper V-0 `passkeys` (auth.js
 * `passkeys`): the list (or the "no passkeys yet" notice) with Rename and
 * Remove per passkey and "Add a passkey"; then the rename page and the
 * remove page, whose `blocked` (last sign-in method) and `failed` variants
 * explain why the passkey is still connected. Every control names the
 * device it acts on; focus returns to the row's control after a view closes.
 */
export function PasskeysScreen(props: PasskeysScreenProps) {
  const { translate } = useI18n();
  const { async, failure, view } = props;
  const target = view.kind === "list"
    ? null
    : props.passkeys.find((passkey) => passkey.id === view.passkeyId) ?? null;

  // Moves focus into a view when it opens and back to the control that
  // opened it when it closes.
  const openerRef = useRef<string | null>(null);
  const previousView = useRef<PasskeysView["kind"]>(view.kind);
  useEffect(() => {
    const before = previousView.current;
    previousView.current = view.kind;
    if (before === view.kind) return;
    if (view.kind === "rename") {
      document.getElementById(PASSKEY_RENAME_INPUT_ID)?.focus();
    } else if (view.kind === "remove") {
      (document.getElementById(PASSKEY_REMOVE_PASSWORD_INPUT_ID) ??
        document.querySelector<HTMLElement>("[data-passkey-back]"))?.focus();
    } else {
      // Back on the list: the control that opened the view, or — when its
      // passkey is gone — the next remaining control, then "Add a passkey".
      (document.querySelector<HTMLElement>(
        `[data-passkey-opener="${CSS.escape(openerRef.current ?? "")}"]`,
      ) ?? document.querySelector<HTMLElement>("[data-passkey-opener]") ??
        document.querySelector<HTMLElement>("[data-passkey-add]"))?.focus();
    }
  }, [view]);

  const base = {
    kind: async,
    emptyDescription: translate("passkeys.emptyDescription"),
    emptyTitle: translate("passkeys.emptyTitle"),
    onRefresh: props.onRefresh,
    onReload: props.onReload,
    onRetry: props.onRetry,
  };

  if (view.kind === "rename") {
    const name = target?.name ?? "";
    return (
      <UI.SettingsContent data-testid="passkeys-rename">
        <UI.AuthHeading
          description={translate("passkeys.rename.description")}
          title={translate("passkeys.rename.title")}
        />
        <SecurityAsyncBoundary {...base}>
          <UI.FormContent>
            {failure === null ? null : (
              <UI.InlineNotice tone="error">
                {translate("passkeys.rename.failed")}
              </UI.InlineNotice>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                props.onSubmitRename();
              }}
            >
              <UI.Stack gap="standard">
                <UI.Field
                  htmlFor={PASSKEY_RENAME_INPUT_ID}
                  label={translate("passkeys.rename.nameLabel")}
                >
                  <UI.TextInput
                    autoComplete="off"
                    id={PASSKEY_RENAME_INPUT_ID}
                    name="passkey-name"
                    onChange={props.onNameChange}
                    type="text"
                    value={props.nameDraft}
                  />
                </UI.Field>
                <UI.Button
                  aria-label={translate("passkeys.rename.saveAria", { name })}
                  disabled={isDisconnected(async)}
                  loading={props.pending}
                  type="submit"
                >
                  {translate(
                    props.pending
                      ? "auth.common.pendingAction"
                      : "passkeys.rename.save",
                  )}
                </UI.Button>
              </UI.Stack>
            </form>
            <ActionLink href="?" onActivate={props.onCancel}>
              {translate("passkeys.rename.cancel")}
            </ActionLink>
          </UI.FormContent>
        </SecurityAsyncBoundary>
      </UI.SettingsContent>
    );
  }

  if (view.kind === "remove") {
    const name = target?.name ?? "";
    const failureKind = failure === null || failure === "failed"
      ? null
      : failure.kind;
    const blocked = failureKind === "lastSignInMethod";
    const signInRequired = failureKind === "passwordNotSet";
    const codeInvalid = failureKind === "invalidCode";
    return (
      <UI.SettingsContent data-testid="passkeys-remove">
        <UI.AuthHeading
          description={translate("passkeys.remove.description", { name })}
          title={translate("passkeys.remove.title")}
        />
        <SecurityAsyncBoundary {...base}>
          <UI.FormContent>
            <UI.DescriptionItem
              description={target?.description}
              icon={<UI.IconGlyph name="key" size="large" />}
              title={name}
            />
            {signInRequired ? null : (
              <UI.InlineNotice
                tone={blocked || failure === null || props.factorRequired &&
                    failureKind === "factorRequired"
                  ? "warning"
                  : "error"}
              >
                {blocked
                  ? translate("passkeys.remove.blocked")
                  : failure === null
                  ? translate("passkeys.remove.warning")
                  : failureKind === "factorRequired"
                  ? translate(
                    props.codeKind === "backup"
                      ? "passkeys.remove.factorNoticeBackup"
                      : "passkeys.remove.factorNotice",
                  )
                  : failureKind === "invalidCode"
                  ? translate("passkeys.remove.codeError")
                  : failureKind === "invalidPassword"
                  ? translate("passkeys.remove.passwordError")
                  : translate("passkeys.remove.failed")}
              </UI.InlineNotice>
            )}
            {signInRequired
              ? (
                <PasswordNotSetNotice
                  onSignOutThenSignIn={props.onSignOutThenSignIn}
                />
              )
              : null}
            {blocked
              ? (
                <RouterLink
                  data-passkey-back=""
                  to={SECURITY_SETTINGS_PATH}
                  variant="button"
                >
                  {translate("passkeys.remove.backToMethods")}
                </RouterLink>
              )
              : signInRequired
              ? null
              : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    props.onSubmitRemove();
                  }}
                >
                  <UI.Stack gap="standard">
                    {props.passwordless
                      ? (
                        <UI.InlineNotice tone="neutral">
                          {translate("settings.passwordless.note")}
                        </UI.InlineNotice>
                      )
                      : (
                        <UI.Field
                          error={failure !== null && failure !== "failed" &&
                              failure.kind === "invalidPassword"
                            ? translate("passkeys.remove.passwordError")
                            : undefined}
                          htmlFor={PASSKEY_REMOVE_PASSWORD_INPUT_ID}
                          label={translate("passkeys.remove.passwordLabel")}
                        >
                          <UI.PasswordInput
                            autoComplete="current-password"
                            id={PASSKEY_REMOVE_PASSWORD_INPUT_ID}
                            invalid={failure !== null && failure !== "failed" &&
                              failure.kind === "invalidPassword"}
                            name="current-password"
                            onChange={props.onPasswordChange}
                            placeholder={translate(
                              "passkeys.remove.passwordPlaceholder",
                            )}
                            revealLabels={{
                              hide: translate("auth.signIn.hidePassword"),
                              show: translate("auth.signIn.showPassword"),
                            }}
                            value={props.passwordDraft}
                          />
                        </UI.Field>
                      )}
                    {props.factorRequired
                      ? (
                        <UI.Field
                          error={codeInvalid
                            ? translate("passkeys.remove.codeError")
                            : undefined}
                          hint={translate(
                            props.codeKind === "backup"
                              ? "auth.twoFactor.backup.hint"
                              : "auth.twoFactor.codeHint",
                          )}
                          htmlFor={PASSKEY_REMOVE_CODE_INPUT_ID}
                          label={translate(
                            props.codeKind === "backup"
                              ? "auth.twoFactor.backupCode"
                              : "auth.twoFactor.code",
                          )}
                        >
                          <UI.OneTimeCodeInput
                            id={PASSKEY_REMOVE_CODE_INPUT_ID}
                            invalid={codeInvalid}
                            kind={props.codeKind}
                            name="code"
                            onChange={props.onCodeChange}
                            placeholder={translate(
                              props.codeKind === "backup"
                                ? "auth.twoFactor.backup.placeholder"
                                : "auth.twoFactor.challenge.codePlaceholder",
                            )}
                            value={props.codeDraft}
                          />
                        </UI.Field>
                      )
                      : null}
                    {props.factorRequired
                      ? (
                        <ActionLink
                          href="?"
                          onActivate={props.onToggleCodeKind}
                        >
                          {translate(
                            props.codeKind === "backup"
                              ? "auth.twoFactor.useAuthenticator"
                              : "auth.twoFactor.useBackupCode",
                          )}
                        </ActionLink>
                      )
                      : null}
                    <UI.Button
                      aria-label={translate("passkeys.remove.confirmAria", {
                        name,
                      })}
                      disabled={isDisconnected(async)}
                      loading={props.pending}
                      type="submit"
                    >
                      {translate(
                        props.pending
                          ? "auth.common.pendingAction"
                          : "passkeys.remove.confirm",
                      )}
                    </UI.Button>
                  </UI.Stack>
                </form>
              )}
            <ActionLink href="?" onActivate={props.onCancel}>
              {translate("passkeys.remove.cancel")}
            </ActionLink>
          </UI.FormContent>
        </SecurityAsyncBoundary>
      </UI.SettingsContent>
    );
  }

  return (
    <UI.SettingsContent data-testid="passkeys-list">
      <UI.AuthHeading
        description={translate("passkeys.description")}
        title={translate("passkeys.title")}
      />
      <SecurityAsyncBoundary
        {...base}
        emptyAction={
          <RouterLink to={props.addTo} variant="primaryButton">
            {translate("passkeys.addAction")}
          </RouterLink>
        }
      >
        {props.notice === null
          ? null
          : <UI.InlineNotice tone="success">{props.notice}</UI.InlineNotice>}
        {props.passkeys.length === 0
          ? (
            <UI.InlineNotice tone="neutral">
              {translate("passkeys.noneNotice")}
            </UI.InlineNotice>
          )
          : (
            <UI.Stack
              aria-label={translate("passkeys.listLabel")}
              data-testid="passkeys-rows"
              gap="compact"
              role="list"
            >
              {props.passkeys.map((passkey) => (
                <div key={passkey.id} role="listitem">
                  <UI.DescriptionItem
                    action={
                      <UI.Inline gap="standard">
                        <ActionLink
                          aria-label={translate("passkeys.renameAria", {
                            name: passkey.name,
                          })}
                          data-passkey-opener={`rename:${passkey.id}`}
                          href={`?rename=${encodeURIComponent(passkey.id)}`}
                          onActivate={() => {
                            openerRef.current = `rename:${passkey.id}`;
                            props.onRename(passkey.id);
                          }}
                        >
                          {translate("passkeys.renameLink")}
                        </ActionLink>
                        <ActionLink
                          aria-label={translate("passkeys.removeAria", {
                            name: passkey.name,
                          })}
                          data-passkey-opener={`remove:${passkey.id}`}
                          href={`?remove=${encodeURIComponent(passkey.id)}`}
                          onActivate={() => {
                            openerRef.current = `remove:${passkey.id}`;
                            props.onRemove(passkey.id);
                          }}
                        >
                          {translate("passkeys.removeLink")}
                        </ActionLink>
                      </UI.Inline>
                    }
                    description={passkey.description}
                    icon={<UI.IconGlyph name="key" size="large" />}
                    title={passkey.name}
                  />
                </div>
              ))}
            </UI.Stack>
          )}
        <UI.FormContent>
          <RouterLink
            data-passkey-add=""
            to={props.addTo}
            variant="primaryButton"
          >
            {translate("passkeys.addAction")}
          </RouterLink>
        </UI.FormContent>
        <UI.Text variant="hint">{translate("passkeys.privacyHint")}</UI.Text>
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}
