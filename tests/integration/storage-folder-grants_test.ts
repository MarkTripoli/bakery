import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { addMember, type Member } from "../helpers/durable-questions.ts";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import { resetTestDatabase } from "../../apps/server/src/platform/migrate.ts";

const databaseConfig = readTestDatabaseConfig();

async function resetDatabase(): Promise<void> {
  const reset = openDatabase(databaseConfig.databaseUrl);
  try {
    await resetTestDatabase(reset, {
      targetUrl: databaseConfig.databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
  } finally {
    await closeDatabase(reset);
  }
}

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

function call(
  fixture: Fixture,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: cookie,
        "Idempotency-Key": crypto.randomUUID(),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ));
}

async function ok(response: Response, status = 200): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

async function shape(response: Response): Promise<[number, unknown]> {
  const body = JSON.parse(await response.text()) as Json;
  return [response.status, body.code];
}

const text = (value: string) => btoa(value);

const folder = async (fixture: Fixture, cookie: string, path: string) =>
  (await ok(
    await call(fixture, cookie, "POST", "/v1/storage/folders", { path }),
    201,
  )).id as string;

const put = (fixture: Fixture, cookie: string, path: string) =>
  call(fixture, cookie, "PUT", "/v1/storage/files", {
    path,
    mediaType: "text/plain",
    content: text("hello"),
  });

const grant = (
  fixture: Fixture,
  cookie: string,
  folderId: string,
  principalId: string,
  level: string,
) =>
  call(fixture, cookie, "POST", `/v1/storage/folders/${folderId}/grants`, {
    principalId,
    level,
  });

const restrict = (
  fixture: Fixture,
  cookie: string,
  folderId: string,
  restricted: boolean,
) =>
  call(fixture, cookie, "POST", `/v1/storage/folders/${folderId}/restriction`, {
    restricted,
  });

const listing = (fixture: Fixture, cookie: string, folderId: string) =>
  call(fixture, cookie, "GET", `/v1/storage/folders/${folderId}/entries`);

const names = async (response: Response): Promise<string[]> =>
  ((await ok(response)).items as Json[]).map((item) => String(item.name));

async function restrictedFolderIsHiddenAndAGrantOpensItAtItsLevel(
  fixture: Fixture,
): Promise<void> {
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");
  const cara: Member = await addMember(fixture as never, seed, "cara");

  const secret = await folder(fixture, admin, "/shared/secret");
  await ok(await put(fixture, admin, "/shared/secret/plan.txt"));
  await ok(await restrict(fixture, admin, secret, true), 200);

  const missing = await shape(
    await listing(fixture, bob.cookie, crypto.randomUUID()),
  );
  assertEquals(missing, [404, "RESOURCE_NOT_FOUND"]);
  assertEquals(
    await shape(await listing(fixture, bob.cookie, secret)),
    missing,
  );
  assertEquals(
    await shape(await put(fixture, bob.cookie, "/shared/secret/x.txt")),
    await shape(await put(fixture, bob.cookie, "/shared/nowhere/x.txt")),
  );
  const shared = await ok(
    await call(fixture, admin, "GET", "/v1/storage/roots"),
  );
  const sharedId = (shared.items as Json[]).find((r) => r.name === "shared")!
    .id as string;
  assert(
    !(await names(await listing(fixture, bob.cookie, sharedId))).includes(
      "secret",
    ),
  );
  assert(
    (await names(await listing(fixture, admin, sharedId))).includes("secret"),
  );

  await ok(await grant(fixture, admin, secret, bob.principalId, "view"), 201);
  assertEquals(await names(await listing(fixture, bob.cookie, secret)), [
    "plan.txt",
  ]);
  assert(
    (await names(await listing(fixture, bob.cookie, sharedId))).includes(
      "secret",
    ),
  );
  const refused = await put(fixture, bob.cookie, "/shared/secret/x.txt");
  assertEquals(refused.status, 409);
  const refusal = JSON.parse(await refused.text()) as Json;
  assertEquals(refusal.code, "STORAGE_AREA_REFUSED");
  assertEquals(
    (refusal.params as Json | undefined)?.reason ?? refusal.reason,
    "folder_view_only",
  );

  await ok(await grant(fixture, admin, secret, bob.principalId, "edit"), 201);
  await ok(await put(fixture, bob.cookie, "/shared/secret/x.txt"));
  assertEquals(
    await shape(await listing(fixture, cara.cookie, secret)),
    missing,
  );

  const denied = await grant(
    fixture,
    bob.cookie,
    secret,
    cara.principalId,
    "view",
  );
  assertEquals((await shape(denied))[1], "STORAGE_AREA_REFUSED");
  await ok(
    await grant(fixture, admin, secret, bob.principalId, "manage"),
    201,
  );
  await ok(
    await grant(fixture, bob.cookie, secret, cara.principalId, "view"),
    201,
  );
  assert(
    (await names(await listing(fixture, cara.cookie, secret))).includes(
      "x.txt",
    ),
  );

  const grants = (await ok(
    await call(fixture, admin, "GET", `/v1/storage/folders/${secret}/grants`),
  )).items as Json[];
  const caraGrant = grants.find((g) => g.principalId === cara.principalId)!;
  await ok(
    await call(
      fixture,
      admin,
      "POST",
      `/v1/storage/folder-grants/${caraGrant.id}/revoke`,
    ),
  );
  assertEquals(
    await shape(await listing(fixture, cara.cookie, secret)),
    missing,
  );
}

