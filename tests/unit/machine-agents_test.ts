import { assertEquals } from "@std/assert";
import {
  agentNeedingSignIn,
  agentOfBinding,
  agentOfKey,
  agentRows,
  agentState,
  attemptEnded,
  type AttemptFacts,
  type BindingFacts,
  dialogView,
  minutesLeft,
  pageBadge,
  parseChallenge,
  paymentKind,
  softwareEntries,
} from "../../apps/web/src/pages/machine-agents.ts";

// #70 C2b: the Coding agents rows and the sign-in dialog, as functions of what the
// server returns. Nothing is shown that the server did not give.

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const binding = (over: Partial<BindingFacts> = {}): BindingFacts => ({
  id: "00000000-0000-4000-8000-0000000000b1",
  componentKey: "harness.claude",
  provider: "anthropic",
  billingRoute: "subscription",
  enabled: true,
  lastCheckedAt: null,
  safeProblem: null,
  ...over,
});

Deno.test("an agent is named by the words of its component key or provider, and pi only as a whole word", () => {
  for (
    const [text, agent] of [
      ["claude", "claude"],
      ["harness.claude-code", "claude"],
      ["anthropic", "claude"],
      ["Claude_Code", "claude"],
      ["codex", "codex"],
      ["harness.codex", "codex"],
      ["openai", "codex"],
      ["pi", "pi"],
      ["pi-harness", "pi"],
      ["harness.pi", "pi"],
    ] as const
  ) assertEquals(agentOfKey(text), agent, text);
  for (
    const text of [
      "piano",
      "spirit",
      "worker-supervisor",
      "git",
      "",
      "harness.bakery",
      "pipeline",
    ]
  ) {
    assertEquals(agentOfKey(text), null, text);
  }
  // The component key wins; the provider is the fallback.
  assertEquals(
    agentOfBinding({ componentKey: "harness.codex", provider: "anthropic" }),
    "codex",
  );
  assertEquals(
    agentOfBinding({ componentKey: "harness.bakery", provider: "openai" }),
    "codex",
  );
  assertEquals(
    agentOfBinding({ componentKey: "harness.bakery", provider: "other" }),
    null,
  );
});

Deno.test("a row is signed out when the server recorded a problem, ready once checked, not checked before, and not signed in without an enabled binding", () => {
  assertEquals(agentState(null), "notSignedIn");
  assertEquals(agentState(binding({ enabled: false })), "notSignedIn");
  assertEquals(
    agentState(binding({ enabled: false, safeProblem: { code: "x" } })),
    "notSignedIn",
  );
  assertEquals(
    agentState(binding({ safeProblem: { code: "AUTH" } })),
    "signedOut",
  );
  assertEquals(
    agentState(
      binding({
        safeProblem: { code: "AUTH" },
        lastCheckedAt: "2026-11-14T00:00:00Z",
      }),
    ),
    "signedOut",
  );
  assertEquals(
    agentState(binding({ lastCheckedAt: "2026-11-14T00:00:00Z" })),
    "ready",
  );
  assertEquals(agentState(binding()), "notChecked");
  assertEquals(
    agentState(binding({ lastCheckedAt: undefined, safeProblem: undefined })),
    "notChecked",
  );
  assertEquals(agentState(binding({ lastCheckedAt: "" })), "notChecked");
});

Deno.test("what a binding pays with is the subscription unless it says otherwise", () => {
  assertEquals(paymentKind(binding()), "subscription");
  assertEquals(paymentKind(binding({ billingRoute: "api_metered" })), "apiKey");
  assertEquals(paymentKind(binding({ billingRoute: "local" })), "localModel");
  assertEquals(
    paymentKind(binding({ billingRoute: "something-new" })),
    "subscription",
  );
});

