/**
 * Issue 69: the external-ticket list answers the tickets linked to one task.
 *
 * The route, the filter and the fixtures live in the issue 82 helpers, so this
 * module imports the fixture and the HTTP helpers and registers the case here.
 * It is a test module: it exports nothing and its only job is `Deno.test`.
 */
import { assert, assertEquals } from "@std/assert";
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
const SOURCES = "/v1/external-ticket-sources";

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

function post(fx: TicketFixture, path: string, body?: unknown) {
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

async function previewAll(fx: TicketFixture, sourceId: string) {
  await read(await post(fx, `${SOURCES}/${sourceId}/previews`), 201);
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
    // `created_at` defaults to `now()`, which is the transaction's start, so
    // two links written in separate transactions can share an instant; the id
    // is the tie-break, and asserting without knowing both is a coin flip.
    const linkIds: string[] = [];
    for (
      const [ticket, task] of [
        [first, taskId],
        [second, taskId],
        [second, otherTask],
      ] as const
    ) {
      linkIds.push(
        (await read<{ id: string }>(
          await post(fx, `${TICKETS}/${ticket.id}/links`, {
            taskId: task,
            role: "reference",
          }),
          201,
        )).id,
      );
    }
    // The second ticket carries two links, and the read answers newest first
    // with the id as the tie-break, so which came first is the ids' to say.
    const [, secondLinkId, otherLinkId] = linkIds;
    const forTask = (id: string, extra = "") =>
      ticketCall(fx, "GET", `${TICKETS}?taskId=${id}${extra}`).then((
        response,
      ) => read<Page<TicketView>>(response, 200));
    // Newest link first; the third ticket was never linked to this task.
    const mine = await forTask(taskId);
    assertEquals(mine.items.map((item) => item.id), [second.id, first.id]);
    assert(!mine.items.some((item) => item.id === third.id));
    // The ticket still serves every task it is linked to, from the same read,
    // newest link first with the id as the tie-break, which is the order the
    // read documents rather than the order this test happened to write them.
    const linksOfSecond = otherLinkId < secondLinkId
      ? [otherTask, taskId]
      : [taskId, otherTask];
    assertEquals(
      [mine.items[0].id, mine.items[0].linkedTaskIds],
      [second.id, linksOfSecond],
    );
    assertEquals((await forTask(otherTask)).items.map((item) => item.id), [
      second.id,
    ]);
    // A task with no link answers an empty page, not an error.
    const none = await forTask(await fx.createPlainTask());
    assertEquals([none.items, none.nextCursor], [[], null]);
    // An id that names no task matches nothing rather than failing.
    assertEquals((await forTask(crypto.randomUUID())).items, []);
    // The filter composes with keyset paging.
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
