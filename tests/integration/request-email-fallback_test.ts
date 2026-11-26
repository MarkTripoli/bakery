import { assert, assertEquals } from "@std/assert";
import { sendDueRequestEmails } from "../../apps/server/src/modules/work/request-email.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import { addMember, seedRun } from "../helpers/run-requests.ts";
import { serveSmtp } from "../helpers/smtp-loopback.ts";

const NOTE = "Please check the migration numbers in the plan";

async function open() {
  const fixture = await openSocketFixture();
  const asked = await addMember(fixture, "Asked", "developer");
  const run = await seedRun(fixture);
  const smtp = serveSmtp();
  await fixture.pgDatabase.query(
    "delete from bakery.installation_email_settings where id = 'installation'",
  );
  await fixture.pgDatabase.query(
    `insert into bakery.installation_email_settings
       (id, host, port, security, from_address, from_name, last_test_outcome,
        last_test_at)
     values ('installation', '127.0.0.1', $1, 'starttls', 'bakery@example.test',
       'Bakery', 'delivered', now())`,
    [smtp.port],
  );
  const request = async (createdAt: Date, status = "open") =>
    (await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.person_requests
         (organization_id, run_id, task_id, intent, recipient_id, asked_by,
          asked_by_kind, note, status, expires_at, created_at)
       values ($1, $2, $3, 'fyi', $4, $5, 'person', $6, $7,
         $8::timestamptz + interval '7 days', $8)
       returning id`,
      [
        fixture.organizationId,
        run.runId,
        run.taskId,
        asked.principalId,
        fixture.principalId,
        NOTE,
        status,
        createdAt.toISOString(),
      ],
    )).rows[0].id;
  const deliveries = async (requestId: string) =>
    (await fixture.pgDatabase.query<
      { channel: string; state: string; attempts: number }
    >(
      `select channel, state, attempts from bakery.person_request_deliveries
        where request_id = $1`,
      [requestId],
    )).rows;
  const sweep = (now: Date) =>
    sendDueRequestEmails({
      database: fixture.runtimePgDatabase,
      publicBaseUrl: "https://bakery.example.test",
      allowPlainLoopback: true,
      now,
    });
  return {
    fixture,
    asked,
    run,
    smtp,
    request,
    deliveries,
    sweep,
    finish: async () => {
      await fixture.pgDatabase.query(
        "delete from bakery.installation_email_settings where id = 'installation'",
      );
      await smtp.close();
      await cleanupAuthFixture(fixture.pgDatabase, [asked.email]);
      await fixture.close();
    },
  };
}

const mine = (
  outcomes: readonly { requestId: string; result: string }[],
  id: string,
) => outcomes.filter((outcome) => outcome.requestId === id);

Deno.test("a request still open after 15 minutes is emailed once, as a link only", async () => {
  const o = await open();
  try {
    const askedAt = new Date("2026-11-26T09:00:00Z");
    const id = await o.request(askedAt);
    assertEquals(
      mine(await o.sweep(new Date("2026-11-26T09:14:00Z")), id),
      [],
    );
    assertEquals(await o.deliveries(id), []);
    assertEquals(
      mine(await o.sweep(new Date("2026-11-26T09:16:00Z")), id),
      [{ requestId: id, result: "delivered" }],
    );
    assertEquals(
      mine(await o.sweep(new Date("2026-11-26T09:30:00Z")), id),
      [],
    );
    assertEquals(await o.deliveries(id), [
      { channel: "email", state: "delivered", attempts: 1 },
    ]);
    const data = o.smtp.received.filter((line) => line.startsWith("DATA:"));
    const mail = data.find((line) => line.includes(id));
    assert(mail !== undefined, "the email names the request in its link");
    assert(
      mail.includes(
        `https://bakery.example.test/runs/${o.run.runId}?request=${id}`,
      ),
    );
    assert(!mail.includes(NOTE), "the email never carries the note");
    assert(o.smtp.received.some((line) => line.includes(o.asked.email)));
  } finally {
    await o.finish();
  }
});

Deno.test("an answered request, or email that is not working, sends nothing", async () => {
  const o = await open();
  try {
    const answered = await o.request(
      new Date("2026-11-26T09:00:00Z"),
      "answered",
    );
    assertEquals(
      mine(await o.sweep(new Date("2026-11-26T09:30:00Z")), answered),
      [],
    );
    const open = await o.request(new Date("2026-11-26T09:00:00Z"));
    await o.fixture.pgDatabase.query(
      `update bakery.installation_email_settings
          set last_test_outcome = 'auth_failed' where id = 'installation'`,
    );
    assertEquals(await o.sweep(new Date("2026-11-26T09:30:00Z")), []);
    assertEquals(await o.deliveries(open), []);
  } finally {
    await o.finish();
  }
});

Deno.test("a send that fails is tried again, at most three times in all", async () => {
  const o = await open();
  try {
    const id = await o.request(new Date("2026-11-26T09:00:00Z"));
    await o.smtp.close();
    for (let minute = 16; minute < 21; minute++) {
      await o.sweep(new Date(`2026-11-26T09:${minute}:00Z`));
    }
    const [row] = await o.deliveries(id);
    assertEquals([row.state, row.attempts], ["failed", 3]);
  } finally {
    await o.finish();
  }
});