Deno.test("one row per agent the machine reported, in its order, then any agent only a binding or component names", () => {
  assertEquals(agentRows([], [], []), []);
  const rows = agentRows(["codex", "claude"], [], []);
  assertEquals(
    rows.map((row) => [row.agent, row.state, row.binding, row.componentKey]),
    [
      ["codex", "notSignedIn", null, null],
      ["claude", "notSignedIn", null, null],
    ],
  );
  // A reported component gives a not-signed-in agent what a sign-in is attached to.
  const withComponent = agentRows(["claude"], [], [{
    componentKey: "harness.claude",
  }, { componentKey: "worker-supervisor" }]);
  assertEquals(withComponent[0]!.componentKey, "harness.claude");
  assertEquals(withComponent[0]!.state, "notSignedIn");
  // A binding sets the state and its own component key.
  const signed = agentRows(["claude"], [
    binding({ lastCheckedAt: "2026-11-14T00:00:00Z" }),
  ], [{ componentKey: "other.claude" }]);
  assertEquals(signed.map((row) => [row.agent, row.state, row.componentKey]), [[
    "claude",
    "ready",
    "harness.claude",
  ]]);
  // One only a reported component names gets a row too.
  assertEquals(
    agentRows([], [], [
      { componentKey: "harness.codex" },
      { componentKey: "worker-supervisor" },
    ]).map((row) => [row.agent, row.state, row.componentKey]),
    [["codex", "notSignedIn", "harness.codex"]],
  );
  // An agent the capabilities do not list but a binding names still gets a row, after the listed ones.
  const extra = agentRows(["claude"], [
    binding({ id: "2", componentKey: "harness.pi", provider: "pi" }),
  ], []);
  assertEquals(extra.map((row) => row.agent), ["claude", "pi"]);
  // An enabled binding wins over a disabled one for the same agent, whichever comes first.
  const two = agentRows(["claude"], [
    binding({ id: "old", enabled: false }),
    binding({ id: "new" }),
  ], []);
  assertEquals(two[0]!.binding?.id, "new");
  const only = agentRows(
    ["claude"],
    [binding({ id: "old", enabled: false })],
    [],
  );
  assertEquals(only[0]!.binding?.id, "old");
  assertEquals(only[0]!.state, "notSignedIn");
  // Bindings of other agents never leak into a row.
  const mixed = agentRows(["claude", "codex"], [
    binding({
      id: "c",
      componentKey: "harness.codex",
      provider: "openai",
      lastCheckedAt: "2026-11-14T00:00:00Z",
    }),
  ], []);
  assertEquals(mixed.map((row) => [row.agent, row.state]), [[
    "claude",
    "notSignedIn",
  ], ["codex", "ready"]]);
});

Deno.test("the banner is about the first agent that is signed out, else the first not signed in", () => {
  const rows = agentRows(["claude", "codex", "pi"], [
    binding({
      id: "1",
      componentKey: "harness.codex",
      provider: "openai",
      safeProblem: { code: "AUTH" },
    }),
    binding({
      id: "2",
      componentKey: "harness.pi",
      provider: "pi",
      lastCheckedAt: "2026-11-14T00:00:00Z",
    }),
  ], []);
  assertEquals(agentNeedingSignIn(rows)?.agent, "codex");
  const none = agentRows(["pi"], [
    binding({
      id: "2",
      componentKey: "harness.pi",
      provider: "pi",
      lastCheckedAt: "2026-11-14T00:00:00Z",
    }),
  ], []);
  assertEquals(agentNeedingSignIn(none), null);
  assertEquals(
    agentNeedingSignIn(agentRows(["claude", "pi"], [], []))?.agent,
    "claude",
  );
  assertEquals(agentNeedingSignIn([]), null);
});

Deno.test("an address is shown only if it is a plain https address; a code only if it is plainly a code", () => {
  assertEquals(
    parseChallenge({
      verificationUri: "https://login.example/device",
      userCode: "ABCD-EFGH",
    }),
    {
      address: "https://login.example/device",
      code: "ABCD-EFGH",
    },
  );
  assertEquals(
    parseChallenge({
      verification_uri: "https://login.example/d",
      user_code: "WXYZ1234",
    }),
    { address: "https://login.example/d", code: "WXYZ1234" },
  );
  assertEquals(parseChallenge({ url: "https://login.example/start" }), {
    address: "https://login.example/start",
    code: null,
  });
  assertEquals(parseChallenge("https://login.example/x"), {
    address: "https://login.example/x",
    code: null,
  });
  for (
    const hostile of [
      "javascript:alert(1)",
      "http://login.example/",
      "data:text/html,<script>1</script>",
      "https://user:pass@login.example/",
      "file:///etc/passwd",
      "//login.example/",
      "not a url",
      "",
      `https://login.example/${"a".repeat(2000)}`,
    ]
  ) {
    assertEquals(
      parseChallenge({ verificationUri: hostile }).address,
      null,
      hostile.slice(0, 30),
    );
    assertEquals(parseChallenge(hostile).address, null, hostile.slice(0, 30));
  }
  for (
    const code of [
      "",
      "ab",
      "has space",
      "x".repeat(65),
      "<script>",
      "a\nb",
      "ABCD‏EFGH",
      "ABC;DEF",
    ]
  ) {
    assertEquals(
      parseChallenge({ userCode: code }).code,
      null,
      JSON.stringify(code),
    );
  }
  for (
    const odd of [null, undefined, 7, true, [], ["https://login.example/"], {
      nested: { verificationUri: "https://login.example/" },
    }]
  ) {
    assertEquals(
      parseChallenge(odd),
      { address: null, code: null },
      JSON.stringify(odd),
    );
  }
  // The first key that is a good address wins; a bad one before it is skipped.
  assertEquals(
    parseChallenge({
      verificationUri: "javascript:1",
      url: "https://login.example/ok",
    }).address,
    "https://login.example/ok",
  );
});

