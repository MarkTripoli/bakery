import { assert, assertEquals } from "@std/assert";
import {
  receiveSlackEvent,
  type SlackIntakeDependencies,
  type SlackIntakeResult,
} from "../../apps/server/src/modules/integrations/slack-intake.ts";
import type {
  CommitSlackReceiptResult,
  SlackInstallationRecord,
} from "../../apps/server/src/modules/integrations/slack-receipts.ts";
import { sha256Hex } from "../../apps/server/src/modules/integrations/intake-signature.ts";

const NOW_MS = 1_800_000_000_000;
const encoder = new TextEncoder();
const installation: SlackInstallationRecord = {
  installationId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  appId: "A0APP",
  teamId: "T0TEAM",
  botUserId: "U0BOT",
  signingSecretId: null,
  status: "active",
};

async function sign(
  timestamp: string,
  body: string,
  secret: Uint8Array<ArrayBuffer>,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`v0:${timestamp}:${body}`),
    ),
  );
  return `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type Harness = {
  readonly deps: SlackIntakeDependencies;
  readonly commits: Parameters<SlackIntakeDependencies["commit"]>[0][];
  readonly secrets: Uint8Array<ArrayBuffer>[];
  readonly peeked: (string | null)[];
};

function harness(
  options: {
    installed?: boolean;
    commitResult?: CommitSlackReceiptResult;
    commitThrows?: boolean;
  } = {},
): Harness {
  const commits: Harness["commits"] = [];
  const secrets: Uint8Array<ArrayBuffer>[] = [];
  const peeked: (string | null)[] = [];
  return {
    commits,
    secrets,
    peeked,
    deps: {
      signingSecrets: (appId) => {
        peeked.push(appId);
        const secret = encoder.encode("signing-secret");
        secrets.push(secret);
        return Promise.resolve([secret]);
      },
      findInstallation: (appId, teamId) =>
        Promise.resolve(
          options.installed === false || appId !== installation.appId ||
            teamId !== installation.teamId
            ? null
            : installation,
        ),
      commit: (input) => {
        if (options.commitThrows) return Promise.reject(new Error("db down"));
        commits.push(input);
        return Promise.resolve(
          options.commitResult ?? { kind: "recorded", receiptId: "rcpt-1" },
        );
      },
      sha256Hex,
      now: () => NOW_MS,
    },
  };
}

async function deliver(
  deps: SlackIntakeDependencies,
  body: unknown,
  overrides: { signature?: string | null; timestamp?: string | null } = {},
): Promise<SlackIntakeResult> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(NOW_MS / 1000));
  return await receiveSlackEvent({
    raw: encoder.encode(text),
    signatureHeader: "signature" in overrides
      ? overrides.signature!
      : await sign(timestamp, text, encoder.encode("signing-secret")),
    timestampHeader: "timestamp" in overrides
      ? overrides.timestamp!
      : timestamp,
  }, deps);
}

const mention = (extra: Record<string, unknown> = {}) => ({
  type: "event_callback",
  event_id: "Ev1",
  api_app_id: installation.appId,
  team_id: installation.teamId,
  authorizations: [{
    team_id: installation.teamId,
    user_id: installation.botUserId,
  }],
  event: {
    type: "app_mention",
    channel: "C1",
    user: "U1",
    ts: "1.1",
    text: "hi",
  },
  ...extra,
});

Deno.test("the handshake answers its challenge and commits nothing", async () => {
  const h = harness();
  const result = await deliver(h.deps, {
    type: "url_verification",
    challenge: "abc",
  });
  assertEquals(result, { kind: "challenge", challenge: "abc" });
  assertEquals(h.commits.length, 0);
  assertEquals(h.peeked, [null]);
});

Deno.test("an unsigned, badly signed or stale delivery is one AUTH_INVALID and touches nothing", async () => {
  const h = harness();
  const body = mention();
  const refusedAuth: SlackIntakeResult = {
    kind: "refused",
    code: "AUTH_INVALID",
  };
  assertEquals(await deliver(h.deps, body, { signature: null }), refusedAuth);
  assertEquals(
    await deliver(h.deps, body, { signature: "v0=" + "0".repeat(64) }),
    refusedAuth,
  );
  assertEquals(await deliver(h.deps, body, { timestamp: "1" }), refusedAuth);
  assertEquals(h.commits.length, 0);
});

Deno.test("the body is read as an event only after it verifies", async () => {
  const h = harness();
  assertEquals(await deliver(h.deps, "not json"), {
    kind: "refused",
    code: "MALFORMED_REQUEST",
  });
  assertEquals(await deliver(h.deps, "not json", { signature: null }), {
    kind: "refused",
    code: "AUTH_INVALID",
  });
});

Deno.test("a verified event for a workspace nobody installed is refused like a bad signature", async () => {
  const h = harness({ installed: false });
  assertEquals(await deliver(h.deps, mention()), {
    kind: "refused",
    code: "AUTH_INVALID",
  });
  assertEquals(h.commits.length, 0);
});

Deno.test("a mention commits its receipt, then is acknowledged as accepted", async () => {
  const h = harness();
  const result = await deliver(h.deps, mention());
  assertEquals(result, {
    kind: "acknowledged",
    disposition: "accepted",
    receiptId: "rcpt-1",
  });
  assertEquals(h.commits.length, 1);
  assertEquals(h.commits[0]!.eventId, "Ev1");
  assertEquals(h.commits[0]!.decision.kind, "mention");
  assertEquals(h.commits[0]!.payloadDigest.length, 64);
});

Deno.test("an ignored event commits a receipt carrying no text, and is rejected, not accepted", async () => {
  const h = harness();
  const echo = mention({
    event: {
      type: "message",
      thread_ts: "1.0",
      channel: "C1",
      user: "U9",
      ts: "2.0",
      text: "secret",
      bot_id: "B1",
    },
  });
  const result = await deliver(h.deps, echo);
  assertEquals(result, {
    kind: "acknowledged",
    disposition: "rejected",
    receiptId: "rcpt-1",
  });
  const decision = h.commits[0]!.decision;
  assertEquals(decision.kind, "ignore");
  assert(!JSON.stringify(h.commits[0]).includes("secret"));
});

Deno.test("a retry is a duplicate, and the same id with other bytes is a payload mismatch", async () => {
  const again = harness({
    commitResult: {
      kind: "duplicate",
      receiptId: "rcpt-0",
      outcome: "accepted",
    },
  });
  assertEquals(await deliver(again.deps, mention()), {
    kind: "acknowledged",
    disposition: "duplicate",
    receiptId: "rcpt-0",
  });
  const changed = harness({ commitResult: { kind: "conflict" } });
  assertEquals(await deliver(changed.deps, mention()), {
    kind: "refused",
    code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
  });
});

Deno.test("a database failure is thrown, never answered as queued", async () => {
  const h = harness({ commitThrows: true });
  let thrown: unknown;
  try {
    await deliver(h.deps, mention());
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error && thrown.message === "db down");
});

Deno.test("every signing secret handed over is zeroed afterwards", async () => {
  const h = harness();
  await deliver(h.deps, mention());
  await deliver(h.deps, mention(), { signature: null });
  assert(h.secrets.length === 2);
  for (const secret of h.secrets) assert(secret.every((byte) => byte === 0));
});

Deno.test("raw bytes verify before any body field can select authority", async () => {
  const h = harness();
  await deliver(h.deps, mention());
  await deliver(h.deps, "[1,2]");
  assertEquals(h.peeked, [null, null]);
});
