import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { createApiRouter } from "../../../packages/contracts/src/http.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { createIntegrationsActionRegistry } from "../../../apps/server/src/modules/integrations/actions.ts";
import { INTAKE_MAX_BODY_BYTES } from "../../../apps/server/src/modules/integrations/intake-body.ts";
import { authTestOrigin } from "../auth.ts";
import {
  deliveryOf,
  enabledReceiver,
  installationPayload,
  instrumentedDatabase,
  issuesPayload,
  receipt,
  receiptRows,
  receiptText,
  receiverApp,
  rowCounts,
  send,
  webhookUrl,
  withFixture,
} from "./receipts-shared.ts";
import { formEncodedPayload, signDelivery } from "./signed-delivery.ts";

const SHA256_HEX = "a".repeat(64);
const CANARY = "canary-body-text-52d1";

type Problem = {
  code: string;
  status: number;
  requestId: string;
  traceId: string;
  instance?: string;
  limit?: number;
  [key: string]: unknown;
};

/** Everything the console was told while `work` ran. */
async function logged<T>(
  work: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const names = ["log", "info", "warn", "error", "debug"] as const;
  const original = names.map((name) => console[name]);
  for (const name of names) {
    console[name] = (...args: unknown[]) => {
      lines.push(
        args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg))
          .join(" "),
      );
    };
  }
  try {
    return { value: await work(), lines };
  } finally {
    names.forEach((name, index) => {
      console[name] = original[index] as never;
    });
  }
}

/** A problem body without the fields that differ on every request. */
function stable(problem: Problem): Record<string, unknown> {
  const {
    requestId: _requestId,
    traceId: _traceId,
    instance: _instance,
    ...rest
  } = problem;
  return rest;
}

function rawRequest(
  headers: Record<string, string>,
  body: BodyInit | ReadableStream<Uint8Array<ArrayBuffer>> | null,
): Request {
  return new Request(webhookUrl, {
    method: "POST",
    headers,
    body,
    // Required for a streamed request body; the runtime types do not list it.
    ...{ duplex: "half" },
  });
}

const issuesHeaders = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-github-delivery": crypto.randomUUID(),
  "x-github-event": "issues",
  "x-hub-signature-256": `sha256=${SHA256_HEX}`,
  ...extra,
});

/** A body that counts reads and cancellations; when read it is a small JSON object. */
function watchedBody() {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      state.pulls += 1;
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

Deno.test("issue 71 receiver security: a missing or malformed signature header is refused before the database is touched", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database });
    const body = JSON.stringify(issuesPayload(r));
    const good = await signDelivery(r.secret, body);
    const hex = good.slice("sha256=".length);
    const before = await rowCounts(f);
    for (
      const [name, signature] of [
        ["missing", null],
        ["empty", ""],
        ["uppercase hex", `sha256=${hex.toUpperCase()}`],
        ["legacy sha1", `sha1=${hex.slice(0, 40)}`],
        ["no prefix", hex],
        ["truncated", good.slice(0, -2)],
        ["wrong algorithm name", `sha512=${hex}`],
      ] as const
    ) {
      const response = await app.fetch(
        await deliveryOf(r, { event: "issues", body, signature }),
      );
      assertEquals(response.status, 401, name);
      const problem = await response.json() as Problem;
      assertEquals(problem.code, "AUTH_INVALID", name);
    }
    assertEquals(state.queries, [], "no secret read, no query of any kind");
    assertEquals(await rowCounts(f), before);
  });
});

Deno.test("issue 71 receiver security: a wrong secret or a changed byte is refused and writes nothing", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database });
    const body = JSON.stringify(issuesPayload(r));
    const signed = await signDelivery(r.secret, body);
    const flipped = new TextEncoder().encode(body);
    flipped[flipped.length - 2] ^= 1;
    const before = await rowCounts(f);
    const variants = [
      { event: "issues", body, secret: "not-the-webhook-secret" },
      { event: "issues", body: flipped, signature: signed },
      { event: "issues", body: `${body}\n`, signature: signed },
      // A signature for the right bytes under the wrong event is still valid
      // for the bytes, so it is the receipt, not the signature, that decides.
    ];
    for (const options of variants) {
      const response = await app.fetch(await deliveryOf(r, options));
      assertEquals(response.status, 401);
      assertEquals((await response.json() as Problem).code, "AUTH_INVALID");
    }
    assertEquals(await rowCounts(f), before);
    assertEquals(
      state.queries.filter((sql) => /\b(insert|update|delete)\b/i.test(sql)),
      [],
      "a refused signature writes nothing",
    );
    assertEquals(state.queries.length, variants.length, "one secret read each");
  });
});

