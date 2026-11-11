import {
  TICKET_CHECK_MAX_EVIDENCE,
  type TicketIssueRef,
  type TicketPresetPin,
  type TicketReadinessCheck,
  type TicketReadinessReport,
  type TicketReasonCode,
  type TicketRequestIntent,
  type TicketRequestOrigin,
  type TicketSourcePolicy,
  ticketVerdictFromChecks,
} from "@bakery/contracts/ticket-admission";
import {
  automaticAdmissionAllowed,
  intentFromLabels,
  labelsCoverIntent,
  parseOffsetInstant,
  type TicketLabelBasis,
} from "./ticket-policy.ts";
import {
  basisDigest,
  type BlockerProofEntry,
  dependencyDigest,
  type NormalizedTicketSnapshot,
  normalizeSnapshot,
  requirementsDigest,
  sortIssueRefs,
} from "./ticket-snapshot.ts";
import type {
  PredecessorProof,
  TicketActorRole,
  TicketIssueRead,
  TicketLabelProvenance,
  TicketLinksRead,
  TicketReadFailure,
} from "./ticket-source-reader.ts";

/**
 * The readiness evaluator. `evaluateReadiness` turns facts that were already
 * read (the issue, its links, one proof per blocker, label provenance, the
 * labelling actor's role, the database facts of the source) into a
 * deterministic report. It never reads the provider, the database, the
 * environment or a clock. A provider failure never passes a check: it yields
 * `wait` with `provider_unavailable`. A check whose input cannot exist (the
 * issue is gone, moved or a pull request) is left out of the report rather
 * than answered falsely; `ticket_supported` carries the reject.
 *
 * Type-check reach: `pnpm typecheck` (turbo `apps/server` `typecheck`) checks
 * the entry points listed in `apps/server/package.json`. `src/main.ts` reaches
 * this module through `app.ts`, the ticket routes and `ticket-admission.ts`,
 * so the server graph type-checks it.
 */

/** Database and authority-chain facts of the ticket source, read in the admission transaction. */
export type ReadinessSourceFacts = {
  /** `ticket_sources.enabled`. */
  enabled: boolean;
  /** The integration connection is enabled. */
  connectionEnabled: boolean;
  /** The GitHub installation is enabled (not suspended or removed). */
  installationEnabled: boolean;
  /** The repository resource is selected and available on the installation. */
  resourceSelected: boolean;
  /** Repository the source reads, owner/name; a ticket from another repository is refused. */
  repositoryFullName: string;
  /** The Bakery repository is archived. */
  repositoryArchived: boolean;
  /** The Bakery repository has an active execution profile. */
  repositoryHasActiveProfile: boolean;
  /** The fixed preset can start a run for this source (setup is complete). */
  presetReady: boolean;
};

/** Authority facts of the principal an admission acts as, and of the labelling actor. */
export type ReadinessAuthorityFacts = {
  /**
   * The principal the admission acts as is live and holds `task:write` and
   * `run:write` now: the caller for a manual request, the delegation principal
   * for webhook and poll origins, the recorded principal on a recheck.
   */
  principalActive: boolean;
  /** Who applied the request label, read from issue events; null when not read. */
  provenance: TicketLabelProvenance | null;
  /** Repository role of the labelling actor; null when not read. */
  actorRole: TicketActorRole | null;
};

/** The nonterminal request that already exists for the ticket, if any. */
export type ReadinessActiveRequest = { intent: TicketRequestIntent };

/**
 * Everything one evaluation reads. Contract: an evaluation of a
 * request that already exists (a duplicate `ticketRequests.create`, a recheck
 * or a resume) must pass the request's recorded `origin`, label basis and
 * `intent`, never those of the call that found it. `authority_live` is origin
 * specific, so a poll duplicate of a manual request evaluated as `poll` would
 * wait on `no_delegation` and suspend a healthy request.
 *
 * `origin` and `labelBasis` are paired: a `manual` origin carries the `manual`
 * basis (an explicit caller request that needs no label), `webhook` and `poll`
 * carry the `label` basis, and `adoption` may carry either. Any other pairing
 * is inconsistent and waits in `authority_live` with `actor_unverifiable`.
 */
