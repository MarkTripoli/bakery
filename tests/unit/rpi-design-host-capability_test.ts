import { assertEquals } from "@std/assert";
import {
  hostSatisfiedCapabilities,
  WORKFLOW_ACTION_METADATA,
} from "@bakery/contracts/workflow-action-registry";
import { hostMeetsJobRequirements } from "../../packages/persistence/src/job-platform.ts";
import { readWorkerConfig } from "../../apps/worker/src/config.ts";

/**
 * #436: no host claims a design step it cannot run. rpi.design needs its design
 * tool; a host has it when it advertises `paper`, or when it runs the Claude
 * harness, which serves the session its bound tools through the tool gateway
 * and so advertises `tool-gateway`. A Pi or Codex host without `paper` has
 * neither and must not claim the step (it would only refuse it).
 */

const design = {
  capabilities: [...WORKFLOW_ACTION_METADATA["rpi.design"].capabilities],
};

/** The capabilities a worker with this harness registers and claims with. */
function workerCapabilities(
  harness: "CLAUDE" | "PI" | "CODEX",
  capabilities: string,
): string[] {
  const values: Record<string, string> = {
    BAKERY_SERVER_URL: "http://127.0.0.1:8000",
    BAKERY_WORKER_STATE_DIR: "/tmp/bakery-rpi-design-capability-state",
    BAKERY_WORKER_CAPABILITIES: capabilities,
    [`BAKERY_${harness}_HARNESS`]: "1",
    [`BAKERY_${harness}_HARNESS_REPOSITORY`]: "/tmp/bakery-harness-repo",
  };
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(values)) {
    previous.set(name, Deno.env.get(name));
  }
  try {
    for (const [name, value] of Object.entries(values)) {
      Deno.env.set(name, value);
    }
    return readWorkerConfig().capabilities;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

function claims(capabilities: readonly string[]): boolean {
  return hostMeetsJobRequirements(design, { os: "linux", capabilities });
}

Deno.test("rpi.design requires its design tool, not only a model (#436)", () => {
  assertEquals(design.capabilities, ["model", "paper"]);
});

for (const harness of ["PI", "CODEX"] as const) {
  Deno.test(`a ${harness} host without paper does not claim rpi.design (#436)`, () => {
    const capabilities = workerCapabilities(harness, "model,git,shell");
    assertEquals(capabilities.includes("tool-gateway"), false);
    assertEquals(claims(capabilities), false);
  });

  Deno.test(`a ${harness} host with paper claims rpi.design (#436)`, () => {
    assertEquals(claims(workerCapabilities(harness, "model,paper")), true);
  });
}

Deno.test("a Claude host advertises the tool gateway and claims rpi.design without paper (#436)", () => {
  const capabilities = workerCapabilities("CLAUDE", "model,git,shell");
  assertEquals(capabilities.includes("tool-gateway"), true);
  assertEquals(claims(capabilities), true);
});

Deno.test("the tool gateway stands in for paper only, never for a model (#436)", () => {
  assertEquals(claims(["tool-gateway"]), false);
  assertEquals(hostSatisfiedCapabilities(["tool-gateway"]).sort(), [
    "paper",
    "tool-gateway",
  ]);
  assertEquals(hostSatisfiedCapabilities(["model"]), ["model"]);
});
