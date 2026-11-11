import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
const {
  buildDesignCase,
  closeServer,
  computeSourceIdentity,
  designReferenceUrl,
  fontDigests,
  lookupArtboard,
  readDesignManifest,
  renderDesignReference,
  resolveSourceProfile,
} = await import(
  new URL("../scripts/render-paper-references.mjs", import.meta.url).href
);
const {
  comparisonStatus,
  designCompatibilityIssues,
  designReferenceInputs,
  repositoryBaselineProvenance,
  sourceDigestIssues,
} = await import(new URL("../scripts/compare-paper.mjs", import.meta.url).href);
const { comparePngs } = await import(
  new URL("../scripts/image-score.mjs", import.meta.url).href
);
import { workerReadinessMarkup } from "../scripts/worker-readiness-reference.mjs";
const { paperBrowserLaunchOptions, withPaperBrowser } = await import(
  new URL("../scripts/paper-browser-profile.mjs", import.meta.url).href
);
const { captureDesignCase, designCaptureMetadata } = await import(
  new URL("../scripts/capture-stories.mjs", import.meta.url).href
);
const directory = "docs/technical-design/worker-readiness";
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const baseline = await json(
  "docs/technical-design/ui-baselines/paper-baselines.json",
);
const profile = await json(`${directory}/source-profile.json`);
const manifest = await json(`${directory}/paper-manifest.json`);
const selected = { sourceProfile: "K-0" };
const mixed = { ...baseline, sourceProfiles: { "K-0": profile } };

test("optional K-0 preserves V-0 bytes, digest, URL, lookup, selectors, inputs and threshold", async () => {
  const before = JSON.stringify(baseline);
  const original = baseline.cases.find((entry) => entry.reference === "design");
  const identity = await computeSourceIdentity(baseline);
  const inputs = [...designReferenceInputs(baseline)];
  const artboards = await readDesignManifest();
  resolveSourceProfile(mixed, selected);
  assert.equal(JSON.stringify(baseline), before);
  assert.deepEqual(await computeSourceIdentity(mixed), identity);
  assert.equal(
    identity.digest,
    "a6978501f470309914eb5865790937c7dff9db7f1bb94f21c8cc80db8013d449",
  );
  assert.deepEqual(resolveSourceProfile(mixed), resolveSourceProfile(baseline));
  assert.deepEqual(resolveSourceProfile(mixed).render, {
    entryPath: "auth-mocks/index.html",
    mountSelector: "#app",
    readyGlobal: "bakeryAuthReady",
    imageSelector: "#app img",
  });
  assert.equal(
    designReferenceUrl("http://localhost", mixed, original),
    designReferenceUrl("http://localhost", baseline, original),
  );
  assert.deepEqual(
    lookupArtboard(artboards, original.design, mixed),
    lookupArtboard(artboards, original.design),
  );
  assert.deepEqual([...designReferenceInputs(mixed)], inputs);
  assert.equal(comparisonStatus(0.95), "passed");
  assert.equal(comparisonStatus(0.949999), "failed");
});

