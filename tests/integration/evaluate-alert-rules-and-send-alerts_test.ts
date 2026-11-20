import { assert, assertEquals } from "@std/assert";
import { createHmac } from "node:crypto";
import { allowAnyAddress } from "../../apps/server/src/platform/telemetry-destinations/index.ts";
import { createAlertEvaluator } from "../../apps/server/src/modules/monitoring/alert-evaluator.ts";
import {
  sealInstallationSecret,
  writeInstallationSecretVersion,
} from "../../apps/server/src/modules/secrets/installation-secrets.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

/**
 * AC4 of #739 against a real database and a real receiver: given a worker that
 * stops, the rule fires, one signed webhook is sent, repeats are suppressed and
 * a recovery notice follows. The Slack half waits for the Slack store.
 */

type Seen = { headers: Record<string, string>; body: string };

function receiver(status: () => number) {
  const seen: Seen[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      // Only a signed alert is the test's traffic: a POST with a body. A host
      // that probes new localhost ports sends empty GETs, which must not count.
      const body = request.method === "POST" ? await request.text() : "";
      if (body === "") return new Response("not found", { status: 404 });
      seen.push({ headers: Object.fromEntries(request.headers), body });
      return new Response("received", { status: status() });
    },
  );
  return {
    seen,
    address: `http://127.0.0.1:${server.addr.port}/alerts`,
    close: () => server.shutdown(),
  };
}

function verifies(seen: Seen, secret: string): boolean {
  const parts = Object.fromEntries(
    (seen.headers["bakery-signature"] ?? "").split(",").map((part) =>
      part.split("=") as [string, string]
    ),
  );
  return parts.v1 === createHmac("sha256", secret)
    .update(`${parts.t}.${seen.body}`).digest("hex");
}

/** The application role cannot delete a channel secret, so the test clears its own. */
async function clearAlertFixture(
  database: { query: (text: string, values?: unknown[]) => Promise<unknown> },
): Promise<void> {
  await database.query("delete from bakery.alert_states");
  await database.query("delete from bakery.alert_events");
  await database.query("delete from bakery.alert_channels");
  await database.query(
    "update bakery.secrets set active_version_id = null where provider = 'alerts'",
  );
  await database.query(
    "delete from bakery.secret_versions where secret_id in (select id from bakery.secrets where provider = 'alerts')",
  );
  await database.query("delete from bakery.secrets where provider = 'alerts'");
}

const types = (hook: { seen: Seen[] }) =>
  hook.seen.map((s) => JSON.parse(s.body).type as string);

