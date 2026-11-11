/**
 * The fixed coding tasks of the M1 journey and the checks on the
 * patches they produce. No Playwright import and no side effect, so Deno (the
 * unit tests `tests/unit/m1-task_test.ts` and friends) and Node (the journey
 * spec) both import it.
 *
 * Every funded run gets its own task over its own functions: the main run
 * (`main`, the plan-first task of P4 to P7) documents one function, and the
 * fault, cancel and queued runs (P8, P9) each document three different
 * functions in three different files. Each task asks the real executor for an
 * accurate one-paragraph doc comment per function and nothing else, so a run is
 * long enough for a mid-run kill or cancel to land inside it, a clone that
 * still holds an earlier run's commit cannot make a later run a no-op, and the
 * patch check is the same for every run: comment lines only, no removals,
 * exactly the named files, each comment directly above its function.
 *
 * The functions were chosen by searching the repository for small exported
 * functions with no doc comment directly above them (4 to 14 lines, in files
 * that are neither generated nor tests), one function per file, no function in
 * two runs. `tests/unit/m1-task_test.ts` re-reads each file and fails when a
 * function gains a comment, loses its export or moves.
 */

/** Repository-relative path of the one file the change may touch. */
export const M1_TASK_FILE = "packages/ui/src/atoms/theme.ts";

/** The one exported function that gets the doc comment. */
export const M1_TASK_FUNCTION = "parseTheme";

export const M1_TASK_TITLE = "Document parseTheme in the UI theme atoms";

/** The main run's task text, fixed so every run of it asks for the same change. */
export const M1_TASK_DESCRIPTION = [
  `Add a doc comment to the exported function ${M1_TASK_FUNCTION} in`,
  `${M1_TASK_FILE}.`,
  "The comment is exactly one accurate paragraph that says what the function",
  "accepts and what it returns, including the fallback.",
  "Change nothing else: no other function, no other file, no code.",
  "The only edit is the comment directly above the function.",
].join(" ");

/** One exported function that gets a doc comment, in the file that declares it. */
export type DocTarget = { readonly file: string; readonly fn: string };

export type RunTaskKey = "main" | "faults" | "cancel" | "queued";

export type RunTask = {
  readonly key: RunTaskKey;
  readonly title: string;
  readonly description: string;
  readonly targets: readonly DocTarget[];
};

function multiFunctionTask(
  key: Exclude<RunTaskKey, "main">,
  title: string,
  targets: readonly DocTarget[],
): RunTask {
  const list = targets.map((target) => `\`${target.fn}\` in \`${target.file}\``)
    .join("; ");
  return {
    key,
    title,
    targets,
    description: [
      `Add a doc comment to each of these ${targets.length} exported functions: ${list}.`,
      "Each comment is an accurate one-paragraph doc comment that says what",
      "the function accepts, what it returns and when it throws, if it does.",
      "Put each comment directly above its function. Change nothing else: no",
      "other function, no other file, no code.",
      "When the comments are in place, run `deno fmt --check` on the changed",
      "files and say what it reported.",
    ].join(" "),
  };
}

/** The task of each funded run (P6, P8, P9 cancel, P9 queued). */
export const M1_RUN_TASKS: Readonly<Record<RunTaskKey, RunTask>> = {
  main: {
    key: "main",
    title: M1_TASK_TITLE,
    description: M1_TASK_DESCRIPTION,
    targets: [{ file: M1_TASK_FILE, fn: M1_TASK_FUNCTION }],
  },
  faults: multiFunctionTask("faults", "Document three helpers (faults run)", [
    {
      file: "packages/contracts/src/integrations.ts",
      fn: "formatActionReference",
    },
    {
      file: "apps/server/src/modules/knowledge/previews/shared.ts",
      fn: "timingSafeEqualHex",
    },
    { file: "apps/worker/src/storage.ts", fn: "assertAbsolutePath" },
  ]),
  cancel: multiFunctionTask("cancel", "Document three helpers (cancel run)", [
    { file: "packages/contracts/src/http.ts", fn: "getTraceId" },
    {
      file: "apps/worker/src/registration-store.ts",
      fn: "generateWorkerCredential",
    },
    {
      file: "apps/server/src/modules/catalog/storage-port.ts",
      fn: "assertSkillObjectKey",
    },
  ]),
  queued: multiFunctionTask("queued", "Document three helpers (queued run)", [
    { file: "apps/worker/src/supervisor-support.ts", fn: "isLeaseLoss" },
    {
      file: "apps/server/src/modules/knowledge/media.ts",
      fn: "inferArtifactMediaType",
    },
    {
      file: "apps/server/src/modules/auth/scim/credentials.ts",
      fn: "sha256Hex",
    },
  ]),
};

