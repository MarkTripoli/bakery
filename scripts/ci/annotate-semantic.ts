import {
  type Answer,
  askSystemOne,
  type NoulAnswer,
  publishStepSummary,
  type Question,
  readTypeSafeApiKey,
  type ScoreAnswer,
  TypeSafeUnavailable,
} from "../lib/typesafe.ts";
import {
  isSemanticCommitSubject,
  isSemanticPullRequestTitle,
  isSemanticTitle,
  listCommitSubjects,
  MAX_SUBJECT_LENGTH,
  SEMANTIC_RULE_TEXT,
} from "./validate-semantic.ts";

// Commit subjects are distinctive strings, so batching is safe; 20 per
// request matched the batch-1 control at 97.5% in the experiments and keeps
// a large PR well inside the model's request budget.
export const SUBJECTS_PER_REQUEST = 20;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export type SemanticSubject = {
  readonly text: string;
};

export type DescribesLevel =
  | "vague"
  | "names the area"
  | "verifiable change";

export type SemanticAnnotationRow = {
  readonly label: string;
  readonly subject: string;
  readonly regexValid: boolean;
  readonly wellFormedProbability: number;
  readonly describesLevel: DescribesLevel;
  readonly describesConfidence: number;
  readonly noteLength?: number;
};

export type SemanticSubjectRow = {
  readonly label: string;
  readonly text: string;
  readonly regexValid: boolean;
  readonly noteLength?: number;
};

export function titleRow(
  title: string,
  pullRequestNumber?: number,
): SemanticSubjectRow {
  return {
    label: "title",
    text: title,
    regexValid: pullRequestNumber === undefined
      ? isSemanticTitle(title)
      : isSemanticPullRequestTitle(title, pullRequestNumber),
    noteLength: pullRequestNumber === undefined
      ? undefined
      : `${title} (#${pullRequestNumber})`.length,
  };
}

export function buildQuestions(
  subjects: readonly SemanticSubject[],
): Record<string, Question> {
  const questions: Record<string, Question> = {};
  subjects.forEach((_, index) => {
    const subjectPath = `subjects[${index}].text`;
    questions[`wf_${index}`] = {
      type: "noul",
      instructions:
        `Is \`${subjectPath}\` a well-formed Conventional Commit subject under \`rules\`?`,
      criteria: {
        true:
          "The subject communicates a valid Conventional Commit form and meaning. Do not judge byte-level details such as exact spacing, casing, or the 72-character limit here; the deterministic regex already decides those rules.",
        false:
          "The subject is a semantic near-miss or does not communicate a well-formed Conventional Commit subject. Do not override the deterministic regex on byte-level spacing, casing, or length rules; this answer explains the semantic reason for a disagreement.",
      },
    };
    questions[`desc_${index}`] = {
      type: "score",
      instructions:
        `How well does the description in \`${subjectPath}\` tell a reviewer what actually changed? Use the complete subject text and judge whether its description is concrete and verifiable, not whether its Conventional Commit punctuation is valid.`,
      criteria: [
        "Vague: does not say what changed, for example 'wip', 'fix stuff', or 'update'.",
        "Names the area: says where or which artefact is involved but not what observable change occurred.",
        "Verifiable change: a reader could check from the diff that the stated change happened.",
      ],
    };
  });
  return questions;
}

export function noteFor(row: SemanticAnnotationRow): string {
  const noteLength = row.noteLength ?? row.subject.length;
  if (!row.regexValid && noteLength > MAX_SUBJECT_LENGTH) {
    return `${noteLength} characters, over ${MAX_SUBJECT_LENGTH}${
      row.noteLength === undefined ? "" : " once squashed"
    }`;
  }
  if (!row.regexValid && row.wellFormedProbability >= 0.7) {
    return "regex rejected but reads as conventional — check spacing/casing";
  }
  if (!row.regexValid) return "not a Conventional Commit subject";
  if (row.describesLevel === "vague" && row.describesConfidence >= 0.6) {
    return "vague subject: say what changed";
  }
  return "";
}

function markdownCell(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, " ");
  const escapedSlashes = normalized.replaceAll("\\", "\\\\");
  return escapedSlashes.replaceAll("|", "\\|");
}

export type SemanticUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requestCount: number;
};

