import { assertEquals, assertRejects } from "@std/assert";
import { readReleasePresence } from "../../scripts/ci/native-worker-release-diagnostics.ts";

Deno.test("native failure preserves field-presence diagnostics before deleting owned state", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-presence-" });
  const path = `${directory}/registration.json`;
  const attemptId = "private-attempt-id";
  const credential = "private-credential-must-never-appear";
  let diagnostic = "";
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        workerCredential: credential,
        workerSessionId: "private-session",
        activeAssignments: { [attemptId]: { leaseToken: credential } },
        terminationEvidence: {
          [attemptId]: { observedBy: "private-observer" },
        },
        releaseMarkers: { other: { reason: credential } },
      }),
    );
    await assertRejects(
      async () => {
        try {
          throw new Error("CONTROLLED_NATIVE_FAILURE");
        } finally {
          diagnostic = JSON.stringify(
            await readReleasePresence(path, attemptId),
          );
          await Deno.remove(directory, { recursive: true });
        }
      },
      Error,
      "CONTROLLED_NATIVE_FAILURE",
    );
    assertEquals(
      diagnostic,
      JSON.stringify({
        state: "readable",
        activeAssignments: true,
        terminationEvidence: true,
        releaseMarkers: false,
      }),
    );
    assertEquals(await readReleasePresence(path, attemptId), {
      state: "unreadable",
    });
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("native presence diagnostics never echo malformed state or read errors", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-unreadable-" });
  const path = `${directory}/registration.json`;
  try {
    for (
      const contents of [
        "private-credential:{",
        "null",
        "[]",
        '{"activeAssignments":"private-credential"}',
      ]
    ) {
      await Deno.writeTextFile(path, contents);
      assertEquals(await readReleasePresence(path, "private-attempt"), {
        state: "unreadable",
      });
    }
    await Deno.writeTextFile(path, "{}");
    assertEquals(await readReleasePresence(path, "private-attempt"), {
      state: "readable",
      activeAssignments: false,
      terminationEvidence: false,
      releaseMarkers: false,
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("native diagnostics identify each surviving release field without credentials or IDs", async () => {
  const directory = await Deno.makeTempDir({ prefix: "native-fields-" });
  const path = `${directory}/registration.json`;
  const attemptId = "private-attempt-id";
  const credential = "private-credential";
  try {
    for (let mask = 0; mask < 8; mask++) {
      const fields = [
        "activeAssignments",
        "terminationEvidence",
        "releaseMarkers",
      ] as const;
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          workerCredential: credential,
          ...Object.fromEntries(fields.map((field, index) => [
            field,
            mask & (1 << index)
              ? { [attemptId]: { privateValue: credential } }
              : {},
          ])),
        }),
      );
      const diagnostic = await readReleasePresence(path, attemptId);
      assertEquals(diagnostic, {
        state: "readable",
        activeAssignments: Boolean(mask & 1),
        terminationEvidence: Boolean(mask & 2),
        releaseMarkers: Boolean(mask & 4),
      });
      const output = JSON.stringify(diagnostic);
      assertEquals(output.includes(credential), false);
      assertEquals(output.includes(attemptId), false);
      assertEquals(output.includes("privateValue"), false);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