export type ReadinessInput = {
  source: ReadinessSourceFacts;
  policy: TicketSourcePolicy;
  /** `ticket_sources.policy_revision` the policy was read at. */
  policyRevision: number;
  /** Fixed preset identity the report is bound to. */
  preset: TicketPresetPin;
  /** Answer of the issue read. */
  issue: TicketIssueRead;
  /** Answer of the links read; null when it was not made (treated as unavailable). */
  links: TicketLinksRead | null;
  /** One proof per native blocker. A blocker without an entry has no proof. */
  proofs: readonly BlockerProofEntry[];
  authority: ReadinessAuthorityFacts;
  activeRequest: ReadinessActiveRequest | null;
  /** What the admission asks for; null when nothing is asked (no request label). */
  intent: TicketRequestIntent | null;
  /** Origin of the admission; on a recheck, the origin recorded on the request. */
  origin: TicketRequestOrigin;
  labelBasis: TicketLabelBasis;
  /**
   * Requirements digest pinned on the existing request, or null before one
   * exists. When set, a live digest that differs yields `requirements_unchanged`
   * wait `acceptance_changed`, so an edit that keeps its acceptance criteria is
   * still detected.
   */
  pinnedRequirementsDigest: string | null;
};

type PresentIssue = {
  normalized: NormalizedTicketSnapshot;
  labels: readonly string[];
};

type Context = {
  input: ReadinessInput;
  present: PresentIssue | null;
  hold: boolean;
  requirements: string | null;
};

type Outcome = Pick<TicketReadinessCheck, "status" | "reason" | "evidence">;
type Evidence = TicketReadinessCheck["evidence"][number];

function evidenceRef(ref: string, digest?: string): Evidence {
  return digest === undefined ? { ref } : { ref, digest };
}

function passed(...evidence: Evidence[]): Outcome {
  return {
    status: "pass",
    reason: "ok",
    evidence: evidence.slice(0, TICKET_CHECK_MAX_EVIDENCE),
  };
}

function waiting(reason: TicketReasonCode, ...evidence: Evidence[]): Outcome {
  return {
    status: "wait",
    reason,
    evidence: evidence.slice(0, TICKET_CHECK_MAX_EVIDENCE),
  };
}

function rejected(reason: TicketReasonCode, ...evidence: Evidence[]): Outcome {
  return {
    status: "reject",
    reason,
    evidence: evidence.slice(0, TICKET_CHECK_MAX_EVIDENCE),
  };
}

/**
 * The outcome of any check that needed a read that did not succeed. Every
 * failure reason waits the same way; the evidence names it
 * (`provider:rate_limited`, or `provider:labels_truncated` for an issue with
 * more labels than the reader keeps), so a report says why the read gave
 * nothing and a cut label list does not read as a GitHub outage.
 */
function providerUnavailable(failure: TicketReadFailure | null): Outcome {
  return waiting(
    "provider_unavailable",
    evidenceRef(
      failure === null ? "read:missing" : `provider:${failure.reason}`,
    ),
  );
}

function issueRefText(ref: TicketIssueRef): string {
  return `${ref.repositoryFullName}#${ref.number}`;
}

/**
 * Whether a body has an `Acceptance criteria` heading with at least one list
 * item (bullet, task or numbered line with text) in its section. The section
 * runs to the next heading of the same or a higher level. Nothing inside a
 * code fence, an HTML comment or an indented code block (four spaces or a tab)
 * counts: a fence closes only on a line of the same character that is at least
 * as long as the opener. Line endings (CRLF, lone CR) are normalized here.
 */
export function hasAcceptanceCriteria(body: string): boolean {
  let sectionLevel: number | null = null;
  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null) {
      if (closesFence(raw, fence)) fence = null;
      continue;
    }
    const visible = hideComments(raw, inComment);
    inComment = visible.inComment;
    const line = visible.text;
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence has no backtick in its info string (else it is inline code).
    if (opener !== null && !(opener[1][0] === "`" && opener[2].includes("`"))) {
      fence = { char: opener[1][0], length: opener[1].length };
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      if (sectionLevel !== null && level <= sectionLevel) sectionLevel = null;
      const title = heading[2].replace(/^[*_]+|[*_]+$/g, "").trim();
      if (sectionLevel === null && /^acceptance criteria\s*:?$/i.test(title)) {
        sectionLevel = level;
      }
      continue;
    }
    if (sectionLevel !== null && isListItem(line)) return true;
  }
  return false;
}

