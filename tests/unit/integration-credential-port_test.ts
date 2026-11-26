import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import type { CredentialRequest } from "../../apps/server/src/modules/catalog/integration-gate-broker.ts";
import {
  createInstallationCredentialPort,
  createProviderRequestPort,
  type CredentialStoreDeps,
} from "../../apps/server/src/modules/integrations/credential-port.ts";
import type { AppCredentials } from "../../apps/server/src/modules/integrations/callbacks.ts";
import type { TokenTarget } from "../../apps/server/src/modules/integrations/token-broker.ts";
import { createFetchGitHubAppClient } from "../../apps/server/src/modules/integrations/github-app.ts";

/**
 * The production credential store.
 *
 * Before this file the invoke door ran with `denyAllProviderRequests`: a send
 * could be perfectly authorized and still leave the building with nothing. The
 * broker, profiles and token broker all existed and all already took a registry;
 * only the adapter from "authorized" to "here is a credential" was missing.
 */

const ORG = "00000000-0000-4000-8000-000000003101";
const CONNECTION = "00000000-0000-4000-8000-000000003102";
const INSTALL = "00000000-0000-4000-8000-000000003103";
const RESOURCE = "00000000-0000-4000-8000-000000003104";

const credentials = {
  registrationId: "00000000-0000-4000-8000-000000003105",
  appId: 42,
  clientId: "client",
  clientSecret: "secret",
  privateKey: "key",
} as unknown as AppCredentials;

const request = (
  overrides: Partial<CredentialRequest> = {},
): CredentialRequest => ({
  organizationId: ORG,
  connectionId: CONNECTION,
  resourceId: RESOURCE,
  profileId: "github-app",
  providerPermissions: { contents: "read" },
  // The generation the broker captured before the authority snapshot. A request
  // carrying none is refused, so every fixture carries one.
  generation: 7,
  subject: {
    installId: INSTALL,
    resourceKind: "repository",
    repositoryId: "900",
  },
  ...overrides,
});

