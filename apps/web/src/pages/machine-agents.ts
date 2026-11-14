import type { CodingAgent, MachineBadge } from "./machine-state.ts";

/**
 * The machine page's Coding agents section (#70 C2b), as pure functions: which
 * agent a binding or a reported component belongs to, the one state a row shows,
 * and what the sign-in dialog shows for what the server has returned so far.
 * Words such as "binding", "provider" and "billing route" never reach the screen:
 * a row says whether the agent is signed in and which subscription it uses.
 */

export type AgentState = "ready" | "signedOut" | "notChecked" | "notSignedIn";
export type PaymentKind = "subscription" | "apiKey" | "localModel";

/** What the page needs of one provider binding. */
export type BindingFacts = Readonly<{
  id: string;
  componentKey: string;
  provider: string;
  billingRoute: string;
  enabled: boolean;
  lastCheckedAt?: string | null;
  /** Present when the server has recorded a problem with this sign-in. */
  safeProblem?: unknown;
}>;

export type ComponentFacts = Readonly<{ componentKey: string }>;

const AGENT_WORDS: Readonly<Record<CodingAgent, readonly string[]>> = {
  claude: ["claude", "anthropic"],
  codex: ["codex", "openai"],
  pi: ["pi"],
};
const AGENT_ORDER: readonly CodingAgent[] = ["claude", "codex", "pi"];

/**
 * The agent a component key or provider name stands for, by its words: `claude`,
 * `harness.claude-code`, `anthropic` are Claude Code; `pi` only as a whole word
 * (`pi-harness`, never `piano`).
 */
export function agentOfKey(text: string): CodingAgent | null {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const agent of AGENT_ORDER) {
    if (words.some((word) => AGENT_WORDS[agent].includes(word))) return agent;
  }
  return null;
}

export function agentOfBinding(
  binding: Pick<BindingFacts, "componentKey" | "provider">,
): CodingAgent | null {
  return agentOfKey(binding.componentKey) ?? agentOfKey(binding.provider);
}

/** What the person sees for one binding: signed in, signed out, not yet checked, or nothing set up. */
export function agentState(binding: BindingFacts | null): AgentState {
  if (binding === null || !binding.enabled) return "notSignedIn";
  if (binding.safeProblem !== null && binding.safeProblem !== undefined) {
    return "signedOut";
  }
  return binding.lastCheckedAt ? "ready" : "notChecked";
}

export function paymentKind(binding: BindingFacts): PaymentKind {
  return binding.billingRoute === "api_metered"
    ? "apiKey"
    : binding.billingRoute === "local"
    ? "localModel"
    : "subscription";
}

export type AgentRow = Readonly<{
  agent: CodingAgent;
  binding: BindingFacts | null;
  state: AgentState;
  /** The component the machine reported for this agent: what a sign-in is attached to. Null when it has not reported one. */
  componentKey: string | null;
}>;

/**
 * One row per coding agent the machine reported (its capabilities first, in
 * the order it lists them), then any agent only its components or bindings
 * name. An enabled binding wins over a disabled one.
 */
export function agentRows(
  advertised: readonly CodingAgent[],
  bindings: readonly BindingFacts[],
  components: readonly ComponentFacts[],
): AgentRow[] {
  const agents: CodingAgent[] = [...advertised];
  const named = [
    ...bindings.map((binding) => agentOfBinding(binding)),
    ...components.map((component) => agentOfKey(component.componentKey)),
  ];
  for (const agent of named) {
    if (agent !== null && !agents.includes(agent)) agents.push(agent);
  }
  return agents.map((agent) => {
    const own = bindings.filter((binding) => agentOfBinding(binding) === agent);
    const binding = own.find((entry) => entry.enabled) ?? own[0] ?? null;
    const component = components.find((entry) =>
      agentOfKey(entry.componentKey) === agent
    );
    return {
      agent,
      binding,
      state: agentState(binding),
      componentKey: binding?.componentKey ?? component?.componentKey ?? null,
    };
  });
}

/** The name a provider binding is made under for an agent the person signs in. */
export const PROVIDER_OF_AGENT: Readonly<Record<CodingAgent, string>> = {
  claude: "anthropic",
  codex: "openai",
  pi: "pi",
};

/** The first row that needs the person: signed out before not signed in, in the machine's own order. */
export function agentNeedingSignIn(rows: readonly AgentRow[]): AgentRow | null {
  return rows.find((row) => row.state === "signedOut") ??
    rows.find((row) => row.state === "notSignedIn") ?? null;
}

export type SoftwareEntry = Readonly<{
  /** Stable key for a list. */
  key: string;
  /** The coding agent the component is, if it is one. */
  agent: CodingAgent | null;
  /** The machine's own name for it when it is not an agent. */
  name: string;
  version: string;
}>;

/**
 * What the machine reports it has installed, one entry per distinct name and
 * version, in the machine's order: a coding agent by its own name, anything
 * else by the name the machine gave it. No kind and no install owner: they are
 * the machine's words for itself, not the person's.
 */
