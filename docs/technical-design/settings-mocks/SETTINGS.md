# Settings

<!--
THESIS: Settings manages personal preferences and explains the user's own access.
OWN-WORLD: Extend Bakery's approved Geist, neutral surfaces, cobalt selection,
208px application rail, aligned rows and explicit light/dark token maps.
STORY: Manage your account, appearance and sessions, then inspect your own access.
FIRST VIEWPORT: Current workspace and role provide context; the personal form or
read-only access summary leads. On phone, use one column with 44px controls.
FORM: Extend the established settings surface. No new visual-world selection.
-->

Mode: Operate. Editable design in [Paper](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/O-0).

One **Settings** page owns the former Settings and User settings designs,
including account actions and recovery states. Duplicate profile/overview designs
and their empty Paper pages were removed. Profile retains display name, first
name, last name, job title and photo URL. Language and time zone live in Appearance.

## Shared section navigation

The text-first 224px sub-sidebar from the original Account & permissions design
is now the [repo-wide SectionNavigation standard](../DESIGN.md#section-navigation),
also required by [the engineering rules](../../engineering-rules.md). Desktop and phone use one ordered
route list:

| Section | Route | Scope |
| --- | --- | --- |
| Profile | `/settings/profile` | Own account identity across organizations |
| Account & security | `/settings/security` | Own sign-in methods, password and email |
| Active sessions | `/settings/sessions` | Own signed-in devices and session revocation |
| Connected clients | `/settings/clients` | Own authorized clients and consent revocation |
| Appearance | `/settings/appearance` | Private preferences in the selected organization: theme, language and time zone |
| Your access | `/settings/access` | Current user's effective access in the selected organization, read-only |

`/settings` opens Profile on desktop and the section index on phone. The account
menu and app rail both say Settings and use this same destination. Detail/action
routes keep their parent selected. Desktop uses restrained text links; phone
uses aligned full-width rows and a Settings return link. Organization administration
is not a personal section. Legacy native-workbench extension specimens remain
outside this account-area consolidation; revised screens there follow the same
shared navigation standard.

The user selected **custom roles with explicit capabilities** as the future
direction. Admin and Developer remain the only current organization roles.
All identities, roles and example grants in these designs are sample data.
These are proposed interface designs, not evidence of implemented authorization.

## Authority and scope

| Boundary | Current model | Settings behavior |
| --- | --- | --- |
| Personal | Account identity; private organization-specific presentation preferences | Every member can manage their own account, theme and sessions. No self-service role picker. |
| Your access | Live Admin or Developer role in the selected workspace | Show only the current user's role and effective access. This view cannot change roles, members or grants. Switching workspaces refreshes the summary. |
| Repository and external resource | Explicit repository access and action/resource grants | Display the connection, exact granted actions and selected resource read-only. Role alone does not authorize external actions. |
| Future custom role | Proposed additive, explicit capability definitions | Show the assigned role's capabilities and repository scope read-only. Personal preferences remain available for every role. |

Organization members, invitations, role changes, custom-role definitions and
organization administration belong exclusively to the separate Organization
page. Installation administration also belongs outside this personal settings
surface and requires its own explicit grant. Neither is in settings navigation.

The future assigned-role example includes only read/comment/resolve in Bakery,
with no organization-wide or external actions. It illustrates restricted
navigation and a read-only summary; it is not a role editor.

Current source: [authorization](../04-backend-and-errors.md#auth-authorization-and-secret-handling),
[organization operations](../api-catalog.json), [integration grants](../09-integrations.md),
[account/security](../auth-mocks/AUTH-FLOWS.md), and [preferences](../01-data-model.md).
The effective-access projection requires implementation design; no endpoint or
runtime behavior is claimed by this mock.

## Interaction and recovery

Profile fields map to [the canonical personal user profile](../01-data-model.md#personal-user-profile):
Display name → `name`, First name → `firstName` / `first_name`, Last name →
`lastName` / `last_name`, Job title → `title`, and Profile photo URL → the existing
`image` field. Only Display name is required. Names and title accept Unicode;
optional blanks clear to null. Existing display names are never split or overwritten
from name parts. These details belong to the user's account across workspaces.
Use native name/given-name/family-name/organization-title autofill, associated
visible labels and a URL keyboard for the photo field. Validation names the field
and limit; keep all draft values when saving fails.

The initial image control accepts a validated HTTPS image link. The existing
avatar previews the saved image or falls back to initials. A failed image keeps
the fallback and a readable error; it never blocks access to the profile form.
Clear the URL to remove the photo. File uploads are outside this URL-based control.

- Personal account, appearance and session controls are available to Admin,
  Developer and future custom roles. No role picker or permission editor appears
  in personal settings. Your access remains read-only for all roles.
- If workspace access is removed, clear protected access results and offer a
  return to personal settings. Do not render stale protected content. The user's
  own account controls remain available.
- Recheck authorization on every access-summary request. Hiding navigation never
  replaces the server's current membership/resource check.
- Unsaved profile changes: Save profile owns name, title and image changes; appearance updates
  immediately. Save errors preserve the draft. Save success announces once.
- Stale access data offers an explicit refresh. Loading preserves section
  geometry; the no-grant state explains that no external actions are available.
  Offline profile edits retain the draft and never report success.
- Notification delivery preferences remain **Future concept** Settings specimens.
  The new [Notifications inbox](../24-mentions-and-notifications.md) is a separate
  destination reached through the global bell. Future push preferences will use
  this same Settings section navigation after their contract is reconciled.
- Appearance saves theme immediately. Language/time-zone changes use Save
  preferences, retain drafts on error and do not rewrite scheduled-work time zones.
- Password validation, email verification pending, sign-out-other-sessions and
  client-revocation confirmation retain desktop/phone states. Sign-out explains
  that agents and scheduled work continue; revocation names the affected device
  or client. Account changes use the auth provider's authenticated flows.

## Responsive and accessible behavior

- Sheet 320–743px: one settings subroute, 16px gutters, no horizontal tables;
  all actionable rows provide at least 44px targets; editable input text is 16px.
- Pane 744–1279px: use the existing 56px compact application rail, then settings
  navigation/content when each fits; otherwise open navigation as a sheet.
- Rail 1280px+: 208px app rail, 224px settings navigation, 40px content gutters.
- Role names wrap; authorization status never relies on color alone. Use semantic
  input/label relationships, a visible cobalt focus ring and live save/error
  announcements during implementation. Check zoom, RTL, pseudo-locale and keyboard
  behavior in the actual runtime; static Paper frames do not verify those lanes.
- Personal account views are light; effective-access views demonstrate the
  authored dark map. Both maps apply to all shared components during implementation.

## Surface ownership

Settings owns personal scope, the full account/security design flows,
role-aware visibility and the user's own effective access. The Organization page owns all member and role management,
including cursor pagination and the mobile overflow menu → Change role flow.
The existing visual authority remains [DESIGN.md](../DESIGN.md) and the Paper file.

## Delivered artifacts and review

[paper-manifest.json](paper-manifest.json) indexes 28 product/state specimens
and two guides on one Settings page, with local PNG exports. It includes both
appearance themes, account-menu/phone-index variants and four account-action pairs.
It records which frames represent the current model and future concepts.

Impeccable scope refinement removed the organization member screens, custom-role
editors, member navigation and member links. The remaining screens preserve exact
GitHub connection/resource identity and the future role's comment/resolve scope.
Final screenshots and export dimensions were checked. Static Paper designs do
not verify runtime, keyboard, screen-reader or server authorization behavior.

Profile schema additions, provider field mappings, access ERD and technical-map
inventory were synchronized, including the self-only profile
allowlist/storage-mapping check. No
database migration or profile runtime was executed.