/**
 * The first message to the coordinator. It asks for one clarifying question
 * before the plan, so the journey meets a real pause at a question.
 */
export const M1_PLAN_REQUEST = [
  "Before you write the plan, ask me exactly one question:",
  "should the doc comment use block style (/** ... */) or line style (// ...)?",
  "Offer both styles as options. When I answer, propose the plan.",
].join(" ");

/** The message for a task that needs a plan with no question first. */
export const M1_PLAN_ONLY_REQUEST =
  "Please propose the plan for this task now. Do not ask any question.";

/** The change request that makes the plan name the one function and file. */
export const M1_CHANGE_REQUEST = [
  `Please make the plan name ${M1_TASK_FUNCTION} and ${M1_TASK_FILE} in its`,
  "title and state that the change adds a comment only.",
].join(" ");

/** The answer chosen when the question has no option to pick. */
export const M1_QUESTION_TEXT_ANSWER = "Use block style (/** ... */).";

/** Every file a unified diff (`git diff --binary`) changes, in order, deduplicated. */
export function patchFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match === null) continue;
    for (const path of [match[1], match[2]]) {
      if (!files.includes(path)) files.push(path);
    }
  }
  return files;
}

/** The added lines of a unified diff (those starting with `+`, not `+++`). */
export function addedLines(diff: string): string[] {
  return diff.split("\n").filter((line) =>
    line.startsWith("+") && !line.startsWith("+++")
  ).map((line) => line.slice(1));
}

/** True for a line that is a comment line or blank: `/**`, ` *`, `*\/` or `//`. */
export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("/*") ||
    trimmed.startsWith("*") || trimmed.startsWith("//");
}

/** The patch adds at least one line and every added line is a comment line. */
export function addsOnlyComments(diff: string): boolean {
  const added = addedLines(diff);
  return added.some((line) => line.trim() !== "") && added.every(isCommentLine);
}

/** The patch removes no line: a doc comment is purely additive. */
export function removesNothing(diff: string): boolean {
  return !diff.split("\n").some((line) =>
    line.startsWith("-") && !line.startsWith("---")
  );
}

/**
 * The model named by each Claude Code `system/init` record in a stream-json
 * stdout. The journey compares it with the pinned proof model.
 */
export function claudeInitModels(stdout: string): string[] {
  const models: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const record = JSON.parse(trimmed) as {
        type?: unknown;
        subtype?: unknown;
        model?: unknown;
      };
      if (
        record.type === "system" && record.subtype === "init" &&
        typeof record.model === "string"
      ) models.push(record.model);
    } catch {
      // Not a JSON line (a log line or a partial record): nothing to read.
    }
  }
  return models;
}

// ---- the patch of a doc-comment run ------------------------------------------------------

type AddedBlock = {
  /** The added lines, without their `+`. */
  readonly lines: string[];
  /** The line right after the block when it is a context line; else null. */
  readonly next: string | null;
};

type FileChange = {
  readonly file: string;
  readonly blocks: AddedBlock[];
  removed: number;
};

/**
 * Splits a unified diff into per-file changes: each contiguous block of added
 * lines with the context line that follows it, and the count of removed lines.
 * Hunk headers (`@@ ... @@ <function>`) are never read as code: git prints the
 * last column-zero line before the hunk there, which names a function the
 * hunk may not touch.
 */
