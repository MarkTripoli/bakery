import { assertEquals } from "@std/assert";
import {
  hostAllowedCapabilities,
  hostSatisfiedCapabilities,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import { hostMeetsJobRequirements } from "../../packages/persistence/src/job-platform.ts";

Deno.test("a Claude enrollment allows the tool gateway its worker advertises", () => {
  assertEquals(hostAllowedCapabilities(["git", "claude"]), [
    "git",
    "claude",
    "tool-gateway",
  ]);
  assertEquals(hostAllowedCapabilities(["claude-code"]), [
    "claude-code",
    "tool-gateway",
  ]);
  assertEquals(hostAllowedCapabilities(["claude", "tool-gateway"]), [
    "claude",
    "tool-gateway",
  ]);
});

Deno.test("an enrollment without Claude allows no tool gateway", () => {
  assertEquals(hostAllowedCapabilities(["git", "codex"]), ["git", "codex"]);
  assertEquals(hostAllowedCapabilities([]), []);
});

Deno.test("a pre-gateway Claude host meets a design step's paper requirement at attempt start", () => {
  const design = { capabilities: ["paper"] };
  assertEquals(
    hostMeetsJobRequirements(design, { os: "linux", capabilities: ["claude"] }),
    true,
  );
  assertEquals(
    hostMeetsJobRequirements(design, { os: "linux", capabilities: ["codex"] }),
    false,
  );
  assertEquals(hostSatisfiedCapabilities(["codex"]).includes("paper"), false);
});
