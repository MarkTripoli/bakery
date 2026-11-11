import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { registerPullRequest } from "../../../apps/server/src/modules/integrations/pull-requests.ts";
import { deleteGitHubAppRegistrationRows } from "../auth.ts";
import { count, type GitHubAppFixture } from "../github-app-registration.ts";
import { formEncodedPayload } from "./signed-delivery.ts";
import { removeSeed, seedTaskAndRepository } from "./seed.ts";
import {
  checkRunPayload,
  checkSuitePayload,
  deliveryOf,
  digestOf,
  enabledReceiver,
  installationPayload,
  instrumentedDatabase,
  issuesPayload,
  pullRequestPayload,
  receipt,
  receiptRow,
  receiptRows,
  receiptText,
  receiverApp,
  routeRows,
  rowCounts,
  selectAndEnable,
  send,
  SHA_A,
  SHA_B,
  SHA_C,
  sharedSecondConnection,
  unselectedResources,
  withFixture,
} from "./receipts-shared.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The design (issue 71, Q4) fixes receipt retention at seven days, past
 * GitHub's three-day redelivery window. It is a literal here, not the module's
 * constant, so changing the constant fails the test instead of moving the
 * expectation with it.
 */
const RETENTION_MS = 7 * DAY_MS;

/** A body with fields the receiver must never keep. */
const CANARY = "canary-issue-title-7f3a";

function noisyIssues(target: { installationId: number; repositoryId: number }) {
  return JSON.stringify({
    ...issuesPayload(target, 1, "opened"),
    issue: { number: 1, title: CANARY, body: CANARY },
    sender: { login: CANARY },
  });
}

async function setInstallationStatus(
  f: GitHubAppFixture,
  installationRowId: string,
  status: string,
): Promise<void> {
  await f.pgDatabase.query(
    "update bakery.integration_installations set status = $2 where id = $1",
    [installationRowId, status],
  );
}

async function setConnectionStatus(
  f: GitHubAppFixture,
  connectionId: string,
  status: string,
): Promise<void> {
  await f.pgDatabase.query(
    "update bakery.integration_connections set status = $2 where id = $1",
    [connectionId, status],
  );
}

async function setConnectionArchived(
  f: GitHubAppFixture,
  connectionId: string,
  archived: boolean,
): Promise<void> {
  await f.pgDatabase.query(
    `update bakery.integration_connections
        set archived_at = case when $2::boolean then now() end
      where id = $1`,
    [connectionId, archived],
  );
}

const NO_ROWS = {
  receipts: 0,
  routes: 0,
  domainEvents: 0,
  outbox: 0,
  audits: 0,
};

/** Asserts a delivery was stored ignored for `reason` and created nothing else. */
async function assertStoredIgnored(
  f: GitHubAppFixture,
  stored: { eventId: string; status: string },
  reason: string,
  label: string,
): Promise<void> {
  assertEquals(stored.status, "ignored", label);
  const row = await receiptRow(f, stored.eventId);
  assertEquals(row.status, "ignored", label);
  assertEquals(row.rejection_reason, reason, label);
  assertEquals((await routeRows(f, stored.eventId)).length, 0, label);
}