export function renderTable(
  rows: readonly SemanticAnnotationRow[],
  usage?: SemanticUsage,
): string {
  const lines = [
    "### TypeSafe semantic advisory",
    "The regex remains the gate; this annotation is advisory only.",
    "",
    "| subject | regex | p(well-formed) | describes (level, confidence) | note |",
    "| --- | --- | ---: | --- | --- |",
    ...rows.map((row) => {
      const subject = row.label === "title"
        ? `title: ${row.subject}`
        : row.subject;
      const formattedProbability = row.wellFormedProbability.toFixed(2);
      const formattedConfidence = row.describesConfidence.toFixed(2);
      return `| ${markdownCell(subject)} | ${
        row.regexValid ? "pass" : "fail"
      } | ${formattedProbability} | ${
        markdownCell(row.describesLevel)
      } (${formattedConfidence}) | ${markdownCell(noteFor(row))} |`;
    }),
  ];
  if (usage) {
    lines.push(
      "",
      `TypeSafe usage: ${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens across ${usage.requestCount} requests.`,
    );
  }
  return lines.join("\n");
}

function levelForScore(score: number): DescribesLevel {
  if (score < 0.5) return "vague";
  if (score < 1.5) return "names the area";
  return "verifiable change";
}

function noulAnswer(answer: Answer, id: string): NoulAnswer {
  if (answer.type !== "noul") {
    throw new TypeSafeUnavailable(`TypeSafe answer ${id} had the wrong type`);
  }
  return answer;
}

function scoreAnswer(answer: Answer, id: string): ScoreAnswer {
  if (answer.type !== "score") {
    throw new TypeSafeUnavailable(`TypeSafe answer ${id} had the wrong type`);
  }
  return answer;
}

function usageSubjectRows(
  subjects: readonly SemanticSubjectRow[],
  answers: Record<string, Answer>,
): SemanticAnnotationRow[] {
  return subjects.map((subject, index) => {
    const wellFormed = noulAnswer(answers[`wf_${index}`], `wf_${index}`);
    const describes = scoreAnswer(answers[`desc_${index}`], `desc_${index}`);
    return {
      label: subject.label,
      subject: subject.text,
      regexValid: subject.regexValid,
      wellFormedProbability: wellFormed.noul,
      describesLevel: levelForScore(describes.score),
      describesConfidence: describes.confidence,
      noteLength: subject.noteLength,
    };
  });
}

function parseArgs(args: readonly string[]): {
  title: string;
  base: string;
  head: string;
  pullRequestNumber?: number;
} | null {
  const hasPullRequestNumber = args.length === 7;
  if (
    (args.length !== 5 && !hasPullRequestNumber) ||
    args[0] !== "--title" ||
    args[2] !== "--commit-range"
  ) {
    return null;
  }
  const [_, title, __, base, head] = args;
  if (!title || !base || !head) return null;
  if (!hasPullRequestNumber) return { title, base, head };
  if (
    args[5] !== "--pull-request-number" ||
    !/^[1-9][0-9]*$/.test(args[6]) ||
    !Number.isSafeInteger(Number(args[6]))
  ) {
    return null;
  }
  return { title, base, head, pullRequestNumber: Number(args[6]) };
}

async function main(): Promise<void> {
  const parsed = parseArgs(Deno.args);
  if (!parsed) {
    console.error(
      "Usage: annotate-semantic.ts --title <title> --commit-range <base> <head> [--pull-request-number <n>]",
    );
    Deno.exit(2);
  }
  const apiKey = readTypeSafeApiKey();
  if (!apiKey) {
    console.log("TypeSafe advisory skipped: TYPESAFE_API_KEY not set");
    return;
  }

  try {
    const commits = await listCommitSubjects(parsed.base, parsed.head);
    const subjects: SemanticSubjectRow[] = [
      titleRow(parsed.title, parsed.pullRequestNumber),
      ...commits.map((commit) => ({
        label: `commit ${commit.sha.slice(0, 12)}`,
        text: commit.subject,
        regexValid: isSemanticCommitSubject(commit.subject),
      })),
    ];

    const rows: SemanticAnnotationRow[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let requestCount = 0;
    for (const batch of chunk(subjects, SUBJECTS_PER_REQUEST)) {
      const response = await askSystemOne(
        {
          state: {
            rules: SEMANTIC_RULE_TEXT,
            subjects: batch.map(({ text }) => ({ text })),
          },
          questions: buildQuestions(batch),
        },
        { apiKey },
      );
      rows.push(...usageSubjectRows(batch, response.answers));
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      requestCount++;
    }
    await publishStepSummary(
      renderTable(rows, { inputTokens, outputTokens, requestCount }),
    );
  } catch (error) {
    if (error instanceof TypeSafeUnavailable) {
      console.log(`TypeSafe advisory skipped: ${error.message}`);
      return;
    }
    console.log(
      `TypeSafe advisory skipped: ${
        error instanceof Error ? error.message : "request failed"
      }`,
    );
  }
}

if (import.meta.main) await main();
