/**
 * #448 slice S6: the pin rule and the read-set row an agent's storage read
 * records (chapter 25 section 17.6, O46).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  chooseRead,
  listingDigest,
  stepReadSetRow,
} from "../../apps/server/src/modules/knowledge/step-read-set.ts";

const reader = {
  attemptId: "attempt-1",
  agentSessionId: "session-1",
  runId: "run-1",
};
const pin = { artifactVersionId: "version-pinned", sha256: "a".repeat(64) };

Deno.test("an agent's read of a declared input serves the pinned version", () => {
  assertEquals(chooseRead({ reader, pin, revision: null }), {
    kind: "pinned",
    artifactVersionId: "version-pinned",
  });
});

Deno.test("a named revision is the latest on request, never the pin", () => {
  assertEquals(chooseRead({ reader, pin, revision: 3 }), { kind: "latest" });
});

Deno.test("a file that is not a declared input is read as the latest", () => {
  assertEquals(chooseRead({ reader, pin: null, revision: null }), {
    kind: "latest",
  });
});

Deno.test("a person's read is never pinned", () => {
  assertEquals(chooseRead({ reader: null, pin, revision: null }), {
    kind: "latest",
  });
});

Deno.test("a person's read records no read-set row", () => {
  assertEquals(
    stepReadSetRow(null, {
      organizationId: "org",
      entryId: "entry",
      served: { kind: "listing" },
      sha256: "b".repeat(64),
      pinned: false,
    }),
    null,
  );
});

Deno.test("a record-area read names the artifact version and the pin", () => {
  assertEquals(
    stepReadSetRow(reader, {
      organizationId: "org",
      entryId: "entry",
      served: { kind: "artifact", versionId: "version-pinned" },
      sha256: pin.sha256,
      pinned: true,
    }),
    {
      organizationId: "org",
      attemptId: "attempt-1",
      agentSessionId: "session-1",
      entryId: "entry",
      versionId: null,
      artifactVersionId: "version-pinned",
      sha256: pin.sha256,
      pinned: true,
    },
  );
});

Deno.test("a working-area read names the storage version, unpinned", () => {
  const row = stepReadSetRow(reader, {
    organizationId: "org",
    entryId: "entry",
    served: { kind: "storage", versionId: "storage-version" },
    sha256: "c".repeat(64),
    pinned: false,
  });
  assertEquals(row?.versionId, "storage-version");
  assertEquals(row?.artifactVersionId, null);
  assertEquals(row?.pinned, false);
});

Deno.test("a folder listing names no version and digests what it listed", async () => {
  const items = [{ id: "a", kind: "file", versionId: "v1" }];
  const row = stepReadSetRow(reader, {
    organizationId: "org",
    entryId: "folder",
    served: { kind: "listing" },
    sha256: await listingDigest(items),
    pinned: false,
  });
  assertEquals(row?.versionId, null);
  assertEquals(row?.artifactVersionId, null);
  assertEquals(row?.sha256, await listingDigest(items));
  assertNotEquals(
    row?.sha256,
    await listingDigest([{ id: "a", kind: "file", versionId: "v2" }]),
  );
});