function fileChanges(diff: string): FileChange[] {
  const changes: FileChange[] = [];
  let current: FileChange | undefined;
  let block: { lines: string[] } | undefined;
  let inHunk = false;
  const closeBlock = (next: string | null) => {
    if (current && block) current.blocks.push({ lines: block.lines, next });
    block = undefined;
  };
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      closeBlock(null);
      current = { file: header[2], blocks: [], removed: 0 };
      changes.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      closeBlock(null);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      block ??= { lines: [] };
      block.lines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      closeBlock(null);
      current.removed++;
    } else if (line.startsWith(" ")) {
      closeBlock(line.slice(1));
    } else {
      // `\ No newline at end of file`, a blank separator or the end of input.
      closeBlock(null);
    }
  }
  closeBlock(null);
  return changes;
}

/**
 * Problems with a doc-comment patch; an empty list means it is the change the
 * task asked for. The patch must touch exactly the files of `targets`; in each
 * file add exactly one block of comment lines and remove nothing; and the line
 * right after that block must declare the target function. A comment above a
 * neighbouring function fails, whatever the hunk header says.
 */
export function verifyDocCommentPatch(
  diff: string,
  targets: readonly DocTarget[],
): string[] {
  const problems: string[] = [];
  const changes = fileChanges(diff);
  const touched = changes.map((change) => change.file);
  const expected = targets.map((target) => target.file);
  for (const file of touched) {
    if (!expected.includes(file)) {
      problems.push(`touches ${file}, which no target names`);
    }
  }
  for (const target of targets) {
    const change = changes.find((entry) => entry.file === target.file);
    if (!change) {
      problems.push(
        `${target.file} is not changed (${target.fn} has no comment)`,
      );
      continue;
    }
    if (change.removed > 0) {
      problems.push(`${target.file} removes ${change.removed} line(s)`);
    }
    if (change.blocks.length !== 1) {
      problems.push(
        `${target.file} adds ${change.blocks.length} blocks, expected one comment above ${target.fn}`,
      );
      continue;
    }
    const [block] = change.blocks;
    if (
      !block.lines.some((line) => line.trim() !== "") ||
      !block.lines.every(isCommentLine)
    ) {
      problems.push(`${target.file} adds a line that is not a comment line`);
    }
    const declaration = new RegExp(`^export (async )?function ${target.fn}\\b`);
    if (block.next === null || !declaration.test(block.next)) {
      problems.push(
        `the comment in ${target.file} is not directly above ${target.fn} (next line: ${
          block.next ?? "none"
        })`,
      );
    }
  }
  return problems;
}

// ---- the brief artifact carries the approved revision ----------------------------------

/** What the approved plan revision must look like inside the run's brief. */
export type ExpectedPlan = {
  readonly revision: number;
  readonly planRevisionId: string;
  readonly digest: string;
};

/**
 * Problems with the task brief artifact (`task-brief-<job>-<fence>.json`, the
 * JSON `renderTaskBrief` in `apps/worker/src/task-brief.ts` publishes) against
 * the plan revision the approval named. It fails only on a real mismatch.
 */
export function checkBriefApprovedPlan(
  briefText: string,
  expected: ExpectedPlan,
): string[] {
  let brief: unknown;
  try {
    brief = JSON.parse(briefText);
  } catch {
    return ["the brief artifact is not JSON"];
  }
  if (brief === null || typeof brief !== "object") {
    return ["the brief artifact is not an object"];
  }
  const record = brief as Record<string, unknown>;
  const problems: string[] = [];
  if (record.schema !== "bakery.task-brief/v1") {
    problems.push(
      `schema is ${String(record.schema)}, not bakery.task-brief/v1`,
    );
  }
  const plan = record.approvedPlan;
  if (plan === null || typeof plan !== "object") {
    problems.push("the brief carries no approvedPlan");
    return problems;
  }
  const approved = plan as Record<string, unknown>;
  if (approved.revision !== expected.revision) {
    problems.push(
      `approvedPlan.revision is ${
        String(approved.revision)
      }, expected ${expected.revision}`,
    );
  }
  if (approved.planRevisionId !== expected.planRevisionId) {
    problems.push(
      `approvedPlan.planRevisionId is ${
        String(approved.planRevisionId)
      }, expected ${expected.planRevisionId}`,
    );
  }
  if (approved.digest !== expected.digest) {
    problems.push("approvedPlan.digest differs from the plan revision digest");
  }
  return problems;
}

