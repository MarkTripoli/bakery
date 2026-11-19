import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import type { SsoOverview, SsoProvider } from "../api/sso.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** What removing one provider does to the people of its organization. */
export type RemovalSituation =
  /** SSO is not required: members keep password and passkey sign-in. */
  | "notRequired"
  /** SSO is required and another verified provider remains. */
  | "otherRemains"
  /** SSO is required and this is the only verified provider: removal also ends the requirement. */
  | "onlyVerified"
  /** The provider's domain was never verified: nobody signs in through it. */
  | "neverVerified";

/** The situation, from the overview the page last loaded, for one provider. */
export function removalSituation(
  overview: SsoOverview,
  provider: SsoProvider,
): RemovalSituation {
  if (!provider.domainVerified) return "neverVerified";
  if (!overview.enforce) return "notRequired";
  const another = overview.providers.some((other) =>
    other.providerId !== provider.providerId && other.domainVerified
  );
  return another ? "otherRemains" : "onlyVerified";
}

/** Why the last attempt did not remove the provider; the dialog stays open on both. */
export type RemovalProblem = "failed" | "outOfDate";

type Line = {
  readonly key: MessageKey;
  readonly values?: Record<string, string>;
};

/** The lines that apply to a situation, in reading order. */
function linesFor(
  situation: RemovalSituation,
  provider: SsoProvider,
): readonly Line[] {
  const domain = { domain: provider.domain };
  switch (situation) {
    case "notRequired":
      return [
        { key: "settings.sso.provider.delete.line.stayMembers" },
        { key: "settings.sso.provider.delete.line.passwordOrPasskey" },
        { key: "settings.sso.provider.delete.line.sessions" },
        {
          key: "settings.sso.provider.delete.line.verification",
          values: domain,
        },
      ];
    case "otherRemains":
      return [
        { key: "settings.sso.provider.delete.line.stayMembers" },
        {
          key: "settings.sso.provider.delete.line.stillRequired",
          values: domain,
        },
        { key: "settings.sso.provider.delete.line.sessions" },
        {
          key: "settings.sso.provider.delete.line.verification",
          values: domain,
        },
      ];
    case "onlyVerified":
      return [
        { key: "settings.sso.provider.delete.line.stayMembers" },
        { key: "settings.sso.provider.delete.line.passwordOrPasskey" },
        { key: "settings.sso.provider.delete.line.sessions" },
        {
          key: "settings.sso.provider.delete.line.verification",
          values: domain,
        },
      ];
    case "neverVerified":
      return [{
        key: "settings.sso.provider.delete.line.neverOn",
        values: { name: provider.providerId },
      }];
  }
}

/**
 * Confirms removing one SSO provider. The title, the lines and the button
 * follow what the removal will do (see `removalSituation`); when it also ends
 * the SSO requirement, the title, a warning and the button all say so.
 */
export function SsoRemoveDialog(
  { busy, onCancel, onConfirm, problem, provider, situation }: {
    readonly busy: boolean;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
    readonly problem: RemovalProblem | null;
    readonly provider: SsoProvider;
    readonly situation: RemovalSituation;
  },
) {
  const { translate } = useI18n();
  const stopsRequiring = situation === "onlyVerified";
  const name = { name: provider.providerId };
  return (
    <UI.AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      state={busy ? "confirming" : "open"}
      title={translate(
        stopsRequiring
          ? "settings.sso.provider.delete.titleStopRequiring"
          : "settings.sso.provider.delete.title",
        name,
      )}
      variant="destructive"
      data-actions-layout="stack"
      data-testid="sso-remove-dialog"
      data-situation={situation}
      cancelAction={
        <UI.Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {translate("settings.sso.dialog.cancel")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          type="button"
          variant="destructive"
          loading={busy}
          onClick={onConfirm}
        >
          {translate(
            stopsRequiring
              ? "settings.sso.provider.delete.confirmStopRequiring"
              : "settings.sso.provider.delete.confirm",
          )}
        </UI.Button>
      }
    >
      <UI.Stack gap="compact">
        {problem
          ? (
            <UI.InlineNotice tone="error" data-testid="sso-remove-problem">
              {translate(
                problem === "outOfDate"
                  ? "settings.sso.provider.delete.outOfDate"
                  : "settings.sso.provider.delete.failed",
                name,
              )}
            </UI.InlineNotice>
          )
          : null}
        {stopsRequiring
          ? (
            <UI.InlineNotice tone="warning">
              <strong>
                {translate("settings.sso.provider.delete.onlyProvider.title")}
              </strong>{" "}
              {translate("settings.sso.provider.delete.onlyProvider.body")}
            </UI.InlineNotice>
          )
          : null}
        {situation === "neverVerified" ? null : (
          <UI.Text>
            {translate("settings.sso.provider.delete.body", {
              domain: provider.domain,
            })}
          </UI.Text>
        )}
        {linesFor(situation, provider).map((line) => (
          <UI.Text key={line.key}>{translate(line.key, line.values)}</UI.Text>
        ))}
        <UI.Text variant="muted">
          {translate(
            stopsRequiring
              ? "settings.sso.provider.delete.auditBoth"
              : "settings.sso.provider.delete.audit",
          )}
        </UI.Text>
      </UI.Stack>
    </UI.AlertDialog>
  );
}