test("K-0 binds exact inputs, fonts and per-case source without V-0 fallback", async () => {
  assert.equal(
    (await computeSourceIdentity(mixed, selected)).digest,
    profile.source.digest,
  );
  const frame = manifest.screens[0];
  const designCase = buildDesignCase(mixed, manifest, {
    ...selected,
    screen: frame.id,
    state: frame.state,
    theme: frame.theme,
    device: frame.device,
    route: "/fixture",
    session: "anonymous",
  });
  const metadata = await designCaptureMetadata(mixed, designCase, {
    fontDigests: { unrelated: "default" },
  });
  assert.deepEqual(metadata.fontDigests, await fontDigests(mixed, selected));
  assert.equal(metadata.sourceDigest, profile.source.digest);
  await assert.rejects(
    designCaptureMetadata(mixed, { ...designCase, sourceDigest: "stale" }, {}),
    /source.digest mismatch/,
  );
  assert.deepEqual(await designCaptureMetadata(mixed, {}, { default: true }), {
    default: true,
  });
  assert.equal(designCase.pageId, "K-0");
  assert.equal(designCase.frameId, "8SD-0");
  assert.equal(
    designReferenceUrl("http://localhost", mixed, designCase),
    "http://localhost/worker-readiness/index.html?screen=1&theme=light#list",
  );
  const withCase = { ...mixed, cases: [...mixed.cases, designCase] };
  assert.deepEqual(await sourceDigestIssues(withCase), []);
  for (const input of profile.source.inputs) {
    assert.ok(designReferenceInputs(withCase).has(input));
  }
  assert.equal(Object.keys(await fontDigests(mixed, selected)).length, 6);
  for (const input of manifest.inputs) {
    const bytes = await readFile(`${directory}/${input.path}`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      input.sha256,
      input.path,
    );
  }
  assert.throws(
    () => resolveSourceProfile({ ...baseline, sourceProfiles: {} }, selected),
    /Unknown Paper source profile/,
  );
  assert.throws(
    () => resolveSourceProfile(mixed, { sourceProfile: "V-0" }),
    /Unknown Paper source profile/,
  );
  assert.throws(
    () =>
      lookupArtboard(awaitlessManifest(), designCase.design, mixed, selected),
    /mismatch/,
  );
  const missing = structuredClone(withCase);
  missing.sourceProfiles["K-0"].source.inputs.push(`${directory}/not-admitted`);
  await assert.rejects(computeSourceIdentity(missing, selected), /ENOENT/);
  assert.match((await sourceDigestIssues(missing)).join("\n"), /ENOENT/);
  const invalid = structuredClone(mixed);
  invalid.sourceProfiles["K-0"].render.readyGlobal = "bakeryAuthReady";
  assert.throws(() => resolveSourceProfile(invalid, selected), /Invalid K-0/);
  await assert.rejects(
    workerReadinessMarkup(directory, "96H-0"),
    /Unknown K-0 frame/,
  );
  const html = await workerReadinessMarkup(directory, "8SD-0");
  assert.ok(html.includes("--font-sans:Geist"));
  assert.ok(html.includes("--text-14:14px"));
  assert.ok(html.includes("--container-sidebar:208px"));
  assert.ok(html.includes("--container-inspector:320px"));
  assert.ok(html.includes("--font-weight-regular:400;"));
});
function awaitlessManifest() {
  return { ...manifest, pageId: "V-0" };
}

