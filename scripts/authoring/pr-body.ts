import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  isPendingVerification,
  splitMessages,
  staleVerification,
  validateDescription,
} from "./validate.ts";

/**
 * Structured PR descriptions. An author writes a small JSON spec (never raw
 * markdown); this module renders it into the exact template the description
 * check reads, runs the real validator on the result, and lets each verifier
 * change only their own Verification line. The wording, order and limits stay
 * owned by validate.ts, so the two cannot drift.
 */

export type VerifyItem = "backend" | "ui" | "implementation" | "tests";

/** The four merge-gate boxes: the label the validator keys on, who ticks it. */
export const verifyItems: Record<
  VerifyItem,
  { label: string; who: string; checks: string }
> = {
  backend: {
    label: "Backend verified",
    who: "reviewer",
    checks: "contracts, data, permissions and errors behave as described.",
  },
  ui: {
    label: "UI verified",
    who: "design-ux",
    checks:
      "no duplicate of an existing screen or component; fits the navigation; consistent patterns; desktop and phone, light and dark.",
  },
  implementation: {
    label: "Implementation clean",
    who: "reviewer",
    checks:
      "follows existing patterns, no duplicated logic, no dead code, nothing outside the ticket.",
  },
  tests: {
    label: "Tests cover the change",
    who: "qa",
    checks: "new behavior has tests that fail without it.",
  },
};

const itemOrder = Object.keys(verifyItems) as VerifyItem[];

/** How validate.ts names each item inside its error messages. */
const verifyKeys: Record<VerifyItem, string> = {
  backend: "backend verified",
  ui: "ui verified",
  implementation: "implementation clean",
  tests: "tests cover",
};

export interface PrBodySpec {
  /** Owning GitHub issue number (the Ticket line and the Closes/Refs line). */
  ticket: number;
  /** True (default) writes "Closes #n"; false writes "Refs #n" for a slice. */
  closes?: boolean;
  /** Task record; defaults to the ticket. */
  task?: string;
  /** A walkthrough URL; defaults to "not requested". */
  walkthrough?: string;
  /** One or two sentences, at most 40 words. */
  purpose: string;
  /** Level plus one to three bullets of at most 25 words. */
  risk: { level: "Low" | "Medium" | "High"; bullets: string[] };
  /** One to four bullets of at most 25 words; omit for "None". */
  notes?: string[];
  /** A view, or a reason there is no structural change. */
  outline: {
    prose?: string;
    views?: { lang?: string; body: string }[];
    noStructuralChange?: string;
  };
  /** Up to three bullets of at most 30 words; omit for "None". */
  decisions?: string[];
  /** What CI cannot show: UI images (at most four) and the new tests. */
  evidence?: {
    head?: string;
    items?: string[];
    images?: { alt: string; url: string }[];
  };
  /** Items that do not apply to this change, each with its reason. */
  notApplicable?: Partial<Record<VerifyItem, string>>;
}

