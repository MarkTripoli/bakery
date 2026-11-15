import { assertEquals } from "@std/assert";
import {
  type SaveApi,
  saveWorkingSettings,
} from "../../apps/web/src/pages/projects/repository-save.ts";

type Call = { name: string; options: Record<string, unknown> };

/** A fake of the three calls: what each answers, and what was sent, in order. */
function fake(answers: {
  create?: unknown;
  read?: unknown;
  update?: unknown;
}) {
  const calls: Call[] = [];
  const api = {
    createRepositoryProfile: (options: Record<string, unknown>) => {
      calls.push({ name: "create", options });
      return Promise.resolve(answers.create);
    },
    getRepository: (options: Record<string, unknown>) => {
      calls.push({ name: "read", options });
      return Promise.resolve(answers.read);
    },
    updateRepository: (options: Record<string, unknown>) => {
      calls.push({ name: "update", options });
      return Promise.resolve(answers.update);
    },
  } as unknown as SaveApi;
  return { api, calls };
}

const profile = { id: "p3", revision: 3 };
const ok = (data: unknown) => ({ ok: true, data });
const refused = (status: number) => ({
  ok: false,
  error: { kind: "problem", problem: { status } },
});
const input = (previous: unknown = null) => ({
  organizationId: "org",
  repository: { id: "r", defaultBranch: "main", version: 4 },
  previous: previous as never,
  revision: 3,
  branches: ["main", "release/*"],
  folder: "",
  createKey: "create-key",
  useKey: (id: string, version: number) => `use-${id}-${version}`,
});

Deno.test("a version the server put in use itself is not put in use again", async () => {
  const { api, calls } = fake({
    create: ok(profile),
    read: ok({ id: "r", version: 2, activeProfileId: "p3" }),
  });
  const result = await saveWorkingSettings(api, input());
  assertEquals(result.ok && result.putInUseBy, "server");
  assertEquals(calls.map((call) => call.name), ["create", "read"]);
});

Deno.test("otherwise the page puts it in use with the version it has just read", async () => {
  const { api, calls } = fake({
    create: ok(profile),
    read: ok({ id: "r", version: 7, activeProfileId: "p2" }),
    update: ok({}),
  });
  const result = await saveWorkingSettings(api, input());
  assertEquals(result.ok && result.putInUseBy, "page");
  assertEquals(calls.map((call) => call.name), ["create", "read", "update"]);
  assertEquals(calls[2].options.ifMatch, '"v7"');
  assertEquals(calls[2].options.input, { activeProfileId: "p3" });
  assertEquals(calls[2].options.idempotencyKey, "use-p3-7");
});

Deno.test("the new version keeps what else the version in use holds and works from the default branch", async () => {
  const { api, calls } = fake({
    create: ok(profile),
    read: ok({ id: "r", version: 2, activeProfileId: "p3" }),
  });
  await saveWorkingSettings(
    api,
    input({ config: { agentBindings: { "harness.implement": "a" } } }),
  );
  const sent = calls[0].options.input as {
    revision: number;
    digest: string;
    config: Record<string, unknown>;
  };
  assertEquals(sent.revision, 3);
  assertEquals(sent.config.agentBindings, { "harness.implement": "a" });
  assertEquals(sent.config.branches, {
    base: "main",
    allowedPatterns: ["main", "release/*"],
  });
  assertEquals(calls[0].options.idempotencyKey, "create-key");
  assertEquals(/^[0-9a-f]{64}$/.test(sent.digest), true);
});

Deno.test("a refused create stops there, and says which step", async () => {
  const { api, calls } = fake({ create: refused(428) });
  const result = await saveWorkingSettings(api, input());
  assertEquals(result.ok, false);
  assertEquals(!result.ok && result.step, "create");
  assertEquals(calls.map((call) => call.name), ["create"]);
});

Deno.test("a version saved but not put in use is reported with the version, whichever step failed", async () => {
  const stale = fake({
    create: ok(profile),
    read: ok({ id: "r", version: 2, activeProfileId: "p2" }),
    update: refused(412),
  });
  const first = await saveWorkingSettings(stale.api, input());
  assertEquals(!first.ok && first.step, "use");
  assertEquals(!first.ok && first.step === "use" && first.profile.id, "p3");
  const unread = fake({ create: ok(profile), read: refused(500) });
  const second = await saveWorkingSettings(unread.api, input());
  assertEquals(!second.ok && second.step, "use");
});

const withRules = {
  config: {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["main"] },
    worktree: { root: "." },
    repositoryRules: { entries: [{ ruleKey: "commits.format" }] },
  },
};

Deno.test("over a version that carries rules, the save keeps them: never stated, the repository version as If-Match", async () => {
  const { api, calls } = fake({
    create: ok(profile),
    read: ok({ id: "r", version: 5, activeProfileId: "p3" }),
  });
  const result = await saveWorkingSettings(api, input(withRules));
  assertEquals(result.ok && result.putInUseBy, "server");
  assertEquals(calls.map((call) => call.name), ["create", "read"]);
  const sent = calls[0].options;
  assertEquals(sent.ifMatch, '"v4"');
  const body = sent.input as Record<string, unknown>;
  assertEquals(body.keepRepositoryRules, true);
  assertEquals(
    (body.config as Record<string, unknown>).repositoryRules,
    undefined,
  );
});

Deno.test("over a version without rules, the save says nothing of rules and sends no If-Match", async () => {
  const { api, calls } = fake({
    create: ok(profile),
    read: ok({ id: "r", version: 5, activeProfileId: "p3" }),
  });
  await saveWorkingSettings(
    api,
    input({ config: { schemaVersion: 1, branches: { allowedPatterns: [] } } }),
  );
  assertEquals(calls[0].options.ifMatch, undefined);
  assertEquals(
    (calls[0].options.input as Record<string, unknown>).keepRepositoryRules,
    undefined,
  );
});

Deno.test("a refused save over rules reports the create step and its error", async () => {
  const { api, calls } = fake({ create: refused(412) });
  const result = await saveWorkingSettings(api, input(withRules));
  assertEquals(result.ok, false);
  assertEquals(!result.ok && result.step, "create");
  assertEquals(calls.map((call) => call.name), ["create"]);
});
