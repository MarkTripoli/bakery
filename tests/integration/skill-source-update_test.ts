import { assert, assertEquals } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import {
  type SkillSourceAdapter,
  SkillSourceAdapterError,
  type SkillSourceFetchRequest,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

type Fx = Awaited<ReturnType<typeof openPersonalSkillFixture>>;
type Check = {
  skillId: string;
  sourceId: string;
  status: "current" | "update_available" | "unreachable";
  requestedRevision: string;
  installedRevision: string;
  latestRevision: string | null;
  lastCheckedAt: string | null;
  problem: string | null;
  changes: {
    path: string;
    change: "added" | "removed" | "changed";
    installedSha256: string | null;
    latestSha256: string | null;
    diff: string | null;
    diffOmitted: string | null;
  }[];
  changesTruncated: boolean;
};

const encoder = new TextEncoder();
const b64 = (text: string) =>
  btoa(String.fromCharCode(...encoder.encode(text)));
const INSTALLED = "a".repeat(40);
const NEWER = "b".repeat(40);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function upload(files: Record<string, string>, revision = 1) {
  const listed = [];
  for (const [path, text] of Object.entries(files)) {
    const bytes = encoder.encode(text);
    listed.push({
      path,
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      sha256: await sha256(bytes),
      isExecutable: false,
    });
  }
  const manifest = {
    schemaVersion: 1,
    license: "MIT",
    entryPath: "SKILL.md",
    files: listed,
  };
  return {
    revision,
    digest: await sha256(encoder.encode(canonicalJson(manifest))),
    entryPath: "SKILL.md",
    manifest,
    files: Object.entries(files).map(([path, text]) => ({
      path,
      mediaType: "text/markdown",
      isExecutable: false,
      contentBase64: b64(text),
    })),
  };
}

/** A source whose answer a test sets: a revision and its files, or down. */
function fakeSource() {
  const state: {
    revision: string;
    files: Record<string, string>;
    down: boolean;
  } = {
    revision: INSTALLED,
    files: {},
    down: false,
  };
  const calls: SkillSourceFetchRequest[] = [];
  /** How many other sessions held an open transaction at each fetch. */
  const openTransactions: number[] = [];
  const probe: { read: (() => Promise<number>) | null } = { read: null };
  /** Runs while the source is being read, after the skill was read and before the answer is written. */
  const during: { run: (() => Promise<void>) | null } = { run: null };
  const adapter: SkillSourceAdapter = {
    async fetchPinnedSource(request) {
      calls.push(request);
      if (probe.read !== null) openTransactions.push(await probe.read());
      if (during.run !== null) await during.run();
      if (state.down) throw new SkillSourceAdapterError("SOURCE_UNAVAILABLE");
      return await Promise.resolve({
        sourceType: request.sourceType,
        normalizedLocator: request.locator,
        requestedRevision: request.requestedRevision,
        sourceRevision: state.revision,
        sourceProofDigest: "sha256:" + "0".repeat(64),
        normalizedPath: request.path ?? "",
        inventory: {
          manifest: {},
          manifestBytes: new Uint8Array(),
          files: Object.entries(state.files).map(([path, text]) => ({
            path,
            content: encoder.encode(text),
            isExecutable: false,
          })),
        },
      });
    },
  };
  return { state, calls, adapter, openTransactions, probe, during };
}

function api(f: Fx, cookie: string) {
  return (method: string, path: string, body?: unknown) =>
    f.fixture.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers: {
          cookie,
          "Bakery-Organization-Id": f.organizationId,
          "content-type": "application/json",
          origin: authTestOrigin,
          ...(method === "GET"
            ? {}
            : { "Idempotency-Key": crypto.randomUUID() }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
}

const SKILL_V1 = {
  "SKILL.md": "# Guide\n\nline one\nline two\nline three\n",
  "references/old.md": "Going away.\n",
  "references/same.md": "Unchanged.\n",
};

Deno.test("a skill from a source is checked against it file by file, and nothing is installed", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-source-update-" });
  const source = fakeSource();
  const f = await openPersonalSkillFixture({
    skillFileRoot: root,
    skillSourceAdapter: source.adapter,
  });
  try {
    const owner = api(f, f.ownerCookie);
    const other = api(f, f.adminCookie);
    // A transaction held open by another session shows in pg_locks as the
    // virtual transaction id it owns (readable by every role, unlike the
    // application role's pg_stat_activity rows).
    source.probe.read = async () =>
      (await f.fixture.pgDatabase.query<{ n: number }>(
        `select count(distinct pid)::int as n from pg_locks
          where locktype = 'virtualxid' and pid <> pg_backend_pid()`,
      )).rows[0].n;

    // A skill published locally, then recorded as imported from a Git source.
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "guide",
      name: "Guide",
      scope: "organization",
    }, "skill-guide");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const publish = await f.post(
      f.ownerCookie,
      `/v1/skills/${skill.id}/versions`,
      await upload(SKILL_V1),
      "publish-guide",
    );
    assertEquals(publish.status, 201, await publish.clone().text());
    const version = await publish.json() as { id: string };

    // Before it has a source, there is nothing to check.
    const local = await owner("POST", `/v1/skills/${skill.id}/source-update`);
    const localText = await local.text();
    assertEquals(local.status, 409, localText);
    // Named by its reason, so a skill with no remote source cannot slip on to the
    // next refusal (no completed import) and still answer 409.
    assertEquals(
      (JSON.parse(localText) as { reason?: string }).reason,
      "skill_has_no_remote_source",
    );

    const sourceResponse = await f.post(f.ownerCookie, "/v1/skill-sources", {
      sourceType: "git",
      url: "https://github.com/example/skills.git",
      name: "Example skills",
      license: "MIT",
    }, "source-guide");
    assertEquals(
      sourceResponse.status,
      201,
      await sourceResponse.clone().text(),
    );
    const registered = await sourceResponse.json() as { id: string };
    const admitted = await f.post(f.ownerCookie, "/v1/skill-imports", {
      sourceId: registered.id,
      revision: "main",
      path: "skills/guide",
    }, "import-guide");
    assertEquals(admitted.status, 201, await admitted.clone().text());
    const run = await admitted.json() as { id: string };
    const db = f.fixture.pgDatabase;
    await db.query(
      `update bakery.skill_versions set source_revision = $3
        where organization_id = $1 and id = $2`,
      [f.organizationId, version.id, INSTALLED],
    );
    await db.query(
      `update bakery.skills set source_id = $3, source_path = 'skills/guide'
        where organization_id = $1 and id = $2`,
      [f.organizationId, skill.id, registered.id],
    );
    await db.query(
      `update bakery.skill_imports
          set state = 'completed', skill_id = $3, skill_version_id = $4,
              resolved_revision = $5, updated_at = now()
        where organization_id = $1 and run_id = $2`,
      [f.organizationId, run.id, skill.id, version.id, INSTALLED],
    );
    const path = `/v1/skills/${skill.id}/source-update`;
    const versionsBefore = await db.query<{ n: string }>(
      `select count(*)::text as n from bakery.skill_versions
        where organization_id = $1 and skill_id = $2`,
      [f.organizationId, skill.id],
    );

    // The source holds the same files: current, and the time of the look moves.
    source.state.files = { ...SKILL_V1 };
    const same = await owner("POST", path);
    assertEquals(same.status, 200, await same.clone().text());
    const current = await same.json() as Check;
    assertEquals(
      [
        current.status,
        current.changes,
        current.latestRevision,
        current.problem,
      ],
      ["current", [], INSTALLED, null],
    );
    assertEquals(
      [current.requestedRevision, current.installedRevision],
      ["main", INSTALLED],
    );
    assert(current.lastCheckedAt !== null);
    assertEquals(source.calls.at(-1)?.requestedRevision, "main");
    assertEquals(source.calls.at(-1)?.path, "skills/guide");

    // The source moved: one file changed, one added, one removed, one the same.
    source.state.revision = NEWER;
    source.state.files = {
      "SKILL.md": "# Guide\n\nline one\nline TWO\nline three\n",
      "references/new.md": "Brand new.\nSecond line.\n",
      "references/same.md": "Unchanged.\n",
    };
    const moved = await owner("POST", path);
    assertEquals(moved.status, 200, await moved.clone().text());
    const update = await moved.json() as Check;
    assertEquals(update.status, "update_available");
    assertEquals(update.latestRevision, NEWER);
    assertEquals(update.installedRevision, INSTALLED);
    assertEquals(update.changes.map((c) => [c.path, c.change]), [
      ["SKILL.md", "changed"],
      ["references/new.md", "added"],
      ["references/old.md", "removed"],
    ]);
    const [changed, added, removed] = update.changes;
    assertEquals(
      changed.diff,
      "@@ -1,5 +1,5 @@\n # Guide\n \n line one\n-line two\n+line TWO\n line three",
    );
    assertEquals(added.diff, "@@ -1,0 +1,2 @@\n+Brand new.\n+Second line.");
    assertEquals(added.installedSha256, null);
    assertEquals(removed.diff, "@@ -1,1 +1,0 @@\n-Going away.");
    assertEquals(removed.latestSha256, null);
    assertEquals(changed.diffOmitted, null);
    assert(update.lastCheckedAt !== null);
    assert(update.lastCheckedAt >= current.lastCheckedAt!);
    const audit = async () =>
      (await f.fixture.pgDatabase.query<{ details: Record<string, unknown> }>(
        `select details from bakery.audit_events
          where operation = 'skills.sourceUpdate' and resource_id = $1
          order by created_at desc, id desc limit 1`,
        [skill.id],
      )).rows[0].details;
    assertEquals(
      [(await audit()).changedFiles, (await audit()).changesTruncated],
      [3, false],
    );

    // An unreachable source is an answer: the last good check time stays.
    source.state.down = true;
    const down = await owner("POST", path);
    assertEquals(down.status, 200, await down.clone().text());
    const unreachable = await down.json() as Check;
    assertEquals(
      [
        unreachable.status,
        unreachable.problem,
        unreachable.latestRevision,
        unreachable.changes,
      ],
      ["unreachable", "SOURCE_UNAVAILABLE", null, []],
    );
    assertEquals(unreachable.lastCheckedAt, update.lastCheckedAt);

    // More differing files than one answer lists: the list stops at 200, says
    // so, and the audit counts every file that differs.
    source.state.down = false;
    source.state.files = Object.fromEntries(
      Array.from(
        { length: 201 },
        (
          _,
          n,
        ) => [`references/n-${String(n).padStart(3, "0")}.md`, `File ${n}.\n`],
      ),
    );
    const many = await owner("POST", path);
    assertEquals(many.status, 200, await many.clone().text());
    const crowded = await many.json() as Check;
    assertEquals(
      [crowded.changes.length, crowded.changesTruncated],
      [200, true],
    );
    // 201 added, plus the three installed files the source no longer has.
    assertEquals(
      [(await audit()).changedFiles, (await audit()).changesTruncated],
      [204, true],
    );

    // The source was looked at with no transaction held open for it.
    assert(source.openTransactions.length >= 4, "the source was fetched");
    assertEquals(source.openTransactions.filter((n) => n !== 0), []);

    // Looking installs nothing.
    const versionsAfter = await db.query<{ n: string }>(
      `select count(*)::text as n from bakery.skill_versions
        where organization_id = $1 and skill_id = $2`,
      [f.organizationId, skill.id],
    );
    assertEquals(versionsAfter.rows[0].n, versionsBefore.rows[0].n);
    const active = await db.query<{ id: string }>(
      `select active_version_id as id from bakery.skills
        where organization_id = $1 and id = $2`,
      [f.organizationId, skill.id],
    );
    assertEquals(active.rows[0].id, version.id);

    // The skill changes while the source is being read: nothing is written and
    // the caller is told, so an answer about an old version is never recorded.
    const checkedAt = async () =>
      (await db.query<{ at: string | null }>(
        `select last_checked_at::text as at from bakery.skill_sources
          where organization_id = $1 and id = $2`,
        [f.organizationId, registered.id],
      )).rows[0].at;
    const auditCount = async () =>
      (await db.query<{ n: string }>(
        `select count(*)::text as n from bakery.audit_events
          where operation = 'skills.sourceUpdate' and resource_id = $1`,
        [skill.id],
      )).rows[0].n;
    const auditsBefore = await auditCount();
    const checkedBefore = await checkedAt();
    source.state.files = { ...SKILL_V1 };
    // The active version moves away while the source is being read (set by
    // SQL: a local version cannot be published to a skill whose source is a
    // Git one). An error thrown inside the adapter would be read as an
    // unreachable source, so a failed move is checked after the call.
    let versionMoves = -1;
    source.during.run = async () => {
      versionMoves = (await db.query(
        `update bakery.skills set active_version_id = null
          where organization_id = $1 and id = $2 and active_version_id = $3`,
        [f.organizationId, skill.id, version.id],
      )).rowCount ?? 0;
    };
    const raced = await owner("POST", path);
    source.during.run = null;
    assertEquals(versionMoves, 1, "the active version moved during the check");
    const racedText = await raced.text();
    assertEquals(raced.status, 409, racedText);
    assertEquals(
      (JSON.parse(racedText) as { reason?: string }).reason,
      "skill_changed_during_source_check",
    );
    assertEquals(await checkedAt(), checkedBefore);
    assertEquals(await auditCount(), auditsBefore);
    // Put the skill back as it was for what follows.
    await db.query(
      `update bakery.skills set active_version_id = $3
        where organization_id = $1 and id = $2`,
      [f.organizationId, skill.id, version.id],
    );

    // An unknown skill is not found; so is another person's private skill.
    const missing = await owner(
      "POST",
      `/v1/skills/${crypto.randomUUID()}/source-update`,
    );
    assertEquals(missing.status, 404);
    const mine = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "mine",
      name: "Mine",
      scope: "personal",
    }, "skill-mine");
    assertEquals(mine.status, 201, await mine.clone().text());
    const hidden = await other(
      "POST",
      `/v1/skills/${(await mine.json() as { id: string }).id}/source-update`,
    );
    assertEquals(hidden.status, 404);
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});