Deno.test("issue 71 receiver security: every authentication failure gives the caller the same answer", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const body = JSON.stringify(issuesPayload(r));
    const answers: Record<string, unknown>[] = [];
    const ask = async (options: Parameters<typeof deliveryOf>[1]) => {
      const response = await f.app.fetch(await deliveryOf(r, options));
      assertEquals(response.status, 401);
      answers.push(stable(await response.json() as Problem));
    };
    await ask({ event: "issues", body, signature: null });
    await ask({ event: "issues", body, signature: "sha256=bad" });
    await ask({ event: "issues", body, secret: "another-secret" });
    // The App has no webhook secret at all: nothing can verify. The id is
    // put back so the fixture's cleanup still finds the secret.
    const stored = (await f.pgDatabase.query<{ id: string }>(
      "select webhook_secret_id as id from bakery.integration_app_registrations",
    )).rows[0].id;
    await f.pgDatabase.query(
      "update bakery.integration_app_registrations set webhook_secret_id = null",
    );
    try {
      await ask({ event: "issues", body });
    } finally {
      await f.pgDatabase.query(
        "update bakery.integration_app_registrations set webhook_secret_id = $1",
        [stored],
      );
    }
    for (const answer of answers.slice(1)) {
      assertEquals(answer, answers[0]);
    }
    assertEquals((await rowCounts(f)).receipts, 0);
  });
});

Deno.test("issue 71 receiver security: with no secrets key mounted, every delivery is refused as unauthenticated", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const app = receiverApp(f, { secretsKey: null });
    const response = await app.fetch(
      await deliveryOf(r, { event: "issues", payload: issuesPayload(r) }),
    );
    assertEquals(response.status, 401);
    assertEquals((await response.json() as Problem).code, "AUTH_INVALID");
    assertEquals((await rowCounts(f)).receipts, 0);
  });
});

Deno.test("issue 71 receiver security: an unsupported content type is refused before the body or the secret is read", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database });
    for (
      const contentType of [
        "text/plain",
        "application/xml",
        "multipart/form-data; boundary=x",
        "application/jsonx",
        "",
      ]
    ) {
      const response = await app.fetch(
        await deliveryOf(r, {
          event: "issues",
          payload: issuesPayload(r),
          contentType,
        }),
      );
      assertEquals(response.status, 415, contentType);
      assertEquals(
        (await response.json() as Problem).code,
        "UNSUPPORTED_MEDIA_TYPE",
      );
    }
    assertEquals(state.queries, []);
    assertEquals((await rowCounts(f)).receipts, 0);
  });
});

Deno.test("issue 71 receiver security: an unsupported content type is refused before one byte of the body is read", async () => {
  await withFixture(async (f) => {
    await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database });
    for (const contentType of ["text/plain", "application/xml", ""]) {
      const body = watchedBody();
      const response = await app.fetch(
        rawRequest(issuesHeaders({ "content-type": contentType }), body.stream),
      );
      assertEquals(response.status, 415, contentType);
      assertEquals(
        (await response.json() as Problem).code,
        "UNSUPPORTED_MEDIA_TYPE",
      );
      assertEquals(body.state.pulls, 0, `the ${contentType} body was read`);
      assert(body.state.cancelled, "the unread body is released");
    }
    // The signature header is checked first, so with no signature the same
    // request is a 401 and its body is still not read.
    const { "x-hub-signature-256": _omitted, ...unsigned } = issuesHeaders({
      "content-type": "text/plain",
    });
    const unauthenticated = watchedBody();
    const refused = await app.fetch(
      rawRequest(unsigned, unauthenticated.stream),
    );
    assertEquals(refused.status, 401);
    assertEquals((await refused.json() as Problem).code, "AUTH_INVALID");
    assertEquals(unauthenticated.state.pulls, 0);
    assertEquals(state.queries, [], "no secret was read for either refusal");
    assertEquals((await rowCounts(f)).receipts, 0);
  });
});

