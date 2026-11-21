// What the launcher prints. Pure functions, no I/O: release.mjs reads the
// state file and writes the lines; these only turn a state or an error code
// into words. Rules (design for #59): the first line says what state Bakery is
// in, the next says whether anything changed, then the one next command, and
// the code goes last in square brackets so it can be searched for.

export const STEP_LABELS = [
  "Checking the release",
  "Checking database changes",
  "Saving a snapshot",
  "Switching",
  "Checking health",
];

const COMMAND = "bakery-release";
const RESTORE_HINT = [
  "To go further back, restore a backup. See the runbook, After a restore",
  "(docs/runbooks/backups.md). An administrator then finishes the restore",
  "in Bakery.",
];

// Failures thrown before the journal is written: the host is exactly as it was.
const NOTHING_CHANGED = new Set([
  "RELEASE_SHA_INVALID",
  "ARCHIVE_DIGEST_INVALID",
  "RELEASE_MANIFEST_INVALID",
  "RELEASE_MIGRATION_INVALID",
  "RELEASE_ASSET_INVALID",
  "DEPLOY_PREPARE_FAILED",
  "APPLIED_MIGRATION_CHANGED",
  "APPLIED_MIGRATION_REMOVED",
  "MIGRATION_COMPATIBILITY_REVIEW_REQUIRED",
  "ROLLBACK_SCHEMA_INCOMPATIBLE",
  "NO_ROLLBACK_BASELINE",
  "ROLLBACK_HEAD_CHANGED",
  "ROLLBACK_TARGET_INVALID",
  "BOOTSTRAP_ALREADY_INITIALIZED",
  "RECOVERY_REQUIRED",
  "ROOT_REQUIRED",
  "EXPECTED_DEPLOY_ROLLBACK_RECOVER_RENDER",
]);

const short = (sha) => (typeof sha === "string" ? sha.slice(0, 8) : "none");

export function failureCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":")[0];
}

function running(context) {
  return context.active
    ? `Bakery is still running ${short(context.active)}.`
    : "Nothing is installed yet.";
}

/**
 * The lines to print for a failed command.
 *
 * context.active / context.previous: what the state file says now (null when
 * it could not be read). context.requested: the version the command named.
 * context.command: deploy | bootstrap | rollback | recover | restore.
 * context.phase: the journal phase now, so a switch that did not finish can be
 * told apart from one that was undone.
 */
export function failureLines(error, context = {}) {
  const code = failureCode(error);
  const tail = `[${code}]`;
  const current = short(context.active);
  const previous = short(context.previous);
  const lines = (...rows) => [...rows, tail];
  switch (code) {
    case "ROOT_REQUIRED":
      return lines(
        "This command has to run as root. Nothing was changed.",
        `Run it again with sudo: sudo ${COMMAND} ${
          context.command ?? "status"
        }`,
      );
    case "EXPECTED_DEPLOY_ROLLBACK_RECOVER_RENDER":
      return lines(
        "That is not a command the launcher knows. Nothing was changed.",
        "Use one of: deploy, bootstrap, rollback, recover, restore, render, status.",
      );
    case "RELEASE_SHA_INVALID":
    case "ARCHIVE_DIGEST_INVALID":
    case "RELEASE_MANIFEST_INVALID":
    case "RELEASE_MIGRATION_INVALID":
    case "RELEASE_ASSET_INVALID":
      return lines(
        "This release could not be verified, so nothing was changed.",
        running(context),
      );
    case "DEPLOY_PREPARE_FAILED":
      return lines(
        "This release could not be unpacked and checked, so nothing was changed.",
        running(context),
      );
    case "APPLIED_MIGRATION_CHANGED":
    case "APPLIED_MIGRATION_REMOVED":
      return lines(
        "This release rewrites or drops a database change Bakery already applied.",
        `It was not installed. ${running(context)}`,
      );
    case "MIGRATION_COMPATIBILITY_REVIEW_REQUIRED":
      return lines(
        `This update changes the database in a way ${current} could not read`,
        "afterwards. It was not installed.",
        running(context),
        "A person has to review the migration and list it as safe in the",
        "release's expand list before it can be installed.",
      );
    case "ROLLBACK_SCHEMA_INCOMPATIBLE":
      return lines(
        `Going back is not possible: the database was changed in a way ${previous}`,
        `cannot read. Bakery stays on ${current}. Nothing was changed.`,
        ...RESTORE_HINT,
      );
    case "NO_ROLLBACK_BASELINE":
      return lines(
        "There is no earlier version to go back to.",
        `Bakery stays on ${current}. Nothing was changed.`,
        ...RESTORE_HINT,
      );
    case "ROLLBACK_HEAD_CHANGED":
      return lines(
        `Bakery is no longer running ${
          short(context.requested)
        }, so nothing was`,
        `rolled back. ${running(context)}`,
        `Check what is running: ${COMMAND} status`,
      );
    case "ROLLBACK_TARGET_INVALID":
      return lines(
        "The version to go back to is not the one that was kept. Nothing was changed.",
        `Check what is running: ${COMMAND} status`,
      );
    case "BOOTSTRAP_ALREADY_INITIALIZED":
      return lines(
        "Bakery is already set up, so nothing was changed.",
        `${running(context)} To install a new version use: ${COMMAND} deploy`,
      );
    case "RECOVERY_REQUIRED":
      return lines(
        "An earlier update was interrupted, so this command changed nothing.",
        `Finish or undo it first: ${COMMAND} recover`,
      );
    default:
      break;
  }
  const verb = context.command === "rollback" ? "Going back" : "The update";
  if (context.phase === "committed" && NOTHING_CHANGED.has(code) === false) {
    return lines(
      `${verb} did not go through. ${running(context)}`,
      `Check what is running: ${COMMAND} status`,
    );
  }
  if (context.phase && context.phase !== "committed") {
    return lines(
      "The switch was interrupted and Bakery cannot tell which version is",
      `active. Last known: ${current}. Do not start anything by hand.`,
      `Run: ${COMMAND} recover`,
    );
  }
  return [code];
}

