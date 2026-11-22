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

Deno.test("only Linux on arm64 is supported, and it is the one chosen when the page opens", () => {
  assertEquals(
    SYSTEM_ROWS.map((row) => [row.os, row.architecture, row.supported]),
    [
      ["linux", "arm64", true],
      ["linux", "x64", false],
      ["macos", "arm64", false],
      ["macos", "x64", false],
    ],
  );
  assertEquals(supportedRows().map((row) => row.id), ["linux-arm64"]);
  assertEquals(defaultSystemRow()?.id, "linux-arm64");
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
  assertEquals(isSupportedSystem("linux", "x86_64"), false);
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
  // Linux x86_64 has steps but is not supported: it keeps its steps for a
  // machine already enrolled, and cannot be chosen for a new one.
  assertEquals(
    [hasSetupSteps("linux"), isSupportedSystem("linux", "x86_64")],
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
  assertEquals(isSupportedSystem("linux", "x64"), false);
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