async function aGrantAboveARestrictedFolderDoesNotReachBelowIt(
  fixture: Fixture,
): Promise<void> {
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");

  const outer = await folder(fixture, admin, "/shared/outer");
  const inner = await folder(fixture, admin, "/shared/outer/inner");
  await ok(await put(fixture, admin, "/shared/outer/inner/deep.txt"));
  await ok(await restrict(fixture, admin, outer, true));
  await ok(
    await grant(fixture, admin, outer, bob.principalId, "manage"),
    201,
  );
  assertEquals(
    await names(await listing(fixture, bob.cookie, outer)),
    ["inner"],
  );
  assertEquals(
    await names(await listing(fixture, bob.cookie, inner)),
    ["deep.txt"],
  );
  await ok(await restrict(fixture, admin, inner, true));
  assertEquals(
    await shape(await listing(fixture, bob.cookie, inner)),
    [404, "RESOURCE_NOT_FOUND"],
  );
  assertEquals(await names(await listing(fixture, bob.cookie, outer)), []);
  await ok(await restrict(fixture, admin, inner, false));
  assertEquals(
    await names(await listing(fixture, bob.cookie, inner)),
    ["deep.txt"],
  );
}

async function aFileTrashedOutOfARestrictedFolderStaysHidden(
  fixture: Fixture,
): Promise<void> {
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");
  const secret = await folder(fixture, admin, "/shared/vault");
  const file = await ok(await put(fixture, admin, "/shared/vault/key.txt"));
  await ok(await restrict(fixture, admin, secret, true));
  const entry = file as Json;
  const trashed = await call(
    fixture,
    admin,
    "DELETE",
    `/v1/storage/entries/${entry.id}`,
    undefined,
    { "If-Match": `"${entry.version}"` },
  );
  assert(trashed.status < 300, await trashed.clone().text());
  const bobTrash = await names(
    await call(fixture, bob.cookie, "GET", "/v1/storage/trash"),
  );
  assertEquals(bobTrash.includes("key.txt"), false);
  const adminTrash = await names(
    await call(fixture, admin, "GET", "/v1/storage/trash"),
  );
  assertEquals(adminTrash.includes("key.txt"), true);
  assertEquals(
    await shape(
      await call(
        fixture,
        bob.cookie,
        "GET",
        `/v1/storage/files/${entry.id}/content`,
      ),
    ),
    [404, "RESOURCE_NOT_FOUND"],
  );
}

async function personalAndRecordAreasTakeNoGrants(
  fixture: Fixture,
): Promise<void> {
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");
  const roots = (await ok(
    await call(fixture, admin, "GET", "/v1/storage/roots"),
  )).items as Json[];
  const mine = roots.find((r) => String(r.path).startsWith("/users/"))!;
  const personal = await grant(
    fixture,
    admin,
    mine.id as string,
    bob.principalId,
    "view",
  );
  assertEquals((await shape(personal))[1], "STORAGE_AREA_REFUSED");
  const projects = roots.find((r) => r.name === "projects")!;
  const record = await restrict(fixture, admin, projects.id as string, true);
  assertEquals((await shape(record))[1], "STORAGE_AREA_REFUSED");
  const shared = await folder(fixture, admin, "/shared/open");
  const stranger = await grant(
    fixture,
    admin,
    shared,
    crypto.randomUUID(),
    "view",
  );
  assertEquals((await shape(stranger))[0], 422);
  await ok(await put(fixture, bob.cookie, "/shared/open/ok.txt"));
}