Deno.test("issue 71 receipts: a first signed delivery writes one receipt, one route, one domain event, one outbox row and one audit row", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const body = noisyIssues(r);
    const deliveryId = crypto.randomUUID();
    const response = await send(r, { event: "issues", body, deliveryId });
    assertEquals(response.status, 202, await response.clone().text());
    assertEquals(response.headers.get("cache-control"), "no-store");
    const acknowledged = await response.json();
    assertEquals(
      Object.keys(acknowledged).sort(),
      ["eventId", "receivedAt", "status", "taskId"],
    );
    assertEquals(acknowledged.status, "accepted");
    assertEquals(acknowledged.taskId, null);

    const row = await receiptRow(f, acknowledged.eventId);
    assertEquals(row.provider, "github");
    assertEquals(row.registration_id, r.registrationId);
    assertEquals(row.external_delivery_id, deliveryId);
    assertEquals(row.payload_digest, await digestOf(body));
    assertEquals(row.event_kind, "issues");
    assertEquals(row.event_action, "opened");
    assertEquals(row.installation_id, r.installationRowId);
    assertEquals(row.normalized_projection, {
      action: "opened",
      installationId: r.installationId,
      repositoryId: r.repositoryId,
      number: 1,
      headSha: null,
    });
    assertEquals(row.status, "routed");
    assertEquals(row.rejection_reason, null);
    assertEquals(
      row.expires_at.getTime() - row.received_at.getTime(),
      RETENTION_MS,
      "a receipt expires seven days after it arrived",
    );
    assertEquals(
      Date.parse(acknowledged.receivedAt),
      row.received_at.getTime(),
    );

    const routes = await routeRows(f, acknowledged.eventId);
    assertEquals(routes.length, 1);
    const [route] = routes;
    assertEquals(route.organization_id, f.organizationId);
    assertEquals(route.connection_id, r.connection.connectionId);
    assertEquals(route.installation_id, r.installationRowId);
    assertEquals(route.resource_id, r.resource.id);
    assertEquals(route.purpose, "fact_refresh");
    assertEquals(route.status, "pending");
    assertEquals([route.attempts, route.version], [0, 1]);

    const events = await f.pgDatabase.query<{
      organization_id: string;
      aggregate_id: string;
      aggregate_version: number;
      payload: unknown;
    }>(
      `select organization_id, aggregate_id, aggregate_version, payload
         from bakery.domain_events
        where event_type = 'intake.received'
          and payload->>'inboundEventId' = $1`,
      [acknowledged.eventId],
    );
    assertEquals(events.rows.length, 1);
    assertEquals(events.rows[0].organization_id, f.organizationId);
    assertEquals(events.rows[0].aggregate_id, route.id);
    assertEquals(events.rows[0].aggregate_version, 1);
    assertEquals(events.rows[0].payload, {
      inboundEventId: acknowledged.eventId,
    });
    const outbox = await f.pgDatabase.query<{
      delivery_key: string;
      status: string;
      destination: string;
    }>(
      `select delivery_key, status, destination from bakery.outbox
        where event_id in (select id from bakery.domain_events
          where payload->>'inboundEventId' = $1)`,
      [acknowledged.eventId],
    );
    assertEquals(outbox.rows, [{
      delivery_key: `intake:${route.id}`,
      status: "pending",
      destination: "inngest",
    }]);
    const audits = await f.pgDatabase.query<{
      organization_id: string | null;
      principal_id: string | null;
      resource_type: string;
      outcome: string;
      details: unknown;
    }>(
      `select organization_id, principal_id, resource_type, outcome, details
         from bakery.audit_events
        where operation = 'integrationEvents.receive' and resource_id = $1`,
      [acknowledged.eventId],
    );
    assertEquals(audits.rows, [{
      organization_id: null,
      principal_id: null,
      resource_type: "inbound_event",
      outcome: "succeeded",
      details: { eventKind: "issues", routes: 1 },
    }]);
    assertEquals(await rowCounts(f), {
      receipts: 1,
      routes: 1,
      domainEvents: 1,
      outbox: 1,
      audits: 1,
    });
    // The body is never stored: only its digest and the bounded projection.
    assert(
      !(await receiptText(f)).includes(CANARY),
      "no receipt or route holds repository text",
    );
  });
});

Deno.test("issue 71 receipts: an exact duplicate acknowledges the original receipt and writes nothing; changed bytes or event name are refused", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const body = JSON.stringify(issuesPayload(r, 3));
    const deliveryId = crypto.randomUUID();
    const first = await receipt(r, { event: "issues", body, deliveryId });
    assertEquals(first.status, "accepted");
    const counts = await rowCounts(f);
    const text = await receiptText(f);

    const again = await receipt(r, { event: "issues", body, deliveryId });
    assertEquals(again.status, "duplicate");
    assertEquals(again.eventId, first.eventId);
    assertEquals(again.receivedAt, first.receivedAt);
    assertEquals(again.taskId, null);
    assertEquals(await rowCounts(f), counts);
    assertEquals(await receiptText(f), text);

    // The same id with different bytes (even a harmless whitespace change).
    const changed = await send(r, {
      event: "issues",
      body: `${body} `,
      deliveryId,
    });
    assertEquals(changed.status, 422);
    assertEquals((await changed.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    // The same bytes under another event name.
    const renamed = await send(r, { event: "repository", body, deliveryId });
    assertEquals(renamed.status, 422);
    assertEquals((await renamed.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assertEquals(
      await rowCounts(f),
      counts,
      "a refusal makes no second transition",
    );
    assertEquals(await receiptText(f), text);

    // The same bytes under a new delivery id are a new delivery.
    const fresh = await receipt(r, { event: "issues", body });
    assertEquals(fresh.status, "accepted");
    assertNotEquals(fresh.eventId, first.eventId);
    assertEquals((await rowCounts(f)).receipts, 2);
  });
});

Deno.test("issue 71 receipts: eight parallel identical deliveries produce one accepted, seven duplicates and one route", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const options = {
      event: "issues",
      body: JSON.stringify(issuesPayload(r, 9)),
      deliveryId: crypto.randomUUID(),
    };
    const requests = await Promise.all(
      Array.from({ length: 8 }, () => send(r, options)),
    );
    const bodies = await Promise.all(requests.map((response) => {
      assertEquals(response.status, 202);
      return response.json();
    }));
    assertEquals(
      bodies.filter(({ status }) => status === "accepted").length,
      1,
    );
    assertEquals(
      bodies.filter(({ status }) => status === "duplicate").length,
      7,
    );
    assertEquals(new Set(bodies.map(({ eventId }) => eventId)).size, 1);
    assertEquals(await rowCounts(f), {
      receipts: 1,
      routes: 1,
      domainEvents: 1,
      outbox: 1,
      audits: 1,
    });
  });
});

