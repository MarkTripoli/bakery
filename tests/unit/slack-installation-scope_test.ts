import { assert, assertEquals } from "@std/assert";
import {
  channelCapability,
  classifySlackInstallation,
  isSlackEnterpriseId,
  resolveSlackActor,
  SLACK_FEATURE_SCOPES,
  slackFeaturesFor,
  type SlackIdentityLink,
} from "../../apps/server/src/modules/integrations/slack-scope.ts";

// A Slack workspace installing the bot and a person proving who they are are
// two separate authorities. These cases pin the three ways they can be confused:
// treating an organization-wide install as a workspace one, treating a channel
// the admin did not select as available, and treating an unlinked Slack user as
// a Bakery member.

// Assembled at run time: a token-shaped literal in the source trips push
// protection and every secret scanner, and this one is only a stand-in.
const BOT_TOKEN = [
  "xo",
  "xb-",
  "123456789012-",
  "1234567890123-",
  "secretsecretsecret",
].join("");

function install(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    app_id: "A0APP123",
    access_token: BOT_TOKEN,
    token_type: "bot",
    scope: "channels:read,chat:write,commands,app_mentions:read",
    bot_user_id: "U0BOT1234",
    team: { id: "T0ABC123", name: "Acme" },
    enterprise: null,
    is_enterprise_install: false,
    authed_user: { id: "U0ADMIN12" },
    ...overrides,
  };
}

const expectedApp = "A0APP123";

Deno.test("a workspace installation is accepted and keeps the verified team, the app and the bot, and never the token", () => {
  const result = classifySlackInstallation(install(), expectedApp);
  assert(result.ok);
  assertEquals(result.installation, {
    kind: "workspace",
    appId: "A0APP123",
    teamId: "T0ABC123",
    botUserId: "U0BOT1234",
    scopes: ["app_mentions:read", "channels:read", "chat:write", "commands"],
  });
  assert(!JSON.stringify(result).includes(BOT_TOKEN));
  assert(!JSON.stringify(result).includes("xoxb"));
});

Deno.test("a workspace inside an Enterprise Grid organization keeps the enterprise id", () => {
  const result = classifySlackInstallation(
    install({ enterprise: { id: "E0ENT1234", name: "Acme Org" } }),
    expectedApp,
  );
  assert(result.ok);
  assertEquals(result.installation.enterpriseId, "E0ENT1234");
  assertEquals(result.installation.kind, "workspace");
});

Deno.test("an organization-wide installation is refused, however it is flagged", () => {
  // The documented flag.
  assertEquals(
    classifySlackInstallation(
      install({ is_enterprise_install: true }),
      expectedApp,
    ),
    { ok: false, reason: "organization_wide" },
  );
  // With an enterprise and no team of its own: an org-level install carries no workspace.
  assertEquals(
    classifySlackInstallation(
      install({
        is_enterprise_install: true,
        team: null,
        enterprise: { id: "E0ENT1234" },
      }),
      expectedApp,
    ),
    { ok: false, reason: "organization_wide" },
  );
  // A flag that is present but not literally false is not a workspace install.
  for (const flag of ["false", 0, null, "", "no", {}, []]) {
    const result = classifySlackInstallation(
      install({ is_enterprise_install: flag }),
      expectedApp,
    );
    assert(
      !result.ok,
      `is_enterprise_install=${JSON.stringify(flag)} was accepted`,
    );
    assertEquals(result.reason, "organization_wide");
  }
  // An absent flag on a response that has an enterprise but no team.
  const noTeam = install({ team: undefined, enterprise: { id: "E0ENT1234" } });
  delete noTeam.is_enterprise_install;
  assert(!classifySlackInstallation(noTeam, expectedApp).ok);
});

