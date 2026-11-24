import type { TicketPresetId, TicketSourceResponse } from "../../api/client.ts";
import {
  DEFAULT_HOLD_LABEL,
  DEFAULT_START_LABEL,
  presetField,
  presetOfPolicy,
} from "../issue-sources.ts";
import { ageOf, type SourceHealth, troubleOf } from "../issue-state.ts";

/**
 * One repository's issue settings as the page edits them (#69, slice 1).
 *
 * The server stores a versioned policy: three label names, an optional
 * delegation for automatic admission, whether automatic admission is on and
 * since when, whether acceptance criteria are required, and whether a person
 * approves the plan. This module is the only place that shape is read or
 * written, so the page never guesses at a field.
 *
 * Two rules come from the served contracts rather than the design:
 * - `automatic.since` is stamped by the server and ignored on input, so the
 *   form never carries a date and the page shows the one the response holds.
 * - a label name is unsafe when it is not trimmed or carries a control
 *   character, a URL or an expression marker (the schema's rule), so the form
 *   refuses those before Save rather than sending them to a 422.
 */

/** GitHub's label length bound, and the schema's. */
export const LABEL_MAX_LENGTH = 50;

/** One person allowed to trigger automatic admission. */
export type TriggerPerson = {
  /** GitHub's numeric user id, as a decimal string: what the policy stores. */
  readonly id: string;
  /** The username, when this page looked it up; the stored policy keeps ids only. */
  readonly login: string | null;
};

