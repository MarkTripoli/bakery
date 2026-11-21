import type { AgentRow } from "./machine-agents.ts";
import type { CodingAgent } from "./machine-state.ts";

/**
 * The machine page's Models tab and its "Add a model" page (#70 slice 4), as pure functions.
 * Words such as "provider route", "binding" and "incident" never reach the screen: a row says which
 * model, which coding agent, how it is paid and one state. The page turns the codes returned here into
 * words, so every sentence stays in the string catalogue.
 */

export type RouteHarness = "pi" | "claude_code" | "codex" | "mastra";
export type RouteBilling = "subscription" | "api_metered" | "local";
export type RouteStatus = "active" | "disabled" | "revoked";
export type RouteHealth = "healthy" | "degraded" | "open" | "unverified";

/** What the page needs of one served model. */
export type RouteFacts = Readonly<{
  id: string;
  provider: string;
  model: string;
  harness: RouteHarness;
  billingRoute: RouteBilling;
  status: RouteStatus;
  health: RouteHealth;
  workerBindingId: string | null;
  inferenceVerifiedAt: string | null;
  version: number;
}>;

/** The one state a row shows. */
export type ModelState =
  | "working"
  | "havingTrouble"
  | "stopped"
  | "notTried"
  | "turnedOff";

export function modelState(
  route: Pick<RouteFacts, "status" | "health">,
): ModelState {
  if (route.status !== "active") return "turnedOff";
  switch (route.health) {
    case "healthy":
      return "working";
    case "degraded":
      return "havingTrouble";
    case "open":
      return "stopped";
    default:
      return "notTried";
  }
}

export type ModelTone = "success" | "warning" | "danger" | "neutral";

export function modelTone(state: ModelState): ModelTone {
  switch (state) {
    case "working":
      return "success";
    case "havingTrouble":
      return "warning";
    case "stopped":
      return "danger";
    default:
      return "neutral";
  }
}

const AGENT_OF_HARNESS: Readonly<Record<RouteHarness, CodingAgent | null>> = {
  claude_code: "claude",
  codex: "codex",
  pi: "pi",
  mastra: null,
};

export function agentOfHarness(harness: RouteHarness): CodingAgent | null {
  return AGENT_OF_HARNESS[harness];
}

const HARNESS_OF_AGENT: Readonly<Record<CodingAgent, RouteHarness>> = {
  claude: "claude_code",
  codex: "codex",
  pi: "pi",
};

export function harnessOfAgent(agent: CodingAgent): RouteHarness {
  return HARNESS_OF_AGENT[agent];
}

/**
 * The models this machine may use: those tied to one of its own sign-ins. The server lists models for
 * the whole organization with no machine filter, so the match is made here. A model with no sign-in is
 * not any one machine's.
 */
export function modelsForMachine(
  routes: readonly RouteFacts[],
  machineBindingIds: ReadonlySet<string>,
): RouteFacts[] {
  return routes.filter((route) =>
    route.workerBindingId !== null &&
    machineBindingIds.has(route.workerBindingId)
  );
}

/**
 * Where a machine's own sign-ins cannot be read (only an administrator reads them), the models shown are
 * those for the coding agents the machine advertises: the ones its work can be sent to.
 */
export function modelsForAgents(
  routes: readonly RouteFacts[],
  agents: readonly CodingAgent[],
): RouteFacts[] {
  return routes.filter((route) => {
    const agent = agentOfHarness(route.harness);
    return agent !== null && agents.includes(agent);
  });
}

/** A turned-off model that is only turned off can come back; a revoked one never does. */
export function canSwitch(
  route: Pick<RouteFacts, "status">,
  isAdmin: boolean,
): boolean {
  return isAdmin && route.status !== "revoked";
}

/** The status a switch asks for when it is pressed. */
export function statusAfterSwitch(
  route: Pick<RouteFacts, "status">,
): "active" | "disabled" {
  return route.status === "active" ? "disabled" : "active";
}

