import { assert, assertEquals } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

type Fx = Awaited<ReturnType<typeof openPersonalSkillFixture>>;
type Draft = {
  id: string;
  baseVersionId: string | null;
  baseRevision: number | null;
  entryPath: string;
  license: string | null;
  files: {
    id: string;
    path: string;
    sizeBytes: number;
    isExecutable: boolean;
  }[];
  totalBytes: number;
  version: number;
};
type Check = {
  ok: boolean;
  problems: {
    file: string | null;
    line: number | null;
    code: string;
    message: string;
  }[];
  draftVersion: number;
};

const encoder = new TextEncoder();
const b64 = (text: string) =>
  btoa(String.fromCharCode(...encoder.encode(text)));

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

async function upload(files: Record<string, string>) {
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
    revision: 1,
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

function api(f: Fx, cookie: string) {
  const headers = (key?: string, version?: number) => ({
    cookie,
    "Bakery-Organization-Id": f.organizationId,
    "content-type": "application/json",
    origin: authTestOrigin,
    ...(key === undefined ? {} : { "Idempotency-Key": key }),
    ...(version === undefined ? {} : { "If-Match": `"${version}"` }),
  });
  const call = (
    method: string,
    path: string,
    options: { body?: unknown; key?: string; version?: number } = {},
  ) =>
    f.fixture.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers: headers(
          options.key ?? (method === "GET" ? undefined : crypto.randomUUID()),
          options.version,
        ),
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
      }),
    );
  return { call };
}

