/* Static auth design fixtures. No real credentials, auth requests, emails or provider callbacks. */
const SCREENS = [
  [
    "login",
    "Sign in",
    "/sign-in",
    [
      "default",
      "invalid",
      "unverified",
      "loading",
      "throttled",
      "offline",
      "unavailable",
      "github-disabled",
    ],
    "B · Full logo above the bakery copy. Optional GitHub appears only when configured.",
  ],
  [
    "join",
    "Invitation required",
    "/register",
    ["default"],
    "Closed registration explains the invitation path; public SaaS signup remains out of scope.",
  ],
  [
    "invite",
    "Accept an invitation",
    "/invitations/:invitationId",
    [
      "default",
      "authenticated",
      "wrong-account",
      "expired",
      "revoked",
      "accepted",
      "declined",
      "loading",
    ],
    "C · Keep organization, invited identity and role visible before acceptance.",
  ],
  [
    "invite-login",
    "Sign in to accept",
    "/sign-in?invitation=…",
    ["default", "invalid", "loading"],
    "C · Preserve the invited destination through sign-in; accept separately after authentication.",
  ],
  [
    "register",
    "Create your account",
    "/register?invitation=…",
    ["default", "invalid", "existing", "loading"],
    "Invited email is fixed. Account creation does not grant membership until invitation acceptance.",
  ],
  ["verify", "Verify your email", "/verify-email", [
    "default",
    "success",
    "expired",
    "used",
    "resent",
    "cooldown",
    "unavailable",
  ], "Server policy determines when mailbox verification is required."],
  ["forgot", "Request a password reset", "/forgot-password", [
    "default",
    "sent",
    "loading",
    "throttled",
    "offline",
  ], "Generic response protects account existence; delivery is not claimed."],
  ["reset", "Set a new password", "/reset-password", [
    "default",
    "invalid",
    "expired",
    "used",
    "success",
    "loading",
  ], "Expiring reset token, password-manager support and explicit completion."],
  [
    "github",
    "GitHub sign-in handoff",
    "/auth/return/github",
    [
      "default",
      "returning",
      "canceled",
      "failed",
      "missing-email",
      "unlinked",
      "success",
    ],
    "Provider credentials and consent live on GitHub. This does not install the repository integration.",
  ],
  ["organizations", "Choose an organization", "/organizations", [
    "default",
    "empty",
    "removed",
    "loading",
  ], "Only current memberships appear; a role belongs to this organization."],
  [
    "expired",
    "Session expired",
    "/sign-in?reason=expired",
    ["default"],
    "Return to the same authorized destination after sign-in; work continues.",
  ],
  ["reauth", "Confirm your identity", "/account/reauthenticate", [
    "default",
    "invalid",
    "loading",
  ], "Fresh authentication precedes a sensitive account action."],
  [
    "security",
    "Account and security",
    "/settings/account",
    ["default", "saved", "protected"],
    "Account sign-in methods, authenticator protection and optional passkeys.",
  ],
  ["password", "Change password", "/settings/account/password", [
    "default",
    "invalid",
    "success",
    "loading",
  ], "Confirm current credentials, then replace the password."],
  [
    "email",
    "Change email",
    "/settings/account/email",
    ["default", "pending", "expired", "success"],
    "Current email remains authoritative until ownership of the new address is verified.",
  ],
  ["sessions", "Active sessions", "/settings/account/sessions", [
    "default",
    "revoked",
    "empty",
  ], "Identify the current device and make revocation impact explicit."],
  ["revoke", "Revoke sessions", "/settings/account/sessions/revoke", [
    "default",
    "success",
    "failed",
  ], "Confirmation is scoped to other sessions; it does not stop workers."],
  [
    "signout",
    "Sign out",
    "/sign-out",
    ["default", "unsynced", "success"],
    "Separate browser logout from background work and other sessions.",
  ],
  [
    "consent",
    "Authorize an MCP client",
    "/oauth/consent",
    ["default", "denied", "success", "expired"],
    "Verified client, chosen organization and readable requested scopes. No broader grant than current membership.",
  ],
  [
    "clients",
    "Connected clients",
    "/settings/account/clients",
    ["default", "revoked", "empty"],
    "OAuth grant revocation is separate from session logout or integration removal.",
  ],
  [
    "revoke-client",
    "Revoke a client grant",
    "/settings/account/clients/:id/revoke",
    ["default", "failed"],
    "Name the client, organization and lost capabilities before revocation.",
  ],
  [
    "link-github",
    "Link a sign-in method",
    "/settings/account/sign-in-methods/github",
    ["default", "confirm", "connected", "canceled", "conflict", "last-method"],
    "Fresh authentication and provider ownership precede linking. Keep a usable method before unlinking.",
  ],
  ["desktop", "Return to desktop", "/auth/desktop/complete", [
    "default",
    "blocked",
  ], "Browser authorization returns through a validated native callback."],
  [
    "setup",
    "Local installation access",
    "/setup",
    ["default", "ready", "recovery"],
    "First Admin remains a local CLI action; no email or external provider is needed to bootstrap.",
  ],
  [
    "mail-invite",
    "Email · Invitation",
    "email / invitation",
    ["default"],
    "Responsive transactional email; illustrative expiry and destination.",
  ],
  [
    "mail-verify",
    "Email · Verification",
    "email / verification",
    ["default"],
    "One explicit verification action; safe ignore guidance.",
  ],
  ["mail-reset", "Email · Password reset", "email / password-reset", [
    "default",
  ], "No passwords in messages; an expiring action and clear ignore guidance."],
  ["mail-security", "Email · Security notice", "email / security-change", [
    "default",
  ], "Direct recovery path if the change was not made by the recipient."],
  [
    "primitives",
    "Auth primitives",
    "design-system / authentication",
    ["default"],
    "Shared controls and status states; no separate auth button or input system.",
  ],
  [
    "two-factor",
    "Two-factor authentication",
    "/settings/account/two-factor",
    ["default", "enabled", "no-codes"],
    "Authenticator-app codes and one-use recovery codes. Protection is active only after enrollment verification.",
  ],
  [
    "totp-setup",
    "Set up an authenticator",
    "/settings/account/two-factor/setup",
    ["default", "scan", "invalid", "expired", "loading"],
    "Confirm identity, scan the QR or enter a setup key, then verify one six-digit code. All secrets shown are demo fixtures.",
  ],
  [
    "backup-codes",
    "Save backup codes",
    "/settings/account/two-factor/backup-codes",
    ["default", "copied", "regenerate", "invalid", "regenerated"],
    "Shown after creation only. Save them securely; replacing the set invalidates all previous codes after success.",
  ],
  [
    "totp-disable",
    "Turn off two-factor authentication",
    "/settings/account/two-factor/disable",
    ["default", "invalid", "disabled"],
    "Confirm identity and current second factor before removing protection. Failure leaves the authenticator and recovery codes active.",
  ],
  [
    "totp-challenge",
    "Enter an authentication code",
    "/sign-in/two-factor",
    ["default", "invalid", "loading", "rate-limited", "expired"],
    "One accessible six-digit input supports paste, leading zeros, autofill and a numeric keyboard.",
  ],
  [
    "backup-challenge",
    "Sign in with a backup code",
    "/sign-in/recovery-code",
    ["default", "invalid", "loading", "no-access"],
    "A backup code replaces the current TOTP challenge once. No self-service bypass if all recovery methods are lost.",
  ],
  [
    "passkeys",
    "Manage passkeys",
    "/settings/account/passkeys",
    ["default", "enabled", "rename", "remove", "blocked", "failed"],
    "Optional passwordless sign-in. Rename or remove a credential only for Bakery; retain another usable sign-in method.",
  ],
  [
    "passkey-add",
    "Add a passkey",
    "/settings/account/passkeys/new",
    ["default", "prompt", "canceled", "unsupported", "success"],
    "Confirm identity, name the passkey, and use the browser/device prompt. The prototype does not invoke a real credential ceremony.",
  ],
].map(([id, title, route, states, note]) => ({
  id,
  title,
  route,
  states,
  note,
}));
const ICONS = {
  eye:
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  mail:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  lock:
    '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.1"/>',
  chat:
    '<path d="M21 12a8 8 0 0 1-8 8H5l-4 3V11a9 9 0 0 1 20 1Z" transform="translate(1 -2) scale(.92)"/>',
  activity:
    '<path d="m3 17 5-5 5 3 7-10"/><circle cx="3" cy="17" r="1.5"/><circle cx="8" cy="12" r="1.5"/><circle cx="13" cy="15" r="1.5"/><circle cx="20" cy="5" r="1.5"/>',
  document:
    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h4"/>',
  building: '<path d="M4 21V3h11v18m0-12h5v12M2 21h20M8 7h3m-3 4h3m-3 4h3"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  computer:
    '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  phone:
    '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  sun:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  grid:
    '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>',
  plug: '<path d="M8 2v5m8-5v5M5 7h14v4a7 7 0 0 1-14 0V7Zm7 11v4"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  gear:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2m10-10 2-2"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-5-5 3-3m0 6 3-3"/>',
  github:
    '<path d="M9 19c-4 1.2-4-2-5-2m10 4v-3.2c0-.9-.3-1.5-.8-1.9 3-.4 6.1-1.5 6.1-6.8a5.3 5.3 0 0 0-1.4-3.7c.1-.4.6-1.9-.2-3.8 0 0-1.2-.4-3.9 1.4a13 13 0 0 0-7 0C4.1 1.2 3 1.6 3 1.6c-.8 1.9-.3 3.4-.2 3.8a5.3 5.3 0 0 0-1.4 3.7c0 5.3 3.1 6.4 6.1 6.8-.5.4-.8 1-.8 1.9V21" transform="translate(2 0) scale(.95)"/>',
};
const icon = (n) =>
  '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">' +
  (ICONS[n] || ICONS.document) + "</svg></span>";