Deno.test("a response that is not a clean bot installation of this app is refused", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["not ok", install({ ok: false, error: "invalid_code" }), "not_ok"],
    ["ok as a string", install({ ok: "true" }), "not_ok"],
    ["another app", install({ app_id: "A0OTHER99" }), "wrong_app"],
    ["no app", install({ app_id: undefined }), "wrong_app"],
    ["app in another case", install({ app_id: "a0app123" }), "wrong_app"],
    ["no bot user", install({ bot_user_id: undefined }), "malformed"],
    [
      "bot user that is not a user id",
      install({ bot_user_id: "bot" }),
      "malformed",
    ],
    ["a user token response", install({ token_type: "user" }), "malformed"],
    ["no team", install({ team: undefined }), "malformed"],
    ["a team with a bad id", install({ team: { id: "acme" } }), "malformed"],
    ["a team that is a string", install({ team: "T0ABC123" }), "malformed"],
    [
      "an enterprise with a bad id",
      install({ enterprise: { id: "org" } }),
      "malformed",
    ],
    [
      "scopes that are not a string",
      install({ scope: ["chat:write"] }),
      "malformed",
    ],
    [
      "a scope with a bad shape",
      install({ scope: "chat:write,rm -rf" }),
      "malformed",
    ],
    [
      "too many scopes",
      install({
        scope: Array.from(
          { length: 200 },
          (_, i) =>
            `scope${String.fromCharCode(97 + (i % 26))}${
              String.fromCharCode(97 + Math.floor(i / 26))
            }:read`,
        ).join(","),
      }),
      "malformed",
    ],
  ];
  for (const [name, response, reason] of cases) {
    const result = classifySlackInstallation(response, expectedApp);
    assert(!result.ok, `accepted: ${name}`);
    assertEquals(result.reason, reason, name);
  }
  for (const response of [null, undefined, 5, "ok", [], true]) {
    assertEquals(classifySlackInstallation(response, expectedApp), {
      ok: false,
      reason: "malformed",
    });
  }
  // The expected app itself must be a real id.
  assertEquals(classifySlackInstallation(install(), ""), {
    ok: false,
    reason: "wrong_app",
  });
  assertEquals(classifySlackInstallation(install(), undefined as never), {
    ok: false,
    reason: "wrong_app",
  });
});

Deno.test("scopes are de-duplicated, sorted and bounded, and a refusal never contains the token", () => {
  // Whitespace around a scope is not tolerated: it would be a different string.
  for (
    const scope of [
      "chat:write, commands",
      " chat:write",
      "chat:write ",
      "chat:write,,commands",
      ",chat:write",
      "chat:write,",
    ]
  ) {
    assertEquals(
      classifySlackInstallation(install({ scope }), expectedApp),
      { ok: false, reason: "malformed" },
      JSON.stringify(scope),
    );
  }
  const dup = classifySlackInstallation(
    install({ scope: "commands,chat:write,commands" }),
    expectedApp,
  );
  assert(dup.ok);
  assertEquals(dup.installation.scopes, ["chat:write", "commands"]);
  for (
    const bad of [
      install({ ok: false }),
      install({ app_id: "A0OTHER99" }),
      install({ is_enterprise_install: true }),
      null,
    ]
  ) {
    assert(
      !JSON.stringify(classifySlackInstallation(bad, expectedApp)).includes(
        "xoxb",
      ),
    );
  }
});