/** Why the server says a model is in trouble, in the codes the page has words for. */
export type ReasonCode =
  | "rateLimited"
  | "credentialInvalid"
  | "quotaExhausted"
  | "transportFailure"
  | "providerError"
  | "timeout"
  | "inferenceUnverified"
  | "redirected"
  | "unknown";

const REASONS: Readonly<Record<string, ReasonCode>> = {
  rate_limited: "rateLimited",
  credential_invalid: "credentialInvalid",
  quota_exhausted: "quotaExhausted",
  transport_failure: "transportFailure",
  provider_error: "providerError",
  timeout: "timeout",
  reachable_inference_unverified: "inferenceUnverified",
  redirected: "redirected",
};

export function reasonCode(reason: string | null | undefined): ReasonCode {
  return reason !== null && reason !== undefined &&
      Object.hasOwn(REASONS, reason)
    ? REASONS[reason]
    : "unknown";
}

/** The muted line under a model name, and what it needs from the server to be written. */
export type ModelNote =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "answered"; at: string }>
  | Readonly<{ kind: "trouble"; reason: ReasonCode; since: string | null }>;

export function modelNote(
  route: Pick<RouteFacts, "status" | "health" | "inferenceVerifiedAt">,
  health:
    | Readonly<{ reason: string | null; reasonSince: string | null }>
    | null,
): ModelNote {
  const state = modelState(route);
  if (state === "havingTrouble" || state === "stopped") {
    return {
      kind: "trouble",
      reason: reasonCode(health?.reason),
      since: health?.reasonSince ?? null,
    };
  }
  if (state === "working" && route.inferenceVerifiedAt) {
    return { kind: "answered", at: route.inferenceVerifiedAt };
  }
  return { kind: "none" };
}

/** Only a model in trouble has a reason worth a second request. */
export function needsHealthRead(
  route: Pick<RouteFacts, "status" | "health">,
): boolean {
  const state = modelState(route);
  return state === "havingTrouble" || state === "stopped";
}

/** More than ten models get a search box and a filter by coding agent. */
export const FILTER_THRESHOLD = 10;

export function needsFilters(count: number): boolean {
  return count > FILTER_THRESHOLD;
}

export function filterModels(
  routes: readonly RouteFacts[],
  filter: Readonly<{ search: string; agent: CodingAgent | "all" }>,
): RouteFacts[] {
  const text = filter.search.trim().toLowerCase();
  return routes.filter((route) =>
    (filter.agent === "all" ||
      agentOfHarness(route.harness) === filter.agent) &&
    (text === "" || route.model.toLowerCase().includes(text))
  );
}

/** Which notice sits under the table for a model that is turned off, if any. */
export function turnedOffNotice(
  routes: readonly RouteFacts[],
): RouteFacts | null {
  return routes.find((route) => route.status === "disabled") ?? null;
}

/** What the Models tab shows when there is nothing to list. */
export type ModelsEmpty = "none" | "signInFirst";

export function modelsEmpty(
  rows: readonly AgentRow[],
  count: number,
): ModelsEmpty | null {
  if (count > 0) return null;
  return rows.some((row) => row.state === "ready" || row.state === "notChecked")
    ? "none"
    : "signInFirst";
}

/** An agent can be chosen for a model only while it is signed in on this machine. */
export function agentChoosable(row: AgentRow): boolean {
  return row.binding !== null &&
    (row.state === "ready" || row.state === "notChecked");
}

export type ModelDraft = Readonly<{
  agent: CodingAgent | null;
  /** The provider picked from the list, or "" while "Another provider" is chosen. */
  provider: string;
  /** What is typed when "Another provider" is chosen. */
  otherProvider: string;
  model: string;
  endpoint: string;
  region: string;
}>;

export const EMPTY_DRAFT: ModelDraft = {
  agent: null,
  provider: "",
  otherProvider: "",
  model: "",
  endpoint: "",
  region: "",
};

