import { assert, assertEquals } from "@std/assert";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  readUpdatePolicy,
  recordUpdateEvent,
  UPDATE_EVENT_OPERATION,
  type UpdateEventInput,
  UpdateEventKind,
} from "../../apps/server/src/platform/update-history.ts";

/**
 * #59 slice 3 (server asks 2, 3, 7 and 12 to 15) against real Postgres: the
 * update policy the launcher reads, the history it writes as the database
 * owner, and what the Updates page reads back: which release runs, the kept
 * release, the history as a keyset page, and the last failed update until it
 * is dismissed. The launcher never goes through Bakery's API; the reads do.
 */

const STATUS = "/v1/installation/updates/status";
const LIST = "/v1/installation/updates";
const SETTINGS = "/v1/installation/settings";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 21, 12, minute, 0, 0));

type Event = {
  id: string;
  kind: string;
  at: string;
  by: string | null;
  fromRelease: string | null;
  toRelease: string | null;
  detail: string | null;
  dismissedAt: string | null;
};
type Status = {
  runningRelease: string;
  runningSince: string | null;
  healthy: boolean;
  previousRelease: string | null;
  previousRanFrom: string | null;
  previousRanUntil: string | null;
  lastFailure: Event | null;
};
type Page = { items: Event[]; nextCursor: string | null };

async function clear(o: BackupSettingsFixture) {
  await o.f.pgDatabase.query("delete from bakery.installation_update_history");
  await o.f.pgDatabase.query(
    `update bakery.installation_settings
        set update_failure_policy = 'go_back' where id = true`,
  );
  await o.f.pgDatabase.query(
    `delete from bakery.audit_events
      where operation in ($1, 'installationUpdates.dismiss')`,
    [UPDATE_EVENT_OPERATION],
  );
}

async function withFixture<T>(work: (o: BackupSettingsFixture) => Promise<T>) {
  const o = await openBackupSettingsFixture();
  try {
    await clear(o);
    return await work(o);
  } finally {
    try {
      await clear(o);
    } finally {
      await o.finish();
    }
  }
}