Deno.test("issue 71 receipts: unknown, suspended and revoked installations get one acknowledgement shape, no route and no audit row", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const delivery = async (target: { installationId: number }) => {
      const response = await send(r, {
        event: "issues",
        payload: issuesPayload({ ...r, ...target }, 5),
      });
      assertEquals(response.status, 202, await response.clone().text());
      const text = await response.text();
      return { text, body: JSON.parse(text) as Record<string, unknown> };
    };
    const unknown = await delivery({ installationId: r.installationId + 99 });
    await setInstallationStatus(f, r.installationRowId, "suspended");
    const suspended = await delivery(r);
    await setInstallationStatus(f, r.installationRowId, "revoked");
    const revoked = await delivery(r);

    for (const { body } of [unknown, suspended, revoked]) {
      assertEquals(body.status, "ignored");
      assertEquals(
        Object.keys(body).sort(),
        ["eventId", "receivedAt", "status", "taskId"],
      );
      assertEquals(body.taskId, null);
    }
    // Nothing identifies the account, an organization, a connection or the
    // installation in what GitHub is told.
    const installation = (await f.pgDatabase.query<{ account_login: string }>(
      "select account_login from bakery.integration_installations",
    )).rows[0];
    for (const { text } of [unknown, suspended, revoked]) {
      for (
        const secretValue of [
          installation.account_login,
          f.organizationId,
          r.connection.connectionId,
          r.installationRowId,
          String(r.installationId),
          r.resource.display_name,
        ]
      ) {
        assert(!text.includes(secretValue), `${secretValue} not disclosed`);
      }
    }
    const rows = await receiptRows(f);
    assertEquals(rows.length, 3);
    assertEquals(
      rows.map(({ status, rejection_reason }) => [status, rejection_reason]),
      [
        ["ignored", "unknown_installation"],
        ["ignored", "installation_suspended"],
        ["ignored", "installation_revoked"],
      ],
    );
    assertEquals(rows[0].installation_id, null);
    assertEquals(rows[1].installation_id, r.installationRowId);
    assertEquals(await rowCounts(f), {
      receipts: 3,
      routes: 0,
      domainEvents: 0,
      outbox: 0,
      audits: 0,
    });
    for (const row of rows) {
      assertEquals(
        row.expires_at.getTime() - row.received_at.getTime(),
        RETENTION_MS,
        "ignored receipts expire too",
      );
    }
  });
});

Deno.test("issue 71 receipts: an installation lifecycle event routes while suspended and an unsuspend never re-routes older receipts", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    await setInstallationStatus(f, r.installationRowId, "suspended");
    const ignoredBody = JSON.stringify(issuesPayload(r, 11));
    const ignoredId = crypto.randomUUID();
    const during = await receipt(r, {
      event: "issues",
      body: ignoredBody,
      deliveryId: ignoredId,
    });
    assertEquals(during.status, "ignored");

    const suspend = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "suspend"),
    });
    assertEquals(suspend.status, "accepted");
    const suspendRoutes = await routeRows(f, suspend.eventId);
    assertEquals(suspendRoutes.length, 1);
    assertEquals(suspendRoutes[0].purpose, "installation_reconcile");
    assertEquals(suspendRoutes[0].resource_id, null);
    assertEquals(suspendRoutes[0].connection_id, r.connection.connectionId);

    // The installation recovers; its unsuspend routes by itself.
    await setInstallationStatus(f, r.installationRowId, "enabled");
    const unsuspend = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "unsuspend"),
    });
    assertEquals(unsuspend.status, "accepted");
    assertEquals((await routeRows(f, unsuspend.eventId)).length, 1);
    assertEquals(
      (await routeRows(f, during.eventId)).length,
      0,
      "the receipt from the suspension is not re-routed",
    );
    // Its redelivery after recovery is a duplicate and creates nothing either.
    const before = await rowCounts(f);
    const again = await receipt(r, {
      event: "issues",
      body: ignoredBody,
      deliveryId: ignoredId,
    });
    assertEquals(again.status, "duplicate");
    assertEquals(again.eventId, during.eventId);
    assertEquals(await rowCounts(f), before);
    assertEquals((await routeRows(f, during.eventId)).length, 0);
  });
});

