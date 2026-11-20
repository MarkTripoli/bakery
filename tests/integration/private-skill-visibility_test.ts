/**
 * Who may see and change a personal skill (#431). The PR's other tests cover the
 * confirmation flow and publication; these cover what they do not touch: a
 * personal skill is a 404 to everyone but its owner (identical to an unknown id),
 * a non-owner cannot publish a version to it, a Developer is refused (not
 * hidden) on an organization skill, and library.search shows a person only
 * their own personal skills.
 */
import { assertEquals } from "@std/assert";
import {
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  SESSION_CALL_PATH,
  SESSION_CREDENTIAL_HEADER,
} from "../../apps/server/src/modules/execution/session-routes.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "../helpers/auth.ts";

type Json = Record<string, unknown>;

function base64(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}
async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("a personal skill is a 404 to other members, and only its owner can publish to it", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const ownerEmail = "skillvis-owner-" + suffix + "@example.test";
  const devEmail = "skillvis-dev-" + suffix + "@example.test";
  const adminEmail = "skillvis-admin-" + suffix + "@example.test";
  const password = "Qa728Skill-" + suffix;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email: ownerEmail, displayName: "Skill Owner", password });
    const scope = await fixture.pgDatabase.query<
      { organizationId: string; principalId: string }
    >(
      'select membership.organization_id as "organizationId", membership.principal_id as "principalId" from bakery.organization_memberships as membership join bakery.principals as principal on principal.id = membership.principal_id join public."user" as provider_user on provider_user.id = principal.provider_user_id where provider_user.email = $1',
      [ownerEmail],
    );
    const { organizationId } = scope.rows[0];
    const signIn = await fixture.auth.handler(
      authRequest("/api/auth/sign-in/email", { email: ownerEmail, password }),
    );
    assertEquals(signIn.status, 200);
    const ownerCookie = sessionCookie(signIn);

    const addMember = async (email: string, role: "developer" | "admin") => {
      const userId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      const token = "skillvis-" + crypto.randomUUID();
      const now = new Date();
      await fixture.pgDatabase.query(
        'insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $4, $2, true, $3, $3)',
        [userId, email, now, role],
      );
      await fixture.pgDatabase.query(
        "insert into bakery.principals (id, provider_user_id, display_name, principal_type) values ($1, $2, $3, 'human')",
        [principalId, userId, role],
      );
      await fixture.pgDatabase.query(
        "insert into bakery.organization_memberships (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version) values ($1, $2, $3, $4, 'active', $5, $5, $5, 1)",
        [crypto.randomUUID(), organizationId, principalId, role, now],
      );
      await fixture.pgDatabase.query(
        'insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $5)',
        [
          crypto.randomUUID(),
          token,
          userId,
          new Date(now.getTime() + 3_600_000),
          now,
        ],
      );
      return {
        cookie: await signSessionCookie(token, fixture.config.auth!.secret),
        principalId,
      };
    };
    const dev = await addMember(devEmail, "developer");
    const admin = await addMember(adminEmail, "admin");

    const post = (cookie: string, path: string, payload: Json, key: string) =>
      fixture.app.fetch(authRequest(path, payload, {
        cookie,
        headers: {
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": key,
        },
      }));
    const read = (cookie: string, path: string) =>
      fixture.app.fetch(
        new Request(authTestOrigin + path, {
          headers: { cookie, "Bakery-Organization-Id": organizationId },
        }),
      );
    const patch = (
      cookie: string,
      path: string,
      payload: Json,
      key: string,
      expected: number,
    ) =>
      fixture.app.fetch(
        new Request(authTestOrigin + path, {
          method: "PATCH",
          headers: {
            cookie,
            "Bakery-Organization-Id": organizationId,
            "content-type": "application/json",
            "Idempotency-Key": key,
            "If-Match": '"' + expected + '"',
            origin: authTestOrigin,
          },
          body: JSON.stringify(payload),
        }),
      );

    const personalRes = await post(ownerCookie, "/v1/skills", {
      slug: "qa-private",
      name: "QA Private Notes",
      scope: "personal",
    }, "skillvis-personal");
    assertEquals(personalRes.status, 201, await personalRes.clone().text());
    const personal = await personalRes.json() as {
      id: string;
      version: number;
    };
    const sharedRes = await post(ownerCookie, "/v1/skills", {
      slug: "qa-shared",
      name: "QA Shared Notes",
    }, "skillvis-shared");
    assertEquals(sharedRes.status, 201, await sharedRes.clone().text());
    const shared = await sharedRes.json() as { id: string; version: number };
    const described = await patch(
      ownerCookie,
      "/v1/skills/" + personal.id,
      { description: "zebra-secret-phrase" },
      "skillvis-describe",
      personal.version,
    );
    assertEquals(described.status, 200, await described.clone().text());

    // Another member and another Admin: a personal skill answers exactly as an unknown id does.
    const unknown = crypto.randomUUID();
    const code = async (res: Response) => {
      const body = JSON.parse(await res.text()) as Json;
      return [res.status, body.code];
    };
    const expected404 = [404, "RESOURCE_NOT_FOUND"];
    for (const who of [dev, admin]) {
      assertEquals(
        await code(await read(who.cookie, "/v1/skills/" + personal.id)),
        expected404,
      );
      assertEquals(
        await code(await read(who.cookie, "/v1/skills/" + unknown)),
        expected404,
      );
      assertEquals(
        await code(
          await read(who.cookie, "/v1/skills/" + personal.id + "/use-grants"),
        ),
        expected404,
      );
      assertEquals(
        await code(
          await read(who.cookie, "/v1/skills/" + unknown + "/use-grants"),
        ),
        expected404,
      );
      assertEquals(
        await code(
          await patch(
            who.cookie,
            "/v1/skills/" + personal.id,
            { name: "taken" },
            "skillvis-p-" + crypto.randomUUID(),
            personal.version + 1,
          ),
        ),
        expected404,
      );
      assertEquals(
        await code(
          await patch(
            who.cookie,
            "/v1/skills/" + unknown,
            { name: "taken" },
            "skillvis-u-" + crypto.randomUUID(),
            1,
          ),
        ),
        expected404,
      );
    }

    // A non-owner publishing a version of someone's personal skill: 404, same as an unknown skill; no 201, no 403, no 422.
    const content = new TextEncoder().encode("# QA private skill\n");
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: content.byteLength,
        sha256: await sha256(content),
        isExecutable: false,
      }],
    };
    const upload = {
      revision: 1,
      digest: await sha256(canonicalJson(manifest)),
      entryPath: "SKILL.md",
      manifest,
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: base64(content),
      }],
    };
    for (const who of [dev, admin]) {
      const mine = await post(
        who.cookie,
        "/v1/skills/" + personal.id + "/versions",
        upload,
        "skillvis-pub-" + crypto.randomUUID(),
      );
      const gone = await post(
        who.cookie,
        "/v1/skills/" + unknown + "/versions",
        upload,
        "skillvis-pubu-" + crypto.randomUUID(),
      );
      const mineCode = await code(mine);
      const goneCode = await code(gone);
      assertEquals(mineCode, goneCode);
      assertEquals(mineCode, expected404);
    }
    // A Developer is not an Admin: an organization skill's version is refused, not hidden.
    const devShared = await post(
      dev.cookie,
      "/v1/skills/" + shared.id + "/versions",
      upload,
      "skillvis-pub-shared-" + crypto.randomUUID(),
    );
    assertEquals(devShared.status, 403);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [
      ownerEmail,
      devEmail,
      adminEmail,
    ]);
    await fixture.close();
  }
});

