import { assert, assertEquals } from "@std/assert";
import {
  commitsEntry,
  openRepositoryRulesFixture,
  overrideOf,
  titleEntry,
} from "../helpers/repository-rules-fixture.ts";
import {
  allTableCounts,
  previewOrganizationPath,
  profileWith,
  recordStatements,
  referenceImpact,
  seedBulkProfiles,
  seedBulkRepositories,
  seedProfile,
} from "../helpers/repository-rule-preview-fixture.ts";
import {
  acquirePreviewSlot,
  applyPreviewStatementTimeout,
  mapPreviewDatabaseError,
  PREVIEW_BATCH_SIZE,
  PREVIEW_MAX_BYTES,
  PREVIEW_MEMO_LIMIT,
  SCAN_SQL,
  type ScanRow,
  scanRowBytes,
} from "../../apps/server/src/modules/repository-rules/previews.ts";
import type { OrganizationRepositoryRules } from "../../packages/contracts/src/repository-rules.ts";

type Preview = {
  currentRevision: number;
  counts: Record<string, number>;
  items: Array<{ repositoryId: string; status: string; unsupported: boolean }>;
};

const BINDING_LENGTH = 100;
/** A fat but valid-shaped profile: five overrides, long bindings, matching commands. */
const heavyConfig = (bindingLength = BINDING_LENGTH, templateChars = 0) => {
  const BINDING = "x".repeat(bindingLength - 1) + "1";
  return profileWith(
    [
      overrideOf(commitsEntry(false)),
      overrideOf(titleEntry(72)),
      {
        ruleKey: "changeRequest.description",
        enabled: true,
        mode: "guide",
        options: { template: "t".repeat(templateChars), requiredSections: [] },
      },
      {
        ruleKey: "code.magicNumbers",
        enabled: true,
        mode: "require",
        options: {
          checkBinding: BINDING,
          allowedNumbers: [],
          excludedPaths: [],
        },
      },
      {
        ruleKey: "code.magicStrings",
        enabled: true,
        mode: "require",
        options: {
          checkBinding: BINDING + "2",
          allowedLiterals: [],
          excludedPaths: [],
        },
      },
    ],
    [BINDING, BINDING + "2"],
  );
};