Deno.test("a worker that stops fires one alert, repeats are suppressed, and a recovery follows", async () => {
  const keyFile = await Deno.makeTempFile({ prefix: "bakery-alert-eval-" });
  await Deno.writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  const secretsKey = { file: keyFile, keyId: "alert-evaluator-v1" };
  let answer = 200;
  const hook = receiver(() => answer);
  try {
    await withWorkerFixture(async (fixture) => {
      const database = fixture.pgDatabase;
      try {
        // A channel, with a signing secret the test knows.
        const signingSecret = "whsec_evaluator_test";
        const sealed = await sealInstallationSecret(
          secretsKey,
          null,
          signingSecret,
        );
        await withPgTransaction(database, async (tx) => {
          await writeInstallationSecretVersion(tx, sealed, {
            name: "Alert channel test",
            provider: "alerts",
            principalId: fixture.principalId,
          });
          await tx.query(
            `insert into bakery.alert_channels (id, kind, name, settings, secret_id)
           values ($1, 'webhook', 'On call', $2::jsonb, $3)`,
            [
              crypto.randomUUID(),
              JSON.stringify({ address: hook.address }),
              sealed.secretId,
            ],
          );
        });
        const worker = await registeredWorker(fixture, { slots: 1 });
        const hostId = worker.registration.workerHostId;
        const evaluator = createAlertEvaluator({
          database,
          secretsKey,
          fetch,
          addressPolicy: allowAnyAddress,
        });
        const silentFor = (minutes: number) =>
          database.query(
            `update bakery.worker_hosts
              set last_heartbeat_at = now() - make_interval(mins => $2)
            where id = $1`,
            [hostId, minutes],
          );
        const states = async () =>
          (await database.query<{ rule: string; subject: string }>(
            "select rule, subject from bakery.alert_states",
          )).rows;

        // The worker reports: nothing is wrong, nothing is sent.
        await silentFor(0);
        assertEquals((await evaluator.evaluateOnce()).fired, 0);
        assertEquals(hook.seen.length, 0);

        // It stops reporting. The first check fires, once.
        await silentFor(20);
        const first = await evaluator.evaluateOnce();
        assertEquals([first.ran, first.fired, first.delivered], [true, 1, 1]);
        assertEquals(types(hook), ["alert.fired"]);
        assert(
          verifies(hook.seen[0], signingSecret),
          "the message does not verify",
        );
        assert(JSON.parse(hook.seen[0].body).text.includes("has not reported"));
        assertEquals(await states(), [{
          rule: "worker_lost",
          subject: hostId,
        }]);

        // It stays silent: the same trouble is not sent again.
        for (let check = 0; check < 3; check += 1) {
          assertEquals((await evaluator.evaluateOnce()).fired, 0);
        }
        assertEquals(types(hook), ["alert.fired"], "repeats are suppressed");

        // It reports again. One clear check is not enough; the second resolves it.
        await silentFor(0);
        assertEquals((await evaluator.evaluateOnce()).resolved, 0);
        assertEquals(types(hook), ["alert.fired"]);
        const resolved = await evaluator.evaluateOnce();
        assertEquals([resolved.resolved, resolved.delivered], [1, 1]);
        assertEquals(types(hook), ["alert.fired", "alert.resolved"]);
        assert(verifies(hook.seen[1], signingSecret));
        assert(JSON.parse(hook.seen[1].body).text.startsWith("Resolved:"));
        assertEquals(await states(), []);
        assertEquals((await evaluator.evaluateOnce()).resolved, 0);
        assertEquals(hook.seen.length, 2, "nothing more is said");

        // What happened is kept, with how many channels answered.
        const events = await database.query<
          { kind: string; channels_ok: number; channels_failed: number }
        >(
          `select kind, channels_ok, channels_failed from bakery.alert_events
          order by occurred_at, id`,
        );
        assertEquals(events.rows, [
          { kind: "fired", channels_ok: 1, channels_failed: 0 },
          { kind: "resolved", channels_ok: 1, channels_failed: 0 },
        ]);

        // A rule that is off never fires, and a limit change takes effect.
        await silentFor(20);
        await database.query(
          "insert into bakery.alert_rules (rule, enabled, threshold) values ('worker_lost', false, null) on conflict (rule) do update set enabled = excluded.enabled, threshold = excluded.threshold",
        );
        assertEquals((await evaluator.evaluateOnce()).fired, 0);
        await database.query(
          "insert into bakery.alert_rules (rule, enabled, threshold) values ('worker_lost', true, 3600) on conflict (rule) do update set enabled = excluded.enabled, threshold = excluded.threshold",
        );
        assertEquals(
          (await evaluator.evaluateOnce()).fired,
          0,
          "20 minutes is under a one hour limit",
        );
        await database.query(
          "insert into bakery.alert_rules (rule, enabled, threshold) values ('worker_lost', true, 60) on conflict (rule) do update set enabled = excluded.enabled, threshold = excluded.threshold",
        );
        assertEquals((await evaluator.evaluateOnce()).fired, 1);
        assertEquals(types(hook).at(-1), "alert.fired");

        // A receiver that refuses is counted as failed, and does not make the alert fire again.
        answer = 500;
        await silentFor(0);
        await evaluator.evaluateOnce();
        const refused = await evaluator.evaluateOnce();
        assertEquals([refused.resolved, refused.delivered, refused.failed], [
          1,
          0,
          1,
        ]);
        const channel = (await database.query<
          { last_answer_ok: boolean; last_answer_status: number }
        >("select last_answer_ok, last_answer_status from bakery.alert_channels"))
          .rows[0];
        assertEquals([channel.last_answer_ok, channel.last_answer_status], [
          false,
          500,
        ]);
        answer = 200;

        // A test alert reaches every enabled channel and reports each answer.
        const before = hook.seen.length;
        const test = await evaluator.sendTest();
        assertEquals(test.map((r) => [r.name, r.ok, r.status]), [[
          "On call",
          true,
          200,
        ]]);
        assertEquals(types(hook).slice(before), ["alert.test"]);
        assert(verifies(hook.seen[before], signingSecret));

        // Two servers never act on one check: while another holds the lock, this one skips.
        // And a check that skipped does not use up what a destination dropped meanwhile.
        let dropped = 0;
        const lossy = createAlertEvaluator({
          database,
          secretsKey,
          fetch,
          addressPolicy: allowAnyAddress,
          fanout: {
            states: () =>
              new Map([["telemetry-destination-1", { dropped } as never]]),
          },
        });
        assertEquals(
          (await lossy.evaluateOnce()).ran,
          true,
          "the first look records the count",
        );
        dropped = 3;
        const holder = await database.connect();
        try {
          await holder.query("begin");
          await holder.query("select pg_advisory_xact_lock(739001)");
          const skipped = await evaluator.evaluateOnce();
          assertEquals(skipped.ran, false);
          assertEquals((await lossy.evaluateOnce()).ran, false);
        } finally {
          await holder.query("rollback");
          holder.release();
        }
        assertEquals((await lossy.evaluateOnce()).ran, true);
        assert(
          (await states()).some((s) =>
            s.rule === "export_loss" && s.subject === "telemetry-destination-1"
          ),
          "the drops from the skipped check still raise the alert",
        );
      } finally {
        await clearAlertFixture(database);
      }
    });
  } finally {
    await hook.close();
    await Deno.remove(keyFile);
  }
});
