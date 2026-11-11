import type { ContractOutput } from "./contracts.ts";
import {
  type EffectiveRepositoryRuleEntry,
  type OrganizationRepositoryRules,
  REPOSITORY_RULE_KEYS,
  type RepositoryRuleKey,
  type RepositoryRuleMode,
  type RepositoryRuleOverrides,
} from "./repository-rules.ts";

/**
 * Pure, bounded, deterministic evaluation for repository rule previews.
 *
 * Nothing here touches a shell, the network, a provider or a regular
 * expression applied to caller text: every scan is a single linear pass over
 * a string whose length the transport schema already caps, so adversarial
 * input cannot cause super-linear work. Findings carry fixed codes and fixed
 * messages; sample text is never echoed.
 */

export type RulePreviewStatus = ContractOutput<"RuleSampleResult">["status"];
export type RuleSampleAppliesTo = NonNullable<
  ContractOutput<"RuleSampleResult">["appliesTo"]
>;
export type RuleSampleFinding = { code: string; message: string };
export type RuleSampleResult = {
  ruleKey: RepositoryRuleKey;
  mode: RepositoryRuleMode | null;
  status: RulePreviewStatus;
  appliesTo: RuleSampleAppliesTo | null;
  evaluated: number;
  findings: RuleSampleFinding[];
};

export type RuleSampleInput = {
  commitMessages?: readonly string[];
  pullRequestTitle?: string;
  pullRequestDescription?: string;
};

/** Hard work bounds, independent of the transport caps (defence in depth). */
export const SAMPLE_MAX_COMMIT_MESSAGES = 20;
export const SAMPLE_MAX_COMMIT_MESSAGE_CHARS = 2000;
export const SAMPLE_MAX_TITLE_CHARS = 300;
export const SAMPLE_MAX_DESCRIPTION_CHARS = 8000;

const FINDING_MESSAGES = {
  header_empty: "The first line is empty.",
  type_missing: "A type is required before the separator.",
  type_invalid_characters:
    "The type may only contain lowercase letters, digits and hyphens.",
  type_uppercase: "The type must be lowercase.",
  type_not_allowed: "The type is not one of the allowed types.",
  scope_malformed:
    "The scope must be a non-empty word in parentheses without spaces.",
  scope_required: "A scope in parentheses is required.",
  separator_missing: "A colon followed by a space must follow the type.",
  space_after_colon_missing: "A space must follow the colon.",
  subject_empty: "The subject after the colon is empty.",
  subject_leading_space: "The subject must not start with extra whitespace.",
  subject_too_long: "The subject is longer than the allowed maximum.",
  title_multiline: "The title must be a single line.",
  merge_or_revert_exempt: "A merge or revert commit is exempt from this rule.",
  section_missing: "A required section heading is missing.",
  section_empty: "A required section has no content of its own.",
  rule_disabled: "The rule is disabled, so it is not evaluated.",
  rule_absent: "No entry for the rule applies, so it is not evaluated.",
  sample_not_provided: "The sample does not include text for this rule.",
  needs_language_aware_checker:
    "This rule needs a language-aware checker; the preview never claims a pass.",
} as const;
export type RuleSampleFindingCode = keyof typeof FINDING_MESSAGES;

function finding(
  code: RuleSampleFindingCode,
  suffix = "",
): RuleSampleFinding {
  return { code, message: `${FINDING_MESSAGES[code]}${suffix}` };
}

function isLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}
function isUpper(code: number): boolean {
  return code >= 0x41 && code <= 0x5a;
}
function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}
function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d ||
    code === 0x0b || code === 0x0c || code === 0xa0 || code === 0x3000 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0xfeff;
}

/** Code point count in one linear pass, so surrogate pairs count once. */
export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) index++;
    count++;
  }
  return count;
}

export type HeaderOptions = {
  types: readonly string[];
  scope: "optional" | "required";
  maxSubjectLength: number;
};

/**
 * Validates one header line against Conventional Commits 1.0.0
 * (`type(scope)!: subject`) and the rule's bounded options. Linear scan.
 */