Deno.test("issue 71 receipts: repository and installation_repositories events route as discovery to the right connections", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { organizationId, second } = await sharedSecondConnection(r);
    // The second organization selects another repository of the installation.
    const other = second.resources.find((row) =>
      row.external_id !== r.resource.external_id
    )!;
    await selectAndEnable(f, second.connectionId, other, organizationId);

    const repository = await receipt(r, {
      event: "repository",
      payload: {
        action: "renamed",
        repository: { id: r.repositoryId },
        installation: { id: r.installationId },
      },
    });
    assertEquals(repository.status, "accepted");
    const repositoryRoutes = await routeRows(f, repository.eventId);
    assertEquals(repositoryRoutes.length, 1, "only the selecting organization");
    assertEquals(repositoryRoutes[0].organization_id, f.organizationId);
    assertEquals(repositoryRoutes[0].connection_id, r.connection.connectionId);
    assertEquals(repositoryRoutes[0].resource_id, r.resource.id);
    assertEquals(repositoryRoutes[0].purpose, "discovery");

    const otherRepository = await receipt(r, {
      event: "repository",
      payload: {
        action: "archived",
        repository: { id: Number(other.external_id) },
        installation: { id: r.installationId },
      },
    });
    const otherRoutes = await routeRows(f, otherRepository.eventId);
    assertEquals(otherRoutes.length, 1);
    assertEquals(otherRoutes[0].organization_id, organizationId);
    assertEquals(otherRoutes[0].connection_id, second.connectionId);
    assertEquals(otherRoutes[0].resource_id, other.id);

    // A repository nobody selected reaches no organization.
    const unselected = unselectedResources(r).find((row) =>
      row.external_id !== other.external_id
    )!;
    const none = await receipt(r, {
      event: "repository",
      payload: {
        action: "created",
        repository: { id: Number(unselected.external_id) },
        installation: { id: r.installationId },
      },
    });
    assertEquals(none.status, "ignored");
    assertEquals(
      (await receiptRow(f, none.eventId)).rejection_reason,
      "unselected_repository",
    );
    assertEquals((await routeRows(f, none.eventId)).length, 0);

    // The set of repositories changed: every live connection of the installation.
    const changed = await receipt(r, {
      event: "installation_repositories",
      payload: installationPayload(r, "added"),
    });
    const changedRoutes = await routeRows(f, changed.eventId);
    assertEquals(changedRoutes.length, 2);
    assertEquals(
      changedRoutes.map(({ organization_id }) => organization_id).sort(),
      [f.organizationId, organizationId].sort(),
    );
    for (const route of changedRoutes) {
      assertEquals(route.purpose, "discovery");
      assertEquals(route.resource_id, null);
    }
    // One domain event and outbox row per route, one audit row per receipt.
    assertEquals(await rowCounts(f), {
      receipts: 4,
      routes: 4,
      domainEvents: 4,
      outbox: 4,
      audits: 3,
    });
  });
});

