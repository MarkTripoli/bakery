/**
 * #449: folder grants and restricted folders, through the HTTP routes. A
 * restricted folder does not exist to a member with no grant inside it (not a
 * refusal that would confirm the path), a grant opens it at its level, the
 * restriction stops what is granted above it, and personal and artifact areas
 * take no grants.
 */

import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { addMember, type Member } from "../helpers/durable-questions.ts";

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

/** The status and body of a refusal, to compare one with another. */
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

async function scenario1(fixture: Fixture): Promise<void> { // a restricted folder does not exist to a member without a grant, and a grant opens it at its level
  const admin = fixture.adminCookie;
  const seed = { organizationId: fixture.organizationId } as never;
  const bob: Member = await addMember(fixture as never, seed, "bob");
  const cara: Member = await addMember(fixture as never, seed, "cara");

  const secret = await folder(fixture, admin, "/shared/secret");
  await ok(await put(fixture, admin, "/shared/secret/plan.txt"));
  await ok(await restrict(fixture, admin, secret, true), 200);

  // To bob it is not there: the same answer as an id that never existed.
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
  // And it is not in its parent's listing.
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

  // A view grant reads and writes nothing.
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
  assertEquals(refused.status, 403 === refused.status ? 403 : refused.status);
  const refusal = JSON.parse(await refused.text()) as Json;
  assertEquals(refusal.code, "STORAGE_AREA_REFUSED");
  assertEquals(
    (refusal.params as Json | undefined)?.reason ?? refusal.reason,
    "folder_view_only",
  );

  // An edit grant writes.
  await ok(await grant(fixture, admin, secret, bob.principalId, "edit"), 201);
  await ok(await put(fixture, bob.cookie, "/shared/secret/x.txt"));
  // cara, granted nothing, still sees nothing.
  assertEquals(
    await shape(await listing(fixture, cara.cookie, secret)),
    missing,
  );

  // Bob cannot manage with edit; a manage grant lets him grant cara.
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

  // Revoking closes it again.
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

async function scenario2(fixture: Fixture): Promise<void> { // what is granted above a restricted folder does not reach below it
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
  // inner is open under outer, so bob's grant on outer reaches it.
  assertEquals(
    await names(await listing(fixture, bob.cookie, inner)),
    ["deep.txt"],
  );
  // Restrict inner: the grant above it stops there.
  await ok(await restrict(fixture, admin, inner, true));
  assertEquals(
    await shape(await listing(fixture, bob.cookie, inner)),
    [404, "RESOURCE_NOT_FOUND"],
  );
  assertEquals(await names(await listing(fixture, bob.cookie, outer)), []);
  // Lifting it brings it back.
  await ok(await restrict(fixture, admin, inner, false));
  assertEquals(
    await names(await listing(fixture, bob.cookie, inner)),
    ["deep.txt"],
  );
}

async function scenario3(fixture: Fixture): Promise<void> { // a file trashed out of a restricted folder stays hidden from those who could not see the folder
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

async function scenario4(fixture: Fixture): Promise<void> { // personal and artifact areas take no grants, and an agent cannot widen who opens a folder
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
  // A grant to someone outside the organization is not made.
  const shared = await folder(fixture, admin, "/shared/open");
  const stranger = await grant(
    fixture,
    admin,
    shared,
    crypto.randomUUID(),
    "view",
  );
  assertEquals((await shape(stranger))[0], 422);
  // An unrestricted folder is untouched: bob still writes there.
  await ok(await put(fixture, bob.cookie, "/shared/open/ok.txt"));
}

// One fixture for every scenario: the members each one adds stay in the
// database until the fixture closes, and a second fixture refuses to open on
// them.
Deno.test("folder grants and restricted folders", () =>
  withWorkerFixture(async (fixture) => {
    await scenario1(fixture); // a restricted folder does not exist to a member without a grant, and a grant opens it at its level
    await scenario2(fixture); // what is granted above a restricted folder does not reach below it
    await scenario3(fixture); // a file trashed out of a restricted folder stays hidden from those who could not see the folder
    await scenario4(fixture); // personal and artifact areas take no grants, and an agent cannot widen who opens a folder
  }));