const move = (
  fixture: Fixture,
  cookie: string,
  entry: Json,
  destinationPath: string,
) =>
  call(
    fixture,
    cookie,
    "POST",
    `/v1/storage/entries/${entry.id}/move`,
    { destinationPath },
    { "If-Match": `"${entry.version}"` },
  );

const trash = (fixture: Fixture, cookie: string, entry: Json) =>
  call(
    fixture,
    cookie,
    "DELETE",
    `/v1/storage/entries/${entry.id}`,
    undefined,
    { "If-Match": `"${entry.version}"` },
  );

const restore = (fixture: Fixture, cookie: string, entry: Json) =>
  call(
    fixture,
    cookie,
    "POST",
    `/v1/storage/entries/${entry.id}/restore`,
    undefined,
    { "If-Match": `"${entry.version}"` },
  );

const refusal = async (
  response: Response,
): Promise<[number, string, string]> => {
  const body = JSON.parse(await response.text()) as Json;
  const params = body.params as Json | undefined;
  return [
    response.status,
    String(body.code),
    String(params?.reason ?? body.reason),
  ];
};

const searchPaths = async (
  fixture: Fixture,
  cookie: string,
  query: string,
): Promise<string[]> =>
  ((await ok(
    await call(
      fixture,
      cookie,
      "GET",
      `/v1/files/search?query=${encodeURIComponent(query)}`,
    ),
  )).items as Json[]).map((item) => String(item.path));

async function aViewGranteeCannotMoveTrashOrRestore(
  fixture: Fixture,
): Promise<void> {
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");
  const ledger = await folder(fixture, admin, "/shared/ledger");
  const free = await folder(fixture, admin, "/shared/free");
  const kept = await ok(await put(fixture, admin, "/shared/ledger/kept.txt"));
  const gone = await ok(await put(fixture, admin, "/shared/ledger/gone.txt"));
  await ok(await restrict(fixture, admin, ledger, true));
  await ok(await grant(fixture, admin, ledger, bob.principalId, "view"), 201);

  assertEquals(
    await refusal(
      await move(fixture, bob.cookie, kept, "/shared/free/kept.txt"),
    ),
    [409, "STORAGE_AREA_REFUSED", "folder_view_only"],
  );
  assertEquals(await names(await listing(fixture, admin, free)), []);
  assertEquals(
    await refusal(await trash(fixture, bob.cookie, kept)),
    [409, "STORAGE_AREA_REFUSED", "folder_view_only"],
  );
  assertEquals(
    (await names(await listing(fixture, bob.cookie, ledger))).sort(),
    ["gone.txt", "kept.txt"],
  );

  const trashed = await trash(fixture, admin, gone);
  assert(trashed.status < 300, await trashed.clone().text());
  const trashedEntry = ((await ok(
    await call(fixture, bob.cookie, "GET", "/v1/storage/trash"),
  )).items as Json[]).find((item) => item.name === "gone.txt")!;
  assertEquals(
    await refusal(await restore(fixture, bob.cookie, trashedEntry)),
    [409, "STORAGE_AREA_REFUSED", "folder_view_only"],
  );
  assertEquals(
    (await names(await listing(fixture, admin, ledger))).includes("gone.txt"),
    false,
  );

  await ok(await grant(fixture, admin, ledger, bob.principalId, "edit"), 201);
  const moved = await move(fixture, bob.cookie, kept, "/shared/free/kept.txt");
  assert(moved.status < 300, await moved.clone().text());
  assertEquals(await names(await listing(fixture, admin, free)), ["kept.txt"]);
}

async function onlyAManagerRevokesAGrant(fixture: Fixture): Promise<void> {
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");
  const cara: Member = await addMember(fixture as never, seed, "cara");
  const dan: Member = await addMember(fixture as never, seed, "dan");
  const board = await folder(fixture, admin, "/shared/board");
  await ok(await restrict(fixture, admin, board, true));
  await ok(await grant(fixture, admin, board, bob.principalId, "view"), 201);
  await ok(await grant(fixture, admin, board, cara.principalId, "view"), 201);
  const grants = (await ok(
    await call(fixture, admin, "GET", `/v1/storage/folders/${board}/grants`),
  )).items as Json[];
  const caras = grants.find((g) => g.principalId === cara.principalId)!;
  const revoke = (cookie: string) =>
    call(
      fixture,
      cookie,
      "POST",
      `/v1/storage/folder-grants/${caras.id}/revoke`,
    );

  assertEquals(
    await refusal(await revoke(bob.cookie)),
    [409, "STORAGE_AREA_REFUSED", "folder_manage_required"],
  );
  assertEquals(await shape(await revoke(dan.cookie)), [
    404,
    "RESOURCE_NOT_FOUND",
  ]);
  assertEquals(
    ((await ok(
      await call(fixture, admin, "GET", `/v1/storage/folders/${board}/grants`),
    )).items as Json[]).some((g) => g.id === caras.id),
    true,
  );

  await ok(await grant(fixture, admin, board, bob.principalId, "manage"), 201);
  await ok(await revoke(bob.cookie));
  assertEquals(
    await shape(await listing(fixture, cara.cookie, board)),
    [404, "RESOURCE_NOT_FOUND"],
  );
}