export const exampleSpec: PrBodySpec = {
  ticket: 123,
  closes: true,
  purpose:
    "Admins can see why a run was refused before they retry it, instead of reading the server log.",
  risk: {
    level: "Low",
    bullets: [
      "Read-only change to the run detail response; no migration. Roll back by reverting the commit.",
    ],
  },
  notes: ["The refusal text is not translated yet; English only."],
  outline: {
    views: [{
      lang: "text",
      body:
        "apps/server/src/modules/runs/\n  detail.ts      + refusalReason\n  detail_test.ts + 2 cases",
    }],
  },
  decisions: [
    "Chose to expose the stored reason over recomputing it, because recomputing can disagree with what the worker saw.",
  ],
  evidence: {
    head: "0123abc",
    items: [
      "tests/unit/run-detail_test.ts: a refused run returns its reason; an accepted run returns none.",
    ],
  },
  notApplicable: {
    ui: "Server response only; no screen changes.",
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Words that make an N/A reason read as "not done yet" to the validator. */
const notYet =
  /\b(?:not yet|pending|in progress|awaiting|waiting|to be (?:reviewed|run|done)|tbd|todo|later)\b/i;

/** Shape errors in a spec, phrased as the field to fix. Empty when sound. */
export function specErrors(input: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(input)) return ["spec: must be a JSON object."];
  const text = (path: string, value: unknown, multiline = false): void => {
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${path}: must be a non-empty string.`);
    } else if (!multiline && /[\r\n]/.test(value)) {
      errors.push(`${path}: must be a single line.`);
    }
  };
  const list = (
    path: string,
    value: unknown,
    min: number,
    max: number,
  ): void => {
    if (!Array.isArray(value)) {
      errors.push(`${path}: must be a list.`);
      return;
    }
    if (value.length < min || value.length > max) {
      errors.push(
        `${path}: needs ${min} to ${max} items (has ${value.length}).`,
      );
    }
    value.forEach((item, index) => text(`${path}[${index}]`, item));
  };
  if (!Number.isSafeInteger(input.ticket) || (input.ticket as number) < 1) {
    errors.push("ticket: must be a positive issue number.");
  }
  text("purpose", input.purpose, true);
  if (!isRecord(input.risk)) {
    errors.push("risk: must be { level, bullets }.");
  } else {
    if (!["Low", "Medium", "High"].includes(input.risk.level as string)) {
      errors.push("risk.level: must be Low, Medium or High.");
    }
    list("risk.bullets", input.risk.bullets, 1, 3);
  }
  if (input.notes !== undefined) list("notes", input.notes, 0, 4);
  if (input.decisions !== undefined) list("decisions", input.decisions, 0, 3);
  if (!isRecord(input.outline)) {
    errors.push("outline: must be { views } or { noStructuralChange }.");
  } else {
    const { views, noStructuralChange, prose } = input.outline;
    if (views !== undefined) {
      if (!Array.isArray(views) || views.length > 3) {
        errors.push("outline.views: at most three views.");
      } else {
        views.forEach((view, index) => {
          if (!isRecord(view)) {
            errors.push(`outline.views[${index}]: must be { lang?, body }.`);
          } else text(`outline.views[${index}].body`, view.body, true);
        });
      }
    }
    if (noStructuralChange !== undefined) {
      text("outline.noStructuralChange", noStructuralChange);
    }
    if (prose !== undefined) text("outline.prose", prose, true);
    if (!(Array.isArray(views) && views.length) && !noStructuralChange) {
      errors.push("outline: give a view or noStructuralChange.");
    }
  }
  if (input.evidence !== undefined) {
    if (!isRecord(input.evidence)) {
      errors.push("evidence: must be { items?, images?, head? }.");
    } else {
      const { items, images, head } = input.evidence;
      if (items !== undefined) list("evidence.items", items, 0, 8);
      if (images !== undefined) {
        if (!Array.isArray(images) || images.length > 4) {
          errors.push(
            "evidence.images: at most four; link a folder for more.",
          );
        } else {
          images.forEach((image, index) => {
            if (!isRecord(image)) {
              errors.push(`evidence.images[${index}]: must be { alt, url }.`);
            } else {
              text(`evidence.images[${index}].alt`, image.alt);
              text(`evidence.images[${index}].url`, image.url);
            }
          });
        }
      }
      if (head !== undefined && !/^[0-9a-f]{7,40}$/.test(String(head))) {
        errors.push("evidence.head: must be a 7 to 40 character commit SHA.");
      }
    }
  }
  if (input.notApplicable !== undefined) {
    if (!isRecord(input.notApplicable)) {
      errors.push("notApplicable: must map an item to its reason.");
    } else {
      for (const [item, reason] of Object.entries(input.notApplicable)) {
        if (!itemOrder.includes(item as VerifyItem)) {
          errors.push(
            `notApplicable.${item}: must be one of ${itemOrder.join(", ")}.`,
          );
        } else {
          text(`notApplicable.${item}`, reason);
          if (typeof reason === "string" && notYet.test(reason)) {
            errors.push(
              `notApplicable.${item}: N/A is for items that do not apply, not work that has not happened yet.`,
            );
          }
        }
      }
    }
  }
  return errors;
}

const bullets = (items: readonly string[] | undefined): string =>
  items?.length
    ? items.map((item) => `- ${item.trim()}`).join("\n")
    : "- None.";

const pendingLine = (item: VerifyItem): string => {
  const { label, who, checks } = verifyItems[item];
  return `- [ ] ${label} (${who}): ${checks}`;
};
const naLine = (item: VerifyItem, reason: string): string => {
  const { label, who } = verifyItems[item];
  return `- [ ] ${label} (${who}) N/A: ${reason.trim()}`;
};
const tickLine = (item: VerifyItem, sha: string, claim: string): string => {
  const { label, who } = verifyItems[item];
  return `- [x] ${label} (${who}) @ ${sha}: ${claim.trim()}`;
};

/** Renders a sound spec to the PR template. Call specErrors first. */
export function renderPrBody(spec: PrBodySpec): string {
  const word = spec.closes === false ? "Refs" : "Closes";
  const outline = [
    spec.outline.prose?.trim(),
    ...(spec.outline.views ?? []).map((view) =>
      `\`\`\`${view.lang ?? "text"}\n${view.body.replace(/\n+$/, "")}\n\`\`\``
    ),
    spec.outline.noStructuralChange
      ? `No structural change: ${spec.outline.noStructuralChange.trim()}`
      : undefined,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
  const images = (spec.evidence?.images ?? []).map((image) =>
    `![${image.alt.trim()}](${image.url.trim()})`
  );
  const evidenceItems = spec.evidence?.items ?? [];
  const evidence = evidenceItems.length || images.length
    ? [evidenceItems.length ? bullets(evidenceItems) : "", ...images]
      .filter(Boolean).join("\n\n")
    : "- None.";
  const head = spec.evidence?.head
    ? ` @ ${spec.evidence.head.slice(0, 8)}`
    : "";
  return [
    `Ticket: #${spec.ticket} | Task: ${
      spec.task?.trim() || `#${spec.ticket}`
    } | Walkthrough: ${spec.walkthrough?.trim() || "not requested"}`,
    `## Purpose\n\n${spec.purpose.trim()}\n\n${word} #${spec.ticket}`,
    `## Risk\n\nLevel: ${spec.risk.level}\n\n${bullets(spec.risk.bullets)}`,
    `## Special things to note\n\n${bullets(spec.notes)}`,
    `## Change outline\n\n${outline}`,
    `## Decisions\n\n${bullets(spec.decisions)}`,
    `## Evidence${head}\n\n${evidence}`,
    `## Verification\n\n${
      itemOrder.map((item) => {
        const reason = spec.notApplicable?.[item];
        return reason ? naLine(item, reason) : pendingLine(item);
      }).join("\n")
    }`,
  ].join("\n\n") + "\n";
}

