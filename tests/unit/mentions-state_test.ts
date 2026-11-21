import { assertEquals } from "@std/assert";
import {
  addMention,
  appendLine,
  insertMention,
  markGainsAccess,
  markNeedsSharer,
  type Mention,
  nameParts,
  needsSharer,
  offered,
  reconcile,
  refusalsOf,
  refusedPeople,
  rowKind,
  triggerAt,
  withoutAtSign,
  withoutMention,
} from "../../apps/web/src/mentions/mentions-state.ts";

const sam: Mention = {
  principalId: "p1",
  name: "Sam Patel",
  gainsAccess: true,
  needsSharer: false,
};
const ana: Mention = {
  principalId: "p2",
  name: "Ana Ruiz",
  gainsAccess: false,
  needsSharer: false,
};

Deno.test("the picker opens on an @ at the start or after a space, never inside a word", () => {
  assertEquals(triggerAt("@sa", 3), { start: 0, query: "sa" });
  assertEquals(triggerAt("hi @sa", 6), { start: 3, query: "sa" });
  assertEquals(triggerAt("hi\n@", 4), { start: 3, query: "" });
  assertEquals(triggerAt("mail me at a@b.com", 18), null);
  assertEquals(triggerAt("hi @sam ", 8), null);
  assertEquals(triggerAt("no at sign", 4), null);
});

Deno.test("choosing a person writes @Name and a space, and the caret follows it", () => {
  const trigger = triggerAt("Thanks @sa", 10)!;
  assertEquals(insertMention("Thanks @sa", trigger, 10, "Sam Patel"), {
    text: "Thanks @Sam Patel ",
    caret: 18,
  });
  // text after the caret is kept, with one space between
  const mid = triggerAt("Hi @sa, bye", 6)!;
  assertEquals(
    insertMention("Hi @sa, bye", mid, 6, "Sam Patel").text,
    "Hi @Sam Patel , bye",
  );
});

Deno.test("editing the inserted name removes its chip, and a hand-typed @name has none", () => {
  assertEquals(reconcile("Hi @Sam Patel and @Ana Ruiz", [sam, ana]), [
    sam,
    ana,
  ]);
  assertEquals(reconcile("Hi @Sam Pate", [sam, ana]), []);
  assertEquals(reconcile("Hi @Sam Patelson", [sam]), []);
  assertEquals(reconcile("Hi Sam Patel", [sam]), []);
  assertEquals(reconcile("a@Sam Patel", [sam]), []);
});

Deno.test("removing a chip takes the @ off the name in the text", () => {
  assertEquals(withoutMention("Hi @Sam Patel thanks", sam), "Hi thanks");
  assertEquals(withoutMention("Hi @Sam Patel", sam), "Hi ");
  assertEquals(withoutMention("nothing", sam), "nothing");
});

Deno.test("the same person is one chip, and chosen people are not offered again", () => {
  assertEquals(addMention([sam], sam), [sam]);
  assertEquals(addMention([sam], ana), [sam, ana]);
  const rows = [
    {
      principalId: "p1",
      displayName: "Sam Patel",
      hasAccess: true,
      gainsAccessOnSend: false,
    },
    {
      principalId: "p3",
      displayName: "Lee",
      hasAccess: true,
      gainsAccessOnSend: false,
    },
  ];
  assertEquals(offered(rows, [sam]).map((row) => row.principalId), ["p3"]);
});

Deno.test("a conversation row is ordinary or no access yet; a comment never gives access", () => {
  const has = { hasAccess: true, gainsAccessOnSend: false };
  const gains = { hasAccess: false, gainsAccessOnSend: true };
  const none = { hasAccess: false, gainsAccessOnSend: false };
  assertEquals(rowKind(has, "conversation"), "ready");
  assertEquals(rowKind(gains, "conversation"), "gains");
  // Anyone without access can be chosen; whether the writer may share decides what sending does.
  assertEquals(rowKind(none, "conversation"), "gains");
  assertEquals(rowKind(has, "comment"), "ready");
  assertEquals(rowKind(gains, "comment"), "blocked");
  assertEquals(rowKind(none, "comment"), "blocked");
});

