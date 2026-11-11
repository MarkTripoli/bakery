import { type Context } from "hono";
import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";

const MAX_BODY_BYTES = 512 * 1024;

function jsonBodyResponse(
  body: string,
  status: 200 | 201 | 204,
  replayed = false,
): Response {
  const headers = new Headers();
  if (status !== 204) headers.set("content-type", "application/json");
  if (replayed) headers.set("Idempotent-Replayed", "true");
  return new Response(status === 204 ? null : body, { status, headers });
}

function jsonResponse(
  value: unknown,
  status: 200 | 201,
  replayed = false,
): Response {
  return jsonBodyResponse(JSON.stringify(value), status, replayed);
}

function noContentResponse(replayed = false): Response {
  return jsonBodyResponse("", 204, replayed);
}

function requireJsonContent(context: Context): void {
  const mediaType = (context.req.header("content-type") ?? "")
    .toLowerCase()
    .split(";", 1)[0]
    .trim();
  if (
    mediaType !== "application/json" &&
    !/^[!#$%&'*+\-.^_`|~0-9a-z]+\/[!#$%&'*+\-.^_`|~0-9a-z]+\+json$/.test(
      mediaType,
    )
  ) {
    throw new StandardError({ code: "UNSUPPORTED_MEDIA_TYPE" });
  }
}

async function readJsonBody(context: Context): Promise<unknown> {
  requireJsonContent(context);
  const contentLength = context.req.header("content-length");
  if (contentLength !== undefined) {
    if (
      !/^[0-9]+$/.test(contentLength) ||
      !Number.isSafeInteger(Number(contentLength)) ||
      Number(contentLength) > MAX_BODY_BYTES
    ) {
      throw new StandardError({ code: "BODY_TOO_LARGE" });
    }
  }
  const body = context.req.raw.body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (body !== null) {
    const reader = body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new StandardError({ code: "BODY_TOO_LARGE" });
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new StandardError({ code: "MALFORMED_JSON", cause });
  }
}

type ContractIssue = {
  path: Array<string | number>;
  code: string;
  message: string;
};

function flattenContractIssues(error: z.ZodError): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const visit = (value: unknown, parentPath: ContractIssue["path"]): void => {
    if (!value || typeof value !== "object") return;
    const issue = value as Record<string, unknown>;
    const path = Array.isArray(issue.path)
      ? issue.path.filter((part): part is string | number =>
        typeof part === "string" || typeof part === "number"
      )
      : [];
    const fullPath = [...parentPath, ...path];
    if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
      for (const branch of issue.errors) {
        if (Array.isArray(branch)) {
          for (const nested of branch) visit(nested, fullPath);
        }
      }
      return;
    }
    issues.push({
      path: fullPath,
      code: typeof issue.code === "string" ? issue.code : "custom",
      message: typeof issue.message === "string"
        ? issue.message
        : "Invalid value",
    });
  };
  for (const issue of error.issues) visit(issue, []);
  return issues;
}

async function parseContract<T extends z.ZodType>(
  context: Context,
  schema: T,
): Promise<z.output<T>> {
  const body = await readJsonBody(context);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      cause: parsed.error,
      params: {
        issues: flattenContractIssues(parsed.error),
      },
    });
  }
  return parsed.data as z.output<T>;
}

export { jsonBodyResponse, jsonResponse, noContentResponse, parseContract };
