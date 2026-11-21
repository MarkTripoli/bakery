import { assert, assertEquals, assertRejects } from "@std/assert";
import { githubIntegration } from "../../apps/server/src/modules/catalog/integration-providers/github.ts";

/**
 * Issue 32 (AC1): a lost response to an issue creation is settled by reading,
 * never by posting again, and Bakery's own labels are added and removed one at
 * a time, so a person's labels are never replaced.
 */

type Handler = {
  input: { safeParse(value: unknown): { success: boolean } };
  execute(ctx: unknown, input: unknown): Promise<unknown>;
  reconcile(ctx: unknown): Promise<unknown>;
};
const handlers = githubIntegration.handlers as Record<string, Handler>;
const create = handlers["github.issue.create@1"];
const add = handlers["github.issue.labels.add@1"];
const remove = handlers["github.issue.label.remove@1"];

const EFFECT = "11111111-1111-4111-8111-111111111111";
const MARKER = `<!-- bakery-effect:${EFFECT} -->`;
const BOT = 4242;

type Call = { id: string; input: Record<string, unknown> };

function provider(
  answer: (call: Call) => unknown | Promise<unknown>,
  calls: Call[] = [],
) {
  return {
    calls,
    request(ref: { id: string }, input: Record<string, unknown>) {
      const call = { id: ref.id, input };
      calls.push(call);
      return Promise.resolve().then(() => answer(call));
    },
  };
}

const bot = { id: BOT, type: "Bot" };
const issue = (
  number: number,
  body: string | null,
  user: { id: number; type: string } | null = bot,
) => ({ id: 9_000 + number, number, body, user });

/** Pages of issues, newest first; every page but the last must be full. */
function listing(pages: ReturnType<typeof issue>[][]) {
  return provider((call) => pages[Number(call.input.page) - 1] ?? []);
}

const reconcileCtx = (
  p: ReturnType<typeof provider>,
  botUserId: unknown = BOT,
) => ({
  effect: { id: EFFECT },
  resource: { botUserId },
  input: { title: "t", body: "b" },
  provider: p,
});

Deno.test("a created issue carries the effect marker and answers its number and id", async () => {
  const p = provider(() => issue(7, "x"));
  const result = await create.execute(
    { effect: { id: EFFECT }, provider: p },
    { title: "Fix it", body: "Details", labels: ["bakery:owned"] },
  );
  assertEquals(result, { remoteId: "7", issueId: "9007" });
  assertEquals(p.calls, [{
    id: "github.issue.create",
    input: {
      title: "Fix it",
      body: `Details\n\n${MARKER}`,
      labels: ["bakery:owned"],
    },
  }]);
});

Deno.test("an issue with no labels sends none", async () => {
  const p = provider(() => issue(8, "x"));
  await create.execute({ effect: { id: EFFECT }, provider: p }, {
    title: "T",
    body: "B",
  });
  assertEquals("labels" in p.calls[0].input, false);
});

Deno.test("the creation input refuses a reserved marker, an empty title and more than 20 labels", () => {
  const ok = { title: "T", body: "B" };
  assert(create.input.safeParse(ok).success);
  assertEquals(
    create.input.safeParse({ ...ok, body: "<!-- bakery-effect: x -->" })
      .success,
    false,
  );
  assertEquals(create.input.safeParse({ ...ok, title: "" }).success, false);
  assertEquals(
    create.input.safeParse({
      ...ok,
      labels: Array.from({ length: 21 }, (_, i) => `l${i}`),
    }).success,
    false,
  );
});

Deno.test("a lost creation is confirmed when exactly one issue by the bot carries the marker", async () => {
  const p = listing([[
    issue(12, "other"),
    issue(11, `Details\n\n${MARKER}`),
    issue(10, null),
  ]]);
  assertEquals(await create.reconcile(reconcileCtx(p)), {
    status: "confirmed",
    result: { remoteId: "11", issueId: "9011" },
  });
  // It only read: the listing is the one request, and it asks for every state.
  assertEquals(p.calls.map((c) => c.id), ["github.issues.list"]);
  assertEquals(p.calls[0].input.state, "all");
});

Deno.test("a lost creation stays uncertain when nothing proves it never happened", async () => {
  const uncertain = { status: "uncertain" };
  // No issue carries the marker: absence alone never authorizes another POST.
  assertEquals(
    await create.reconcile(reconcileCtx(listing([[issue(1, "x")]]))),
    uncertain,
  );
  // A person pasted the marker: not authored by the installation's bot.
  assertEquals(
    await create.reconcile(
      reconcileCtx(listing([[issue(2, MARKER, { id: 7, type: "User" })]])),
    ),
    uncertain,
  );
  // A bot, but not this installation's bot.
  assertEquals(
    await create.reconcile(
      reconcileCtx(listing([[issue(3, MARKER, { id: 8, type: "Bot" })]])),
    ),
    uncertain,
  );
  // The author is unknown.
  assertEquals(
    await create.reconcile(reconcileCtx(listing([[issue(4, MARKER, null)]]))),
    uncertain,
  );
  // Two issues carry it: never pick one.
  assertEquals(
    await create.reconcile(
      reconcileCtx(listing([[issue(6, MARKER), issue(5, MARKER)]])),
    ),
    uncertain,
  );
  // The bot's identity is not known to the host.
  assertEquals(
    await create.reconcile({
      ...reconcileCtx(listing([[issue(9, MARKER)]])),
      resource: {},
    }),
    uncertain,
  );
  // The marker must be a whole line, not a substring of someone's text.
  assertEquals(
    await create.reconcile(
      reconcileCtx(listing([[issue(13, `quoted: ${MARKER} here`)]])),
    ),
    uncertain,
  );
});

