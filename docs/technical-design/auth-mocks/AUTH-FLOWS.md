# Authentication · screen and flow contract

Status: design work. Composition approved: B for sign-in, C for invitations; no authentication service is implemented here.
This page extends the current enterprise design. Fixtures use example.com addresses and fictitious organizations.

Review: [interactive page](index.html) · 37 responsive screens, 138 selectable states,
paired phone/desktop captures, shared primitive sheet, four transactional email designs.
The approved sign-in composition uses the full logo above **Fresh commits, coming right up.**
No header bar appears inside that sign-in screen. Invitation flows use the approved context layout.

Validation: [verification.json](verification.json) records 498 layout cases and the tested
sign-in, invitation, recovery, consent, session and gallery interactions. The gallery uses
fixed device viewports with normal vertical scrolling. Follow-up checks verified gallery
height stability and invitation sign-in continuity at 320, 390 and 1440px.
[Protection checks](protection-verification.json) cover authenticator enrollment, code entry,
backup-code copy/download, recovery sign-in, invitation continuity and passkey management.
Visual review was performed in this thread; side-conversation rules prohibit subagents.
The approved designs are also in the existing Bakery Paper file, on one
[Authentication page](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/V-0):
552 editable screen artboards covering all 138 states in desktop/phone and light/dark,
plus an overview. This includes the email designs and shared authentication primitives.
[paper-manifest.json](paper-manifest.json) maps each screen/state/theme/device to its Paper node.
Storybook publication and real authentication remain separate work.

## Settled product boundaries

