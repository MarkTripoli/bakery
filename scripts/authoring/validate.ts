export const fields = {
  issue: [
    "Description",
    "Execution classification",
    "Dependencies",
    "Checklist",
    "Technical details",
    "Acceptance criteria",
    "Design and UX",
    "Verification and closure",
    "Sources",
  ],
  epic: [
    "Description",
    "Child issues",
    "Acceptance criteria",
    "Dependencies",
    "Sources",
  ],
  pr: [
    "Ticket",
    "Task",
    "Walkthrough",
    "Purpose",
    "Risk",
    "Special things to note",
    "Change outline",
    "Decisions",
    "Evidence",
  ],
} as const;

export type Kind = keyof typeof fields;
const key = (text: string) =>
  text.trim().toLowerCase().replace(/:$/, "").replace(/\s+@\s+\S+$/, "");
const known = new Set(Object.values(fields).flat().map(key));

export function parseDescription(body: string) {
  const sections = new Map<string, string[]>();
  const views = new Set<string>();
  const errors: string[] = [];
  let current = "";
  let fence = "";
  let fenceContent: string[] = [];
  let comment = false;
  let rawEnd: RegExp | null = null;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (rawEnd) {
      sections.get(current)?.push(raw);
      if (rawEnd.test(raw)) rawEnd = null;
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      sections.get(current)?.push(raw);
      if (
        marker && marker[1][0] === fence[0] &&
        marker[1].length >= fence.length && !marker[2].trim()
      ) {
        if (!unfinished(fenceContent.join("\n"), true)) views.add(current);
        fence = "";
      } else fenceContent.push(raw);
      continue;
    }
    if (!comment && marker) {
      fence = marker[1];
      fenceContent = [];
      sections.get(current)?.push(raw);
      continue;
    }
    if (!comment) {
      const rawTag = /^ {0,3}<(pre|script|style|textarea)(?:\s|>|$)/i.exec(raw);
      const end = rawTag
        ? new RegExp("</" + rawTag[1] + ">", "i")
        : /^ {0,3}<\?/.test(raw)
        ? /\?>/
        : /^ {0,3}<!\[CDATA\[/.test(raw)
        ? /\]\]>/
        : /^ {0,3}<![A-Z]/.test(raw)
        ? />/
        : /^ {0,3}<\/?[A-Za-z][\w-]*(?:\s|\/?>)/.test(raw)
        ? /^\s*$/
        : null;
      if (end) {
        sections.get(current)?.push(raw);
        if (!end.test(raw)) rawEnd = end;
        continue;
      }
    }
    // Code owns its literal comment delimiters. Outside code, comments cannot
    // supply section names or content, including comments spanning lines.
    let line = "";
    for (let offset = 0; offset < raw.length;) {
      if (comment) {
        const end = raw.indexOf("-->", offset);
        if (end < 0) break;
        comment = false;
        offset = end + 3;
      } else if (raw.startsWith("<!--", offset)) {
        comment = true;
        offset += 4;
      } else if (raw[offset] === "`") {
        const delimiter = /^`+/.exec(raw.slice(offset))![0];
        const end = raw.indexOf(delimiter, offset + delimiter.length);
        const next = end < 0
          ? offset + delimiter.length
          : end + delimiter.length;
        line += raw.slice(offset, next);
        offset = next;
      } else line += raw[offset++];
    }
    const metadata =
      /^Ticket:[ \t]*(.*?)\s*\|\s*Task:[ \t]*(.*?)\s*\|\s*Walkthrough:[ \t]*(.*?)\s*$/i
        .exec(line);
    if (metadata) {
      for (
        const [name, value] of [
          ["Ticket", metadata[1]],
          ["Task", metadata[2]],
          ["Walkthrough", metadata[3]],
        ]
      ) {
        const field = key(name);
        if (sections.has(field)) errors.push("Duplicate section: " + field);
        if (!sections.has(field)) sections.set(field, []);
        sections.get(field)!.push(value);
      }
      current = "walkthrough";
      continue;
    }
    const heading = /^ {0,3}#{2,3}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    const inline = /^\*\*([^*\n]+?):\*\*[ \t]*(.*)$/.exec(line) ??
      /^(Ticket|Task|Walkthrough):[ \t]*(.*)$/i.exec(line);
    if (heading || (inline && known.has(key(inline[1])))) {
      current = key((heading ?? inline)![1]);
      if (sections.has(current) && known.has(current)) {
        errors.push("Duplicate section: " + current);
      }
      if (!sections.has(current)) sections.set(current, []);
      if (inline) sections.get(current)!.push(inline[2]);
    } else {
      sections.get(current)?.push(line);
    }
  }
  if (fence) errors.push("Close the unfinished Markdown code fence.");
  return {
    sections: new Map(
      [...sections].map(([name, lines]) => [name, lines.join("\n").trim()]),
    ),
    errors,
    views,
  };
}

function unfinished(text: string, literal = false): boolean {
  const plain = (literal ? text : text.replace(/<[^>]*>/g, ""))
    .replace(/[*_`]/g, "").trim();
  return !/[\p{L}\p{N}]/u.test(plain) ||
    /^(?:no response|todo|tbd|fixme|n\/a|not applicable|none|[-.]+)[.! ]*$/i
      .test(plain) ||
    (!literal && /^\{[\s\S]*\}$/.test(plain)) ||
    /^\{\s*(?:Focused diff|Shallow file|Pseudocode,|Use the|Describe |Insert |Replace )[^\n]*\}$/i
      .test(plain) ||
    /^(?:[-*]\s+)?(?:TODO|TBD|FIXME)(?:\s*[:—-].*)?$/im.test(plain) ||
    /^(?:[-*]\s+)?(?:replace|insert|describe|fill in)\s+(?:this|here|the .+ here)\b/i
      .test(plain);
}