/** The settings of one repository, as the page holds them while editing. */
export type SettingsForm = {
  readonly enabled: boolean;
  readonly start: string;
  readonly planOnly: boolean;
  readonly planOnlyLabel: string;
  readonly hold: string;
  readonly requireAcceptanceCriteria: boolean;
  readonly approval: "human_approval" | "automatic";
  readonly automatic: boolean;
  /** The Bakery member automatic starts run as. */
  readonly principalId: string | null;
  readonly people: readonly TriggerPerson[];
  /** The built-in workflow the repository runs; the Workflow section changes it, and Save sends it with the rest of the policy. */
  readonly preset: TicketPresetId | null;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * Whether a label name is one the server accepts: trimmed, 1 to 50 characters,
 * no control character, no URL and no expression marker.
 */
export function labelIsUnsafe(value: string): boolean {
  if (value !== value.trim()) return true;
  if (value.length === 0 || value.length > LABEL_MAX_LENGTH) return true;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return value.includes("://") || value.includes("{{") ||
    value.includes("${") || value.includes("`");
}

/** The form a repository's saved settings give, or the defaults for a new one. */
export function formOf(source: TicketSourceResponse | null): SettingsForm {
  const policy = record(source?.policy);
  const labels = record(policy.labels);
  const readiness = record(policy.readiness);
  const approval = record(policy.approval);
  const automatic = record(policy.automatic);
  const delegation = policy.delegation === null ||
      policy.delegation === undefined
    ? null
    : record(policy.delegation);
  const planOnly = typeof labels.planOnly === "string" ? labels.planOnly : null;
  const actors = delegation === null ? [] : delegation.externalActorIds;
  return {
    enabled: source?.enabled ?? false,
    start: text(labels.execute) || DEFAULT_START_LABEL,
    planOnly: planOnly !== null,
    planOnlyLabel: planOnly ?? "",
    hold: text(labels.hold) || DEFAULT_HOLD_LABEL,
    // Acceptance criteria are required unless the policy says otherwise: the
    // default policy requires them, and an absent field is that default.
    requireAcceptanceCriteria: readiness.requireAcceptanceCriteria !== false,
    approval: approval.plan === "automatic" ? "automatic" : "human_approval",
    automatic: automatic.enabled === true,
    principalId: delegation === null
      ? null
      : text(delegation.principalId) || null,
    people: Array.isArray(actors)
      ? actors.flatMap((id) =>
        typeof id === "string" ? [{ id, login: null }] : []
      )
      : [],
    preset: presetOfPolicy(policy),
  };
}

/** The server-stamped instant before which labelled issues wait, or null. */
export function automaticSinceOf(
  source: TicketSourceResponse | null,
): string | null {
  const since = record(record(source?.policy).automatic).since;
  return typeof since === "string" ? since : null;
}

/** What is wrong with the form, by field. An empty object means Save may run. */
export type SettingsProblems = {
  readonly start?: "empty" | "unsafe";
  readonly planOnlyLabel?: "empty" | "unsafe";
  readonly hold?: "empty" | "unsafe";
  /** Two labels are the same, ignoring case: GitHub label names are not case-sensitive. */
  readonly sameLabels?: true;
  /** Automatic start needs someone to run as and at least one person to trigger it. */
  readonly principal?: "missing";
  readonly people?: "missing";
  readonly workflow?: "missing";
};

const labelProblem = (value: string): "empty" | "unsafe" | undefined => {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";
  return labelIsUnsafe(value) ? "unsafe" : undefined;
};

/** Every problem with the form, in field order. */
export function problemsOf(form: SettingsForm): SettingsProblems {
  const start = labelProblem(form.start);
  const hold = labelProblem(form.hold);
  const planOnlyLabel = form.planOnly
    ? labelProblem(form.planOnlyLabel)
    : undefined;
  const names = [form.start.trim(), form.hold.trim()];
  if (form.planOnly) names.push(form.planOnlyLabel.trim());
  const sameLabels = names.every((name) => name !== "") &&
    new Set(names.map((name) => name.toLowerCase())).size !== names.length;
  return {
    ...(start === undefined ? {} : { start }),
    ...(planOnlyLabel === undefined ? {} : { planOnlyLabel }),
    ...(hold === undefined ? {} : { hold }),
    ...(sameLabels ? { sameLabels: true as const } : {}),
    ...(form.automatic && form.principalId === null
      ? { principal: "missing" as const }
      : {}),
    ...(form.automatic && form.people.length === 0
      ? { people: "missing" as const }
      : {}),
    ...(form.automatic && form.preset === null
      ? { workflow: "missing" as const }
      : {}),
  };
}

/** Whether anything would stop Save. */
export function isSavable(form: SettingsForm): boolean {
  return Object.keys(problemsOf(form)).length === 0;
}

/** Whether the form differs from what is saved. */
export function isDirty(
  form: SettingsForm,
  source: TicketSourceResponse | null,
): boolean {
  const saved = formOf(source);
  return form.enabled !== saved.enabled ||
    form.start !== saved.start ||
    form.planOnly !== saved.planOnly ||
    (form.planOnly && form.planOnlyLabel !== saved.planOnlyLabel) ||
    form.hold !== saved.hold ||
    form.requireAcceptanceCriteria !== saved.requireAcceptanceCriteria ||
    form.approval !== saved.approval ||
    form.preset !== saved.preset ||
    form.automatic !== saved.automatic ||
    (form.automatic &&
      (form.principalId !== saved.principalId ||
        form.people.map((one) => one.id).join() !==
          saved.people.map((one) => one.id).join()));
}

/**
 * The policy to send. `automatic.since` is omitted on purpose: the server
 * stamps it when automatic admission is turned on, and ignores anything sent.
 */
export function policyOfForm(form: SettingsForm): {
  readonly version: 1;
  readonly labels: {
    readonly execute: string;
    readonly planOnly: string | null;
    readonly hold: string;
  };
  readonly delegation: {
    readonly principalId: string;
    readonly externalActorIds: string[];
  } | null;
  readonly automatic: { readonly enabled: boolean };
  readonly readiness: { readonly requireAcceptanceCriteria: boolean };
  readonly approval: { readonly plan: "human_approval" | "automatic" };
  readonly preset?: TicketPresetId;
} {
  const delegation = form.automatic && form.principalId !== null &&
      form.people.length > 0
    ? {
      principalId: form.principalId,
      externalActorIds: form.people.map((person) => person.id),
    }
    : null;
  return {
    version: 1,
    labels: {
      execute: form.start.trim(),
      planOnly: form.planOnly ? form.planOnlyLabel.trim() : null,
      hold: form.hold.trim(),
    },
    delegation,
    automatic: { enabled: form.automatic },
    readiness: { requireAcceptanceCriteria: form.requireAcceptanceCriteria },
    approval: { plan: form.approval },
    ...presetField(form.preset),
  };
}

/** The health badge one repository's GitHub read shows. */
export type SourceBadge =
  | "working"
  | "trouble"
  | "reconnecting"
  | "notReadYet";

/**
 * The badge for one repository, from the same mapping the Issues page uses:
 * `troubleOf` decides what counts as trouble, so the two pages cannot disagree.
 */
export function badgeOf(source: TicketSourceResponse | null): SourceBadge {
  const healths: SourceHealth[] = source === null
    ? []
    : [source.syncHealth as SourceHealth];
  const trouble = troubleOf(healths);
  if (trouble === "authRequired") return "reconnecting";
  if (trouble === "degraded" || trouble === "unknown") return "trouble";
  return source?.lastSyncedAt == null ? "notReadYet" : "working";
}

/** The one line under a repository's name in the list. */
export function summaryOf(form: SettingsForm): {
  readonly taking: boolean;
  readonly start: string;
  readonly automatic: boolean;
} {
  return {
    taking: form.enabled,
    start: form.start,
    automatic: form.enabled && form.automatic,
  };
}

/** "Updated 3 hours ago", as whole units, or null when it was never read. */
export function readAgeOf(
  source: TicketSourceResponse | null,
  now: number,
):
  | { readonly unit: "minute" | "hour" | "day"; readonly count: number }
  | "now"
  | null {
  return ageOf(source?.lastSyncedAt ?? null, now);
}

/**
 * The three counts the preview section shows, from the saved copy of the
 * issues. `ticketSources.preview` only records readiness; the numbers come
 * from each issue's own last verdict, so the counts say when they were read.
 */
export type PreviewCounts = {
  readonly canStart: number;
  readonly waiting: number;
  readonly cannotStart: number;
  /**
   * Issues that wait only because their label was on before automatic starts
   * were turned on: a person's Start work admits them (the server's count).
   */
  readonly labeledBeforeWindow: number;
  /** The oldest evaluation the counts rest on, or null when nothing was read. */
  readonly evaluatedAt: string | null;
};

/** A saved issue, as far as the counts need it: an issue nobody judged has none. */
export type CountableIssue = {
  readonly latestReadiness?: unknown;
};

/** One issue's verdict: ready, waiting or rejected, as the report stores it. */
export type Verdict = "ready" | "waiting" | "rejected";

/** One issue's verdict, or null when it has never been judged. */
export function verdictOf(issue: CountableIssue): Verdict | null {
  const verdict = record(issue.latestReadiness).verdict;
  return verdict === "ready" || verdict === "waiting" || verdict === "rejected"
    ? verdict
    : null;
}

/**
 * The counts: an issue that can start, one that is waiting, or one that cannot
 * start. An issue nobody has judged counts as waiting, because that is the only
 * claim that is true of it.
 */
export function countsOf(
  issues: readonly CountableIssue[],
  labeledBeforeWindow = 0,
): PreviewCounts {
  let canStart = 0;
  let waiting = 0;
  let cannotStart = 0;
  let oldest: string | null = null;
  for (const issue of issues) {
    const verdict = verdictOf(issue);
    if (verdict === "ready") canStart++;
    else if (verdict === "rejected") cannotStart++;
    else waiting++;
    const evaluatedAt = record(issue.latestReadiness).evaluatedAt;
    if (
      typeof evaluatedAt === "string" &&
      (oldest === null || Date.parse(evaluatedAt) < Date.parse(oldest))
    ) {
      oldest = evaluatedAt;
    }
  }
  return {
    canStart,
    waiting,
    cannotStart,
    labeledBeforeWindow,
    evaluatedAt: oldest,
  };
}
