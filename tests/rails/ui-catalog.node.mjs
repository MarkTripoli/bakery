import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createCatalog,
  findComponents,
  getComponent,
  getComposition,
  loadCatalog,
  parseComponentCatalog,
} from "../../packages/ui/catalog/index.ts";

const CATALOG_PATH = new URL(
  "../../docs/technical-design/ui-baselines/components.json",
  import.meta.url,
);
const raw = () => JSON.parse(readFileSync(CATALOG_PATH, "utf8"));

function issuesFor(mutate) {
  const value = raw();
  mutate(value);
  const result = parseComponentCatalog(value);
  assert.equal(result.success, false, "mutated catalog must be rejected");
  return result.issues.join("\n");
}

const entry = (value, id) => value.entries.find((e) => e.id === id);

test("schema accepts the authored catalog", () => {
  const result = parseComponentCatalog(raw());
  assert.deepEqual(result.success ? [] : result.issues, []);
  assert.equal(result.catalog.entries.length, 135);
});

test("every entry carries paper frames or a stated absence reason", () => {
  for (const e of loadCatalog().entries) {
    assert(
      e.paper.length > 0 || e.paperAbsentReason,
      `${e.id} has neither paper frames nor paperAbsentReason`,
    );
  }
});

test("derived tokens are defined in the UI stylesheets", () => {
  const root = new URL("../../packages/ui/src/", import.meta.url);
  const css = readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(new URL(file, root), "utf8"))
    .join("\n");
  for (const e of loadCatalog().entries) {
    for (const token of e.tokens) {
      assert(
        css.includes(`${token}:`),
        `${e.id} uses undefined token ${token}`,
      );
    }
  }
});

test("schema rejects a missing description", () => {
  const text = issuesFor((v) => delete entry(v, "ui.button").description);
  assert.match(text, /entries\.\d+\.description/);
});

test("schema rejects a blank description", () => {
  const text = issuesFor((v) => (entry(v, "ui.button").description = "  "));
  assert.match(text, /entries\.\d+\.description/);
});

test("schema rejects an unknown key", () => {
  const text = issuesFor((v) => (entry(v, "ui.button").guidance = {}));
  assert.match(text, /guidance/);
});

test("schema rejects a dangling alternatives.use", () => {
  const text = issuesFor((v) =>
    entry(v, "ui.button").usage.alternatives.push({
      when: "never",
      use: "ui.doesNotExist",
    })
  );
  assert.match(text, /unknown catalog id ui\.doesNotExist/);
});

test("schema rejects a dangling composition id", () => {
  const requires = issuesFor((v) =>
    v.compositions[0].requires.push({ anyOf: ["ui.nope"] })
  );
  assert.match(
    requires,
    /requires slot lists no existing catalog id \(ui\.nope\)/,
  );
  const forbids = issuesFor((v) => v.compositions[0].forbids.push("ui.nope"));
  assert.match(forbids, /unknown catalog id ui\.nope/);
  const applies = issuesFor((v) => v.compositions[0].appliesTo.push("ui.nope"));
  assert.match(applies, /unknown catalog id ui\.nope/);
});

test("schema allows a forward id only inside requires anyOf", () => {
  // A slot may list a component that ships on a later branch, provided one id
  // of the slot is in the catalog.
  const forward = raw();
  forward.compositions[0].requires.push({ anyOf: ["ui.button", "ui.nope"] });
  const accepted = parseComponentCatalog(forward);
  assert.deepEqual(accepted.success ? [] : accepted.issues, []);
  // A slot of only forward ids is unsatisfiable.
  assert.match(
    issuesFor((v) =>
      v.compositions[0].requires.push({ anyOf: ["ui.nope", "ui.alsoNope"] })
    ),
    /requires\.\d+\.anyOf/,
  );
  // Everywhere else the catalog stays strict.
  assert.match(
    issuesFor((v) => v.compositions[0].forbids.push("ui.nope")),
    /unknown catalog id ui\.nope/,
  );
  assert.match(
    issuesFor((v) => v.compositions[0].appliesTo.push("ui.nope")),
    /unknown catalog id ui\.nope/,
  );
  assert.match(
    issuesFor((v) =>
      entry(v, "ui.button").usage.alternatives.push({
        when: "never",
        use: "ui.nope",
      })
    ),
    /unknown catalog id ui\.nope/,
  );
});

test("schema rejects a duplicate frameId inside one entry", () => {
  const text = issuesFor((v) => {
    const e = entry(v, "ui.button");
    e.paper.push({ ...e.paper[0], name: "again" });
  });
  assert.match(text, /lists Paper frame .* twice/);
});

test("schema requires paperAbsentReason for an empty paper list only", () => {
  assert.match(
    issuesFor((v) => (entry(v, "ui.button").paper = [])),
    /needs paperAbsentReason/,
  );
  assert.match(
    issuesFor((v) => (entry(v, "ui.button").paperAbsentReason = "x")),
    /paperAbsentReason must be omitted/,
  );
});

test("schema rejects allowedLevels below the component level", () => {
  const text = issuesFor((v) =>
    entry(v, "ui.dataTable").usage.allowedLevels.unshift("atom")
  );
  assert.match(text, /atomic levels only depend downward/);
});

test("schema rejects an unknown rule id", () => {
  const text = issuesFor((v) =>
    entry(v, "ui.button").usage.ruleIds.push("nope")
  );
  assert.match(text, /unknown rule id nope/);
});

test("allowedLevels follow the atomic-direction rule for every entry", () => {
  const order = ["atom", "molecule", "organism", "template", "page", "app"];
  for (const e of loadCatalog().entries) {
    for (const level of e.usage.allowedLevels) {
      assert(
        order.indexOf(level) >= order.indexOf(e.level),
        `${e.id} (${e.level}) allows lower consumer ${level}`,
      );
    }
  }
});

test("createCatalog throws with every issue", () => {
  assert.throws(() => createCatalog({}), /invalid component catalog/);
});

test("getComponent and getComposition look up by id", () => {
  const catalog = loadCatalog();
  assert.equal(getComponent("ui.dataTable", catalog)?.name, "DataTable");
  assert.equal(getComponent("ui.missing", catalog), undefined);
  assert.equal(getComposition("work-queue", catalog)?.requires.length, 3);
  assert.equal(getComposition("missing", catalog), undefined);
});

test("findComponents maps a raw element to its component", () => {
  const catalog = loadCatalog();
  assert.deepEqual(
    findComponents({ element: "table" }, catalog).map((m) => m.entry.id),
    ["ui.dataTable"],
  );
  assert.deepEqual(
    findComponents({ element: "a" }, catalog).map((m) => m.entry.id),
    ["ui.link"],
  );
});

test("findComponents ranks a query and honours filters", () => {
  const catalog = loadCatalog();
  const ranked = findComponents({ query: "data table of records" }, catalog);
  assert.equal(ranked[0].entry.id, "ui.dataTable");
  assert(ranked[0].reasons.length > 0);
  const atoms = findComponents({ level: "atom" }, catalog);
  assert(atoms.length > 0 && atoms.every((m) => m.entry.level === "atom"));
  const forAtoms = findComponents({ consumerLevel: "atom" }, catalog);
  assert(forAtoms.every((m) => m.entry.level === "atom"));
  assert.deepEqual(
    findComponents({ query: "zzzz-no-such-thing" }, catalog),
    [],
  );
});

test("findComponents does not mutate the catalog", () => {
  const catalog = loadCatalog();
  const before = JSON.stringify(catalog);
  findComponents({ query: "button", element: "button" }, catalog);
  assert.equal(JSON.stringify(catalog), before);
});
