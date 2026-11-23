import { assertEquals } from "@std/assert";
import {
  type AgentRow,
  agentRows,
  type BindingFacts,
} from "../../apps/web/src/pages/machine-agents.ts";
import {
  agentChoosable,
  agentOfHarness,
  canSwitch,
  createRefusal,
  EMPTY_DRAFT,
  filterModels,
  harnessOfAgent,
  type ModelDraft,
  modelMuted,
  modelNote,
  modelsEmpty,
  modelsForMachine,
  modelState,
  modelTone,
  needsFilters,
  needsHealthRead,
  reasonCode,
  type RouteFacts,
  statusAfterSwitch,
  turnedOffNotice,
  updateRefusal,
  validateDraft,
} from "../../apps/web/src/pages/machine-models.ts";

// #70 slice 4: the Models tab and the Add a model page, as functions of what the server returns.
// Nothing is shown that the server did not give, and the words are the design's.

const BINDING = "00000000-0000-4000-8000-0000000000b1";
const OTHER_BINDING = "00000000-0000-4000-8000-0000000000b2";

const route = (over: Partial<RouteFacts> = {}): RouteFacts => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  provider: "acme",
  model: "acme-large",
  harness: "claude_code",
  billingRoute: "subscription",
  status: "active",
  health: "healthy",
  workerBindingId: BINDING,
  inferenceVerifiedAt: null,
  version: 3,
  ...over,
});

const binding = (over: Partial<BindingFacts> = {}): BindingFacts => ({
  id: BINDING,
  componentKey: "harness.claude",
  provider: "acme",
  billingRoute: "subscription",
  enabled: true,
  lastCheckedAt: "2026-11-21T12:00:00.000Z",
  ...over,
});

const rows = (bindings: BindingFacts[] = [binding()]): AgentRow[] =>
  agentRows(["claude", "codex"], bindings, []);

Deno.test("a model's state is one word from its status and health", () => {
  assertEquals(modelState(route()), "working");
  assertEquals(modelState(route({ health: "degraded" })), "havingTrouble");
  assertEquals(modelState(route({ health: "open" })), "stopped");
  assertEquals(modelState(route({ health: "unverified" })), "notTried");
  // Turned off wins over whatever its health was.
  assertEquals(
    modelState(route({ status: "disabled", health: "open" })),
    "turnedOff",
  );
  // Removed for good is its own state: it can never be turned on again.
  assertEquals(modelState(route({ status: "revoked" })), "revoked");
});

Deno.test("only a working model is green and only a stopped one is red", () => {
  assertEquals(modelTone("working"), "success");
  assertEquals(modelTone("havingTrouble"), "warning");
  assertEquals(modelTone("stopped"), "danger");
  assertEquals(modelTone("notTried"), "neutral");
  assertEquals(modelTone("turnedOff"), "neutral");
  assertEquals(modelTone("revoked"), "neutral");
});

Deno.test("a coding agent and its harness name each other, and one has no agent", () => {
  assertEquals(agentOfHarness("claude_code"), "claude");
  assertEquals(agentOfHarness("codex"), "codex");
  assertEquals(agentOfHarness("pi"), "pi");
  assertEquals(agentOfHarness("mastra"), null);
  assertEquals(harnessOfAgent("claude"), "claude_code");
});

Deno.test("a machine's models are the ones tied to its own sign-ins", () => {
  const mine = route();
  const theirs = route({ id: "x2", workerBindingId: OTHER_BINDING });
  const nobodys = route({ id: "x3", workerBindingId: null });
  assertEquals(
    modelsForMachine([mine, theirs, nobodys], new Set([BINDING])).map((r) =>
      r.id
    ),
    [mine.id],
  );
  assertEquals(modelsForMachine([mine], new Set()), []);
});

Deno.test("a model that is not in use is muted, and a revoked one says why it stays off", () => {
  assertEquals(modelMuted(route()), false);
  assertEquals(modelMuted(route({ status: "disabled" })), true);
  assertEquals(modelMuted(route({ status: "revoked" })), true);
  assertEquals(modelNote(route({ status: "revoked" }), null), {
    kind: "revoked",
  });
  assertEquals(modelNote(route({ status: "disabled" }), null), {
    kind: "none",
  });
});

