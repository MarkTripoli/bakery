import { assertEquals } from "@std/assert";
import {
  isSupportedSystem as serverSupports,
  SUPPORTED_WORKER_SYSTEMS,
} from "../../apps/server/src/modules/execution/link-codes.ts";
import {
  CODING_AGENTS,
  defaultSystemRow,
  hasSetupSteps,
  isSupportedSystem,
  normalizeArchitecture,
  supportedRows,
  SYSTEM_ROWS,
  systemRow,
} from "../../apps/web/src/pages/machine-systems.ts";

// #70 slice 3: one typed list of systems is read by every step of the wizard.

Deno.test("Linux on arm64 and on x86_64 are supported, none is chosen for the person, and the macOS rows are not", () => {
  assertEquals(
    SYSTEM_ROWS.map((row) => [row.os, row.architecture, row.supported]),
    [
      ["linux", "arm64", true],
      ["linux", "x64", true],
      ["macos", "arm64", false],
      ["macos", "x64", false],
    ],
  );
  assertEquals(supportedRows().map((row) => row.id), [
    "linux-arm64",
    "linux-x86_64",
  ]);
  // Two supported rows: the person chooses. One would be chosen for them.
  assertEquals(defaultSystemRow(), null);
});

Deno.test("a supported row has an installer and offers every coding agent; any other row offers none", () => {
  for (const row of SYSTEM_ROWS) {
    assertEquals(row.installedAs !== null, row.supported, row.id);
    assertEquals(
      [...row.agents],
      row.supported ? [...CODING_AGENTS] : [],
      row.id,
    );
  }
});

Deno.test("a system is looked up by its system and processor, and an unlisted one is not supported", () => {
  assertEquals(systemRow("linux", "arm64")?.id, "linux-arm64");
  assertEquals(systemRow("linux", "riscv64"), null);
  assertEquals(isSupportedSystem("linux", "arm64"), true);
  assertEquals(isSupportedSystem("linux", "x86_64"), true);
  assertEquals(isSupportedSystem("linux", "riscv64"), false);
  assertEquals(isSupportedSystem("macos", "arm64"), false);
  assertEquals(isSupportedSystem("windows", "x86_64"), false);
  assertEquals(isSupportedSystem("", ""), false);
});

Deno.test("the row ids are unique", () => {
  assertEquals(
    new Set(SYSTEM_ROWS.map((row) => row.id)).size,
    SYSTEM_ROWS.length,
  );
});

Deno.test("a machine has set-up steps on Linux with any processor, never on macOS, and that is separate from being supported", () => {
  for (const row of SYSTEM_ROWS) {
    assertEquals(row.steps !== null, row.os === "linux", row.id);
  }
  assertEquals(hasSetupSteps("linux"), true);
  assertEquals(hasSetupSteps("macos"), false);
  assertEquals(hasSetupSteps("windows"), false);
  // A Linux processor the table does not list has steps but is not supported:
  // it keeps its steps for a machine already enrolled, and cannot be chosen for
  // a new one.
  assertEquals(
    [hasSetupSteps("linux"), isSupportedSystem("linux", "riscv64")],
    [true, false],
  );
});

Deno.test("a processor reads the way the server stores it: x86_64, amd64 and x64 are one, aarch64 is arm64", () => {
  for (const value of ["x64", "x86_64", "X86-64", " amd64 ", "x8664"]) {
    assertEquals(normalizeArchitecture(value), "x64", value);
  }
  for (const value of ["arm64", "aarch64", "ARM64"]) {
    assertEquals(normalizeArchitecture(value), "arm64", value);
  }
  assertEquals(normalizeArchitecture("riscv64"), "riscv64");
});

Deno.test("a machine stored as x64 finds the x86_64 row, so the table and the server agree", () => {
  assertEquals(systemRow("linux", "x64")?.id, "linux-x86_64");
  assertEquals(systemRow("linux", "x86_64")?.id, "linux-x86_64");
  assertEquals(systemRow("linux", "aarch64")?.id, "linux-arm64");
  assertEquals(systemRow("linux", "x64")?.processor, "x86_64");
  assertEquals(isSupportedSystem("linux", "x64"), true);
  assertEquals(isSupportedSystem("linux", "aarch64"), true);
  assertEquals(hasSetupSteps("linux"), true);
});

// The web table copies the server's list of systems it can set up. These tests
// fail the moment the two disagree, in either direction.

Deno.test("the systems the web table calls supported are exactly the server's list", () => {
  const web = SYSTEM_ROWS.filter((row) => row.supported).map((row) =>
    `${row.os}/${row.architecture}`
  ).sort();
  const server = SUPPORTED_WORKER_SYSTEMS.map((system) =>
    `${system.os}/${normalizeArchitecture(system.architecture)}`
  ).sort();
  assertEquals(web, server);
});

Deno.test("every web row agrees with the server on whether its system is supported", () => {
  for (const row of SYSTEM_ROWS) {
    assertEquals(
      serverSupports(row.os, row.architecture),
      row.supported,
      row.id,
    );
  }
});

// The product's list of supported systems is the native support matrix's list
// of verified worker targets (docs/backend-delivery/native-support-matrix.json).
// A target is added here only when its matrix row is verified, and these tests
// fail the moment the two disagree.

Deno.test("the supported systems are exactly the matrix's verified worker targets", async () => {
  const matrix = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../docs/backend-delivery/native-support-matrix.json",
        import.meta.url,
      ),
    ),
  ) as {
    rows: { kind: string; target?: string; status: string }[];
  };
  // A release target is `<platform>-<processor>`: darwin is macOS, and x64 is the stored x64.
  const verified = matrix.rows.filter((row) =>
    row.kind === "worker-target" && row.status === "verified"
  ).map((row) => {
    const [platform, processor] = row.target!.split("-");
    return `${platform === "darwin" ? "macos" : platform}/${
      normalizeArchitecture(processor!)
    }`;
  }).sort();
  const server = SUPPORTED_WORKER_SYSTEMS.map((system) =>
    `${system.os}/${normalizeArchitecture(system.architecture)}`
  ).sort();
  assertEquals(server, verified);
});

Deno.test("the system's name is read the same way everywhere: trimmed and in any case", () => {
  for (const os of ["linux", "Linux", " LINUX "]) {
    assertEquals(hasSetupSteps(os), true, os);
    assertEquals(systemRow(os, "arm64")?.id, "linux-arm64", os);
    assertEquals(isSupportedSystem(os, "x64"), true, os);
  }
  for (const os of ["macos", "macOS", " MacOS "]) {
    assertEquals(hasSetupSteps(os), false, os);
    assertEquals(systemRow(os, "arm64")?.id, "macos-arm64", os);
    assertEquals(isSupportedSystem(os, "arm64"), false, os);
  }
  // The two lookups never disagree about whether a name is a system they know.
  for (const os of ["linux", " Linux", "macos", "darwin", "windows", ""]) {
    assertEquals(
      hasSetupSteps(os),
      SYSTEM_ROWS.some((row) =>
        systemRow(os, row.architecture)?.steps !== null &&
        systemRow(os, row.architecture) !== null
      ),
      os,
    );
  }
});
