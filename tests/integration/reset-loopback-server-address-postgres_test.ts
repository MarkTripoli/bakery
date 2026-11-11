import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  closeDatabase,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readServerAddress } from "../../apps/server/src/platform/migrate.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";

const { databaseUrl } = readTestDatabaseConfig(Deno.env.toObject());

/**
 * The reset loopback guard compares the server address to bare loopback hosts.
 * Read-only: neither query changes any state, and no reset is invoked.
 */
Deno.test("reset loopback check reads a bare server address from Postgres", async () => {
  const database = openDatabase(databaseUrl, 1);
  try {
    const address = await readServerAddress(database);
    // TCP connections always report an address; a unix socket reports null.
    assert(address, "expected a TCP server address");
    assert(!address.includes("/"), `prefix length leaked: ${address}`);
    assertMatch(address, /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i);
    // Without host(), inet::text carries a prefix length, which is the bug the
    // loopback comparison used to hit.
    const raw = await database<{ address: string }[]>`
      select inet_server_addr()::text as address
    `;
    assertEquals(
      raw[0]?.address.replace(/\/(32|128)$/, ""),
      address,
      "host() must equal inet::text minus its prefix length",
    );
    assert(raw[0]?.address.includes("/"), "inet::text should carry a prefix");
  } finally {
    await closeDatabase(database);
  }
});
