// What the launcher prints. Pure functions, no I/O: release.mjs reads the
// state file and writes the lines; these only turn a state or an error code
// into words. Rules (design for #59): the first line says what state Bakery is
// in, the next says whether anything changed, then the one next command, and
// the code goes last in square brackets so it can be searched for.

export const STEP_LABELS = [
  "Checking the release",
  "Checking database changes",
  "Pausing work",
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
  "INSTALLATION_RESTORING",
  "MAINTENANCE_HELD",
  "DRAIN_TIMEOUT",
  "ROLLBACK_SCHEMA_INCOMPATIBLE",
  "NO_ROLLBACK_BASELINE",
  "ROLLBACK_HEAD_CHANGED",
  "ROLLBACK_TARGET_INVALID",
  "BOOTSTRAP_ALREADY_INITIALIZED",
  "RECOVERY_REQUIRED",
  "ROOT_REQUIRED",
  "EXPECTED_DEPLOY_ROLLBACK_RECOVER_RENDER",
]);

/** The installation's choice, in the words the Updates page uses. */
export function policyWords(policy) {
  if (policy === undefined) return "nothing is installed yet";
  if (policy === null) return "not available just now";
  return policy.onFailure === "ask"
    ? "ask before going back"
    : "go back by itself";
}

// Failures that mean "this update was refused": the host is exactly as it was
// and the history says why. A wrong user or command is not an update at all.
const NOT_AN_UPDATE = new Set([
  "ROOT_REQUIRED",
  "EXPECTED_DEPLOY_ROLLBACK_RECOVER_RENDER",
]);