Deno.test("minutes left are whole, at least one, and absent without a usable expiry", () => {
  assertEquals(minutesLeft(new Date(NOW + 10 * 60_000).toISOString(), NOW), 10);
  assertEquals(
    minutesLeft(new Date(NOW + 10 * 60_000 - 20_000).toISOString(), NOW),
    10,
  );
  assertEquals(minutesLeft(new Date(NOW + 5_000).toISOString(), NOW), 1);
  assertEquals(minutesLeft(new Date(NOW - 1).toISOString(), NOW), null);
  assertEquals(minutesLeft(new Date(NOW).toISOString(), NOW), null);
  for (const bad of [null, undefined, "", "tomorrow", "2026-13-45"]) {
    assertEquals(minutesLeft(bad, NOW), null, String(bad));
  }
});

const attempt = (over: Partial<AttemptFacts> = {}): AttemptFacts => ({
  flow: "remote_device",
  state: "pending",
  challenge: null,
  instructions: null,
  expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
  ...over,
});

Deno.test("the dialog shows exactly what the server has returned: starting, a code and an address, a link, the machine itself, and each end", () => {
  assertEquals(dialogView(null, NOW), { kind: "starting" });
  assertEquals(dialogView(attempt(), NOW), { kind: "starting" });
  assertEquals(dialogView(attempt({ state: "challenge_issued" }), NOW), {
    kind: "waiting",
    minutes: 10,
  });
  assertEquals(
    dialogView(
      attempt({
        state: "challenge_issued",
        challenge: {
          verificationUri: "https://login.example/d",
          userCode: "ABCD-EFGH",
        },
      }),
      NOW,
    ),
    {
      kind: "codeAndAddress",
      address: "https://login.example/d",
      code: "ABCD-EFGH",
      minutes: 10,
    },
  );
  assertEquals(
    dialogView(
      attempt({
        state: "challenge_issued",
        flow: "remote_browser",
        challenge: { url: "https://login.example/b" },
      }),
      NOW,
    ),
    { kind: "addressOnly", address: "https://login.example/b", minutes: 10 },
  );
  // A code with no address cannot be acted on: it is not shown, only the wait.
  assertEquals(
    dialogView(
      attempt({
        state: "challenge_issued",
        challenge: { userCode: "ABCD-EFGH" },
      }),
      NOW,
    ),
    { kind: "waiting", minutes: 10 },
  );
  // A challenge that is not a plain address is not an address.
  assertEquals(
    dialogView(
      attempt({
        state: "challenge_issued",
        challenge: { verificationUri: "javascript:1", userCode: "ABCD" },
      }),
      NOW,
    ),
    { kind: "waiting", minutes: 10 },
  );
  // The machine itself: the command only when the server gives one.
  assertEquals(
    dialogView(
      attempt({
        state: "terminal",
        flow: "terminal",
        instructions: "claude login",
      }),
      NOW,
    ),
    { kind: "onMachine", command: "claude login" },
  );
  assertEquals(
    dialogView(
      attempt({ state: "terminal", flow: "terminal", instructions: "  " }),
      NOW,
    ),
    { kind: "onMachine", command: null },
  );
  assertEquals(
    dialogView(
      attempt({ state: "terminal", flow: "terminal", instructions: null }),
      NOW,
    ),
    { kind: "onMachine", command: null },
  );
  assertEquals(
    dialogView(
      attempt({
        state: "pending",
        flow: "terminal",
        instructions: "agent two login",
      }),
      NOW,
    ),
    { kind: "onMachine", command: "agent two login" },
  );
  // The state alone says the local handoff, whatever flow the server names.
  assertEquals(
    dialogView(
      attempt({
        state: "terminal",
        flow: "remote_device",
        instructions: "pi login",
      }),
      NOW,
    ),
    { kind: "onMachine", command: "pi login" },
  );
  assertEquals(
    dialogView(
      attempt({ state: "terminal", flow: null, instructions: null }),
      NOW,
    ),
    { kind: "onMachine", command: null },
  );
  // No expiry given: no sentence about one.
  assertEquals(
    dialogView(attempt({ state: "challenge_issued", expiresAt: null }), NOW),
    { kind: "waiting", minutes: null },
  );
  for (
    const [state, kind] of [["completed", "completed"], ["failed", "failed"], [
      "expired",
      "expired",
    ], ["canceled", "canceled"]] as const
  ) {
    assertEquals(
      dialogView(
        attempt({ state, challenge: { url: "https://login.example/b" } }),
        NOW,
      ),
      { kind },
      state,
    );
  }
});