Deno.test("a truncated listing never proves a creation absent or present twice", async () => {
  const full = Array.from({ length: 100 }, (_, i) => issue(i + 100, "x"));
  const p = listing(Array.from({ length: 20 }, () => full));
  assertEquals(await create.reconcile(reconcileCtx(p)), {
    status: "uncertain",
  });
  assertEquals(p.calls.length, 20, "it stops at the scan limit");
});

Deno.test("adding labels names only the labels to add and answers the labels now on the issue", async () => {
  const p = provider(() => [{ name: "mine" }, { name: "bakery:owned" }]);
  const result = await add.execute({ provider: p }, {
    issueNumber: 5,
    labels: ["bakery:owned"],
  });
  assertEquals(result, { labels: ["mine", "bakery:owned"] });
  assertEquals(p.calls, [{
    id: "github.issue.labels.add",
    input: { issue_number: 5, labels: ["bakery:owned"] },
  }]);
  assertEquals(
    add.input.safeParse({ issueNumber: 5, labels: [] }).success,
    false,
    "an empty list would add nothing",
  );
});

Deno.test("removing a label asks for that one label and keeps the others", async () => {
  const p = provider(() => [{ name: "mine" }]);
  assertEquals(
    await remove.execute({ provider: p }, {
      issueNumber: 5,
      label: "bakery:owned",
    }),
    { labels: ["mine"] },
  );
  assertEquals(p.calls, [{
    id: "github.issue.label.remove",
    input: { issue_number: 5, name: "bakery:owned" },
  }]);
});

Deno.test("removing a label the issue does not carry is a repeat, not a failure", async () => {
  const p = provider((call) => {
    if (call.id === "github.issue.label.remove") {
      throw new Error("provider request failed");
    }
    return [{ name: "mine" }];
  });
  assertEquals(
    await remove.execute({ provider: p }, { issueNumber: 5, label: "gone" }),
    { labels: ["mine"] },
  );
});

Deno.test("a refused removal of a label that is still there keeps the refusal", async () => {
  const p = provider((call) => {
    if (call.id === "github.issue.label.remove") {
      throw new Error("provider request failed");
    }
    return [{ name: "mine" }, { name: "stuck" }];
  });
  await assertRejects(
    () => remove.execute({ provider: p }, { issueNumber: 5, label: "stuck" }),
    Error,
    "provider request failed",
  );
});

Deno.test("a full page of labels never proves a label absent", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` }));
  const p = provider((call) => {
    if (call.id === "github.issue.label.remove") {
      throw new Error("provider request failed");
    }
    return full;
  });
  await assertRejects(() =>
    remove.execute({ provider: p }, { issueNumber: 5, label: "elsewhere" })
  );
});

const labelPage = (...names: string[]) => names.map((name) => ({ name }));

function labelReconcileCtx(
  names: string[],
  input: Record<string, unknown>,
) {
  return {
    effect: { id: EFFECT },
    resource: {},
    input,
    provider: provider(() => labelPage(...names)),
  };
}

Deno.test("a lost label addition is confirmed only when every requested label is on the issue", async () => {
  const input = { issueNumber: 5, labels: ["bakery:owned", "bakery:review"] };
  assertEquals(
    await add.reconcile(
      labelReconcileCtx(["mine", "bakery:owned", "bakery:review"], input),
    ),
    {
      status: "confirmed",
      result: { labels: ["mine", "bakery:owned", "bakery:review"] },
    },
  );
  // One missing label proves nothing: the write may never have landed.
  assertEquals(
    await add.reconcile(labelReconcileCtx(["mine", "bakery:owned"], input)),
    { status: "uncertain" },
  );
  // A full page may hide the label on the next page.
  const full = Array.from({ length: 100 }, (_, i) => `l${i}`);
  assertEquals(
    await add.reconcile(
      labelReconcileCtx(full, { issueNumber: 5, labels: ["l1"] }),
    ),
    { status: "uncertain" },
  );
});

Deno.test("a lost label removal is confirmed only when the label is gone from the issue", async () => {
  const input = { issueNumber: 5, label: "bakery:owned" };
  assertEquals(await remove.reconcile(labelReconcileCtx(["mine"], input)), {
    status: "confirmed",
    result: { labels: ["mine"] },
  });
  assertEquals(
    await remove.reconcile(labelReconcileCtx(["mine", "bakery:owned"], input)),
    { status: "uncertain" },
  );
  const full = Array.from({ length: 100 }, (_, i) => `l${i}`);
  assertEquals(await remove.reconcile(labelReconcileCtx(full, input)), {
    status: "uncertain",
  });
});

Deno.test("a label name with an unpaired surrogate is refused by every action input, a well-formed astral character is not", () => {
  for (const bad of ["\ud800", "a\udc00b", "x\ud83d"]) {
    const shown = JSON.stringify(bad);
    assertEquals(
      add.input.safeParse({ issueNumber: 5, labels: [bad] }).success,
      false,
      `add ${shown}`,
    );
    assertEquals(
      remove.input.safeParse({ issueNumber: 5, label: bad }).success,
      false,
      `remove ${shown}`,
    );
    assertEquals(
      create.input.safeParse({ title: "T", body: "B", labels: [bad] }).success,
      false,
      `create ${shown}`,
    );
  }
  assert(
    add.input.safeParse({ issueNumber: 5, labels: ["\u{1F680} launch"] })
      .success,
  );
});