/** One progress line: "2/5 Checking database changes   none". */
export function stepLine({ step, total, label, result }) {
  return `${step}/${total} ${label.padEnd(26)} ${result}`;
}

// Failures raised before the first step starts (wrong user, bad arguments, an
// earlier interrupted update, nothing to go back to) are not a failed step.
const BEFORE_STEPS = new Set([
  "ROOT_REQUIRED",
  "EXPECTED_DEPLOY_ROLLBACK_RECOVER_RENDER",
  "ARCHIVE_DIGEST_INVALID",
  "ROLLBACK_HEAD_CHANGED",
  "NO_ROLLBACK_BASELINE",
  "ROLLBACK_TARGET_INVALID",
  "RECOVERY_REQUIRED",
  "BOOTSTRAP_ALREADY_INITIALIZED",
]);

export function failedStepLine(step, total = STEP_LABELS.length, code = "") {
  if (BEFORE_STEPS.has(code) || step < 1 || step > total) return null;
  return stepLine({
    step,
    total,
    label: STEP_LABELS[step - 1],
    result: "failed",
  });
}

/** Closing lines after a deploy or rollback that finished. */
export function completionLines(command, state, before) {
  const active = state.active?.sha;
  if (command === "rollback") {
    return [
      `Went back. Bakery is running ${short(active)}.`,
      "The database was not changed.",
    ];
  }
  if (before?.active?.sha === active) {
    return [`Bakery is already running ${short(active)}. Nothing was changed.`];
  }
  const lines = [`Updated. Bakery is running ${short(active)}.`];
  if (state.previous?.sha) {
    lines.push(
      `${short(state.previous.sha)} is kept so you can go back:`,
      `  ${COMMAND} rollback ${active}`,
    );
  } else {
    lines.push("There is no earlier version to go back to.");
  }
  return lines;
}

function row(label, value) {
  return `${label.padEnd(16)} ${value}`;
}

/** The lines `status` prints. state is the parsed journal, or null. */
export function statusLines(state) {
  if (!state || (!state.active && !state.desired)) {
    return [
      row("Running", "nothing is installed yet"),
      row("Can go back to", "No earlier version is kept."),
      row("State", "Ready for the first install."),
    ];
  }
  const back = state.previous?.sha ?? "No earlier version is kept.";
  if (state.phase === "committed") {
    return [
      row("Running", `${state.active.sha} (${state.active.slot})`),
      row("Can go back to", back),
      row("State", "Ready."),
    ];
  }
  if (state.phase === "enrollment") {
    return [
      row("Running", `${state.desired.sha} (${state.desired.slot})`),
      row("Can go back to", back),
      row("State", "Waiting for the first worker to enroll."),
    ];
  }
  return [
    row("Running", "not certain, a switch was interrupted"),
    row(
      "Last known",
      state.active ? `${state.active.sha} (${state.active.slot})` : "none",
    ),
    row("Can go back to", back),
    row("State", `A switch to ${short(state.desired?.sha)} did not finish.`),
    `Run: ${COMMAND} recover`,
  ];
}
