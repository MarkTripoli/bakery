/**
 * The clobber check's corpus is the real incidents, not synthetic shapes.
 *
 * Each case below is drawn from a pull request that is named in the test, and
 * the lines are the bodies those pull requests actually carried. The clobber
 * check exists because a body edit leaves no trace: no timeline event, no
 * revision content, and the seat attribution is discarded by the checklist
 * rail. These cases are the only record that the edits happened at all.
 */

import { assert, assertEquals } from "@std/assert";
import {
  compareLedger,
  hashClaim,
  parseLedger,
  parseVerdict,
  parseVerifierLines,
  renderLedger,
} from "../../scripts/authoring/clobber-ledger.ts";
import type {
  LedgerEntry,
  Verdict,
} from "../../scripts/authoring/clobber-ledger.ts";

const NOW = "2026-11-18T05:00:00.000Z";

/** Build a ledger entry from a line the previous clean run saw. */
function snapshot(
  line: string,
  extra: Partial<LedgerEntry> = {},
): LedgerEntry {
  const [parsed] = parseVerifierLines(`## Verification\n${line}\n`);
  assert(parsed, `the fixture line must parse: ${line}`);
  return {
    item: parsed.item,
    seat: parsed.seat,
    claimHash: parsed.claimHash,
    sha: "583e043c3",
    firstSeenAt: "2026-11-18T02:00:00.000Z",
    lastSeenAt: "2026-11-18T02:00:00.000Z",
    ...extra,
  };
}

/** Compare one previous line against one current body. */
function compare(
  previous: LedgerEntry[],
  currentLine: string,
  verdicts: Verdict[] = [],
) {
  return compareLedger(
    previous,
    parseVerifierLines(
      `## Verification\n${currentLine}\n`,
    ),
    verdicts,
    NOW,
  );
}

// #568 carried the head inside the attribution. The seat stayed design-ux while
// the head was re-labelled to another commit before that seat had reviewed it,
// which is the shape a seat-change comparison passes silently.
const SHAPE_568_BEFORE =
  "- [x] ui verified (design-ux @ 583e043c3): the bell, ring and popover states match the design comments";
const SHAPE_568_AFTER =
  "- [x] ui verified (design-ux @ 758b95a00): the bell, ring and popover states match the design comments";

Deno.test("a same-seat head re-label with no verdict is flagged (#568)", () => {
  const { errors } = compare([snapshot(SHAPE_568_BEFORE)], SHAPE_568_AFTER);
  assertEquals(errors.length, 1);
  assert(
    errors[0].includes("unowned re-label") || errors[0].includes("no verdict"),
  );
  assert(errors[0].includes("758b95a00"));
});

Deno.test("the same re-label is allowed once that seat posts a verdict at the new head", () => {
  const verdicts: Verdict[] = [
    { seat: "design-ux", sha: "758b95a00", at: "2026-11-18T03:53:45.000Z" },
  ];
  const { errors } = compare(
    [snapshot(SHAPE_568_BEFORE)],
    SHAPE_568_AFTER,
    verdicts,
  );
  assertEquals(errors, []);
});

Deno.test("a verdict from a different seat does not corroborate the change", () => {
  const verdicts: Verdict[] = [
    { seat: "reviewer", sha: "758b95a00", at: "2026-11-18T03:53:45.000Z" },
    { seat: "qa", sha: "758b95a00", at: "2026-11-18T04:02:43.000Z" },
  ];
  const { errors } = compare(
    [snapshot(SHAPE_568_BEFORE)],
    SHAPE_568_AFTER,
    verdicts,
  );
  assertEquals(errors.length, 1);
});

// #569's lines were overwritten by another seat's script: the seat attribution
// changed under a claim the seat never wrote.
Deno.test("a line attributed to a different seat is flagged (#569)", () => {
  const before =
    "- [x] Backend verified (reviewer): confirmed N/A is right and content verified";
  const after =
    "- [x] Backend verified (qa): confirmed N/A is right and content verified";
  const { errors } = compare([snapshot(before)], after);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("written by reviewer"));
  assert(errors[0].includes("now attributed to qa"));
});

Deno.test("a deleted verifier line is flagged (#569)", () => {
  const before =
    "- [x] Implementation clean (reviewer): the fix is the minimal form";
  const { errors } = compareLedger(
    [snapshot(before)],
    parseVerifierLines("## Verification\n"),
    [],
    NOW,
  );
  assertEquals(errors.length, 1);
  assert(errors[0].includes("deleted"));
});

// #567 recorded its own re-issue in the line, and the seat posted the verdict
// that backs it. A seat genuinely revising its own claim is not a clobber.
Deno.test("a re-issued claim with the seat's verdict passes (#567)", () => {
  const before =
    "- [x] tests cover (qa2 @ 96314eb4): the stamped version carried the wrong ring claim";
  const after =
    "- [x] tests cover (qa2 re-issued @ 96314eb4): the test surface is the bell ring states";
  const verdicts: Verdict[] = [
    { seat: "qa", sha: "96314eb4", at: "2026-11-18T04:10:00.000Z" },
  ];
  const { errors } = compare([snapshot(before)], after, verdicts);
  assertEquals(errors, []);
});