Deno.test("a preview is bounded in bytes, time and concurrency per organization", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminB = { cookie: f.cookies.adminB, organizationId: organizationBId };
  const draft = { expectedRevision: 0, entries: [commitsEntry(true)] };
  const preview = (
    options: Record<string, unknown> = adminA,
    body: Record<string, unknown> = draft,
    organizationId = organizationAId,
  ) =>
    send("POST", previewOrganizationPath(organizationId), { ...options, body });
  try {
    await test.step("the scan reads only summarized columns, never whole configs", async () => {
      await seedBulkRepositories(f, organizationAId, 40);
      await seedBulkProfiles(
        f,
        organizationAId,
        heavyConfig(BINDING_LENGTH, 2000),
      );
      const recorder = recordStatements(runtime);
      let response: Response;
      try {
        response = await preview();
        await response.arrayBuffer();
      } finally {
        recorder.restore();
      }
      assertEquals(response.status, 200);
      const scan = recorder.statements.filter((sql) =>
        sql.includes("with page as")
      );
      assertEquals(scan.length, 1);
      assert(!/select\s+r\.\*/i.test(scan[0]));
      // A heavy row is summarized to well under a kilobyte.
      const sample = await runtime.query<ScanRow>(SCAN_SQL, [
        organizationAId,
        null,
        1,
        [],
      ]);
      const bytes = scanRowBytes(sample.rows[0]);
      assert(bytes > 100 && bytes < 1500, `row bytes ${bytes}`);
      assertEquals(
        Object.keys(sample.rows[0]).sort(),
        ["application_id", "command_ids", "id", "name", "summaries"],
      );
    });

    await test.step("the statement timeout is set for the transaction and cancels a long statement", async () => {
      const recorder = recordStatements(runtime);
      try {
        const response = await preview();
        await response.arrayBuffer();
      } finally {
        recorder.restore();
      }
      assert(
        recorder.statements.some((sql) =>
          sql.includes("set_config('statement_timeout'")
        ),
      );
      // Transaction-local: no pooled client keeps the timeout after previews.
      const pool = runtime as unknown as { totalCount: number };
      const held = await Promise.all(
        Array.from(
          { length: Math.max(pool.totalCount, 1) },
          () => runtime.connect(),
        ),
      );
      try {
        for (const client of held) {
          const shown = await client.query("show statement_timeout");
          assertEquals(shown.rows[0].statement_timeout, "0");
        }
      } finally {
        for (const client of held) client.release();
      }
      // The same helper against a real transaction cancels pg_sleep and the
      // error maps to the typed timeout.
      const client = await runtime.connect();
      const started = performance.now();
      try {
        await client.query("begin");
        await applyPreviewStatementTimeout(client as never);
        let thrown: unknown;
        try {
          await client.query("select pg_sleep(30)");
        } catch (error) {
          thrown = error;
        }
        assert(thrown, "pg_sleep must be cancelled");
        const mapped = mapPreviewDatabaseError(thrown) as { code: string };
        assertEquals(mapped.code, "DEPENDENCY_TIMEOUT");
        await client.query("rollback");
      } finally {
        client.release();
      }
      assert(performance.now() - started < 9000);
    });

    await test.step("a scan stuck behind a lock is cancelled into a typed 504, not a raw error", async () => {
      let pending: Promise<Response> | undefined;
      const started = performance.now();
      await f.owner.begin(async (tx) => {
        await tx`lock table bakery.repository_profiles in access exclusive mode`;
        pending = Promise.resolve(preview());
        // Wait until the scan is really blocked on the table, then hold the
        // lock past the 5 second statement timeout, counted from that moment.
        let blocked = false;
        for (let attempt = 0; attempt < 600 && !blocked; attempt++) {
          const waiting = await tx`
            select count(*)::int as n from pg_locks l
              join pg_class c on c.oid = l.relation
             where not l.granted and c.relname = 'repository_profiles'`;
          blocked = waiting[0].n > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(blocked, "the scan must be waiting on the held table");
        await new Promise((resolve) => setTimeout(resolve, 5500));
      });
      const response = await pending!;
      const elapsed = performance.now() - started;
      assertEquals(response.status, 504, await response.clone().text());
      assertEquals(
        (await response.json() as { code: string }).code,
        "DEPENDENCY_TIMEOUT",
      );
      assert(elapsed < 12000, `timed out after ${elapsed}ms`);
      // The slot was released: the next preview is not refused.
      const next = await preview();
      assertEquals(next.status, 200, await next.clone().text());
      await next.arrayBuffer();
    });

    await test.step("the byte budget refuses with a typed 422 at its boundary", async () => {
      // Long stored bindings make each row heavy, so a few thousand rows
      // cross the budget. Measure the heavy row size from the data itself.
      await seedBulkRepositories(f, organizationAId, 100, "probe");
      await seedBulkProfiles(f, organizationAId, heavyConfig(1500));
      const sample = await runtime.query<ScanRow>(SCAN_SQL, [
        organizationAId,
        null,
        1000,
        [],
      ]);
      const rowBytes = Math.max(...sample.rows.map(scanRowBytes));
      assert(rowBytes > 3000, `heavy row ${rowBytes}`);
      const fits = Math.floor(PREVIEW_MAX_BYTES / rowBytes);
      assert(
        fits < 20_000,
        `heavy rows must hit the byte budget first: ${fits}`,
      );
      // Top up to ~90% of the budget: allowed.
      await seedBulkRepositories(
        f,
        organizationAId,
        Math.floor(fits * 0.9) - 140,
        "fill",
      );
      await seedBulkProfiles(f, organizationAId, heavyConfig(1500));
      const under = await preview();
      assertEquals(under.status, 200, await under.clone().text());
      const body = await under.json() as Preview;
      assert(body.counts.repositories >= fits * 0.85);
      // Past ~110%: refused, typed, and nothing else is written.
      await seedBulkRepositories(
        f,
        organizationAId,
        Math.ceil(fits * 0.25),
        "over",
      );
      await seedBulkProfiles(f, organizationAId, heavyConfig(1500));
      const before = await allTableCounts(f);
      const over = await preview();
      assertEquals(over.status, 422);
      const refused = await over.json() as {
        code: string;
        issues: Array<{ code: string }>;
      };
      assertEquals(refused.code, "UNPROCESSABLE");
      assertEquals(refused.issues[0].code, "preview_too_large");
      assertEquals(await allTableCounts(f), before);
    });

    await test.step("admission refuses a second scan of one organization and spares the others", async () => {
      const release = acquirePreviewSlot(organizationAId, f.adminA.principalId);
      try {
        const refused = await preview();
        assertEquals(refused.status, 503);
        const body = await refused.json() as {
          code: string;
          retryAfterSeconds?: number;
        };
        assertEquals(body.code, "DEPENDENCY_UNAVAILABLE");
        assert(Number.isInteger(body.retryAfterSeconds));
        // Another organization still previews, and reads still work.
        const other = await preview(
          adminB,
          { expectedRevision: 0, entries: [commitsEntry(true)] },
          organizationBId,
        );
        assertEquals(other.status, 200);
        await other.arrayBuffer();
        const read = await send("GET", f.rulesPath(organizationAId), adminA);
        assertEquals(read.status, 200);
        await read.arrayBuffer();
      } finally {
        release();
      }
      // One person administering two organizations cannot hold both process
      // slots: with their slot in A held, their own preview of B is refused
      // while B's other Admin still scans.
      const releaseShared = acquirePreviewSlot(
        organizationAId,
        f.adminAB.principalId,
      );
      try {
        const sameSlot = await preview(
          { cookie: f.cookies.adminAB, organizationId: organizationBId },
          { expectedRevision: 0, entries: [commitsEntry(true)] },
          organizationBId,
        );
        assertEquals(sameSlot.status, 503);
        await sameSlot.arrayBuffer();
        const otherPerson = await preview(
          adminB,
          { expectedRevision: 0, entries: [commitsEntry(true)] },
          organizationBId,
        );
        assertEquals(otherPerson.status, 200);
        await otherPerson.arrayBuffer();
      } finally {
        releaseShared();
      }
      // The slot is free again once released, and also after a refused request.
      const again = await preview(adminA, {
        expectedRevision: 0,
        entries: [commitsEntry(true)],
        limit: 1,
      });
      assert([200, 422].includes(again.status), String(again.status));
      await again.arrayBuffer();
      const slot = acquirePreviewSlot(organizationAId, f.adminA.principalId);
      slot();
    });
  } finally {
    await f.close();
  }
});

