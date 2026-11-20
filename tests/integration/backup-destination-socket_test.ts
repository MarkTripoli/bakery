import { assert, assertEquals } from "@std/assert";
import {
  type HostResolver,
  HostUnresolvable,
} from "../../apps/server/src/modules/backups/dns.ts";
import {
  BackupProbeOutcome,
  probeBackupDestination,
  resolveBackupDestination,
} from "../../apps/server/src/modules/backups/s3.ts";
import { startS3Receiver } from "../helpers/s3-receiver.ts";

/**
 * #80 S1b: the destination probe over a real loopback socket. These open a
 * listening receiver, so they live in the integration lane (the unit lane has
 * no network permission); the DNS and address rules themselves are in
 * tests/unit/backup-destination-dns_test.ts.
 */

function resolverOf(
  answers: Record<string, readonly string[] | "unresolvable">,
): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  const resolve = ((hostname: string) => {
    calls.push(hostname);
    const answer = answers[hostname];
    if (answer === undefined || answer === "unresolvable") {
      return Promise.reject(new HostUnresolvable());
    }
    return Promise.resolve(answer);
  }) as HostResolver & { calls: string[] };
  resolve.calls = calls;
  return resolve;
}

const credentials = {
  accessKeyId: "AKIAPINNED",
  secretAccessKey: "pinned/secret",
};

function fixtureDestination(endpoint: string, host = "s3-fixture") {
  // `s3-fixture` is a test host: allowed as a loopback fixture in a test environment.
  const url = new URL(endpoint);
  return resolveBackupDestination(
    {
      endpoint: `http://${host}:${url.port}`,
      region: "us-east-1",
      bucket: "bakery-backups",
      prefix: "",
    },
    { allowLoopbackEndpoint: true },
  );
}

Deno.test("the probe connects to the validated address, and to nothing else", async () => {
  const receiver = startS3Receiver();
  try {
    const destination = fixtureDestination(receiver.endpoint);
    // The name resolves to the loopback fixture: allowed, and the real client reaches it.
    const ok = await probeBackupDestination(
      destination,
      credentials,
      undefined,
      resolverOf({ "s3-fixture": ["127.0.0.1"] }),
    );
    assertEquals(ok.outcome, BackupProbeOutcome.Verified, String(ok.detail));
    assert(receiver.requests.some((r) => r.startsWith("PUT ")));
    const reached = receiver.requests.length;

    // Re-pointed at a private address: refused before any socket is opened.
    const repointed = await probeBackupDestination(
      destination,
      credentials,
      undefined,
      resolverOf({ "s3-fixture": ["10.0.0.5"] }),
    );
    assertEquals(
      repointed.outcome,
      BackupProbeOutcome.DestinationPrivateAddress,
    );
    // A mixed answer is refused the same way.
    const mixed = await probeBackupDestination(
      destination,
      credentials,
      undefined,
      resolverOf({ "s3-fixture": ["127.0.0.1", "169.254.169.254"] }),
    );
    assertEquals(mixed.outcome, BackupProbeOutcome.DestinationPrivateAddress);
    // A name that no longer resolves is unreachable, with no address named.
    const gone = await probeBackupDestination(
      destination,
      credentials,
      undefined,
      resolverOf({}),
    );
    assertEquals(gone.outcome, BackupProbeOutcome.DestinationUnreachable);
    assertEquals(receiver.requests.length, reached);
  } finally {
    await receiver.stop();
  }
});

Deno.test("a name re-pointed between the check and the connection is caught at the socket", async () => {
  const receiver = startS3Receiver();
  try {
    const destination = fixtureDestination(receiver.endpoint);
    // The first resolution (the pre-check) answers the loopback fixture; every
    // later one (the connection's own lookup) answers a private address, as a
    // rebinding name with a zero TTL would.
    let asked = 0;
    const rebinding: HostResolver = () => {
      asked += 1;
      return Promise.resolve(asked === 1 ? ["127.0.0.1"] : ["10.0.0.5"]);
    };
    const result = await probeBackupDestination(
      destination,
      credentials,
      undefined,
      rebinding,
    );
    assertEquals(result.outcome, BackupProbeOutcome.DestinationPrivateAddress);
    assert(asked >= 2, `the connection asked again (${asked})`);
    // No request reached the receiver: the socket was never opened.
    assertEquals(receiver.requests, []);
  } finally {
    await receiver.stop();
  }
});

Deno.test("a test environment still refuses a private address that is not loopback", async () => {
  const receiver = startS3Receiver();
  try {
    const destination = fixtureDestination(receiver.endpoint);
    const result = await probeBackupDestination(
      destination,
      credentials,
      undefined,
      resolverOf({ "s3-fixture": ["192.168.1.10"] }),
    );
    assertEquals(result.outcome, BackupProbeOutcome.DestinationPrivateAddress);
    assertEquals(receiver.requests, []);
  } finally {
    await receiver.stop();
  }
});
