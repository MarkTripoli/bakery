import { assert, assertEquals } from "@std/assert";
import { fakeAppKey, fakeRepositories } from "../helpers/fake-github-app.ts";
import {
  count,
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
  patchConnection,
  postCheck,
} from "../helpers/github-app-registration.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

/** Every console line written while `run` runs. */
async function capturing<T>(
  run: (lines: string[]) => Promise<T>,
): Promise<T> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      lines.push(
        args.map((arg) =>
          arg instanceof Error
            ? `${arg.name} ${arg.message} ${arg.stack}`
            : typeof arg === "string"
            ? arg
            : JSON.stringify(arg)
        ).join(" "),
      );
    };
  }
  try {
    return await run(lines);
  } finally {
    methods.forEach((name, index) => console[name] = originals[index]);
  }
}

/** The PEM's base64 body lines; any of them in a value means the key leaked. */
const keyFragments = fakeAppKey.pem.split("\n").filter((line) =>
  line.length > 40 && !line.startsWith("-----")
);

const TABLES = [
  "bakery.audit_events",
  "bakery.domain_events",
  "bakery.idempotency_records",
  "bakery.integration_resources",
  "bakery.integration_connections",
  "bakery.integration_installations",
] as const;

/**
 * Asserts no installation token GitHub issued and no line of the App private
 * key appears in any stored row, response body or console line.
 */
async function assertRedacted(
  f: GitHubAppFixture,
  bodies: string[],
  lines: string[],
) {
  const secrets = [
    ...f.github.issuedTokens.filter((token) => token.startsWith("ghs_")),
    ...keyFragments,
  ];
  assert(secrets.length > keyFragments.length, "a token was issued");
  for (const secret of secrets) {
    for (const body of bodies) assert(!body.includes(secret), "response");
    for (const line of lines) assert(!line.includes(secret), "log line");
    for (const table of TABLES) {
      assertEquals(
        await count(
          f,
          `select count(*) from ${table} as t where t::text like '%' || $1 || '%'`,
          [secret],
        ),
        0,
        table,
      );
    }
  }
  // The fake's request log keeps only the token's shape.
  for (const call of f.github.calls) {
    const authorization = call.headers["authorization"] ?? "";
    assert(
      !authorization.startsWith("Bearer ghs_") ||
        authorization === "Bearer ghs_[redacted]",
    );
  }
}

Deno.test("the installation token and the App key stay out of rows, responses, audit, events and logs on every check path", async () => {
  await withFixture(async (f) => {
    const { connectionId, installation } = await enabledConnection(f, {
      repositories: fakeRepositories(3, ["admin"]),
      selected: 2,
    });
    await capturing(async (lines) => {
      const bodies: string[] = [];
      const check = async (expected: number) => {
        const response = await postCheck(f, connectionId);
        const body = await response.text();
        assertEquals(response.status, expected, body);
        bodies.push(body);
        return JSON.parse(body);
      };
      // Fresh tokens are needed for each failure path: a rename drops the
      // cached one.
      const rename = async () => {
        const response = await patchConnection(f, connectionId, {
          name: `Renamed ${crypto.randomUUID().slice(0, 6)}`,
        });
        assertEquals(response.status, 200, await response.text());
      };
      // Success: a token is minted, used for the probe and cached.
      assertEquals((await check(200)).healthy, true);
      // Provider failure while minting.
      await rename();
      f.github.failures.tokens.add(installation.id);
      const failed = await check(200);
      assertEquals(failed.fault.code, "DEPENDENCY_UNAVAILABLE");
      f.github.failures.tokens.delete(installation.id);
      // A malformed mint answer carrying a live token: revoked, never shown.
      await rename();
      f.github.failures.malformedTokens.add(installation.id);
      const malformed = await check(200);
      assertEquals(malformed.fault.code, "DEPENDENCY_UNAVAILABLE");
      assertEquals(
        f.github.revokedTokens.at(-1),
        f.github.issuedTokens.at(-1),
        "the malformed answer's token is revoked",
      );
      f.github.failures.malformedTokens.delete(installation.id);
      // A malformed listing after a good mint.
      await rename();
      f.github.failures.malformedListing.add(installation.id);
      const listing = await check(200);
      assertEquals(listing.fault.code, "DEPENDENCY_UNAVAILABLE");
      f.github.failures.malformedListing.delete(installation.id);
      // GitHub refusing the narrowing.
      await rename();
      installation.repositories.splice(0, 1);
      assertEquals((await check(200)).healthy, false);
      // A refusal of our own after the disable.
      const disabled = await patchConnection(f, connectionId, {
        enabled: false,
      });
      assertEquals(disabled.status, 200, await disabled.text());
      await check(409);
      // A fault never carries provider detail: only the safe problem fields.
      for (const fault of [failed.fault, malformed.fault, listing.fault]) {
        assert(!JSON.stringify(fault).includes("Server Error"));
        assert(!JSON.stringify(fault).includes("api.github.com"));
      }
      await assertRedacted(f, bodies, lines);
    });
  });
});

Deno.test("audit and the health event carry only safe identifiers and codes", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    const response = await postCheck(f, connectionId);
    assertEquals(response.status, 200, await response.text());
    const audit = (await f.pgDatabase.query<{ details: unknown }>(
      `select details from bakery.audit_events
        where operation = 'integrationConnections.check' and resource_id = $1`,
      [connectionId],
    )).rows;
    assertEquals(audit.length, 1);
    assertEquals(Object.keys(audit[0].details as object).sort(), [
      "discovery",
      "from",
      "healthy",
      "problem",
      "provider",
      "to",
    ]);
    const events = (await f.pgDatabase.query<{ payload: unknown }>(
      `select payload from bakery.domain_events
        where event_type = 'integration.health_changed' and aggregate_id = $1`,
      [connectionId],
    )).rows;
    assertEquals(events.length, 1);
    assertEquals(Object.keys(events[0].payload as object).sort(), [
      "resourceId",
      "resourceVersion",
    ]);
  });
});

Deno.test("another organization's Admin learns nothing about a connection it cannot see", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await enabledConnection(f);
    const unknown = await postCheck(f, crypto.randomUUID());
    const hidden = await postCheck(f, connectionId, {
      organizationId: crypto.randomUUID(),
    });
    // A foreign organization id is refused before the connection is read.
    assert([403, 404].includes(hidden.status), await hidden.text());
    const unknownBody = await unknown.json();
    assertEquals(unknown.status, 404);
    assertEquals(unknownBody.code, "RESOURCE_NOT_FOUND");
    assertEquals(f.github.calls.length, 0);
  });
});