test("profile provenance binds actual original bytes and earliest Git appearance", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "paper-provenance-"));
  const baselinePath =
    "docs/technical-design/ui-baselines/paper-baselines.json";
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = async (path, bytes) => {
    await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
    await writeFile(join(repositoryRoot, path), bytes);
  };
  const store = (value) =>
    write(baselinePath, JSON.stringify(value, null, 2) + "\n");
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "test: provenance fixture");
    return git("rev-parse", "HEAD");
  };
  const legacy = {
    ...baseline,
    cases: [baseline.cases.find((entry) => entry.sourceProfile === undefined)],
  };
  delete legacy.sourceProfiles;
  const candidate = {
    ...legacy,
    sourceProfiles: baseline.sourceProfiles,
    cases: [
      ...legacy.cases,
      ...baseline.cases.filter((entry) => entry.sourceProfile === "K-0"),
    ],
  };
  let base;
  const result = (comparisonRef = base) =>
    repositoryBaselineProvenance({ repositoryRoot, comparisonRef });
  const blocked = (expected) => {
    const observed = result();
    assert.equal(observed.status, "blocked", JSON.stringify(observed));
    assert.match(observed.issues.join("\n"), expected);
  };
  const reset = async () => {
    // This disposable repository owns all paths, including restored files that
    // became untracked in the preceding missing-history negative.
    git("reset", "--hard", base);
    await store(candidate);
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Provenance Test");
    git("config", "user.email", "provenance@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (
      const path of new Set([
        ...profile.source.inputs,
        legacy.cases[0].imagePath,
        "docs/technical-design/ui-baselines/runtime-cases.json",
        "docs/technical-design/ui-baselines/components.json",
      ])
    ) {
      await write(path, await readFile(path));
    }
    await store(legacy);
    base = commit();
    await t.test("real twelve-frame introduction stays introduced throughout its branch", async () => {
      await reset();
      assert.equal(candidate.cases.length - legacy.cases.length, 12);
      assert.deepEqual(result().profiles, {
        legacy: "passed",
        "K-0": "introduced",
      });
      const first = commit();
      assert.equal(result().status, "introduced");
      git("commit", "--allow-empty", "-m", "test: unrelated branch change");
      assert.equal(result().profiles["K-0"], "introduced");
      assert.equal(result(first).profiles["K-0"], "passed");
    });
    await t.test("addition of an otherwise valid registered case cannot renew inventory", async () => {
      await reset();
      const first = structuredClone(candidate);
      first.cases.pop();
      await store(first);
      commit();
      await store(candidate);
      blocked(/inventory/);
    });
    const mutations = [
      ["deletion", (value) => value.cases.pop(), /inventory/],
      [
        "metadata",
        (value) =>
          value.cases.at(-1).pointer = value.cases.at(-1).pointer === "coarse"
            ? "fine"
            : "coarse",
        /inventory/,
      ],
      [
        "revision churn",
        (value) => value.sourceProfiles["K-0"].source.revision += "; changed",
        /metadata/,
      ],
      [
        "digest churn",
        (value) => value.sourceProfiles["K-0"].source.digest = "e".repeat(64),
        /metadata/,
      ],
      ["V0 refresh bypass", (value) => {
        value.source.revision = "fake";
        value.source.digest = "e".repeat(64);
        value.cases.pop();
      }, /V0/],
      ["settings", (value) => value.reference.hidden.push("body"), /V0/],
      [
        "case migration",
        (value) => value.cases[0].sourceProfile = "K-0",
        /metadata|V0/,
      ],
    ];
    for (const [name, mutate, expected] of mutations) {
      await t.test(name, async () => {
        await reset();
        commit();
        const changed = structuredClone(candidate);
        mutate(changed);
        assert.notDeepEqual(changed, candidate);
        await store(changed);
        blocked(expected);
      });
    }
    await t.test("earliest malformed declaration cannot be skipped", async () => {
      await reset();
      const bad = structuredClone(candidate);
      bad.sourceProfiles["K-0"].source.inputs = [];
      await store(bad);
      commit();
      await store(candidate);
      blocked(/Invalid K-0/);
    });
    await t.test("earliest dangling case reference cannot be skipped", async () => {
      await reset();
      const bad = structuredClone(candidate);
      delete bad.sourceProfiles;
      await store(bad);
      commit();
      await store(candidate);
      blocked(/dangling/);
    });
    await t.test("unreadable first manifest cannot be skipped", async () => {
      await reset();
      await write(baselinePath, "{");
      commit();
      await store(candidate);
      blocked(/JSON|property|position/i);
    });
    await t.test("missing historical original cannot use today's replacement", async () => {
      await reset();
      await rm(join(repositoryRoot, `${directory}/${manifest.inputs[0].path}`));
      commit();
      await write(
        `${directory}/${manifest.inputs[0].path}`,
        await readFile(`${directory}/${manifest.inputs[0].path}`),
      );
      blocked(/git show/);
    });
    await t.test("missing historical catalog cannot use today's registry", async () => {
      await reset();
      const path = "docs/technical-design/ui-baselines/runtime-cases.json";
      await rm(join(repositoryRoot, path));
      commit();
      await write(path, await readFile(path));
      blocked(/git show/);
    });
    await t.test("identity A-B-A never finds a later convenient match", async () => {
      await reset();
      commit();
      const exportPath = profile.source.manifestPath;
      await write(exportPath, (await readFile(exportPath, "utf8")) + "\n");
      commit();
      await write(exportPath, await readFile(exportPath));
      blocked(/export identity changed/);
    });
    for (const changedSha of [false, true]) {
      await t.test(`alias cannot license export (changed SHA ${changedSha})`, async () => {
        await reset();
        commit();
        const changed = structuredClone(candidate);
        changed.sourceProfiles.alias = structuredClone(profile);
        if (changedSha) {
          await write(
            profile.source.manifestPath,
            (await readFile(profile.source.manifestPath, "utf8")) + "\n",
          );
        }
        await store(changed);
        blocked(/already owned/);
      });
    }
    await t.test("two aliases in first appearance cannot share a page", async () => {
      await reset();
      const changed = structuredClone(candidate);
      changed.sourceProfiles.alias = profile;
      await store(changed);
      blocked(/already owned/);
    });
    await t.test("deletion and reappearance do not reset ownership", async () => {
      await reset();
      commit();
      await store(legacy);
      commit();
      await store(candidate);
      blocked(/removed or renamed/);
    });
    await t.test("renderer churn cannot mint an extra case", async () => {
      await reset();
      const first = structuredClone(candidate);
      first.cases.pop();
      await store(first);
      commit();
      await write(
        "packages/ui/scripts/worker-readiness-reference.mjs",
        "// changed implementation\n",
      );
      await store(candidate);
      blocked(/inventory/);
    });
    await t.test("original React-CSS bytes and frame IDs stay pinned", async () => {
      await reset();
      await write(
        `${directory}/${manifest.screens[0].sourcePath}`,
        "not an original export",
      );
      blocked(/digest mismatch/);
      await reset();
      const changed = structuredClone(candidate);
      changed.cases.at(-1).frameId = "invented";
      await store(changed);
      blocked(/unknown original frame|registered runtime\/catalog binding/);
    });
    await t.test("wrong original bindings and spoofed revision never introduce a profile", async () => {
      const mutations = [
        (value) => value.cases.at(-1).imageSha256 = "e".repeat(64),
        (value) => value.cases.at(-1).artboard.width += 1,
        (value) => value.cases.at(-1).fontDigests = {},
        (value) => value.sourceProfiles["K-0"].render.readyGlobal = "wrong",
        (value) =>
          value.sourceProfiles["K-0"].source.revision =
            "paper:00000000; mock:00000000; rendered:2026-10-06",
        (value) => value.sourceProfiles["K-0"].source.fileId = "wrong",
      ];
      for (const mutate of mutations) {
        await reset();
        const changed = structuredClone(candidate);
        mutate(changed);
        await store(changed);
        blocked(
          /binding|Invalid K-0|identity mismatch/,
        );
      }
    });
    await t.test("raw V0 object bytes and reference bytes are frozen", async () => {
      await reset();
      await write(baselinePath, JSON.stringify(candidate, null, 4));
      blocked(/V0/);
      await reset();
      await write(legacy.cases[0].imagePath, "changed reference");
      blocked(/reference bytes/);
    });
    await t.test("duplicate or null profiles cannot disappear in JSON parsing", async () => {
      await reset();
      const text = JSON.stringify(candidate, null, 2);
      await write(
        baselinePath,
        text.replace(
          '"sourceProfiles":',
          '"sourceProfiles": {}, "sourceProfiles":',
        ),
      );
      blocked(/Duplicate JSON key/);
      await store({ ...candidate, sourceProfiles: null });
      blocked(/Malformed source profiles/);
    });
    await t.test("invalid base, shallow history and incomparable first appearances block", async () => {
      await reset();
      assert.equal(result("missing-base").status, "blocked");
      await write(".git/shallow", base + "\n");
      blocked(/shallow/);
      await rm(join(repositoryRoot, ".git/shallow"));
      const left = commit();
      git("checkout", "--detach", base);
      await store(candidate);
      git("commit", "--allow-empty", "-m", "test: right branch");
      const right = commit();
      git("checkout", "--detach", left);
      git(
        "merge",
        "--no-ff",
        right,
        "-m",
        "test: join independently introduced profiles",
      );
      blocked(/ambiguous first profile/);
    });
    await t.test("whole-manifest absence must be Git-proven", async () => {
      await reset();
      await rm(join(repositoryRoot, baselinePath));
      const absent = commit();
      await store(legacy);
      assert.equal(result(absent).status, "introduced");
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("merge-based branches follow their own main lineage", async (t) => {
  const baselinePath =
    "docs/technical-design/ui-baselines/paper-baselines.json";
  const legacy = {
    ...baseline,
    cases: [baseline.cases.find((entry) => entry.sourceProfile === undefined)],
  };
  delete legacy.sourceProfiles;
  const candidate = {
    ...legacy,
    sourceProfiles: baseline.sourceProfiles,
    cases: [
      ...legacy.cases,
      ...baseline.cases.filter((entry) => entry.sourceProfile === "K-0"),
    ],
  };
  const flipped = structuredClone(candidate);
  flipped.cases.at(-1).pointer = flipped.cases.at(-1).pointer === "coarse"
    ? "fine"
    : "coarse";
  // Each scenario owns a disposable repository whose `main` stands for
  // origin/main, so branch snapshots can predate a merge of newer main.
  const scenario = async (name, body) =>
    await t.test(name, async () => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), "paper-lineage-"));
      const git = (...args) =>
        execFileSync("git", args, {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      const write = async (path, bytes) => {
        await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
        await writeFile(join(repositoryRoot, path), bytes);
      };
      const store = (value) =>
        write(baselinePath, JSON.stringify(value, null, 2) + "\n");
      const commit = (message = "test: lineage fixture") => {
        git("add", ".");
        git("commit", "-m", message);
        return git("rev-parse", "HEAD");
      };
      const result = () =>
        repositoryBaselineProvenance({ repositoryRoot, comparisonRef: "main" });
      const blocked = (expected) => {
        const observed = result();
        assert.equal(observed.status, "blocked", JSON.stringify(observed));
        assert.match(observed.issues.join("\n"), expected);
      };
      try {
        git("init", "-q", "-b", "main");
        git("config", "user.name", "Provenance Test");
        git("config", "user.email", "provenance@example.invalid");
        git("config", "commit.gpgsign", "false");
        for (
          const path of new Set([
            ...profile.source.inputs,
            legacy.cases[0].imagePath,
            "docs/technical-design/ui-baselines/runtime-cases.json",
            "docs/technical-design/ui-baselines/components.json",
          ])
        ) {
          await write(path, await readFile(path));
        }
        await body({ git, write, store, commit, result, blocked });
      } finally {
        await rm(repositoryRoot, { recursive: true, force: true });
      }
    });
  const branch = (git) => git("checkout", "-q", "-b", "feature");
  const mergeMain = (git, ...flags) =>
    git("merge", "--no-ff", "-m", "test: merge main", ...flags, "main");
  const advanceMain = async ({ git, write, store, commit }, value) => {
    git("checkout", "-q", "main");
    if (value) await store(value);
    else await write("main-note.txt", "main moved\n");
    commit("test: main moves");
    git("checkout", "-q", "feature");
  };

  await scenario(
    "profile introduced on main after the branch started",
    async (c) => {
      await c.store(legacy);
      c.commit();
      branch(c.git);
      await c.write("branch-note.txt", "branch work\n");
      c.commit();
      await advanceMain(c, candidate);
      mergeMain(c.git);
      assert.deepEqual(c.result().profiles, {
        legacy: "passed",
        "K-0": "passed",
      });
      assert.equal(c.result().status, "passed");
    },
  );
  await scenario(
    "profile already on main when the branch started",
    async (c) => {
      await c.store(candidate);
      c.commit();
      branch(c.git);
      await c.write("branch-note.txt", "branch work\n");
      c.commit();
      await advanceMain(c);
      mergeMain(c.git);
      assert.equal(c.result().status, "passed");
    },
  );
  await scenario(
    "main bytes win over a conflicting in-branch introduction",
    async (c) => {
      await c.store(legacy);
      c.commit();
      branch(c.git);
      await c.store(flipped);
      c.commit();
      await advanceMain(c, candidate);
      mergeMain(c.git, "-X", "theirs");
      assert.equal(c.result().status, "passed", JSON.stringify(c.result()));
    },
  );
  await scenario(
    "in-branch introduction survives a main merge and stays frozen",
    async (c) => {
      await c.store(legacy);
      c.commit();
      branch(c.git);
      await c.store(candidate);
      c.commit();
      await advanceMain(c);
      mergeMain(c.git);
      assert.equal(c.result().status, "introduced");
      await c.store(flipped);
      c.blocked(/inventory/);
    },
  );
  await scenario(
    "pre-merge tamper reverted before the merge still blocks",
    async (c) => {
      await c.store(candidate);
      c.commit();
      branch(c.git);
      await c.store(flipped);
      c.commit();
      await c.store(candidate);
      c.commit();
      await advanceMain(c);
      mergeMain(c.git);
      c.blocked(/inventory/);
    },
  );
  await scenario("pre-merge profile removal still blocks", async (c) => {
    await c.store(candidate);
    c.commit();
    branch(c.git);
    await c.store(legacy);
    c.commit();
    await c.store(candidate);
    c.commit();
    await advanceMain(c);
    mergeMain(c.git);
    c.blocked(/removed or renamed/);
  });
  await scenario("tamper after the merge blocks", async (c) => {
    await c.store(candidate);
    c.commit();
    branch(c.git);
    await c.write("branch-note.txt", "branch work\n");
    c.commit();
    await advanceMain(c);
    mergeMain(c.git);
    assert.equal(c.result().status, "passed");
    await c.store(flipped);
    c.blocked(/inventory/);
    c.commit();
    c.blocked(/inventory/);
  });
  await scenario(
    "linear branch keeps first-introduction freezing",
    async (c) => {
      await c.store(legacy);
      c.commit();
      branch(c.git);
      await c.store(candidate);
      c.commit();
      assert.equal(c.result().status, "introduced");
      await c.store(flipped);
      c.blocked(/inventory/);
    },
  );
});

test("V-0 refresh under profiles is bound to the refreshed V-0 input bytes", async (t) => {
  const baselinePath =
    "docs/technical-design/ui-baselines/paper-baselines.json";
  const authScript = "docs/technical-design/auth-mocks/auth.js";
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const legacy = {
    ...baseline,
    cases: [baseline.cases.find((entry) => entry.sourceProfile === undefined)],
  };
  delete legacy.sourceProfiles;
  const candidate = {
    ...legacy,
    sourceProfiles: baseline.sourceProfiles,
    cases: [
      ...legacy.cases,
      ...baseline.cases.filter((entry) => entry.sourceProfile === "K-0"),
    ],
  };
  // The helper restates the V-0 digest function so a fixture can stand in for
  // the repository; it must reproduce the committed V-0 identity exactly.
  const v0Identity = async (read, source = baseline.source) => {
    const parts = [];
    for (const input of source.inputs) {
      parts.push(`${input}\0${sha(await read(input))}\n`);
    }
    const digest = sha(parts.join(""));
    return {
      digest,
      revision: `paper:${
        sha(await read(source.manifestPath)).slice(0, 8)
      }; mock:${digest.slice(0, 8)}; rendered:2026-10-10`,
    };
  };
  const real = await v0Identity((path) => readFile(path));
  assert.equal(real.digest, baseline.source.digest);
  assert.equal(
    real.revision.slice(0, -"2026-10-10".length),
    baseline.source.revision.slice(0, -"2026-09-22".length),
  );
  const flipped = structuredClone(candidate);
  flipped.cases.at(-1).pointer = flipped.cases.at(-1).pointer === "coarse"
    ? "fine"
    : "coarse";
  const scenario = async (name, body) =>
    await t.test(name, async () => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), "paper-refresh-"));
      const git = (...args) =>
        execFileSync("git", args, {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      const write = async (path, bytes) => {
        await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
        await writeFile(join(repositoryRoot, path), bytes);
      };
      const fixtureRead = (path) => readFile(join(repositoryRoot, path));
      const store = (value) =>
        write(baselinePath, JSON.stringify(value, null, 2) + "\n");
      const commit = (message = "test: refresh fixture") => {
        git("add", ".");
        git("commit", "-m", message);
        return git("rev-parse", "HEAD");
      };
      const result = () =>
        repositoryBaselineProvenance({ repositoryRoot, comparisonRef: "main" });
      const blocked = (expected = /V0/) => {
        const observed = result();
        assert.equal(observed.status, "blocked", JSON.stringify(observed));
        assert.match(observed.issues.join("\n"), expected);
      };
      const passes = () => {
        const observed = result();
        assert.equal(observed.status, "passed", JSON.stringify(observed));
      };
      // Edits one V-0 input and returns the manifest carrying the bound
      // identity of the edited input bytes.
      const refresh = async (marker, value = candidate) => {
        await write(
          authScript,
          (await fixtureRead(authScript)).toString() + `\n// ${marker}\n`,
        );
        const next = structuredClone(value);
        Object.assign(next.source, await v0Identity(fixtureRead, next.source));
        return next;
      };
      try {
        git("init", "-q", "-b", "main");
        git("config", "user.name", "Provenance Test");
        git("config", "user.email", "provenance@example.invalid");
        git("config", "commit.gpgsign", "false");
        for (
          const path of new Set([
            ...profile.source.inputs,
            ...baseline.source.inputs,
            legacy.cases[0].imagePath,
            "docs/technical-design/ui-baselines/runtime-cases.json",
            "docs/technical-design/ui-baselines/components.json",
          ])
        ) {
          await write(path, await readFile(path));
        }
        await store(candidate);
        commit();
        git("checkout", "-q", "-b", "feature");
        await body({
          git,
          write,
          store,
          commit,
          result,
          blocked,
          passes,
          refresh,
        });
      } finally {
        await rm(repositoryRoot, { recursive: true, force: true });
      }
    });

  await scenario(
    "genuine input-bound refresh passes and stays frozen",
    async (c) => {
      c.passes();
      const refreshed = await c.refresh("refresh");
      await c.store(refreshed);
      c.passes();
      c.commit();
      c.passes();
      c.git("commit", "--allow-empty", "-m", "test: unrelated change");
      c.passes();
    },
  );
  await scenario(
    "refresh may also change V-0 objects and settings",
    async (c) => {
      const refreshed = await c.refresh("refresh");
      refreshed.reference.hidden.push(".extra");
      await c.store(refreshed);
      c.passes();
      c.commit();
      c.passes();
    },
  );
  await scenario("fake identity with edited inputs blocks", async (c) => {
    await c.refresh("refresh");
    const fake = structuredClone(candidate);
    fake.source.revision = "fake";
    fake.source.digest = "e".repeat(64);
    await c.store(fake);
    c.blocked();
    c.commit();
    c.blocked();
  });
  await scenario(
    "self-declared digest without matching bytes blocks",
    async (c) => {
      const refreshed = await c.refresh("refresh");
      refreshed.source.digest = "e".repeat(64);
      refreshed.source.revision = refreshed.source.revision.replace(
        /mock:[0-9a-f]{8}/,
        "mock:eeeeeeee",
      );
      await c.store(refreshed);
      c.blocked(/does not match the V0 input bytes/);
    },
  );
  await scenario("revision-only change blocks", async (c) => {
    const changed = structuredClone(candidate);
    changed.source.revision += "x";
    await c.store(changed);
    c.blocked(/unchanged from the merge base/);
    const rerendered = structuredClone(candidate);
    rerendered.source.revision = rerendered.source.revision.replace(
      /rendered:.*/,
      "rendered:2026-10-10",
    );
    await c.store(rerendered);
    c.blocked(/unchanged from the merge base/);
  });
  await scenario("digest-only change blocks", async (c) => {
    const refreshed = await c.refresh("refresh");
    refreshed.source.revision = candidate.source.revision;
    await c.store(refreshed);
    c.blocked(/not bound to the V0 input bytes/);
  });
  await scenario("unbound paper prefix blocks", async (c) => {
    const refreshed = await c.refresh("refresh");
    refreshed.source.revision = refreshed.source.revision.replace(
      /^paper:[0-9a-f]{8}/,
      "paper:00000000",
    );
    await c.store(refreshed);
    c.blocked(/not bound to the V0 input bytes/);
  });
  await scenario("later edit under the same identity blocks", async (c) => {
    const refreshed = await c.refresh("refresh");
    await c.store(refreshed);
    c.commit();
    const edited = structuredClone(refreshed);
    edited.reference.hidden.push(".sneaky");
    await c.store(edited);
    c.blocked();
    c.commit();
    c.blocked();
  });
  await scenario("a second refresh blocks", async (c) => {
    const first = await c.refresh("first");
    await c.store(first);
    c.commit();
    const second = await c.refresh("second", first);
    await c.store(second);
    c.blocked(/already exists/);
    c.commit();
    c.blocked(/already exists/);
  });
  await scenario("A to B to A blocks", async (c) => {
    const refreshed = await c.refresh("refresh");
    await c.store(refreshed);
    c.commit();
    c.git("checkout", "-q", "main", "--", ".");
    c.commit("test: back to the merge base");
    c.blocked(/already exists/);
  });
  await scenario(
    "K-0 object change after the refresh still blocks",
    async (c) => {
      const refreshed = await c.refresh("refresh");
      await c.store(refreshed);
      c.commit();
      const tampered = structuredClone(refreshed);
      tampered.cases.at(-1).pointer = flipped.cases.at(-1).pointer;
      await c.store(tampered);
      c.blocked(/inventory/);
    },
  );
  await scenario(
    "K-0 object change inside the refresh commit blocks",
    async (c) => {
      const refreshed = await c.refresh("refresh");
      refreshed.cases.at(-1).pointer = flipped.cases.at(-1).pointer;
      await c.store(refreshed);
      c.blocked(/inventory/);
    },
  );
  await scenario("merging main after the refresh still passes", async (c) => {
    const refreshed = await c.refresh("refresh");
    await c.store(refreshed);
    c.commit();
    c.git("checkout", "-q", "main");
    await c.write("main-note.txt", "main moved\n");
    c.commit("test: main moves");
    c.git("checkout", "-q", "feature");
    c.git("merge", "--no-ff", "-m", "test: merge main", "main");
    c.passes();
    const edited = structuredClone(refreshed);
    edited.reference.hidden.push(".sneaky");
    await c.store(edited);
    c.blocked();
  });
});

