import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { CopyValueButton } from "./CopyValueButton.tsx";

/** The DNS host a provider's verification record is published at. */
export function verificationHost(
  provider: Readonly<{ providerId: string; domain: string }>,
): string {
  return `_bakery-verify-${provider.providerId}.${provider.domain}`;
}

/**
 * The TXT record an administrator publishes to prove control of a domain: its
 * type, host and value, each with a Copy button, the help line, and the check.
 * After a check that found nothing the check becomes a notice that says what
 * happened and offers "Check again".
 */
export function DomainVerificationRecord(
  { provider, token, checking, checkFailed, onCheck, testId }: Readonly<{
    provider: Readonly<{ providerId: string; domain: string }>;
    /** The pending record value; "…" shows until the server has issued it. */
    token: string | undefined;
    checking: boolean;
    /** The last check of this provider found no record. */
    checkFailed: boolean;
    onCheck: () => void;
    testId?: string;
  }>,
) {
  const { translate } = useI18n();
  const host = verificationHost(provider);
  const checkLabel = translate("settings.sso.verify.checkLabel", {
    name: provider.providerId,
  });
  return (
    <UI.Stack gap="compact" data-testid={testId}>
      <UI.Text variant="muted">
        {translate("settings.sso.verify.help", { domain: provider.domain })}
      </UI.Text>
      <UI.DescriptionList>
        <UI.DescriptionItem
          description={<UI.DataText variant="code">TXT</UI.DataText>}
          title={translate("settings.sso.verify.type")}
        />
        <UI.DescriptionItem
          action={
            <CopyValueButton
              label={translate("settings.sso.verify.copyHost")}
              value={host}
            />
          }
          actionPlacement="below"
          description={
            <UI.DataText
              data-testid="sso-txt-host"
              state="wrapped"
              variant="code"
            >
              {host}
            </UI.DataText>
          }
          title={translate("settings.sso.verify.host")}
        />
        <UI.DescriptionItem
          action={token
            ? (
              <CopyValueButton
                label={translate("settings.sso.verify.copyValue")}
                value={token}
              />
            )
            : undefined}
          actionPlacement="below"
          description={
            <UI.DataText
              data-testid="sso-txt-value"
              state="wrapped"
              variant="code"
            >
              {token ?? "…"}
            </UI.DataText>
          }
          title={translate("settings.sso.verify.value")}
        />
      </UI.DescriptionList>
      {checkFailed && !checking
        ? (
          <UI.InlineNotice
            action={
              <UI.Button
                aria-label={translate("settings.sso.verify.checkAgainLabel", {
                  name: provider.providerId,
                })}
                type="button"
                variant="outline"
                onClick={onCheck}
              >
                {translate("settings.sso.verify.checkAgain")}
              </UI.Button>
            }
            data-testid="sso-check-failed"
            role="status"
            tone="warning"
          >
            {translate("settings.sso.verify.pending")}
          </UI.InlineNotice>
        )
        : (
          <UI.Inline>
            <UI.Button
              aria-label={checkLabel}
              loading={checking}
              type="button"
              variant="outline"
              onClick={onCheck}
            >
              {translate("settings.sso.verify.check")}
            </UI.Button>
          </UI.Inline>
        )}
    </UI.Stack>
  );
}
