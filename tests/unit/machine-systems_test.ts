import { assertEquals } from "@std/assert";
import {
  CODING_AGENTS,
  defaultSystemRow,
  isSupportedSystem,
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
      ["linux", "x86_64", false],
      ["macos", "arm64", false],
      ["macos", "x86_64", false],
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