export type DraftField = "agent" | "provider" | "model" | "endpoint" | "region";
export type DraftError = "required" | "tooLong" | "address";

export type CreateInput = Readonly<{
  provider: string;
  endpoint: string;
  model: string;
  harness: RouteHarness;
  billingRoute: RouteBilling;
  credentialLocation: "harness_host" | "bakery_secret";
  region?: string;
  workerBindingId: string;
}>;

export const MAX_PROVIDER = 64;
export const MAX_ENDPOINT = 2048;
export const MAX_MODEL = 200;
export const MAX_REGION = 64;

/** The provider the draft names: the one picked, or the one typed under "Another provider". */
export function draftProvider(draft: ModelDraft): string {
  return (draft.provider === "" ? draft.otherProvider : draft.provider).trim();
}

/**
 * What the form may send, or what is wrong. The server is the authority on an address (it refuses a
 * private or credentialed one); here only what is plainly wrong is caught, so the person is told at once.
 */
export function validateDraft(
  draft: ModelDraft,
  rows: readonly AgentRow[],
):
  | Readonly<{ ok: true; input: CreateInput }>
  | Readonly<{ ok: false; errors: Partial<Record<DraftField, DraftError>> }> {
  const errors: Partial<Record<DraftField, DraftError>> = {};
  const row = rows.find((entry) => entry.agent === draft.agent) ?? null;
  if (draft.agent === null || row === null || !agentChoosable(row)) {
    errors.agent = "required";
  }
  const provider = draftProvider(draft);
  if (provider === "") errors.provider = "required";
  else if (provider.length > MAX_PROVIDER) errors.provider = "tooLong";
  const model = draft.model.trim();
  if (model === "") errors.model = "required";
  else if (model.length > MAX_MODEL) errors.model = "tooLong";
  const endpoint = draft.endpoint.trim();
  if (endpoint === "") errors.endpoint = "required";
  else if (endpoint.length > MAX_ENDPOINT) errors.endpoint = "tooLong";
  else if (!looksLikeHttps(endpoint)) errors.endpoint = "address";
  const region = draft.region.trim();
  if (region.length > MAX_REGION) errors.region = "tooLong";
  if (Object.keys(errors).length > 0 || row?.binding === null || row === null) {
    return { ok: false, errors };
  }
  const binding = row.binding!;
  return {
    ok: true,
    input: {
      provider,
      endpoint,
      model,
      harness: harnessOfAgent(row.agent),
      billingRoute: binding.billingRoute as RouteBilling,
      credentialLocation: "harness_host",
      ...(region === "" ? {} : { region }),
      workerBindingId: binding.id,
    },
  };
}

function looksLikeHttps(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

/** What the server's refusal of a new model points at, in the form's own fields. */
export type CreateRefusal =
  | Readonly<{ kind: "field"; field: DraftField; error: DraftError }>
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "failed" }>;

export type ProblemFacts = Readonly<{
  status?: number;
  code?: string;
  issueCodes?: readonly string[];
  issues?: readonly Readonly<{ path?: string; code?: string }>[];
}>;

export function createRefusal(
  problem: ProblemFacts | null | undefined,
): CreateRefusal {
  if (problem?.status === 422) {
    const codes = problem.issueCodes ?? problem.issues?.map((issue) =>
      issue.code ?? ""
    ) ?? [];
    if (codes.includes("provider_endpoint_invalid")) {
      return { kind: "field", field: "endpoint", error: "address" };
    }
    if (codes.includes("provider_route_binding_unknown")) {
      return { kind: "field", field: "agent", error: "required" };
    }
  }
  if (problem?.status === 409 || problem?.status === 412) {
    return { kind: "changed" };
  }
  return { kind: "failed" };
}

/** What a refused switch says: someone else changed the model, or it could not be changed. */
export function updateRefusal(
  problem: ProblemFacts | null | undefined,
): "changed" | "failed" {
  return problem?.status === 409 || problem?.status === 412 ||
      problem?.status === 428
    ? "changed"
    : "failed";
}
