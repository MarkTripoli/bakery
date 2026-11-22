import { assertEquals } from "@std/assert";
import {
  AFTER_SINCE,
  automaticPolicy,
  BEFORE_SINCE,
  EXECUTE_LABEL,
  seedLabeler,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  read,
  ticketCall,
} from "../helpers/ticket-admission/operations-http.ts";

/**
 * Issue 61: the preview says how many issues wait only because their request
 * label was there before automatic starts were turned on, so the settings
 * page can say "{n} of them already had the label".
 */

type Preview = {
  counts: {
    wouldStart: number;
    planOnly: number;
    held: number;
    blocked: number;
    labeledBeforeWindow: number;
  };
  issues: { number: number; outcome: string; reasons: string[] }[];
};

Deno.test("issue 61: the preview counts issues held back only by the automatic-start window", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    seedLabeler(fx);
    for (const number of [1, 2, 3, 4]) {
      fx.reader.setIssue({ number, labels: [] });
      fx.facts.set(number, `2026-06-01T00:00:0${number}Z`);
    }
    // 1 and 2 were labeled by an allowlisted writer before the window opened.
    for (const number of [1, 2]) {
      fx.reader.setIssue({ number, labels: [EXECUTE_LABEL] });
      fx.reader.setLabelApplied(number, EXECUTE_LABEL, {
        appliedAt: BEFORE_SINCE,
      });
    }
    // 3 was labeled inside the window: it would start, so it is not counted.
    fx.reader.setIssue({ number: 3, labels: [EXECUTE_LABEL] });
    fx.reader.setLabelApplied(3, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
    // 4 carries no label: blocked for another reason, so it is not counted.

    const preview = await read<Preview>(
      await ticketCall(fx, "POST", `/v1/ticket-sources/${sourceId}/previews`, {
        body: {},
      }),
      201,
    );
    assertEquals(
      preview.issues.map((issue) => [issue.number, issue.outcome]),
      [[1, "blocked"], [2, "blocked"], [3, "would_start"], [4, "blocked"]],
      JSON.stringify(preview.issues),
    );
    assertEquals(preview.issues[0].reasons, ["adoption_required"]);
    assertEquals(preview.counts, {
      wouldStart: 1,
      planOnly: 0,
      held: 0,
      blocked: 3,
      labeledBeforeWindow: 2,
    });
  }, { budget: true }));
