import { assertEquals } from "@std/assert";
import {
  defaultVersion,
  newestFirst,
  summaryOf,
} from "../../apps/web/src/pages/library/agent-state.ts";

const version = (revision: number, config: unknown = {}) => ({
  id: `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
  agentId: "a",
  revision,
  config,
  digest: "d".repeat(64),
  createdBy: "p",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
});

Deno.test("a configuration is summarised with what the version says and nothing it does not", () => {
  assertEquals(
    summaryOf(version(1, {
      harness: "claude_code",
      billing: { provider: "anthropic", model: "claude-sonnet", maxTokens: 1 },
      allowedCapabilities: ["repo.write", "repo.read", 7],
      promptBindings: { system: "p-2", brief: "p-1" },
      skillBindings: { review: "s-1" },
    })),
    {
      harness: "claude_code",
      model: "claude-sonnet",
      capabilities: ["repo.write", "repo.read"],
      prompts: ["brief", "system"],
      skills: ["review"],
    },
  );
  assertEquals(summaryOf(version(1, {})), {
    harness: null,
    model: null,
    capabilities: [],
    prompts: [],
    skills: [],
  });
  assertEquals(summaryOf(version(1, "not an object")).harness, null);
  assertEquals(summaryOf(version(1, { billing: { model: "" } })).model, null);
});

Deno.test("versions are newest first and the default is the one in use, else the newest", () => {
  const all = [version(1), version(3), version(2)];
  assertEquals(newestFirst(all).map((v) => v.revision), [3, 2, 1]);
  assertEquals(defaultVersion(newestFirst(all), all[0]!.id)?.revision, 1);
  assertEquals(defaultVersion(newestFirst(all), null)?.revision, 3);
  assertEquals(defaultVersion([], null), null);
});