const isPending = isPendingVerification;

export interface BuildResult {
  body: string;
  /** Real problems: shape errors or validator errors other than pending. */
  errors: string[];
  /** Boxes still waiting for a verifier; expected on a new or open PR. */
  pending: string[];
}

/** Spec in, validated body out. Pending sign-offs are reported, not errors. */
export function buildPrBody(input: unknown): BuildResult {
  const shape = specErrors(input);
  if (shape.length) return { body: "", errors: shape, pending: [] };
  const body = renderPrBody(input as PrBodySpec);
  const all = validateDescription("pr", body);
  return {
    body,
    errors: all.filter((error) => !isPending(error)),
    pending: all.filter(isPending),
  };
}

export type VerifyUpdate =
  | { state: "tick"; sha: string; claim: string }
  | { state: "na"; reason: string }
  | { state: "pending" };

const verificationHeading = /^ {0,3}#{2,3}[ \t]+Verification[ \t]*#*[ \t]*$/i;

function itemIndex(
  lines: string[],
  item: VerifyItem,
): number {
  const start = lines.findIndex((line) => verificationHeading.test(line));
  if (start < 0) throw new Error("The body has no Verification section.");
  const label = new RegExp(
    `^[-*] \\[.\\]\\s*${
      verifyItems[item].label.split(" ").slice(0, 2).join(" ")
    }\\b`,
    "i",
  );
  const hits = lines.map((line, index) => ({ line, index })).filter((entry) =>
    entry.index > start && label.test(entry.line)
  );
  if (hits.length !== 1) {
    throw new Error(
      `Expected one "${
        verifyItems[item].label
      }" line in Verification, found ${hits.length}.`,
    );
  }
  return hits[0].index;
}