Deno.test("only an administrator switches a model, and never a revoked one", () => {
  assertEquals(canSwitch(route(), true), true);
  assertEquals(canSwitch(route(), false), false);
  assertEquals(canSwitch(route({ status: "disabled" }), true), true);
  assertEquals(canSwitch(route({ status: "revoked" }), true), false);
  assertEquals(statusAfterSwitch(route()), "disabled");
  assertEquals(statusAfterSwitch(route({ status: "disabled" })), "active");
});

Deno.test("a reason is shown only for a model in trouble, and unknown reasons stay unknown", () => {
  assertEquals(reasonCode("rate_limited"), "rateLimited");
  assertEquals(
    reasonCode("reachable_inference_unverified"),
    "inferenceUnverified",
  );
  assertEquals(reasonCode("something_new"), "unknown");
  assertEquals(reasonCode(null), "unknown");
  assertEquals(needsHealthRead(route()), false);
  assertEquals(needsHealthRead(route({ health: "degraded" })), true);
  assertEquals(needsHealthRead(route({ health: "open" })), true);
  assertEquals(
    needsHealthRead(route({ status: "disabled", health: "open" })),
    false,
  );
});

Deno.test("the muted line under a model says why it is in trouble, or when it last answered", () => {
  const trouble = route({ health: "degraded" });
  assertEquals(
    modelNote(trouble, {
      reason: "timeout",
      reasonSince: "2026-11-21T10:00:00.000Z",
    }),
    { kind: "trouble", reason: "timeout", since: "2026-11-21T10:00:00.000Z" },
  );
  // Until the reason has been read, the line says so rather than guessing.
  assertEquals(modelNote(trouble, null), {
    kind: "trouble",
    reason: "unknown",
    since: null,
  });
  const proven = route({ inferenceVerifiedAt: "2026-11-21T11:00:00.000Z" });
  assertEquals(modelNote(proven, null), {
    kind: "answered",
    at: "2026-11-21T11:00:00.000Z",
  });
  // No proof of an answer, no claim of one.
  assertEquals(modelNote(route(), null), { kind: "none" });
  assertEquals(modelNote(route({ health: "unverified" }), null), {
    kind: "none",
  });
});

Deno.test("more than ten models get a search and a filter by coding agent", () => {
  assertEquals(needsFilters(10), false);
  assertEquals(needsFilters(11), true);
  const list = [
    route({ id: "1", model: "Acme Large" }),
    route({ id: "2", model: "Other", harness: "codex" }),
    route({ id: "3", model: "acme small", harness: "pi" }),
  ];
  assertEquals(
    filterModels(list, { search: "acme", agent: "all" }).map((r) => r.id),
    ["1", "3"],
  );
  assertEquals(
    filterModels(list, { search: "", agent: "codex" }).map((r) => r.id),
    ["2"],
  );
  assertEquals(filterModels(list, { search: "  ", agent: "all" }).length, 3);
  assertEquals(
    filterModels(list, { search: "acme", agent: "pi" }).map((r) => r.id),
    ["3"],
  );
});

Deno.test("the notice under the table is for a model turned off, not a revoked one", () => {
  assertEquals(
    turnedOffNotice([route(), route({ id: "d", status: "disabled" })])?.id,
    "d",
  );
  assertEquals(turnedOffNotice([route(), route({ status: "revoked" })]), null);
  assertEquals(turnedOffNotice([]), null);
});

Deno.test("an empty list asks for a sign-in first when no coding agent is signed in", () => {
  assertEquals(modelsEmpty(rows(), 0), "none");
  assertEquals(modelsEmpty(rows([]), 0), "signInFirst");
  assertEquals(
    modelsEmpty(rows([binding({ enabled: false })]), 0),
    "signInFirst",
  );
  assertEquals(
    modelsEmpty(rows([binding({ safeProblem: { code: "x" } })]), 0),
    "signInFirst",
  );
  assertEquals(modelsEmpty(rows(), 2), null);
});

