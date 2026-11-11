import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  closeDatabase,
  type Database,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  bootstrapDatabase,
  BootstrapError,
  type BootstrapNames,
  type BootstrapPasswords,
  scramVerifier,
} from "../../apps/server/scripts/bootstrap-database.ts";

function adminUrl(): string {
  const value = Deno.env.get("BAKERY_ADMIN_DATABASE_URL")?.trim();
  if (!value) throw new Error("BAKERY_ADMIN_DATABASE_URL_REQUIRED");
  return value;
}

function urlFor(
  base: string,
  options: { database?: string; user?: string; password?: string },
): string {
  const url = new URL(base);
  if (options.database) url.pathname = `/${options.database}`;
  if (options.user) url.username = options.user;
  if (options.password) url.password = options.password;
  return url.toString();
}

function randomPassword(): string {
  return `Pw${crypto.randomUUID().replaceAll("-", "")}.x`;
}

async function withBootstrapFixture(
  run: (fixture: {
    admin: Database;
    names: BootstrapNames;
    passwords: BootstrapPasswords;
    bootstrap: () => Promise<readonly string[]>;
    loginAs: (
      role: string,
      password: string,
      database: string,
    ) => Promise<string>;
  }) => Promise<void>,
): Promise<void> {
  const base = adminUrl();
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const names: BootstrapNames = {
    owner: `bootstrap_${suffix}_owner`,
    app: `bootstrap_${suffix}_app`,
    inngest: `bootstrap_${suffix}_inngest`,
    applicationDatabase: `bootstrap_${suffix}_db`,
    inngestDatabase: `bootstrap_${suffix}_inngestdb`,
  };
  const passwords: BootstrapPasswords = {
    owner: randomPassword(),
    app: randomPassword(),
    inngest: randomPassword(),
  };
  const admin = openDatabase(base, 1);
  const bootstrap = async (): Promise<readonly string[]> => {
    const result = await bootstrapDatabase(admin, {
      names,
      passwords,
      openDatabase: (database) => openDatabase(urlFor(base, { database }), 1),
    });
    assertEquals(result.event, "bakery.database.bootstrap.v1");
    assert(result.serverVersionNum >= 150000);
    // The report is a secrets-free one-liner.
    const serialized = JSON.stringify(result);
    for (const password of Object.values(passwords)) {
      assert(!serialized.includes(password));
    }
    assert(!serialized.includes("SCRAM-SHA-256"));
    return result.changes;
  };
  const loginAs = async (
    role: string,
    password: string,
    database: string,
  ): Promise<string> => {
    const session = openDatabase(
      urlFor(base, { database, user: role, password }),
      1,
    );
    try {
      const rows = await session<{ user: string }[]>`
        select current_user as user
      `;
      return rows[0]!.user;
    } finally {
      await closeDatabase(session);
    }
  };
  try {
    await run({ admin, names, passwords, bootstrap, loginAs });
  } finally {
    try {
      for (
        const database of [names.applicationDatabase, names.inngestDatabase]
      ) {
        await admin.unsafe(`drop database if exists ${database} with (force)`);
      }
      for (const role of [names.owner, names.app, names.inngest]) {
        await admin.unsafe(`drop role if exists ${role}`);
      }
    } finally {
      await closeDatabase(admin);
    }
  }
}

Deno.test("bootstrap creates roles and databases, then a second run changes nothing", async () => {
  await withBootstrapFixture(
    async ({ admin, names, passwords, bootstrap, loginAs }) => {
      const first = await bootstrap();
      assertEquals(
        [...first].sort(),
        [
          `database:${names.applicationDatabase}:connect:${names.app}`,
          `database:${names.applicationDatabase}:created`,
          `database:${names.inngestDatabase}:created`,
          `role:${names.app}:created`,
          `role:${names.inngest}:created`,
          `role:${names.owner}:created`,
        ].sort(),
      );
      assertEquals(await bootstrap(), []);

      const roles = await admin<{
        rolname: string;
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        rolpassword: string;
      }[]>`
        select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
          rolreplication, rolbypassrls, rolpassword
        from pg_authid
        where rolname in ${admin([names.owner, names.app, names.inngest])}
      `;
      assertEquals(roles.length, 3);
      for (const role of roles) {
        assertEquals(role.rolcanlogin, true);
        assertEquals(
          [
            role.rolsuper,
            role.rolcreatedb,
            role.rolcreaterole,
            role.rolreplication,
            role.rolbypassrls,
          ],
          [false, false, false, false, false],
        );
        assert(role.rolpassword.startsWith("SCRAM-SHA-256$4096:"));
        for (const password of Object.values(passwords)) {
          assert(!role.rolpassword.includes(password));
        }
      }

      const owners = await admin<{ datname: string; owner: string }[]>`
        select datname, pg_get_userbyid(datdba) as owner from pg_database
        where datname in ${
        admin([names.applicationDatabase, names.inngestDatabase])
      }
      `;
      assertEquals(
        Object.fromEntries(owners.map((row) => [row.datname, row.owner])),
        {
          [names.applicationDatabase]: names.owner,
          [names.inngestDatabase]: names.inngest,
        },
      );

      // Logging in with the plaintext proves the client-computed verifier.
      assertEquals(
        await loginAs(names.owner, passwords.owner, names.applicationDatabase),
        names.owner,
      );
      assertEquals(
        await loginAs(names.app, passwords.app, names.applicationDatabase),
        names.app,
      );
      assertEquals(
        await loginAs(names.inngest, passwords.inngest, names.inngestDatabase),
        names.inngest,
      );
      await assertRejects(() =>
        loginAs(names.app, passwords.owner, names.applicationDatabase)
      );
    },
  );
});

