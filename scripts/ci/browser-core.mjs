// Explicit consumer cases, executed once in their intended browser context.
export const AUTH_BOOTSTRAP_PROJECT = "desktop-auth-bootstrap";
export const browserCore = [
  [
    AUTH_BOOTSTRAP_PROJECT,
    "auth-journey.spec.ts",
    "1a. empty install redirects to /setup",
  ],
  [
    AUTH_BOOTSTRAP_PROJECT,
    "auth-journey.spec.ts",
    "1b. keyboard-only sign-in reaches / with an org-scoped request and an httpOnly session cookie",
  ],
  [
    AUTH_BOOTSTRAP_PROJECT,
    "auth-journey.spec.ts",
    "1c. tap-driven sign-in on an emulated iPhone reaches / (assertion 9's mobile repeat of 1)",
  ],
  [
    AUTH_BOOTSTRAP_PROJECT,
    "auth-journey.spec.ts",
    "2. an anonymous deep link to /settings/sessions redirects to sign-in and returns there after sign-in",
  ],
  [
    AUTH_BOOTSTRAP_PROJECT,
    "auth-journey.spec.ts",
    "3. a tampered session cookie redirects to /sign-in?reason=expired and /v1/me reports AUTH_INVALID",
  ],
  [
    AUTH_BOOTSTRAP_PROJECT,
    "auth-journey.spec.ts",
    "4. a second session can be listed, revoked individually, and revoking the current session signs the browser out",
  ],
  [
    AUTH_BOOTSTRAP_PROJECT,
    "auth-journey.spec.ts",
    "7. a cross-origin sign-in and a cross-origin session revocation are both blocked",
  ],
  [
    "desktop-shared-admin",
    "browser-artifact-core.spec.ts",
    "downloads immutable scoped bytes and denies revoked session reads",
  ],
  [
    "desktop-shared-admin",
    "organization-access-real-api.spec.ts",
    "an admin binds, observes and revokes scoped roles; a guest and a foreign org stay isolated",
  ],
  [
    "desktop",
    "scope-and-auth.spec.ts",
    "partitions the protected cache when organization identity changes",
  ],
  [
    "desktop",
    "auth-guard.spec.ts",
    "navigates to /organizations?reason=forbidden when a forbidden session is caught elsewhere",
  ],
  [
    "desktop",
    "task-composer.spec.ts",
    "submit sends one task then one preset run on one scoped intent and opens the task",
  ],
  [
    "desktop",
    "task-composer.spec.ts",
    "an unknown outcome locks the form; Retry replays identical keys and bodies",
  ],
  [
    "desktop",
    "task-composer.spec.ts",
    "offline blocks submit and says nothing is sent; back online restores the form",
  ],
  [
    "mobile",
    "tasks.spec.ts",
    "controls are capability gated, keyboard operable, and offline safe",
  ],
  [
    "desktop",
    "task-conversation.spec.ts",
    "System theme follows the emulated scheme and re-themes without reload",
  ],
  [
    "mobile",
    "task-conversation.spec.ts",
    "System theme follows the emulated scheme and re-themes without reload",
  ],
  [
    "desktop",
    "task-conversation.spec.ts",
    "200% zoom keeps the conversation reachable, unclipped and in focus order",
  ],
  [
    "desktop",
    "tasks.spec.ts",
    "the artifact pane previews the current version as inert text with a safe link",
  ],
  [
    "mobile",
    "shell.spec.ts",
    "a phone gets the section index at /settings and each row opens its page",
  ],
  ["desktop", "shell.spec.ts", "keeps shell navigation and route focus native"],
  [
    "desktop",
    "shell.spec.ts",
    "the Settings rail link and /settings land on Profile",
  ],
  [
    "desktop",
    "settings-states.spec.ts",
    "offline and reconnecting withhold the save action and never report success: password",
  ],
  [
    "desktop",
    "settings-states.spec.ts",
    "offline and reconnecting withhold the save action and never report success: passkey-add",
  ],
  [
    "desktop",
    "settings-states.spec.ts",
    "offline and reconnecting withhold the save action and never report success: reauth",
  ],
];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function coreGrep(project) {
  const cases = browserCore.filter(([context]) => context === project);
  return new RegExp(
    cases.map(([, file, title]) =>
      `${escapeRegex(file)}.* ${escapeRegex(title)}$`
    ).join("|") || "(?!)",
  );
}

// A sharded run sees only its own slice of the suite. With `presentOnly`, a
// core case that is absent from the slice is not this shard's to prove (the
// whole-suite listing check below proves it exists exactly once); a case that
// is present must still execute and pass exactly once.
export function coreCoverageIssues(tests, { presentOnly = false } = {}) {
  const issues = [];
  for (const [project, file, title] of browserCore) {
    const matches = tests.filter((entry) =>
      entry.project === project && entry.file === file && entry.title === title
    );
    if (presentOnly && matches.length === 0) continue;
    if (
      matches.length !== 1 || matches[0].outcome !== "expected" ||
      matches[0].status !== "passed"
    ) {
      issues.push(
        `${project}/${file}: ${title} must execute and pass exactly once`,
      );
    }
  }
  return issues;
}

// Whole-suite check for sharded runs: every core case must be listed exactly
// once across the unsharded test list, so a shard cannot hide a missing or
// duplicated case behind its own slice.
export function coreListingIssues(tests) {
  const issues = [];
  for (const [project, file, title] of browserCore) {
    const count = tests.filter((entry) =>
      entry.project === project && entry.file === file && entry.title === title
    ).length;
    if (count !== 1) {
      issues.push(
        `${project}/${file}: ${title} must be listed exactly once, found ${count}`,
      );
    }
  }
  return issues;
}
