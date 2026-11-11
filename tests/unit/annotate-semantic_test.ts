import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildQuestions,
  chunk,
  noteFor,
  renderTable,
  type SemanticAnnotationRow,
  SUBJECTS_PER_REQUEST,
  titleRow,
} from "../../scripts/ci/annotate-semantic.ts";
import {
  askSystemOne,
  TypeSafeUnavailable,
} from "../../scripts/lib/typesafe.ts";

function row(
  overrides: Partial<SemanticAnnotationRow> = {},
): SemanticAnnotationRow {
  return {
    label: "commit abc123",
    subject: "feat: add useful behavior",
    regexValid: true,
    wellFormedProbability: 0.5,
    describesLevel: "names the area",
    describesConfidence: 0.5,
    ...overrides,
  };
}

Deno.test("noteFor explains regex/model disagreement at the 0.7 boundary", () => {
  assertEquals(
    noteFor(row({ regexValid: false, wellFormedProbability: 0.7 })),
    "regex rejected but reads as conventional — check spacing/casing",
  );
  assertEquals(
    noteFor(row({ regexValid: false, wellFormedProbability: 0.6999 })),
    "not a Conventional Commit subject",
  );
});

Deno.test("noteFor states the length overflow deterministically before any model note", () => {
  const subject = `feat(auth): ${"x".repeat(61)}`;
  assertEquals(subject.length, 73);
  assertEquals(
    noteFor(row({ subject, regexValid: false, wellFormedProbability: 0.95 })),
    "73 characters, over 72",
  );
  assertEquals(
    noteFor(
      row({
        subject: subject.slice(0, 72),
        regexValid: true,
        wellFormedProbability: 0.95,
      }),
    ),
    "",
  );
});

Deno.test("titleRow applies the squash-aware predicate and length note", () => {
  const title = `feat: ${"x".repeat(60)}`;
  assertEquals(title.length, 66);
  const tooLong = titleRow(title, 207);
  assertEquals(tooLong.regexValid, false);
  assertEquals(
    noteFor(
      row({
        label: tooLong.label,
        subject: tooLong.text,
        regexValid: tooLong.regexValid,
        noteLength: tooLong.noteLength,
      }),
    ),
    "73 characters, over 72 once squashed",
  );

  const fits = titleRow(title, 9);
  assertEquals(fits.regexValid, true);
  assertEquals(
    noteFor(
      row({
        label: fits.label,
        subject: fits.text,
        regexValid: fits.regexValid,
        noteLength: fits.noteLength,
      }),
    ),
    "",
  );
});

Deno.test("noteFor flags a confident vague valid subject at 0.6", () => {
  assertEquals(
    noteFor(
      row({
        describesLevel: "vague",
        describesConfidence: 0.6,
      }),
    ),
    "vague subject: say what changed",
  );
  assertEquals(
    noteFor(
      row({
        describesLevel: "vague",
        describesConfidence: 0.5999,
      }),
    ),
    "",
  );
});

Deno.test("buildQuestions creates two path-specific questions per subject", () => {
  const questions = buildQuestions([
    { text: "feat: add the first behavior" },
    { text: "chore: update dependencies" },
  ]);
  assertEquals(Object.keys(questions), ["wf_0", "desc_0", "wf_1", "desc_1"]);
  assert(
    String(questions.wf_0.instructions).includes("subjects[0].text"),
  );
  assert(
    String(questions.desc_0.instructions).includes("subjects[0].text"),
  );
  assert(
    String(questions.wf_1.instructions).includes("subjects[1].text"),
  );
  assert(
    String(questions.desc_1.instructions).includes("subjects[1].text"),
  );
});

Deno.test("renderTable hardens hostile subject cells", () => {
  const subject = "feat: add | path\\\r\r# Forged\nnext";
  const rendered = renderTable([row({ subject })]);
  const dataRows = rendered.split("\n").filter((line) =>
    line.startsWith("| ") &&
    !line.startsWith("| subject ") &&
    !line.startsWith("| ---")
  );
  assertEquals(dataRows.length, 1);
  assert(!rendered.includes("\r"));
  assert(dataRows[0].includes("| feat: add \\| path\\\\ # Forged next |"));
});