/** Whether `line` closes `fence`: same character, at least as long, nothing after it. */
function closesFence(
  line: string,
  fence: { char: string; length: number },
): boolean {
  const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return closer !== null && closer[1][0] === fence.char &&
    closer[1].length >= fence.length;
}

/**
 * `line` without its HTML comments (`<!-- ... -->`), and whether a comment is
 * still open at its end so the next lines stay hidden until `-->`.
 */
function hideComments(
  line: string,
  inComment: boolean,
): { text: string; inComment: boolean } {
  let text = "";
  let rest = line;
  let open = inComment;
  while (rest.length > 0) {
    if (open) {
      const end = rest.indexOf("-->");
      if (end === -1) return { text, inComment: true };
      rest = rest.slice(end + 3);
      open = false;
    } else {
      const start = rest.indexOf("<!--");
      if (start === -1) {
        text += rest;
        break;
      }
      text += rest.slice(0, start);
      rest = rest.slice(start + 4);
      open = true;
    }
  }
  return { text, inComment: open };
}

/** Columns of leading whitespace, a tab advancing to the next multiple of four. */
function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

function isListItem(line: string): boolean {
  // Four columns of indentation start an indented code block, not a list item.
  if (indentWidth(line) >= 4) return false;
  const marker = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
  if (marker === null) return false;
  return marker[1].replace(/^\[[ xX]\](?:[ \t]+|$)/, "").trim().length > 0;
}

function sourceLive({ source }: ReadinessInput): Outcome {
  if (!source.enabled) return waiting("source_disabled");
  if (!source.connectionEnabled) return waiting("connection_not_enabled");
  if (!source.installationEnabled) return waiting("installation_not_enabled");
  if (!source.resourceSelected) return waiting("resource_not_selected");
  return passed();
}

/** Runs `evaluate` on a present issue; null when the issue cannot supply the check. */
function whenIssue(
  context: Context,
  evaluate: (present: PresentIssue) => Outcome,
): Outcome | null {
  const issue = context.input.issue;
  if (issue.kind === "unavailable") return providerUnavailable(issue);
  if (context.present === null) return null;
  return evaluate(context.present);
}

function ticketSupported(context: Context): Outcome {
  const { input, present } = context;
  const issue = input.issue;
  if (issue.kind === "unavailable") return providerUnavailable(issue);
  if (issue.kind === "gone") return rejected("ticket_gone");
  if (issue.kind === "moved") return rejected("ticket_moved");
  if (issue.kind === "pull_request") {
    return rejected("pull_request_not_ticket");
  }
  if (present === null) return providerUnavailable(null);
  const { snapshot } = present.normalized;
  if (
    snapshot.repositoryFullName.toLowerCase() !==
      input.source.repositoryFullName.toLowerCase()
  ) {
    return rejected(
      "repository_mismatch",
      evidenceRef(`repository:${snapshot.repositoryFullName}`),
    );
  }
  if (snapshot.state === "closed") {
    return rejected("ticket_closed", evidenceRef("state:closed"));
  }
  if (present.normalized.tooLarge) {
    return rejected("requirements_too_large");
  }
  return passed(evidenceRef("state:open"));
}

function notHeld(context: Context): Outcome | null {
  return whenIssue(context, () =>
    context.hold
      ? waiting(
        "held",
        evidenceRef(`label:${context.input.policy.labels.hold}`),
      )
      : passed());
}