test("shared browser boundary emits K-0 flag, isolates V-0 and closes on failure", async () => {
  const defaultBrowser = {};
  let closes = 0;
  const scopedBrowser = {
    close: () => {
      closes += 1;
    },
  };
  const launches = [];
  const launch = (options) => {
    launches.push(options);
    return scopedBrowser;
  };
  assert.deepEqual(paperBrowserLaunchOptions(), { headless: true });
  assert.deepEqual(paperBrowserLaunchOptions(selected), {
    headless: true,
    args: ["--font-render-hinting=none"],
  });
  assert.equal(
    await withPaperBrowser(defaultBrowser, {}, (browser) => browser, launch),
    defaultBrowser,
  );
  assert.equal(launches.length, 0);
  assert.equal(
    await withPaperBrowser(
      defaultBrowser,
      selected,
      (browser) => browser,
      launch,
    ),
    scopedBrowser,
  );
  await assert.rejects(
    withPaperBrowser(defaultBrowser, selected, () => {
      throw new Error("capture failed");
    }, launch),
    /capture failed/,
  );
  assert.equal(closes, 2);
  assert.deepEqual(launches, [
    paperBrowserLaunchOptions(selected),
    paperBrowserLaunchOptions(selected),
  ]);
  assert.throws(
    () => paperBrowserLaunchOptions({ sourceProfile: "unknown" }),
    /Unknown Paper source profile/,
  );
});