Deno.test("askSystemOne rejects every malformed response shape as malformed response", async () => {
  const usage = { input_tokens: 10, output_tokens: 2 };
  const questions = {
    q: { type: "noul" as const, instructions: "Is `subject` urgent?" },
  };
  const bodies: Record<string, unknown> = {
    "not an object": [],
    "no answers": { model: "jev-latest", usage },
    "missing answer id": { model: "jev-latest", answers: {}, usage },
    "extra answer id": {
      model: "jev-latest",
      answers: {
        q: { type: "noul", noul: 0.5 },
        extra: { type: "noul", noul: 0.5 },
      },
      usage,
    },
    "noul as string": {
      model: "jev-latest",
      answers: { q: { type: "noul", noul: "0.5" } },
      usage,
    },
    "noul above 1": {
      model: "jev-latest",
      answers: { q: { type: "noul", noul: 1.2 } },
      usage,
    },
    "choice without confidence": {
      model: "jev-latest",
      answers: { q: { type: "choice", choice: "a", probabilities: { a: 1 } } },
      usage,
    },
    "probabilities as array": {
      model: "jev-latest",
      answers: {
        q: { type: "choice", choice: "a", probabilities: [1], confidence: 1 },
      },
      usage,
    },
    "score without legend": {
      model: "jev-latest",
      answers: {
        q: {
          type: "score",
          score: 1,
          probabilities: { "0": 1 },
          confidence: 1,
        },
      },
      usage,
    },
    "fractional usage": {
      model: "jev-latest",
      answers: { q: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1.5, output_tokens: 2 },
    },
  };
  for (const [name, body] of Object.entries(bodies)) {
    const error = await assertRejects(
      () =>
        askSystemOne({ state: "subject", questions }, {
          apiKey: "test-key",
          fetch: () =>
            Promise.resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
        }),
      TypeSafeUnavailable,
      undefined,
      name,
    );
    assertEquals(error.message, "malformed response", name);
  }

  const parsed = await askSystemOne({ state: "subject", questions }, {
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: { q: { type: "noul", noul: 0.25 } },
            usage,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });
  assertEquals(parsed.answers.q, { type: "noul", noul: 0.25 });
  assertEquals(parsed.usage, usage);
});

Deno.test("askSystemOne retries one rate-limit response and parses the answer", async () => {
  let calls = 0;
  const response = await askSystemOne(
    {
      state: "subject",
      questions: {
        urgent: { type: "noul", instructions: "Is this urgent?" },
      },
    },
    {
      apiKey: "test-key",
      fetch: () => {
        calls++;
        if (calls === 1) {
          return Promise.resolve(new Response("busy", { status: 429 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: "jev-latest",
              answers: { urgent: { type: "noul", noul: 0.91 } },
              usage: { input_tokens: 11, output_tokens: 4 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      },
    },
  );
  assertEquals(calls, 2);
  assertEquals(response.answers.urgent, { type: "noul", noul: 0.91 });
});

Deno.test("askSystemOne retries a transient 503 once but not a second time", async () => {
  const ok = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: { q: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const request = {
    state: "s",
    questions: { q: { type: "noul" as const, instructions: "x" } },
  };
  let calls = 0;
  const recovered = await askSystemOne(request, {
    apiKey: "test-key",
    fetch: () =>
      ++calls === 1 ? Promise.resolve(new Response("", { status: 503 })) : ok(),
  });
  assertEquals(calls, 2);
  assertEquals(recovered.answers.q, { type: "noul", noul: 0.5 });

  const persistent = await assertRejects(
    () =>
      askSystemOne(request, {
        apiKey: "test-key",
        fetch: () => Promise.resolve(new Response("", { status: 503 })),
      }),
    TypeSafeUnavailable,
  );
  assertEquals(persistent.message, "http 503");
});

Deno.test("renderTable reports token usage when the run supplies it", () => {
  const withUsage = renderTable([row()], {
    inputTokens: 1200,
    outputTokens: 80,
    requestCount: 2,
  });
  assert(
    withUsage.endsWith(
      "TypeSafe usage: 1200 input tokens, 80 output tokens across 2 requests.",
    ),
  );
  assertEquals(renderTable([row()]).includes("TypeSafe usage"), false);
});

Deno.test("askSystemOne redacts API keys from HTTP and transport errors", async () => {
  const apiKey = "SYNTHETIC_CANARY_KEY";
  const httpError = await assertRejects(
    () =>
      askSystemOne(
        { state: "subject", questions: {} },
        {
          apiKey,
          fetch: () =>
            Promise.resolve(
              new Response(`invalid Authorization: Bearer ${apiKey}`, {
                status: 401,
              }),
            ),
        },
      ),
    TypeSafeUnavailable,
  );
  assert(!httpError.message.includes(apiKey));

  const transportError = await assertRejects(
    () =>
      askSystemOne(
        { state: "subject", questions: {} },
        {
          apiKey,
          fetch: () => Promise.reject(new Error(`transport ${apiKey}`)),
        },
      ),
    TypeSafeUnavailable,
  );
  assert(!transportError.message.includes(apiKey));
});

Deno.test("chunk splits subjects into full batches plus a remainder", () => {
  const items = Array.from({ length: 45 }, (_, index) => index);
  const batches = chunk(items, SUBJECTS_PER_REQUEST);
  assertEquals(batches.map((batch) => batch.length), [20, 20, 5]);
  assertEquals(batches.flat(), items);
  assertEquals(chunk([], SUBJECTS_PER_REQUEST), []);
});
