import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Offsite,
  OffsiteError,
  offsiteFromSettings,
  pruneLocal,
  pruneOffsite,
  uploadSet,
} from "../../scripts/deploy/backup-runner/offsite.ts";
import type { RunnerSettings } from "../../scripts/deploy/backup-runner/api.ts";
import type { Artifact } from "../../scripts/deploy/backup-runner/backup-step.ts";
import { createSecrets } from "../../scripts/deploy/backup-runner/redact.ts";
import { startS3Receiver } from "../helpers/s3-receiver.ts";

const KEY_ID = "AKIAEXAMPLEKEY123456";
const KEY_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const BUCKET = "bakery-backups";
const set = (stamp: string, n = 1) =>
  `${stamp}-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const N1 = set("20260101T030000Z", 1);
const N2 = set("20260201T030000Z", 2);
const N3 = set("20261119T030000Z", 3);

const base: RunnerSettings = {
  scheduleEnabled: true,
  daysToKeep: 30,
  offsiteConfigured: true,
  offsiteEndpoint: "http://127.0.0.1:1",
  offsiteRegion: "us-east-1",
  offsiteBucket: BUCKET,
  offsitePrefix: "prod/",
  offsiteAccessKeyId: KEY_ID,
  offsiteSecretAccessKey: KEY_SECRET,
  offsiteRefusal: null,
};

function offsiteFor(
  endpoint: string,
  allowLoopbackEndpoint = true,
): Offsite {
  const offsite = offsiteFromSettings(
    { ...base, offsiteEndpoint: endpoint },
    { allowLoopbackEndpoint },
  );
  assert(offsite !== null);
  return offsite;
}

async function makeArtifact(
  root: string,
  name: string,
  files: Record<string, Uint8Array>,
): Promise<Artifact> {
  const directory = `${root}/${name}`;
  await Deno.mkdir(directory, { recursive: true });
  const list = [];
  let total = 0;
  for (const [file, bytes] of Object.entries(files)) {
    await Deno.writeFile(`${directory}/${file}`, bytes);
    list.push({ name: file, path: `${directory}/${file}`, size: bytes.length });
    total += bytes.length;
  }
  return { name, directory, files: list, totalBytes: total };
}

const bytes = (length: number, seed = 1) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251);

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-runner-offsite-" });
  try {
    return await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const secrets = () => createSecrets([KEY_ID, KEY_SECRET]);
const standardSet = (root: string, name: string, seed = 1) =>
  makeArtifact(root, name, {
    "bakery.dump.age": bytes(300, seed),
    "inngest.dump.age": bytes(120, seed + 1),
    "files.tar.gz.age": bytes(80, seed + 2),
    "release.json": new TextEncoder().encode("{}"),
    SHA256SUMS: new TextEncoder().encode("sums\n"),
  });

Deno.test("a set uploads under <prefix><name>/, data first and the checksum list last, and every object is verified", async () => {
  await withTemp(async (root) => {
    const receiver = startS3Receiver();
    try {
      const artifact = await standardSet(root, N3);
      const done: number[] = [];
      await uploadSet({
        offsite: offsiteFor(receiver.endpoint),
        artifact,
        secrets: secrets(),
        onFile: (n) => done.push(n),
      });
      assertEquals(done, [1, 2, 3, 4, 5]);
      for (const file of artifact.files) {
        const stored = receiver.objects.get(
          `/${BUCKET}/prod/${N3}/${file.name}`,
        );
        assert(stored !== undefined, file.name);
        assertEquals(stored.length, file.size);
        assertEquals(stored, await Deno.readFile(file.path));
      }
      const puts = receiver.requests.filter((r) => r.startsWith("PUT ")).map((
        r,
      ) => r.split("/").at(-1));
      assertEquals(puts.at(-1), "SHA256SUMS");
      assertEquals(puts.at(-2), "release.json");
      // Every upload was followed by a size check.
      assertEquals(
        receiver.requests.filter((r) => r.startsWith("HEAD ")).length,
        5,
      );
    } finally {
      await receiver.stop();
    }
  });
});

Deno.test("a file larger than one part goes up as a multipart upload and arrives byte for byte", async () => {
  await withTemp(async (root) => {
    const receiver = startS3Receiver();
    try {
      const artifact = await makeArtifact(root, N3, {
        "bakery.dump.age": bytes(2500, 7),
        "empty.age": new Uint8Array(0),
        SHA256SUMS: new TextEncoder().encode("sums\n"),
      });
      await uploadSet({
        offsite: offsiteFor(receiver.endpoint),
        artifact,
        secrets: secrets(),
        partBytes: 1000,
      });
      assertEquals(
        receiver.objects.get(`/${BUCKET}/prod/${N3}/bakery.dump.age`),
        bytes(2500, 7),
      );
      assertEquals(
        receiver.objects.get(`/${BUCKET}/prod/${N3}/empty.age`)?.length,
        0,
      );
      const key = `/${BUCKET}/prod/${N3}/bakery.dump.age`;
      assertEquals(
        receiver.requests.filter((r) => r === `PUT ${key}`).length,
        3,
      );
      assertEquals(
        receiver.requests.filter((r) => r === `POST ${key}`).length,
        2,
      );
    } finally {
      await receiver.stop();
    }
  });
});

Deno.test("an object the destination holds at another size is not claimed as off-site", async () => {
  await withTemp(async (root) => {
    const receiver = startS3Receiver({ headSizeDelta: -1 });
    try {
      const error = await assertRejects(
        async () =>
          await uploadSet({
            offsite: offsiteFor(receiver.endpoint),
            artifact: await standardSet(root, N3),
            secrets: secrets(),
          }),
        OffsiteError,
      );
      assertEquals(error.code, "runner_error");
      assert(error.detail.includes("expected"));
    } finally {
      await receiver.stop();
    }
  });
});

Deno.test("a destination that answers 403 is destination_refused and the key never appears", async () => {
  await withTemp(async (root) => {
    const receiver = startS3Receiver({ rejectKey: KEY_ID });
    try {
      const error = await assertRejects(
        async () =>
          await uploadSet({
            offsite: offsiteFor(receiver.endpoint),
            artifact: await standardSet(root, N3),
            secrets: secrets(),
          }),
        OffsiteError,
      );
      assertEquals(error.code, "destination_refused");
      assert(!error.detail.includes(KEY_ID));
      assert(!error.detail.includes(KEY_SECRET));
      assertEquals(receiver.objects.size, 0);
    } finally {
      await receiver.stop();
    }
  });
});

Deno.test("a destination that cannot be reached is destination_unreachable", async () => {
  await withTemp(async (root) => {
    const receiver = startS3Receiver();
    const endpoint = receiver.endpoint;
    await receiver.stop();
    const error = await assertRejects(
      async () =>
        await uploadSet({
          offsite: offsiteFor(endpoint),
          artifact: await standardSet(root, N3),
          secrets: secrets(),
        }),
      OffsiteError,
    );
    assertEquals(error.code, "destination_unreachable");
  });
});

/** A TCP listener that counts how many connections were attempted against it. */
function connectionCounter() {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const state = { connections: 0 };
  (async () => {
    try {
      for await (const connection of listener) {
        state.connections++;
        connection.close();
      }
    } catch { /* closed */ }
  })();
  return {
    port: (listener.addr as Deno.NetAddr).port,
    state,
    close: () => listener.close(),
  };
}

Deno.test("a name that resolves to a private or loopback address is refused before any connection", async () => {
  await withTemp(async (root) => {
    for (
      const address of [
        "10.0.0.5",
        "127.0.0.1",
        "169.254.169.254",
        "fd00:ec2::254",
        "::ffff:192.168.1.1",
      ]
    ) {
      const decoy = connectionCounter();
      try {
        const error = await assertRejects(
          async () =>
            await uploadSet({
              offsite: offsiteFor(
                `https://backups.example.test:${decoy.port}`,
                false,
              ),
              artifact: await standardSet(root, N3),
              secrets: secrets(),
              resolve: () => Promise.resolve([address]),
            }),
          OffsiteError,
          "",
          address,
        );
        assertEquals(error.code, "destination_refused", address);
        assertEquals(error.detail, "destination_private_address", address);
        assertEquals(decoy.state.connections, 0, address);
      } finally {
        decoy.close();
      }
    }
  });
});

