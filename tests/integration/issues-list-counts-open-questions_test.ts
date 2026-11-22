import { assertEquals } from "@std/assert";
import {
  EXECUTE_LABEL,
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";

/**
 * Issue 61: the issues list says how many questions wait for an answer on
 * the task of each issue's open request, so the list can show "Needs an
 * answer" without reading every task's questions.
 */

type Ticket = { id: string; number: string | null; openQuestionCount: number };

async function ask(
  fx: TicketFixture,
  taskId: string,
  question: { kind?: string; status?: string; expired?: boolean },
): Promise<void> {
  await fx.owner.query(
    `insert into bakery.questions (
       organization_id, kind, conversation_id, task_id, generation, prompt,
       status, expires_at
     )
     select organization_id, $3, conversation_id, id, 1, 'Which branch?', $4,
            case when $5 then now() - interval '1 minute' else null end
       from bakery.tasks where organization_id = $1 and id = $2`,
    [
      fx.organizationId,
      taskId,
      question.kind ?? "question",
      question.status ?? "open",
      question.expired ?? false,
    ],
  );
}

Deno.test("issue 61: the issues list and the issue read count the open questions of the open request's task", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setIssue({ number: 613, labels: [EXECUTE_LABEL] });
    fx.reader.setIssue({ number: 614, labels: [EXECUTE_LABEL] });
    const asked = await fx.admit(sourceId, { number: 613, intent: "plan" });
    const quiet = await fx.admit(sourceId, { number: 614, intent: "plan" });
    const taskId = asked.request!.taskId;
    // Two open questions count; an answered, an expired one and an approval do not.
    await ask(fx, taskId, {});
    await ask(fx, taskId, {});
    await ask(fx, taskId, { status: "answered" });
    await ask(fx, taskId, { expired: true });
    await ask(fx, taskId, { kind: "approval" });

    const list = await read<{ items: Ticket[] }>(
      await ticketCall(fx, "GET", "/v1/external-tickets"),
      200,
    );
    const counts = Object.fromEntries(
      list.items.map((item) => [item.id, item.openQuestionCount]),
    );
    assertEquals(counts[asked.ticketId!], 2);
    assertEquals(counts[quiet.ticketId!], 0);
    const one = await read<Ticket>(
      await ticketCall(fx, "GET", `/v1/external-tickets/${asked.ticketId}`),
      200,
    );
    assertEquals(one.openQuestionCount, 2);

    // Once the request ends, its task's questions no longer count.
    await fx.owner.query(
      `update bakery.ticket_requests set disposition = 'canceled'
        where organization_id = $1 and id = $2`,
      [fx.organizationId, asked.request!.id],
    );
    const ended = await read<Ticket>(
      await ticketCall(fx, "GET", `/v1/external-tickets/${asked.ticketId}`),
      200,
    );
    assertEquals(ended.openQuestionCount, 0);
  }));