Deno.test("parallel previews of one organization never starve another organization", async () => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId, organizationBId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  const adminB = { cookie: f.cookies.adminB, organizationId: organizationBId };
  try {
    await seedBulkRepositories(f, organizationAId, 8_000);
    await seedBulkProfiles(f, organizationAId, heavyConfig(30));
    // One admitted preview on its own always succeeds on this data.
    const alone = await send("POST", previewOrganizationPath(organizationAId), {
      ...adminA,
      body: { expectedRevision: 0, entries: [commitsEntry(true)], limit: 100 },
    });
    assertEquals(alone.status, 200, await alone.clone().text());
    assertEquals((await alone.json() as Preview).counts.repositories, 8000);
    const before = Deno.memoryUsage().rss;
    const started = performance.now();
    const previews = Array.from(
      { length: 6 },
      () =>
        send("POST", previewOrganizationPath(organizationAId), {
          ...adminA,
          body: {
            expectedRevision: 0,
            entries: [commitsEntry(true)],
            limit: 100,
          },
        }),
    );
    const reads: number[] = [];
    const readStatuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      const at = performance.now();
      const read = await send("GET", f.rulesPath(organizationBId), adminB);
      readStatuses.push(read.status);
      reads.push(performance.now() - at);
      await read.arrayBuffer();
    }
    const results = await Promise.all(previews);
    const statuses = await Promise.all(results.map(async (response) => {
      await response.arrayBuffer();
      return response.status;
    }));
    const elapsed = performance.now() - started;
    const rssDelta = (Deno.memoryUsage().rss - before) / 1_000_000;
    console.log(
      `LOAD parallel=6 repos=8000 totalMs=${elapsed.toFixed(0)} ` +
        `orgBReadMs=${reads.map((ms) => ms.toFixed(0)).join("/")} ` +
        `statuses=${JSON.stringify(statuses)} rssDeltaMB=${
          rssDelta.toFixed(0)
        }`,
    );
    assertEquals(readStatuses, [200, 200, 200, 200, 200, 200]);
    assert(
      Math.max(...reads) < 3000,
      `org B read took ${Math.max(...reads)}ms`,
    );
    assert(
      statuses.every((status) => [200, 503, 504].includes(status)),
      JSON.stringify(statuses),
    );
    assert(statuses.includes(503));
    // The first admitted request was answered (a 504 is legitimate under load).
    assert(
      statuses.some((status) => status === 200 || status === 504),
      `burst was all refused: ${JSON.stringify(statuses)}`,
    );
  } finally {
    await f.close();
  }
});

