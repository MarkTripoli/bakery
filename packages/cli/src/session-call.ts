/**
 * The `bakery` CLI inside a session: one credential, one transport (#404).
 *
 * A session's agent holds no access token. What it holds is the *session
 * operation credential* minted at claim (chapter 25 §18.1): it names the
 * attempt, the fence, the person the agent acts for and the scopes the
 * definition was granted, and it dies with the lease. The API inside a session
 * therefore cannot be reached the way the web app reaches it, and the CLI must
 * not grow a second way either.
 *
 * So the CLI keeps its commands and changes only its transport. Every call is
 * a `session-call` of the operation the command already used, dispatched by
 * the gateway that owns authorisation, liveness and the audit. Nothing new is
 * exposed and no command is re-implemented: `files ls` still calls
 * `storageRoots.list`, and the gateway judges it exactly as it judges a
 * person's call to `/v1/storage/roots`.
 *
 * Two rules make that honest:
 *
 * - **The credential is read from the assignment, not from the environment.**
 *   There is no `--token`, and there is no `BAKERY_SESSION_CREDENTIAL` either:
 *   a token in the environment is a token in `ps` output, in a child's
 *   environment and in every crash dump. The worker writes it to an
 *   attempt-private file and the CLI reads that file.
 * - **The tool list is the gateway's, not ours.** `session tools` asks the
 *   server what this credential may call. A command whose operation is not
 *   offered fails with the server's reason rather than a guess of ours.
 */

import { ApiProblemError, ApiTransportError } from "@bakery/contracts/client";
import { UsageError } from "./config.ts";

/** Envelope field carrying the credential; the same name the server mints (#401). */
export const SESSION_CREDENTIAL_FIELD = "sessionCredential";

/** Where the worker puts it. Attempt-private, mode 0600, outside any artifact path. */
export const SESSION_CREDENTIAL_FILE = "BAKERY_SESSION_CREDENTIAL_FILE";

export type SessionConfig = Readonly<{
  baseUrl: string;
  /** The enrolled host's credential: it identifies the machine, never the person. */
  hostToken: string;
  /** The session operation credential: narrower than the host, dies with the lease. */
  sessionToken: string;
  attemptId: string;
  organizationId: string;
}>;

export const SESSION_ENVIRONMENT = Object.freeze({
  url: "BAKERY_URL",
  hostToken: "BAKERY_HOST_TOKEN",
  hostTokenFile: "BAKERY_HOST_TOKEN_FILE",
  credentialFile: SESSION_CREDENTIAL_FILE,
  attempt: "BAKERY_ATTEMPT_ID",
  organization: "BAKERY_ORGANIZATION",
});

/** One operation the server says this credential may call. */
export type SessionTool = Readonly<{
  name: string;
  method: string;
  path: string;
  scope: string;
  readOnly: boolean;
}>;

/** What the server answered to one call, as the CLI needs it. */
export type SessionCallOutcome = Readonly<{
  result: unknown;
}>;

export type SessionApi = Readonly<{
  /** What this session may call, in the server's order. */
  tools: () => Promise<readonly SessionTool[]>;
  /** Runs one operation and answers with its own output. */
  call: (tool: string, args: unknown) => Promise<unknown>;
}>;

export function sessionToolsPath(attemptId: string): string {
  return `/v1/worker/attempts/${encodeURIComponent(attemptId)}/session-tools`;
}

export function sessionCallPath(attemptId: string): string {
  return `/v1/worker/attempts/${encodeURIComponent(attemptId)}/session-call`;
}

/**
 * A session call refused by Bakery, with the operation named.
 *
 * The gateway answers a refusal as a problem document. Re-saying it here adds
 * the one thing the server cannot know: which command of ours asked.
 */
export class SessionRefusal extends Error {
  override readonly name = "SessionRefusal";

  constructor(
    readonly tool: string,
    readonly problem: ApiProblemError | ApiTransportError,
  ) {
    super(
      problem instanceof ApiProblemError
        ? `${tool}: ${problem.problem.code} (${problem.problem.status}${
          problem.problem.reason === undefined
            ? ""
            : `, ${problem.problem.reason}`
        })`
        : `${tool}: ${problem.kind} failure`,
    );
  }

  /** What a person should do about it, when the answer says. */
  get advice(): string {
    if (!(this.problem instanceof ApiProblemError)) {
      return "The server did not answer. Try again; if it repeats, the session's host may be cut off.";
    }
    const { code } = this.problem.problem;
    if (code === "AUTH_EXPIRED") {
      return "This session's lease ended, so its credential did too. Start the step again.";
    }
    if (code === "AUTH_FORBIDDEN") {
      return `The session was not granted ${this.tool}. A person can widen the workflow's grant for it.`;
    }
    if (code === "RESOURCE_NOT_FOUND") {
      return `${this.tool} is not offered to a session at all.`;
    }
    return "Bakery refused the call; the code above is the server's own reason.";
  }
}

type Fetch = typeof fetch;

function required(
  value: string | undefined,
  what: string,
  hint: string,
): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    throw new UsageError(`Set ${what}: ${hint}`);
  }
  return trimmed;
}

/**
 * Reads the session's settings, or says which one is missing.
 *
 * The two credentials are separate on purpose and are refused if equal: a host
 * token presented as a session credential must fail here, where the message can
 * explain it, rather than on the server as an opaque AUTH_INVALID.
 */