/** A database that answers the two rows the port reads, in order. */
function databaseAnswering(
  rows: {
    connection?: { status: string; installationId: string } | null;
    installation?: { status: string; externalId: string } | null;
  },
  onRead: () => void = () => {},
): PgDatabase {
  let call = 0;
  const query = (sql: string) => {
    if (/^\s*(begin|commit|rollback)/i.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    call += 1;
    onRead();
    if (call === 1) {
      return Promise.resolve({
        rows: rows.connection === null ? [] : [
          rows.connection ?? {
            // `enabled`, not `active`: the broker mints only for an enabled
            // connection and an enabled installation.
            status: "enabled",
            installationId: INSTALL,
          },
        ],
      });
    }
    return Promise.resolve({
      rows: rows.installation === null ? [] : [
        rows.installation ?? {
          status: "enabled",
          externalId: "1234",
        },
      ],
    });
  };
  // withPgTransaction talks to a pooled client, so the fake is a client first:
  // `connect()` hands one back and the transaction runs through it.
  const client = { query, release: () => {} };
  return {
    query,
    connect: () => Promise.resolve(client),
  } as unknown as PgDatabase;
}

function depsWith(overrides: Partial<CredentialStoreDeps> = {}): {
  deps: CredentialStoreDeps;
  targets: TokenTarget[];
  generationCalls: string[];
} {
  const targets: TokenTarget[] = [];
  const generationCalls: string[] = [];
  const deps: CredentialStoreDeps = {
    database: databaseAnswering({}),
    broker: {
      token: (target: TokenTarget) => {
        targets.push(target);
        return Promise.resolve({
          kind: "minted",
          token: "ghs_minted",
          expiresAt: Date.now() + 3_600_000,
          permissions: { contents: "read" },
          repositoryIds: [900],
        });
      },
    } as unknown as CredentialStoreDeps["broker"],
    readAppCredentials: () => Promise.resolve(credentials),
    generationOf: (connectionId) => {
      generationCalls.push(connectionId);
      return 7;
    },
    ...overrides,
  };
  return { deps, targets, generationCalls };
}

Deno.test("a successful mint returns the credential", async () => {
  // The first version of this port tested `"kind" in minted` and so refused EVERY
  // success: both the minted token and the refusal carry `kind`. This test exists
  // because that bug type-checks and reads plausibly.
  const { deps } = depsWith();
  const port = createInstallationCredentialPort(deps);
  const credential = await port.resolve(request());
  assertEquals(credential, "ghs_minted");
});

Deno.test("the carried generation is the one the broker mints against", async () => {
  // The generation is not read here at all. It was captured upstream, BEFORE the
  // authority snapshot this request was authorized against, so an edit landing
  // between that snapshot and this mint moves the broker's counter away from the
  // carried value and the broker refuses. Reading it here would compare a fresh
  // value against itself and see nothing wrong.
  const { deps, targets, generationCalls } = depsWith();
  await createInstallationCredentialPort(deps).resolve(
    request({ generation: 11 }),
  );
  assertEquals(generationCalls, [], "the port must not read the generation");
  assertEquals(targets[0]!.generation, 11);
});

Deno.test("an edit between the snapshot and the mint refuses instead of minting", async () => {
  // The reviewer's Medium, at the ordering: the snapshot is authorized under
  // generation 11, an edit commits, and by the time the port resolves the
  // counter is 12. The broker compares the carried 11 against its live 12.
  let live = 11;
  const minted: string[] = [];
  const { deps } = depsWith({
    broker: {
      token: (target: TokenTarget) => {
        if (target.generation !== live) {
          return Promise.resolve({ kind: "refused", reason: "stale" });
        }
        minted.push(target.connectionId);
        return Promise.resolve({
          kind: "minted",
          token: "ghs_minted",
          expiresAt: Date.now() + 3_600_000,
          permissions: { contents: "read" },
          repositoryIds: [900],
        });
      },
    } as unknown as CredentialStoreDeps["broker"],
  });
  const port = createInstallationCredentialPort(deps);
  const current = await port.resolve(request({ generation: live }));
  assertEquals(current, "ghs_minted");

  live += 1; // the edit lands after the snapshot, before the next mint
  const error = await assertRejects(
    () => port.resolve(request({ generation: 11 })),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(minted.length, 1, "the stale request must not mint");
});

Deno.test("a request carrying no generation is refused before any read", async () => {
  let reads = 0;
  const { deps, targets } = depsWith({
    database: databaseAnswering({}, () => reads += 1),
  });
  const error = await assertRejects(
    () =>
      createInstallationCredentialPort(deps).resolve(
        { ...request(), generation: undefined } as unknown as CredentialRequest,
      ),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(reads, 0);
  assertEquals(targets.length, 0);
});

Deno.test("a connection pointing at another installation is not minted", async () => {
  // The snapshot authorized this invocation under the installation it named; if
  // the connection has moved to a different one since, a token minted here would
  // be for authority the invocation was never checked against.
  const { deps, targets } = depsWith({
    database: databaseAnswering({
      connection: { status: "enabled", installationId: "another-install" },
    }),
  });
  const error = await assertRejects(
    () => createInstallationCredentialPort(deps).resolve(request()),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(targets.length, 0);
});

Deno.test("an installation id that is not a number refuses the mint", async () => {
  // `Number()` maps anything unparseable to NaN, and the client would ask for
  // installation "NaN": a request that cannot be about anybody, sent anyway.
  const { deps, targets } = depsWith({
    database: databaseAnswering({
      installation: { status: "enabled", externalId: "not-a-number" },
    }),
  });
  const error = await assertRejects(
    () => createInstallationCredentialPort(deps).resolve(request()),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(targets.length, 0);
});

Deno.test("the minted token names the validated numeric installation", async () => {
  const { deps, targets } = depsWith();
  await createInstallationCredentialPort(deps).resolve(request());
  assertEquals(targets[0]!.installationId, 1234);
});

Deno.test("the token is minted with exactly the declared permissions", async () => {
  // Never widened: an installation may hold far more than the action declared,
  // and a token minted to the installation's maximum would be authority the
  // caller never asked for.
  const { deps, targets } = depsWith({
    database: databaseAnswering({}),
  });
  await createInstallationCredentialPort(deps).resolve(
    request({ providerPermissions: { contents: "write", issues: "read" } }),
  );
  assertEquals(targets.length, 1);
  assertEquals(targets[0]!.permissions, { contents: "write", issues: "read" });
});

Deno.test("a disabled installation is refused by the broker, not minted", async () => {
  const { deps, targets } = depsWith({
    database: databaseAnswering({
      installation: { status: "suspended", externalId: "1234" },
    }),
    broker: {
      isCurrent: () => true,
      generation: () => 7,
      token: (target: TokenTarget) => {
        targets.push(target);
        // The broker's own rule: only an enabled installation mints.
        return Promise.resolve(
          target.installationStatus === "enabled"
            ? {
              kind: "minted",
              token: "ghs_x",
              expiresAt: 0,
              permissions: {},
              repositoryIds: [],
            }
            : { kind: "refused" },
        );
      },
    } as unknown as CredentialStoreDeps["broker"],
  });
  const failure = await assertRejects(
    () => createInstallationCredentialPort(deps).resolve(request()),
    StandardError,
  );
  // One shape for "no usable credential", matching what the broker's caller
  // already raises at this stage rather than inventing a second one.
  assertEquals(failure.code, "STATE_CONFLICT");
  assertEquals(
    (failure.params as { reason?: string } | undefined)?.reason,
    "auth_required",
  );
});

Deno.test("a connection whose rows are gone is refused, never minted from guesses", async () => {
  const { deps, targets } = depsWith({
    database: databaseAnswering({ connection: null }),
  });
  const failure = await assertRejects(
    () => createInstallationCredentialPort(deps).resolve(request()),
    StandardError,
  );
  assertEquals(failure.code, "STATE_CONFLICT");
  assertEquals(targets.length, 0, "no token may be minted without the rows");
});

Deno.test("a missing app registration is refused", async () => {
  const { deps, targets } = depsWith({
    database: databaseAnswering({}),
    readAppCredentials: () => Promise.resolve(null),
  });
  await assertRejects(
    () => createInstallationCredentialPort(deps).resolve(request()),
    StandardError,
  );
  assertEquals(targets.length, 0);
});

Deno.test("a repository id that is not a number is refused, never narrowed to NaN", async () => {
  // An empty set is not a narrower token: the real client refuses one, and the
  // refusal would arrive as DEPENDENCY_UNAVAILABLE, which reads as an outage.
  let reads = 0;
  const { deps, targets } = depsWith({
    database: databaseAnswering({}, () => {
      reads += 1;
    }),
  });
  const error = await assertRejects(
    () =>
      createInstallationCredentialPort(deps).resolve(
        request({
          subject: {
            installId: INSTALL,
            resourceKind: "repository",
            repositoryId: "abc",
          },
        }),
      ),
    StandardError,
  );
  assertEquals((error as StandardError).code, "STATE_CONFLICT");
  // Refused before the rows were read and before any key was touched.
  assertEquals(reads, 0);
  assertEquals(targets.length, 0);
});

Deno.test("no repository id is refused before anything is read or minted", async () => {
  let reads = 0;
  const { deps, targets } = depsWith({
    database: databaseAnswering({}, () => {
      reads += 1;
    }),
  });
  const error = await assertRejects(
    () =>
      createInstallationCredentialPort(deps).resolve(
        request({
          subject: { installId: INSTALL, resourceKind: "organization" },
        }),
      ),
    StandardError,
  );
  assertEquals((error as StandardError).code, "STATE_CONFLICT");
  assertEquals(reads, 0);
  assertEquals(targets.length, 0);
});

Deno.test("the credential is never written into the token target or an error", async () => {
  // A credential store that leaks the secret into the values it hands around
  // turns one compromise into two.
  const { deps, targets } = depsWith({ database: databaseAnswering({}) });
  const credential = await createInstallationCredentialPort(deps).resolve(
    request(),
  );
  assert(typeof credential === "string");
  assert(
    !JSON.stringify(targets).includes(credential as string),
    "the minted credential must not appear in the target sent to the broker",
  );
});

Deno.test("the provider request port is assembled WITH a credential store", () => {
  // `createBroker` had no production caller: it needs a CredentialPort and
  // nothing implemented one. The assembly takes both together, so a caller
  // cannot wire the sender without the credential source.
  const { deps } = depsWith({ database: databaseAnswering({}) });
  const port = createProviderRequestPort({
    ...deps,
    registry: {
      integrations: [],
      byGateId: new Map(),
      bySlug: new Map(),
    } as never,
    fetch: (() =>
      Promise.reject(new Error("unused"))) as unknown as typeof fetch,
    snapshotPort: { snapshot: () => Promise.resolve(null) } as never,
    secretsKey: undefined,
    providers: { providers: [] },
  });
  assertEquals(typeof port.request, "function");
});

Deno.test("createBroker has a production caller", async () => {
  // A source-level assertion, because the defect being fixed is precisely an
  // absence: a green suite that never notices nothing calls the sender.
  const source = await Deno.readTextFile(
    new URL(
      "../../apps/server/src/modules/integrations/credential-port.ts",
      import.meta.url,
    ),
  );
  assert(
    /createBroker\(\{/.test(source),
    "the credential store must assemble the broker, not export a port nobody uses",
  );
  assert(
    !/export function createProviderRequestPort[\s\S]{0,600}?denyAllProviderRequests/
      .test(source),
    "the production port must not quietly fall back to denying every request",
  );
});

Deno.test("the assembled port reaches the invoke door", async () => {
  // The store existing is not enough: the door must receive it. This is the
  // wiring that was missing - the door defaulted to denying every send, so a
  // correct credential store would still have changed nothing.
  const app = await Deno.readTextFile(
    new URL("../../apps/server/src/app.ts", import.meta.url),
  );
  assert(
    /const providerRequests = createProviderRequestPort\(\{/.test(app),
    "app.ts must assemble the provider request port once per process",
  );
  assert(
    /createIntegrationsRoutes\(\{[\s\S]{0,900}?providerRequests,/.test(app),
    "the integrations routes must be handed the assembled port, not the deny-all default",
  );
  assert(
    // Whitespace-tolerant: the assertion is about the wiring, not the wrapping.
    /generationOf:[^\n]*\n\s*installationTokenBroker\.generation\(connectionId\)/
      .test(app),
    "the generation must come from the process broker, so an edit mid-request refuses",
  );
});

/**
 * The proof that the narrowed set is the one GitHub is actually asked for.
 *
 * The unit fixture answered `repositoryIds: [900]` no matter what it was given,
 * which is exactly why #640 shipped: the fixture set the id by hand while the
 * production snapshot never did. These two tests put the real client in the
 * path, so the value that reaches the wire is the value the port produced.
 */
function recordingGitHub(answer: () => Response) {
  const requests: { url: string; body: unknown }[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
  return { client: createFetchGitHubAppClient(fetcher), requests };
}

const TOKEN_ANSWER = () =>
  new Response(
    JSON.stringify({
      token: "ghs_realminted",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: "read" },
      repositories: [{ id: 900 }],
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );

Deno.test("the set the port narrows to is the set GitHub is asked for", async () => {
  const { client, requests } = recordingGitHub(TOKEN_ANSWER);
  const { deps, targets } = depsWith();
  await createInstallationCredentialPort(deps).resolve(request());

  // What the port decided, and then what the real client sent with it.
  assertEquals(targets[0]!.repositoryIds, [900]);
  const minted = await client.mintInstallationToken(
    {
      jwt: "signed-app-jwt",
      installationId: targets[0]!.installationId,
      repositoryIds: targets[0]!.repositoryIds,
      permissions: targets[0]!.permissions,
    },
    new AbortController().signal,
  );

  assertEquals(minted.kind, "minted");
  assertEquals(requests.length, 1);
  assertEquals(
    requests[0]!.url,
    "https://api.github.com/app/installations/1234/access_tokens",
  );
  assertEquals(
    (requests[0]!.body as { repository_ids: number[] }).repository_ids,
    [900],
  );
});

Deno.test("the real client refuses an empty set, which is why the port refuses first", async () => {
  const { client, requests } = recordingGitHub(TOKEN_ANSWER);
  const error = await assertRejects(
    () =>
      client.mintInstallationToken(
        {
          jwt: "signed-app-jwt",
          installationId: 1234,
          repositoryIds: [],
          permissions: { contents: "read" },
        },
        new AbortController().signal,
      ),
    StandardError,
  );

  // No request left the process, and the code the caller would have seen names
  // a dependency outage rather than the unbound repository that caused it.
  assertEquals((error as StandardError).code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(requests.length, 0);
});