Deno.test("a preview reads one snapshot even when a publication commits mid-scan", async () => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  try {
    await seedBulkRepositories(f, organizationAId, 2500);
    const published = await send("POST", f.versionsPath(organizationAId), {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      body: { expectedRevision: 0, entries: [commitsEntry(false)] },
    });
    assertEquals(published.status, 201);
    const request = {
      ...adminA,
      body: { expectedRevision: 1, entries: [commitsEntry(true)], limit: 100 },
    };
    const nextRequest = {
      ...adminA,
      body: { expectedRevision: 2, entries: [commitsEntry(true)], limit: 100 },
    };
    // Hold the profiles table so the scan blocks AFTER its snapshot was taken
    // (the authority statements come first), then commit new repositories and
    // a new organization revision together with releasing the lock.
    let pending: Promise<Response> | undefined;
    await f.owner.begin(async (tx) => {
      await tx`lock table bakery.repository_profiles in access exclusive mode`;
      pending = Promise.resolve(
        send("POST", previewOrganizationPath(organizationAId), request),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 400 && !blocked; attempt++) {
        const waiting = await tx`
          select count(*)::int as n from pg_locks l
            join pg_class c on c.oid = l.relation
           where not l.granted and c.relname = 'repository_profiles'`;
        blocked = waiting[0].n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(blocked, "the scan must be waiting on the held table");
      // Committed together with the lock release, after the scan's snapshot.
      await tx`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch
        )
        select gen_random_uuid(), ${organizationAId}::uuid, application_id,
               gen_random_uuid(), 'late-' || g::text, 'late-owner',
               'late-' || g::text, 'main'
          from generate_series(1, 300) as g,
               (select application_id from bakery.repositories
                 where organization_id = ${organizationAId} limit 1) as one`;
      await tx`
        insert into bakery.organization_repository_rule_versions (
          id, organization_id, revision, config, digest, created_by
        ) values (
          gen_random_uuid(), ${organizationAId}, 2,
          ${tx.json({ revision: 2, entries: [] })}, ${"f".repeat(64)},
          ${f.adminA.principalId}
        )`;
    });
    const response = await pending!;
    const body = await response.json() as Preview;
    assertEquals(response.status, 200);
    assertEquals(body.currentRevision, 1);
    assertEquals(body.counts.repositories, 2500);
    // A new request sees the new world.
    const next = await send(
      "POST",
      previewOrganizationPath(organizationAId),
      nextRequest,
    );
    assertEquals(next.status, 200, await next.clone().text());
    const nextBody = await next.json() as Preview;
    assertEquals(nextBody.counts.repositories, 2800);
    assertEquals(nextBody.currentRevision, 2);
  } finally {
    await f.close();
  }
});