test("K-0 compatibility rejects missing or stale raster configuration and source identity", () => {
  const reference = {
    ...selected,
    browserLaunchOptions: paperBrowserLaunchOptions(selected),
    sourceDigest: profile.source.digest,
    rasterProfile: baseline.cases.find((entry) => entry.sourceProfile === "K-0")
      .rasterProfile,
    viewport: {},
    dpr: 1,
    theme: "light",
    pointer: "fine",
    locale: "en-US",
    direction: "ltr",
    fontDigests: {},
    browser: "chromium",
    os: "linux-x64",
  };
  const candidate = {
    ...reference,
    colorScheme: "light",
    browserVersion: "153.0.8010.12",
    playwrightVersion: "1.63.0",
  };
  assert.deepEqual(designCompatibilityIssues(candidate, reference), []);
  for (
    const field of [
      "browserLaunchOptions",
      "sourceDigest",
      "browserVersion",
      "playwrightVersion",
      "rasterProfile",
    ]
  ) {
    const missing = { ...candidate };
    delete missing[field];
    assert.ok(designCompatibilityIssues(missing, reference).length > 0, field);
  }
  assert.ok(
    designCompatibilityIssues({
      ...candidate,
      browserLaunchOptions: { headless: true },
    }, reference).length > 0,
  );
});

