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
    "Special things to note",
    "Change outline",
  ],
} as const;

export type Kind = keyof typeof fields;
const key = (text: string) => text.trim().toLowerCase().replace(/:$/, "");
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
      (field === "dependencies" || field === "special things to note") &&
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

if (import.meta.main) {
  const [kind, path] = Deno.args;
  if (!Object.hasOwn(fields, kind ?? "") || !path || Deno.args.length !== 2) {
    console.error("Usage: validate.ts issue|epic|pr <body.md|->");
    Deno.exit(2);
  }
  const body = path === "-"
    ? await new Response(Deno.stdin.readable).text()
    : await Deno.readTextFile(path);
  const errors = validateDescription(kind as Kind, body);
  console.log(JSON.stringify({ ok: errors.length === 0, errors }));
  if (errors.length) Deno.exit(1);
}