export async function readSessionConfig(
  sources: Readonly<{
    environment: (name: string) => string | undefined;
    flags: Readonly<{ url?: string; organization?: string }>;
    readFileText: (path: string) => Promise<string>;
  }>,
): Promise<SessionConfig> {
  const baseUrl = required(
    sources.flags.url ?? sources.environment(SESSION_ENVIRONMENT.url),
    SESSION_ENVIRONMENT.url,
    "your Bakery server's address.",
  );
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("scheme");
    }
  } catch {
    throw new UsageError(
      `${SESSION_ENVIRONMENT.url} is not a web address: ${baseUrl}`,
    );
  }
  const readFile = async (path: string, variable: string) => {
    const text = await sources.readFileText(path).catch(() => {
      throw new UsageError(`Cannot read ${variable}: ${path}`);
    });
    return required(text, variable, "a non-empty file.");
  };
  const credentialFile = required(
    sources.environment(SESSION_ENVIRONMENT.credentialFile),
    SESSION_ENVIRONMENT.credentialFile,
    "the file the worker wrote this attempt's session credential to. A session is the only place this command works.",
  );
  let hostToken = sources.environment(SESSION_ENVIRONMENT.hostToken)?.trim() ??
    "";
  const hostTokenFile = sources.environment(SESSION_ENVIRONMENT.hostTokenFile)
    ?.trim();
  if (hostToken === "" && hostTokenFile) {
    hostToken = await readFile(
      hostTokenFile,
      SESSION_ENVIRONMENT.hostTokenFile,
    );
  }
  required(
    hostToken,
    `${SESSION_ENVIRONMENT.hostToken} (or ${SESSION_ENVIRONMENT.hostTokenFile})`,
    "the enrolled host's credential, which the worker already has.",
  );
  const sessionToken = await readFile(
    credentialFile,
    SESSION_ENVIRONMENT.credentialFile,
  );
  if (sessionToken === hostToken) {
    throw new UsageError(
      `${SESSION_ENVIRONMENT.credentialFile} holds the host's credential. A session call needs the session's own, which is narrower.`,
    );
  }
  return {
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    hostToken,
    sessionToken,
    attemptId: required(
      sources.environment(SESSION_ENVIRONMENT.attempt),
      SESSION_ENVIRONMENT.attempt,
      "the attempt this session is running.",
    ),
    organizationId: required(
      sources.flags.organization ??
        sources.environment(SESSION_ENVIRONMENT.organization),
      SESSION_ENVIRONMENT.organization,
      "the organization this attempt was claimed in.",
    ),
  };
}

function problemOf(response: Response, body: unknown): ApiProblemError {
  const problem = body as { code?: unknown; status?: unknown };
  return new ApiProblemError({
    type: "session-call",
    title: "The session call was refused",
    status: response.status,
    code: typeof problem?.code === "string"
      ? problem.code
      : "SESSION_CALL_FAILED",
    retryable: response.status >= 500,
    ...(typeof (body as { reason?: unknown })?.reason === "string"
      ? { reason: (body as { reason: string }).reason }
      : {}),
  });
}

/** The tool gateway, called the way the gateway's own routes are called. */
export function createSessionApi(
  config: SessionConfig,
  fetchImplementation: Fetch = globalThis.fetch,
): SessionApi {
  const send = async (
    path: string,
    init: Readonly<{ method: string; body?: unknown }>,
    tool: string,
  ): Promise<unknown> => {
    const headers = new Headers({
      // The host's credential, because the route checks the lease against the
      // enrolled machine; and the session's, because that is who is calling.
      authorization: `Bearer ${config.hostToken}`,
      "x-session-credential": config.sessionToken,
      "Bakery-Organization-Id": config.organizationId,
      accept: "application/json",
    });
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    let response: Response;
    try {
      response = await fetchImplementation(`${config.baseUrl}${path}`, {
        method: init.method,
        headers,
        // A credential is a bearer value: no cookies, so the call never depends
        // on a browser session the attempt does not have.
        credentials: "omit",
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw new SessionRefusal(
        tool,
        new ApiTransportError("network", error instanceof Error ? 0 : 0),
      );
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      throw new SessionRefusal(tool, problemOf(response, parsed));
    }
    return parsed;
  };

  return {
    tools: async () => {
      const body = await send(
        sessionToolsPath(config.attemptId),
        { method: "GET" },
        "session tools",
      ) as { tools?: unknown };
      const list = Array.isArray(body?.tools) ? body.tools : [];
      return list as readonly SessionTool[];
    },
    call: async (tool, args) => {
      const body = await send(
        sessionCallPath(config.attemptId),
        { method: "POST", body: { tool, arguments: args } },
        tool,
      ) as { outcome?: unknown; result?: unknown };
      // An audited refusal is still an answer: say it, do not print the
      // operation's output as though it had run.
      if (body?.outcome === "denied" || body?.outcome === "unknown") {
        throw new SessionRefusal(
          tool,
          new ApiProblemError({
            type: "session-call",
            title: "The session call did not run",
            status: 403,
            code: "AUTH_FORBIDDEN",
            retryable: false,
          }),
        );
      }
      return body?.result;
    },
  };
}