export function validateConventionalHeader(
  header: string,
  options: HeaderOptions,
): RuleSampleFinding[] {
  if (header.length === 0 || header.trim().length === 0) {
    return [finding("header_empty")];
  }
  let index = 0;
  const length = header.length;
  // Type: everything up to the first "(", "!" or ":".
  while (index < length) {
    const char = header[index];
    if (char === "(" || char === "!" || char === ":") break;
    index++;
  }
  if (index >= length) return [finding("separator_missing")];
  const type = header.slice(0, index);
  if (type.length === 0) return [finding("type_missing")];
  let hasUpper = false;
  for (let at = 0; at < type.length; at++) {
    const code = type.charCodeAt(at);
    if (isUpper(code)) hasUpper = true;
    else if (!isLower(code) && !isDigit(code) && code !== 0x2d) {
      return [finding("type_invalid_characters")];
    }
  }
  if (hasUpper) return [finding("type_uppercase")];
  if (!options.types.includes(type)) return [finding("type_not_allowed")];
  const findings: RuleSampleFinding[] = [];
  // Optional scope.
  let hasScope = false;
  if (header[index] === "(") {
    const close = header.indexOf(")", index + 1);
    if (close === -1) return [finding("scope_malformed")];
    const scope = header.slice(index + 1, close);
    if (scope.length === 0) return [finding("scope_malformed")];
    for (let at = 0; at < scope.length; at++) {
      const code = scope.charCodeAt(at);
      if (code === 0x28 || isSpace(code)) {
        return [finding("scope_malformed")];
      }
    }
    hasScope = true;
    index = close + 1;
  }
  if (!hasScope && options.scope === "required") {
    findings.push(finding("scope_required"));
  }
  if (header[index] === "!") index++;
  if (header[index] !== ":") return [...findings, finding("separator_missing")];
  index++;
  if (index >= length) return [...findings, finding("subject_empty")];
  if (header[index] !== " ") {
    return [...findings, finding("space_after_colon_missing")];
  }
  index++;
  const subject = header.slice(index);
  if (subject.trim().length === 0) {
    return [...findings, finding("subject_empty")];
  }
  if (isSpace(subject.charCodeAt(0))) {
    findings.push(finding("subject_leading_space"));
  }
  if (codePointLength(subject) > options.maxSubjectLength) {
    findings.push(finding("subject_too_long"));
  }
  return findings;
}

function firstLine(message: string): string {
  const end = message.search(/[\r\n]/);
  return end === -1 ? message : message.slice(0, end);
}

function isMergeOrRevert(header: string): boolean {
  return header.startsWith("Merge ") || header.startsWith('Revert "');
}

type EntryOf<Key extends RepositoryRuleKey> = Extract<
  EffectiveRepositoryRuleEntry,
  { ruleKey: Key }
>;

function evaluateCommits(
  entry: EntryOf<"commits.semantic">,
  messages: readonly string[] | undefined,
): RuleSampleResult {
  const options = entry.options;
  const range = options.range ?? "all_commits";
  const base = {
    ruleKey: entry.ruleKey,
    mode: entry.mode,
    appliesTo: range,
  };
  if (!messages || messages.length === 0) {
    return {
      ...base,
      status: "not_evaluated",
      evaluated: 0,
      findings: [finding("sample_not_provided")],
    };
  }
  const bounded = messages.slice(0, SAMPLE_MAX_COMMIT_MESSAGES);
  const indexes = range === "final_squash_commit"
    ? [bounded.length - 1]
    : bounded.map((_, index) => index);
  const findings: RuleSampleFinding[] = [];
  let failed = false;
  let evaluated = 0;
  for (const index of indexes) {
    const header = firstLine(
      bounded[index].slice(0, SAMPLE_MAX_COMMIT_MESSAGE_CHARS),
    );
    if (
      options.mergeAndRevertCommits === "exempt" && isMergeOrRevert(header)
    ) {
      findings.push(
        finding("merge_or_revert_exempt", ` (commit ${index + 1})`),
      );
      continue;
    }
    evaluated++;
    for (const issue of validateConventionalHeader(header, options)) {
      failed = true;
      findings.push({
        code: issue.code,
        message: `${issue.message} (commit ${index + 1})`,
      });
    }
  }
  return {
    ...base,
    status: failed ? "fail" : evaluated === 0 ? "not_evaluated" : "pass",
    evaluated,
    findings,
  };
}