Deno.test("issue 71 receipts: pull request and check events route only for a tracked pull request", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const seed = await seedTaskAndRepository(f, r.resource);
    try {
      const events = (headSha: string) =>
        [
          ["pull_request", pullRequestPayload(r, 7, headSha)],
          ["check_run", checkRunPayload(r, headSha)],
          ["check_suite", checkSuitePayload(r, headSha)],
        ] as const;
      for (const [event, payload] of events(SHA_A)) {
        const untracked = await receipt(r, { event, payload });
        assertEquals(untracked.status, "ignored", event);
        assertEquals(
          (await receiptRow(f, untracked.eventId)).rejection_reason,
          "untracked_pull_request",
          event,
        );
        assertEquals((await routeRows(f, untracked.eventId)).length, 0, event);
      }
      assertEquals(await rowCounts(f), {
        receipts: 3,
        routes: 0,
        domainEvents: 0,
        outbox: 0,
        audits: 0,
      });

      await withPgTransaction(
        f.runtimePgDatabase!,
        (transaction) =>
          registerPullRequest(transaction, {
            organizationId: f.organizationId,
            taskId: seed.taskId,
            repositoryId: seed.repositoryId,
            providerNumber: 7,
            url: "https://github.com/example/repo/pull/7",
            headSha: SHA_A,
            baseSha: SHA_B,
          }),
      );
      for (const [event, payload] of events(SHA_A)) {
        const tracked = await receipt(r, { event, payload });
        assertEquals(tracked.status, "accepted", event);
        const routes = await routeRows(f, tracked.eventId);
        assertEquals(routes.length, 1, event);
        assertEquals(routes[0].purpose, "fact_refresh", event);
        assertEquals(routes[0].resource_id, r.resource.id, event);
      }
      // A pull request that moved to a new head still matches by number; a
      // check on a head no tracked pull request has does not.
      const synchronized = await receipt(r, {
        event: "pull_request",
        payload: pullRequestPayload(r, 7, SHA_C),
      });
      assertEquals(synchronized.status, "accepted");
      const stranger = await receipt(r, {
        event: "check_run",
        payload: checkRunPayload(r, SHA_C),
      });
      assertEquals(stranger.status, "ignored");
      const otherNumber = await receipt(r, {
        event: "pull_request",
        payload: pullRequestPayload(r, 8, SHA_A),
      });
      assertEquals(otherNumber.status, "ignored");
      assertEquals(
        (await receiptRow(f, otherNumber.eventId)).rejection_reason,
        "untracked_pull_request",
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 receipts: ping, an unsupported event and a delivery without an installation are stored ignored with no route", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);

    const ping = await receipt(r, {
      event: "ping",
      payload: {
        zen: "Keep it logically awesome.",
        installation: { id: r.installationId },
      },
    });
    assertEquals(ping.status, "ignored");
    const pingRow = await receiptRow(f, ping.eventId);
    assertEquals(pingRow.rejection_reason, "ping");
    assertEquals(pingRow.installation_id, r.installationRowId);

    // A resource event GitHub sent without an installation.
    const bare = await receipt(r, {
      event: "issues",
      payload: {
        action: "opened",
        issue: { number: 1 },
        repository: { id: r.repositoryId },
      },
    });
    assertEquals(
      (await receiptRow(f, bare.eventId)).rejection_reason,
      "no_installation",
    );

    // An event Bakery does not parse is acknowledged without reading its body.
    const unsupportedBody = `not json at all ${CANARY}`;
    const unsupported = await receipt(r, {
      event: "star",
      body: unsupportedBody,
    });
    assertEquals(unsupported.status, "ignored");
    const unsupportedRow = await receiptRow(f, unsupported.eventId);
    assertEquals(unsupportedRow.rejection_reason, "unsupported_event");
    assertEquals(unsupportedRow.event_kind, "star");
    assertEquals(unsupportedRow.event_action, null);
    assertEquals(unsupportedRow.normalized_projection, null);
    assertEquals(
      unsupportedRow.payload_digest,
      await digestOf(unsupportedBody),
    );

    assertEquals(await rowCounts(f), {
      receipts: 3,
      routes: 0,
      domainEvents: 0,
      outbox: 0,
      audits: 0,
    });
    assert(!(await receiptText(f)).includes(CANARY));
  });
});

Deno.test("issue 71 receipts: a signed github_app_authorization delivery is acknowledged ignored, with one receipt and no route", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    // A user revoking the App's authorization names no installation, so the
    // event cannot reach a connection even though its family is installation
    // reconciliation. The receipt is checked for an installation id first.
    const body = JSON.stringify({
      action: "revoked",
      sender: { login: CANARY },
    });
    const response = await send(r, {
      event: "github_app_authorization",
      body,
    });
    assertEquals(response.status, 202, await response.clone().text());
    const acknowledged = await response.json();
    assertEquals(acknowledged.status, "ignored");
    assertEquals(acknowledged.taskId, null);
    const rows = await receiptRows(f);
    assertEquals(rows.length, 1, "one receipt");
    assertEquals(rows[0].id, acknowledged.eventId);
    assertEquals(rows[0].status, "ignored");
    assertEquals(rows[0].rejection_reason, "no_installation");
    assertEquals(rows[0].installation_id, null);
    assertEquals(rows[0].event_kind, "github_app_authorization");
    assertEquals(rows[0].event_action, "revoked");
    assertEquals(rows[0].payload_digest, await digestOf(body));
    assertEquals(rows[0].normalized_projection, {
      action: "revoked",
      installationId: null,
      repositoryId: null,
      number: null,
      headSha: null,
    });
    assertEquals((await routeRows(f)).length, 0, "zero routes");
    assertEquals(await rowCounts(f), {
      receipts: 1,
      routes: 0,
      domainEvents: 0,
      outbox: 0,
      audits: 0,
    });
    assert(!(await receiptText(f)).includes(CANARY));
  });
});