async function searchHidesFilesInARestrictedFolder(
  fixture: Fixture,
): Promise<void> {
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");
  const vault = await folder(fixture, admin, "/shared/search-vault");
  await ok(
    await put(fixture, admin, "/shared/search-vault/quarterly-plan.txt"),
  );
  await ok(await put(fixture, admin, "/shared/quarterly-open.txt"));
  await ok(await restrict(fixture, admin, vault, true));

  assertEquals(await searchPaths(fixture, bob.cookie, "quarterly"), [
    "/shared/quarterly-open.txt",
  ]);
  assertEquals(
    (await searchPaths(fixture, admin, "quarterly")).sort(),
    ["/shared/quarterly-open.txt", "/shared/search-vault/quarterly-plan.txt"],
  );
  const scoped = await ok(
    await call(
      fixture,
      bob.cookie,
      "GET",
      "/v1/files/search?query=quarterly&path=%2Fshared%2Fsearch-vault",
    ),
  );
  assertEquals(scoped.items, []);

  await ok(await grant(fixture, admin, vault, bob.principalId, "view"), 201);
  assertEquals(
    (await searchPaths(fixture, bob.cookie, "quarterly")).sort(),
    ["/shared/quarterly-open.txt", "/shared/search-vault/quarterly-plan.txt"],
  );

  const grants = (await ok(
    await call(fixture, admin, "GET", `/v1/storage/folders/${vault}/grants`),
  )).items as Json[];
  await ok(
    await call(
      fixture,
      admin,
      "POST",
      `/v1/storage/folder-grants/${
        grants.find((g) => g.principalId === bob.principalId)!.id
      }/revoke`,
    ),
  );
  assertEquals(await searchPaths(fixture, bob.cookie, "quarterly"), [
    "/shared/quarterly-open.txt",
  ]);
}

async function aFolderTakesAtMostTwoHundredGrants(
  fixture: Fixture,
): Promise<void> {
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");
  const crowded = await folder(fixture, admin, "/shared/crowded");
  await ok(await restrict(fixture, admin, crowded, true));
  await fixture.pgDatabase.query(
    `with made as (
       insert into bakery.principals (display_name, principal_type)
       select 'grantee ' || n, 'service' from generate_series(1, 200) as n
       returning id)
     insert into bakery.storage_folder_grants
       (organization_id, folder_id, principal_id, level, granted_by)
     select $1, $2, id, 'view', $3 from made`,
    [fixture.organizationId, crowded, fixture.principalId],
  );
  const refused = await grant(fixture, admin, crowded, bob.principalId, "view");
  const body = JSON.parse(await refused.text()) as Json;
  assertEquals(refused.status, 422);
  assert(JSON.stringify(body).includes("folder_grant_limit"));
  const listed = (await ok(
    await call(fixture, admin, "GET", `/v1/storage/folders/${crowded}/grants`),
  )).items as Json[];
  assertEquals(listed.length, 200);
}

Deno.test("folder grants and restricted folders", async () => {
  try {
    await withWorkerFixture(async (fixture) => {
      await restrictedFolderIsHiddenAndAGrantOpensItAtItsLevel(fixture);
      await aGrantAboveARestrictedFolderDoesNotReachBelowIt(fixture);
      await aFileTrashedOutOfARestrictedFolderStaysHidden(fixture);
      await personalAndRecordAreasTakeNoGrants(fixture);
      await aViewGranteeCannotMoveTrashOrRestore(fixture);
      await onlyAManagerRevokesAGrant(fixture);
      await searchHidesFilesInARestrictedFolder(fixture);
      await aFolderTakesAtMostTwoHundredGrants(fixture);
    });
  } finally {
    await resetDatabase();
  }
});