Deno.test("a feature is on only when every scope it needs was granted, and an unknown scope switches nothing on", () => {
  const all = Object.values(SLACK_FEATURE_SCOPES).flat();
  const features = (scopes: string[]) => slackFeaturesFor(scopes).sort();
  assertEquals(features([]), []);
  assertEquals(features(["chat:write"]), ["progress_posts"]);
  assertEquals(features(["channels:read"]), ["channel_picker"]);
  assertEquals(features(["commands"]), ["slash_commands"]);
  assertEquals(features(["app_mentions:read"]), ["mentions"]);
  // `message.groups` is an event subscription, not a scope, so only the history
  // scope can appear in an installation response. Whether private channels may
  // take part is the admin's separate switch, checked by channelCapability.
  assertEquals(features(["groups:history"]), ["linked_replies_private"]);
  assertEquals(features(["channels:history"]), ["linked_replies_public"]);
  assertEquals(
    features(["groups:history", "channels:history"]),
    ["linked_replies_private", "linked_replies_public"],
  );
  assert(features(["channels:history"]).includes("linked_replies_public"));
  assertEquals(features(all).length, Object.keys(SLACK_FEATURE_SCOPES).length);
  // Prefix and wildcard grants do not count; a scope is matched whole.
  assertEquals(features(["chat"]), []);
  assertEquals(features(["chat:*"]), []);
  assertEquals(features(["*"]), []);
  assertEquals(features(["chat:write:extra"]), []);
  assertEquals(features(["CHAT:WRITE"]), []);
  assertEquals(features(["admin"]), []);
  assertEquals(slackFeaturesFor(null as never), []);
  assertEquals(slackFeaturesFor("chat:write" as never), []);
});

const selection = (ids: string[], privateParticipation = false) => ({
  selectedChannelIds: new Set(ids),
  privateParticipation,
});

Deno.test("a channel is available only when the admin selected it and the bot is in it", () => {
  const picked = selection(["C0PUBLIC1", "C0PUBLIC2"]);
  assertEquals(
    channelCapability(picked, {
      id: "C0PUBLIC1",
      isPrivate: false,
      botIsMember: true,
    }),
    { available: true },
  );
  assertEquals(
    channelCapability(picked, {
      id: "C0OTHER99",
      isPrivate: false,
      botIsMember: true,
    }),
    { available: false, reason: "not_selected" },
  );
  assertEquals(
    channelCapability(picked, {
      id: "C0PUBLIC1",
      isPrivate: false,
      botIsMember: false,
    }),
    { available: false, reason: "bot_not_member" },
  );
  assertEquals(
    channelCapability(selection([]), {
      id: "C0PUBLIC1",
      isPrivate: false,
      botIsMember: true,
    }),
    { available: false, reason: "not_selected" },
  );
});

Deno.test("a private channel needs private participation to be switched on as well as selected", () => {
  const channel = { id: "G0PRIVATE1", isPrivate: true, botIsMember: true };
  assertEquals(channelCapability(selection(["G0PRIVATE1"]), channel), {
    available: false,
    reason: "private_not_enabled",
  });
  assertEquals(channelCapability(selection(["G0PRIVATE1"], true), channel), {
    available: true,
  });
  assertEquals(channelCapability(selection([], true), channel), {
    available: false,
    reason: "not_selected",
  });
  // A public channel is not affected by the private switch.
  assertEquals(
    channelCapability(selection(["C0PUBLIC1"], true), {
      id: "C0PUBLIC1",
      isPrivate: false,
      botIsMember: true,
    }),
    { available: true },
  );
});

Deno.test("anything that is not clearly a selected channel is unavailable, not guessed at", () => {
  const picked = selection(["C0PUBLIC1"], true);
  const good = { id: "C0PUBLIC1", isPrivate: false, botIsMember: true };
  const malformed: unknown[] = [
    null,
    undefined,
    "C0PUBLIC1",
    5,
    [],
    {},
    { ...good, id: undefined },
    { ...good, id: "" },
    { ...good, id: "c0public1" },
    { ...good, id: "C0PUBLIC1 " },
    { ...good, id: "C0PUBLIC1\n" },
    { ...good, id: ["C0PUBLIC1"] },
    { ...good, id: "D0DIRECT01" },
    { ...good, id: "U0USER1234" },
    { ...good, isPrivate: "false" },
    { ...good, isPrivate: undefined },
    { ...good, botIsMember: "true" },
    { ...good, botIsMember: 1 },
    { ...good, botIsMember: undefined },
  ];
  for (const channel of malformed) {
    const result = channelCapability(picked, channel as never);
    assert(!result.available, `available: ${JSON.stringify(channel)}`);
  }
  // A selection that is not a real selection grants nothing.
  for (
    const bad of [null, undefined, {}, {
      selectedChannelIds: ["C0PUBLIC1"],
      privateParticipation: false,
    }, {
      selectedChannelIds: new Set(["C0PUBLIC1"]),
      privateParticipation: "yes",
    }]
  ) {
    assert(!channelCapability(bad as never, good).available);
  }
  // An id in the selection that is not an id never matches a real channel by accident.
  assert(!channelCapability(selection(["*", "C0*", ""]), good).available);
});