Deno.test("a session's library.search shows its person only their own personal skills", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 1 });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const org = fixture.organizationId;
    const db = fixture.pgDatabase;
    const otherUser = crypto.randomUUID();
    const otherPrincipal = crypto.randomUUID();
    await db.query(
      'insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $2, $3, true, now(), now())',
      [otherUser, "Other", "skillvis-search-" + otherUser + "@example.test"],
    );
    await db.query(
      "insert into bakery.principals (id, provider_user_id, display_name, principal_type) values ($1, $2, 'Other', 'human')",
      [otherPrincipal, otherUser],
    );
    try {
      const insert = (
        slug: string,
        name: string,
        description: string | null,
        scope: string,
        owner: string | null,
      ) =>
        db.query(
          "insert into bakery.skills (id, organization_id, slug, name, description, scope, owner_principal_id) values ($1, $2, $3, $4, $5, $6, $7)",
          [crypto.randomUUID(), org, slug, name, description, scope, owner],
        );
      await insert("zebra-shared", "Zebra Shared", null, "organization", null);
      await insert(
        "zebra-mine",
        "Zebra Mine",
        null,
        "personal",
        fixture.principalId,
      );
      await insert(
        "zebra-theirs",
        "Zebra Theirs",
        null,
        "personal",
        otherPrincipal,
      );
      await insert(
        "stripes-theirs",
        "Stripes Theirs",
        "a zebra-only secret",
        "personal",
        otherPrincipal,
      );
      await insert(
        "stripes-mine",
        "Stripes Mine",
        "a zebra-only secret",
        "personal",
        fixture.principalId,
      );

      const assignment = await claimAssignment(fixture, worker) as unknown as {
        attemptId: string;
        sessionCredential: string;
      };
      const search = (args: Record<string, unknown>) =>
        workerRequest(
          fixture,
          worker.credential,
          SESSION_CALL_PATH.replace(":id", assignment.attemptId),
          { tool: "library.search", arguments: args },
          {
            headers: {
              [SESSION_CREDENTIAL_HEADER]: assignment.sessionCredential,
            },
          },
        );
      const run = async (args: Record<string, unknown>) => {
        const res = await search(args);
        const text = await res.text();
        assertEquals(res.status, 200, text);
        const page = (JSON.parse(text) as {
          result: { items: { name: string }[]; nextCursor: string | null };
        }).result;
        return {
          names: page.items.map((i) => i.name).sort(),
          cursor: page.nextCursor,
        };
      };
      // By name: shared + mine, never theirs.
      assertEquals((await run({ query: "zebra" })).names, [
        "Stripes Mine",
        "Zebra Mine",
        "Zebra Shared",
      ]);
      assertEquals((await run({ query: "zebra", kind: "skill" })).names, [
        "Stripes Mine",
        "Zebra Mine",
        "Zebra Shared",
      ]);
      // By description: only mine.
      assertEquals((await run({ query: "zebra-only" })).names, [
        "Stripes Mine",
      ]);
      // Their names do not match even when asked for exactly.
      assertEquals((await run({ query: "Theirs" })).names, []);
      // Paging walks exactly the three visible hits.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 6; i++) {
        const page = await run(
          cursor === null
            ? { query: "zebra", kind: "skill", limit: 1 }
            : { query: "zebra", kind: "skill", limit: 1, cursor },
        );
        seen.push(...page.names);
        cursor = page.cursor;
        if (cursor === null) break;
      }
      assertEquals(seen.sort(), ["Stripes Mine", "Zebra Mine", "Zebra Shared"]);
    } finally {
      // This file shares a database with the files after it: a second user left
      // behind makes the next createSuperuser report a bootstrap conflict.
      await db.query(
        "delete from bakery.skills where organization_id = $1 and slug = any($2::text[])",
        [org, [
          "zebra-shared",
          "zebra-mine",
          "zebra-theirs",
          "stripes-theirs",
          "stripes-mine",
        ]],
      );
      await db.query("delete from bakery.principals where id = $1", [
        otherPrincipal,
      ]);
      await db.query('delete from public."user" where id = $1', [otherUser]);
    }
  }));