export function isRefusal(code) {
  return NOTHING_CHANGED.has(code) && !NOT_AN_UPDATE.has(code);
}

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
    case "INSTALLATION_RESTORING":
      return lines(
        "Bakery is held after a restore, so it was not updated.",
        "Finish the restore first: open Bakery, Installation, Restore.",
      );
    case "MAINTENANCE_HELD":
      return lines(
        "A backup is running, so Bakery was not updated. Nothing was changed.",
        `${running(context)} Try again when the backup has finished.`,
      );
    case "DRAIN_TIMEOUT":
      return lines(
        "Work that is running did not finish in time, so Bakery was not",
        `updated. ${running(context)} It is taking work as before.`,
        "Try again in a few minutes.",
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
    case "UPDATE_LEFT_UNHEALTHY":
      return lines(
        `Bakery is not healthy on ${
          short(context.requested)
        } and was left as it is.`,
        "Work stays paused. It starts again by itself within 35 minutes.",
        `To go back to ${current} now: ${COMMAND} recover`,
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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Carried over: 3 tasks, 1 approval, 2 open questions." */
export function carriedOverLine(counts) {
  return `Carried over: ${plural(counts.tasks, "task")}, ${
    plural(counts.approvals, "approval")
  }, ${plural(counts.questions, "open question")}.`;
}

/** What may or may not have happened outside Bakery, in #64's words. */
function unsureLinesFor(counts) {
  if (!counts || counts.outsideActionsUnsure === 0) return [];
  const n = counts.outsideActionsUnsure;
  return [
    `${
      plural(n, "outside action is", "outside actions are")
    } held. They may or may not`,
    "have happened. Bakery never sends them again; each is checked first.",
    `See them: ${COMMAND} status --unsure`,
  ];
}

/**
 * Closing lines after a deploy or rollback that finished. `resumed` is what
 * waited through an update: the counts when work was resumed, null when it could
 * not be (the pause then lapses by itself), undefined when nothing was paused.
 */
export function completionLines(command, state, before, resumed) {
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
  if (resumed) lines.push(`${carriedOverLine(resumed)} Work has resumed.`);
  else if (resumed === null) {
    lines.push(
      "Work could not be resumed just now. It starts again by itself within",
      `35 minutes, or run: ${COMMAND} recover`,
    );
  }
  lines.push(...unsureLinesFor(resumed));
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

/** What the person sees before being asked whether to go back. */
export function askLines({ from, to }) {
  return [
    `Bakery is not healthy on ${short(from)}.`,
    "",
    row("Running", from),
    row("Can go back to", to),
    row("Update policy", policyWords({ onFailure: "ask" })),
    "",
  ];
}

const clock = (iso) => iso.slice(11, 16);

/**
 * The line that says an answer was kept: who, when, and that it was given at
 * the server. Nothing when no one was asked. `decision` is the recorded event
 * of kind decided_go_back or decided_stay, with whether this host and Bakery
 * have it.
 */
export function decisionLines(decision) {
  // No one was asked (nobody could be): there is no answer to report.
  if (!decision || decision.by === null) return [];
  const who = `by ${decision.by} at ${
    clock(decision.at)
  } UTC, from the server.`;
  const lines = decision.kind === "decided_go_back"
    ? [`Decision recorded: gone back ${who}`]
    : [
      `Decision recorded: kept ${short(decision.fromRelease)} ${who}`,
      `To go back: ${COMMAND} recover`,
    ];
  if (!decision.inBakery && decision.kept) {
    lines.push(
      "Bakery's history does not have it yet. It is sent the next time you run:",
      `  ${COMMAND} recover`,
    );
  } else if (!decision.inBakery) {
    lines.push("It could not be recorded, on this server or in Bakery.");
  }
  return lines;
}

function row(label, value) {
  return `${label.padEnd(16)} ${value}`;
}

/**
 * The line for what is waiting. counts is the database's answer, null when it
 * did not answer, undefined when there is no release to ask with yet.
 */
function workRow(counts) {
  if (counts === undefined) return row("Work", "nothing is installed yet");
  if (counts === null) {
    return row("Work", "not available, the database did not answer");
  }
  return row(
    "Work",
    `${plural(counts.tasks, "task")}, ${
      plural(counts.approvals, "approval")
    }, ${plural(counts.questions, "open question")}`,
  );
}

/** The lines `status` prints. state is the parsed journal, or null. */
export function statusLines(state, counts, policy) {
  if (!state || (!state.active && !state.desired)) {
    return [
      row("Running", "nothing is installed yet"),
      row("Can go back to", "No earlier version is kept."),
      workRow(undefined),
      row("Update policy", policyWords(undefined)),
      row("State", "Ready for the first install."),
    ];
  }
  const back = state.previous?.sha ?? "No earlier version is kept.";
  const unsure = unsureLinesFor(counts ?? undefined);
  if (state.phase === "committed") {
    return [
      row("Running", `${state.active.sha} (${state.active.slot})`),
      row("Can go back to", back),
      workRow(counts),
      row("Update policy", policyWords(policy ?? null)),
      row("State", "Ready."),
      ...unsure,
    ];
  }
  if (state.phase === "enrollment") {
    return [
      row("Running", `${state.desired.sha} (${state.desired.slot})`),
      row("Can go back to", back),
      workRow(counts),
      row("Update policy", policyWords(policy ?? null)),
      row("State", "Waiting for the first worker to enroll."),
      ...unsure,
    ];
  }
  return [
    row("Running", "not certain, a switch was interrupted"),
    row(
      "Last known",
      state.active ? `${state.active.sha} (${state.active.slot})` : "none",
    ),
    row("Can go back to", back),
    workRow(counts),
    row("Update policy", policyWords(policy ?? null)),
    row("State", `A switch to ${short(state.desired?.sha)} did not finish.`),
    `Run: ${COMMAND} recover`,
  ];
}

/** `status --unsure`: the outside actions whose outcome is unknown, by kind. */
export function unsureLines(actions) {
  if (actions === undefined) return ["Nothing is installed yet."];
  if (actions === null) {
    return ["The database did not answer, so the list cannot be shown."];
  }
  if (actions.length === 0) return ["No outside action needs a look."];
  return [
    "These outside actions may or may not have happened. Bakery never sends",
    "them again; each is checked first.",
    ...actions.map((a) =>
      `  ${plural(a.count, "action")} of ${a.operation}, since ${a.since}`
    ),
  ];
}