/**
 * Changes one Verification line and nothing else. The caller re-validates; a
 * tick must carry the head SHA it was checked at and a claim that says what
 * was verified.
 */
export function setVerification(
  body: string,
  item: VerifyItem,
  update: VerifyUpdate,
): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const index = itemIndex(lines, item);
  if (update.state === "tick") {
    if (!/^[0-9a-f]{7,40}$/.test(update.sha)) {
      throw new Error("A tick needs the head commit SHA it was checked at.");
    }
    if (!update.claim.trim()) {
      throw new Error("A tick needs a claim: say what was verified.");
    }
    lines[index] = tickLine(item, update.sha.slice(0, 8), update.claim);
  } else if (update.state === "na") {
    if (!update.reason.trim() || notYet.test(update.reason)) {
      throw new Error(
        "N/A needs a reason the item does not apply (not 'pending' or 'later').",
      );
    }
    lines[index] = naLine(item, update.reason);
  } else lines[index] = pendingLine(item);
  return lines.join(eol);
}

/**
 * Re-publishing a spec must not erase sign-offs already on the live body:
 * the verifiers own those lines. N/A lines carry over, and so do ticks made at
 * the PR head; a tick at another commit names code that is gone, so it takes
 * the freshly rendered open line like any other open box.
 */
export function carryVerification(
  rendered: string,
  live: string,
  head: string,
): string {
  const now = head.toLowerCase();
  const atHead = (line: string): boolean => {
    const sha = /@\s*([0-9a-f]{7,40})\b/i.exec(line)?.[1]?.toLowerCase();
    return sha !== undefined && now.startsWith(sha);
  };
  let result = rendered;
  for (const item of itemOrder) {
    try {
      const liveLines = live.split(/\r?\n/);
      const kept = liveLines[itemIndex(liveLines, item)];
      if (
        (/^[-*] \[[xX]\]/.test(kept) && atHead(kept)) ||
        /\bN\/A:\s*\S/.test(kept)
      ) {
        const lines = result.split("\n");
        lines[itemIndex(lines, item)] = kept;
        result = lines.join("\n");
      }
    } catch {
      // A live body without that line has nothing to carry.
    }
  }
  return result;
}

/** The `gh pr create` arguments: ready for review unless a draft is asked for, because a draft cannot merge and skips some CI. */
export function createPrArgs(title: string, draft: boolean): string[] {
  return [
    "pr",
    "create",
    ...(draft ? ["--draft"] : []),
    "--title",
    title,
    "--body-file",
    "-",
  ];
}

/**
 * What re-publishing a spec onto a live PR would send: the new body with the
 * live sign-offs carried over, the format errors that stop it, and the lines
 * still open at the PR head. A format error means nothing is sent.
 */
export function prepareRepublish(
  rendered: string,
  live: { body: string; headRefOid: string },
): { body: string; errors: string[]; pending: string[] } {
  const body = carryVerification(rendered, live.body, live.headRefOid);
  const found = splitMessages(validateDescription("pr", body));
  return {
    body,
    errors: found.errors,
    pending: [...found.pending, ...staleVerification(body, live.headRefOid)],
  };
}

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 1 << 24,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

const livePull = (number: string): { body: string; headRefOid: string } => {
  const data = JSON.parse(
    gh(["pr", "view", number, "--json", "body,headRefOid"]),
  );
  return { body: data.body ?? "", headRefOid: data.headRefOid };
};