- Invitation-only email/password accounts. Optional GitHub sign-in appears only when configured.
- First installation Admin is bootstrapped through the local CLI; email delivery and a hosted identity provider are not bootstrap dependencies.
- Multiple organizations and members exist from the first release. Admin/Developer is an organization membership, never a role a new user chooses.
- Public registration, billing/subscription provisioning and SSO remain separate future product decisions. Authenticator-app TOTP, backup codes and optional passkey settings are included in the design. A direct registration visit without a valid invitation explains how to join; it does not silently open public signup.
- User GitHub sign-in authenticates a person. Installing the GitHub integration authorizes repositories in a separate flow.
- Web and desktop share the same account UI. Desktop uses the browser for provider authorization and a validated return path.
- Better Auth owns /api/auth/*; Bakery domain operations remain /v1. Browser sessions, MCP consent and worker enrollment are separate authorities.

## Approved layout direction

A · Focused entry: a 380px unboxed form with generous space.
B · Context beside the form: a product-context pane beside the same form.
C · Destination-aware entry: invitation destination and access summary beside the form.

Approved: B for routine access; C when there is an invitation or a consent request. B has no header bar. Its full logo is centered above Fresh commits, coming right up. On phone, the logo remains and supplemental product copy yields to the form.
All use current DESIGN.md roles, Geist, a small existing conveyor logo and familiar controls. Images are composition studies, not pixel specifications. Their text and incidental controls will be replaced by semantic, accessible UI.

Phone: one column, 16px gutters, 44px controls, 16px editable text; invitation summary precedes the form. Supplemental product context is omitted at narrow widths. No horizontal panning or shrunken desktop image.
Tablet: form remains a readable width; essential context stacks until it can fit comfortably.
Desktop: restrained form width, optional adjacent context; authenticated settings restore the approved icon rail.
Light and dark themes use the same geometry and explicit semantic colors.

## Entry and registration

| Screen | User sees / does | Next step and edge states |
| --- | --- | --- |
| Sign in | Email, password with reveal, Sign in, Forgot password; conditional GitHub option | Restore an authorized destination, or choose an organization. Submitting, invalid credentials, unverified email, throttled, unavailable and offline states |
| Invitation required | “Bakery accounts are created through invitations.” | Sign in or use the invitation from an Admin. No inert public signup form |
| Invitation landing | Validated organization name, invited identity, inviter and role; Accept invitation or Create account | Missing, expired, revoked, already accepted and wrong-account states; no sensitive organization details before verification of the invitation |
| Create account | Invited email, full name, new password; immutable invited email explained | Server checks the invitation again. Existing account leads to sign-in/recovery without an open account-enumeration endpoint. Registration does not itself confer membership |
| Verify email | Destination, Check your email, resend status and safe return action | Verified, expired, already used, delivery unavailable and resend cooldown. Show only when server policy requires verification |
| Registration complete | Account created; named invitation still pending | Accept invitation once identity is proven; retain a recoverable pending invitation if acceptance fails |
| Accept invitation | Explicit organization and Admin/Developer access summary, accept/decline | Recheck email, invitation expiry, revocation and role server-side. Success enters that organization; repeated acceptance returns the existing membership |
| Wrong account | “This invitation is for a different email address.” | Switch account, keep invitation context; never transfer the invitation to the current identity |

## Recovery and provider sign-in

| Screen | User sees / does | Next step and edge states |
| --- | --- | --- |
| Forgot password | Email and Send reset link | Generic response irrespective of account existence; submitting, invalid format, cooldown, offline, delivery unavailable |
| Reset requested | “If this account can be reset, we’ll send an email.” | Change email, resend when allowed, back to sign-in. Do not claim an email was delivered |
| Set new password | New password and reveal; policy guidance | Validate token and password server-side. Invalid/expired/used token routes to a new reset request |
| Password updated | Clear success; sign in again | Design proposal: invalidate previous sessions on reset. Do not auto-enter the organization from an unverified URL |
| GitHub handoff | “Continue to GitHub to sign in.” | GitHub owns its actual credentials and consent page. Bakery preserves a validated destination and pending invitation |
| GitHub callback | Returning, completed, canceled or failed | Explicit retry/email sign-in; missing provider email and unlinked account get safe recovery. No automatic account merge solely on a matching email |
| Link GitHub account | Signed-in security settings, provider identity, explained purpose | Require fresh authentication and provider ownership proof; canceled, unavailable, already linked and unlink-with-no-other-method guards |

## Organizations and session boundaries

| Screen | User sees / does | Next step and edge states |
| --- | --- | --- |
| Choose organization | Authorized memberships with name and role; search if needed | Last authorized choice may be restored; pagination uses cursors if necessary. Never show another organization's private data |
| No organization access | Account identity and “You don’t belong to an organization yet.” | Join via invitation, refresh access or sign out. No unapproved unrestricted organization-creation button |
| Session expired | “Sign in to continue”; destination retained safely | Authentication returns to the same authorized location. Existing background work continues independently |
| Access removed | Access ended; organization switch / sign out | Stop protected subscriptions and clear that organization's query/document caches. Never render stale protected content behind a login overlay |
| Reauthenticate | Current identity, password or linked provider | Complete only the pending security action after a short-lived server check; canceled/expired/failed states |
| Sign out | Sign out this session; return to sign-in | No implication that workers stop or another device is signed out. Unsynced local edits receive a save/recovery path before clearing |
| Service unavailable | Readable reason, retry and safe return | Retain non-secret form context; no uncontrolled automatic retries or repeated provider popup loops |

## Account security

| Screen | User sees / does | Next step and edge states |
| --- | --- | --- |
| Account and security | Name, verified email, available sign-in methods, sessions | Desktop uses the approved app rail; phone has full settings navigation |
| Change password | Current password, new password, reveal and guidance | Reauthenticate; success and validation errors; preserve current session only under the selected server policy |
| Change email | New email, explanation of verification | Verify ownership before replacing the authoritative address; wrong/expired link, cancel and pending state |
| Active sessions | Current session identified, other device/session summaries, last activity | Revoke one or all other sessions with impact confirmation; approximate device metadata is not proof of identity |
| Revoke sessions | Number and scope of affected sessions; confirm/cancel | Already revoked, failure and success; current-session revocation redirects to sign-in |

## Two-factor authentication and passkeys

The canonical [implementation plan](../04-backend-and-errors.md#account-protection-totp-backup-codes-and-passkeys)
and [release gates](../15-implementation-readiness.md#delivery-acceptance) now include
these flows, provider-owned migrations and server enforcement.

Settings → Account and security exposes **Two-factor authentication** and **Passkeys**.
The existing rail, typography, form fields and notices are reused. Every new state has
phone/desktop and light/dark artboards on the same Authentication page.

| Flow | Design and recovery |
| --- | --- |
| Enable authenticator | Confirm identity → QR or manual setup key → verify a six-digit TOTP → save backup codes. Enrollment remains inactive until verification succeeds; expired setup restarts with a new key. |
| Verify sign-in | One text input with numeric keyboard, leading-zero support, paste and one-time-code autofill. Explicit Verify action; incorrect/expired code, pending request, rate limit and expired sign-in states. No resend button for app-generated codes. |
| Backup codes | Display the new set after creation; copy/download and explicit saved acknowledgement. Settings subsequently shows a remaining count, never the saved plaintext. Successful regeneration replaces all old codes atomically; failed verification leaves the old set intact. |
| Recovery sign-in | One unused backup code replaces the current TOTP challenge. Consume it only after successful verification; reject replay. Preserve a pending invitation or validated destination. Lost authenticator plus lost codes requires a separately verified recovery path. |
| Disable authenticator | Confirm identity and a current factor; clearly state that unused backup codes also stop working. Failure leaves protection on. A lost-factor user must recover access first. |
| Passkey settings | Empty/list, name, add, rename, remove, last-method guard and failed-removal states. Browser/device owns credential creation and user verification; canceled and unsupported states preserve other methods. Removing a Bakery credential does not delete the private key from a password manager. |

These are synthetic mocks. The QR uses a public demo key, and sample backup codes cannot
access an account. The passkey flow never calls a real credential ceremony. Mock transitions
are navigation fixtures, not evidence of server authentication or MFA enforcement.

Implementation boundary: Better Auth provides TOTP enrollment/verification and backup-code
operations, but its default second-factor enforcement covers credential sign-ins, not every
OAuth/passkey path. Bakery must enforce its required assurance on the server before granting
application access. The initial policy still requires TOTP or a backup code for enrolled
accounts after passkey sign-in; a client redirect or successful social login is not sufficient.
Passwordless accounts require fresh proof using an available method rather than a fabricated
password field. [Better Auth two-factor reference](https://better-auth.com/docs/plugins/2fa),
[passkey reference](https://better-auth.com/docs/plugins/passkey), checked 2026-09-08.

Do not log TOTP keys, QR payloads, codes or credential challenges. Enrollment material is
short-lived and excluded from normal caches/analytics. Server-owned attempts, session and
assurance checks govern setup, recovery and removal. Sign-in routes remain inaccessible to
protected data while a required factor is pending. Backup-code storage, atomic consumption,
revocation and notification behavior need runtime tests before release.

## Related authorization surfaces

| Screen | User sees / does | Boundary |
| --- | --- | --- |
| MCP authorization | Verified client identity, Bakery organization, requested capabilities in plain language; Allow / Deny | OAuth provider owns consent transaction. Grant must be inside current membership and requested scopes. No passwords or tokens in the consent summary |
| MCP denied / complete | Access denied or client connected; safe return to caller | Do not imply denial revoked earlier grants. Client redirect must come from the validated transaction |
| Connected clients | Client, organization, granted capabilities and revoke action | OAuth grant revocation is distinct from browser session logout and GitHub integration removal |

### Shipped core scope (`?caps=core`)

The shipped product derives its V-0 references from this mock with `?caps=core`. Core keeps **password change, passkeys and connected clients** (hub rows, the Account and security navigation, the Clients link on phone) and keeps the Sign-in methods section. It still omits GitHub sign-in, password reset, email change and the email verification badge, which stay future decisions. The hub and the connected clients list are the `security` and `clients` artboards; the derived renders may be shorter than their Paper frames, never taller. Production routes: `/settings/security`, `/settings/security/password`, `/settings/security/passkeys`, `/settings/security/passkeys/new`, `/account/reauthenticate`, `/settings/clients`, `/settings/clients/revoke` and `/oauth/consent`.
| Return to desktop | “You’re signed in”; Open Bakery or continue in browser | Use registered callback/deep-link/loopback rules. No credentials in user-visible links or localStorage |
| Local setup handoff | Setup incomplete or ready; installation URL and next action | First Admin is still created by the local CLI. No public HTTP “make me Admin” flow |
| Local recovery without email | Explain that email recovery is unavailable on this installation | Explicit installation-owner recovery procedure; never imply any org Admin can reset arbitrary users |

## Error and privacy behavior

- Required inputs use persistent labels, associated hints/errors and focus on the first invalid field after submission.
- Never show raw Better Auth/provider exceptions. The client maps protocol-safe codes to shared translated UI messages. Bakery-owned domain HTTP errors use the existing StandardError / RFC 9457 path; OAuth endpoints retain OAuth envelopes.
- Incorrect email/password is one generic failure. Recovery and verification responses do not reveal whether an address has an account.
- Reset/verification/invitation tokens are single-use and expiring. Use explicit actions for mutations; email previews/scanners must not accept an invitation.
- Preserve return intent as a validated same-origin route or server-owned identifier. Reject external return URLs; recheck destination authorization after login.
- Never persist passwords or tokens in localStorage, analytics, screenshots, copied diagnostics or URLs intended for sharing. Login context contains no cached protected document body.
- Rate-limit feedback uses the server's retry information; mock countdown durations are illustrative. Resend errors never claim successful delivery.
- One form submission at a time; stable button width and loading label. Network retries must not create duplicate accounts or consume invitations twice.
- Session revocation closes protected streams and removes tenant caches; authentication refresh must not recover removed permissions.
- New organization roles and sensitive account recovery are never selected or elevated by a client-supplied field.

## Shared primitive inventory

Reuse @bakery/ui contracts: LogoMark, Text/Heading, Field, Button, Link, IconButton,
InlineNotice, AlertBanner, StatusLabel, ObjectRow, Dialog, ThemeProvider and
ApplicationRail. Add auth-specific compositions rather than a second button/input system.

Each primitive needs default/hover/focus/pressed/disabled/loading/error as applicable.
Password reveal has an accessible toggle name and state; autocomplete uses email,
current-password or new-password correctly; paste and password managers remain supported.
Status changes use polite announcements; blocking submission errors use alert semantics.
Focus moves on route change and returns to the trigger after dialogs.

## Mock and handoff acceptance

- Every screen/state above has a phone and desktop composition, including errors and unavailable methods.
- Review at 320, 390, 744, 1280 and 1440 CSS pixels; 200% zoom, keyboard, coarse pointer, reduced motion, long names, pseudo-locale and RTL.
- Theme resolves before paint. There are no hover-only actions, inaccessible icon buttons, clipped consent scopes or modal focus escapes.
- No animated background or generated imagery containing a functional control. Image directions are references; real text remains selectable semantic HTML.
- Keep email templates readable at phone width: invitation, verification, reset and security-change notices. Each states the intended action, expiry, destination and ignore/recovery guidance without leaking a password.
- Paper handoff: primitive variants first, then shared auth layout/form/context compositions; pair phone/desktop artboards. Export exact node IDs and a manifest after user approves composition.
- Storybook handoff: reuse the same semantic components and synthetic fixtures, with light/dark and input states; no authentication network required to review.
- A static prototype must disclose that submission, mail delivery and provider authorization are simulated.
- Runtime verification remains separate: cross-organization isolation, invitation races, enumeration resistance, CSRF/Origin checks, rotation/revocation, safe redirects and provider callback failures.

## Decisions still needed for implementation

These do not block layout review: exact password policy; whether validated email invitations
satisfy mailbox verification in the chosen implementation; mail delivery/recovery configuration;
fresh-auth windows and session durations; desktop callback mechanism. Keep these configurable or
provider-owned only where the real contract calls for it, not as speculative user-facing settings.

## Sources

Current product choices: [Product](../PRODUCT.md), [identity boundary](../README.md#identity-and-authority),
[design system](../DESIGN.md), [frontend rail](../03-frontend-and-design-system.md),
[standard errors](../12-standard-errors.md).

Verified provider references (2026-09-07): [Better Auth email/password](https://better-auth.com/docs/authentication/email-password),
[organizations](https://better-auth.com/docs/plugins/organization),
[GitHub sign-in](https://better-auth.com/docs/authentication/github).
The route inventory above is Bakery's proposed UX design, not a list of already implemented provider endpoints.