const subject = { teamId: "T0ABC123", userId: "U0USER123" };
const link = (
  overrides: Partial<SlackIdentityLink> = {},
): SlackIdentityLink => ({
  principalId: "11111111-2222-4333-8444-555555555555",
  state: "active",
  memberCurrent: true,
  ...overrides,
});

Deno.test("an installation without a link never acts as a Bakery member", async () => {
  // The bot is installed and a user sends a protected command; nothing links them.
  const actor = await resolveSlackActor(
    subject,
    () => Promise.resolve(undefined),
  );
  assertEquals(actor, {
    kind: "service",
    verifiedHuman: false,
    reason: "unlinked",
  });
  assert(!("principalId" in actor));
});

Deno.test("a link counts only while it is active and its principal is a current member", async () => {
  assertEquals(
    await resolveSlackActor(subject, () => Promise.resolve(link())),
    {
      kind: "human",
      principalId: "11111111-2222-4333-8444-555555555555",
    },
  );
  assertEquals(
    await resolveSlackActor(
      subject,
      () => Promise.resolve(link({ state: "revoked" })),
    ),
    {
      kind: "service",
      verifiedHuman: false,
      reason: "revoked",
    },
  );
  assertEquals(
    await resolveSlackActor(
      subject,
      () => Promise.resolve(link({ memberCurrent: false })),
    ),
    {
      kind: "service",
      verifiedHuman: false,
      reason: "not_a_member",
    },
  );
  // Anything but the exact active state is not active.
  for (const state of ["pending", "ACTIVE", "", undefined, null, 1]) {
    const actor = await resolveSlackActor(
      subject,
      () => Promise.resolve(link({ state: state as never })),
    );
    assertEquals(actor.kind, "service", `state ${String(state)}`);
  }
  for (const memberCurrent of ["true", 1, undefined, null]) {
    const actor = await resolveSlackActor(
      subject,
      () => Promise.resolve(link({ memberCurrent: memberCurrent as never })),
    );
    assertEquals(
      actor.kind,
      "service",
      `memberCurrent ${String(memberCurrent)}`,
    );
  }
  // A link row without a principal id cannot become one.
  for (const principalId of ["", undefined, null, 5, {}]) {
    const actor = await resolveSlackActor(
      subject,
      () => Promise.resolve(link({ principalId: principalId as never })),
    );
    assertEquals(actor.kind, "service");
  }
});

Deno.test("the lookup is keyed by the stable ids and nothing a person can choose", async () => {
  const seen: unknown[] = [];
  const spy = (key: unknown) => {
    seen.push(key);
    return Promise.resolve(undefined);
  };
  // Display name, handle and email arrive on real events; none may reach the lookup.
  await resolveSlackActor(
    {
      ...subject,
      enterpriseId: "E0ENT1234",
      displayName: "Alice Example",
      handle: "@alice",
      email: "alice@example.com",
    } as never,
    spy,
  );
  assertEquals(seen, [{
    teamId: "T0ABC123",
    userId: "U0USER123",
    enterpriseId: "E0ENT1234",
  }]);
  assert(!JSON.stringify(seen).includes("alice"));
});