function bulletsOf(text: string): string[] {
  return text.match(/^[-*] .+/gm) ?? [];
}

/**
 * Drops fenced code blocks. A fence's contents are literal: a `- something`
 * line inside one is code being quoted, not a bullet the author wrote, so
 * anything that counts or grades list items must look at the text without it.
 */
export function withoutFences(text: string): string {
  return text.replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm,
    "",
  );
}

/** Prose only: drops code fences, table rows, images and link targets. */
export function prose(text: string): string {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, "")
    .replace(/^\s*\|.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]*>/g, "");
}

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’._/-]*/gu) ?? []).length;
}

/**
 * The Change outline's show-me views: each fenced block is one view, and its
 * lines are the view's budget. A view's own labels and node names are part of
 * the view, never prose — so a bigger diagram must not be paid for out of the
 * prose cap, and the prose cap must not be dodged by hiding words in a fence.
 */
function outlineViews(text: string): { views: number; lines: number } {
  let views = 0;
  let lines = 0;
  for (
    const block of text.matchAll(
      /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm,
    )
  ) {
    const body = block[2].split("\n").filter((line) => line.trim());
    if (body.length) views += 1;
    lines += body.length;
  }
  return { views, lines };
}

export function relatedIssue(body: string): number | null {
  const sections = parseDescription(body).sections;
  const value = sections.get("ticket") ?? sections.get("related issue") ?? "";
  const match =
    /(?:(?:closes|fixes|resolves|refs)\s+)?#([1-9]\d*)\b|github\.com\/[\w.-]+\/[\w.-]+\/issues\/([1-9]\d*)/i
      .exec(value);
  if (!match) return null;
  const number = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(number) ? number : null;
}