let counter = 0;
const id = () =>
  `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const record = (
  o: BackupSettingsFixture,
  event: Partial<UpdateEventInput> & {
    kind: UpdateEventKind;
    occurredAt: Date;
  },
) =>
  withPgTransaction(
    o.f.pgDatabase,
    (transaction) =>
      recordUpdateEvent(transaction, {
        id: id(),
        byName: "mark",
        fromRelease: null,
        toRelease: null,
        detail: null,
        ...event,
      }),
  );

const status = async (o: BackupSettingsFixture) => {
  const response = await o.admin("GET", STATUS);
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as Status;
};

/** The release this server runs, as anyone can read it. */
async function runningRelease(o: BackupSettingsFixture): Promise<string> {
  const response = await o.f.app.request("/v1/installation/status");
  const body = await response.json() as { release: string };
  assert(/^.+$/.test(body.release), "the public status names the release");
  return body.release;
}

Deno.test("the policy is go_back until an administrator picks ask; leaving it out keeps the choice", () =>
  withFixture(async (o) => {
    const read = () =>
      withPgTransaction(o.f.pgDatabase, (t) => readUpdatePolicy(t));
    assertEquals((await read()).onFailure, "go_back");
    const settings = async () =>
      await (await o.admin("GET", SETTINGS)).json() as {
        version: number;
        registrationMode: string;
        organizationCreationPolicy: string;
        updateFailurePolicy: string;
      };
    let current = await settings();
    assertEquals(current.updateFailurePolicy, "go_back");
    const patch = async (extra: Record<string, unknown>) => {
      const response = await o.admin("PATCH", SETTINGS, {
        registrationMode: current.registrationMode,
        organizationCreationPolicy: current.organizationCreationPolicy,
        ...extra,
      }, { keyed: true, version: current.version });
      assertEquals(response.status, 200, await response.clone().text());
      current = await response.json();
      return current;
    };
    assertEquals(
      (await patch({ updateFailurePolicy: "ask" })).updateFailurePolicy,
      "ask",
    );
    assertEquals(
      (await read()).onFailure,
      "ask",
      "the launcher reads it from the database",
    );
    assertEquals(
      (await patch({})).updateFailurePolicy,
      "ask",
      "a caller that predates the field leaves the choice alone",
    );
    assertEquals((await read()).onFailure, "ask");
    const refused = await o.admin("PATCH", SETTINGS, {
      registrationMode: current.registrationMode,
      organizationCreationPolicy: current.organizationCreationPolicy,
      updateFailurePolicy: "whenever",
    }, { keyed: true, version: current.version });
    assert(
      refused.status >= 400 && refused.status < 500,
      String(refused.status),
    );
    await refused.body?.cancel();
    assertEquals(
      (await read()).onFailure,
      "ask",
      "a bad value changes nothing",
    );
    await patch({ updateFailurePolicy: "go_back" });
    assertEquals((await read()).onFailure, "go_back");
  }));

Deno.test("recording an event twice stores it once and audits it once", () =>
  withFixture(async (o) => {
    const event = {
      id: id(),
      kind: UpdateEventKind.Updated,
      occurredAt: at(1),
      byName: "mark",
      fromRelease: A,
      toRelease: B,
      detail: null,
    };
    const send = () =>
      withPgTransaction(o.f.pgDatabase, (t) => recordUpdateEvent(t, event));
    assertEquals((await send()).recorded, true);
    assertEquals(
      (await send()).recorded,
      false,
      "the launcher resends what it could not record",
    );
    const rows = await o.f.pgDatabase.query<{ n: number }>(
      `select count(*)::integer as n from bakery.installation_update_history
        where id = $1`,
      [event.id],
    );
    assertEquals(rows.rows[0].n, 1);
    const audits = await o.f.pgDatabase.query<{ n: number; details: string }>(
      `select count(*)::integer as n, max(details::text) as details
         from bakery.audit_events where operation = $1 and resource_id = $2`,
      [UPDATE_EVENT_OPERATION, event.id],
    );
    assertEquals(audits.rows[0].n, 1);
    assert(audits.rows[0].details.includes(B), "release ids only");
  }));

Deno.test("status names the running release, how long, and the release the launcher keeps", () =>
  withFixture(async (o) => {
    const running = await runningRelease(o);
    const empty = await status(o);
    assertEquals(empty.runningRelease, running);
    assertEquals(empty.healthy, true);
    assertEquals(empty.runningSince, null, "nothing recorded yet");
    assertEquals(empty.previousRelease, null);
    assertEquals(empty.lastFailure, null);

    // The kept release is A, which ran from minute 1 to minute 9.
    await record(o, {
      kind: UpdateEventKind.Installed,
      occurredAt: at(1),
      toRelease: A,
    });
    await record(o, {
      kind: UpdateEventKind.Updated,
      occurredAt: at(9),
      fromRelease: A,
      toRelease: running,
    });
    const after = await status(o);
    assertEquals(after.runningSince, at(9).toISOString());
    assertEquals(after.previousRelease, A);
    assertEquals(after.previousRanFrom, at(1).toISOString());
    assertEquals(after.previousRanUntil, at(9).toISOString());

    // An update that failed and went back changes nothing about what is kept.
    await record(o, {
      kind: UpdateEventKind.WentBack,
      occurredAt: at(20),
      byName: null,
      fromRelease: C,
      toRelease: running,
    });
    const failed = await status(o);
    assertEquals(failed.previousRelease, A);
    assertEquals(failed.lastFailure?.kind, "went_back");
    assertEquals(failed.lastFailure?.by, null, "Bakery went back by itself");
    assertEquals(failed.lastFailure?.fromRelease, C);
  }));

Deno.test("the kept release is not guessed when the history does not end at the running one", () =>
  withFixture(async (o) => {
    await record(o, {
      kind: UpdateEventKind.Updated,
      occurredAt: at(5),
      fromRelease: A,
      toRelease: B,
    });
    const body = await status(o);
    assertEquals(body.previousRelease, null);
    assertEquals(body.previousRanUntil, null);
    assertEquals(body.runningSince, null);
  }));

Deno.test("the last failure shows until it is dismissed or a later update succeeds, and stays in the history", () =>
  withFixture(async (o) => {
    const running = await runningRelease(o);
    const failure = await record(o, {
      kind: UpdateEventKind.DecidedGoBack,
      occurredAt: at(3),
      fromRelease: C,
      toRelease: running,
    });
    assert(failure.recorded);
    const shown = (await status(o)).lastFailure;
    assertEquals(shown?.kind, "decided_go_back");
    assertEquals(shown?.by, "mark");

    const first = await o.admin(
      "POST",
      `${LIST}/${shown!.id}/dismiss`,
      undefined,
      {
        keyed: true,
      },
    );
    assertEquals(first.status, 200, await first.clone().text());
    const dismissed = await first.json() as Event;
    assert(dismissed.dismissedAt !== null);
    assertEquals((await status(o)).lastFailure, null);
    const again = await o.admin(
      "POST",
      `${LIST}/${shown!.id}/dismiss`,
      undefined,
      {
        keyed: true,
      },
    );
    assertEquals(
      (await again.json() as Event).dismissedAt,
      dismissed.dismissedAt,
      "dismissing again changes nothing",
    );
    const listed = await (await o.admin("GET", LIST)).json() as Page;
    assertEquals(listed.items.length, 1, "the row stays in the history");

    // A new failure shows again; a later successful update clears it.
    await record(o, {
      kind: UpdateEventKind.WentBack,
      occurredAt: at(10),
      byName: null,
      fromRelease: C,
      toRelease: running,
    });
    assertEquals((await status(o)).lastFailure?.kind, "went_back");
    await record(o, {
      kind: UpdateEventKind.Updated,
      occurredAt: at(11),
      fromRelease: running,
      toRelease: C,
    });
    assertEquals((await status(o)).lastFailure, null);
  }));

Deno.test("only a failure can be dismissed, an unknown id is 404, and only an administrator may", () =>
  withFixture(async (o) => {
    const updated = await record(o, {
      kind: UpdateEventKind.Updated,
      occurredAt: at(2),
      fromRelease: A,
      toRelease: B,
    });
    assert(updated.recorded);
    const rows = await (await o.admin("GET", LIST)).json() as Page;
    const notice = rows.items[0];
    const refused = await o.admin(
      "POST",
      `${LIST}/${notice.id}/dismiss`,
      undefined,
      {
        keyed: true,
      },
    );
    assertEquals(refused.status, 404, "an update is not a notice");
    await refused.body?.cancel();
    const unknown = await o.admin(
      "POST",
      `${LIST}/${id()}/dismiss`,
      undefined,
      {
        keyed: true,
      },
    );
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();

    await record(o, {
      kind: UpdateEventKind.WentBack,
      occurredAt: at(4),
      byName: null,
      fromRelease: C,
      toRelease: A,
    });
    const failure = (await status(o)).lastFailure!;
    const developer = await o.admin(
      "POST",
      `${LIST}/${failure.id}/dismiss`,
      undefined,
      {
        keyed: true,
        cookie: o.f.developerCookie,
      },
    );
    assertEquals(developer.status, 403, await developer.clone().text());
    await developer.body?.cancel();
    assertEquals((await status(o)).lastFailure?.dismissedAt, null);
    for (const path of [STATUS, LIST]) {
      const read = await o.admin("GET", path, undefined, {
        cookie: o.f.developerCookie,
      });
      assertEquals(read.status, 403, path);
      await read.body?.cancel();
    }
  }));

Deno.test("the history is a keyset page, newest first, that does not skip or repeat a row", () =>
  withFixture(async (o) => {
    const kinds = [
      UpdateEventKind.Installed,
      UpdateEventKind.Updated,
      UpdateEventKind.Refused,
      UpdateEventKind.RolledBack,
      UpdateEventKind.Interrupted,
    ];
    // Two events share a minute: the id breaks the tie.
    const minutes = [1, 2, 3, 3, 4];
    for (const [index, kind] of kinds.entries()) {
      await record(o, {
        kind,
        occurredAt: at(minutes[index]),
        fromRelease: A,
        toRelease: B,
        detail: kind === UpdateEventKind.Refused
          ? "This release could not be verified, so nothing was changed."
          : null,
      });
    }
    const seen: Event[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = cursor === null
        ? `${LIST}?limit=2`
        : `${LIST}?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const response = await o.admin("GET", url);
      assertEquals(response.status, 200, await response.clone().text());
      const page = await response.json() as Page;
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    assertEquals(pages, 3);
    assertEquals(seen.length, 5);
    assertEquals(new Set(seen.map((e) => e.id)).size, 5, "no row repeats");
    const times = seen.map((e) => e.at);
    assertEquals(times, [...times].sort().reverse());
    assertEquals(
      seen.find((e) => e.kind === "refused")?.detail,
      "This release could not be verified, so nothing was changed.",
    );
    const bad = await o.admin("GET", `${LIST}?cursor=not-a-cursor`);
    assert(bad.status >= 400 && bad.status < 500, String(bad.status));
    await bad.body?.cancel();
  }));