Deno.test("a subject that is not a real workspace and user never reaches the lookup", async () => {
  let calls = 0;
  const lookup = () => {
    calls += 1;
    return Promise.resolve(link());
  };
  for (
    const bad of [
      null,
      undefined,
      {},
      { teamId: "T0ABC123" },
      { userId: "U0USER123" },
      { teamId: "acme", userId: "U0USER123" },
      { teamId: "T0ABC123", userId: "alice" },
      { teamId: "T0ABC123", userId: "alice@example.com" },
      { teamId: "T0ABC123", userId: "U0USER123", enterpriseId: "org" },
      { teamId: "t0abc123", userId: "U0USER123" },
      { teamId: "T0ABC123", userId: "U0USER123\n" },
    ]
  ) {
    const actor = await resolveSlackActor(bad as never, lookup as never);
    assertEquals(actor, {
      kind: "service",
      verifiedHuman: false,
      reason: "malformed",
    }, JSON.stringify(bad));
  }
  assertEquals(calls, 0);
});

Deno.test("a lookup that fails is a service identity, never a guess at a person", async () => {
  const boom = () => Promise.reject(new Error("database down"));
  const sync = () => {
    throw new Error("sync boom");
  };
  for (
    const lookup of [
      boom,
      sync,
      () => Promise.resolve(null),
      () => Promise.resolve("U0USER123"),
      () => Promise.resolve(5),
    ]
  ) {
    const actor = await resolveSlackActor(subject, lookup as never);
    assertEquals(actor.kind, "service");
    assert(actor.kind === "service" && actor.verifiedHuman === false);
  }
  assertEquals(await resolveSlackActor(subject, boom), {
    kind: "service",
    verifiedHuman: false,
    reason: "lookup_failed",
  });
  assertEquals(await resolveSlackActor(subject, undefined as never), {
    kind: "service",
    verifiedHuman: false,
    reason: "lookup_failed",
  });
});

Deno.test("a service identity can never be made to look like a human", async () => {
  const actor = await resolveSlackActor(
    subject,
    () => Promise.resolve(undefined),
  );
  assertEquals(actor.kind === "service" && actor.verifiedHuman, false);
  // Whatever a caller spreads in, the shape of a refusal has no principal.
  assertEquals(Object.keys(actor).sort(), ["kind", "reason", "verifiedHuman"]);
});

Deno.test("the scope limit is the count and not the shape: exactly the limit is accepted and one more is not", () => {
  // Letters only, because a scope with a digit fails the shape check, which
  // would make the refusal look like a count limit it is not.
  const name = (i: number) =>
    `scope${String.fromCharCode(97 + (i % 26))}${
      String.fromCharCode(97 + Math.floor(i / 26))
    }:read`;
  const list = (count: number) =>
    Array.from({ length: count }, (_, i) => name(i)).join(",");
  const atLimit = classifySlackInstallation(
    install({ scope: list(100) }),
    expectedApp,
  );
  assert(atLimit.ok, "100 well-formed scopes are within the limit");
  assertEquals(atLimit.installation.scopes.length, 100);
  assertEquals(
    classifySlackInstallation(install({ scope: list(101) }), expectedApp),
    { ok: false, reason: "malformed" },
  );
});

Deno.test("a feature that needs several scopes is on only when every one of them was granted", () => {
  const table = { combo: ["alpha:read", "beta:write"], solo: ["gamma"] };
  assertEquals(slackFeaturesFor(["alpha:read"], table), []);
  assertEquals(slackFeaturesFor(["beta:write"], table), []);
  assertEquals(slackFeaturesFor(["alpha:read", "beta:write"], table), [
    "combo",
  ]);
  assertEquals(
    slackFeaturesFor(["alpha:read", "beta:write", "gamma"], table).sort(),
    ["combo", "solo"],
  );
  assertEquals(slackFeaturesFor(["gamma"], table), ["solo"]);
});

Deno.test("a channel whose id is not an id is unavailable even when the selection names that very string", () => {
  for (
    const id of [
      "c0public1",
      "*",
      "C0*",
      "",
      "D0DIRECT01",
      "C0PUBLIC1 ",
      "../x",
    ]
  ) {
    const result = channelCapability(selection([id]), {
      id,
      isPrivate: false,
      botIsMember: true,
    });
    assert(!result.available, `available: ${JSON.stringify(id)}`);
    assertEquals(result.available === false && result.reason, "malformed");
  }
});