function intentAuthorized(context: Context): Outcome | null {
  return whenIssue(context, (present) => {
    const { input } = context;
    if (input.labelBasis === "manual") {
      return passed(evidenceRef("basis:manual"));
    }
    const { labels } = input.policy;
    const wanted = input.intent;
    const labelEvidence = [
      evidenceRef(`label:${labels.execute}`),
      ...(wanted !== "start" && labels.planOnly !== null
        ? [evidenceRef(`label:${labels.planOnly}`)]
        : []),
    ];
    if (
      wanted === null ||
      !labelsCoverIntent(present.labels, input.policy, wanted)
    ) {
      return waiting(
        input.activeRequest === null ? "label_missing" : "label_withdrawn",
        ...labelEvidence,
      );
    }
    // An existing request was admitted already; the automatic window gates
    // admission, not the life of the request. The one exception is a plan
    // request asked to start: that is a new admission of implementation, so
    // it needs the window, the enabled switch and a label applied after
    // `since` like a fresh start. Without this a pre-`since` execute label
    // could start a run from a webhook or poll by upgrading a plan request.
    if (!automaticOrigin(input.origin) || !admitsNewWork(input)) {
      return passed(...labelEvidence);
    }
    const { automatic: window } = input.policy;
    if (!window.enabled || window.since === null) {
      return waiting("adoption_required", evidenceRef("automatic:disabled"));
    }
    const provenance = input.authority.provenance;
    if (provenance !== null && provenance.kind === "unavailable") {
      return providerUnavailable(provenance);
    }
    if (provenance === null || provenance.kind !== "applied") {
      return waiting("adoption_required", evidenceRef("label:unverified"));
    }
    // A timestamp without an explicit offset cannot be placed on the timeline
    // without guessing a time zone, so the label counts as unverified.
    if (parseOffsetInstant(provenance.appliedAt) === null) {
      return waiting("adoption_required", evidenceRef("label:unverified"));
    }
    return automaticAdmissionAllowed(input.policy, provenance.appliedAt)
      ? passed(...labelEvidence, evidenceRef(`applied:${provenance.appliedAt}`))
      : waiting(
        "adoption_required",
        evidenceRef(`applied:${provenance.appliedAt}`),
        evidenceRef(`since:${window.since}`),
      );
  });
}

/** Whether the origin is automatic: a webhook or a poll, never a person. */
function automaticOrigin(origin: TicketRequestOrigin): boolean {
  return origin === "webhook" || origin === "poll";
}

/**
 * Whether this evaluation can admit new work, so the automatic window applies:
 * there is no request yet, or the request is a plan request being asked to
 * start (an upgrade to implementation). A recheck or duplicate of any other
 * existing request keeps the request it already has.
 */
function admitsNewWork({ activeRequest, intent }: ReadinessInput): boolean {
  return activeRequest === null ||
    (activeRequest.intent === "plan" && intent === "start");
}

function epicExcluded(context: Context): Outcome | null {
  return whenIssue(context, () => {
    const links = context.input.links;
    if (links === null) return providerUnavailable(null);
    if (links.kind === "unavailable") return providerUnavailable(links);
    // A count that is not a whole number of at least zero is no count: it
    // fails closed as an unusable provider answer, never as "no sub-issues".
    if (
      !Number.isSafeInteger(links.subIssuesTotal) || links.subIssuesTotal < 0
    ) {
      return waiting("provider_unavailable", evidenceRef("sub_issues:invalid"));
    }
    return links.subIssuesTotal > 0
      ? rejected(
        "has_sub_issues",
        evidenceRef(`sub_issues:${links.subIssuesTotal}`),
      )
      : passed();
  });
}

function acceptancePresent(context: Context): Outcome | null {
  return whenIssue(context, ({ normalized }) => {
    if (!context.input.policy.readiness.requireAcceptanceCriteria) {
      return passed(evidenceRef("policy:acceptance_optional"));
    }
    return hasAcceptanceCriteria(normalized.body)
      ? passed()
      : waiting("acceptance_missing");
  });
}

const BLOCKER_REASON_PRIORITY = [
  "predecessor_open",
  "closed_unmerged",
  "inaccessible",
  "links_truncated",
  "proof_unavailable",
  "provider_unavailable",
] as const;
type BlockerReason = typeof BLOCKER_REASON_PRIORITY[number];

function blockerReason(
  proof: PredecessorProof | TicketReadFailure | undefined,
): BlockerReason | null {
  if (proof === undefined) return "proof_unavailable";
  switch (proof.kind) {
    case "satisfied":
      return null;
    case "open":
      return "predecessor_open";
    case "closed_unmerged":
      return "closed_unmerged";
    case "inaccessible":
      return "inaccessible";
    case "proof_unavailable":
      return "proof_unavailable";
    case "unavailable":
      return "provider_unavailable";
  }
}

