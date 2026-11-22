/**
 * #74 rev 4 server needs without a migration: a skill source's name, the import
 * read that says what an import made or why it failed, taking a reviewed update
 * of an imported skill, and renaming a draft file in one step.
 */
import { assertEquals } from "@std/assert";
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

type Run = { id: string };
type ImportResult = {
  runId: string;
  state: string;
  skillId: string | null;
  versionId: string | null;
  failureCode: string | null;
};

function command(
  f: Fx,
  cookie: string,
  path: string,
  body: unknown,
  options: { key: string; version?: number },
) {
  return f.fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: "POST",
      headers: {
        cookie,
        "Bakery-Organization-Id": f.organizationId,
        "content-type": "application/json",
        origin: authTestOrigin,
        "Idempotency-Key": options.key,
        ...(options.version === undefined
          ? {}
          : { "If-Match": `"${options.version}"` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** A local skill recorded as imported from a Git source at "main". */
async function importedSkill(f: Fx, slug: string) {
  const db = f.fixture.pgDatabase;
  const created = await f.post(f.ownerCookie, "/v1/skills", {
    slug,
    name: slug,
    scope: "organization",
  }, `skill-${slug}`);
  assertEquals(created.status, 201, await created.clone().text());
  const skill = await created.json() as { id: string };
  const publish = await f.post(
    f.ownerCookie,
    `/v1/skills/${skill.id}/versions`,
    await upload(SKILL_V1),
    `publish-${slug}`,
  );
  assertEquals(publish.status, 201, await publish.clone().text());
  const version = await publish.json() as { id: string };
  const sourceResponse = await f.post(f.ownerCookie, "/v1/skill-sources", {
    sourceType: "git",
    url: `https://github.com/example/${slug}.git`,
    name: "Example skills",
    license: "MIT",
  }, `source-${slug}`);
  assertEquals(sourceResponse.status, 201, await sourceResponse.clone().text());
  const source = await sourceResponse.json() as { id: string; name: string };
  const admitted = await f.post(f.ownerCookie, "/v1/skill-imports", {
    sourceId: source.id,
    revision: "main",
    path: `skills/${slug}`,
  }, `import-${slug}`);
  assertEquals(admitted.status, 201, await admitted.clone().text());
  const run = await admitted.json() as Run;
  await db.query(
    `update bakery.skill_versions set source_revision = $3
      where organization_id = $1 and id = $2`,
    [f.organizationId, version.id, INSTALLED],
  );
  await db.query(
    `update bakery.skills set source_id = $3, source_path = $4
      where organization_id = $1 and id = $2`,
    [f.organizationId, skill.id, source.id, `skills/${slug}`],
  );
  await db.query(
    `update bakery.skill_imports
        set state = 'completed', skill_id = $3, skill_version_id = $4,
            resolved_revision = $5, updated_at = now()
      where organization_id = $1 and run_id = $2`,
    [f.organizationId, run.id, skill.id, version.id, INSTALLED],
  );
  return { skill, version, source, run };
}

Deno.test("a skill source is read with its name", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const created = await f.post(f.ownerCookie, "/v1/skill-sources", {
      sourceType: "git",
      url: "https://github.com/example/named.git",
      name: "Team skills",
      license: "MIT",
    }, "named-source");
    assertEquals(created.status, 201, await created.clone().text());
    const source = await created.json() as { id: string; name: string | null };
    assertEquals(source.name, "Team skills");
    const read = await f.read(f.ownerCookie, `/v1/skill-sources/${source.id}`);
    assertEquals(
      (await read.json() as { name: string | null }).name,
      "Team skills",
    );
    const list = await f.read(f.ownerCookie, "/v1/skill-sources");
    const items =
      (await list.json() as { items: { id: string; name: string | null }[] })
        .items;
    assertEquals(
      items.find((item) => item.id === source.id)?.name,
      "Team skills",
    );
  } finally {
    await f.close();
  }
});

Deno.test("an import's read says what it made, or the code it failed with", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-import-read-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const db = f.fixture.pgDatabase;
    const made = await importedSkill(f, "made");
    const read = async (cookie: string, runId: string) => {
      const response = await f.read(cookie, `/v1/skill-imports/${runId}`);
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json() as ImportResult;
    };
    assertEquals(await read(f.adminCookie, made.run.id), {
      runId: made.run.id,
      state: "completed",
      skillId: made.skill.id,
      versionId: made.version.id,
      failureCode: null,
    });

    // A queued import has made nothing yet; a failed one names its code.
    const queued = await f.post(f.ownerCookie, "/v1/skill-imports", {
      sourceId: made.source.id,
      revision: "v2",
      path: "skills/made",
    }, "import-queued");
    assertEquals(queued.status, 201, await queued.clone().text());
    const queuedRun = await queued.json() as Run;
    assertEquals(await read(f.ownerCookie, queuedRun.id), {
      runId: queuedRun.id,
      state: "queued",
      skillId: null,
      versionId: null,
      failureCode: null,
    });
    await db.query(
      `update bakery.skill_imports
          set state = 'failed', terminal_fault = '{"code":"SOURCE_UNAVAILABLE"}'
        where organization_id = $1 and run_id = $2`,
      [f.organizationId, queuedRun.id],
    );
    assertEquals(await read(f.ownerCookie, queuedRun.id), {
      runId: queuedRun.id,
      state: "failed",
      skillId: null,
      versionId: null,
      failureCode: "SOURCE_UNAVAILABLE",
    });

    // A private skill an import made is named to its owner only.
    await db.query(
      `update bakery.skills set scope = 'personal', owner_principal_id = $2
        where id = $1`,
      [made.skill.id, f.ownerPrincipalId],
    );
    assertEquals(
      (await read(f.ownerCookie, made.run.id)).skillId,
      made.skill.id,
    );
    const hidden = await read(f.adminCookie, made.run.id);
    assertEquals([hidden.skillId, hidden.versionId], [null, null]);
    assertEquals(
      (await f.read(f.ownerCookie, `/v1/skill-imports/${crypto.randomUUID()}`))
        .status,
      404,
    );
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("taking a reviewed update imports exactly that revision and keeps following the branch", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-take-update-" });
  const source = fakeSource();
  const f = await openPersonalSkillFixture({
    skillFileRoot: root,
    skillSourceAdapter: source.adapter,
  });
  try {
    const db = f.fixture.pgDatabase;
    const owner = api(f, f.ownerCookie);
    const { skill } = await importedSkill(f, "followed");
    source.state.revision = NEWER;
    source.state.files = { ...SKILL_V1, "SKILL.md": "# Guide\n\nnewer\n" };
    const check = await owner("POST", `/v1/skills/${skill.id}/source-update`);
    const checked = await check.json() as Check;
    assertEquals([checked.status, checked.latestRevision], [
      "update_available",
      NEWER,
    ]);
    const skillVersion = async () =>
      (await (await f.read(f.ownerCookie, `/v1/skills/${skill.id}`))
        .json() as { version: number }).version;
    const path = `/v1/skills/${skill.id}/source-update/take`;

    // If-Match is required, and a stale one is refused.
    assertEquals(
      (await command(f, f.ownerCookie, path, { revision: NEWER }, {
        key: "take-no-match",
      })).status,
      428,
    );
    assertEquals(
      (await command(f, f.ownerCookie, path, { revision: NEWER }, {
        key: "take-stale",
        version: (await skillVersion()) + 3,
      })).status,
      412,
    );

    // The source moved past what was reviewed: refused, nothing admitted.
    source.state.revision = "c".repeat(40);
    const moved = await command(f, f.ownerCookie, path, { revision: NEWER }, {
      key: "take-moved",
      version: await skillVersion(),
    });
    const movedText = await moved.text();
    assertEquals(moved.status, 409, movedText);
    assertEquals(
      (JSON.parse(movedText) as { reason?: string }).reason,
      "skill_update_revision_not_latest",
    );

    // The reviewed revision is still the latest: one import of exactly it.
    source.state.revision = NEWER;
    const request = { key: "take-newer", version: await skillVersion() };
    const taken = await command(
      f,
      f.ownerCookie,
      path,
      { revision: NEWER },
      request,
    );
    assertEquals(taken.status, 201, await taken.clone().text());
    const run = await taken.json() as Run;
    const replay = await command(
      f,
      f.ownerCookie,
      path,
      { revision: NEWER },
      request,
    );
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals((await replay.json() as Run).id, run.id);
    const admitted = await db.query<{
      requested_revision: string;
      source_path: string;
      followed: string | null;
    }>(
      `select import.requested_revision, import.source_path,
              run.snapshot #>> '{request,followedRevision}' as followed
         from bakery.skill_imports as import
         join bakery.workflow_runs as run on run.id = import.run_id
        where import.run_id = $1`,
      [run.id],
    );
    assertEquals(admitted.rows[0], {
      requested_revision: NEWER,
      source_path: "skills/followed",
      followed: "main",
    });
    const audits = await db.query<{ n: number }>(
      `select count(*)::int as n from bakery.audit_events
        where operation = 'skills.takeSourceUpdate' and resource_id::text = $1`,
      [skill.id],
    );
    assertEquals(audits.rows[0].n, 1);
    const events = await db.query<{ n: number }>(
      `select count(*)::int as n from bakery.domain_events
        where event_type = 'skill.import.requested' and aggregate_id::text = $1`,
      [run.id],
    );
    assertEquals(events.rows[0].n, 1);

    // Once that import completes, the next check still follows main.
    const newVersion = `00000000-0000-8000-8000-${
      crypto.randomUUID().slice(-12)
    }`;
    await db.query(
      `insert into bakery.skill_versions (
         id, organization_id, skill_id, revision, source_revision, digest,
         entry_path, manifest, status, created_by
       ) values ($1, $2, $3, 2, $4, $5, 'SKILL.md', '{}'::jsonb,
                 'published', $6)`,
      [
        newVersion,
        f.organizationId,
        skill.id,
        NEWER,
        `sha256:${"e".repeat(64)}`,
        f.ownerPrincipalId,
      ],
    );
    await db.query(
      `update bakery.skills set active_version_id = $2 where id = $1`,
      [skill.id, newVersion],
    );
    await db.query(
      `update bakery.skill_imports
          set state = 'completed', skill_id = $2, skill_version_id = $3,
              resolved_revision = $4, updated_at = now() + interval '1 second'
        where run_id = $1`,
      [run.id, skill.id, newVersion, NEWER],
    );
    const again = await owner("POST", `/v1/skills/${skill.id}/source-update`);
    const rechecked = await again.json() as Check;
    assertEquals(again.status, 200, JSON.stringify(rechecked));
    assertEquals(
      [rechecked.requestedRevision, rechecked.installedRevision],
      ["main", NEWER],
    );
    assertEquals(source.calls.at(-1)?.requestedRevision, "main");
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a draft file is renamed in one step, keeping its content and its problems", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const owner = api(f, f.ownerCookie);
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "renamed",
      name: "Renamed",
      scope: "personal",
    }, "rename-skill");
    const skill = await created.json() as { id: string };
    const draftPath = `/v1/skills/${skill.id}/draft`;
    const opened = await owner("POST", draftPath);
    assertEquals(opened.status, 200, await opened.clone().text());
    let draft = await opened.json() as {
      version: number;
      files: { path: string; sizeBytes: number }[];
    };
    for (
      const [path, text] of [
        [
          "SKILL.md",
          "# Renamed\n\nRead [notes](notes.md).\nSee [gone](gone.md).\n",
        ],
        ["notes.md", "First line.\n"],
      ]
    ) {
      const saved = await command(f, f.ownerCookie, `${draftPath}/files`, {
        path,
        mediaType: "text/markdown",
        contentBase64: b64(text),
      }, { key: `save-${path}`, version: draft.version });
      assertEquals(saved.status, 200, await saved.clone().text());
      draft = await saved.json() as typeof draft;
    }
    type Problems = {
      problems: { file: string | null; line: number | null; code: string }[];
    };
    const problems = async () =>
      (await (await owner("POST", `${draftPath}/check`)).json() as Problems)
        .problems.filter((problem) =>
          problem.code === "referenced_file_missing"
        );
    const before = await problems();
    assertEquals(
      before.map((problem) => [problem.file, problem.line]),
      [["SKILL.md", 4]],
    );

    const renamePath = `${draftPath}/files/rename`;
    // Refused onto a path the draft already has, ignoring capitals.
    const clash = await command(f, f.ownerCookie, renamePath, {
      path: "notes.md",
      newPath: "skill.MD",
    }, { key: "rename-clash", version: draft.version });
    assertEquals(clash.status, 409, await clash.clone().text());
    const stale = await command(f, f.ownerCookie, renamePath, {
      path: "SKILL.md",
      newPath: "guide.md",
    }, { key: "rename-stale", version: draft.version + 9 });
    assertEquals(stale.status, 412);

    // The entry file moves; the draft's entry follows it.
    const renamed = await command(f, f.ownerCookie, renamePath, {
      path: "SKILL.md",
      newPath: "guide.md",
    }, { key: "rename-entry", version: draft.version });
    assertEquals(renamed.status, 200, await renamed.clone().text());
    const after = await renamed.json() as typeof draft;
    assertEquals(after.version, draft.version + 1);
    assertEquals(after.files.map((file) => file.path).sort(), [
      "guide.md",
      "notes.md",
    ]);
    assertEquals(
      after.files.find((file) => file.path === "guide.md")?.sizeBytes,
      draft.files.find((file) => file.path === "SKILL.md")?.sizeBytes,
    );
    assertEquals(
      (after as unknown as { entryPath: string }).entryPath,
      "guide.md",
    );
    // The same problem, at the same line, now at the new path.
    assertEquals(
      (await problems()).map((problem) => [problem.file, problem.line]),
      [["guide.md", 4]],
    );
    const content = await f.fixture.pgDatabase.query<{ content: Uint8Array }>(
      `select content from bakery.skill_draft_files where path = 'guide.md'`,
    );
    assertEquals(
      new TextDecoder().decode(content.rows[0].content),
      "# Renamed\n\nRead [notes](notes.md).\nSee [gone](gone.md).\n",
    );
  } finally {
    await f.close();
  }
});