Deno.test("polling stops at the four ends and only there", () => {
  for (const state of ["completed", "failed", "expired", "canceled"]) {
    assertEquals(attemptEnded(state), true, state);
  }
  for (
    const state of ["pending", "challenge_issued", "terminal", "", "unknown"]
  ) assertEquals(attemptEnded(state), false, state);
});

Deno.test("the header badge: Needs attention only for an otherwise Ready or Checking machine with an agent to sign in", () => {
  const signedIn = agentRows(["claude"], [
    binding({ lastCheckedAt: "2026-11-14T00:00:00.000Z" }),
  ], []);
  const none = agentRows(["claude"], [], []);
  const out = agentRows(["claude"], [binding({ safeProblem: "AUTH" })], []);
  const unchecked = agentRows(["claude"], [binding()], []);
  // Every agent signed in: the machine's own reading stands.
  assertEquals(pageBadge("ready", signedIn, true), "ready");
  assertEquals(pageBadge("checking", signedIn, true), "checking");
  // Not signed in, or signed out: a ready or checking machine needs attention.
  assertEquals(pageBadge("ready", none, true), "needsAttention");
  assertEquals(pageBadge("ready", out, true), "needsAttention");
  assertEquals(pageBadge("checking", none, true), "needsAttention");
  // Not checked is not a problem to fix by signing in.
  assertEquals(pageBadge("ready", unchecked, true), "ready");
  // Every more specific reading of the machine is left as it is.
  for (
    const badge of [
      "retired",
      "offline",
      "notResponding",
      "needsAttention",
      "paused",
      "finishing",
    ] as const
  ) {
    assertEquals(pageBadge(badge, none, true), badge, badge);
  }
  // Until the agents' own data is known nothing is claimed about them.
  assertEquals(pageBadge("ready", none, false), "ready");
  assertEquals(pageBadge("ready", [], true), "ready");
});

Deno.test("the software list: an agent by its own name, anything else by the machine's name, once per name and version", () => {
  assertEquals(
    softwareEntries([
      { componentKey: "harness.claude", actualVersion: "1.2.0" },
      { componentKey: "harness.codex", actualVersion: "0.9.1" },
      { componentKey: "harness.claude", actualVersion: "1.2.0" },
      { componentKey: "worker-supervisor", actualVersion: "3.0.0" },
      { componentKey: "harness.claude", actualVersion: "1.3.0" },
    ]),
    [
      {
        key: "claude@1.2.0",
        agent: "claude",
        name: "harness.claude",
        version: "1.2.0",
      },
      {
        key: "codex@0.9.1",
        agent: "codex",
        name: "harness.codex",
        version: "0.9.1",
      },
      {
        key: "worker-supervisor@3.0.0",
        agent: null,
        name: "worker-supervisor",
        version: "3.0.0",
      },
      {
        key: "claude@1.3.0",
        agent: "claude",
        name: "harness.claude",
        version: "1.3.0",
      },
    ],
  );
  assertEquals(softwareEntries([]), []);
});