Deno.test("an update left running unhealthy, by a person's stay or because no one could be asked, still names what it replaced and shows a notice", () =>
  withFixture(async (o) => {
    const running = await runningRelease(o);
    // What the launcher records: the move first, then the stay.
    for (const by of ["mark", null] as const) {
      await o.f.pgDatabase.query(
        "delete from bakery.installation_update_history",
      );
      await record(o, {
        kind: UpdateEventKind.Updated,
        occurredAt: at(5),
        fromRelease: A,
        toRelease: running,
      });
      await record(o, {
        kind: UpdateEventKind.DecidedStay,
        occurredAt: at(6),
        byName: by,
        fromRelease: running,
        toRelease: A,
      });
      const body = await status(o);
      assertEquals(body.runningRelease, running);
      assertEquals(body.runningSince, at(5).toISOString(), String(by));
      assertEquals(
        body.previousRelease,
        A,
        "what an administrator can go back to",
      );
      assertEquals(body.previousRanUntil, at(5).toISOString());
      assertEquals(body.lastFailure?.kind, "decided_stay");
      assertEquals(body.lastFailure?.by, by);
      const dismissed = await o.admin(
        "POST",
        `${LIST}/${body.lastFailure!.id}/dismiss`,
        undefined,
        { keyed: true },
      );
      assertEquals(dismissed.status, 200, await dismissed.clone().text());
      await dismissed.body?.cancel();
      assertEquals((await status(o)).lastFailure, null);
    }
  }));

