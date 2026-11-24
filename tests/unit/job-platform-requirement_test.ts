import { assertEquals } from "@std/assert";
import { hostMeetsJobRequirements } from "../../packages/persistence/src/job-platform.ts";

// #52 AC2: the claim rule. A job's required platform must equal the host's
// enrolled OS; free capacity or a superset of capabilities never overrides it.

const linux = { os: "linux", capabilities: ["git", "model", "xcode"] };
const mac = { os: "macos", capabilities: ["git", "model"] };

Deno.test("a Linux host cannot take a macOS-only job even with every capability", () => {
  assertEquals(
    hostMeetsJobRequirements(
      { capabilities: ["git"], platform: "macos" },
      linux,
    ),
    false,
  );
});

Deno.test("a host on the required platform with the capabilities takes the job", () => {
  assertEquals(
    hostMeetsJobRequirements({ capabilities: ["git"], platform: "macos" }, mac),
    true,
  );
});

Deno.test("a job with no platform runs on any host that has its capabilities", () => {
  assertEquals(
    hostMeetsJobRequirements({ capabilities: ["git"] }, linux),
    true,
  );
  assertEquals(hostMeetsJobRequirements({ capabilities: ["git"] }, mac), true);
});

Deno.test("the right platform does not excuse a missing capability", () => {
  assertEquals(
    hostMeetsJobRequirements(
      { capabilities: ["xcode"], platform: "macos" },
      mac,
    ),
    false,
  );
});

Deno.test("platform match is exact, not a prefix or case fold", () => {
  for (const os of ["MacOS", "mac", "macos ", "darwin"]) {
    assertEquals(
      hostMeetsJobRequirements({ capabilities: [], platform: "macos" }, {
        os,
        capabilities: [],
      }),
      false,
    );
  }
});