const escapeHTML = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]),
  );
const el = (id) => document.getElementById(id);
const link = (text, to) =>
  '<a class="text-link" href="#' + to + '">' + text + "</a>";
const button = (text, to, kind = "primary") =>
  '<button class="btn ' + kind + ' full" type="button" data-go="' + to + '">' +
  text + "</button>";
const notice = (text, tone = "info") =>
  '<div class="notice ' + tone + '" role="' +
  (tone === "error" ? "alert" : "status") + '">' + icon(
    tone === "success"
      ? "check"
      : tone === "error" || tone === "warning"
      ? "alert"
      : "document",
  ) + "<div>" + text + "</div></div>";
const heading = (title, description) =>
  '<div class="form-heading"><h1 tabindex="-1">' + title + "</h1><p>" +
  description + "</p></div>";
function field(label, name, type = "text", options = {}) {
  const id = "field-" + name,
    hint = options.hint || "",
    error = options.error || "",
    password = type === "password";
  return '<div class="field"><label for="' + id + '">' + label +
    '</label><div class="input-wrap"><input id="' + id + '" name="' + name +
    '" type="' + type + '" ' + (options.readonly ? "readonly " : "required ") +
    (options.value ? 'value="' + escapeHTML(options.value) + '" ' : "") +
    'autocomplete="' +
    (password
      ? (name === "current-password" ? "current-password" : "new-password")
      : type === "email"
      ? "email"
      : name === "name"
      ? "name"
      : "off") +
    '" ' +
    (type === "email"
      ? 'inputmode="email" autocapitalize="none" spellcheck="false" '
      : "") +
    'placeholder="' + escapeHTML(options.placeholder || "") + '"' +
    (error ? ' aria-invalid="true"' : "") +
    ((hint || error) ? ' aria-describedby="' + id + '-hint"' : "") +
    (password ? " data-password" : "") + ">" +
    (password
      ? '<button type="button" class="reveal" data-reveal="' + id +
        '" aria-label="Show ' + label.toLowerCase() +
        '" aria-pressed="false">' + icon("eye") + "</button>"
      : "") +
    "</div>" +
    ((hint || error)
      ? '<p id="' + id + '-hint" class="' + (error ? "field-error" : "hint") +
        '">' + (error || hint) + "</p>"
      : "") +
    "</div>";
}
const form = (body, text, to) =>
  '<form class="stack" data-next="' + to + '">' + body +
  '<button class="btn primary full" type="submit">' + text + "</button></form>";
const identity = (symbol, title, body, action = "") =>
  '<div class="item">' + icon(symbol) + '<div class="grow"><h3>' + title +
  '</h3><p class="hint">' + body + "</p></div>" + action + "</div>";
/* ?caps=core renders the design as a core installation ships it: password sign-in, invitations, organizations,
   authenticator two-factor with backup codes, passkeys, password change, browser sessions and connected clients. Everything that needs an external
   identity provider or outbound email (GitHub sign-in, password reset, email change, the email-verification badge) is omitted, exactly as the
   login/github-disabled state already omits GitHub, and the preview-only review aids (sample-invitation notice,
   loading-state banner, the settings shell's preview caption, the demo-QR and sample-code disclaimers, the
   sessions' "synthetic device" suffix) are not rendered, and the copied-codes status drops its "Sample" qualifier. The Paper artboards stay the design
   of record; `core` is a documented derivation of them. */
const CAPABILITIES = new URLSearchParams(location.search).get("caps") === "core"
  ? "core"
  : "all";
const core = CAPABILITIES === "core";
const social = () =>
  core ? "" : '<div class="or">or</div>' +
    button(icon("github") + "Continue with GitHub", "github", "secondary");
const forgotLink = () => core ? "" : link("Forgot password?", "forgot");
const brandSmall = () =>
  '<a class="small-brand" href="#login"><img class="logo-light" src="favicon.png" alt=""><img class="logo-dark" src="favicon-dark.png" alt=""><span>Bakery</span></a>';
const themeButton = () =>
  '<button class="btn quiet theme-switch" type="button" data-theme-toggle aria-label="Toggle color theme">' +
  icon("sun") + "</button>";
const prototypeFooter = () =>
  '<span class="prototype-mark">Design preview · actions simulated</span>' +
  themeButton();
function authShell(body) {
  return '<div class="auth-layout"><aside class="brand-pane" aria-label="Bakery"><div class="brand-content"><img class="full-logo logo-light" src="logo.png" alt="Bakery"><img class="full-logo logo-dark" src="logo-dark.png" alt=""><h2>Fresh commits,<br>coming right up.</h2><div class="brand-steps">' +
    identity("chat", "Start with an idea", "") +
    identity("activity", "Watch your agents work", "") +
    identity("document", "Ship the next batch", "") +
    '</div></div><p class="brand-footer">Your software, made together.</p></aside><section class="form-pane"><img class="full-logo mobile-logo logo-light" src="logo.png" alt="Bakery"><img class="full-logo mobile-logo logo-dark" src="logo-dark.png" alt=""><div class="form-content">' +
    body + '</div><div class="form-bottom">' + prototypeFooter() +
    "</div></section></div>";
}
function contextShell(body, consent = false) {
  const summary = consent
    ? '<h2>Connect your tools to Bakery</h2><p class="muted consent-lede">Review what this client can access before you continue.</p><div class="identity-rows">' +
      identity(
        "terminal",
        "Local development client",
        "Registered client · illustrative",
      ) + identity("building", "Northstar", "Your organization") +
      '</div><p class="hint context-extra">You can revoke this connection from Account and security.</p>'
    : '<h2>You’re joining<br>Northstar</h2><p class="muted">A Bakery organization</p><div class="identity-rows">' +
      identity("person", "Jordan Lee", "Invited you") +
      identity("lock", "Developer", "Your organization role") +
      '</div><p class="hint context-extra">Create and follow work with your team.</p>';
  return '<div class="context-layout">' + brandSmall() +
    '<div class="context-box"><aside class="context-summary">' +
    icon(consent ? "plug" : "building") + summary +
    '</aside><section class="form-content">' + body +
    '</section></div><div class="context-footer">' + prototypeFooter() +
    "</div></div>";
}
function settingsShell(body, active = "security") {
  const nav = [
    ["document", "Work", "organizations"],
    ["grid", "Applications", "organizations"],
    ["terminal", "Sessions", "sessions"],
    ["computer", "Workers", "setup"],
    ["plug", "Integrations", "clients"],
    ["activity", "Automations", "organizations"],
    ["gear", "Settings", "security"],
  ];
  return '<div class="settings-layout"><aside class="app-rail">' +
    brandSmall() +
    '<div class="hint" style="padding-inline:8px">Northstar</div><nav class="rail-nav" aria-label="Application">' +
    nav.map(([i, t, id]) =>
      '<a href="#' + id + '"' +
      (id === "security" ? ' aria-current="page"' : "") + ">" + icon(i) + t +
      "</a>"
    ).join("") + '</nav><div class="rail-bottom">' +
    identity("person", "Alex Morgan", "Developer") +
    '</div></aside><section class="settings-main"><div class="settings-topbar"><span class="muted">Settings</span><span class="muted">/</span><strong>Account and security</strong><div class="grow"></div>' +
    themeButton() +
    '</div><nav class="mobile-settings-nav" aria-label="Account navigation">' +
    link("Account", "security") + link("Sessions", "sessions") +
    link("Clients", "clients") + '</nav><div class="settings-content">' +
    (active !== "security"
      ? link(icon("back") + "Account and security", "security")
      : "") +
    body +
    (core
      ? ""
      : '<p class="prototype-mark">Design preview · synthetic account and sessions</p>') +
    "</div></section></div>";
}
let pendingInvitation = false,
  mockTwoFactor = false;