Deno.test("an unchanged claim is not a clobber, however often it runs", () => {
  const line =
    "- [x] ui verified (design-ux @ 583e043c3): the bell and ring match the design";
  const { errors, ledger } = compare([snapshot(line)], line);
  assertEquals(errors, []);
  assertEquals(ledger.length, 1);
  // The streak is preserved, so the ledger records when the claim first stood.
  assertEquals(ledger[0].firstSeenAt, "2026-11-18T02:00:00.000Z");
  assertEquals(ledger[0].lastSeenAt, NOW);
});

// #569's UI line is N/A because a two-file prose change has no interface. An
// N/A line needs no verdict; requiring one would flag every honest N/A.
Deno.test("an N/A line that stays N/A is not a clobber", () => {
  const line =
    "- [ ] UI verified (design-ux): N/A: no visible UI at this head, the PR is two XML files";
  const { errors } = compare([snapshot(line)], line);
  assertEquals(errors, []);
});

Deno.test("a new line is recorded, not flagged, so the first sighting is a diff", () => {
  const line =
    "- [x] Backend verified (reviewer): read the three surfaces and the drift check";
  const { errors, ledger } = compareLedger(
    [],
    parseVerifierLines(`## Verification\n${line}\n`),
    [],
    NOW,
  );
  assertEquals(errors, []);
  assertEquals(ledger.length, 1);
  assertEquals(ledger[0].firstSeenAt, NOW);
});

// The first run has no snapshot, so a clobber that happened before it is
// invisible. The design states this limit; the test pins that it stays a
// documented blindness rather than becoming a false promise.
Deno.test("the first run is blind: an unowned attribution alone is not a flag", () => {
  const { errors } = compareLedger(
    [],
    parseVerifierLines(`## Verification\n${SHAPE_568_AFTER}\n`),
    [],
    NOW,
  );
  assertEquals(errors, []);
});

Deno.test("the head inside the attribution is part of the claim hash", () => {
  const before =
    "- [x] ui verified (design-ux @ 583e043c3): the bell and ring match";
  const after =
    "- [x] ui verified (design-ux @ 758b95a00): the bell and ring match";
  const [a] = parseVerifierLines(`## Verification\n${before}\n`);
  const [b] = parseVerifierLines(`## Verification\n${after}\n`);
  assert(a.claimHash !== b.claimHash);
});

// Three orders appear in real bodies; all three must key the same item, or the
// ledger would see a delete plus an add and miss a re-label.
Deno.test("the three real attribution orders key the same item", () => {
  const orders = [
    "- [x] backend verified @ 583e043c3 (reviewer re-stamp): verified by read",
    "- [x] backend verified (reviewer) @ 583e043c3: verified by read",
    "- [x] backend verified (reviewer @ 583e043c3): verified by read",
  ].map((line) => parseVerifierLines(`## Verification\n${line}\n`)[0]);
  for (const parsed of orders) {
    assertEquals(parsed.item, "backend verified");
    assertEquals(parsed.seat, "reviewer");
  }
});

Deno.test("the ledger round-trips through its comment marker", () => {
  const entries = [snapshot(SHAPE_568_BEFORE)];
  const rendered = renderLedger(entries);
  assert(rendered.includes("<!-- bakery-authoring-ledger -->"));
  assertEquals(parseLedger(rendered), entries);
  assertEquals(parseLedger("just a comment"), null);
  assertEquals(parseLedger("<!-- bakery-authoring-ledger -->\nnot json"), null);
});

// Every seat shares one GitHub account, so a verdict's seat is read from the
// prose conventions, never from the comment author.
Deno.test("a verdict's seat and head are read from the prose", () => {
  const qa = parseVerdict(
    "## QA verdict @ 583e043c3 — Approved\n\nall green",
    "2026-11-18T04:02:43.000Z",
  );
  assertEquals(qa?.seat, "qa");
  assertEquals(qa?.sha, "583e043c3");

  const reviewer = parseVerdict(
    "Verdict: Approve\nHead: `758b95a00`\n\n- [Low] something",
    "2026-11-18T03:53:45.000Z",
  );
  assertEquals(reviewer?.seat, "reviewer");
  assertEquals(reviewer?.sha, "758b95a00");

  const ux = parseVerdict(
    "## UX sign-off @ 96314eb4\n\nthe ring matches",
    "2026-11-18T04:10:00.000Z",
  );
  assertEquals(ux?.seat, "design-ux");
  assertEquals(ux?.sha, "96314eb4");

  assertEquals(parseVerdict("just chatting", "2026-11-18T04:10:00.000Z"), null);
});

Deno.test("the claim hash ignores spacing and trailing blanks", () => {
  assertEquals(hashClaim("the bell  and ring"), hashClaim("the bell and ring"));
  assertEquals(hashClaim("the bell"), hashClaim("the bell  \n"));
  assert(hashClaim("the bell") !== hashClaim("the bell and ring"));
});