Deno.test("issue 71 receipts: a form-encoded delivery routes like the JSON one and the digest covers the form bytes", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const body = formEncodedPayload(JSON.stringify(issuesPayload(r, 21)));
    const formed = await receipt(r, {
      event: "issues",
      body,
      contentType: "application/x-www-form-urlencoded",
    });
    assertEquals(formed.status, "accepted");
    assertEquals(
      (await receiptRow(f, formed.eventId)).payload_digest,
      await digestOf(body),
    );
    const routes = await routeRows(f, formed.eventId);
    assertEquals(routes.length, 1);
    assertEquals(routes[0].resource_id, r.resource.id);
    assertEquals(
      (await receiptRow(f, formed.eventId)).normalized_projection?.number,
      21,
    );
  });
});

Deno.test("issue 71 receipts: deleting a registration's rows clears receipts of a known installation and of an unknown one", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const known = await receipt(r, {
      event: "issues",
      payload: issuesPayload(r, 31),
    });
    const unknown = await receipt(r, {
      event: "issues",
      payload: issuesPayload(
        { ...r, installationId: r.installationId + 77 },
        32,
      ),
    });
    assertEquals(known.status, "accepted");
    assertEquals(unknown.status, "ignored");
    const rows = await receiptRows(f);
    assertEquals(
      rows.map(({ installation_id }) => installation_id === null).sort(),
      [false, true],
      "one receipt names its installation row and one has a null installation_id",
    );
    assertEquals((await routeRows(f)).length, 1);

    // The shared cleanup order must remove receipts before the installation,
    // connection and registration rows they reference.
    await deleteGitHubAppRegistrationRows(
      f.pgDatabase,
      "select id from bakery.principals",
      [],
    );
    assertEquals(
      await count(f, "select count(*) from bakery.inbound_events"),
      0,
    );
    assertEquals(
      await count(f, "select count(*) from bakery.inbound_event_routes"),
      0,
    );
    assertEquals(
      await count(
        f,
        "select count(*) from bakery.integration_app_registrations",
      ),
      0,
    );
    assertEquals(
      await count(f, "select count(*) from bakery.integration_installations"),
      0,
    );
  });
});

Deno.test("issue 71 receipts: a database failure while committing answers a retryable 503 and leaves no row", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database });
    const deliver = async (deliveryId: string) =>
      await app.fetch(
        await deliveryOf(r, {
          event: "issues",
          payload: issuesPayload(r, 41),
          deliveryId,
        }),
      );

    // The statement that settles the receipt fails after the receipt, the
    // route, the domain event and the outbox row were written in the same
    // transaction: all of it rolls back.
    state.failing = "update bakery.inbound_events";
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (line: unknown) => warnings.push(String(line));
    let failed: Response;
    try {
      failed = await deliver(crypto.randomUUID());
    } finally {
      console.warn = warn;
    }
    assertEquals(failed.status, 503);
    const problem = await failed.json();
    assertEquals(problem.code, "DEPENDENCY_UNAVAILABLE");
    assertEquals(problem.retryable, true);
    assertEquals(await rowCounts(f), {
      receipts: 0,
      routes: 0,
      domainEvents: 0,
      outbox: 0,
      audits: 0,
    });
    assertEquals(warnings.length, 1);
    const line = JSON.parse(warnings[0]);
    assertEquals(line.event, "github_webhook_unavailable");
    assertEquals(line.stage, "commit");
    assert(!warnings[0].includes(r.secret));

    // Checking out a connection can fail too; nothing is written then either.
    state.failing = null;
    state.connectFails = true;
    const unreachable = await deliver(crypto.randomUUID());
    assertEquals(unreachable.status, 503);
    assertEquals((await rowCounts(f)).receipts, 0);

    // The same delivery succeeds once the database is back.
    state.connectFails = false;
    const deliveryId = crypto.randomUUID();
    const recovered = await deliver(deliveryId);
    assertEquals(recovered.status, 202);
    assertEquals((await recovered.json()).status, "accepted");
    assertEquals((await rowCounts(f)).receipts, 1);
  });
});