Deno.test("a name re-pointed after it was checked is refused at the socket, with no connection", async () => {
  await withTemp(async (root) => {
    const decoy = connectionCounter();
    try {
      let asked = 0;
      const error = await assertRejects(
        async () =>
          await uploadSet({
            offsite: offsiteFor(
              `https://backups.example.test:${decoy.port}`,
              false,
            ),
            artifact: await standardSet(root, N3),
            secrets: secrets(),
            // The check sees a public address; the connection then sees loopback.
            resolve: () =>
              Promise.resolve(
                ++asked === 1 ? ["93.184.216.34"] : ["127.0.0.1"],
              ),
          }),
        OffsiteError,
      );
      assertEquals(error.code, "destination_refused");
      assertEquals(error.detail, "destination_private_address");
      assertEquals(decoy.state.connections, 0);
      assert(asked >= 2);
    } finally {
      decoy.close();
    }
  });
});

Deno.test("a name that cannot be resolved is destination_unreachable", async () => {
  await withTemp(async (root) => {
    const error = await assertRejects(
      async () =>
        await uploadSet({
          offsite: offsiteFor("https://backups.example.test", false),
          artifact: await standardSet(root, N3),
          secrets: secrets(),
          resolve: () => Promise.reject(new Error("NXDOMAIN")),
        }),
      OffsiteError,
    );
    assertEquals(error.code, "destination_unreachable");
    assertEquals(error.detail, "destination_unresolvable");
  });
});