Deno.test("an agent can be chosen only while it is signed in here", () => {
  const list = rows();
  assertEquals(agentChoosable(list.find((r) => r.agent === "claude")!), true);
  assertEquals(agentChoosable(list.find((r) => r.agent === "codex")!), false);
  assertEquals(
    agentChoosable(
      rows([binding({ safeProblem: { code: "x" } })]).find((r) =>
        r.agent === "claude"
      )!,
    ),
    false,
  );
});

const filled = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  ...EMPTY_DRAFT,
  agent: "claude",
  provider: "acme",
  model: "acme-large",
  endpoint: "https://api.acme.example/v1",
  ...over,
});

Deno.test("a complete form sends the agent's own sign-in, and a harness, never a typed one", () => {
  const result = validateDraft(filled({ region: " eu-west " }), rows());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.input, {
      provider: "acme",
      endpoint: "https://api.acme.example/v1",
      model: "acme-large",
      harness: "claude_code",
      billingRoute: "subscription",
      credentialLocation: "harness_host",
      region: "eu-west",
      workerBindingId: BINDING,
    });
  }
  // An empty region is left out, not sent as an empty string.
  const bare = validateDraft(filled(), rows());
  assertEquals(bare.ok && "region" in bare.input, false);
});

Deno.test("another provider is the typed one", () => {
  const result = validateDraft(
    filled({ provider: "", otherProvider: " newco " }),
    rows(),
  );
  assertEquals(result.ok && result.input.provider, "newco");
  assertEquals(
    validateDraft(filled({ provider: "", otherProvider: "" }), rows()).ok,
    false,
  );
});

Deno.test("a form that is plainly wrong says which field and why", () => {
  const empty = validateDraft(EMPTY_DRAFT, rows());
  assertEquals(empty.ok, false);
  if (!empty.ok) {
    assertEquals(empty.errors, {
      agent: "required",
      provider: "required",
      model: "required",
      endpoint: "required",
    });
  }
  const bad = validateDraft(
    filled({
      endpoint: "http://api.acme.example",
      model: "m".repeat(201),
      region: "r".repeat(65),
    }),
    rows(),
  );
  assertEquals(!bad.ok && bad.errors, {
    endpoint: "address",
    model: "tooLong",
    region: "tooLong",
  });
  assertEquals(
    !validateDraft(filled({ endpoint: "not a url" }), rows()).ok,
    true,
  );
});

Deno.test("an agent that is not signed in cannot be the one a model is added for", () => {
  const result = validateDraft(filled({ agent: "codex" }), rows());
  assertEquals(!result.ok && result.errors.agent, "required");
});

Deno.test("the server's refusal of an address lands under the address field", () => {
  assertEquals(
    createRefusal({ status: 422, issueCodes: ["provider_endpoint_invalid"] }),
    { kind: "field", field: "endpoint", error: "address" },
  );
  assertEquals(
    createRefusal({
      status: 422,
      issues: [{ path: "/endpoint", code: "provider_endpoint_invalid" }],
    }),
    { kind: "field", field: "endpoint", error: "address" },
  );
  assertEquals(
    createRefusal({
      status: 422,
      issueCodes: ["provider_route_binding_unknown"],
    }),
    { kind: "field", field: "agent", error: "required" },
  );
  assertEquals(createRefusal({ status: 409 }), { kind: "changed" });
  assertEquals(createRefusal({ status: 500 }), { kind: "failed" });
  assertEquals(createRefusal(null), { kind: "failed" });
});

Deno.test("a refused switch says someone else changed the model, or that it failed", () => {
  assertEquals(updateRefusal({ status: 412 }), "changed");
  assertEquals(
    updateRefusal({ status: 409, code: "STATE_CONFLICT" }),
    "changed",
  );
  assertEquals(updateRefusal({ status: 428 }), "changed");
  assertEquals(updateRefusal({ status: 500 }), "failed");
  assertEquals(updateRefusal(null), "failed");
});