function dependenciesSatisfied(context: Context): Outcome | null {
  return whenIssue(context, () => {
    const { links, proofs } = context.input;
    if (links === null) return providerUnavailable(null);
    if (links.kind === "unavailable") return providerUnavailable(links);
    const byId = new Map(
      proofs.map((entry) => [entry.blocker.id, entry.proof]),
    );
    const unmet = new Map<BlockerReason, TicketIssueRef[]>();
    const met: TicketIssueRef[] = [];
    for (const blocker of sortIssueRefs(links.blockedBy)) {
      const reason = blockerReason(byId.get(blocker.id));
      if (reason === null) {
        met.push(blocker);
      } else {
        unmet.set(reason, [...(unmet.get(reason) ?? []), blocker]);
      }
    }
    if (links.truncated) unmet.set("links_truncated", []);
    for (const reason of BLOCKER_REASON_PRIORITY) {
      const blockers = unmet.get(reason);
      if (blockers === undefined) continue;
      return waiting(
        reason,
        ...(reason === "links_truncated"
          ? [evidenceRef("links:truncated")]
          : blockers.map((blocker) =>
            evidenceRef(`blocker:${issueRefText(blocker)}`)
          )),
      );
    }
    return passed(
      ...met.map((blocker) => evidenceRef(`blocker:${issueRefText(blocker)}`)),
    );
  });
}

function noActiveAdmission({ activeRequest, intent }: ReadinessInput): Outcome {
  if (activeRequest === null || intent === null) return passed();
  // Same intent returns the request; a plan request upgrades to start.
  if (
    activeRequest.intent === intent ||
    (activeRequest.intent === "plan" && intent === "start")
  ) {
    return passed(evidenceRef(`request:${activeRequest.intent}`));
  }
  return waiting(
    "active_request",
    evidenceRef(`request:${activeRequest.intent}`),
  );
}

function repositoryReady({ source }: ReadinessInput): Outcome {
  if (source.repositoryArchived) return waiting("repository_archived");
  if (!source.repositoryHasActiveProfile) return waiting("no_active_profile");
  return passed();
}

function presetReady({ source, preset }: ReadinessInput): Outcome {
  // The policy and the pin both name the one fixed preset by literal type, so
  // there is no identity to compare; only the repository's setup can fail.
  if (!source.presetReady) {
    return waiting("preset_setup_required", evidenceRef(`preset:${preset.id}`));
  }
  return passed(evidenceRef(`preset:${preset.id}`));
}

/**
 * Whether `origin` and `labelBasis` agree. A webhook or poll admits on the
 * label alone, so the `manual` basis (no label needed) would let it skip label
 * coverage, the window and the provenance rules; a manual request has no label
 * to rely on. Either pairing is a caller bug and never reads as ready.
 */
function originMatchesBasis({ origin, labelBasis }: ReadinessInput): boolean {
  if (automaticOrigin(origin)) return labelBasis === "label";
  if (origin === "manual") return labelBasis === "manual";
  return true;
}

function authorityLive(context: Context): Outcome {
  const { input } = context;
  const { authority, policy, origin } = input;
  if (!originMatchesBasis(input)) {
    return waiting(
      "actor_unverifiable",
      evidenceRef(`origin:${origin}`),
      evidenceRef(`basis:${input.labelBasis}`),
    );
  }
  if (!automaticOrigin(origin)) {
    return authority.principalActive
      ? passed(evidenceRef("authority:caller"))
      : waiting("principal_inactive");
  }
  const delegation = policy.delegation;
  if (delegation === null) return waiting("no_delegation");
  if (!authority.principalActive) return waiting("principal_inactive");
  const provenance = authority.provenance;
  if (provenance === null) {
    return input.issue.kind === "unavailable"
      ? providerUnavailable(input.issue)
      : waiting("actor_unverifiable", evidenceRef("label:unverified"));
  }
  if (provenance.kind === "unavailable") return providerUnavailable(provenance);
  if (provenance.kind !== "applied") {
    return waiting("actor_unverifiable", evidenceRef("label:unverified"));
  }
  const actor = evidenceRef(`github_actor:${provenance.actorId}`);
  if (!delegation.githubActorIds.includes(provenance.actorId)) {
    return waiting("actor_not_allowlisted", actor);
  }
  const role = authority.actorRole;
  if (role === null || role.kind === "absent") {
    return waiting("actor_unverifiable", actor);
  }
  if (role.kind === "unavailable") return providerUnavailable(role);
  if (role.userId !== provenance.actorId) {
    return waiting("actor_unverifiable", actor);
  }
  if (role.permission !== "admin" && role.permission !== "write") {
    return waiting("actor_role_insufficient", actor);
  }
  return passed(actor, evidenceRef(`role:${role.permission}`));
}