Deno.test("a selection that only looks like a set cannot make every channel available", () => {
  const everything = { has: () => true, size: 1 };
  const lookalike = {
    selectedChannelIds: everything,
    privateParticipation: true,
  };
  for (
    const channel of [
      { id: "C0ANYTHING", isPrivate: false, botIsMember: true },
      { id: "G0PRIVATE9", isPrivate: true, botIsMember: true },
    ]
  ) {
    assertEquals(channelCapability(lookalike as never, channel), {
      available: false,
      reason: "malformed",
    });
  }
  // The same holds for an array, which has no has().
  assertEquals(
    channelCapability(
      {
        selectedChannelIds: ["C0PUBLIC1"],
        privateParticipation: false,
      } as never,
      { id: "C0PUBLIC1", isPrivate: false, botIsMember: true },
    ),
    { available: false, reason: "malformed" },
  );
});

// ---- QA round 1 on #148 -----------------------------------------------------
// The scope pattern was written from memory and tested only with scopes of the
// shape it allowed, so it refused a whole installation over a routine scope.
// These are real bot scopes from Slack's reference, in the shapes that matter:
// a dot after the colon, a dot before it, a hyphen, and several of them.

const REAL_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "channels:write.invites",
  "chat:write",
  "chat:write.customize",
  "chat:write.public",
  "commands",
  "files:read",
  "im:history",
  "incoming-webhook",
  "links.embed:write",
  "pins:write",
  "reactions:write",
  "users:read",
  "users:read.email",
  "workflow.steps:execute",
];

Deno.test("every real Slack bot scope shape is accepted, singly and all together", () => {
  for (const scope of REAL_SCOPES) {
    const result = classifySlackInstallation(install({ scope }), expectedApp);
    assert(result.ok, `refused a real scope: ${scope}`);
    assertEquals(result.installation.scopes, [scope]);
  }
  const all = classifySlackInstallation(
    install({ scope: [...REAL_SCOPES].reverse().join(",") }),
    expectedApp,
  );
  assert(all.ok);
  assertEquals(all.installation.scopes, [...REAL_SCOPES].sort());
});

Deno.test("a feature still switches on when its scope arrives alongside the dotted and hyphenated ones", () => {
  const result = classifySlackInstallation(
    install({
      scope: "chat:write,chat:write.public,incoming-webhook,commands",
    }),
    expectedApp,
  );
  assert(result.ok);
  assertEquals(
    slackFeaturesFor(result.installation.scopes).sort(),
    ["progress_posts", "slash_commands"],
  );
  // chat:write.public is a different scope from chat:write: it grants nothing here.
  const only = classifySlackInstallation(
    install({ scope: "chat:write.public" }),
    expectedApp,
  );
  assert(only.ok);
  assertEquals(slackFeaturesFor(only.installation.scopes), []);
});

