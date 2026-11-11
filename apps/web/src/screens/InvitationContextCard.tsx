import type { OrganizationRole } from "@bakery/contracts/contracts";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type InvitationRole = OrganizationRole;

const ROLE_KEY: Readonly<Record<InvitationRole, MessageKey>> = {
  admin: "auth.invitation.role.Admin",
  developer: "auth.invitation.role.Developer",
  viewer: "auth.invitation.role.Viewer",
  guest: "auth.invitation.role.Guest",
};

/** The catalog's role labels, keyed by the wire enum (`auth.js` "Developer"). */
export function invitationRoleMessageKey(role: InvitationRole): MessageKey {
  return ROLE_KEY[role];
}

export type InvitationContextCardProps = {
  readonly organizationName: string;
  /**
   * The Admin who sent the invitation (`inviterDisplayName` on the
   * preview). Null when the inviting principal no longer exists — the
   * column then shows the role row alone rather than an empty identity.
   */
  readonly inviterDisplayName: string | null;
  readonly role: InvitationRole;
};

/**
 * Paper's `contextShell` summary column (`auth.js` L94): the organization
 * glyph, "You're joining {organization}", the "A Bakery organization"
 * subtitle, the inviter and role identity rows, and the closing hint the
 * phone artboard drops.
 *
 * Returns the aside's children directly — `UI.AuthEntry`'s `context` slot
 * *is* `.context-summary`, which already owns the 24px column — so every
 * screen built on the context shell (`invite`, `invite-login`, `register`)
 * passes this one node and cannot drift from the others.
 */
export function InvitationContextCard(
  { inviterDisplayName, organizationName, role }: InvitationContextCardProps,
) {
  const { translate } = useI18n();
  return (
    <>
      <UI.IconGlyph name="building" size="large" />
      {
        /* auth.js L94 `<h2>You’re joining<br>Northstar</h2>`: the break is part
          of the composition, not a consequence of the 244px measure. */
      }
      <UI.Heading level="section">
        {translate("auth.invitation.contextGreeting")}
        <br />
        {organizationName}
      </UI.Heading>
      <UI.Text variant="muted">
        {translate("auth.invitation.contextSubtitle")}
      </UI.Text>
      <UI.DescriptionList>
        {inviterDisplayName === null ? null : (
          <UI.DescriptionItem
            description={translate("auth.invitation.contextInviterCaption")}
            icon={<UI.IconGlyph name="person" size="large" />}
            title={inviterDisplayName}
          />
        )}
        <UI.DescriptionItem
          description={translate("auth.invitation.contextRoleCaption")}
          icon={<UI.IconGlyph name="lock" size="large" />}
          title={translate(invitationRoleMessageKey(role))}
        />
      </UI.DescriptionList>
      <UI.Text variant="hint">
        {translate("auth.invitation.contextHint")}
      </UI.Text>
    </>
  );
}