Deno.test("corrupt saved overrides count as none and the memo bound does not change answers", async () => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  try {
    const published = await send("POST", f.versionsPath(organizationAId), {
      ...adminA,
      idempotencyKey: crypto.randomUUID(),
      body: { expectedRevision: 0, entries: [commitsEntry(false)] },
    });
    assertEquals(published.status, 201);
    const good = await f.seedRepository(organizationAId);
    await seedProfile(
      f,
      organizationAId,
      good.repositoryId,
      profileWith([overrideOf({ ...commitsEntry(false), mode: "warn" })]),
    );
    const hostile: unknown[] = [
      { repositoryRules: "text" },
      { repositoryRules: { entries: "text" } },
      { repositoryRules: { entries: [null] } },
      { repositoryRules: { entries: ["x", 1] } },
      {
        repositoryRules: {
          entries: [{ ruleKey: "__proto__", enabled: true, mode: "warn" }],
        },
      },
      {
        repositoryRules: {
          entries: [{
            ruleKey: "commits.semantic",
            enabled: "yes",
            mode: "warn",
          }],
        },
      },
      {
        repositoryRules: {
          entries: [{
            ruleKey: "commits.semantic",
            enabled: true,
            mode: "block",
          }],
        },
      },
      {
        repositoryRules: {
          entries: Array(2).fill({
            ruleKey: "commits.semantic",
            enabled: true,
            mode: "warn",
          }),
        },
      },
      {
        repositoryRules: {
          entries: Array(6).fill({
            ruleKey: "commits.semantic",
            enabled: true,
            mode: "warn",
          }),
        },
      },
      { repositoryRules: { entries: Array(5000).fill(1) } },
      { fixedPolicy: "junk", repositoryRules: null },
      { fixedPolicy: { commands: "junk" } },
      { fixedPolicy: { commands: [null, 1, { id: 5 }] } },
    ];
    for (const config of hostile) {
      const repo = await f.seedRepository(organizationAId);
      await seedProfile(f, organizationAId, repo.repositoryId, config as never);
    }
    const response = await send(
      "POST",
      previewOrganizationPath(organizationAId),
      {
        ...adminA,
        body: {
          expectedRevision: 1,
          entries: [commitsEntry(true)],
          limit: 100,
        },
      },
    );
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json() as Preview;
    assertEquals(body.counts, {
      repositories: hostile.length + 1,
      inherited: hostile.length,
      overridden: 0,
      newlyLocked: 1,
      unsupported: 0,
    });
    assertEquals(
      body.items.find((item) => item.repositoryId === good.repositoryId)
        ?.status,
      "newly_locked",
    );
  } finally {
    await f.close();
  }
});

Deno.test("more distinct override shapes than the memo holds still classify exactly", async () => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  try {
    const shapes = PREVIEW_MEMO_LIMIT + 500;
    assert(shapes < PREVIEW_BATCH_SIZE * 20);
    await seedBulkRepositories(f, organizationAId, shapes);
    // Distinct checker binding per repository; every third repository has the
    // matching command in its active fixed policy.
    await f.owner`
      with numbered as (
        select id, row_number() over (order by id) as n
          from bakery.repositories where organization_id = ${organizationAId}
      ), made as (
        insert into bakery.repository_profiles (
          id, organization_id, repository_id, revision, config, digest, created_by
        )
        select gen_random_uuid(), ${organizationAId}::uuid, id, 1,
               jsonb_build_object(
                 'schemaVersion', 1,
                 'repositoryRules', jsonb_build_object('entries', jsonb_build_array(
                   jsonb_build_object(
                     'ruleKey', 'code.magicNumbers', 'enabled', true,
                     'mode', 'require',
                     'options', jsonb_build_object(
                       'checkBinding', 'bind-' || n::text,
                       'allowedNumbers', '[]'::jsonb,
                       'excludedPaths', '[]'::jsonb)))),
                 'fixedPolicy', jsonb_build_object('commands', case
                   when n % 3 = 0
                   then jsonb_build_array(jsonb_build_object('id', 'bind-' || n::text))
                   else '[]'::jsonb end)),
               ${"e".repeat(64)}, ${f.adminA.principalId}::uuid
          from numbered
        returning id, repository_id
      )
      update bakery.repositories r set active_profile_id = made.id
        from made
       where r.organization_id = ${organizationAId} and r.id = made.repository_id`;
    const entries = [commitsEntry(false)];
    const response = await send(
      "POST",
      previewOrganizationPath(organizationAId),
      {
        ...adminA,
        body: { expectedRevision: 0, entries, limit: 100 },
      },
    );
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json() as Preview;
    const reference = await referenceImpact(
      f,
      organizationAId,
      null,
      { revision: 1, entries: entries as never } as OrganizationRepositoryRules,
    );
    assertEquals(body.counts, reference.counts);
    assertEquals(body.counts.overridden, shapes);
    // Two thirds name no command in their own policy: unsupported.
    assertEquals(body.counts.unsupported, shapes - Math.floor(shapes / 3));
  } finally {
    await f.close();
  }
});