Deno.test("issue 71 receiver security: an oversize body is refused with 413, logged safely and stored nowhere", async () => {
  await withFixture(async (f) => {
    await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database });
    const chunk = new Uint8Array(100_000).fill(0x61);
    const declared = rawRequest(
      issuesHeaders({
        "content-length": String(INTAKE_MAX_BODY_BYTES + 1),
        "x-request-id": "oversize-declared-1",
      }),
      new Uint8Array(16),
    );
    let pulls = 0;
    let cancelled = false;
    const chunked = rawRequest(
      issuesHeaders({ "x-request-id": "oversize-chunked-1" }),
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
          if (pulls > 100) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 }),
    );
    const { value: responses, lines } = await logged(async () => [
      await app.fetch(declared),
      await app.fetch(chunked),
    ]);
    for (const response of responses) {
      assertEquals(response.status, 413);
      const problem = await response.json() as Problem;
      assertEquals(problem.code, "BODY_TOO_LARGE");
      assertEquals(problem.limit, INTAKE_MAX_BODY_BYTES);
    }
    assert(cancelled, "the oversize stream is cancelled");
    assert(pulls <= 4, `the read stopped at the limit (${pulls} chunks)`);
    assertEquals(state.queries, [], "nothing authenticated, nothing read");
    assertEquals((await rowCounts(f)).receipts, 0);
    assertEquals(lines.length, 2, "one safe line per refusal");
    for (const [index, line] of lines.entries()) {
      const parsed = JSON.parse(line);
      assertEquals(parsed.event, "github_webhook_body_too_large");
      assertEquals(parsed.limit, INTAKE_MAX_BODY_BYTES);
      assertEquals(
        parsed.requestId,
        ["oversize-declared-1", "oversize-chunked-1"][index],
      );
      assertEquals(
        Object.keys(parsed).sort(),
        ["component", "event", "limit", "requestId", "traceId"],
      );
    }
  });
});

Deno.test("issue 71 receiver security: a body of exactly the limit is read and judged by its signature", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const exact = "x".repeat(INTAKE_MAX_BODY_BYTES);
    const response = await send(r, { event: "star", body: exact });
    assertEquals(response.status, 202, await response.clone().text());
    assertEquals((await response.json()).status, "ignored");
    const forged = await send(r, {
      event: "star",
      body: exact,
      secret: "another-secret",
    });
    assertEquals(forged.status, 401);
    assertEquals((await rowCounts(f)).receipts, 1);
  });
});

Deno.test("issue 71 receiver security: a body that trickles in is cut off at the deadline before authentication", async () => {
  await withFixture(async (f) => {
    await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database, deadlineMs: 80 });
    let cancelled = false;
    let sent = false;
    const stalled = rawRequest(
      issuesHeaders(),
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          if (sent) return new Promise<void>(() => {});
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"action":'));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 }),
    );
    const response = await app.fetch(stalled);
    assertEquals(response.status, 504);
    assertEquals(
      (await response.json() as Problem).code,
      "DEPENDENCY_TIMEOUT",
    );
    assert(cancelled, "the trickling stream is cancelled");
    assertEquals(state.queries, [], "unauthenticated bytes reached no query");
    assertEquals((await rowCounts(f)).receipts, 0);
  });
});

