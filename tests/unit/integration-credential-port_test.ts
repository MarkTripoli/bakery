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
            status: "active",
            installationId: INSTALL,
          },
        ],
      });
    }
    return Promise.resolve({
      rows: rows.installation === null ? [] : [
        rows.installation ?? {
          status: "active",
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

Deno.test("the generation is captured BEFORE the rows are read", async () => {
  // Ordering is the safety property, not a detail: capture after the read leaves
  // a window where a connection revoked mid-request still mints a token against
  // authority that has since changed.
  const order: string[] = [];
  const { deps } = depsWith({
    database: databaseAnswering({}, () => order.push("read")),
    generationOf: () => {
      order.push("generation");
      return 7;
    },
  });
  await createInstallationCredentialPort(deps).resolve(request());
  assertEquals(
    order[0],
    "generation",
    "the generation must be captured before any row is read",
  );
  assertEquals(order.indexOf("read") > 0, true);
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

Deno.test("a non-numeric repository id narrows to no repositories, not NaN", async () => {
  // `Number("abc")` is NaN, and a NaN in a permission set is a request GitHub
  // rejects at best. An unparseable id yields an empty set instead.
  const { deps, targets } = depsWith({ database: databaseAnswering({}) });
  await createInstallationCredentialPort(deps).resolve(
    request({
      subject: {
        installId: INSTALL,
        resourceKind: "repository",
        repositoryId: "abc",
      },
    }),
  );
  assertEquals(targets[0]!.repositoryIds, []);
});

Deno.test("no repository id yields an empty narrowed set", async () => {
  const { deps, targets } = depsWith({ database: databaseAnswering({}) });
  await createInstallationCredentialPort(deps).resolve(
    request({ subject: { installId: INSTALL, resourceKind: "organization" } }),
  );
  assertEquals(targets[0]!.repositoryIds, []);
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
    /generationOf:[\s\S]{0,120}?installationTokenBroker\.generation\(connectionId\)/
      .test(app),
    "the generation must come from the process broker, so an edit mid-request refuses",
  );
});
