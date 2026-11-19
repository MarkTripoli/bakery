import { assertEquals, assertRejects } from "@std/assert";
import { githubIntegration } from "../../apps/server/src/modules/catalog/integration-providers/github.ts";
import { ticketNoteBody } from "../../apps/server/src/modules/work/ticket-notes.ts";

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