async function explicitConnect(
  admin: Database,
  names: BootstrapNames,
): Promise<boolean> {
  const rows = await admin<{ granted: boolean }[]>`
    select exists (
      select 1
      from pg_database as database
      cross join lateral aclexplode(
        coalesce(database.datacl, acldefault('d', database.datdba))
      ) as acl
      join pg_roles as role on role.oid = acl.grantee
      where database.datname = ${names.applicationDatabase}
        and role.rolname = ${names.app}
        and acl.privilege_type = 'CONNECT'
    ) as granted
  `;
  return rows[0]!.granted;
}

Deno.test("bootstrap leaves CONNECT to a pending migration drain", async () => {
  await withBootstrapFixture(async ({ admin, names, bootstrap }) => {
    await bootstrap();
    assert(await explicitConnect(admin, names));
    // A drain revokes CONNECT and records the row; bootstrap must not undo it.
    const application = openDatabase(
      urlFor(adminUrl(), { database: names.applicationDatabase }),
      1,
    );
    try {
      await application.unsafe(`
        create schema bakery;
        create table bakery.application_migration_drain (
          id text primary key,
          public_connect boolean not null,
          application_connect boolean not null,
          started_at timestamptz not null default now()
        );
        insert into bakery.application_migration_drain
          (id, public_connect, application_connect)
        values ('database', true, true);
      `);
      await admin.unsafe(
        `revoke connect on database ${names.applicationDatabase} from ${names.app}`,
      );
      assert(!await explicitConnect(admin, names));
      assertEquals(await bootstrap(), []);
      assert(!await explicitConnect(admin, names));
      // Once the drain restores its state the next bootstrap grants again.
      await application.unsafe(
        "delete from bakery.application_migration_drain where id = 'database'",
      );
      assertEquals(await bootstrap(), [
        `database:${names.applicationDatabase}:connect:${names.app}`,
      ]);
      assert(await explicitConnect(admin, names));
      assertEquals(await bootstrap(), []);
    } finally {
      await closeDatabase(application);
    }
  });
});

Deno.test("bootstrap repairs drifted attributes, passwords and database owners", async () => {
  await withBootstrapFixture(
    async ({ admin, names, passwords, bootstrap, loginAs }) => {
      await bootstrap();
      const stale = await scramVerifier("stale-password-value");
      await admin.unsafe(`alter role ${names.app} createdb`);
      await admin.unsafe(
        `alter role ${names.inngest} password '${stale}'`,
      );
      await admin.unsafe(
        `alter database ${names.inngestDatabase} owner to ${names.owner}`,
      );
      assertEquals(
        [...await bootstrap()].sort(),
        [
          `database:${names.inngestDatabase}:owner`,
          `role:${names.app}:attributes`,
          `role:${names.inngest}:password`,
        ].sort(),
      );
      assertEquals(await bootstrap(), []);
      assertEquals(
        await loginAs(names.inngest, passwords.inngest, names.inngestDatabase),
        names.inngest,
      );
    },
  );
});

Deno.test("bootstrap refuses a bakery_app role with memberships", async () => {
  await withBootstrapFixture(async ({ admin, names, bootstrap }) => {
    await bootstrap();
    await admin.unsafe(`grant ${names.inngest} to ${names.app}`);
    await assertRejects(
      () => bootstrap(),
      BootstrapError,
      "BAKERY_APP_ROLE_MEMBERSHIP_UNSAFE",
    );
  });
});

Deno.test("bootstrap refuses a connection that is not a superuser", async () => {
  await withBootstrapFixture(async ({ names, passwords, bootstrap }) => {
    await bootstrap();
    const owner = openDatabase(
      urlFor(adminUrl(), {
        database: names.applicationDatabase,
        user: names.owner,
        password: passwords.owner,
      }),
      1,
    );
    try {
      await assertRejects(
        () =>
          bootstrapDatabase(owner, {
            names,
            passwords,
            openDatabase: () => owner,
          }),
        BootstrapError,
        "BOOTSTRAP_SUPERUSER_REQUIRED",
      );
    } finally {
      await closeDatabase(owner);
    }
    assertEquals(await bootstrap(), []);
  });
});