Deno.test("a stay that recover put back is one incident: one notice, and the kept release is still known", () =>
  withFixture(async (o) => {
    const running = await runningRelease(o);
    for (const by of ["mark", null] as const) {
      await o.f.pgDatabase.query(
        "delete from bakery.installation_update_history",
      );
      // What the launcher records: the running release was installed over A,
      // an update to B was left unhealthy, and recover put the running one back.
      await record(o, {
        kind: UpdateEventKind.Updated,
        occurredAt: at(3),
        fromRelease: A,
        toRelease: running,
      });
      await record(o, {
        kind: UpdateEventKind.Updated,
        occurredAt: at(5),
        fromRelease: running,
        toRelease: B,
      });
      await record(o, {
        kind: UpdateEventKind.DecidedStay,
        occurredAt: at(6),
        byName: by,
        fromRelease: B,
        toRelease: running,
      });
      await record(o, {
        kind: UpdateEventKind.Interrupted,
        occurredAt: at(7),
        fromRelease: B,
        toRelease: running,
      });
      const body = await status(o);
      assertEquals(body.lastFailure?.kind, "interrupted", String(by));
      assertEquals(
        body.previousRelease,
        A,
        "recover does not forget what is kept",
      );
      assertEquals(body.previousRanUntil, at(3).toISOString());
      assertEquals(body.runningSince, at(3).toISOString());
      const dismissed = await o.admin(
        "POST",
        `${LIST}/${body.lastFailure!.id}/dismiss`,
        undefined,
        { keyed: true },
      );
      assertEquals(dismissed.status, 200, await dismissed.clone().text());
      await dismissed.body?.cancel();
      assertEquals(
        (await status(o)).lastFailure,
        null,
        "dismissing the newest clears the incident; the older stay does not come back",
      );
      const listed = await (await o.admin("GET", LIST)).json() as Page;
      assertEquals(listed.items.length, 4, "every row stays in the history");
    }
  }));

Deno.test("a new incident after a dismissed one shows again, and a later successful update clears the last one", () =>
  withFixture(async (o) => {
    const running = await runningRelease(o);
    const dismiss = async (id: string) => {
      const response = await o.admin(
        "POST",
        `${LIST}/${id}/dismiss`,
        undefined,
        {
          keyed: true,
        },
      );
      assertEquals(response.status, 200, await response.clone().text());
      await response.body?.cancel();
    };
    await record(o, {
      kind: UpdateEventKind.DecidedStay,
      occurredAt: at(2),
      fromRelease: B,
      toRelease: running,
    });
    await dismiss((await status(o)).lastFailure!.id);
    assertEquals((await status(o)).lastFailure, null);
    await record(o, {
      kind: UpdateEventKind.WentBack,
      occurredAt: at(8),
      byName: null,
      fromRelease: C,
      toRelease: running,
    });
    assertEquals((await status(o)).lastFailure?.kind, "went_back");
    await dismiss((await status(o)).lastFailure!.id);
    assertEquals((await status(o)).lastFailure, null);
    await record(o, {
      kind: UpdateEventKind.Interrupted,
      occurredAt: at(9),
      fromRelease: C,
      toRelease: running,
    });
    assertEquals((await status(o)).lastFailure?.kind, "interrupted");
    await record(o, {
      kind: UpdateEventKind.Updated,
      occurredAt: at(10),
      fromRelease: running,
      toRelease: C,
    });
    assertEquals((await status(o)).lastFailure, null);
  }));
