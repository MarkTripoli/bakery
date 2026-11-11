import {
  readRuntimeConfig,
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "@bakery/config";
import { createBakeryClient } from "../../packages/contracts/src/client.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  authRequest,
  authTestOrigin,
  openAuthFixture,
  sessionCookie,
} from "./auth.ts";

/** Creates/drops only this UUID database; no shared/preview fixture data. */
export async function openSecretsFixture() {
  const config = readTestDatabaseConfig(Deno.env.toObject(), {
    requireAdmin: true,
  });
  const hosts = ["localhost", "127.0.0.1", "[::1]"];
  if (
    !readTestDatabaseResetOptions().allowRemote &&
    [config.databaseUrl, config.adminDatabaseUrl].some((value) =>
      !hosts.includes(new URL(value).hostname)
    )
  ) throw new Error("DESTRUCTIVE_RESET_REQUIRES_LOOPBACK");
  const name = `bakery_secrets_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = openDatabase(config.adminDatabaseUrl, 1);
  const directory = await Deno.makeTempDir({ prefix: "bakery-secrets-" });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const key = { file, keyId: "fixture-key-v1" };
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.pathname = `/${name}`;
  const appDatabaseUrl = new URL(config.appDatabaseUrl);
  appDatabaseUrl.pathname = `/${name}`;
  const ownerRole = decodeURIComponent(databaseUrl.username).replaceAll(
    '"',
    '""',
  );
  const adminFixtureUrl = new URL(config.adminDatabaseUrl);
  adminFixtureUrl.pathname = `/${name}`;
  const adminPgDatabase = openPgDatabase(adminFixtureUrl.toString());
  let created = false;
  let fixture: Awaited<ReturnType<typeof openAuthFixture>> | undefined;
  let calls = 0;
  const providerAuthorizations: string[] = [];
  let provider: (authorization: string) => Promise<Response> = () =>
    Promise.resolve(Response.json({ id: 12345, login: "fixture-user" }));
  const cleanup = async () => {
    try {
      await fixture?.close();
    } finally {
      try {
        await closePgDatabase(adminPgDatabase);
        if (created) await admin.unsafe(`drop database "${name}"`);
      } finally {
        await closeDatabase(admin);
        await Deno.remove(directory, { recursive: true });
      }
    }
  };
  try {
    await admin.unsafe(`create database "${name}" owner "${ownerRole}"`);
    created = true;
    fixture = await openAuthFixture({
      databaseConfig: {
        databaseUrl: databaseUrl.toString(),
        appDatabaseUrl: appDatabaseUrl.toString(),
      },
      secretsKey: key,
      secretsFetch: async (url, options) => {
        const authorization = new Headers(options?.headers).get(
          "authorization",
        );
        if (
          String(url) !== "https://api.github.com/user" ||
          options?.method !== "GET" || options.redirect !== "error" ||
          authorization === null
        ) throw new Error("FIXED_PROVIDER_REQUIRED");
        calls++;
        providerAuthorizations.push(authorization);
        return await provider(authorization);
      },
    });
    const password = `Generated-${crypto.randomUUID()}`;
    const email = `secrets-${crypto.randomUUID()}@example.test`;
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Fixture Admin", password });
    const actor = await fixture.pgDatabase.query<
      { principal_id: string; organization_id: string }
    >(`select principal_id,organization_id from bakery.organization_memberships where role='admin'`);
    const principalId = actor.rows[0].principal_id;
    const organizationId = actor.rows[0].organization_id;
    const signIn = await fixture.auth.handler(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    if (signIn.status !== 200) throw new Error("FIXTURE_SIGNIN_FAILED");
    const cookie = sessionCookie(signIn);
    const request = (
      path: string,
      body?: unknown,
      idempotencyKey?: string,
      org = organizationId,
      options: {
        method?: "DELETE" | "PATCH" | "POST";
        ifMatch?: string;
        contentType?: string;
      } = {},
    ) =>
      fixture!.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method: options.method ?? (body === undefined ? "GET" : "POST"),
          headers: {
            ...(options.ifMatch ? { "If-Match": options.ifMatch } : {}),
            cookie,
            origin: authTestOrigin,
            "Bakery-Organization-Id": org,
            ...(body === undefined ? {} : {
              "content-type": options.contentType ?? "application/json",
              ...(options.method === "DELETE"
                ? (idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
                : { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() }),
            }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const clientTrace: {
      method: string;
      path: string;
      bodyKeys: string[];
      ifMatch: string | null;
    }[] = [];
    const client = createBakeryClient({
      baseUrl: authTestOrigin,
      getContext: () => ({ organizationId }),
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        clientTrace.push({
          method: init?.method ?? "GET",
          path: new URL(String(url)).pathname,
          bodyKeys: typeof init?.body === "string"
            ? Object.keys(JSON.parse(init.body)).sort()
            : [],
          ifMatch: headers.get("if-match"),
        });
        headers.set("cookie", cookie);
        headers.set("origin", authTestOrigin);
        return fixture!.app.fetch(new Request(url, { ...init, headers }));
      },
    });
    const app = await request("/v1/applications", {
      slug: "fixture-a",
      name: "Fixture A",
      description: "",
    });
    if (app.status !== 201) throw new Error("FIXTURE_APPLICATION_FAILED");
    const applicationId = (await app.json()).id as string;
    const second = await request("/v1/applications", {
      slug: "fixture-b",
      name: "Fixture B",
      description: "",
    });
    if (second.status !== 201) throw new Error("FIXTURE_APPLICATION_FAILED");
    const applicationB = (await second.json()).id as string;
    const organizationB = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organizations(id,name,slug,metadata,created_at,updated_at,version) values($1,'Fixture B',$2,'{}'::jsonb,now(),now(),1)`,
      [organizationB, `fixture-${crypto.randomUUID()}`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships(id,organization_id,principal_id,role,status,joined_at,created_at,updated_at,version) values($1,$2,$3,'admin','active',now(),now(),now(),1)`,
      [crypto.randomUUID(), organizationB, principalId],
    );
    const foreign = await request(
      "/v1/applications",
      { slug: "foreign-a", name: "Foreign A", description: "" },
      undefined,
      organizationB,
    );
    if (foreign.status !== 201) throw new Error("FIXTURE_APPLICATION_FAILED");
    const foreignApplication = (await foreign.json()).id as string;
    const foreignB = await request(
      "/v1/applications",
      { slug: "foreign-b", name: "Foreign B", description: "" },
      undefined,
      organizationB,
    );
    if (foreignB.status !== 201) throw new Error("FIXTURE_APPLICATION_FAILED");
    return {
      fixture,
      adminPgDatabase,
      request,
      client,
      clientTrace,
      adminCookie: cookie,
      principalId,
      organizationId,
      organizationB,
      applicationId,
      applicationB,
      foreignApplication,
      key,
      ownerDatabaseUrl: databaseUrl.toString(),
      appDatabaseUrl: appDatabaseUrl.toString(),
      cleanup,
      calls: () => calls,
      providerAuthorizations: () => [...providerAuthorizations],
      setProvider: (next: typeof provider) => {
        provider = next;
      },
      withoutKey: () =>
        readRuntimeConfig({
          BAKERY_ENV: "test",
          BAKERY_APP_DATABASE_URL: appDatabaseUrl.toString(),
          BETTER_AUTH_SECRET: fixture!.config.auth!.secret,
          BAKERY_PUBLIC_BASE_URL: authTestOrigin,
        }),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export type SecretsFixture = Awaited<ReturnType<typeof openSecretsFixture>>;