// ---- deciding an expired approval ----------------------------------------------------------

export type DecisionResponse = { status: number; body: string };
export type RefusedDecision = DecisionResponse & { path: "ui" | "api" };

/**
 * Sends the decision on an approval the clock move has expired, by the UI when
 * the Approve button is still there and by the API when a refetch already
 * removed it, and returns the server's answer. The page-response promise is
 * read only after a click that happened: an API request never reaches it, so
 * waiting on it for the API path would only time out.
 */
export async function decideRefused(options: {
  /** Clicks the Approve button; rejects when it is no longer there. */
  clickApprove: () => Promise<void>;
  /** The page's response to the decision POST, or null when none arrived. */
  uiResponse: Promise<DecisionResponse | null>;
  /** The same decision sent through the API; resolves with its status and body. */
  sendByApi: () => Promise<DecisionResponse>;
}): Promise<RefusedDecision> {
  let clicked = false;
  try {
    await options.clickApprove();
    clicked = true;
  } catch {
    // The button was gone: use the API path below.
  }
  if (clicked) {
    const response = await options.uiResponse;
    if (response === null) {
      throw new Error(
        "M1_DECISION_NOT_SEEN: the click sent no decision request",
      );
    }
    return { ...response, path: "ui" };
  }
  return { ...(await options.sendByApi()), path: "api" };
}

// ---- a duplicate decision on an approved approval ----------------------------------------

/** The fields of an approval the duplicate-decision check compares. */
export type ApprovalSnapshot = {
  id: string;
  status: string;
  version: number;
  decision: string | null;
};

type Answer = { status: number; body: Record<string, unknown> };

/**
 * Problems with how the server answered two decisions sent after the page's
 * approve. An identical decision (same decision and comment, so the same
 * digest) is acknowledged with 200 and the stored approval, unchanged
 * (`approvals.ts`: `answer_digest === digest` returns the row, and
 * `tests/integration/persist-scoped-workflow-approvals_test.ts` pins the 200).
 * A conflicting decision (a reject on an approved approval) is refused with
 * 409 `approval_decided`. Neither may change the stored approval. An empty
 * list means the server did exactly that.
 */
export function checkDuplicateDecision(options: {
  before: ApprovalSnapshot;
  identical: Answer;
  conflicting: Answer;
  after: ApprovalSnapshot;
}): string[] {
  const { before, identical, conflicting, after } = options;
  const problems: string[] = [];
  if (identical.status !== 200) {
    problems.push(
      `an identical duplicate answered ${identical.status}, expected the 200 replay`,
    );
  } else {
    if (identical.body.id !== before.id) {
      problems.push("the replay returned another approval");
    }
    if (identical.body.version !== before.version) {
      problems.push(
        `the replay changed the version ${before.version} to ${
          String(identical.body.version)
        }`,
      );
    }
  }
  if (conflicting.status !== 409) {
    problems.push(
      `a conflicting decision answered ${conflicting.status}, expected 409`,
    );
  } else if (conflicting.body.reason !== "approval_decided") {
    problems.push(
      `a conflicting decision was refused for ${
        String(conflicting.body.reason)
      }, expected approval_decided`,
    );
  }
  if (after.version !== before.version) {
    problems.push(
      `the stored version moved ${before.version} to ${after.version}`,
    );
  }
  if (after.decision !== before.decision) {
    problems.push(
      `the stored decision moved ${String(before.decision)} to ${
        String(after.decision)
      }`,
    );
  }
  if (after.status !== before.status) {
    problems.push(
      `the stored status moved ${before.status} to ${after.status}`,
    );
  }
  return problems;
}