function evaluateTitle(
  entry: EntryOf<"changeRequest.semanticTitle">,
  title: string | undefined,
): RuleSampleResult {
  const options = entry.options;
  const base = {
    ruleKey: entry.ruleKey,
    mode: entry.mode,
    appliesTo: "pull_request_title" as const,
  };
  if (title === undefined) {
    return {
      ...base,
      status: "not_evaluated",
      evaluated: 0,
      findings: [finding("sample_not_provided")],
    };
  }
  const bounded = title.slice(0, SAMPLE_MAX_TITLE_CHARS);
  const findings = /[\r\n]/.test(bounded)
    ? [finding("title_multiline")]
    : validateConventionalHeader(bounded, options);
  return {
    ...base,
    status: findings.length === 0 ? "pass" : "fail",
    evaluated: 1,
    findings,
  };
}

type Section = { level: number; title: string; body: string[] };

/** ATX headings outside fenced code; each body runs to the next heading of the same or higher rank. */
function parseSections(source: string): Section[] {
  // Comments first: a heading inside `<!-- -->` is template guidance, not a section.
  const markdown = stripHtmlComments(source);
  const lines = markdown.split(/\r\n|\r|\n/);
  const headings: Array<{ level: number; title: string; at: number }> = [];
  let fence: string | null = null;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed.slice(0, 3);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (line.length - trimmed.length > 3) continue;
    let level = 0;
    while (level < trimmed.length && trimmed[level] === "#") level++;
    if (level === 0 || level > 6) continue;
    if (trimmed.length > level && trimmed[level] !== " ") continue;
    let title = trimmed.slice(level).trim();
    let end = title.length;
    while (end > 0 && title[end - 1] === "#") end--;
    if (end < title.length && (end === 0 || title[end - 1] === " ")) {
      title = title.slice(0, end).trim();
    }
    headings.push({ level, title, at });
  }
  return headings.map((heading, position) => {
    let stop = lines.length;
    for (let next = position + 1; next < headings.length; next++) {
      if (headings[next].level <= heading.level) {
        stop = headings[next].at;
        break;
      }
    }
    return {
      level: heading.level,
      title: heading.title,
      body: lines.slice(heading.at + 1, stop),
    };
  });
}

/** Removes `<!-- ... -->` comments in one pass; an unclosed comment drops the rest. */
function stripHtmlComments(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("<!--", at);
    if (open === -1) {
      out += text.slice(at);
      break;
    }
    out += text.slice(at, open);
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    at = close + 3;
  }
  return out;
}

function isFenceMarker(line: string): boolean {
  return line.startsWith("```") || line.startsWith("~~~");
}

/**
 * Strips one leading marker: a quote, a bullet (`-`, `*`, `+`, `1.`, `1)`) or a
 * checkbox token (`[ ]`, `[x]`, `[X]`). Returns the line unchanged when none.
 */
function stripMarker(line: string): string {
  const first = line[0];
  if (first === ">" || first === "-" || first === "*" || first === "+") {
    return line.slice(1).trim();
  }
  let digits = 0;
  while (
    digits < line.length && line.charCodeAt(digits) >= 0x30 &&
    line.charCodeAt(digits) <= 0x39
  ) {
    digits++;
  }
  if (digits > 0 && (line[digits] === "." || line[digits] === ")")) {
    return line.slice(digits + 1).trim();
  }
  if (
    line.length >= 3 && first === "[" && line[2] === "]" &&
    " xX".includes(line[1])
  ) {
    return line.slice(3).trim();
  }
  return line;
}

