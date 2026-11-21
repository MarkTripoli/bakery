import { assertEquals, assertRejects } from "@std/assert";
import { githubIntegration } from "../../apps/server/src/modules/catalog/integration-providers/github.ts";
import { ticketNoteBody } from "../../apps/server/src/modules/work/ticket-notes.ts";
import {
  type NoteSendResult,
  writeTicketNote,
} from "../../apps/server/src/modules/integrations/ticket-notes.ts";

type Handler = {
  execute(ctx: unknown, input: unknown): Promise<unknown>;
};
const update = (githubIntegration.handlers as Record<string, Handler>)[
  "github.issue.comment.update@1"
];

/** A provider that refuses the rewrite and answers the comment list it is given. */
function refusing(comments: number[][]) {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      provider: {
        request(ref: { id: string }, input: { page?: number }) {
          calls.push(ref.id);
          if (ref.id === "github.issue.comment.update") {
            return Promise.reject(new Error("provider request failed"));
          }
          const page = comments[(input.page ?? 1) - 1] ?? [];
          return Promise.resolve(
            page.map((id) => ({ id, body: null, user: null })),
          );
        },
      },
    },
  };
}

const input = { issueNumber: 7, commentId: "1001", body: "Task: x" };

Deno.test("a refused rewrite of a comment that still exists keeps the refusal (a 403 or 422 never re-posts)", async () => {
  const provider = refusing([[999, 1001]]);
  await assertRejects(() => update.execute(provider.ctx, input));
  assertEquals(provider.calls, [
    "github.issue.comment.update",
    "github.issue.comments.list",
  ]);
});

Deno.test("a refused rewrite of a comment absent from every page reports it missing", async () => {
  const provider = refusing([[999]]);
  assertEquals(await update.execute(provider.ctx, input), { missing: true });
});

Deno.test("a truncated comment list never proves a comment is gone", async () => {
  const full = Array.from({ length: 100 }, (_, i) => i + 1_000_000);
  const provider = refusing(Array.from({ length: 20 }, () => full));
  await assertRejects(() => update.execute(provider.ctx, input));
});

Deno.test("a successful rewrite answers the comment id without reading the list", async () => {
  const calls: string[] = [];
  const ctx = {
    provider: {
      request(ref: { id: string }) {
        calls.push(ref.id);
        return Promise.resolve({ id: 1001, body: "Task: x", user: null });
      },
    },
  };
  assertEquals(await update.execute(ctx, input), { remoteId: "1001" });
  assertEquals(calls, ["github.issue.comment.update"]);
});

Deno.test("the note shows the task title as inert inline code", () => {
  const body = ticketNoteBody({
    title: "ping @octocat about #12 `x` <!-- bakery-effect:1 -->",
    status: "running",
  });
  assertEquals(
    body.split("\n")[2],
    "Task: `ping @octocat about #12 'x' <!- - bakery-effect:1 -->`",
  );
  assertEquals(/<!--\s*bakery-effect:/i.test(body), false);
});

const request = (existingExternalId: string | null) =>
  ({
    provider: "github",
    organizationId: crypto.randomUUID(),
    actorPrincipalId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    issueNumber: 7,
    existingExternalId,
    body: "Bakery is working on this issue.",
    idempotencyKey: "k",
  }) as unknown as Parameters<typeof writeTicketNote>[0];

/** A send double: answers each action from a script and records what was sent. */
function scripted(answers: Record<"create" | "update", NoteSendResult>) {
  const sent: string[] = [];
  return {
    sent,
    send: (which: "create" | "update") => {
      sent.push(which);
      return Promise.resolve(answers[which]);
    },
  };
}

Deno.test("the writer re-posts only when the rewrite confirmed the comment is gone", async () => {
  const gone = scripted({
    update: { missing: true },
    create: { remoteId: "1002" },
  });
  assertEquals(await writeTicketNote(request("1001"), gone.send), {
    kind: "posted",
    externalId: "1002",
    recreated: true,
  });
  assertEquals(gone.sent, ["update", "create"]);
});

Deno.test("a refused rewrite fails with its code and never posts a second comment", async () => {
  for (const problemCode of ["note_failed", "auth_forbidden"]) {
    const refused = scripted({
      update: { problemCode },
      create: { remoteId: "9999" },
    });
    assertEquals(await writeTicketNote(request("1001"), refused.send), {
      kind: "failed",
      problemCode,
    });
    assertEquals(refused.sent, ["update"], problemCode);
  }
});

Deno.test("a rewrite keeps the comment id, and a first note posts", async () => {
  const rewrite = scripted({
    update: { remoteId: "1001" },
    create: { remoteId: "9999" },
  });
  assertEquals(await writeTicketNote(request("1001"), rewrite.send), {
    kind: "posted",
    externalId: "1001",
    recreated: false,
  });
  assertEquals(rewrite.sent, ["update"]);
  const first = scripted({
    update: { remoteId: "9999" },
    create: { remoteId: "1001" },
  });
  assertEquals(await writeTicketNote(request(null), first.send), {
    kind: "posted",
    externalId: "1001",
    recreated: false,
  });
  assertEquals(first.sent, ["create"]);
});

Deno.test("a lost rewrite is settled by reading the comment: same text confirms, other text and a truncated list do not, a full read without it confirms it gone", async () => {
  const reconcile = (comments: { id: number; body: string | null }[][]) => {
    const calls: string[] = [];
    return (update as unknown as {
      reconcile(ctx: unknown): Promise<unknown>;
    }).reconcile({
      input,
      provider: {
        request(ref: { id: string }, query: { page?: number }) {
          calls.push(ref.id);
          const page = comments[(query.page ?? 1) - 1] ?? [];
          return Promise.resolve(page.map((c) => ({ ...c, user: null })));
        },
      },
    });
  };
  assertEquals(await reconcile([[{ id: 1001, body: "Task: x" }]]), {
    status: "confirmed",
    result: { remoteId: "1001" },
  });
  assertEquals(await reconcile([[{ id: 1001, body: "Task: old" }]]), {
    status: "uncertain",
  });
  assertEquals(await reconcile([[{ id: 999, body: "other" }]]), {
    status: "confirmed",
    result: { missing: true },
  });
  const full = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1_000_000,
    body: null,
  }));
  assertEquals(await reconcile(Array.from({ length: 20 }, () => full)), {
    status: "uncertain",
  });
});