Deno.test("issue 71 receiver security: a signed body that is not a valid event is a 400 and stores nothing", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const before = await rowCounts(f);
    const refuse = async (
      options: Parameters<typeof deliveryOf>[1],
      status: number,
      code: string,
    ) => {
      const response = await send(r, options);
      assertEquals(response.status, status, code);
      assertEquals((await response.json() as Problem).code, code);
    };
    await refuse({ event: "issues", body: "{not json" }, 400, "MALFORMED_JSON");
    await refuse({ event: "issues", body: "" }, 400, "MALFORMED_JSON");
    await refuse(
      { event: "issues", body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) },
      400,
      "MALFORMED_JSON",
    );
    await refuse(
      {
        event: "issues",
        payload: { action: "opened", issue: { number: "7" } },
      },
      400,
      "MALFORMED_REQUEST",
    );
    await refuse(
      { event: "issues", payload: { action: "opened", issue: { number: 7 } } },
      400,
      "MALFORMED_REQUEST",
    );
    await refuse(
      {
        event: "installation",
        payload: { installation: { id: r.installationId } },
      },
      400,
      "MALFORMED_REQUEST",
    );
    // A well-formed form delivery is accepted, so the refusals below are
    // about the bytes, not the encoding.
    const formed = await send(r, {
      event: "issues",
      body: formEncodedPayload(JSON.stringify(issuesPayload(r))),
      contentType: "application/x-www-form-urlencoded",
    });
    assertEquals(formed.status, 202, await formed.clone().text());
    assertEquals(
      (await rowCounts(f)).receipts,
      before.receipts + 1,
      "only the well-formed form delivery was stored",
    );
    await refuse(
      {
        event: "issues",
        body: "other=1",
        contentType: "application/x-www-form-urlencoded",
      },
      400,
      "MALFORMED_REQUEST",
    );
    await refuse(
      {
        event: "issues",
        body: `payload=${encodeURIComponent("{}")}&payload=x`,
        contentType: "application/x-www-form-urlencoded",
      },
      400,
      "MALFORMED_REQUEST",
    );
    assertEquals(
      (await rowCounts(f)).receipts,
      before.receipts + 1,
      "no refused delivery left a receipt",
    );
  });
});

Deno.test("issue 71 receiver security: missing or malformed delivery id and event name headers are 400 after a valid signature", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const body = JSON.stringify(issuesPayload(r));
    const signature = await signDelivery(r.secret, body);
    const attempt = async (headers: Record<string, string | null>) => {
      const prepared: Record<string, string> = {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      };
      for (const [name, value] of Object.entries(headers)) {
        if (value !== null) prepared[name] = value;
      }
      const response = await f.app.fetch(rawRequest(prepared, body));
      assertEquals(response.status, 400, JSON.stringify(headers));
      assertEquals(
        (await response.json() as Problem).code,
        "MALFORMED_REQUEST",
      );
    };
    const valid = crypto.randomUUID();
    await attempt({ "x-github-event": "issues" });
    await attempt({ "x-github-delivery": valid });
    await attempt({
      "x-github-delivery": "x".repeat(256),
      "x-github-event": "issues",
    });
    await attempt({
      "x-github-delivery": "bad id!",
      "x-github-event": "issues",
    });
    await attempt({ "x-github-delivery": "", "x-github-event": "issues" });
    await attempt({ "x-github-delivery": valid, "x-github-event": "Issues" });
    await attempt({
      "x-github-delivery": valid,
      "x-github-event": "issues.labeled",
    });
    await attempt({
      "x-github-delivery": valid,
      "x-github-event": "e".repeat(101),
    });
    assertEquals((await rowCounts(f)).receipts, 0);
  });
});

Deno.test("issue 71 receiver security: the signature is judged before the delivery id and event name, so a forged request learns nothing about them", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const body = JSON.stringify(issuesPayload(r));
    const genuine = await signDelivery(r.secret, body);
    const forged = await signDelivery("another-secret", body);
    const valid = crypto.randomUUID();
    const malformed: [string, Record<string, string>][] = [
      ["both headers missing", {}],
      ["delivery id with a space", {
        "x-github-delivery": "bad id!",
        "x-github-event": "issues",
      }],
      ["over-long delivery id", {
        "x-github-delivery": "x".repeat(256),
        "x-github-event": "issues",
      }],
      ["empty delivery id", {
        "x-github-delivery": "",
        "x-github-event": "issues",
      }],
      ["uppercase event name", {
        "x-github-delivery": valid,
        "x-github-event": "Issues",
      }],
      ["over-long event name", {
        "x-github-delivery": valid,
        "x-github-event": "e".repeat(101),
      }],
      ["event name missing", { "x-github-delivery": valid }],
    ];
    const attempt = async (
      headers: Record<string, string>,
      signature: string,
    ) =>
      await f.app.fetch(rawRequest({
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        ...headers,
      }, body));
    const reference = stable(
      await (await attempt({
        "x-github-delivery": valid,
        "x-github-event": "issues",
      }, forged)).json() as Problem,
    );
    for (const [name, headers] of malformed) {
      const refused = await attempt(headers, forged);
      assertEquals(refused.status, 401, `forged, ${name}`);
      assertEquals(
        stable(await refused.json() as Problem),
        reference,
        `forged, ${name}: the same answer as any other forgery`,
      );
      // Once the signature is genuine the same headers are a format error.
      const genuineAttempt = await attempt(headers, genuine);
      assertEquals(genuineAttempt.status, 400, `genuine, ${name}`);
      assertEquals(
        (await genuineAttempt.json() as Problem).code,
        "MALFORMED_REQUEST",
        name,
      );
    }
    assertEquals((await rowCounts(f)).receipts, 0);
  });
});