Deno.test("what is not a scope is still refused: empty parts, case, space, control characters, odd punctuation and non-ASCII", () => {
  const refused = [
    "Chat:write",
    "CHAT:WRITE",
    "chat:Write",
    "chat:write ",
    " chat:write",
    "chat: write",
    "chat write",
    "chat:write\n",
    "\nchat:write",
    "chat:write\r",
    "chat:write\t",
    "chat:write\u0000",
    "chat:write\u0085",
    "chat:write ",
    "chat::write",
    "chat:write:extra",
    "chat:write:public:more",
    ":write",
    "chat:",
    ":",
    ".",
    ".write",
    "chat.",
    "chat..write",
    "chat:.write",
    "chat:write.",
    "chat:write..public",
    "chat.:write",
    "-chat",
    "_chat",
    "9chat",
    "chat:-write",
    "chat/write",
    "chat*",
    "chat:*",
    "*",
    "chat;write",
    "chat'write",
    'chat"write',
    "chat\\write",
    "chat:write=public",
    "chat:wrïte",
    "chät:write",
    "ｃhat:write",
    "chat:write​",
    "chat‮:write",
  ];
  for (const scope of refused) {
    const result = classifySlackInstallation(
      install({ scope: `commands,${scope}` }),
      expectedApp,
    );
    assert(!result.ok, `accepted ${JSON.stringify(scope)}`);
    assertEquals(result.reason, "malformed", JSON.stringify(scope));
  }
  // An empty scope between commas, and a response with no scopes at all.
  for (const scope of ["commands,,chat:write", ",", "commands,"]) {
    assertEquals(
      classifySlackInstallation(install({ scope }), expectedApp),
      { ok: false, reason: "malformed" },
      JSON.stringify(scope),
    );
  }
  const none = classifySlackInstallation(install({ scope: "" }), expectedApp);
  assert(none.ok);
  assertEquals(none.installation.scopes, []);
});

Deno.test("a scope has a length limit, and an enormous scope string is refused before it is split or matched", () => {
  const name = (length: number) => `a${"b".repeat(length - 1)}`;
  assert(
    classifySlackInstallation(install({ scope: name(128) }), expectedApp).ok,
  );
  assertEquals(
    classifySlackInstallation(install({ scope: name(129) }), expectedApp),
    { ok: false, reason: "malformed" },
  );
  // Shapes a backtracking pattern could be tortured with, at a size that would
  // take a naive implementation a long time: they are refused by length first.
  const started = performance.now();
  for (
    const scope of [
      "a".repeat(5_000_000),
      `${"a.".repeat(2_000_000)}!`,
      `${"a-".repeat(2_000_000)}:`,
      `${"a:".repeat(2_000_000)}`,
      ",".repeat(5_000_000),
    ]
  ) {
    assertEquals(
      classifySlackInstallation(install({ scope }), expectedApp),
      { ok: false, reason: "malformed" },
    );
  }
  const elapsed = performance.now() - started;
  assert(elapsed < 1000, `five huge scope strings took ${elapsed} ms`);
  // A near-limit scope made of many short parts is matched in linear time.
  const dotted = Array.from({ length: 64 }, () => "a").join(".");
  const nearly = `${dotted}:${dotted}`.slice(0, 128);
  const once = performance.now();
  classifySlackInstallation(install({ scope: `${nearly}!` }), expectedApp);
  assert(performance.now() - once < 50, "a 128-character near miss is cheap");
});

Deno.test("the total size of the scope string is bounded by the count and the length together", () => {
  const scope = (count: number, length: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `${String.fromCharCode(97 + (i % 26))}${
          String.fromCharCode(97 + Math.floor(i / 26))
        }${"x".repeat(length - 2)}`,
    ).join(",");
  const atLimit = classifySlackInstallation(
    install({ scope: scope(100, 128) }),
    expectedApp,
  );
  assert(atLimit.ok, "100 scopes of 128 characters are the largest accepted");
  assertEquals(atLimit.installation.scopes.length, 100);
  assertEquals(
    classifySlackInstallation(install({ scope: scope(101, 128) }), expectedApp),
    { ok: false, reason: "malformed" },
  );
});

Deno.test("digits are allowed after the first character of a part, and nowhere else is case allowed", () => {
  for (
    const scope of [
      "a1",
      "chat2:write",
      "chat:write2",
      "a-1",
      "x1.y2:z3.w4",
      "app2_v3:read-9",
    ]
  ) {
    const result = classifySlackInstallation(install({ scope }), expectedApp);
    assert(result.ok, `refused a scope with digits: ${scope}`);
    assertEquals(result.installation.scopes, [scope]);
  }
  // Upper case anywhere is refused, not only at the start of the scope: each
  // position class (first letter, rest of a part, after a dot, after the colon).
  for (
    const scope of [
      "cHat:write",
      "chaT:write",
      "chat:wRite",
      "chat:writE",
      "chat:write.pUblic",
      "chat:write.publiC",
      "chat.Embed:write",
      "chat.embeD:write",
      "incoming-Webhook",
      "incoming-webhooK",
      "a_B",
      "a1B",
    ]
  ) {
    const result = classifySlackInstallation(install({ scope }), expectedApp);
    assert(!result.ok, `accepted upper case: ${scope}`);
    assertEquals(result.reason, "malformed", scope);
  }
});