Deno.test("off-site retention removes expired sets and nothing else, and never the newest or the one just taken", async () => {
  await withTemp(async (root) => {
    const receiver = startS3Receiver();
    try {
      const offsite = offsiteFor(receiver.endpoint);
      for (const [n, name] of [N1, N2, N3].entries()) {
        await uploadSet({
          offsite,
          artifact: await standardSet(root, name, n + 1),
          secrets: secrets(),
        });
      }
      // Things that are not backup sets, and another folder.
      receiver.objects.set(`/${BUCKET}/prod/notes.txt`, bytes(5));
      receiver.objects.set(`/${BUCKET}/prod/latest/x`, bytes(5));
      receiver.objects.set(`/${BUCKET}/other/${N1}/x`, bytes(5));
      const removed = await pruneOffsite({
        offsite,
        artifactName: N3,
        daysToKeep: 30,
        now: new Date("2026-11-20T12:00:00Z"),
      });
      assertEquals(removed, [N1, N2]);
      const keys = [...receiver.objects.keys()];
      assertEquals(keys.some((k) => k.includes(`/prod/${N1}/`)), false);
      assertEquals(keys.some((k) => k.includes(`/prod/${N2}/`)), false);
      assertEquals(keys.filter((k) => k.includes(`/prod/${N3}/`)).length, 5);
      for (
        const kept of ["/prod/notes.txt", "/prod/latest/x", `/other/${N1}/x`]
      ) {
        assert(receiver.objects.has(`/${BUCKET}${kept}`), kept);
      }
      // Nothing is expired when everything is recent or it is the only set.
      assertEquals(
        await pruneOffsite({
          offsite,
          artifactName: N3,
          daysToKeep: 30,
          now: new Date("2026-11-20T12:00:00Z"),
        }),
        [],
      );
    } finally {
      await receiver.stop();
    }
  });
});