Deno.test("issue 71 receiver security: an event outside the supported list is acknowledged and stored ignored", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const acknowledged = await receipt(r, {
      event: "workflow_run",
      body: JSON.stringify({ action: "completed", note: CANARY }),
    });
    assertEquals(acknowledged.status, "ignored");
    const rows = await receiptRows(f);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].rejection_reason, "unsupported_event");
    assertEquals(rows[0].event_kind, "workflow_run");
    assertFalse((await receiptText(f)).includes(CANARY));
    assertEquals((await rowCounts(f)).routes, 0);
  });
});

Deno.test("issue 71 receiver security: unknown, suspended and revoked installations get indistinguishable acknowledgements", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const shapes: Record<string, unknown>[] = [];
    const ask = async (installationId: number) => {
      const acknowledged = await receipt(r, {
        event: "issues",
        payload: issuesPayload({ ...r, installationId }, 2),
      });
      const { eventId: _eventId, receivedAt: _receivedAt, ...rest } =
        acknowledged;
      shapes.push(rest);
    };
    await ask(r.installationId + 1);
    await f.pgDatabase.query(
      "update bakery.integration_installations set status = 'suspended'",
    );
    await ask(r.installationId);
    await f.pgDatabase.query(
      "update bakery.integration_installations set status = 'revoked'",
    );
    await ask(r.installationId);
    for (const shape of shapes.slice(1)) assertEquals(shape, shapes[0]);
    assertEquals(shapes[0], { status: "ignored", taskId: null });
    assertEquals(await rowCounts(f), {
      receipts: 3,
      routes: 0,
      domainEvents: 0,
      outbox: 0,
      audits: 0,
    });
  });
});

Deno.test("issue 71 receiver security: logs and errors never contain the secret, a signature, the body or an identifier from it", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database });
    const body = JSON.stringify({
      ...issuesPayload(r),
      issue: { number: 1, title: CANARY },
    });
    const signature = await signDelivery(r.secret, body);
    const responses: string[] = [];
    const { lines } = await logged(async () => {
      const collect = async (response: Response) => {
        responses.push(await response.text());
      };
      await collect(
        await app.fetch(await deliveryOf(r, { event: "issues", body })),
      );
      await collect(
        await app.fetch(
          await deliveryOf(r, { event: "issues", body, secret: "x" }),
        ),
      );
      await collect(
        await app.fetch(
          await deliveryOf(r, { event: "issues", body: `${body} `, signature }),
        ),
      );
      await collect(
        await app.fetch(
          await deliveryOf(r, { event: "issues", body: `{"n":"${CANARY}` }),
        ),
      );
      await collect(
        await app.fetch(
          rawRequest(
            issuesHeaders({
              "content-length": String(INTAKE_MAX_BODY_BYTES + 9),
            }),
            body,
          ),
        ),
      );
      state.failing = "update bakery.inbound_events";
      await collect(
        await app.fetch(await deliveryOf(r, { event: "issues", body })),
      );
    });
    const secrets = [r.secret, signature.slice("sha256=".length), CANARY, body];
    for (const text of [...lines, ...responses]) {
      for (const secretValue of secrets) {
        assertFalse(
          text.includes(secretValue),
          `output leaked ${secretValue.slice(0, 12)}`,
        );
      }
    }
    assert(lines.length >= 2, "failures were logged");
    // No token was minted or logged on the receiving path.
    assertEquals(f.github.tokenRequests.length, 0);
    assertEquals(
      f.github.calls.length,
      0,
      "receiving a delivery asks GitHub nothing",
    );
  });
});