test("actual K-0 source renders match all twelve approved full-frame PNGs", {
  skip: !process.env.K0_RENDER_OUTPUT,
}, async () => {
  const output = process.env.K0_RENDER_OUTPUT;
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  const results = [];
  try {
    const page = await browser.newPage();
    for (const frame of manifest.screens) {
      const designCase = buildDesignCase(mixed, manifest, {
        ...selected,
        screen: frame.id,
        state: frame.state,
        theme: frame.theme,
        device: frame.device,
        route: "/fixture",
        session: "anonymous",
      });
      try {
        const rendered = await renderDesignReference(
          browser,
          mixed,
          designCase,
        );
        await writeFile(`${output}/${frame.nodeId}.png`, rendered.bytes);
        const result = await comparePngs(page, {
          candidate: rendered.bytes,
          baseline: await readFile(`${directory}/${frame.imagePath}`),
        });
        results.push({
          frameId: frame.nodeId,
          ...result,
          status: comparisonStatus(result.score),
          browserLaunchOptions: rendered.browserLaunchOptions,
          browserVersion: rendered.browserVersion,
          os: rendered.os,
          sourceDigest: profile.source.digest,
          rasterProfile: rendered.rasterProfile,
          rasterContract: rendered.rasterContract,
          playwrightVersion: rendered.playwrightVersion,
        });
      } catch (error) {
        results.push({ frameId: frame.nodeId, issue: error.message });
      }
    }
    await writeFile(
      `${output}/results.json`,
      JSON.stringify(results, null, 2) + "\n",
    );
    assert.equal(results.length, 12);
    for (const result of results) console.log(JSON.stringify(result));
    const failures = results.filter((result) =>
      result.issue || !(result.score >= 0.95)
    );
    assert.deepEqual(failures, [], JSON.stringify(failures));
  } finally {
    await browser.close();
    await closeServer();
  }
});

