import { assert, assertEquals } from "@std/assert";
import { sendDueRequestEmails } from "../../apps/server/src/modules/work/request-email.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import { addMember, seedRun } from "../helpers/run-requests.ts";
import { serveSmtp, type SmtpScript } from "../helpers/smtp-loopback.ts";

const NOTE = "Please check the migration numbers in the plan";

async function open(script: SmtpScript = {}) {
  const fixture = await openSocketFixture();
  const asked = await addMember(fixture, "Asked", "developer");
  const run = await seedRun(fixture);
  const smtp = serveSmtp(script);
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
       values ($1, $2, $3, 'review', $4, $5, 'person', $6, $7,
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
    const mail = data.find((line) => line.includes(o.run.taskId));
    assert(mail !== undefined, "the email links the task");
    assert(mail.includes(`https://bakery.example.test/tasks/${o.run.taskId}`));
    const names = await o.fixture.pgDatabase.query<
      { asker: string; title: string }
    >(
      `select principal.display_name as asker, task.title
         from bakery.principals principal, bakery.tasks task
        where principal.id = $1 and task.id = $2`,
      [o.fixture.principalId, o.run.taskId],
    );
    const { asker, title } = names.rows[0];
    assert(mail.includes(`Subject: ${asker} asked you to review in Bakery`));
    assert(mail.includes(`${asker} asked you to review work in ${title}.`));
    assert(
      mail.includes(
        "You will need to sign in. This email has no details on purpose: they stay in Bakery.",
      ),
    );
    assert(
      mail.includes(
        "You are getting this because the request has not been opened in Bakery.",
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
  const o = await open({ mailFrom: "550 refused" });
  try {
    const id = await o.request(new Date("2026-11-26T09:00:00Z"));
    for (let minute = 16; minute < 21; minute++) {
      await o.sweep(new Date(`2026-11-26T09:${minute}:00Z`));
    }
    const [row] = await o.deliveries(id);
    assertEquals([row.state, row.attempts], ["failed", 3]);
  } finally {
    await o.finish();
  }
});

Deno.test("nobody whose membership is inactive, or whose account is disabled, is emailed", async () => {
  const o = await open();
  try {
    const askedAt = new Date("2026-11-26T09:00:00Z");
    await o.fixture.pgDatabase.query(
      `update bakery.organization_memberships set status = 'inactive'
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.asked.principalId],
    );
    const suspended = await o.request(askedAt);
    assertEquals(
      mine(await o.sweep(new Date("2026-11-26T09:30:00Z")), suspended),
      [],
    );
    await o.fixture.pgDatabase.query(
      `update bakery.organization_memberships set status = 'active'
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.asked.principalId],
    );
    await o.fixture.pgDatabase.query(
      "update bakery.principals set disabled_at = now() where id = $1",
      [o.asked.principalId],
    );
    assertEquals(
      mine(await o.sweep(new Date("2026-11-26T09:31:00Z")), suspended),
      [],
    );
    assertEquals(await o.deliveries(suspended), []);
  } finally {
    await o.fixture.pgDatabase.query(
      "update bakery.principals set disabled_at = null where id = $1",
      [o.asked.principalId],
    );
    await o.finish();
  }
});

Deno.test("the emailed link is a page the web app serves", async () => {
  const router = await Deno.readTextFile(
    new URL("../../apps/web/src/router.tsx", import.meta.url),
  );
  assert(router.includes('path: "/tasks/$taskId"'));
});