/**
 * Meaningful lines of a section body. List and quote markers, checkbox tokens
 * (a tick is not content, in any case and after any bullet) and code fence
 * delimiters carry no content; text inside a fence does.
 */
function contentLines(body: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of stripHtmlComments(body.join("\n")).split("\n")) {
    let line = raw.trim();
    if (isFenceMarker(line)) continue;
    for (;;) {
      const next = stripMarker(line);
      if (next === line) break;
      line = next;
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/** Headings match case-insensitively; with duplicate headings the first one wins. */
function findSection(sections: Section[], name: string): Section | undefined {
  const wanted = name.trim().toLowerCase();
  return sections.find((section) => section.title.toLowerCase() === wanted);
}

function evaluateDescription(
  entry: EntryOf<"changeRequest.description">,
  description: string | undefined,
): RuleSampleResult {
  const options = entry.options;
  const base = {
    ruleKey: entry.ruleKey,
    mode: entry.mode,
    appliesTo: "pull_request_description" as const,
  };
  if (description === undefined) {
    return {
      ...base,
      status: "not_evaluated",
      evaluated: 0,
      findings: [finding("sample_not_provided")],
    };
  }
  const sample = parseSections(
    description.slice(0, SAMPLE_MAX_DESCRIPTION_CHARS),
  );
  const template = parseSections(options.template);
  const findings: RuleSampleFinding[] = [];
  for (const name of options.requiredSections) {
    const found = findSection(sample, name);
    if (!found) {
      findings.push(finding("section_missing", ` (${name})`));
      continue;
    }
    const templateSection = findSection(template, name);
    const templateLines = new Set(
      templateSection ? contentLines(templateSection.body) : [],
    );
    const own = contentLines(found.body).filter((line) =>
      !templateLines.has(line)
    );
    if (own.length === 0) {
      findings.push(finding("section_empty", ` (${name})`));
    }
  }
  return {
    ...base,
    status: findings.length === 0 ? "pass" : "fail",
    evaluated: options.requiredSections.length,
    findings,
  };
}

function notEvaluated(
  ruleKey: RepositoryRuleKey,
  mode: RepositoryRuleMode | null,
  code: RuleSampleFindingCode,
): RuleSampleResult {
  return {
    ruleKey,
    mode,
    status: "not_evaluated",
    appliesTo: null,
    evaluated: 0,
    findings: [finding(code)],
  };
}

/**
 * One result per rule key in canonical order. Disabled or absent rules and the
 * two magic-literal rules are `not_evaluated`; the preview never claims a pass
 * it did not compute.
 */
export function evaluateRuleSample(
  entries: readonly EffectiveRepositoryRuleEntry[],
  sample: RuleSampleInput,
): RuleSampleResult[] {
  const byKey = new Map(entries.map((entry) => [entry.ruleKey, entry]));
  return REPOSITORY_RULE_KEYS.map((key) => {
    const entry = byKey.get(key);
    if (!entry) return notEvaluated(key, null, "rule_absent");
    if (!entry.enabled) return notEvaluated(key, entry.mode, "rule_disabled");
    switch (entry.ruleKey) {
      case "commits.semantic":
        return evaluateCommits(entry, sample.commitMessages);
      case "changeRequest.semanticTitle":
        return evaluateTitle(entry, sample.pullRequestTitle);
      case "changeRequest.description":
        return evaluateDescription(entry, sample.pullRequestDescription);
      default:
        return notEvaluated(key, entry.mode, "needs_language_aware_checker");
    }
  });
}

export type RuleImpactStatus = ContractOutput<
  "RepositoryRulePreviewItem"
>["status"];
export type RuleImpact = {
  status: RuleImpactStatus;
  unsupported: boolean;
  supersededRules: RepositoryRuleKey[];
  reactivatedRules: RepositoryRuleKey[];
};

/** What classification needs from one saved override; options are not read. */
export type OverrideSummary = {
  ruleKey: RepositoryRuleKey;
  enabled: boolean;
  mode: RepositoryRuleMode;
  checkBinding: string | null;
};

/** Reduces typed overrides to the fields classification reads. */
export function summarizeOverrides(
  overrides: RepositoryRuleOverrides | null | undefined,
): OverrideSummary[] {
  return (overrides?.entries ?? []).map((entry) => ({
    ruleKey: entry.ruleKey,
    enabled: entry.enabled,
    mode: entry.mode,
    checkBinding: entry.ruleKey === "code.magicNumbers" ||
        entry.ruleKey === "code.magicStrings"
      ? entry.options.checkBinding
      : null,
  }));
}

function lockedKeys(
  rules: OrganizationRepositoryRules | null,
): Set<RepositoryRuleKey> {
  return new Set(
    (rules?.entries ?? []).filter((entry) => entry.locked).map((entry) =>
      entry.ruleKey
    ),
  );
}

/**
 * Builds a classifier for one current baseline and one draft. A locked
 * organization entry wins over a saved override of the same key (the
 * resolver's rule), so everything derives from the two lock sets:
 *
 * - `newly_locked`: an override is not superseded by the current locks but is
 *   by the draft's.
 * - `overridden`: otherwise, an override stays effective under the draft.
 * - `inherited`: otherwise.
 * - `reactivatedRules`: overrides superseded now whose lock the draft drops.
 * - `unsupported`: the draft-effective set holds an enabled `require`
 *   magic-literal rule whose binding is null or names no command.
 */
export function createRuleImpactClassifier(
  current: OrganizationRepositoryRules | null,
  draft: OrganizationRepositoryRules,
): (
  overrides: readonly OverrideSummary[],
  commandIds: readonly string[],
) => RuleImpact {
  const lockedNow = lockedKeys(current);
  const lockedDraft = lockedKeys(draft);
  const draftByKey = new Map(
    draft.entries.map((entry) => [entry.ruleKey, entry]),
  );
  return (overrides, commandIds) => {
    const byKey = new Map(overrides.map((entry) => [entry.ruleKey, entry]));
    let newlyLocked = false;
    let overridden = false;
    const supersededRules: RepositoryRuleKey[] = [];
    const reactivatedRules: RepositoryRuleKey[] = [];
    let unsupported = false;
    for (const key of REPOSITORY_RULE_KEYS) {
      const override = byKey.get(key);
      const lockedByDraft = lockedDraft.has(key);
      if (override) {
        if (lockedByDraft) {
          supersededRules.push(key);
          if (!lockedNow.has(key)) newlyLocked = true;
        } else {
          overridden = true;
          if (lockedNow.has(key)) reactivatedRules.push(key);
        }
      }
      if (key !== "code.magicNumbers" && key !== "code.magicStrings") continue;
      let enabled: boolean;
      let mode: RepositoryRuleMode;
      let binding: string | null;
      const entry = draftByKey.get(key);
      if (override && !lockedByDraft) {
        ({ enabled, mode, checkBinding: binding } = override);
      } else if (
        entry && (entry.ruleKey === "code.magicNumbers" ||
          entry.ruleKey === "code.magicStrings")
      ) {
        enabled = entry.enabled;
        mode = entry.mode;
        binding = entry.options.checkBinding;
      } else continue;
      if (
        enabled && mode === "require" &&
        (binding === null || !commandIds.includes(binding))
      ) unsupported = true;
    }
    return {
      status: newlyLocked
        ? "newly_locked"
        : overridden
        ? "overridden"
        : "inherited",
      unsupported,
      supersededRules,
      reactivatedRules,
    };
  };
}

/** One-shot form of {@link createRuleImpactClassifier} over typed overrides. */
export function classifyRepositoryRuleImpact(
  current: OrganizationRepositoryRules | null,
  draft: OrganizationRepositoryRules,
  overrides: RepositoryRuleOverrides | null | undefined,
  commandIds: readonly string[],
): RuleImpact {
  return createRuleImpactClassifier(current, draft)(
    summarizeOverrides(overrides),
    commandIds,
  );
}
