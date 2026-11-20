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
    assertEquals(unsafe.status, 422, await unsafe.clone().text());
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