Deno.test("local retention reads the marker: an incomplete newest directory shields nothing and old ones are pruned", async () => {
  await withTemp(async (root) => {
    const backups = `${root}/backups`;
    await Deno.mkdir(backups);
    const completeOld = set("20261001T030000Z", 11);
    const completeNewest = set("20261101T030000Z", 12);
    const incompleteOld = set("20261015T030000Z", 13);
    const incompleteRecent = set("20261119T030000Z", 14);
    for (
      const [name, marked] of [
        [completeOld, false],
        [completeNewest, false],
        [incompleteOld, true],
        [incompleteRecent, true],
      ] as const
    ) {
      await Deno.mkdir(`${backups}/${name}`);
      await Deno.writeTextFile(`${backups}/${name}/SHA256SUMS`, "x");
      if (marked) {
        await Deno.writeTextFile(
          `${backups}/${name}/INCOMPLETE.json`,
          JSON.stringify({
            format: 1,
            complete: false,
            cause: "manifest_builder_missing",
            detail: "deno is not installed",
            failedStores: [],
          }),
        );
      }
    }
    await Deno.writeTextFile(
      `${backups}/latest`,
      `${backups}/${completeNewest}\n`,
    );
    const removed = await pruneLocal({
      root: backups,
      // Nothing named: no set is protected as "just taken".
      artifactName: set("20990101T000000Z", 99),
      daysToKeep: 7,
      now: new Date("2026-11-20T12:00:00Z"),
    });
    // The old complete set and the old incomplete set go; the newest COMPLETE
    // set stays, as does the incomplete one that is not yet old enough.
    assertEquals(removed.sort(), [completeOld, incompleteOld].sort());
    const left = [];
    for await (const entry of Deno.readDir(backups)) left.push(entry.name);
    assertEquals(
      left.sort(),
      [completeNewest, incompleteRecent, "latest"].sort(),
    );
    // `latest` is never touched by retention.
    assertEquals(
      (await Deno.readTextFile(`${backups}/latest`)).trim(),
      `${backups}/${completeNewest}`,
    );
  });
});

Deno.test("settings become an off-site target, or a named failure", () => {
  const allow = { allowLoopbackEndpoint: false };
  assertEquals(
    offsiteFromSettings({ ...base, offsiteConfigured: false }, allow),
    null,
  );
  // The server withheld the credentials: a failure, never a silent skip.
  const refused = (word: string) =>
    assertRejectsSync(() =>
      offsiteFromSettings({ ...base, offsiteRefusal: word }, allow)
    );
  assertEquals(refused("destination_private_address"), [
    "destination_refused",
    "destination_private_address",
  ]);
  assertEquals(refused("destination_invalid"), [
    "destination_refused",
    "destination_invalid",
  ]);
  assertEquals(refused("destination_unresolvable"), [
    "destination_unreachable",
    "destination_unresolvable",
  ]);
  // Configured but no credentials released.
  assertEquals(
    assertRejectsSync(() =>
      offsiteFromSettings({ ...base, offsiteAccessKeyId: null }, allow)
    ),
    [
      "runner_error",
      "The off-site destination is configured but the server released no credentials.",
    ],
  );
  // A bad shape of destination.
  assertEquals(
    assertRejectsSync(() =>
      offsiteFromSettings(
        { ...base, offsiteEndpoint: "http://s3.example.com" },
        allow,
      )
    ),
    ["destination_refused", "destination_invalid"],
  );
  // Loopback http only in a test environment.
  assertEquals(
    assertRejectsSync(() =>
      offsiteFromSettings(
        { ...base, offsiteEndpoint: "http://127.0.0.1:9000" },
        allow,
      )
    ),
    ["destination_refused", "destination_invalid"],
  );
  const ok = offsiteFromSettings(
    { ...base, offsiteEndpoint: "http://127.0.0.1:9000" },
    { allowLoopbackEndpoint: true },
  );
  assertEquals(ok?.destination.loopbackAllowed, true);
  assertEquals(ok?.destination.prefix, "prod/");
});

function assertRejectsSync(run: () => unknown): [string, string] {
  try {
    run();
  } catch (error) {
    if (error instanceof OffsiteError) return [error.code, error.detail];
    throw error;
  }
  throw new Error("expected an OffsiteError");
}