// Harness plumbing proof only. This synthetic local route is not enrollment UI.
test("production candidate capture records the same K-0 raster profile", {
  skip: !process.env.K0_RENDER_OUTPUT,
}, async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><style>body{margin:0}#root{min-height:100vh;background:white}</style><div id="root"><main>Capture plumbing probe, not a product fixture</main></div>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const frame = manifest.screens[4];
    const designCase = buildDesignCase(mixed, manifest, {
      ...selected,
      screen: frame.id,
      state: frame.state,
      theme: frame.theme,
      device: frame.device,
      route: "/fixture",
      session: "anonymous",
    });
    const record = await captureDesignCase(
      null,
      `http://127.0.0.1:${server.address().port}`,
      designCase,
      await designCaptureMetadata(mixed, designCase, {
        os: `${process.platform}-${process.arch}`,
        playwrightVersion: JSON.parse(
          await readFile(
            "packages/ui/node_modules/@playwright/test/package.json",
            "utf8",
          ),
        ).version,
      }),
      {
        acquire: () => {
          throw new Error("K-0 must not use the V-0 context pool");
        },
      },
    );
    assert.equal(record.status, "passed");
    assert.deepEqual(
      record.browserLaunchOptions,
      paperBrowserLaunchOptions(selected),
    );
    assert.deepEqual(
      designCompatibilityIssues(record, {
        ...designCase,
        fontDigests: record.fontDigests,
      }),
      [],
    );
    await writeFile(
      `${process.env.K0_RENDER_OUTPUT}/candidate-plumbing.json`,
      JSON.stringify(record, null, 2) + "\n",
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});