export function softwareEntries(
  components: readonly Readonly<{
    componentKey: string;
    actualVersion: string;
  }>[],
): SoftwareEntry[] {
  const seen = new Set<string>();
  const entries: SoftwareEntry[] = [];
  for (const component of components) {
    const agent = agentOfKey(component.componentKey);
    const name = agent ?? component.componentKey;
    const key = `${name}@${component.actualVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      key,
      agent,
      name: component.componentKey,
      version: component.actualVersion,
    });
  }
  return entries;
}

/**
 * The badge in the machine page's header. A machine that would read Ready (or
 * Checking) reads Needs attention while an agent on it is signed out or not
 * signed in; every more specific reading (Retired, Offline, Not responding,
 * Paused, Finishing up, or the server's own Needs attention) is left as it is.
 * `known` is false until the agents' own data has loaded, so a page still
 * loading never claims an agent is missing its sign-in.
 */
export function pageBadge(
  badge: MachineBadge,
  rows: readonly AgentRow[],
  known: boolean,
): MachineBadge {
  if (!known) return badge;
  if (badge !== "ready" && badge !== "checking") return badge;
  return agentNeedingSignIn(rows) === null ? badge : "needsAttention";
}

// --- the sign-in dialog -----------------------------------------------------

export type AttemptFacts = Readonly<{
  flow?: string | null;
  state: string;
  challenge?: unknown;
  /** Local-login instructions for a terminal-only agent, when the server gives them. */
  instructions?: string | null;
  expiresAt?: string | null;
}>;

export type DialogView =
  | Readonly<{ kind: "starting" }>
  | Readonly<{ kind: "waiting"; minutes: number | null }>
  | Readonly<
    {
      kind: "codeAndAddress";
      address: string;
      code: string;
      minutes: number | null;
    }
  >
  | Readonly<{ kind: "addressOnly"; address: string; minutes: number | null }>
  | Readonly<{ kind: "onMachine"; command: string | null }>
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "canceled" }>;

const ADDRESS_KEYS = [
  "verificationUri",
  "verification_uri",
  "verificationUrl",
  "verification_url",
  "url",
  "uri",
  "link",
];
const CODE_KEYS = ["userCode", "user_code", "code"];

function httpsAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) {
    return null;
  }
  try {
    const url = new URL(value);
    // Only a plain https address with no login in it: it opens in a new tab.
    return url.protocol === "https:" && url.username === "" &&
        url.password === ""
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** The address and the code in a challenge, each only if it is plainly one. */
export function parseChallenge(
  challenge: unknown,
): { address: string | null; code: string | null } {
  if (typeof challenge === "string") {
    return { address: httpsAddress(challenge), code: null };
  }
  if (typeof challenge !== "object" || challenge === null) {
    return { address: null, code: null };
  }
  const record = challenge as Record<string, unknown>;
  let address: string | null = null;
  for (const key of ADDRESS_KEYS) {
    address = httpsAddress(record[key]);
    if (address !== null) break;
  }
  let code: string | null = null;
  for (const key of CODE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && /^[A-Za-z0-9-]{3,64}$/.test(value)) {
      code = value;
      break;
    }
  }
  return { address, code };
}

/** Whole minutes left, at least one, or null when there is no usable expiry. */
export function minutesLeft(
  expiresAt: string | null | undefined,
  now: number,
): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at) || at <= now) return null;
  return Math.max(1, Math.round((at - now) / 60_000));
}

/**
 * What the dialog shows, from what the server has returned: nothing is shown that
 * the server did not give (no address, no code, no command) beyond the plain
 * sentence for the state.
 */
export function dialogView(
  attempt: AttemptFacts | null,
  now: number,
): DialogView {
  if (attempt === null) return { kind: "starting" };
  switch (attempt.state) {
    case "completed":
      return { kind: "completed" };
    case "failed":
      return { kind: "failed" };
    case "expired":
      return { kind: "expired" };
    case "canceled":
      return { kind: "canceled" };
    case "terminal":
      return {
        kind: "onMachine",
        command: attempt.instructions?.trim() || null,
      };
    default:
      break;
  }
  if (attempt.flow === "terminal") {
    return { kind: "onMachine", command: attempt.instructions?.trim() || null };
  }
  const minutes = minutesLeft(attempt.expiresAt, now);
  const { address, code } = parseChallenge(attempt.challenge);
  if (address !== null && code !== null) {
    return { kind: "codeAndAddress", address, code, minutes };
  }
  if (address !== null) return { kind: "addressOnly", address, minutes };
  if (attempt.state === "challenge_issued") return { kind: "waiting", minutes };
  return { kind: "starting" };
}

/** Whether the attempt has reached an end: the polling stops there. */
export function attemptEnded(state: string): boolean {
  return state === "completed" || state === "failed" || state === "expired" ||
    state === "canceled";
}