function requirementsUnchanged(context: Context): Outcome | null {
  const pinned = context.input.pinnedRequirementsDigest;
  if (pinned === null) return null;
  return whenIssue(
    context,
    () =>
      context.requirements === pinned
        ? passed(evidenceRef("requirements:pinned", pinned))
        : waiting(
          "acceptance_changed",
          evidenceRef("requirements:pinned", pinned),
          ...(context.requirements === null
            ? []
            : [evidenceRef("requirements:live", context.requirements)]),
        ),
  );
}

/** Evaluates every check in `TICKET_CHECK_IDS` order, leaving out those with no input. */
function evaluateChecks(context: Context): TicketReadinessCheck[] {
  const { input } = context;
  const outcomes: [TicketReadinessCheck["id"], Outcome | null][] = [
    ["source_live", sourceLive(input)],
    ["ticket_supported", ticketSupported(context)],
    ["not_held", notHeld(context)],
    ["intent_authorized", intentAuthorized(context)],
    ["epic_excluded", epicExcluded(context)],
    ["acceptance_present", acceptancePresent(context)],
    ["dependencies_satisfied", dependenciesSatisfied(context)],
    ["no_active_admission", noActiveAdmission(input)],
    ["repository_ready", repositoryReady(input)],
    ["preset_ready", presetReady(input)],
    ["authority_live", authorityLive(context)],
    ["requirements_unchanged", requirementsUnchanged(context)],
  ];
  const checks: TicketReadinessCheck[] = [];
  for (const [id, outcome] of outcomes) {
    if (outcome !== null) checks.push({ id, ...outcome });
  }
  return checks;
}

/**
 * Evaluates one ticket for admission. The verdict is `ready` only when every
 * check passes, `rejected` when any check rejects, otherwise `waiting`. The
 * basis digest covers the requirement and dependency digests, the policy
 * revision, the preset, the intent, the label basis, the hold state and every
 * check outcome, so a changed verdict is a new basis and a repeat is not.
 * The report `requirementsDigest` is null when the issue could not be read or
 * its body was too large to hash; the basis still tracks such an issue by its
 * provider update marker.
 */
export async function evaluateReadiness(
  input: ReadinessInput,
): Promise<TicketReadinessReport> {
  const issue = input.issue;
  const normalized = issue.kind === "present"
    ? normalizeSnapshot(issue.snapshot, {
      links: null,
      providerUpdatedAt: issue.providerUpdatedAt,
    })
    : null;
  const labels = issue.kind === "present" ? issue.snapshot.labels : [];
  const requirements = normalized === null
    ? null
    : await requirementsDigest(normalized);
  const dependency = input.links?.kind === "present"
    ? await dependencyDigest(input.links, input.proofs)
    : null;
  const hold = intentFromLabels(labels, input.policy).hold;
  const context: Context = {
    input,
    present: normalized === null ? null : { normalized, labels },
    hold,
    requirements,
  };
  const checks = evaluateChecks(context);
  return {
    version: 1,
    verdict: ticketVerdictFromChecks(checks),
    checks,
    requirementsDigest: normalized === null || normalized.tooLarge
      ? null
      : requirements,
    dependencyDigest: dependency,
    basisDigest: await basisDigest({
      requirementsDigest: requirements,
      dependencyDigest: dependency,
      sourcePolicyRevision: input.policyRevision,
      preset: input.preset,
      intent: input.intent,
      labelBasis: input.labelBasis,
      hold,
      checks: checks.map(({ id, status, reason }) => ({ id, status, reason })),
    }),
    sourcePolicyRevision: input.policyRevision,
    preset: input.preset,
  };
}
