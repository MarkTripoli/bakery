import { assert, assertEquals } from "@std/assert";
import {
  type BackupSettingsFixture,
  openBackupSettingsFixture,
} from "../helpers/backup-settings.ts";
import {
  removeSeededEffects,
  seedEffect,
} from "../helpers/external-effects-seed.ts";

/**
 * #59 ask 11 (also #64 ask 5): `GET /v1/installation/uncertain-actions`, the one
 * list of outside actions whose outcome Bakery cannot tell. An installation
 * administrator reads kinds and counts; nothing an effect pointed at leaves the
 * ledger, and nobody else can read it.
 */

const PATH = "/v1/installation/uncertain-actions";

type Body = {
  total: number;
  kinds: { operation: string; count: number; since: string }[];
};

async function withFixture<T>(work: (o: BackupSettingsFixture) => Promise<T>) {
  const o = await openBackupSettingsFixture();
  try {
    await removeSeededEffects(o.f.pgDatabase);
    return await work(o);
  } finally {
    try {
      await removeSeededEffects(o.f.pgDatabase);
    } finally {
      await o.finish();
    }
  }
}

const seed = (o: BackupSettingsFixture, status: string, operation: string) =>
  seedEffect(o.f.pgDatabase, o.f.organizationId, status, operation);

Deno.test("an administrator reads the uncertain actions by kind, oldest first, with counts and no target", () =>
  withFixture(async (o) => {
    const before = await (await o.admin("GET", PATH)).json() as Body;
    await seed(o, "uncertain", "test.zeta.send");
    await seed(o, "uncertain", "test.alpha.send");
    await seed(o, "uncertain", "test.alpha.send");
    await seed(o, "confirmed", "test.confirmed.send");
    await seed(o, "prepared", "test.prepared.send");

    const response = await o.admin("GET", PATH);
    assertEquals(response.status, 200, await response.clone().text());
    const text = await response.clone().text();
    const body = await response.json() as Body;

    const alpha = body.kinds.find((k) => k.operation === "test.alpha.send");
    const zeta = body.kinds.find((k) => k.operation === "test.zeta.send");
    assertEquals(alpha?.count, 2);
    assertEquals(zeta?.count, 1);
    assertEquals(
      body.kinds.some((k) => k.operation.startsWith("test.confirmed")),
      false,
      "a confirmed action is not uncertain",
    );
    assertEquals(
      body.kinds.some((k) => k.operation.startsWith("test.prepared")),
      false,
      "an action still being sent is not uncertain yet",
    );
    assertEquals(body.total, before.total + 3);
    assert(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(alpha!.since),
      alpha!.since,
    );
    // Oldest first: the list is ordered by when each kind became uncertain.
    const sinces = body.kinds.map((k) => k.since);
    assertEquals(sinces, [...sinces].sort());
    assert(!text.includes("secret-target"), "no effect's target is shown");
  }));

Deno.test("an action leaves the list once it is reconciled", () =>
  withFixture(async (o) => {
    const effect = await seed(o, "uncertain", "test.settles.send");
    const listed = async () =>
      ((await (await o.admin("GET", PATH)).json()) as Body).kinds.some((k) =>
        k.operation === "test.settles.send"
      );
    assertEquals(await listed(), true);
    await o.f.pgDatabase.query(
      "update bakery.external_effects set status = 'confirmed' where id = $1",
      [effect],
    );
    assertEquals(
      await listed(),
      false,
      "a reconciled action is no longer unsure",
    );
  }));

Deno.test("only an installation administrator can read it, and a refusal shows nothing", () =>
  withFixture(async (o) => {
    await seed(o, "uncertain", "test.hidden.send");
    const developer = await o.admin("GET", PATH, undefined, {
      cookie: o.f.developerCookie,
    });
    assertEquals(developer.status, 403, await developer.clone().text());
    const text = await developer.text();
    assert(text.includes("AUTH_FORBIDDEN"), text);
    assert(!text.includes("test.hidden.send"));
    const anonymous = await o.f.app.request(PATH);
    assert([401, 403].includes(anonymous.status), String(anonymous.status));
    await anonymous.body?.cancel();
  }));