const DEMO_BACKUP_CODES = [
  "h7mk2-9pvx4",
  "r3nb8-2qfw6",
  "d9tx5-4kma7",
  "w6cp3-8jyh2",
  "m2vz7-5xrd9",
  "k8hs4-3nwp6",
  "t5jq9-7bcv3",
  "p4fr6-2zmk8",
];
function verificationCode(error = "") {
  return '<div class="field"><label for="verification-code">Authentication code</label><input id="verification-code" name="verification-code" class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" aria-describedby="verification-hint"' +
    (error ? ' aria-invalid="true"' : "") +
    '><p id="verification-hint" class="' + (error ? "field-error" : "hint") +
    '">' + (error || "Enter the six-digit code from your authenticator app.") +
    "</p></div>";
}
const accountForm = (body) =>
  settingsShell('<div class="form-content">' + body + "</div>", "protection");
function protectionScreen(id, s) {
  const invalid = s === "invalid";
  switch (id) {
    case "two-factor": {
      const enabled = s !== "default";
      return settingsShell(
        heading(
          "Two-factor authentication",
          "Add an extra check when you sign in to Bakery.",
        ) + identity(
          "shield",
          "Authenticator app",
          enabled
            ? "Two-factor authentication is on."
            : "Use a six-digit code from an authenticator app.",
          '<span class="badge ' + (enabled ? "success" : "") + '">' +
            (enabled ? "On" : "Off") + "</span>",
        ) + (enabled
          ? '<section class="stack"><h2>Recovery</h2>' +
            identity(
              "key",
              "Backup codes",
              s === "no-codes"
                ? "No unused codes remain."
                : "8 unused codes. Each code works once.",
              link("Generate new codes", "backup-codes/regenerate"),
            ) + (s === "no-codes"
              ? notice(
                "Save a new set now so you can recover access if you lose your authenticator.",
                "warning",
              )
              : "") +
            "</section>" +
            link("Turn off two-factor authentication", "totp-disable")
          : notice(
            "Keep your authenticator and backup codes available so you can recover access.",
          ) + '<div class="form-content">' +
            button("Set up authenticator", "totp-setup") + "</div>"),
        "protection",
      );
    }
    case "totp-setup":
      if (s === "default") {
        return accountForm(
          heading("Set up an authenticator", "First, confirm it’s you.") +
            form(
              field("Current password", "current-password", "password", {
                placeholder: "Enter your current password",
              }),
              "Continue",
              "totp-setup/scan",
            ) + link("Cancel", "two-factor"),
        );
      }
      if (s === "expired") {
        return accountForm(
          heading(
            "Setup expired",
            "Start again to get a new QR code and setup key.",
          ) +
            notice("Two-factor authentication was not turned on.", "warning") +
            button("Restart setup", "totp-setup") +
            link("Back to security", "security"),
        );
      }
      return accountForm(
        heading(
          "Connect your authenticator",
          "Scan this QR code, then enter the code your app shows.",
        ) +
          '<div class="qr-setup"><img class="totp-qr" src="totp-demo.png" alt="Sample authenticator setup QR code. This demo key cannot access a Bakery account."><div class="stack"><h3>Can’t scan the code?</h3><p class="hint">Enter this setup key in your authenticator instead.</p><div class="code setup-key">JBSW Y3DP EHPK 3PXP</div><button class="btn secondary" type="button" data-copy-key>Copy setup key</button></div></div>' +
          (core
            ? ""
            : '<p class="caption">Demo QR and key · not connected to an account</p>') +
          form(
            verificationCode(
              invalid
                ? "That code is incorrect or expired. Try the current code from your app."
                : "",
            ),
            "Verify and turn on",
            "backup-codes",
          ) + link("Cancel setup", "two-factor"),
      );
    case "backup-codes":
      if (s === "regenerate" || invalid) {
        return accountForm(
          heading(
            "Generate new backup codes?",
            "Replace your current recovery codes with a new set.",
          ) +
            notice(
              "All previous backup codes stop working after a new set is generated. Your authenticator stays connected.",
              "warning",
            ) +
            form(
              field("Current password", "current-password", "password", {
                placeholder: "Enter your current password",
                error: invalid
                  ? "We couldn’t verify your password. Your existing codes still work."
                  : "",
              }) + verificationCode(),
              "Generate new codes",
              "backup-codes/regenerated",
            ) + link("Cancel", "two-factor/enabled"),
        );
      }
      return accountForm(
        heading(
          "Save your backup codes",
          "Use one if you can’t access your authenticator app.",
        ) + (s === "regenerated"
          ? notice(
            "New codes are ready. Your previous codes no longer work.",
            "success",
          )
          : notice(
            "Two-factor authentication is on. Save these codes before you leave.",
            "success",
          )) +
          '<div class="backup-code-list">' +
          DEMO_BACKUP_CODES.map((code) =>
            '<code class="backup-code">' + code + "</code>"
          ).join("") + "</div>" +
          (core
            ? ""
            : '<p class="caption">Sample codes · not valid for sign-in</p>') +
          '<p class="muted">Keep these in a password manager or another safe place. Each code works once. These codes won’t be shown again.</p><div class="two-actions"><button class="btn secondary" type="button" data-copy-codes>' +
          (s === "copied" ? "Copied" : "Copy codes") +
          '</button><button class="btn secondary" type="button" data-download-codes>Download codes</button></div><p class="hint" role="status" data-copy-status>' +
          (s === "copied"
            ? (core ? "Backup codes copied." : "Sample backup codes copied.")
            : "") +
          "</p>" + button("I’ve saved these codes", "two-factor/enabled"),
      );
    case "totp-disable":
      if (s === "disabled") {
        return accountForm(
          heading(
            "Two-factor authentication is off",
            "Your authenticator and backup codes no longer verify Bakery sign-ins.",
          ) +
            notice(
              "Your password and other sign-in methods stay connected.",
              "info",
            ) + button("Back to security", "security", "secondary"),
        );
      }
      return accountForm(
        heading(
          "Turn off two-factor authentication?",
          "Future password sign-ins will no longer ask for an authenticator code.",
        ) +
          notice(
            "Your unused backup codes will also stop working.",
            "warning",
          ) +
          form(
            field("Current password", "current-password", "password", {
              placeholder: "Enter your current password",
            }) + verificationCode(
              invalid
                ? "We couldn’t verify this request. Protection is still on."
                : "",
            ),
            "Turn off two-factor authentication",
            "totp-disable/disabled",
          ) + link("Cancel", "two-factor/enabled"),
      );
    case "totp-challenge":
      if (s === "expired") {
        return authShell(
          heading(
            "Sign-in request expired",
            "Start again to verify your account.",
          ) + button("Back to sign in", "login"),
        );
      }
      if (s === "rate-limited") {
        return authShell(
          heading(
            "Wait before trying again",
            "Too many verification attempts. Your account is still protected.",
          ) +
            notice(
              "Try again when the server allows another attempt.",
              "warning",
            ) +
            '<button class="btn primary full" disabled>Verification temporarily paused</button>' +
            link("Back to sign in", "login"),
        );
      }
      return authShell(
        heading(
          "One more check",
          "Open your authenticator app to finish signing in.",
        ) + form(
          verificationCode(
            invalid
              ? "That code is incorrect or expired. Try the current code from your app."
              : "",
          ),
          "Verify and sign in",
          "organizations",
        ) + link("Use a backup code", "backup-challenge") +
          link("Back to sign in", "login"),
      );
    case "backup-challenge":
      if (s === "no-access") {
        return authShell(
          heading(
            "Can’t verify your account?",
            "Use an available sign-in method or contact your installation owner.",
          ) +
            notice(
              "If you’ve lost your authenticator and all backup codes, account recovery requires an identity check.",
              "warning",
            ) + link("Back to sign in", "login"),
        );
      }
      return authShell(
        heading(
          "Use a backup code",
          "Enter one of the codes you saved when you set up two-factor authentication.",
        ) + form(
          field("Backup code", "backup-code", "text", {
            placeholder: "xxxxx-xxxxx",
            error: invalid
              ? "That code is incorrect or already used. Try a different unused code."
              : "",
            hint:
              "Each code works once. A successful sign-in consumes this code.",
          }),
          "Verify and sign in",
          "organizations",
        ) + link("Use authenticator instead", "totp-challenge") +
          link("I don’t have a backup code", "backup-challenge/no-access"),
      );
    case "passkeys":
      if (s === "rename") {
        return accountForm(
          heading("Rename passkey", "Choose a name you’ll recognize later.") +
            form(
              field("Passkey name", "passkey-name", "text", {
                value: "Personal laptop",
              }),
              "Save name",
              "passkeys/enabled",
            ) + link("Cancel", "passkeys/enabled"),
        );
      }
      if (["remove", "blocked", "failed"].includes(s)) {
        return accountForm(
          heading(
            "Remove this passkey?",
            "Personal laptop will no longer sign in to Bakery.",
          ) +
            identity(
              "key",
              "Personal laptop",
              "Added recently · sample passkey",
            ) + notice(
              s === "blocked"
                ? "Add another usable sign-in method before removing your last one."
                : s === "failed"
                ? "The passkey could not be removed. It is still connected."
                : "This removes access to Bakery. It does not delete the passkey from your password manager.",
              s === "failed" ? "error" : "warning",
            ) + (s === "blocked"
              ? button("Back to sign-in methods", "security", "secondary")
              : form(
                field("Current password", "current-password", "password", {
                  placeholder: "Confirm your current password",
                }),
                "Remove passkey",
                "passkeys",
              )) +
            link("Cancel", "passkeys/enabled"),
        );
      }
      return settingsShell(
        heading(
          "Passkeys",
          "Sign in with your device lock, fingerprint, face or security key.",
        ) + (s === "default"
          ? notice(
            "No passkeys added yet. Your existing sign-in methods still work.",
          )
          : identity(
            "key",
            "Personal laptop",
            "Added recently · sample passkey",
            '<div class="row">' + link("Rename", "passkeys/rename") +
              link("Remove", "passkeys/remove") + "</div>",
          )) +
          '<div class="form-content">' +
          button("Add a passkey", "passkey-add") +
          '</div><p class="hint">Your device or password manager keeps the private key. Bakery never receives your fingerprint or face data.</p>',
        "protection",
      );
    case "passkey-add":
      if (s === "success") {
        return accountForm(
          heading(
            "Your passkey is ready",
            "Personal laptop can now sign in to Bakery.",
          ) +
            notice(
              "Your existing sign-in methods remain available.",
              "success",
            ) + button("Manage passkeys", "passkeys/enabled"),
        );
      }
      if (s === "unsupported") {
        return accountForm(
          heading(
            "Passkeys aren’t available here",
            "Use a supported browser on a device with a screen lock.",
          ) +
            notice(
              "No passkey was created. You can keep using your other sign-in methods.",
              "info",
            ) + button("Back to passkeys", "passkeys", "secondary"),
        );
      }
      if (s === "canceled") {
        return accountForm(
          heading(
            "Passkey creation canceled",
            "No passkey was added to your account.",
          ) + button("Try again", "passkey-add") +
            link("Back to passkeys", "passkeys"),
        );
      }
      if (s === "prompt") {
        return accountForm(
          heading(
            "Follow your device’s prompt",
            "Choose where to save the passkey and confirm with your device lock.",
          ) + identity("key", "Personal laptop", "Bakery · alex@example.com") +
            notice(
              "Your browser or operating system handles this step. The prompt may look different on each device.",
            ) +
            // The browser's own passkey prompt completes this step, so the
            // artboard carries no Bakery control here (#334); Cancel stays,
            // because aborting the ceremony is a real product action.
            link("Cancel", "passkey-add/canceled"),
        );
      }
      return accountForm(
        heading(
          "Add a passkey",
          "Confirm your identity, then save a passkey with your device or password manager.",
        ) +
          form(
            field("Passkey name", "passkey-name", "text", {
              value: "Personal laptop",
              hint: "Use a name that helps you recognize this passkey.",
            }) +
              field("Current password", "current-password", "password", {
                placeholder: "Confirm your current password",
              }),
            "Continue",
            "passkey-add/prompt",
          ) + link("Cancel", "passkeys"),
      );
  }
}
function renderScreen(id, s) {
  if (
    [
      "two-factor",
      "totp-setup",
      "backup-codes",
      "totp-disable",
      "totp-challenge",
      "backup-challenge",
      "passkeys",
      "passkey-add",
    ].includes(id)
  ) return protectionScreen(id, s);
  const invalid = s === "invalid";
  if (s === "offline" || s === "unavailable" && id !== "verify") {
    return authShell(
      heading(
        s === "offline" ? "You’re offline" : "Sign-in is unavailable",
        s === "offline"
          ? "Reconnect to continue signing in."
          : "Bakery could not reach its authentication service.",
      ) +
        notice(
          "Your account details have not been submitted. Try again when the connection is restored.",
          "warning",
        ) + button("Try again", id) + link("Back to sign in", "login"),
    );
  }
  if (s === "throttled") {
    return authShell(
      heading(
        "A short pause",
        "Too many attempts. Please wait before trying again.",
      ) +
        notice(
          "Try again in a moment. The server will tell you when another attempt is allowed.",
          "warning",
        ) + button("Return to sign in", "login", "secondary"),
    );
  }
  const error = invalid
    ? notice(
      "We couldn’t complete that request. Check the highlighted information and try again.",
      "error",
    )
    : "";
  switch (id) {
    case "login":
      return authShell(
        heading("Welcome back", "Sign in to your Bakery account.") +
          (invalid
            ? notice(
              "Email or password is incorrect. Please try again.",
              "error",
            )
            : s === "unverified"
            ? notice(
              "Verify your email before continuing. " +
                link("View verification step", "verify"),
              "warning",
            )
            : "") +
          form(
            field("Email", "email", "email", {
              placeholder: "you@example.com",
            }) +
              field("Password", "current-password", "password", {
                placeholder: "Enter your password",
              }) +
              (core
                ? ""
                : '<div class="row spread">' + forgotLink() + "</div>"),
            "Sign in",
            "organizations",
          ) + (s === "github-disabled" ? "" : social()) +
          '<p class="hint">New to Bakery? ' +
          link("Join through an invitation", "join") + "</p>",
      );
    case "join":
      return authShell(
        heading(
          "You’re invited to the kitchen.",
          "Bakery accounts are created through invitations.",
        ) +
          '<p class="muted">Ask an organization Admin to invite your email address, then open the invitation to create your account.</p>' +
          button("Sign in to an existing account", "login") +
          (core
            ? ""
            : '<div class="notice"><div><strong>Review this flow</strong><p class="hint">This preview includes a sample invitation.</p>' +
              link("Open sample invitation", "invite") + "</div></div>"),
      );
    case "invite":
      if (
        ["wrong-account", "expired", "revoked", "accepted", "declined"]
          .includes(s)
      ) {
        const v = {
          "wrong-account": [
            "Use your invited email",
            "You’re signed in with a different account. Switch accounts to use this invitation.",
            "Switch account",
            "login",
          ],
          expired: [
            "This invitation has expired",
            "Ask the organization Admin for a new invitation.",
            "Back to sign in",
            "login",
          ],
          revoked: [
            "This invitation is no longer available",
            "Ask the organization Admin to confirm your access.",
            "Back to sign in",
            "login",
          ],
          accepted: [
            "You’re already part of Northstar",
            "This invitation has already been accepted.",
            "Open Northstar",
            "organizations",
          ],
          declined: [
            "Invitation declined",
            "You have not joined Northstar. An Admin can send another invitation if needed.",
            "Back to sign in",
            "login",
          ],
        }[s];
        return ["expired", "revoked", "declined"].includes(s)
          ? authShell(heading(v[0], v[1]) + button(v[2], v[3]))
          : contextShell(heading(v[0], v[1]) + button(v[2], v[3]));
      }
      return contextShell(
        heading("Join Northstar", "You’ve been invited as a Developer.") +
          identity(
            "mail",
            "alex@example.com",
            s === "authenticated"
              ? "Signed in as Alex Morgan"
              : "Email on the invitation",
          ) +
          notice(
            "You can create tasks and collaborate on work. Organization administration stays with Admins.",
          ) +
          (s === "authenticated"
            ? button("Accept invitation", "invite/accepted")
            : button("Create your account", "register") +
              link("Already have an account? Sign in", "invite-login")) +
          link("Decline invitation", "invite/declined"),
      );
    case "invite-login":
      return contextShell(
        heading(
          "Sign in to accept",
          "Use the email address on your invitation.",
        ) +
          (invalid
            ? notice(
              "Email or password is incorrect. Please try again.",
              "error",
            )
            : "") +
          form(
            field("Email", "email", "email", {
              value: "alex@example.com",
              readonly: true,
            }) +
              field("Password", "current-password", "password", {
                placeholder: "Enter your password",
              }) + forgotLink(),
            "Sign in and continue",
            "invite/authenticated",
          ) + link("Need an account? Create your account", "register"),
      );
    case "register":
      return contextShell(
        heading(
          "Create your account",
          "A place at the workbench is waiting for you.",
        ) + error + (s === "existing"
          ? notice(
            "If you already have an account, sign in to continue with this invitation.",
            "info",
          )
          : "") +
          form(
            field("Full name", "name", "text", { placeholder: "Alex Morgan" }) +
              field("Email", "email", "email", {
                value: "alex@example.com",
                readonly: true,
                hint: "This email is set by your invitation.",
              }) + field("Password", "new-password", "password", {
                placeholder: "Create a strong password",
                hint:
                  "Use a long, unique password. Password managers are welcome.",
                error: invalid
                  ? "Choose a password that meets your installation’s policy."
                  : "",
              }),
            "Create account",
            "verify",
          ) + social() + link("Already have an account? Sign in", "login"),
      );
    case "verify":
      if (s === "success" || s === "used") {
        return authShell(
          heading("Email verified", "Your email is ready to use.") +
            notice(
              "Continue to accept your invitation to Northstar.",
              "success",
            ) + button("Continue to invitation", "invite/authenticated"),
        );
      }
      if (s === "expired") {
        return authShell(
          heading(
            "This link has expired",
            "Request a new verification email to continue.",
          ) + button("Send a new link", "verify/resent") +
            link("Back to sign in", "login"),
        );
      }
      return authShell(
        heading(
          "Check your inbox",
          "Verify the email on your Bakery account.",
        ) + identity("mail", "alex@example.com", "Verification destination") +
          notice(
            s === "unavailable"
              ? "We couldn’t send this email. Try again or contact your installation owner."
              : s === "cooldown"
              ? "Please wait before requesting another email."
              : s === "resent"
              ? "A new verification email was requested. Use the newest link."
              : "Open the verification link in your email, then return here.",
            s === "unavailable" ? "error" : "info",
          ) +
          (s === "cooldown"
            ? '<button class="btn secondary full" disabled>Resend available shortly</button>'
            : button(
              "Resend verification email",
              "verify/resent",
              "secondary",
            )) +
          link("Back to sign in", "login") +
          link("Preview: open verification link", "verify/success"),
      );
    case "forgot":
      if (s === "sent") {
        return authShell(
          heading(
            "Check your inbox",
            "If this account can be reset, we’ll send an email.",
          ) +
            '<p class="muted">Use the newest reset link. Check your spam folder if you don’t see it.</p>' +
            button("Back to sign in", "login") +
            link("Try a different email", "forgot") +
            link("Preview: open reset link", "reset"),
        );
      }
      return authShell(
        heading(
          "Forgot your password?",
          "We’ll help you get back to the kitchen.",
        ) +
          form(
            field("Email", "email", "email", {
              placeholder: "you@example.com",
            }),
            "Send reset link",
            "forgot/sent",
          ) + link(icon("back") + "Back to sign in", "login"),
      );
    case "reset":
      if (s === "success") {
        return authShell(
          heading(
            "Password updated",
            "You can sign in with your new password.",
          ) +
            notice("Previous sessions will need to sign in again.", "success") +
            button("Back to sign in", "login"),
        );
      }
      if (s === "expired" || s === "used") {
        return authShell(
          heading(
            "Request a new reset link",
            "This link has expired or has already been used.",
          ) + button("Request another link", "forgot"),
        );
      }
      return authShell(
        heading(
          "A fresh start",
          "Set a new password for your Bakery account.",
        ) + error +
          form(
            field("New password", "new-password", "password", {
              placeholder: "Create a strong password",
              hint: "Use a long password you don’t use elsewhere.",
              error: invalid
                ? "This password does not meet your installation’s policy."
                : "",
            }),
            "Update password",
            "reset/success",
          ) + link("Back to sign in", "login"),
      );
    case "github": {
      const v = {
        default: [
          "Continue to GitHub",
          "GitHub will verify your identity. You’ll return here to continue.",
          "Preview GitHub return",
          "github/returning",
        ],
        returning: [
          "Finishing sign-in",
          "Checking your GitHub identity and Bakery access.",
          "Preview successful return",
          "github/success",
        ],
        canceled: [
          "GitHub sign-in was canceled",
          "No new sign-in was completed. Try again or use your email and password.",
          "Try GitHub again",
          "github",
        ],
        failed: [
          "We couldn’t complete sign-in",
          "The provider may be unavailable. Try again or use your email and password.",
          "Try again",
          "github",
        ],
        "missing-email": [
          "An email address is needed",
          "Choose a verified email in GitHub before continuing, or sign in with your Bakery email.",
          "Use email instead",
          "login",
        ],
        unlinked: [
          "Finish with your Bakery account",
          "Sign in with an existing method, then link GitHub from Account and security.",
          "Sign in with email",
          "login",
        ],
        success: [
          "You’re signed in",
          "Choose the organization you want to open.",
          "Continue",
          "organizations",
        ],
      }[s] || [];
      return authShell(
        heading(v[0], v[1]) +
          identity("github", "GitHub", "Identity provider") +
          notice(
            "Signing in does not grant repository access or install the GitHub integration.",
          ) + button(v[2], v[3]) + link("Back to email sign in", "login"),
      );
    }
    case "organizations":
      if (s === "empty" || s === "removed") {
        return authShell(
          heading(
            s === "removed"
              ? "Your organization access changed"
              : "No organization access yet",
            "Your account is signed in, but you don’t have an available membership.",
          ) +
            notice("Ask an organization Admin for an invitation.", "warning") +
            button("Check access again", "organizations", "secondary") +
            link("Sign out", "signout"),
        );
      }
      return authShell(
        heading("Where are we working?", "Choose a Bakery organization.") +
          '<div class="list">' +
          [["N", "Northstar", "Developer"], ["P", "Personal", "Admin"]].map((
            [a, t, r],
          ) =>
            '<button class="item selectable" type="button" data-go="security"><span class="avatar">' +
            a + '</span><span class="grow"><strong>' + t +
            '</strong><span class="hint" style="display:block">' + r +
            "</span></span>" + icon("arrow") + "</button>"
          ).join("") + "</div>" + link("Use a different account", "signout"),
      );
    case "expired":
      return authShell(
        heading(
          "Sign in to continue",
          "Your session ended. Your background work keeps running.",
        ) +
          notice(
            "After sign-in, return to the plan you were reviewing. Access is checked again first.",
          ) + button("Sign in again", "login") +
          link("Use a different account", "login"),
      );
    case "reauth":
      return authShell(
        heading(
          "Confirm it’s you",
          "Sign in again before changing account security.",
        ) + identity("person", "Alex Morgan", "alex@example.com") + error +
          form(
            field("Password", "current-password", "password", {
              placeholder: "Enter your password",
            }),
            "Confirm identity",
            "security/saved",
          ) + link("Cancel", "security"),
      );
    case "security":
      return settingsShell(
        heading(
          "Account and security",
          "Manage how you sign in and where you’re signed in.",
        ) +
          (s === "saved"
            ? notice("Your identity was confirmed.", "success")
            : "") +
          identity(
            "person",
            "Alex Morgan",
            core ? "alex@example.com" : "alex@example.com · Verified",
          ) + '<section class="stack"><h2>Sign-in methods</h2><div>' +
          identity(
            "lock",
            "Password",
            "A password is set for this account.",
            link("Change", "password"),
          ) + (core ? "" : identity(
            "github",
            "GitHub",
            "Optional sign-in method.",
            link("Link account", "link-github"),
          )) +
          identity(
            "key",
            "Passkeys",
            s === "protected" ? "1 passkey added." : "No passkeys added.",
            link("Manage", s === "protected" ? "passkeys/enabled" : "passkeys"),
          ) + "</div></section>" + "<section><h2>Account protection</h2>" +
          identity(
            "shield",
            "Two-factor authentication",
            s === "protected"
              ? "Authenticator on · 8 backup codes remaining."
              : "Off · Add a six-digit authenticator code.",
            link(
              s === "protected" ? "Manage" : "Set up",
              s === "protected" ? "two-factor/enabled" : "two-factor",
            ),
          ) + "</section><section><h2>Account access</h2>" +
          (core ? "" : identity(
            "mail",
            "Email address",
            "alex@example.com",
            link("Change", "email"),
          )) +
          identity(
            "computer",
            "Active sessions",
            "Current device and other signed-in sessions.",
            link("Manage", "sessions"),
          ) +
          identity(
            "plug",
            "Connected clients",
            "Apps authorized through Bakery OAuth.",
            link("Manage", "clients"),
          ) + "</section>" + link("Sign out of this session", "signout"),
      );
    case "password":
      if (s === "success") {
        return settingsShell(
          heading(
            "Password changed",
            "Your account now uses the new password.",
          ) +
            // The shipped `settings.password.successNotice` string (#334).
            notice(
              "Your current session stays signed in. Other sessions were signed out.",
              "success",
            ) + link("Review active sessions", "sessions"),
          "password",
        );
      }
      return settingsShell(
        '<div class="form-content">' +
          heading(
            "Change password",
            "Use a unique password for your Bakery account.",
          ) + error +
          form(
            field("Current password", "current-password", "password", {
              placeholder: "Current password",
            }) +
              field("New password", "new-password", "password", {
                placeholder: "New password",
                error: invalid
                  ? "Choose a different password that meets the configured policy."
                  : "",
              }),
            "Save password",
            "password/success",
          ) + link("Cancel", "security") + "</div>",
        "password",
      );
    case "email":
      if (s === "pending" || s === "expired" || s === "success") {
        return settingsShell(
          '<div class="form-content">' + heading(
            s === "success"
              ? "Email updated"
              : s === "expired"
              ? "Verification link expired"
              : "Verify your new email",
            s === "success"
              ? "Your account now uses the verified address."
              : "Your current email stays active until verification is complete.",
          ) + notice(
            s === "success"
              ? "alex.new@example.com is now verified."
              : s === "expired"
              ? "Request a new link to finish this change."
              : "Check alex.new@example.com for a verification email.",
            s === "success" ? "success" : "info",
          ) + (s === "success" ? link("Back to account", "security") : button(
            "Send another verification email",
            "email/pending",
            "secondary",
          ) + link("Preview: finish verification", "email/success")) +
            "</div>",
          "email",
        );
      }
      return settingsShell(
        '<div class="form-content">' +
          heading(
            "Change email address",
            "You’ll verify the new address before it replaces your current one.",
          ) + identity("mail", "alex@example.com", "Current verified email") +
          form(
            field("New email", "email", "email", {
              placeholder: "alex.new@example.com",
            }),
            "Continue to verification",
            "email/pending",
          ) + link("Cancel", "security") + "</div>",
        "email",
      );
    case "sessions":
      return settingsShell(
        heading(
          "Active sessions",
          "Review devices signed in to your Bakery account.",
        ) +
          (s === "revoked"
            ? notice("The selected session was signed out.", "success")
            : "") +
          identity(
            "computer",
            "This device",
            "Desktop browser · active now",
            '<span class="badge success">Current</span>',
          ) +
          (s === "empty"
            ? notice("There are no other active sessions.")
            : identity(
              "phone",
              "Mobile browser",
              "Last active recently" + (core ? "" : " · synthetic device"),
              link("Revoke", "revoke"),
            ) +
              identity(
                "computer",
                "Other desktop",
                "Last active yesterday" + (core ? "" : " · synthetic device"),
                link("Revoke", "revoke"),
              )) +
          button("Sign out all other sessions", "revoke", "secondary"),
        "sessions",
      );
    case "revoke":
      return settingsShell(
        '<div class="form-content">' + heading(
          s === "success"
            ? "Other sessions signed out"
            : "Sign out other sessions?",
          s === "success"
            ? "Those devices will need to sign in again."
            : "Two other sessions will lose access to Bakery.",
        ) +
          (s === "failed"
            ? notice("We couldn’t revoke these sessions. Try again.", "error")
            : notice(
              "This device stays signed in. Background tasks and workers keep running.",
              s === "success" ? "success" : "warning",
            )) +
          (s === "success"
            ? button("Return to sessions", "sessions/empty", "secondary")
            : '<div class="two-actions">' +
              button("Cancel", "sessions", "secondary") +
              button("Sign out 2 sessions", "revoke/success", "danger") +
              "</div>") +
          "</div>",
        "revoke",
      );
    case "signout":
      if (s === "success") {
        return authShell(
          heading(
            "You’re signed out",
            "Your background work is still running.",
          ) + button("Sign in", "login"),
        );
      }
      return authShell(
        heading(
          "Sign out of this session?",
          "You’ll need to sign in again on this device.",
        ) + (s === "unsynced"
          ? notice(
            "A local draft hasn’t synced. Finish syncing or recover the draft before signing out.",
            "warning",
          ) + button("Return to your work", "security")
          : '<p class="muted">Other sessions, agents and scheduled work stay active.</p><div class="two-actions">' +
            button("Cancel", "security", "secondary") +
            button("Sign out", "signout/success") + "</div>"),
      );
    case "consent":
      if (["success", "denied", "expired"].includes(s)) {
        return contextShell(
          heading(
            s === "success"
              ? "Client connected"
              : s === "denied"
              ? "Access was not granted"
              : "Authorization expired",
            s === "success"
              ? "Return to your client to continue."
              : s === "denied"
              ? "This request did not add access. Existing grants are unchanged."
              : "Start a new connection request from your client.",
          ) + button(
            s === "success" ? "Review connected clients" : "Return to account",
            s === "success" ? "clients" : "security",
            "secondary",
          ),
          true,
        );
      }
      return contextShell(
        heading(
          "Allow access to Bakery?",
          "Local development client is requesting access.",
        ) +
          '<div class="field"><label for="org-consent">Organization</label><select id="org-consent"><option>Northstar · Developer</option><option>Personal · Admin</option></select><p class="hint">Only this organization is included in the grant.</p></div><div class="consent-scopes">' +
          identity(
            "document",
            "Read work and artifacts",
            "Read tasks, plans and execution evidence you can access.",
          ) +
          identity(
            "terminal",
            "Start and steer tasks",
            "Create work and send instructions under your permissions.",
          ) + "</div>" +
          notice(
            "The client cannot manage members or secrets with this request.",
          ) + '<div class="two-actions">' +
          button("Deny", "consent/denied", "secondary") +
          button("Allow access", "consent/success") + "</div>",
        true,
      );
    case "clients":
      return settingsShell(
        heading(
          "Connected clients",
          "Review apps you’ve authorized to access Bakery.",
        ) +
          (s === "revoked"
            ? notice("The client’s access was revoked.", "success")
            : "") +
          (s === "empty" || s === "revoked"
            ? notice(
              "No clients are connected. Connect a client from its own setup flow.",
            )
            : identity(
              "terminal",
              "Local development client",
              "Northstar · Read work and artifacts, start and steer tasks",
              button("Revoke access", "revoke-client", "secondary"),
            )) +
          // The gallery link into the consent artboard is a prototype aid, not a
          // product control; the core (shipped) derivation omits it.
          (core ? "" : link("Preview client authorization", "consent")),
        "clients",
      );
    case "revoke-client":
      return settingsShell(
        '<div class="form-content">' +
          heading(
            "Revoke client access?",
            "Local development client will lose its current access to Northstar.",
          ) + notice(
            s === "failed"
              ? "The grant could not be revoked. Try again."
              : "The client will no longer be able to read work or start and steer tasks through this grant. Other sessions and integrations stay connected.",
            s === "failed" ? "error" : "warning",
          ) + '<div class="two-actions">' +
          button("Cancel", "clients", "secondary") +
          button("Revoke access", "clients/revoked", "danger") + "</div></div>",
        "clients",
      );
    case "link-github": {
      let body = heading(
        "Link GitHub sign-in",
        "Add another way to sign in to your Bakery account.",
      );
      if (s === "default") {
        body += form(
          field("Password", "current-password", "password", {
            placeholder: "Confirm your current password",
          }),
          "Confirm and continue",
          "link-github/confirm",
        ) + link("Cancel", "security");
      } else if (s === "confirm") {
        body += notice(
          "Continue to GitHub to prove you own the account. This does not install the repository integration.",
        ) + button("Preview GitHub confirmation", "link-github/connected") +
          link("Cancel", "link-github/canceled");
      } else if (s === "connected") {
        body += notice("GitHub is linked as a sign-in method.", "success") +
          button("Back to account", "security");
      } else {body += notice(
          s === "last-method"
            ? "Add and verify another sign-in method before removing this one."
            : s === "conflict"
            ? "This GitHub identity cannot be linked to your account. Sign in with your existing method or contact the installation owner."
            : "GitHub linking was canceled. Your existing sign-in method is unchanged.",
          s === "canceled" ? "info" : "warning",
        ) + button("Back to account", "security", "secondary");}
      return settingsShell(
        '<div class="form-content">' + body + "</div>",
        "security",
      );
    }
    case "desktop":
      return authShell(
        heading("You’re ready to roll.", "Your browser sign-in is complete.") +
          (s === "blocked"
            ? notice(
              "The desktop app didn’t open. Open Bakery manually or continue in this browser.",
              "warning",
            )
            : "") +
          button("Open Bakery desktop", "desktop/blocked") +
          link("Continue in this browser", "organizations") +
          '<p class="hint">This preview does not launch an installed application.</p>',
      );
    case "setup":
      return authShell(
        heading(
          s === "ready"
            ? "Your kitchen is ready"
            : s === "recovery"
            ? "Recover local access"
            : "Finish local setup",
          s === "ready"
            ? "Your installation and first Admin account are ready."
            : s === "recovery"
            ? "Email recovery is not configured on this installation."
            : "Create the first Admin through the installation setup command.",
        ) + (s === "ready" ? button("Continue to sign in", "login") : notice(
          s === "recovery"
            ? "Contact the installation owner to use the documented local recovery procedure. Organization membership alone does not grant recovery authority."
            : "Run the local setup workflow on the machine hosting Bakery. It will create the first account without requiring email delivery.",
        )) + link("Back to sign in", "login"),
      );
    case "mail-invite":
      return mailShell(
        "You’ve got a place at the table.",
        "Jordan Lee invited you to join Northstar as a Developer.",
        "Accept invitation",
        "invite",
        "This sample invitation expires in 7 days. If you weren’t expecting it, you can ignore this email.",
      );
    case "mail-verify":
      return mailShell(
        "One last step.",
        "Verify alex@example.com to finish setting up your Bakery account.",
        "Verify email",
        "verify/success",
        "This sample link expires in 1 hour. If you didn’t create an account, ignore this email.",
      );
    case "mail-reset":
      return mailShell(
        "A fresh start awaits.",
        "A password reset was requested for your Bakery account.",
        "Reset password",
        "reset",
        "This sample link expires in 1 hour. If you didn’t request it, you can ignore this email. Your password hasn’t changed.",
      );
    case "mail-security":
      return mailShell(
        "Your password changed.",
        "The password for your Bakery account was updated.",
        "Review account security",
        "security",
        "If this wasn’t you, recover your account and contact the installation owner. No password is included in this message.",
      );
    case "primitives":
      return settingsShell(
        heading(
          "Authentication primitives",
          "The same components, reused across every account flow.",
        ) + '<section class="stack"><h2>Actions</h2><div class="row wrap">' +
          button("Primary action", "login") +
          button("Secondary action", "login", "secondary") +
          '<button class="btn" disabled>Unavailable</button></div></section><section class="stack">' +
          field("Email address", "email", "email", {
            placeholder: "you@example.com",
            hint: "Persistent labels and 44px inputs.",
          }) +
          field("Password", "new-password", "password", {
            error: "Explain the problem and how to fix it.",
          }) + '</section><section class="stack">' +
          notice("Informational feedback.") +
          notice("The action completed.", "success") +
          notice("This needs attention.", "warning") +
          notice("Something failed. Try again.", "error") + "</section>" +
          identity(
            "person",
            "Identity and role",
            "Alex Morgan · Developer",
            '<span class="badge success">Verified</span>',
          ),
      );
  }
  return authShell(
    heading(
      "Screen unavailable",
      "Choose another screen from the review page.",
    ) + link("Sign in", "login"),
  );
}
function mailShell(title, description, cta, to, foot) {
  return '<div class="email-layout"><article class="email-sheet">' +
    brandSmall() + heading(title, description) + button(cta, to) +
    '<p class="hint">' + foot +
    '</p><div class="divider"></div><p class="hint">Only continue on the Bakery installation you recognize. This mock uses a sample destination.</p><div class="code">https://bakery.example.com</div></article><p class="email-footer">Bakery · account notification<br>Design preview · sample expiry, no message sent</p>' +
    themeButton() + "</div>";
}
function parsedHash() {
  const parts = location.hash.slice(1).split("/"),
    screen = SCREENS.find((v) => v.id === parts[0]) || SCREENS[0];
  return {
    screen,
    state: screen.states.includes(parts[1]) ? parts[1] : "default",
  };
}
function applyTheme(value) {
  const t = value === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : value;
  document.documentElement.dataset.theme = t;
}
function mountMock() {
  const { screen, state: variant } = parsedHash();
  if (["invite", "invite-login", "register"].includes(screen.id)) {
    pendingInvitation = true;
  }
  if (
    screen.id === "invite" &&
    ["expired", "revoked", "declined"].includes(variant)
  ) pendingInvitation = false;
  if (screen.id === "two-factor" && variant !== "default") mockTwoFactor = true;
  if (screen.id === "totp-disable" && variant === "disabled") {
    mockTwoFactor = false;
  }
  const previousId = el("app").dataset.screen;
  el("app").innerHTML = renderScreen(screen.id, variant);
  el("app").dataset.screen = screen.id;
  el("app").dataset.state = variant;
  if (pendingInvitation && screen.id === "login") {
    el("app").querySelector("form")?.setAttribute(
      "data-next",
      "invite/authenticated",
    );
  }
  if (mockTwoFactor && ["login", "invite-login"].includes(screen.id)) {
    el("app").querySelector("form")?.setAttribute(
      "data-next",
      "totp-challenge",
    );
  }
  if (
    pendingInvitation &&
    ["totp-challenge", "backup-challenge"].includes(screen.id)
  ) {
    el("app").querySelector("form")?.setAttribute(
      "data-next",
      "invite/authenticated",
    );
  }
  if (pendingInvitation && screen.id === "github" && variant === "success") {
    el("app").querySelector('[data-go="organizations"]')?.setAttribute(
      "data-go",
      "invite/authenticated",
    );
  }
  if (variant === "loading") {
    const submit = el("app").querySelector("button[type=submit]") ||
      el("app").querySelector(".btn.primary");
    if (submit) {
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
      submit.textContent = "Working…";
    }
    if (!core) {
      const body = el("app").querySelector(".form-content") || el("app");
      body.insertAdjacentHTML(
        "afterbegin",
        notice("Waiting for the server. This is the loading-state preview."),
      );
    }
  }
  if (new URLSearchParams(location.search).get("long") === "1") {
    el("app").classList.add("long-test");
    for (const n of el("app").querySelectorAll("h1,h2,h3,.hint")) {
      if (n.textContent.includes("Northstar")) {
        n.textContent = n.textContent.replaceAll(
          "Northstar",
          "Northstar Engineering and Research Organization",
        );
      }
    }
  }
  if (new URLSearchParams(location.search).get("pseudo") === "1") {
    const walker = document.createTreeWalker(el("app"), NodeFilter.SHOW_TEXT),
      nodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.trim()) {
        nodes.push(walker.currentNode);
      }
    }
    for (const n of nodes) n.textContent = "［" + n.textContent + " ···］";
  }
  for (const f of el("app").querySelectorAll("form")) {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!f.reportValidity()) {
        return;
      }
      const b = f.querySelector("[type=submit]");
      b.disabled = true;
      b.textContent = "Continuing…";
      // Mock-only delay demonstrates pending feedback. No field values are read or stored.
      setTimeout(() => {
        location.hash = f.dataset.next;
      }, 160);
    });
  }
  for (const b of el("app").querySelectorAll("[data-go]")) {
    b.onclick = () => {
      location.hash = b.dataset.go;
    };
  }
  for (const b of el("app").querySelectorAll("[data-reveal]")) {
    b.onclick = () => {
      const input = el(b.dataset.reveal), show = input.type === "password";
      input.type = show ? "text" : "password";
      b.setAttribute("aria-pressed", String(show));
      b.setAttribute(
        "aria-label",
        (show ? "Hide " : "Show ") + input.name.replaceAll("-", " "),
      );
    };
  }
  for (const b of el("app").querySelectorAll("[data-theme-toggle]")) {
    b.onclick = () => {
      const value = document.documentElement.dataset.theme === "dark"
        ? "light"
        : "dark";
      applyTheme(value);
      if (parent !== window) {
        parent.postMessage(
          { type: "bakery-auth-theme", value },
          location.origin,
        );
      }
    };
  }
  for (
    const b of el("app").querySelectorAll("[data-copy-codes],[data-copy-key]")
  ) {
    b.onclick = async () => {
      const status = el("app").querySelector("[data-copy-status]");
      try {
        await navigator.clipboard.writeText(
          b.hasAttribute("data-copy-key")
            ? "JBSWY3DPEHPK3PXP"
            : "Bakery design preview — sample codes, not valid for sign-in\n" +
              DEMO_BACKUP_CODES.join("\n"),
        );
        b.textContent = "Copied";
        if (status) {
          status.textContent = core
            ? "Backup codes copied."
            : "Sample backup codes copied.";
        }
      } catch {
        if (status) {
          status.textContent =
            "Copy was unavailable. Select the codes or download them instead.";
        } else b.textContent = "Copy unavailable — select the key";
      }
    };
  }
  for (const b of el("app").querySelectorAll("[data-download-codes]")) {
    b.onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([
          "Bakery design preview — sample codes, not valid for sign-in\n" +
          DEMO_BACKUP_CODES.join("\n"),
        ], { type: "text/plain" }),
      );
      a.download = "bakery-demo-backup-codes.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  }
  const code = el("verification-code");
  if (code) {
    code.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text").replace(/\s/g, "");
      if (/^[0-9]{6}$/.test(text || "")) {
        e.preventDefault();
        code.value = text;
      }
    });
  }
  if (previousId && previousId !== screen.id) {
    el("app").querySelector("h1")?.focus({ preventScroll: true });
  }
  document.title = "Bakery · " + screen.title;
  if (parent !== window) {
    parent.postMessage({
      type: "bakery-auth-route",
      id: screen.id,
      state: variant,
    }, location.origin);
  }
}
const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") || "system");
document.documentElement.dir = params.get("rtl") === "1" ? "rtl" : "ltr";
if (params.has("embed") || params.has("screen")) {
  el("gallery").hidden = true;
  el("app").hidden = false;
  mountMock();
  globalThis.addEventListener("hashchange", mountMock);
  globalThis.bakeryAuthReady = true;
} else {
  el("gallery").hidden = false;
  el("app").hidden = true;
  const frame = el("preview"),
    screenSelect = el("screen-select"),
    stateSelect = el("state-select");
  let viewport = matchMedia("(max-width:743px)").matches ? "phone" : "desktop";
  screenSelect.innerHTML = SCREENS.map((s) =>
    '<option value="' + s.id + '">' + s.title + "</option>"
  ).join("");
  const update = () => {
    const { screen, state: variant } = parsedHash();
    screenSelect.value = screen.id;
    stateSelect.innerHTML = screen.states.map((s) =>
      '<option value="' + s + '">' + s.replaceAll("-", " ") + "</option>"
    ).join("");
    stateSelect.value = variant;
    el("screen-title").textContent = screen.title;
    el("screen-route").textContent = screen.route;
    el("screen-note").textContent = screen.note;
    el("preview-wrap").className = "preview-wrap " + viewport;
    for (const b of document.querySelectorAll("[data-viewport]")) {
      b.setAttribute("aria-pressed", String(b.dataset.viewport === viewport));
    }
    const settings = new URLSearchParams({
      embed: "1",
      theme: el("theme-select").value,
      rtl: el("rtl-toggle").checked ? "1" : "0",
      long: el("long-toggle").checked ? "1" : "0",
      pseudo: el("pseudo-toggle").checked ? "1" : "0",
      caps: el("core-toggle").checked ? "core" : "all",
    });
    const href = "index.html?" + settings.toString() + "#" + screen.id +
      (variant === "default" ? "" : "/" + variant);
    frame.src = href;
    frame.style.height = (viewport === "desktop" ? "960" : "844") + "px";
    el("open-screen").href = href.replace("embed=1", "screen=1");
    const index = SCREENS.indexOf(screen);
    el("position").textContent = (index + 1) + " / " + SCREENS.length;
    el("previous").disabled = index === 0;
    el("next").disabled = index === SCREENS.length - 1;
    el("previous").onclick = () => location.hash = SCREENS[index - 1].id;
    el("next").onclick = () => location.hash = SCREENS[index + 1].id;
    applyTheme(el("theme-select").value);
  };
  screenSelect.onchange = () => location.hash = screenSelect.value;
  stateSelect.onchange = () =>
    location.hash = screenSelect.value + "/" + stateSelect.value;
  el("theme-select").onchange = update;
  for (
    const id of ["rtl-toggle", "long-toggle", "pseudo-toggle", "core-toggle"]
  ) el(id).onchange = update;
  for (const b of document.querySelectorAll("[data-viewport]")) {
    b.onclick = () => {
      viewport = b.dataset.viewport;
      update();
    };
  }
  globalThis.addEventListener("hashchange", update);
  globalThis.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) {
      return;
    }
    if (e.data?.type === "bakery-auth-route") {
      const { id, state: v } = e.data,
        screen = SCREENS.find((s) => s.id === id);
      if (!screen || !screen.states.includes(v)) return;
      const hash = "#" + id + (v === "default" ? "" : "/" + v);
      if (location.hash !== hash) {
        history.replaceState(null, "", hash);
        screenSelect.value = id;
        stateSelect.innerHTML = screen.states.map((s) =>
          "<option>" + s + "</option>"
        ).join("");
        stateSelect.value = v;
        el("screen-title").textContent = screen.title;
        el("screen-route").textContent = screen.route;
        el("screen-note").textContent = screen.note;
        const i = SCREENS.indexOf(screen);
        el("position").textContent = (i + 1) + " / " + SCREENS.length;
        el("previous").disabled = i === 0;
        el("next").disabled = i === SCREENS.length - 1;
        el("previous").onclick = () => location.hash = SCREENS[i - 1].id;
        el("next").onclick = () => location.hash = SCREENS[i + 1].id;
        el("open-screen").href = frame.contentWindow.location.href.replace(
          "embed=1",
          "screen=1",
        );
      }
    }
    if (
      e.data?.type === "bakery-auth-theme" &&
      ["light", "dark"].includes(e.data.value)
    ) {
      el("theme-select").value = e.data.value;
      applyTheme(e.data.value);
    }
  });
  el("screen-count").textContent = SCREENS.length + " screens · " +
    SCREENS.reduce((n, s) => n + s.states.length, 0) + " review states";
  update();
  globalThis.bakeryAuthReady = true;
}
