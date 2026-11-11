/**
 * The real Bakery API, a real test database and the in-memory fake GitHub
 * App (fake-github-app.ts) in one process, for the browser proof of the
 * GitHub connect flow (apps/web/tests/organization-integrations-fake-github
 * .spec.ts). Nothing reaches github.com.
 *
 * Usage: deno run -A --config deno.json
 *   tests/helpers/github-connect-server.child.ts
 *
 * The API keeps the test public origin (`authTestOrigin`); a caller sends
 * that as Origin. Callback redirects are paths, so they land on whichever
 * web app forwarded the request. Prints one JSON line: the API URL, the
 * control URL, the public origin, and the seeded Admin's session cookie and
 * organization. The control server stands in for the
 * github.com pages a browser visits:
 *
 * - POST /manifest {manifest}: GitHub creates the App the manifest names
 *   and returns the one-time conversion code.
 * - POST /install {slug}: the user installs that App on a new GitHub
 *   organization holding three repositories they administer; returns the
 *   installation id.
 * - POST /authorize {authorizationUrl}: the user approves the App and can
 *   see every installation made so far; returns the OAuth code.
 *
 * On a database the auth-bootstrap project already bootstrapped (a full
 * browser lane) it signs in as that Admin instead of seeding one. It runs
 * until stdin closes or SIGTERM, then removes what it seeded.
 */
import {
  createFakeGitHubApp,
  fakeAppKey,
  type FakeGitHubApp,
  fakeRepositories,
} from "./fake-github-app.ts";
import { clearGitHubAppRegistrations } from "./github-app-registration.ts";
import { openSharedAdminFixture } from "./installation-settings.ts";
import { authTestOrigin } from "./auth.ts";
import { createInstallationTokenBroker } from "../../apps/server/src/modules/integrations/token-broker.ts";

const directory = await Deno.makeTempDir({ prefix: "bakery-github-connect-" });
const file = `${directory}/key`;
await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
  mode: 0o600,
});
const secretsKey = { file, keyId: "github-connect-browser-key-v1" };
const github = createFakeGitHubApp();
const broker = createInstallationTokenBroker({
  github: github.client,
  secretsKey,
});
const fixture = await openSharedAdminFixture({
  secretsKey,
  githubAppClient: github.client,
  installationTokenBroker: broker,
});
await clearGitHubAppRegistrations(fixture);

const apps = new Map<string, FakeGitHubApp>();
const installationIds: number[] = [];

/** GitHub's slug for an App name: lowercase words joined by hyphens. */
function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}

async function control(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body = await request.json().catch(() => null) as
    | Record<string, string>
    | null;
  if (body === null) {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  if (path === "/manifest") {
    const manifest = JSON.parse(body.manifest) as { name: string };
    const { code, app } = github.issueCode({
      name: manifest.name,
      slug: slugOf(manifest.name),
      pem: fakeAppKey.pem,
    });
    apps.set(app.slug, app);
    return Response.json({ code, name: app.name, slug: app.slug });
  }
  if (path === "/install") {
    const app = apps.get(body.slug);
    if (!app) return Response.json({ error: "unknown App" }, { status: 404 });
    const repositories = fakeRepositories(3, ["admin"]).map((
      repository,
      i,
    ) => ({
      ...repository,
      name: ["bakery", "tools", "docs"][i],
    }));
    const installation = github.addInstallation(app, {
      account: { id: 7_100_001, login: "acme-org", type: "Organization" },
      repositories,
    });
    installationIds.push(installation.id);
    return Response.json({ installationId: installation.id });
  }
  if (path === "/authorize") {
    const code = github.authorize({
      authorizationUrl: body.authorizationUrl,
      installationIds,
    });
    return Response.json({ code });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

const api = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  (request, info) =>
    fixture.app.fetch(request, { remoteAddr: info.remoteAddr }),
);
const controller = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  control,
);
console.log(JSON.stringify({
  apiUrl: `http://127.0.0.1:${api.addr.port}`,
  controlUrl: `http://127.0.0.1:${controller.addr.port}`,
  publicOrigin: authTestOrigin,
  adminCookie: fixture.adminCookie,
  organizationId: fixture.organizationId,
}));
const stop = Promise.withResolvers<void>();
Deno.addSignalListener("SIGTERM", () => stop.resolve());
Deno.addSignalListener("SIGINT", () => stop.resolve());
try {
  await Promise.race([
    (async () => {
      const buffer = new Uint8Array(1);
      while (await Deno.stdin.read(buffer) !== null) {
        // Keep serving until the spec closes stdin.
      }
    })(),
    stop.promise,
  ]);
} finally {
  await api.shutdown();
  await controller.shutdown();
  try {
    await clearGitHubAppRegistrations(fixture);
  } finally {
    await fixture.finish();
    await Deno.remove(directory, { recursive: true });
  }
}