Deno.test("issue 71 receiver security: the registered action refuses any call that did not come through the verified route", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const registry = createIntegrationsActionRegistry(f.runtimePgDatabase!, {
      publicBaseUrl: authTestOrigin,
      secretsKey: f.secretsKey,
      github: f.github.client,
      cursorSecret: "intake-receipts-test-cursor-secret-0123456789",
    });
    const envelope = {
      deliveryId: crypto.randomUUID(),
      eventType: "issues",
      payload: issuesPayload(r),
    };
    const before = await rowCounts(f);

    // Straight into the registry: the guard runs before the handler.
    const context = {
      request: new Request(webhookUrl, { method: "POST" }),
      params: {},
      requestId: "req",
      traceId: "trace",
      signal: new AbortController().signal,
    };
    const error = await registry.execute("intake.github", context, envelope)
      .then(() => null, (thrown) => thrown);
    assert(error instanceof StandardError);
    assertEquals(error.code, "AUTH_INVALID");

    // Through the generic JSON router, which knows nothing of signatures.
    const router = createApiRouter({
      registry,
      publicBaseUrl: authTestOrigin,
    });
    const response = await router.request(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    assertEquals(response.status, 401);
    assertEquals((await response.json() as Problem).code, "AUTH_INVALID");

    // And through the whole application without a signature.
    const app = await f.app.fetch(
      new Request(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      }),
    );
    assertEquals(app.status, 401);
    // Only the receiving route answers POST; the path has no other method.
    const read = await f.app.fetch(new Request(webhookUrl));
    assertEquals(read.status, 405);
    assertEquals(await rowCounts(f), before);
  });
});

Deno.test("issue 71 receiver security: a valid signature never lets the payload pick the organization", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    // The payload names organization and connection ids of the first tenant;
    // the receiver reads none of them and routes only by installation and
    // repository ids it already holds.
    const other = crypto.randomUUID();
    const acknowledged = await receipt(r, {
      event: "installation",
      payload: {
        ...installationPayload(r, "created"),
        organization_id: other,
        organizationId: other,
        connection_id: other,
      },
    });
    assertEquals(acknowledged.status, "accepted");
    const routes = await f.pgDatabase.query<{ organization_id: string }>(
      "select organization_id from bakery.inbound_event_routes",
    );
    assertEquals(
      routes.rows.map(({ organization_id }) => organization_id),
      [f.organizationId],
    );
    assertFalse((await receiptText(f)).includes(other));
  });
});

Deno.test("issue 71 receiver security: a caller-supplied request id is echoed only as a short token of safe characters", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const app = receiverApp(f);
    const ask = async (supplied: string) => {
      // No signature: the cheapest refusal, which still carries the request id.
      const response = await app.fetch(
        await deliveryOf(r, {
          event: "issues",
          payload: issuesPayload(r),
          signature: null,
        }).then((request) => {
          request.headers.set("x-request-id", supplied);
          return request;
        }),
      );
      assertEquals(response.status, 401, supplied);
      const text = await response.text();
      return { problem: JSON.parse(text) as Problem, text };
    };

    for (
      const safe of ["ok-id_1.2", "req.123-abc", "a", "A".repeat(128)]
    ) {
      const { problem } = await ask(safe);
      assertEquals(problem.requestId, safe, "a safe token is echoed");
    }

    for (
      const unsafe of [
        "has space",
        'quote"d',
        "<script>alert(1)</script>",
        "a/b",
        "a;b",
        "a,b",
        "A".repeat(129),
        "A".repeat(4096),
        "",
      ]
    ) {
      const { problem, text } = await ask(unsafe);
      assertMatch(problem.requestId, UUID, `a fresh id replaces ${unsafe}`);
      if (unsafe !== "") {
        assertFalse(text.includes(unsafe), "the unsafe value is not echoed");
      }
    }

    // The same id reaches the log line of a refused oversize body.
    const { value: response, lines } = await logged(async () =>
      await receiverApp(f).fetch(
        rawRequest(
          issuesHeaders({
            "content-length": String(INTAKE_MAX_BODY_BYTES + 1),
            "x-request-id": "not safe <b>",
          }),
          new Uint8Array(16),
        ),
      )
    );
    assertEquals(response.status, 413);
    const problem = await response.json() as Problem;
    assertMatch(problem.requestId, UUID);
    assertEquals(lines.length, 1);
    assertEquals(JSON.parse(lines[0]).requestId, problem.requestId);
    assertFalse(lines[0].includes("not safe"));
  });
});
