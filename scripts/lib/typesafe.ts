export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type NoulQuestion = {
  type: "noul";
  instructions: JsonValue;
  criteria?: { true?: string; false?: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: JsonValue;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: JsonValue;
  criteria: readonly string[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const DEFAULT_MODEL = "jev-latest";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 500;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

function isProbabilityRecord(
  value: unknown,
): value is Record<string, number> {
  return isRecord(value) &&
    Object.values(value).every((entry) => isProbability(entry));
}

function parseAnswer(value: unknown): Answer | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type === "noul") {
    return isProbability(value.noul)
      ? { type: "noul", noul: value.noul }
      : null;
  }
  if (value.type === "choice") {
    if (
      typeof value.choice !== "string" ||
      !isProbabilityRecord(value.probabilities) ||
      !isProbability(value.confidence)
    ) {
      return null;
    }
    return {
      type: "choice",
      choice: value.choice,
      probabilities: value.probabilities,
      confidence: value.confidence,
    };
  }
  if (value.type === "score") {
    if (
      !isFiniteNumber(value.score) ||
      !isStringRecord(value.legend) ||
      !isProbabilityRecord(value.probabilities) ||
      !isProbability(value.confidence)
    ) {
      return null;
    }
    return {
      type: "score",
      score: value.score,
      legend: value.legend,
      probabilities: value.probabilities,
      confidence: value.confidence,
    };
  }
  return null;
}

function parseSystemOneResponse(payload: unknown): SystemOneResponse | null {
  if (!isRecord(payload) || typeof payload.model !== "string") return null;
  if (!isRecord(payload.answers) || !isRecord(payload.usage)) return null;
  if (
    !Number.isInteger(payload.usage.input_tokens) ||
    (payload.usage.input_tokens as number) < 0 ||
    !Number.isInteger(payload.usage.output_tokens) ||
    (payload.usage.output_tokens as number) < 0
  ) {
    return null;
  }

  const answers: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(payload.answers)) {
    const answer = parseAnswer(value);
    if (answer === null) return null;
    answers[id] = answer;
  }
  return {
    model: payload.model,
    answers,
    usage: {
      input_tokens: payload.usage.input_tokens as number,
      output_tokens: payload.usage.output_tokens as number,
    },
  };
}

export class TypeSafeUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TypeSafeUnavailable";
  }
}

export function readTypeSafeApiKey(): string | null {
  const value = Deno.env.get(TYPESAFE_API_KEY_ENV);
  return value && value.trim() ? value : null;
}

function redacted(message: string, apiKey: string): string {
  return apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
}

function unavailable(message: string, apiKey: string): TypeSafeUnavailable {
  const safeMessage = redacted(message, apiKey).trim().slice(0, 240);
  return new TypeSafeUnavailable(safeMessage || "network error");
}

function errorName(error: unknown): string {
  if (
    error instanceof Error &&
    /^[A-Za-z0-9._-]+$/.test(error.name)
  ) {
    return error.name;
  }
  return "Error";
}

function unavailableForError(
  error: unknown,
  apiKey: string,
): TypeSafeUnavailable {
  const name = errorName(error);
  const category = name === "TimeoutError" || name === "AbortError"
    ? "timeout"
    : "network error";
  return unavailable(`${category} (${name})`, apiKey);
}

function wait(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export async function askSystemOne(
  request: {
    state: JsonValue;
    questions: Record<string, Question>;
    model?: string;
  },
  options: {
    apiKey: string;
    fetch?: typeof fetch;
    endpoint?: string;
    timeoutMs?: number;
  },
): Promise<SystemOneResponse> {
  const model = request.model ?? DEFAULT_MODEL;
  let body: string;
  try {
    body = JSON.stringify({
      state: request.state,
      model,
      questions: request.questions,
    });
  } catch (error) {
    throw unavailableForError(error, options.apiKey);
  }

  const fetchImpl = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw unavailableForError(error, options.apiKey);
    }

    if (!response.ok) {
      // 429/529 are rate limits; 502/503/504 are transient upstream failures
      // (a 503 interrupted a 328-request run once). One retry for both.
      const transient = response.status === 429 || response.status === 529 ||
        response.status === 502 || response.status === 503 ||
        response.status === 504;
      if (attempt === 0 && transient) {
        await wait(RETRY_DELAY_MS);
        continue;
      }
      if (response.status === 429 || response.status === 529) {
        throw unavailable("rate limited after retry", options.apiKey);
      }
      throw unavailable(`http ${response.status}`, options.apiKey);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw unavailable("malformed response", options.apiKey);
    }
    const parsed = parseSystemOneResponse(payload);
    if (parsed === null) {
      throw unavailable("malformed response", options.apiKey);
    }

    const expectedIds = Object.keys(request.questions).sort();
    const receivedIds = Object.keys(parsed.answers).sort();
    if (
      expectedIds.length !== receivedIds.length ||
      expectedIds.some((id, index) => id !== receivedIds[index])
    ) {
      throw unavailable("malformed response", options.apiKey);
    }
    return parsed;
  }

  throw unavailable("rate limited after retry", options.apiKey);
}

export async function publishStepSummary(markdown: string): Promise<void> {
  console.log(markdown);
  const summaryPath = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryPath) {
    await Deno.writeTextFile(
      summaryPath,
      markdown.endsWith("\n") ? markdown : `${markdown}\n`,
      { append: true },
    );
  }
}