Deno.test("only a conversation person without access and without the writer's right to share needs a sharer", () => {
  const has = { hasAccess: true, gainsAccessOnSend: false };
  const gains = { hasAccess: false, gainsAccessOnSend: true };
  const none = { hasAccess: false, gainsAccessOnSend: false };
  assertEquals(needsSharer(none, "conversation"), true);
  assertEquals(needsSharer(gains, "conversation"), false);
  assertEquals(needsSharer(has, "conversation"), false);
  assertEquals(needsSharer(none, "comment"), false);
});

Deno.test("a refusal that says the writer may not share marks only the refused people", () => {
  const marked = markNeedsSharer([sam, ana], new Set(["p1"]));
  assertEquals(marked[0], { ...sam, gainsAccess: false, needsSharer: true });
  assertEquals(marked[1], ana);
});

Deno.test("an Ask line goes on its own line at the end and says where it stands", () => {
  assertEquals(appendLine("", "@Dana can you?"), {
    text: "@Dana can you?",
    start: 0,
    end: 14,
  });
  assertEquals(appendLine("Hi Ana", "@Dana can you?"), {
    text: "Hi Ana\n@Dana can you?",
    start: 7,
    end: 21,
  });
  assertEquals(appendLine("Hi\n", "x").start, 3);
});

Deno.test("name parts give the count, the first two and the rest", () => {
  assertEquals(nameParts([]), { count: 0, first: "", second: "", rest: 0 });
  assertEquals(nameParts(["A"]), { count: 1, first: "A", second: "", rest: 0 });
  assertEquals(nameParts(["A", "B", "C", "D"]), {
    count: 4,
    first: "A",
    second: "B",
    rest: 2,
  });
});

Deno.test("a refusal names the mentions by place and code, and other failures name none", () => {
  const failure = {
    kind: "problem" as const,
    problem: {
      issues: [
        { path: "/mentions/1", message: "mention share forbidden" },
        { path: "/mentions/0", message: "mention not member" },
        { path: "/body", message: "too long" },
      ],
    },
  };
  // deno-lint-ignore no-explicit-any
  const refusals = refusalsOf(failure as any);
  assertEquals(refusals, [
    { index: 1, code: "share_forbidden" },
    { index: 0, code: "not_member" },
  ]);
  assertEquals(
    refusedPeople([sam, ana], refusals).map((
      entry,
    ) => [entry.mention.name, entry.code]),
    [["Ana Ruiz", "share_forbidden"], ["Sam Patel", "not_member"]],
  );
  assertEquals(refusalsOf({ kind: "network" }), []);
});

Deno.test("removing a chip cuts its own word, not the start of a longer name", () => {
  const sam: Mention = {
    principalId: "p2",
    name: "Sam",
    gainsAccess: false,
    needsSharer: false,
  };
  assertEquals(
    withoutMention("Hi @Samir and @Sam ok", sam),
    "Hi @Samir and ok",
  );
  assertEquals(withoutMention("@Sam", sam), "");
  assertEquals(withoutMention("Hi @Samir", sam), "Hi @Samir");
  const patel: Mention = {
    principalId: "p3",
    name: "Sam Patel",
    gainsAccess: false,
    needsSharer: false,
  };
  assertEquals(
    withoutMention("@Sam Patelson, @Sam Patel!", patel),
    "@Sam Patelson, !",
  );
});

Deno.test("not mentioning someone keeps the name as words and drops only the @", () => {
  const sam: Mention = {
    principalId: "p2",
    name: "Sam",
    gainsAccess: true,
    needsSharer: false,
  };
  assertEquals(withoutAtSign("Hi @Sam ok", sam), "Hi Sam ok");
  assertEquals(withoutAtSign("Hi @Samir and @Sam", sam), "Hi @Samir and Sam");
  assertEquals(withoutAtSign("no mention", sam), "no mention");
});

Deno.test("a refusal that says a person has no access after all makes the offer come back for them only", () => {
  const marked = markGainsAccess([sam, ana], new Set(["p2"]));
  assertEquals(marked[0], sam);
  assertEquals(marked[1], { ...ana, gainsAccess: true, needsSharer: false });
});
