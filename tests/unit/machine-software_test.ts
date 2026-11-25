import { assertEquals } from "@std/assert";
import {
  softwareRows,
  softwareUpdate,
} from "../../apps/web/src/pages/machine-software.ts";

Deno.test("an update is offered only when the available version differs", () => {
  assertEquals(softwareUpdate("1.2.0", "1.3.0"), {
    kind: "available",
    version: "1.3.0",
  });
  assertEquals(softwareUpdate("1.2.0", "1.2.0"), { kind: "upToDate" });
  assertEquals(softwareUpdate("1.2.0", null), { kind: "notReported" });
  assertEquals(softwareUpdate("1.2.0", undefined), { kind: "notReported" });
  assertEquals(softwareUpdate("1.2.0", ""), { kind: "notReported" });
});

Deno.test("software rows keep every component, name an agent by its agent, and carry kind, owner and update", () => {
  assertEquals(
    softwareRows([
      {
        componentKey: "harness.claude",
        kind: "harness",
        actualVersion: "1.2.0",
        installOwner: "external",
        availableVersion: "1.3.0",
      },
      {
        componentKey: "worker-supervisor",
        kind: "worker",
        actualVersion: "3.0.0",
        installOwner: "bakery",
        availableVersion: "3.0.0",
      },
      {
        componentKey: "git",
        kind: "toolchain",
        actualVersion: "2.40.0",
        installOwner: "external",
      },
    ]),
    [
      {
        key: "harness.claude@1.2.0",
        agent: "claude",
        name: "harness.claude",
        kind: "harness",
        version: "1.2.0",
        installedBy: "external",
        update: { kind: "available", version: "1.3.0" },
      },
      {
        key: "worker-supervisor@3.0.0",
        agent: null,
        name: "worker-supervisor",
        kind: "worker",
        version: "3.0.0",
        installedBy: "bakery",
        update: { kind: "upToDate" },
      },
      {
        key: "git@2.40.0",
        agent: null,
        name: "git",
        kind: "toolchain",
        version: "2.40.0",
        installedBy: "external",
        update: { kind: "notReported" },
      },
    ],
  );
  assertEquals(softwareRows([]), []);
});