export function validateDescription(kind: Kind, body: string): string[] {
  if (typeof body !== "string" || body.length > 65536) {
    return ["Description must be text no longer than 65,536 characters."];
  }
  const { sections, errors, views } = parseDescription(body);
  const order = [...sections.keys()];
  let previous = -1;
  for (const name of fields[kind]) {
    const field = key(name);
    const value = sections.get(field) ?? "";
    const allowedNone =
      (field === "dependencies" || field === "special things to note" ||
        field === "decisions") &&
      /^(?:-\s*)?None[.!]?$/i.test(value);
    if (!allowedNone && unfinished(value)) {
      errors.push("Complete section: " + name);
    }
    const position = order.indexOf(field);
    if (position >= 0 && position < previous) {
      errors.push("Use template section order at: " + name);
    }
    previous = Math.max(previous, position);
  }
  if (kind === "issue") {
    const classification = sections.get("execution classification")?.split(
      "\n",
    )[0].trim();
    if (!classification || !/^(AFK|HITL)$/.test(classification)) {
      errors.push("Execution classification must be AFK or HITL.");
    }
    const checklist = sections.get("checklist") ?? "";
    const items = [...checklist.matchAll(/^[-*] \[[ xX]\] (.+)$/gm)];
    if (!items.length || items.some((item) => unfinished(item[1]))) {
      errors.push("Checklist needs concrete Markdown checkbox deliverables.");
    }
    if (
      !/\bgiven\b[\s\S]+\bwhen\b[\s\S]+\bthen\b/i.test(
        sections.get("acceptance criteria") ?? "",
      )
    ) {
      errors.push(
        "Acceptance criteria need observable Given/When/Then scenarios.",
      );
    }
  }
  if (kind !== "pr") {
    const deps = sections.get("dependencies") ?? "";
    if (
      !/^None\b/i.test(deps) &&
      !/(?:#[1-9]\d*|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*)/
        .test(deps)
    ) {
      errors.push(
        "Dependencies must reference prerequisite issues or explicitly say None.",
      );
    }
  } else {
    const ticket = sections.get("ticket") ?? "";
    if (
      !/(?:#[1-9]\d*\b|github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*)/i
        .test(ticket)
    ) {
      errors.push("Ticket must link one owning GitHub issue.");
    }
    if (unfinished(sections.get("task") ?? "")) {
      errors.push("Task must identify the work item or task record.");
    }
    const walkthrough = sections.get("walkthrough") ?? "";
    if (!/^(?:not requested|https:\/\/\S+)$/i.test(walkthrough.trim())) {
      errors.push("Walkthrough must be a URL or explicitly say not requested.");
    }
    if (!relatedIssue(body)) {
      errors.push("Ticket must name one owning work item as #number.");
    }
    const notes = sections.get("special things to note") ?? "";
    const bullets = notes.match(/^[-*] .+/gm) ?? [];
    if (bullets.length < 1 || bullets.length > 4) {
      errors.push(
        "Special things to note needs one to four bullets (or - None.).",
      );
    }
    const risk = sections.get("risk") ?? "";
    if (!/^Level:\s*(Low|Medium|High)\s*$/im.test(risk.split("\n")[0] ?? "")) {
      errors.push("Risk must start with Level: Low, Medium or High.");
    }
    const riskBullets = bulletsOf(risk);
    if (riskBullets.length < 1 || riskBullets.length > 3) {
      errors.push("Risk needs one to three bullets.");
    }
    const decisions = sections.get("decisions") ?? "";
    const decisionBullets = bulletsOf(decisions);
    if (
      !/^(?:-\s*)?None[.!]?$/i.test(decisions) &&
      (decisionBullets.length < 1 || decisionBullets.length > 3)
    ) {
      errors.push("Decisions needs one to three bullets (or - None.).");
    }
    const evidence = sections.get("evidence") ?? "";
    const rows = evidence.split("\n").filter((line) =>
      /^\s*\|/.test(line) && !/^\s*\|[\s|:-]*\|?\s*$/.test(line) &&
      /[\p{L}\p{N}]/u.test(line.replace(/\|/g, ""))
    );
    // Owner rule: Evidence is UI evidence and new tests only. A PR with
    // nothing to show says so, and says why, instead of filling the table with
    // routine checks CI already reports.
    // `- None.` either alone or opening a line that then says why.
    const evidenceNone = /^(?:-\s*)?None\.(?:[ \t]+\S|[ \t]*$)/im.test(
      evidence,
    );
    if (evidenceNone) {
      const why = withoutFences(evidence).replace(
        /^(?:-\s*)?None\./im,
        "",
      )
        .trim();
      if (!why) {
        errors.push(
          "Evidence None. needs one line saying why there is nothing to show.",
        );
      }
    } else if (rows.length < 2) {
      errors.push(
        "Evidence needs a table with at least one filled check row, or None.",
      );
    } else if (rows.length > 9) {
      errors.push("Evidence table: at most eight check rows.");
    }
    // Owner rule: never list routine checks. CI already shows fmt, lint and
    // typecheck results, and an Evidence table full of green ticks says
    // nothing about whether the change works. Fenced code is exempt, because
    // a PR about the linter legitimately quotes it. The owner's rule names
    // those three commands, so only those three are matched: "format" is
    // deliberately absent, since real test files carry it in their names
    // (`contracts-module-format.node.mjs`) and a PR must be able to cite them.
    const routine = withoutFences(evidence).match(
      /\b(?:fmt|lint|typecheck)\b/i,
    );
    if (routine) {
      errors.push(
        `Evidence lists a routine check (${
          routine[0]
        }); CI reports those. Show UI evidence or new tests.`,
      );
    }
    const limits: [string, number, number][] = [
      ["purpose", 40, 0],
      ["risk", 0, 25],
      ["special things to note", 0, 25],
      ["change outline", 40, 0],
      ["decisions", 0, 30],
      ["evidence", 40, 0],
    ];
    for (const [name, words, perBullet] of limits) {
      const value = sections.get(name) ?? "";
      if (words && wordCount(prose(value)) > words) {
        errors.push(`Too long: ${name} prose must be at most ${words} words.`);
      }
      if (
        perBullet &&
        bulletsOf(value).some((b) => wordCount(prose(b)) > perBullet)
      ) {
        errors.push(
          `Too long: each ${name} bullet must be at most ${perBullet} words.`,
        );
      }
    }
    // The Change outline is the core of a PR: one to three show-me views,
    // 80 lines of view in all. The 40-word prose cap above is counted only
    // outside fences, so views and prose have separate budgets.
    const outlineView = outlineViews(sections.get("change outline") ?? "");
    if (outlineView.lines > 80) {
      errors.push(
        `Too long: change outline views must be at most 80 lines in all (${outlineView.lines}).`,
      );
    }
    if (outlineView.views > 3) {
      errors.push(
        `Too many views: change outline takes at most three (${outlineView.views}).`,
      );
    }
    const images = (body.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
    if (images > 4) {
      errors.push(
        "Too many screenshots: at most four; link the rest as one folder.",
      );
    }
    const total = [...sections].filter(([name]) =>
      !["ticket", "task", "walkthrough"].includes(name)
    ).reduce((sum, [, value]) => sum + wordCount(prose(value)), 0);
    if (total > 300) {
      errors.push(
        `Too long: ${total} words of prose; the whole description must be at most 300.`,
      );
    }
    const outline = sections.get("change outline") ?? "";
    const hasView = views.has("change outline");
    const explained = /^No structural change:\s+\S.{15,}$/im.test(outline);
    if (!hasView && !explained) {
      errors.push(
        "Change outline needs a focused show-me code/diagram view or a concrete No structural change: explanation.",
      );
    }
  }
  return [...new Set(errors)];
}

/**
 * Review and QA verdict comments: a verdict line, the head commit, at most
 * five one-line findings and at most 150 words of prose in all.
 */
export function validateReview(body: string): string[] {
  const errors: string[] = [];
  const text = body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (
    !/^\*{0,2}Verdict:\*{0,2}\s*(Approve|Changes requested|Blocked)\b/im.test(
      text.split("\n")[0] ?? "",
    )
  ) {
    errors.push(
      "First line must be Verdict: Approve, Changes requested or Blocked.",
    );
  }
  if (!/^\*{0,2}Head:\*{0,2}\s*`?[0-9a-f]{7,40}`?/im.test(text)) {
    errors.push("Name the head commit reviewed: Head: <sha>.");
  }
  // A `- ` line inside a fenced block is quoted code, not a finding. Counting
  // it made a reviewer who pasted a repro with a list fail the severity and
  // 25-word rules on lines they never wrote as findings.
  const findings = withoutFences(text).match(/^[-*] .+/gm) ?? [];
  if (findings.length > 5) {
    errors.push("At most five findings; merge or drop the minor ones.");
  }
  for (const finding of findings) {
    if (!/^[-*] \*{0,2}\[?(High|Medium|Low)\]?\*{0,2}/i.test(finding)) {
      errors.push(
        "Start each finding with its severity: [High], [Medium] or [Low].",
      );
      break;
    }
  }
  if (findings.some((finding) => wordCount(prose(finding)) > 25)) {
    errors.push("Too long: each finding must be at most 25 words.");
  }
  const total = wordCount(prose(text));
  if (total > 150) {
    errors.push(
      `Too long: ${total} words of prose; a verdict must be at most 150.`,
    );
  }
  return [...new Set(errors)];
}

if (import.meta.main) {
  const [kind, path] = Deno.args;
  if (
    !(Object.hasOwn(fields, kind ?? "") || kind === "review") || !path ||
    Deno.args.length !== 2
  ) {
    console.error("Usage: validate.ts issue|epic|pr|review <body.md|->");
    Deno.exit(2);
  }
  const body = path === "-"
    ? await new Response(Deno.stdin.readable).text()
    : await Deno.readTextFile(path);
  const errors = kind === "review"
    ? validateReview(body)
    : validateDescription(kind as Kind, body);
  console.log(JSON.stringify({ ok: errors.length === 0, errors }));
  if (errors.length) Deno.exit(1);
}
