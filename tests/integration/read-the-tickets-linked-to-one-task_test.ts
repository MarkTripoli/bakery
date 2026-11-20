/**
 * Issue 69: the external-ticket list answers the tickets linked to one task.
 *
 * The route, the filter and the fixtures live in the issue 82 helpers, so this
 * module imports the fixture and the HTTP helpers and registers the case here.
 * It is a test module: it exports nothing and its only job is `Deno.test`.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  type Problem,
  read,
  ticketCall,
  type TicketView,
} from "../helpers/ticket-admission/operations-http.ts";

const TICKETS = "/v1/external-tickets";

type Page<T> = { items: T[]; nextCursor: string | null };

/** Seeds `count` open issues, all unlabeled, so a preview caches every one. */
function seedIssues(fx: TicketFixture, count: number) {
  for (let number = 1; number <= count; number++) {
    fx.reader.setIssue({ number, labels: [] });
    fx.facts.set(
      number,
      `2026-06-01T00:00:${String(number).padStart(2, "0")}Z`,
    );
  }
}

function post(fx: TicketFixture, path: string, body: unknown = {}) {
  return ticketCall(fx, "POST", path, { body });
}

async function ticketOf(
  fx: TicketFixture,
  sourceId: string,
  number: number,
): Promise<TicketView> {
  const page = await read<Page<TicketView>>(
    await ticketCall(fx, "GET", `${TICKETS}?sourceId=${sourceId}&limit=100`),
    200,
  );
  const found = page.items.find((item) => item.number === String(number));
  assert(found, `ticket ${number} is cached`);
  return found;
}

/** Caches the seeded issues the way a poll does. A preview stores nothing. */
async function previewAll(fx: TicketFixture, sourceId: string, count = 3) {
  for (let number = 1; number <= count; number++) {
    await fx.admit(sourceId, { number, origin: "poll" });
  }
}

Deno.test("issue 69 ops: externalTickets.list answers the tickets linked to one task, and only those", async () => {
  await withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    seedIssues(fx, 3);
    await previewAll(fx, sourceId);
    const [first, second, third] = [
      await ticketOf(fx, sourceId, 1),
      await ticketOf(fx, sourceId, 2),
      await ticketOf(fx, sourceId, 3),
    ];
    const taskId = await fx.createPlainTask();
    const otherTask = await fx.createPlainTask();
    // One task carries two tickets, and one of those is shared with a second
    // task, so "linked to this task" cannot be answered by "has any link".
    // Each link is its own request, so each gets its own transaction and its
    // own `now()`. The second ticket is linked to `taskId` first and then to
    // `otherTask`, and that write order is what the read answers in reverse.
    for (
      const [ticket, task] of [
        [first, taskId],
        [second, taskId],
        [second, otherTask],
      ] as const
    ) {
      await read<{ id: string }>(
        await post(fx, `${TICKETS}/${ticket.id}/links`, {
          taskId: task,
          role: "reference",
        }),
        201,
      );
    }
    // The second ticket carries two links; which the read answers first is
    // derived below from the order they were written in, not from their ids.
    const forTask = (id: string, extra = "") =>
      ticketCall(fx, "GET", `${TICKETS}?taskId=${id}${extra}`).then((
        response,
      ) => read<Page<TicketView>>(response, 200));
    // Each ticket is cached by its own poll, in its own transaction, so they
    // have distinct `created_at` and the read answers the newer first:
    // "linked to this task, and only those" is the property under test.
    const mine = await forTask(taskId);
    assertNotEquals(first.id, second.id);
    assertEquals(mine.items.map((item) => item.id), [second.id, first.id]);
    assert(!mine.items.some((item) => item.id === third.id));
    // The ticket still serves every task it is linked to, from the same read,
    // newest link first. Each link is its own request and its own transaction,
    // so `now()` gives them distinct instants and write order alone decides -
    // the id tie-break only applies to links that SHARE an instant, which
    // these do not. This ticket's links were written to `taskId` before
    // `otherTask`, so `otherTask` is the newer and leads.
    const linksOfSecond = [otherTask, taskId];
    // Reach the ticket by id: which position it holds was decided above from
    // the read's documented order, and the position is not the property here.
    const secondRow = mine.items.find((item) => item.id === second.id);
    assert(secondRow, "the shared ticket is on the page");
    assertEquals(secondRow.linkedTaskIds, linksOfSecond);
    assertEquals(
      (await forTask(otherTask)).items.map((item) => item.id),
      [second.id],
    );
    // A task with no link answers an empty page, not an error.
    const none = await forTask(await fx.createPlainTask());
    assertEquals([none.items, none.nextCursor], [[], null]);
    // An id that names no task matches nothing rather than failing.
    assertEquals((await forTask(crypto.randomUUID())).items, []);
    // The filter composes with keyset paging. Paging walks the SAME
    // newest-first order, so the second page is the other ticket by construction.
    const page = await forTask(taskId, "&limit=1");
    assertEquals(page.items.map((item) => item.id), [second.id]);
    const rest = await forTask(taskId, `&limit=1&cursor=${page.nextCursor}`);
    assertEquals(rest.items.map((item) => item.id), [first.id]);
    assertEquals(rest.nextCursor, null);
    // A cursor carries the filters it was issued under, so an unfiltered
    // cursor cannot be replayed against a task-scoped read.
    const unfiltered = await read<Page<TicketView>>(
      await ticketCall(fx, "GET", `${TICKETS}?limit=1`),
      200,
    );
    const replayed = await ticketCall(
      fx,
      "GET",
      `${TICKETS}?taskId=${taskId}&limit=1&cursor=${unfiltered.nextCursor}`,
    );
    assertEquals(replayed.status, 400);
    assertEquals((await replayed.json() as Problem).code, "INVALID_CURSOR");
  });
});