Deno.test("a skill's draft starts from its active version, is edited and checked file by file, and is discarded", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-drafts-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const owner = api(f, f.ownerCookie);
    const other = api(f, f.adminCookie);
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "guide",
      name: "Guide",
    }, "skill-guide");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const draftPath = `/v1/skills/${skill.id}/draft`;

    // An empty skill gets an empty draft that says what it lacks.
    const emptyOpen = await owner.call("POST", draftPath);
    assertEquals(emptyOpen.status, 200, await emptyOpen.clone().text());
    const empty = await emptyOpen.json() as Draft;
    const reopened = await owner.call("POST", draftPath);
    assertEquals(reopened.status, 200, await reopened.clone().text());
    assertEquals((await reopened.json() as Draft).id, empty.id);
    assertEquals([empty.baseVersionId, empty.files.length, empty.license], [
      null,
      0,
      null,
    ]);
    const emptyCheck = await owner.call("POST", `${draftPath}/check`);
    assertEquals(emptyCheck.status, 200, await emptyCheck.clone().text());
    const emptyProblems = await emptyCheck.json() as Check;
    assertEquals(emptyProblems.ok, false);
    assert(emptyProblems.problems.length > 0);
    const dropped = await owner.call("DELETE", draftPath, {
      version: empty.version,
    });
    assertEquals(dropped.status, 204, await dropped.clone().text());

    // Publish a version, then open a draft from it.
    const publish = await f.post(
      f.ownerCookie,
      `/v1/skills/${skill.id}/versions`,
      await upload({
        "SKILL.md": "# Guide\n\nRead [the reference](references/guide.md).\n",
        "references/guide.md": "The reference.\n",
      }),
      "publish-guide-v1",
    );
    assertEquals(publish.status, 201, await publish.clone().text());
    const opened = await owner.call("POST", draftPath);
    assertEquals(opened.status, 200, await opened.clone().text());
    let draft = await opened.json() as Draft;
    assertEquals(draft.baseRevision, 1);
    assertEquals(draft.license, "MIT");
    assertEquals(draft.files.map((file) => file.path), [
      "SKILL.md",
      "references/guide.md",
    ]);
    // Opening again is the same draft.
    const again = await (await owner.call("POST", draftPath)).json() as Draft;
    assertEquals([again.id, again.version], [draft.id, draft.version]);
    assertEquals((await owner.call("GET", draftPath)).status, 200);

    // Contents are read one file at a time, by the id the draft lists.
    const instructions = draft.files[0];
    const read = await owner.call(
      "GET",
      `${draftPath}/files/${instructions.id}`,
    );
    assertEquals(read.status, 200, await read.clone().text());
    const body = await read.json() as { path: string; contentBase64: string };
    assertEquals(atob(body.contentBase64).includes("the reference"), true);

    // As it stands it publishes.
    const clean = await (await owner.call("POST", `${draftPath}/check`))
      .json() as Check;
    assertEquals([clean.ok, clean.problems, clean.draftVersion], [
      true,
      [],
      draft.version,
    ]);

    // Saving a file needs the draft's version; a stale one is "someone else changed it".
    const edited =
      "# Guide\n\nRead [the reference](references/guide.md)\nand [the missing one](references/missing.md).\n";
    const save = (
      cookieApi: ReturnType<typeof api>,
      version: number,
      content = edited,
    ) =>
      cookieApi.call("POST", `${draftPath}/files`, {
        version,
        body: {
          path: "SKILL.md",
          mediaType: "text/markdown",
          contentBase64: b64(content),
        },
      });
    const saved = await save(owner, draft.version);
    assertEquals(saved.status, 200, await saved.clone().text());
    const afterSave = await saved.json() as Draft;
    assertEquals(afterSave.version, draft.version + 1);
    assertEquals((await save(other, draft.version)).status, 412);
    assertEquals(
      (await owner.call("POST", `${draftPath}/files`, {
        body: {
          path: "SKILL.md",
          mediaType: "text/markdown",
          contentBase64: b64(edited),
        },
      })).status,
      428,
    );
    draft = afterSave;

    // The check names the file and the line, in plain words.
    const flagged = await (await owner.call("POST", `${draftPath}/check`))
      .json() as Check;
    assertEquals(flagged.ok, false);
    assertEquals(
      flagged.problems.map(({ file, line, code }) => ({ file, line, code })),
      [
        { file: "SKILL.md", line: 4, code: "referenced_file_missing" },
      ],
    );
    assertEquals(
      flagged.problems[0].message,
      'The instructions mention "references/missing.md", which is not in this skill.',
    );

    // Bad files are refused with the field named; nothing is stored.
    const unsafe = await owner.call("POST", `${draftPath}/files`, {
      version: draft.version,
      body: {
        path: "../escape.md",
        mediaType: "text/markdown",
        contentBase64: b64("x"),
      },
    });
    // The request schema refuses an unsafe path before any draft is read.
    assertEquals(unsafe.status, 400, await unsafe.clone().text());
    const runnable = await owner.call("POST", `${draftPath}/files`, {
      version: draft.version,
      body: {
        path: "notes.md",
        mediaType: "text/markdown",
        isExecutable: true,
        contentBase64: b64("x"),
      },
    });
    assertEquals(runnable.status, 422);
    const clash = await owner.call("POST", `${draftPath}/files`, {
      version: draft.version,
      body: {
        path: "REFERENCES/Guide.md",
        mediaType: "text/markdown",
        contentBase64: b64("x"),
      },
    });
    assertEquals(clash.status, 409);
    assertEquals(
      ((await (await owner.call("GET", draftPath)).json()) as Draft).version,
      draft.version,
    );

    // A new file, a deletion by id, and the license.
    const added = await (await owner.call("POST", `${draftPath}/files`, {
      version: draft.version,
      body: {
        path: "references/missing.md",
        mediaType: "text/markdown",
        contentBase64: b64("Now it exists.\n"),
      },
    })).json() as Draft;
    assertEquals(added.files.length, 3);
    const fixed = await (await owner.call("POST", `${draftPath}/check`))
      .json() as Check;
    assertEquals(fixed.ok, true);

    // A problem that comes from the upload validation, not one the draft raises
    // itself, still names its file. The API never stores a file whose bytes
    // disagree with its recorded size, so the row is changed underneath it.
    await f.fixture.pgDatabase.query(
      "update bakery.skill_draft_files set content = $3 where draft_id = $1 and path = $2",
      [added.id, "references/missing.md", encoder.encode("changed\n")],
    );
    const resized = await (await owner.call("POST", `${draftPath}/check`))
      .json() as Check;
    assertEquals(
      resized.problems.map(({ file, code }) => ({ file, code })),
      [{ file: "references/missing.md", code: "file_size" }],
    );
    await f.fixture.pgDatabase.query(
      "update bakery.skill_draft_files set content = $3 where draft_id = $1 and path = $2",
      [added.id, "references/missing.md", encoder.encode("Now it exists.\n")],
    );
    const guide = added.files.find((file) =>
      file.path === "references/guide.md"
    )!;
    const removed = await owner.call(
      "DELETE",
      `${draftPath}/files/${guide.id}`,
      { version: added.version },
    );
    assertEquals(removed.status, 200, await removed.clone().text());
    const afterDelete = await removed.json() as Draft;
    assertEquals(afterDelete.files.map((file) => file.path), [
      "SKILL.md",
      "references/missing.md",
    ]);
    const broken = await (await owner.call("POST", `${draftPath}/check`))
      .json() as Check;
    assertEquals(broken.problems.map((problem) => problem.code), [
      "referenced_file_missing",
    ]);
    // A license with a character that cannot be printed is refused and says so.
    const badLicense = await owner.call("PATCH", draftPath, {
      version: afterDelete.version,
      body: { license: "tab\there" },
    });
    assertEquals(badLicense.status, 422, await badLicense.clone().text());
    assert((await badLicense.text()).includes('"license"'));
    assertEquals(
      ((await (await owner.call("GET", draftPath)).json()) as Draft).license,
      "MIT",
    );
    const relicensed = await owner.call("PATCH", draftPath, {
      version: afterDelete.version,
      body: { license: "Apache-2.0" },
    });
    assertEquals(relicensed.status, 200, await relicensed.clone().text());
    const final = await relicensed.json() as Draft;
    assertEquals(final.license, "Apache-2.0");

    // A person's own skill has a draft only for its owner, and a skill shared by
    // Bakery has none.
    const personal = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "mine",
      name: "Mine",
      scope: "personal",
    }, "skill-mine");
    const mine = await personal.json() as { id: string };
    assertEquals(
      (await other.call("POST", `/v1/skills/${mine.id}/draft`)).status,
      404,
    );
    assertEquals(
      (await owner.call("POST", `/v1/skills/${mine.id}/draft`)).status,
      200,
    );
    await f.fixture.pgDatabase.query(
      "update bakery.skills set scope = 'global' where id = $1",
      [skill.id],
    );
    assertEquals((await owner.call("POST", draftPath)).status, 403);
    await f.fixture.pgDatabase.query(
      "update bakery.skills set scope = 'organization' where id = $1",
      [skill.id],
    );

    // Discarding needs the version too.
    assertEquals(
      (await owner.call("DELETE", draftPath, { version: draft.version }))
        .status,
      412,
    );
    const discarded = await owner.call("DELETE", draftPath, {
      version: final.version,
    });
    assertEquals(discarded.status, 204, await discarded.clone().text());
    assertEquals((await owner.call("GET", draftPath)).status, 404);
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a draft refuses a save past its file count or its size", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-caps-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const owner = api(f, f.ownerCookie);
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "caps",
      name: "Caps",
    }, "skill-caps");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const draftPath = `/v1/skills/${skill.id}/draft`;
    const opened = await owner.call("POST", draftPath);
    assertEquals(opened.status, 200, await opened.clone().text());
    let draft = await opened.json() as Draft;
    const save = async (path: string) => {
      const response = await owner.call("POST", `${draftPath}/files`, {
        version: draft.version,
        body: {
          path,
          mediaType: "text/markdown",
          contentBase64: b64("x"),
        },
      });
      return response;
    };
    const first = await save("SKILL.md");
    assertEquals(first.status, 200, await first.clone().text());
    draft = await first.json() as Draft;
    const fill = (count: number) =>
      f.fixture.pgDatabase.query(
        `insert into bakery.skill_draft_files (
           id, organization_id, draft_id, path, media_type, is_executable,
           content, size_bytes, sha256
         ) select gen_random_uuid(), $1, $2,
                  'bulk/' || lpad(g::text, 4, '0') || '.md', 'text/markdown',
                  false, '\\x78'::bytea, 1, repeat('0', 64)
             from generate_series(1, $3::integer) g`,
        [f.organizationId, draft.id, count],
      );

    // 256 files are allowed; the 257th is too many.
    await fill(254);
    const atLimit = await save("notes-a.md");
    assertEquals(atLimit.status, 200, await atLimit.clone().text());
    draft = await atLimit.json() as Draft;
    const overCount = await save("notes-b.md");
    assertEquals(overCount.status, 409, await overCount.clone().text());
    assert((await overCount.text()).includes("draft_too_large"));
    await f.fixture.pgDatabase.query(
      "delete from bakery.skill_draft_files where draft_id = $1 and path like 'bulk/%'",
      [draft.id],
    );

    // 10 MiB of files in all is allowed; one byte more is too much.
    const cap = 10 * 1024 * 1024;
    await f.fixture.pgDatabase.query(
      "update bakery.skill_draft_files set size_bytes = $2 where draft_id = $1 and path = 'SKILL.md'",
      [draft.id, cap - 2],
    );
    const atSize = await save("notes-c.md");
    assertEquals(atSize.status, 200, await atSize.clone().text());
    draft = await atSize.json() as Draft;
    const overSize = await save("notes-d.md");
    assertEquals(overSize.status, 409, await overSize.clone().text());
    assert((await overSize.text()).includes("draft_too_large"));
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("two people opening a draft at the same moment both get the one draft", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-race-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  const holder = await f.fixture.pgDatabase.connect();
  try {
    const owner = api(f, f.ownerCookie);
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "race",
      name: "Race",
    }, "skill-race");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const draftPath = `/v1/skills/${skill.id}/draft`;

    // The other request's draft is inserted but not yet committed, so this
    // request cannot see it and goes on to insert its own, which must wait for
    // the first to finish. That is the overlap, held open on purpose.
    const draftId = crypto.randomUUID();
    await holder.query("begin");
    await holder.query(
      `insert into bakery.skill_drafts (
         id, organization_id, skill_id, entry_path, created_by, updated_by
       ) values ($1, $2, $3, 'SKILL.md', $4, $4)`,
      [draftId, f.organizationId, skill.id, f.ownerPrincipalId],
    );
    const pending = owner.call("POST", draftPath);
    let blocked = false;
    for (let wait = 0; wait < 400 && !blocked; wait += 1) {
      // pg_locks is readable by every role; the open request runs as the
      // application role, whose pg_stat_activity query text is hidden from here.
      const waiting = await f.fixture.pgDatabase.query<{ n: number }>(
        `select count(*)::int as n from pg_locks
          where not granted and locktype = 'transactionid'
            and pid <> pg_backend_pid()`,
      );
      blocked = waiting.rows[0].n > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(
      blocked,
      "the open request never waited on the other draft's insert",
    );
    await holder.query("commit");

    const response = await pending;
    assertEquals(response.status, 200, await response.clone().text());
    const draft = await response.json() as Draft;
    assertEquals(draft.id, draftId, "the request returned the draft that won");
    const rows = await f.fixture.pgDatabase.query<{ count: string }>(
      "select count(*)::text as count from bakery.skill_drafts where skill_id = $1",
      [skill.id],
    );
    assertEquals(rows.rows[0].count, "1");
    // The request that lost made nothing, so it audits nothing.
    const audits = await f.fixture.pgDatabase.query<{ count: string }>(
      "select count(*)::text as count from bakery.audit_events where operation = 'skillDrafts.open' and details->>'skillId' = $1",
      [skill.id],
    );
    assertEquals(audits.rows[0].count, "0");
  } finally {
    await holder.query("rollback").catch(() => {});
    holder.release();
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a stray percent sign in a link is a problem the check reports, not a server error", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-percent-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const owner = api(f, f.ownerCookie);
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "percent",
      name: "Percent",
    }, "skill-percent");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const draftPath = `/v1/skills/${skill.id}/draft`;
    const opened = await owner.call("POST", draftPath);
    const draft = await opened.json() as Draft;
    const saved = await owner.call("POST", `${draftPath}/files`, {
      version: draft.version,
      body: {
        path: "SKILL.md",
        mediaType: "text/markdown",
        contentBase64: b64("# Percent\n\nSee [the offer](50%off.md).\n"),
      },
    });
    assertEquals(saved.status, 200, await saved.clone().text());
    const checked = await owner.call("POST", `${draftPath}/check`);
    assertEquals(checked.status, 200, await checked.clone().text());
    const check = await checked.json() as Check;
    // The skill has no license yet, which the check also says; the link is the
    // problem this case is about.
    const linkProblems = check.problems.filter((problem) =>
      problem.code === "referenced_file_missing"
    );
    assertEquals(
      linkProblems.map(({ file, line, code }) => ({ file, line, code })),
      [{ file: "SKILL.md", line: 3, code: "referenced_file_missing" }],
    );
    assert(linkProblems[0].message.includes("50%off.md"));
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a draft publishes as the next version once; a stale or flawed draft publishes nothing", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-publish-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const owner = api(f, f.ownerCookie);
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "publisher",
      name: "Publisher",
    }, "skill-publisher");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const draftPath = `/v1/skills/${skill.id}/draft`;
    const publishPath = `${draftPath}/publish`;
    const first = await f.post(
      f.ownerCookie,
      `/v1/skills/${skill.id}/versions`,
      await upload({
        "SKILL.md": "# Publisher\n\nRead [the notes](notes.md).\n",
        "notes.md": "The notes.\n",
      }),
      "publisher-v1",
    );
    assertEquals(first.status, 201, await first.clone().text());
    const versionOne = await first.json() as { id: string; digest: string };
    const versions = () =>
      f.fixture.pgDatabase.query<
        { id: string; revision: number; digest: string }
      >(
        "select id, revision, digest from bakery.skill_versions where skill_id = $1 order by revision",
        [skill.id],
      ).then((result) => result.rows);

    const opened = await (await owner.call("POST", draftPath)).json() as Draft;
    // The draft's version is required, and a stale one is refused.
    assertEquals((await owner.call("POST", publishPath)).status, 428);
    assertEquals(
      (await owner.call("POST", publishPath, { version: opened.version + 5 }))
        .status,
      412,
    );

    // A draft with a problem is refused with it, and nothing is published.
    const save = async (content: string, version: number) => {
      const saved = await owner.call("POST", `${draftPath}/files`, {
        version,
        body: {
          path: "SKILL.md",
          mediaType: "text/markdown",
          contentBase64: b64(content),
        },
      });
      assertEquals(saved.status, 200, await saved.clone().text());
      return await saved.json() as Draft;
    };
    const flawed = await save(
      "# Publisher 2\n\nRead [the notes](notes.md) and [gone](gone.md).\n",
      opened.version,
    );
    const refused = await owner.call("POST", publishPath, {
      version: flawed.version,
    });
    assertEquals(refused.status, 422, await refused.clone().text());
    assert((await refused.text()).includes("gone.md"));
    assertEquals((await versions()).length, 1);
    assertEquals(
      (await (await owner.call("GET", draftPath)).json() as Draft).version,
      flawed.version,
    );

    // The corrected draft publishes as revision 2, and the draft is gone.
    const fixed = await save(
      "# Publisher 2\n\nRead [the notes](notes.md).\n",
      flawed.version,
    );
    const key = "publisher-v2";
    const published = await owner.call("POST", publishPath, {
      version: fixed.version,
      key,
    });
    assertEquals(published.status, 201, await published.clone().text());
    const versionTwo = await published.json() as {
      id: string;
      revision: number;
      digest: string;
    };
    assertEquals(versionTwo.revision, 2);
    assert(versionTwo.digest !== versionOne.digest);
    assertEquals((await owner.call("GET", draftPath)).status, 404);
    const rows = await versions();
    assertEquals(rows.map((row) => row.revision), [1, 2]);
    // The first version is exactly as it was published.
    assertEquals(rows[0], {
      id: versionOne.id,
      revision: 1,
      digest: versionOne.digest,
    });
    const active = await f.fixture.pgDatabase.query<
      { active_version_id: string }
    >("select active_version_id from bakery.skills where id = $1", [skill.id]);
    assertEquals(active.rows[0].active_version_id, versionTwo.id);

    // The same request again is the same answer, not a third version.
    const replay = await owner.call("POST", publishPath, {
      version: fixed.version,
      key,
    });
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(replay.headers.get("idempotent-replayed"), "true");
    assertEquals((await replay.json() as { id: string }).id, versionTwo.id);
    assertEquals((await versions()).length, 2);
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an administrator publishes an organization skill's draft with no grant", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-org-publish-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const admin = api(f, f.ownerCookie);
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "shared-publisher",
      name: "Shared publisher",
      scope: "organization",
    }, "skill-shared-publisher");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const first = await f.post(
      f.ownerCookie,
      `/v1/skills/${skill.id}/versions`,
      await upload({ "SKILL.md": "# Shared\n\nFirst.\n" }),
      "shared-v1",
    );
    assertEquals(first.status, 201, await first.clone().text());
    const draftPath = `/v1/skills/${skill.id}/draft`;
    const opened = await admin.call("POST", draftPath);
    assertEquals(opened.status, 200, await opened.clone().text());
    const draft = await opened.json() as Draft;
    const saved = await admin.call("POST", `${draftPath}/files`, {
      version: draft.version,
      body: {
        path: "SKILL.md",
        mediaType: "text/markdown",
        contentBase64: b64("# Shared\n\nBy the administrator.\n"),
      },
    });
    assertEquals(saved.status, 200, await saved.clone().text());
    const edited = await saved.json() as Draft;
    const published = await admin.call("POST", `${draftPath}/publish`, {
      version: edited.version,
    });
    assertEquals(published.status, 201, await published.clone().text());
    assertEquals((await published.json() as { revision: number }).revision, 2);
    assertEquals((await admin.call("GET", draftPath)).status, 404);
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});