Deno.test("issue 71 receipts: a pending installation stores installation_pending and routes nothing until it is enabled", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    await setInstallationStatus(f, r.installationRowId, "pending");
    const waiting = await receipt(r, {
      event: "issues",
      payload: issuesPayload(r, 51),
    });
    await assertStoredIgnored(f, waiting, "installation_pending", "pending");
    assertEquals(
      (await receiptRow(f, waiting.eventId)).installation_id,
      r.installationRowId,
      "the receipt still names the installation row it found",
    );
    assertEquals(await rowCounts(f), { ...NO_ROWS, receipts: 1 });

    // Control: the same delivery shape routes once the installation is enabled.
    await setInstallationStatus(f, r.installationRowId, "enabled");
    const enabled = await receipt(r, {
      event: "issues",
      payload: issuesPayload(r, 52),
    });
    assertEquals(enabled.status, "accepted");
    assertEquals((await routeRows(f, enabled.eventId)).length, 1);
  });
});

Deno.test("issue 71 receipts: lifecycle events reach only live connections and store no_live_connection when none is left", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { second } = await sharedSecondConnection(r);
    const first = r.connection.connectionId;
    const routedTo = async (stored: { eventId: string }) =>
      (await routeRows(f, stored.eventId)).map(({ connection_id }) =>
        connection_id
      ).sort();

    // A connection that is not yet enabled is still live: it follows the installation.
    const both = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "created"),
    });
    assertEquals(both.status, "accepted");
    assertEquals(await routedTo(both), [first, second.connectionId].sort());

    // A revoked connection is no longer live and gets no route; its sibling does.
    await setConnectionStatus(f, second.connectionId, "revoked");
    const sibling = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "unsuspend"),
    });
    assertEquals(sibling.status, "accepted");
    assertEquals(await routedTo(sibling), [first]);
    const repositories = await receipt(r, {
      event: "installation_repositories",
      payload: installationPayload(r, "added"),
    });
    assertEquals(await routedTo(repositories), [first]);

    // Every connection revoked: acknowledged, stored ignored, nothing created.
    await setConnectionStatus(f, first, "revoked");
    const before = await rowCounts(f);
    for (const event of ["installation", "installation_repositories"]) {
      const none = await receipt(r, {
        event,
        payload: installationPayload(r, "removed"),
      });
      await assertStoredIgnored(f, none, "no_live_connection", event);
      assertEquals(
        (await receiptRow(f, none.eventId)).installation_id,
        r.installationRowId,
      );
    }
    assertEquals(await rowCounts(f), {
      ...before,
      receipts: before.receipts + 2,
    });

    // An archived connection is not live either, whatever its status says.
    await setConnectionStatus(f, first, "enabled");
    await setConnectionArchived(f, first, true);
    const archived = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "suspend"),
    });
    await assertStoredIgnored(f, archived, "no_live_connection", "archived");

    // Control: un-archived, the same event routes to it again.
    await setConnectionArchived(f, first, false);
    const restored = await receipt(r, {
      event: "installation",
      payload: installationPayload(r, "unsuspend"),
    });
    assertEquals(restored.status, "accepted");
    assertEquals(await routedTo(restored), [first]);
  });
});

Deno.test("issue 71 receipts: a connection that is not enabled receives no resource or repository event", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const connectionId = r.connection.connectionId;
    const events = (number: number) =>
      [
        ["issues", issuesPayload(r, number)],
        [
          "repository",
          {
            action: "renamed",
            repository: { id: r.repositoryId },
            installation: { id: r.installationId },
          },
        ],
      ] as const;
    let number = 60;
    for (const status of ["disabled", "pending", "revoked"]) {
      await setConnectionStatus(f, connectionId, status);
      for (const [event, payload] of events(number++)) {
        const stored = await receipt(r, { event, payload });
        await assertStoredIgnored(
          f,
          stored,
          "connection_not_enabled",
          `${event} for a ${status} connection`,
        );
      }
    }
    assertEquals((await rowCounts(f)).routes, 0);
    assertEquals((await rowCounts(f)).audits, 0);

    // Control: enabled again, the same events route.
    await setConnectionStatus(f, connectionId, "enabled");
    for (const [event, payload] of events(number)) {
      const stored = await receipt(r, { event, payload });
      assertEquals(stored.status, "accepted", event);
      assertEquals((await routeRows(f, stored.eventId)).length, 1, event);
    }
  });
});