Deno.test("a scope string over the size limit is refused without being split or matched", () => {
  const realSplit = String.prototype.split;
  const splitLengths: number[] = [];
  String.prototype.split = function (this: string, ...args: unknown[]) {
    splitLengths.push(String(this).length);
    return (realSplit as (...a: unknown[]) => string[]).apply(this, args);
  } as typeof String.prototype.split;
  try {
    // The size limit is 100 scopes of 128 characters and their commas: 12,900.
    const huge = "a".repeat(13_000);
    assertEquals(
      classifySlackInstallation(install({ scope: huge }), expectedApp),
      { ok: false, reason: "malformed" },
    );
    assertEquals(
      classifySlackInstallation(
        install({ scope: ",".repeat(5_000_000) }),
        expectedApp,
      ),
      { ok: false, reason: "malformed" },
    );
    const bigSplits = splitLengths.filter((length) => length > 12_900);
    assertEquals(
      bigSplits,
      [],
      "a string over the limit must never reach split",
    );
    // A string at the limit is split: this proves the instrument sees the call.
    const before = splitLengths.length;
    classifySlackInstallation(
      install({ scope: "chat:write,commands" }),
      expectedApp,
    );
    assert(
      splitLengths.length > before,
      "the spy did not see a split it should have",
    );
  } finally {
    String.prototype.split = realSplit;
  }
});

Deno.test("the app id travels to the lookup when the subject names one, and a malformed one never reaches it", async () => {
  const seen: unknown[] = [];
  const spy = (key: unknown) => {
    seen.push(key);
    return Promise.resolve(undefined);
  };
  await resolveSlackActor({ ...subject, appId: "A0APP123" }, spy);
  await resolveSlackActor(
    { ...subject, appId: "A0APP123", enterpriseId: "E0ENT1234" },
    spy,
  );
  assertEquals(seen, [
    { teamId: "T0ABC123", userId: "U0USER123", appId: "A0APP123" },
    {
      teamId: "T0ABC123",
      userId: "U0USER123",
      enterpriseId: "E0ENT1234",
      appId: "A0APP123",
    },
  ]);
  seen.length = 0;
  for (
    const appId of ["a0app123", "", "app", "A", "A0APP123\n", 5, null, [
      "A0APP123",
    ]]
  ) {
    const actor = await resolveSlackActor({ ...subject, appId } as never, spy);
    assertEquals(
      actor,
      { kind: "service", verifiedHuman: false, reason: "malformed" },
      JSON.stringify(appId),
    );
  }
  assertEquals(seen, [], "a malformed app id never reaches the lookup");
});

Deno.test("a Slack Enterprise Grid organization id is E followed by 2 to 31 capitals or digits, as a plain string, and nothing else", () => {
  for (const good of ["E0ENT1234", "EABC", `E${"A".repeat(31)}`, "E12"]) {
    assert(isSlackEnterpriseId(good), good);
  }
  for (
    const bad of [
      "e0ent1234",
      "E",
      "E1",
      `E${"A".repeat(32)}`,
      "T0ABC123",
      "E0ENT1234\n",
      " E0ENT1234",
      "E0ENT-1234",
      "",
      5,
      null,
      undefined,
      ["E0ENT1234"],
      { toString: () => "E0ENT1234" },
    ]
  ) {
    assertEquals(isSlackEnterpriseId(bad), false, JSON.stringify(bad));
  }
});
