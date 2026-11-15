import type {
  RepositoryOnboardingResponse,
  RepositoryProfileObservationResponse,
} from "../../api/client.ts";

type Payload = RepositoryProfileObservationResponse["payload"];
export type CheckResult = Payload["checks"][number];
export type CheckHost = Payload["host"];

/** The sentence key (under `projects.repository.check.name.`) for a check's template. */
export const CHECK_NAME_KEYS = {
  "source.integrity.v1": "source",
  "tool.version.v1": "tool",
  "node.syntax.v1": "node",
  "deno.check.v1": "deno",
  "unsupported.v1": "unsupported",
} as const satisfies Record<CheckResult["template"], string>;

/** The sentence key (under `projects.repository.check.reason.`) for why a check ended as it did. */
export const CHECK_REASON_KEYS = {
  verified: "verified",
  exit_nonzero: "exitNonzero",
  tool_missing: "toolMissing",
  unsupported_command: "unsupportedCommand",
  deadline: "deadline",
  output_limit: "outputLimit",
  platform_mismatch: "platformMismatch",
  source_invalid: "sourceInvalid",
} as const satisfies Record<CheckResult["reason"], string>;

/** What the readiness step shows, from the check's own record and its result. */
export type CheckView =
  | { readonly kind: "none" }
  | { readonly kind: "waiting"; readonly startedAt: string }
  | { readonly kind: "running"; readonly startedAt: string }
  | { readonly kind: "failed" }
  | { readonly kind: "canceled" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "result"; readonly outcome: CheckOutcome };

export type CheckOutcome = {
  /** Every required check passed. */
  readonly ready: boolean;
  readonly required: number;
  /** Required checks that did not pass. */
  readonly blocking: number;
  readonly checks: readonly CheckResult[];
  readonly host: CheckHost;
  readonly observedAt: string;
};

/**
 * Required checks decide Ready; optional ones are shown and never block. The
 * server's own readiness word is not trusted over the checks it lists: a
 * result with a required check that did not pass is never drawn as passed.
 */
export function outcomeOf(
  observation: RepositoryProfileObservationResponse,
): CheckOutcome {
  const required = observation.payload.checks.filter((check) => check.required);
  const blocking = required.filter((check) => check.status !== "passed")
    .length;
  return {
    ready: blocking === 0 && observation.payload.readiness === "eligible",
    required: required.length,
    blocking,
    checks: observation.payload.checks,
    host: observation.payload.host,
    observedAt: observation.payload.observedAt,
  };
}

/**
 * The view of the check the page knows about. `known` is false when no check
 * is known (none started here, none in the address); a read that failed is
 * "unreadable", never a guess.
 */
export function checkView(
  input: {
    readonly known: boolean;
    readonly onboarding: RepositoryOnboardingResponse | null;
    readonly readFailed: boolean;
    readonly observation: RepositoryProfileObservationResponse | null;
    readonly observationFailed: boolean;
  },
): CheckView {
  if (!input.known) return { kind: "none" };
  if (input.onboarding === null) {
    return input.readFailed ? { kind: "unreadable" } : { kind: "loading" };
  }
  const { onboarding } = input;
  if (onboarding.status === "queued" || onboarding.status === "running") {
    // A refresh that failed while the check was running is not progress.
    if (input.readFailed) return { kind: "unreadable" };
    return {
      kind: onboarding.status === "queued" ? "waiting" : "running",
      startedAt: onboarding.createdAt,
    };
  }
  if (onboarding.status === "failed") return { kind: "failed" };
  if (onboarding.status === "canceled") return { kind: "canceled" };
  if (onboarding.profileId === null || onboarding.observationId === null) {
    return { kind: "unavailable" };
  }
  if (input.observationFailed) return { kind: "unreadable" };
  if (input.observation === null) return { kind: "loading" };
  return { kind: "result", outcome: outcomeOf(input.observation) };
}

/** The tools the machine reported missing, in the order it listed them. */
export function missingTools(host: CheckHost): string[] {
  return host.tools.filter((tool) => tool.status === "missing").map((tool) =>
    tool.tool
  );
}

/** Whether a check ended in a way a person can act on by checking again or fixing the machine. */
export function isBlocking(check: CheckResult): boolean {
  return check.required && check.status !== "passed";
}

/**
 * What the header and the footnote say once the connection and the settings
 * are known: Ready when the check passed for the version in use, Check failed
 * when it did not pass (or could not be completed), nothing when no check is
 * known for that version: the page does not guess a state it has not read.
 */
export type CheckStanding = "ready" | "failed" | null;

export function standingOf(
  view: CheckView,
  observedRevision: number | null,
  activeRevision: number | null,
): CheckStanding {
  if (activeRevision === null) return null;
  if (view.kind === "failed" || view.kind === "canceled") return "failed";
  if (view.kind !== "result" || observedRevision === null) return null;
  // The result of an older version says nothing about the one in use now.
  if (observedRevision < activeRevision) return null;
  // A check that did not pass publishes the version it checked but leaves the
  // one in use alone, so a newer, unused version's failed result still counts;
  // only the version in use can be Ready.
  return view.outcome.ready
    ? observedRevision === activeRevision ? "ready" : null
    : "failed";
}