Deno.test("issue 71 receipts: a resource that is unavailable or archived, or on an archived connection, is not routed", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const resourceId = r.resource.id;
    const connectionId = r.connection.connectionId;
    const states: {
      name: string;
      apply: () => Promise<unknown>;
      repair: () => Promise<unknown>;
    }[] = [
      {
        name: "unavailable resource",
        apply: () =>
          f.pgDatabase.query(
            "update bakery.integration_resources set available = false where id = $1",
            [resourceId],
          ),
        repair: () =>
          f.pgDatabase.query(
            "update bakery.integration_resources set available = true where id = $1",
            [resourceId],
          ),
      },
      {
        name: "archived resource",
        apply: () =>
          f.pgDatabase.query(
            "update bakery.integration_resources set archived_at = now() where id = $1",
            [resourceId],
          ),
        repair: () =>
          f.pgDatabase.query(
            "update bakery.integration_resources set archived_at = null where id = $1",
            [resourceId],
          ),
      },
      {
        name: "archived connection",
        apply: () => setConnectionArchived(f, connectionId, true),
        repair: () => setConnectionArchived(f, connectionId, false),
      },
    ];
    let number = 70;
    for (const { name, apply, repair } of states) {
      const routesBefore = (await rowCounts(f)).routes;
      await apply();
      for (
        const [event, payload] of [
          ["issues", issuesPayload(r, number++)],
          [
            "repository",
            {
              action: "archived",
              repository: { id: r.repositoryId },
              installation: { id: r.installationId },
            },
          ],
        ] as const
      ) {
        const stored = await receipt(r, { event, payload });
        await assertStoredIgnored(
          f,
          stored,
          "unselected_repository",
          `${event} for an ${name}`,
        );
      }
      assertEquals((await rowCounts(f)).routes, routesBefore, name);
      // Control: repaired, the same repository routes again.
      await repair();
      const routed = await receipt(r, {
        event: "issues",
        payload: issuesPayload(r, number++),
      });
      assertEquals(routed.status, "accepted", `repaired ${name}`);
      assertEquals((await routeRows(f, routed.eventId)).length, 1, name);
    }
    assertEquals((await rowCounts(f)).audits, states.length);
  });
});

Deno.test("issue 71 receipts: a deadline that fires inside the database stage answers a retryable 503 and persists nothing", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database, deadlineMs: 800 });
    const deliveryId = crypto.randomUUID();
    const deliver = async () =>
      await app.fetch(
        await deliveryOf(r, {
          event: "issues",
          payload: issuesPayload(r, 81),
          deliveryId,
        }),
      );
    const quietly = async <T>(work: () => Promise<T>) => {
      const warn = console.warn;
      const lines: string[] = [];
      console.warn = (line: unknown) => lines.push(String(line));
      try {
        return { value: await work(), lines };
      } finally {
        console.warn = warn;
      }
    };

    // The statement that settles the receipt runs after the receipt, its
    // route, domain event and outbox row were written; it hangs, and the
    // deadline makes the server cancel it (SQLSTATE 57014). That is a database
    // failure, so it is the retryable 503 a failed delivery shows, not a 504.
    state.stalling = "update bakery.inbound_events";
    const started = performance.now();
    const { value: stalled, lines } = await quietly(deliver);
    const elapsed = performance.now() - started;
    assertEquals(stalled.status, 503);
    const problem = await stalled.json();
    assertEquals(problem.code, "DEPENDENCY_UNAVAILABLE");
    assertEquals(problem.retryable, true);
    assert(elapsed < 10_000, `the statement was cancelled (${elapsed} ms)`);
    assertEquals(await rowCounts(f), NO_ROWS, "everything rolled back");
    assertEquals(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assertEquals(line.event, "github_webhook_unavailable");
    assertEquals(line.stage, "commit");
    assertFalse(lines[0].includes(r.secret));

    // Nothing was kept, so GitHub's redelivery of the same id is a first delivery.
    state.stalling = null;
    const retried = await deliver();
    assertEquals(retried.status, 202);
    assertEquals((await retried.json()).status, "accepted");
    assertEquals((await rowCounts(f)).receipts, 1);
  });
});

Deno.test("issue 71 receipts: a deadline that fires between two database statements answers a retryable 504 and persists nothing", async () => {
  await withFixture(async (f) => {
    const r = await enabledReceiver(f);
    const { database, state } = instrumentedDatabase(f.runtimePgDatabase!);
    const app = receiverApp(f, { database, deadlineMs: 800 });
    // The settling statement is held back in the process, not in the
    // database, so the deadline fires while no statement is running. The
    // transaction helper refuses the next statement with an AbortError, which
    // is the one case the route maps to DEPENDENCY_TIMEOUT.
    state.delaying = { fragment: "update bakery.inbound_events", ms: 1_500 };
    const response = await app.fetch(
      await deliveryOf(r, {
        event: "issues",
        payload: issuesPayload(r, 82),
      }),
    );
    assertEquals(response.status, 504);
    const problem = await response.json();
    assertEquals(problem.code, "DEPENDENCY_TIMEOUT");
    assertEquals(problem.retryable, true);
    assertEquals(await rowCounts(f), NO_ROWS, "everything rolled back");
  });
});