const magicOverride = (
  enabled: boolean,
  mode: string,
  checkBinding: string | null,
) => ({
  ruleKey: "code.magicNumbers",
  enabled,
  mode,
  options: { checkBinding, allowedNumbers: [], excludedPaths: [] },
});

Deno.test("override shapes that differ in one field only are never confused by the memo", async () => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  try {
    // The draft names binding c1 so a stored command c1 is projected for every
    // repository; its own magic-string rule is only a warning.
    const entries = [{
      ruleKey: "code.magicStrings",
      enabled: true,
      mode: "warn",
      options: { checkBinding: "c1", allowedLiterals: [], excludedPaths: [] },
      locked: false,
    }];
    const shapes: Array<[boolean, string, string | null, string[]]> = [
      // differ only in mode (commands none): require is unsupported, warn is not
      [true, "require", "c1", []],
      [true, "warn", "c1", []],
      // differ only in enabled
      [false, "require", "c1", []],
      // differ only in binding with the same projected commands [c1]
      [true, "require", "c1", ["c1"]],
      [true, "require", "c2", ["c1"]],
    ];
    for (const [enabled, mode, binding, commands] of shapes) {
      const repo = await f.seedRepository(organizationAId);
      await seedProfile(
        f,
        organizationAId,
        repo.repositoryId,
        profileWith([magicOverride(enabled, mode, binding)], commands),
      );
    }
    const response = await send(
      "POST",
      previewOrganizationPath(organizationAId),
      { ...adminA, body: { expectedRevision: 0, entries, limit: 100 } },
    );
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json() as Preview;
    const reference = await referenceImpact(f, organizationAId, null, {
      revision: 1,
      entries: entries as never,
    } as OrganizationRepositoryRules);
    assertEquals(
      body.items.map((item) => item.unsupported),
      reference.items.map((item) => item.unsupported),
    );
    // Only the first and the last shape are unsupported.
    assertEquals(body.counts.unsupported, 2);
    assertEquals(body.counts, reference.counts);
  } finally {
    await f.close();
  }
});

Deno.test("stored bindings full of delimiters classify independently", async () => {
  const f = await openRepositoryRulesFixture();
  const { send, organizationAId } = f;
  const adminA = { cookie: f.cookies.adminA, organizationId: organizationAId };
  try {
    // With the old delimiter-joined memo key these two stored shapes had the
    // same key: two overrides (a warn number rule and a REQUIRE string rule
    // without a command) versus one warn number rule whose corrupt binding
    // text spells out the second entry.
    const two = profileWith([
      magicOverride(true, "warn", "A"),
      {
        ...magicOverride(true, "require", "B"),
        ruleKey: "code.magicStrings",
        options: { checkBinding: "B", allowedLiterals: [], excludedPaths: [] },
      },
    ]);
    const one = profileWith([
      magicOverride(
        true,
        "warn",
        "A,code.magicStrings:1:require:B",
      ),
    ]);
    // The same idea for a comma-flattened key: the binding spells out the
    // second entry in the other plausible encoding.
    const one2 = profileWith([
      magicOverride(true, "warn", "A,code.magicStrings,true,require,B"),
    ]);
    // Order matters for neither: seed in both id orders by repeating.
    for (const config of [two, one, one2, two, one, one2]) {
      const repo = await f.seedRepository(organizationAId);
      await seedProfile(f, organizationAId, repo.repositoryId, config);
    }
    // Raw delimiter characters in more bindings.
    for (const binding of ["a|b", "a:1", 'q"r', "x,y", "a|b"]) {
      const repo = await f.seedRepository(organizationAId);
      await seedProfile(
        f,
        organizationAId,
        repo.repositoryId,
        profileWith([magicOverride(true, "require", binding)], [binding]),
      );
    }
    const response = await send(
      "POST",
      previewOrganizationPath(organizationAId),
      {
        ...adminA,
        body: {
          expectedRevision: 0,
          entries: [commitsEntry(false)],
          limit: 100,
        },
      },
    );
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json() as Preview;
    // The `two` shape holds a require string rule with no command: unsupported.
    // The `one` shape holds only a warn rule: supported. A binding that names
    // its own stored command is supported.
    assertEquals(body.counts.repositories, 11);
    assertEquals(body.counts.unsupported, 2);
  } finally {
    await f.close();
  }
});