async function readInput(path: string): Promise<string> {
  if (path !== "-") return (await import("node:fs")).readFileSync(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Flags that stand alone; every other --flag takes the next argument. */
const switches = new Set(["tick", "reset", "create", "dry-run", "draft"]);

export function parseArgs(
  args: string[],
): { options: Map<string, string>; positional: string[] } {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
    } else if (switches.has(arg.slice(2))) {
      options.set(arg.slice(2), "true");
    } else {
      options.set(arg.slice(2), args[++index] ?? "");
    }
  }
  return { options, positional };
}

const usage = `Usage:
  pr-body.ts example
  pr-body.ts render <spec.json|->
  pr-body.ts publish <spec.json|-> --pr <n>
  pr-body.ts publish <spec.json|-> --create --title <title> [--draft]
  pr-body.ts verify <backend|ui|implementation|tests> --tick --sha <sha> --claim <text> [--pr <n> | <body.md|->]
  pr-body.ts verify <item> --na <reason> | --reset [--pr <n> | <body.md|->]
  Add --dry-run to publish or verify --pr to print the new body without editing the PR.`;

function report(errors: string[], pending: string[] = []): void {
  console.error(JSON.stringify({ ok: errors.length === 0, errors, pending }));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { options, positional } = parseArgs(rest);
  if (command === "example") {
    console.log(JSON.stringify(exampleSpec, null, 2));
  } else if (command === "render" || command === "publish") {
    const source = positional[0];
    if (!source) {
      console.error(usage);
      process.exit(2);
    }
    const built = buildPrBody(JSON.parse(await readInput(source)));
    if (built.errors.length) {
      report(built.errors, built.pending);
      process.exit(1);
    }
    if (command === "render") {
      process.stdout.write(built.body);
      report([], built.pending);
    } else if (options.has("pr")) {
      const number = options.get("pr")!;
      const live = livePull(number);
      const next = prepareRepublish(built.body, live);
      // A format error stops here: nothing is sent, the fix is printed.
      if (next.errors.length) {
        report(next.errors, next.pending);
        process.exit(1);
      }
      if (options.has("dry-run")) process.stdout.write(next.body);
      else gh(["pr", "edit", number, "--body-file", "-"], next.body);
      report([], next.pending);
    } else if (options.has("create") && options.has("title")) {
      process.stdout.write(
        gh(
          createPrArgs(options.get("title")!, options.has("draft")),
          built.body,
        ),
      );
      report([], built.pending);
    } else {
      console.error(usage);
      process.exit(2);
    }
  } else if (command === "verify") {
    const item = positional[0] as VerifyItem;
    if (!itemOrder.includes(item)) {
      console.error(usage);
      process.exit(2);
    }
    const update: VerifyUpdate = options.has("tick")
      ? {
        state: "tick",
        sha: options.get("sha") ?? "",
        claim: options.get("claim") ?? "",
      }
      : options.has("na")
      ? { state: "na", reason: options.get("na")! }
      : { state: "pending" };
    if (options.has("pr")) {
      const number = options.get("pr")!;
      const first = livePull(number);
      if (
        update.state === "tick" && !first.headRefOid.startsWith(update.sha)
      ) {
        throw new Error(
          `Head moved: the PR is at ${
            first.headRefOid.slice(0, 8)
          }, not ${update.sha}. Re-check before ticking.`,
        );
      }
      const next = setVerification(first.body, item, update);
      const mine = validateDescription("pr", next).filter((error) =>
        error.includes(`"${verifyKeys[item]}"`)
      );
      if (mine.length && update.state !== "pending") {
        report(mine);
        process.exit(1);
      }
      if (livePull(number).body !== first.body) {
        throw new Error("The body changed while editing; run it again.");
      }
      if (options.has("dry-run")) process.stdout.write(next);
      else gh(["pr", "edit", number, "--body-file", "-"], next);
      report([], splitMessages(validateDescription("pr", next)).pending);
    } else {
      const source = positional[1];
      if (!source) {
        console.error(usage);
        process.exit(2);
      }
      process.stdout.write(
        setVerification(await readInput(source), item, update),
      );
    }
  } else {
    console.error(usage);
    process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    report([error instanceof Error ? error.message : String(error)]);
    process.exit(1);
  });
}
