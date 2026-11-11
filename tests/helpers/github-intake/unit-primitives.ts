import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { z } from "zod";
import { descriptionDefectKind } from "../../../packages/contracts/src/description-quality.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { isPullRequestItem } from "../../../apps/server/src/modules/integrations/github-app.ts";
import {
  INTAKE_MAX_BODY_BYTES,
  readBoundedBody,
} from "../../../apps/server/src/modules/integrations/intake-body.ts";
import {
  classifyEvent,
  INTAKE_EVENT_FAMILIES,
  INTAKE_PAYLOAD_SCHEMAS,
  type IntakeEventFamily,
  IntakeProjectionSchema,
  isSupportedEvent,
  parseDelivery,
  parseDeliveryIdHeader,
  parseEventNameHeader,
  parseIntakeContentType,
  projectEvent,
  PROJECTION_MAX_STRING,
  SUPPORTED_EVENTS,
  type SupportedDelivery,
} from "../../../apps/server/src/modules/integrations/intake-events.ts";
import {
  parseSignatureHeader,
  sha256Hex,
  verifyGitHubSignature,
} from "../../../apps/server/src/modules/integrations/intake-signature.ts";
import {
  deliveryRequest,
  formEncodedPayload,
  signDelivery,
} from "./signed-delivery.ts";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

// GitHub's documented test vector:
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
const VECTOR_SECRET = "It's a Secret to Everybody";
const VECTOR_BODY = "Hello, World!";
const VECTOR_SIGNATURE =
  "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

// ---------------------------------------------------------------- body ----

/** A body stream that counts pulls and records cancellation; it reads nothing until asked. */
function spyStream(chunks: readonly Uint8Array<ArrayBuffer>[]) {
  const state = { pulls: 0, cancelled: false };
  let next = 0;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      const chunk = chunks[next];
      if (chunk === undefined) return controller.close();
      next += 1;
      state.pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

function streamRequest(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://bakery.test/v1/webhooks/github", {
    method: "POST",
    body: stream,
    headers,
    // Required for a streamed request body; the runtime types do not list it.
    ...{ duplex: "half" },
  });
}

function filled(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).fill(0x61);
}

async function assertTooLarge(request: Request, limit: number) {
  const error = await assertRejects(
    () => readBoundedBody(request, limit),
    StandardError,
  );
  assertEquals(error.code, "BODY_TOO_LARGE");
  assertEquals(error.params, { limit });
}

Deno.test("the receiver body limit is 256 KiB", () => {
  assertEquals(INTAKE_MAX_BODY_BYTES, 262_144);
});

Deno.test("a body with no Content-Length is read whole across chunks", async () => {
  const { stream, state } = spyStream([bytes('{"a"'), bytes(":1"), bytes("}")]);
  const result = await readBoundedBody(streamRequest(stream), 64);
  assertEquals(new TextDecoder().decode(result), '{"a":1}');
  assertFalse(state.cancelled);
});

Deno.test("a body of exactly the limit passes and one byte more fails", async () => {
  const exact = spyStream([filled(4), filled(4)]);
  const result = await readBoundedBody(
    streamRequest(exact.stream, { "content-length": "8" }),
    8,
  );
  assertEquals(result.byteLength, 8);
  assertFalse(exact.state.cancelled);

  const over = spyStream([filled(4), filled(5)]);
  await assertTooLarge(streamRequest(over.stream), 8);
  assert(over.state.cancelled);
});

Deno.test("a body of exactly 256 KiB passes at the production limit", async () => {
  const { stream } = spyStream([
    filled(INTAKE_MAX_BODY_BYTES / 2),
    filled(INTAKE_MAX_BODY_BYTES / 2),
  ]);
  const result = await readBoundedBody(
    streamRequest(stream, { "content-length": String(INTAKE_MAX_BODY_BYTES) }),
    INTAKE_MAX_BODY_BYTES,
  );
  assertEquals(result.byteLength, INTAKE_MAX_BODY_BYTES);
});

Deno.test("a declared length over the limit fails and cancels before any read", async () => {
  const { stream, state } = spyStream([filled(4), filled(4)]);
  await assertTooLarge(
    streamRequest(stream, {
      "content-length": String(INTAKE_MAX_BODY_BYTES + 1),
    }),
    INTAKE_MAX_BODY_BYTES,
  );
  assert(state.cancelled);
  assertEquals(state.pulls, 0);
});

Deno.test("a chunked body over the limit is cut off and cancelled", async () => {
  const { stream, state } = spyStream([
    filled(4),
    filled(4),
    filled(4),
    filled(4),
    filled(4),
  ]);
  await assertTooLarge(streamRequest(stream), 8);
  assert(state.cancelled);
  // The third chunk crosses the limit; nothing past it is pulled.
  assertEquals(state.pulls, 3);
});

Deno.test("a body longer than its declared length is still bounded by the count", async () => {
  const { stream, state } = spyStream([filled(16)]);
  await assertTooLarge(streamRequest(stream, { "content-length": "4" }), 8);
  assert(state.cancelled);
});

Deno.test("a Content-Length that is not plain digits fails and cancels", async () => {
  for (
    const declared of [
      "abc",
      "-1",
      "+5",
      "1e3",
      "0x10",
      "1.5",
      "1 2",
      "5, 5",
      "",
      "9".repeat(400),
    ]
  ) {
    const { stream, state } = spyStream([filled(4)]);
    await assertTooLarge(
      streamRequest(stream, { "content-length": declared }),
      8,
    );
    assert(state.cancelled, `cancelled for ${JSON.stringify(declared)}`);
    assertEquals(state.pulls, 0, `unread for ${JSON.stringify(declared)}`);
  }
});

Deno.test("a zero Content-Length with an empty body reads as no bytes", async () => {
  const { stream } = spyStream([]);
  const result = await readBoundedBody(
    streamRequest(stream, { "content-length": "0" }),
    8,
  );
  assertEquals(result.byteLength, 0);
});

Deno.test("a request with no body reads as no bytes", async () => {
  const request = new Request("https://bakery.test/v1/webhooks/github", {
    method: "POST",
  });
  assertEquals((await readBoundedBody(request, 8)).byteLength, 0);
});

Deno.test("a limit that is not a non-negative safe integer is refused, not unbounded", async () => {
  for (const limit of [Number.NaN, -1, 1.5, Infinity, 2 ** 53]) {
    const { stream } = spyStream([filled(4)]);
    await assertRejects(
      () => readBoundedBody(streamRequest(stream), limit),
      RangeError,
    );
  }
});

// ----------------------------------------------------------- signature ----

Deno.test("GitHub's documented vector signs and verifies", async () => {
  assertEquals(
    await signDelivery(VECTOR_SECRET, VECTOR_BODY),
    VECTOR_SIGNATURE,
  );
  const signature = parseSignatureHeader(VECTOR_SIGNATURE);
  assert(signature !== null);
  assertEquals(signature.byteLength, 32);
  assert(
    await verifyGitHubSignature(
      bytes(VECTOR_SECRET),
      signature,
      bytes(VECTOR_BODY),
    ),
  );
});

Deno.test("signatures verify over the exact bytes, not their text form", async () => {
  const raw = new Uint8Array([0, 255, 128, 10, 13, 0]);
  const header = await signDelivery("séçret ✓", raw);
  const signature = parseSignatureHeader(header);
  assert(signature !== null);
  assert(await verifyGitHubSignature(bytes("séçret ✓"), signature, raw));
});

Deno.test("forged variants of the documented vector all fail", async () => {
  const signature = parseSignatureHeader(VECTOR_SIGNATURE);
  assert(signature !== null);
  const secret = bytes(VECTOR_SECRET);
  const raw = bytes(VECTOR_BODY);

  assertFalse(
    await verifyGitHubSignature(
      bytes("It's a secret to Everybody"),
      signature,
      raw,
    ),
    "wrong secret",
  );
  assertFalse(
    await verifyGitHubSignature(bytes(`${VECTOR_SECRET} `), signature, raw),
    "secret with a trailing space",
  );
  const flipped = raw.slice();
  flipped[0] = flipped[0]! ^ 1;
  assertFalse(
    await verifyGitHubSignature(secret, signature, flipped),
    "one flipped bit in the body",
  );
  assertFalse(
    await verifyGitHubSignature(secret, signature, bytes(`${VECTOR_BODY}\n`)),
    "one appended byte",
  );
  assertFalse(
    await verifyGitHubSignature(secret, signature, raw.slice(0, -1)),
    "one dropped byte",
  );
  const lastNibble = signature.slice();
  lastNibble[31] = lastNibble[31]! ^ 1;
  assertFalse(
    await verifyGitHubSignature(secret, lastNibble, raw),
    "one flipped bit in the signature",
  );
  assertFalse(
    await verifyGitHubSignature(secret, signature.slice(0, 31), raw),
    "31-byte signature",
  );
  assertFalse(
    await verifyGitHubSignature(secret, new Uint8Array(33), raw),
    "33-byte signature",
  );
  assertFalse(await verifyGitHubSignature(secret, null, raw), "no signature");
});

Deno.test("an empty secret never verifies and does not throw", async () => {
  const signature = parseSignatureHeader(VECTOR_SIGNATURE);
  assert(signature !== null);
  assertFalse(
    await verifyGitHubSignature(
      new Uint8Array(0),
      signature,
      bytes(VECTOR_BODY),
    ),
  );
  assertFalse(
    await verifyGitHubSignature(new Uint8Array(0), null, bytes(VECTOR_BODY)),
  );
});

Deno.test("only the exact sha256 header form parses", () => {
  const hex = VECTOR_SIGNATURE.slice("sha256=".length);
  const accepted = parseSignatureHeader(`sha256=${hex}`);
  assert(accepted !== null);
  assertEquals(
    Array.from(accepted.slice(0, 4), (byte) => byte.toString(16)),
    ["75", "71", "7", "ea"],
  );
  const rejected: Record<string, string | null> = {
    "missing header": null,
    "empty string": "",
    "prefix only": "sha256=",
    "truncated hex": `sha256=${hex.slice(0, 63)}`,
    "one hex digit too many": `sha256=${hex}0`,
    "uppercase hex": `sha256=${hex.toUpperCase()}`,
    "mixed case hex": `sha256=${hex.slice(0, 32)}${
      hex.slice(32).toUpperCase()
    }`,
    "uppercase prefix": `SHA256=${hex}`,
    "legacy sha1 prefix with 40 hex": `sha1=${hex.slice(0, 40)}`,
    "sha1 prefix with 64 hex": `sha1=${hex}`,
    "no prefix": hex,
    "non-hex digit": `sha256=${hex.slice(0, 63)}g`,
    "leading space": ` sha256=${hex}`,
    "trailing space": `sha256=${hex} `,
    "trailing newline": `sha256=${hex}\n`,
    "two signatures": `sha256=${hex}, sha256=${hex}`,
  };
  for (const [name, value] of Object.entries(rejected)) {
    assertEquals(parseSignatureHeader(value), null, name);
  }
});

Deno.test("sha256Hex matches the published digests", async () => {
  assertEquals(
    await sha256Hex(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    await sha256Hex(bytes("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("a built delivery request carries the headers and the signature the receiver reads", async () => {
  const request = await deliveryRequest({
    url: "https://bakery.test/v1/webhooks/github",
    secret: VECTOR_SECRET,
    eventName: "ping",
    deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    body: VECTOR_BODY,
    contentType: "application/json",
  });
  assertEquals(request.method, "POST");
  assertEquals(request.headers.get("x-hub-signature-256"), VECTOR_SIGNATURE);
  assertEquals(request.headers.get("x-github-event"), "ping");
  assertEquals(
    request.headers.get("x-github-delivery"),
    "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  );
  assertEquals(request.headers.get("content-type"), "application/json");
  assertEquals(
    new TextDecoder().decode(await readBoundedBody(request, 64)),
    VECTOR_BODY,
  );

  const forged = await deliveryRequest({
    url: "https://bakery.test/v1/webhooks/github",
    secret: VECTOR_SECRET,
    eventName: "ping",
    deliveryId: "d1",
    body: VECTOR_BODY,
    contentType: "application/json",
    signature: "sha256=00",
  });
  assertEquals(forged.headers.get("x-hub-signature-256"), "sha256=00");
  const unsigned = await deliveryRequest({
    url: "https://bakery.test/v1/webhooks/github",
    secret: VECTOR_SECRET,
    eventName: "ping",
    deliveryId: "d2",
    body: VECTOR_BODY,
    contentType: "application/json",
    signature: null,
  });
  assertEquals(unsigned.headers.get("x-hub-signature-256"), null);
});

// -------------------------------------------------------------- events ----

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

/** Realistic payload fragments: the fields Bakery reads plus fields GitHub adds. */
const payloads = {
  ping: {
    zen: "Keep it logically awesome.",
    hook_id: 7,
    hook: { type: "App", events: ["issues"] },
    sender: { login: "octocat" },
  },
  pingWithInstallation: {
    zen: "Design for failure.",
    installation: { id: 42, node_id: "MDIzOkluc3RhbGxhdGlvbjQy" },
  },
  installation: {
    action: "suspend",
    installation: {
      id: 42,
      account: { login: "octo-org" },
      suspended_at: null,
    },
    repositories: [{ id: 1, name: "hello" }],
    sender: { login: "octocat" },
  },
  installation_repositories: {
    action: "added",
    installation: { id: 42, repository_selection: "selected" },
    repositories_added: [{ id: 1, name: "hello" }],
    repositories_removed: [],
  },
  github_app_authorization: {
    action: "revoked",
    sender: { login: "octocat" },
  },
  repository: {
    action: "renamed",
    repository: { id: 1296269, full_name: "octo-org/hello", private: true },
    installation: { id: 42 },
    changes: { repository: { name: { from: "hi" } } },
  },
  issues: {
    action: "labeled",
    issue: {
      number: 1347,
      title: "Found a bug",
      body: "secret repository text",
      labels: [{ name: "bug" }],
    },
    label: { name: "bug" },
    repository: { id: 1296269, full_name: "octo-org/hello" },
    installation: { id: 42 },
  },
  pull_request: {
    action: "synchronize",
    number: 9,
    pull_request: {
      number: 9,
      title: "Fix it",
      head: { sha: SHA, ref: "fix", repo: { id: 1296269 } },
      base: { sha: OTHER_SHA, ref: "main" },
    },
    repository: { id: 1296269 },
    installation: { id: 42 },
  },
  check_run: {
    action: "completed",
    check_run: {
      id: 128620228,
      head_sha: SHA,
      name: "lint",
      pull_requests: [{ number: 9 }],
    },
    repository: { id: 1296269 },
    installation: { id: 42 },
  },
  check_suite: {
    action: "requested",
    check_suite: { id: 118578147, head_sha: OTHER_SHA, status: "queued" },
    repository: { id: 1296269 },
    installation: { id: 42 },
  },
} as const;

function jsonDelivery(eventName: string, payload: unknown) {
  return {
    contentType: "application/json",
    eventName,
    raw: bytes(JSON.stringify(payload)),
  };
}

function supported(eventName: string, payload: unknown): SupportedDelivery {
  const parsed = parseDelivery(jsonDelivery(eventName, payload));
  assert(parsed.supported, `${eventName} is supported`);
  return parsed;
}

function refusal(input: Parameters<typeof parseDelivery>[0]): StandardError {
  return assertThrows(() => parseDelivery(input), StandardError);
}

Deno.test("the supported events are the nine the design lists, frozen, with a guard", () => {
  assertEquals([...SUPPORTED_EVENTS], [
    "ping",
    "installation",
    "installation_repositories",
    "github_app_authorization",
    "repository",
    "issues",
    "pull_request",
    "check_run",
    "check_suite",
  ]);
  assert(Object.isFrozen(SUPPORTED_EVENTS));
  for (const name of SUPPORTED_EVENTS) assert(isSupportedEvent(name), name);
  for (
    const name of [
      "",
      "push",
      "issue_comment",
      "Issues",
      "issues ",
      "constructor",
      "__proto__",
      "toString",
    ]
  ) assertFalse(isSupportedEvent(name), name);
});

Deno.test("every supported event parses and keeps only the fields Bakery reads", () => {
  const cases = [
    ["ping", payloads.ping, {}, null],
    [
      "ping",
      payloads.pingWithInstallation,
      { installation: { id: 42 } },
      null,
    ],
    [
      "installation",
      payloads.installation,
      { action: "suspend", installation: { id: 42 } },
      "suspend",
    ],
    [
      "installation_repositories",
      payloads.installation_repositories,
      { action: "added", installation: { id: 42 } },
      "added",
    ],
    [
      "github_app_authorization",
      payloads.github_app_authorization,
      { action: "revoked" },
      "revoked",
    ],
    [
      "repository",
      payloads.repository,
      {
        action: "renamed",
        repository: { id: 1296269 },
        installation: { id: 42 },
      },
      "renamed",
    ],
    [
      "issues",
      payloads.issues,
      {
        action: "labeled",
        issue: { number: 1347 },
        repository: { id: 1296269 },
        installation: { id: 42 },
      },
      "labeled",
    ],
    [
      "pull_request",
      payloads.pull_request,
      {
        action: "synchronize",
        pull_request: { number: 9, head: { sha: SHA } },
        repository: { id: 1296269 },
        installation: { id: 42 },
      },
      "synchronize",
    ],
    [
      "check_run",
      payloads.check_run,
      {
        action: "completed",
        check_run: { id: 128620228, head_sha: SHA },
        repository: { id: 1296269 },
        installation: { id: 42 },
      },
      "completed",
    ],
    [
      "check_suite",
      payloads.check_suite,
      {
        action: "requested",
        check_suite: { id: 118578147, head_sha: OTHER_SHA },
        repository: { id: 1296269 },
        installation: { id: 42 },
      },
      "requested",
    ],
  ] as const;
  assertEquals(
    new Set(cases.map(([name]) => name)),
    new Set(SUPPORTED_EVENTS),
  );
  for (const [eventName, payload, kept, action] of cases) {
    const parsed = parseDelivery(jsonDelivery(eventName, payload));
    assertEquals(parsed.supported, true, eventName);
    assertEquals(parsed.eventName, eventName);
    assert(parsed.supported);
    assertEquals(parsed.action, action, eventName);
    assertEquals(parsed.payload, kept, eventName);
  }
});

Deno.test("an issue item keeps its pull_request marker so the processor can drop it", () => {
  const plain = supported("issues", payloads.issues);
  const marked = supported("issues", {
    ...payloads.issues,
    issue: {
      ...payloads.issues.issue,
      pull_request: {
        url: "https://api.github.com/repos/octo-org/hello/pulls/1347",
      },
    },
  });
  assert(plain.eventName === "issues" && marked.eventName === "issues");
  assertFalse(isPullRequestItem(plain.payload.issue));
  assert(isPullRequestItem(marked.payload.issue));
});

Deno.test("the form encoding decodes to the same delivery as JSON", () => {
  const json = JSON.stringify(payloads.issues);
  const fromJson = parseDelivery({
    contentType: "application/json",
    eventName: "issues",
    raw: bytes(json),
  });
  for (
    const body of [
      formEncodedPayload(json),
      // application/x-www-form-urlencoded writes a space as +.
      formEncodedPayload(json).replaceAll("%20", "+"),
    ]
  ) {
    const fromForm = parseDelivery({
      contentType: "application/x-www-form-urlencoded",
      eventName: "issues",
      raw: bytes(body),
    });
    assertEquals(fromForm, fromJson);
  }
});

Deno.test("content type parameters and case do not change the encoding", () => {
  assertEquals(parseIntakeContentType("application/json"), "json");
  assertEquals(parseIntakeContentType("Application/JSON"), "json");
  assertEquals(
    parseIntakeContentType("application/json; charset=utf-8"),
    "json",
  );
  assertEquals(
    parseIntakeContentType("application/json;charset=UTF-8"),
    "json",
  );
  assertEquals(
    parseIntakeContentType("application/x-www-form-urlencoded"),
    "form",
  );
  assertEquals(
    parseIntakeContentType("application/x-www-form-urlencoded; charset=UTF-8"),
    "form",
  );
  for (
    const value of [
      null,
      "",
      "text/plain",
      "text/json",
      "application/jsonp",
      "application/json-patch+json",
      "application/ld+json",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded2",
      "json",
    ]
  ) assertEquals(parseIntakeContentType(value), null, String(value));
});

Deno.test("an unsupported content type is refused before the body is read", () => {
  for (
    const contentType of [
      null,
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/xml",
      "application/jsonp",
    ]
  ) {
    const error = refusal({
      contentType,
      eventName: "issues",
      raw: bytes(JSON.stringify(payloads.issues)),
    });
    assertEquals(error.code, "UNSUPPORTED_MEDIA_TYPE", String(contentType));
  }
  // Content type is checked for unsupported events too.
  assertEquals(
    refusal({ contentType: "text/plain", eventName: "push", raw: bytes("{}") })
      .code,
    "UNSUPPORTED_MEDIA_TYPE",
  );
});

Deno.test("unreadable JSON and UTF-8 are MALFORMED_JSON", () => {
  for (
    const raw of [
      bytes(""),
      bytes("{"),
      bytes('{"action":'),
      bytes("not json"),
      bytes('{"a":1}{"b":2}'),
      new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]),
    ]
  ) {
    const error = refusal({
      contentType: "application/json",
      eventName: "issues",
      raw,
    });
    assertEquals(error.code, "MALFORMED_JSON", Array.from(raw).join(","));
  }
});

Deno.test("form refusals: zero, repeated or extra fields are malformed, bad JSON inside is MALFORMED_JSON", () => {
  const json = encodeURIComponent(JSON.stringify(payloads.issues));
  const form = (body: string | Uint8Array<ArrayBuffer>) =>
    refusal({
      contentType: "application/x-www-form-urlencoded",
      eventName: "issues",
      raw: typeof body === "string" ? bytes(body) : body,
    }).code;
  assertEquals(form(""), "MALFORMED_REQUEST");
  assertEquals(form("payload"), "MALFORMED_JSON");
  assertEquals(form(`other=${json}`), "MALFORMED_REQUEST");
  assertEquals(form(`payload=${json}&payload=${json}`), "MALFORMED_REQUEST");
  assertEquals(form(`payload=${json}&extra=1`), "MALFORMED_REQUEST");
  assertEquals(form(`extra=1&payload=${json}`), "MALFORMED_REQUEST");
  assertEquals(form("payload=%7Bnot-json"), "MALFORMED_JSON");
  assertEquals(form("payload=%FF"), "MALFORMED_JSON");
  assertEquals(
    form(
      new Uint8Array([0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64, 0x3d, 0xff]),
    ),
    "MALFORMED_REQUEST",
  );
  // A JSON body is not read as a form and a form body is not read as JSON.
  assertEquals(
    refusal({
      contentType: "application/json",
      eventName: "issues",
      raw: bytes(`payload=${json}`),
    }).code,
    "MALFORMED_JSON",
  );
});

Deno.test("an event name outside the supported list returns supported false without parsing", () => {
  for (
    const eventName of [
      "push",
      "workflow_run",
      "issue_comment",
      "label",
      "constructor",
      "a".repeat(100),
    ]
  ) {
    // The body is not valid JSON: it is never decoded for an unsupported event.
    assertEquals(
      parseDelivery({
        contentType: "application/json",
        eventName,
        raw: bytes("{{ not json"),
      }),
      { supported: false, eventName },
    );
  }
  assertEquals(
    parseDelivery({
      contentType: "application/x-www-form-urlencoded",
      eventName: "push",
      raw: new Uint8Array([0xff]),
    }),
    { supported: false, eventName: "push" },
  );
});

Deno.test("an event name that fails header validation is MALFORMED_REQUEST", () => {
  for (
    const eventName of ["", "Issues", "issues ", "check-run", "a".repeat(101)]
  ) {
    assertEquals(
      refusal({ contentType: "application/json", eventName, raw: bytes("{}") })
        .code,
      "MALFORMED_REQUEST",
      eventName,
    );
  }
});

Deno.test("payloads that fail their schema are MALFORMED_REQUEST", () => {
  const repo = { id: 1296269 };
  const install = { id: 42 };
  const bad: [string, string, unknown][] = [
    ["installation without installation", "installation", {
      action: "created",
    }],
    ["installation without action", "installation", { installation: install }],
    ["installation id as text", "installation", {
      action: "created",
      installation: { id: "42" },
    }],
    ["installation id zero", "installation", {
      action: "created",
      installation: { id: 0 },
    }],
    ["installation id negative", "installation", {
      action: "created",
      installation: { id: -3 },
    }],
    ["installation id fractional", "installation", {
      action: "created",
      installation: { id: 1.5 },
    }],
    [
      "installation id past 2^53",
      "installation",
      JSON.parse('{"action":"created","installation":{"id":9007199254740993}}'),
    ],
    ["installation id null", "installation", {
      action: "created",
      installation: { id: null },
    }],
    ["installation null", "installation", {
      action: "created",
      installation: null,
    }],
    ["empty action", "installation", { action: "", installation: install }],
    ["action with a space", "installation", {
      action: "bad action",
      installation: install,
    }],
    ["action with a newline", "installation", {
      action: "a\nb",
      installation: install,
    }],
    ["action over 100 characters", "installation", {
      action: "a".repeat(101),
      installation: install,
    }],
    ["action as number", "installation", { action: 1, installation: install }],
    ["repositories event without installation", "installation_repositories", {
      action: "added",
    }],
    ["authorization without action", "github_app_authorization", {}],
    ["repository without repository", "repository", {
      action: "created",
      installation: install,
    }],
    ["repository id as text", "repository", {
      action: "created",
      repository: { id: "1" },
      installation: install,
    }],
    ["issues without issue", "issues", { action: "opened", repository: repo }],
    ["issues without number", "issues", {
      action: "opened",
      issue: {},
      repository: repo,
    }],
    ["issue number zero", "issues", {
      action: "opened",
      issue: { number: 0 },
      repository: repo,
    }],
    ["issue number as text", "issues", {
      action: "opened",
      issue: { number: "7" },
      repository: repo,
    }],
    ["issues without repository", "issues", {
      action: "opened",
      issue: { number: 7 },
    }],
    ["issues with a bad optional installation", "issues", {
      action: "opened",
      issue: { number: 7 },
      repository: repo,
      installation: { id: "x" },
    }],
    ["pull_request without head", "pull_request", {
      action: "opened",
      pull_request: { number: 9 },
      repository: repo,
    }],
    ["pull_request without number", "pull_request", {
      action: "opened",
      pull_request: { head: { sha: SHA } },
      repository: repo,
    }],
    ["pull_request sha uppercase", "pull_request", {
      action: "opened",
      pull_request: { number: 9, head: { sha: SHA.toUpperCase() } },
      repository: repo,
    }],
    ["pull_request sha 39 hex", "pull_request", {
      action: "opened",
      pull_request: { number: 9, head: { sha: SHA.slice(1) } },
      repository: repo,
    }],
    ["pull_request sha 41 hex", "pull_request", {
      action: "opened",
      pull_request: { number: 9, head: { sha: `${SHA}0` } },
      repository: repo,
    }],
    ["pull_request sha not hex", "pull_request", {
      action: "opened",
      pull_request: { number: 9, head: { sha: "z".repeat(40) } },
      repository: repo,
    }],
    ["check_run without head_sha", "check_run", {
      action: "created",
      check_run: { id: 5 },
      repository: repo,
    }],
    ["check_run without id", "check_run", {
      action: "created",
      check_run: { head_sha: SHA },
      repository: repo,
    }],
    ["check_run head_sha not hex", "check_run", {
      action: "created",
      check_run: { id: 5, head_sha: "main" },
      repository: repo,
    }],
    ["check_suite without head_sha", "check_suite", {
      action: "requested",
      check_suite: { id: 5 },
      repository: repo,
    }],
    ["check_suite without repository", "check_suite", {
      action: "requested",
      check_suite: { id: 5, head_sha: SHA },
    }],
    ["ping with a bad installation", "ping", { installation: { id: "x" } }],
    ["array body", "installation", []],
    ["string body", "installation", "text"],
    ["number body", "installation", 42],
    ["null body", "installation", null],
    ["array ping", "ping", []],
    ["null ping", "ping", null],
  ];
  for (const [name, eventName, payload] of bad) {
    const error = refusal(jsonDelivery(eventName, payload));
    assertEquals(error.code, "MALFORMED_REQUEST", name);
  }
});

Deno.test("optional installation and extra fields are tolerated", () => {
  const issues = supported("issues", {
    action: "opened",
    issue: { number: 7, anything: ["GitHub adds"] },
    repository: { id: 1, extra: true },
    sender: { login: "octocat" },
    organization: { login: "octo-org" },
    future_field: { nested: [1, 2, 3] },
  });
  assert(issues.eventName === "issues");
  assertEquals(issues.payload, {
    action: "opened",
    issue: { number: 7 },
    repository: { id: 1 },
  });
  assertEquals(projectEvent(issues).installationId, null);
  assertEquals(supported("ping", {}).payload, {});
  // A 100 character action is the longest accepted.
  assertEquals(
    supported("installation", {
      action: "a".repeat(100),
      installation: { id: 1 },
    }).action,
    "a".repeat(100),
  );
});

Deno.test("header validators accept only the documented shapes", () => {
  const goodIds = [
    "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "a",
    "A-Z-0-9",
    "x".repeat(255),
  ];
  for (const value of goodIds) {
    assertEquals(parseDeliveryIdHeader(value), value);
  }
  for (
    const value of [
      null,
      "",
      "x".repeat(256),
      "has space",
      "under_score",
      "dot.dot",
      "slash/slash",
      "line\nbreak",
      "tab\t",
      "é",
      "id\n",
    ]
  ) assertEquals(parseDeliveryIdHeader(value), null, String(value));

  for (const value of ["ping", "check_run", "x", "a".repeat(100)]) {
    assertEquals(parseEventNameHeader(value), value);
  }
  for (
    const value of [
      null,
      "",
      "a".repeat(101),
      "Ping",
      "check-run",
      "issues1",
      "issues ",
      "issues\n",
      "a.b",
    ]
  ) assertEquals(parseEventNameHeader(value), null, String(value));
});

Deno.test("classification gives each supported event its route purpose family", () => {
  const expected: Record<(typeof SUPPORTED_EVENTS)[number], IntakeEventFamily> =
    {
      ping: "ping",
      installation: "installation_reconcile",
      github_app_authorization: "installation_reconcile",
      installation_repositories: "discovery",
      repository: "discovery",
      issues: "fact_refresh",
      pull_request: "fact_refresh",
      check_run: "fact_refresh",
      check_suite: "fact_refresh",
    };
  for (const eventName of SUPPORTED_EVENTS) {
    assertEquals(classifyEvent({ eventName }), expected[eventName], eventName);
  }
  assertEquals([...INTAKE_EVENT_FAMILIES].sort(), [
    "discovery",
    "fact_refresh",
    "installation_reconcile",
    "ping",
  ]);
});

Deno.test("an authorization event has no installation to route to", () => {
  const event = supported(
    "github_app_authorization",
    payloads.github_app_authorization,
  );
  assertEquals(classifyEvent(event), "installation_reconcile");
  assertEquals(projectEvent(event).installationId, null);
});

Deno.test("projection summarizes each event in ids, a number and a commit only", () => {
  const project = (eventName: string, payload: unknown) =>
    projectEvent(supported(eventName, payload));
  const nothing = {
    action: null,
    installationId: null,
    repositoryId: null,
    number: null,
    headSha: null,
  };
  assertEquals(project("ping", payloads.ping), nothing);
  assertEquals(project("ping", payloads.pingWithInstallation), {
    ...nothing,
    installationId: 42,
  });
  assertEquals(project("installation", payloads.installation), {
    ...nothing,
    action: "suspend",
    installationId: 42,
  });
  assertEquals(
    project("installation_repositories", payloads.installation_repositories),
    { ...nothing, action: "added", installationId: 42 },
  );
  assertEquals(
    project("github_app_authorization", payloads.github_app_authorization),
    { ...nothing, action: "revoked" },
  );
  assertEquals(project("repository", payloads.repository), {
    ...nothing,
    action: "renamed",
    installationId: 42,
    repositoryId: 1296269,
  });
  assertEquals(project("issues", payloads.issues), {
    ...nothing,
    action: "labeled",
    installationId: 42,
    repositoryId: 1296269,
    number: 1347,
  });
  assertEquals(project("pull_request", payloads.pull_request), {
    ...nothing,
    action: "synchronize",
    installationId: 42,
    repositoryId: 1296269,
    number: 9,
    headSha: SHA,
  });
  assertEquals(project("check_run", payloads.check_run), {
    ...nothing,
    action: "completed",
    installationId: 42,
    repositoryId: 1296269,
    headSha: SHA,
  });
  assertEquals(project("check_suite", payloads.check_suite), {
    ...nothing,
    action: "requested",
    installationId: 42,
    repositoryId: 1296269,
    headSha: OTHER_SHA,
  });
});

Deno.test("projection never carries repository text", () => {
  const event = supported("issues", payloads.issues);
  const serialized = JSON.stringify(projectEvent(event));
  assertFalse(serialized.includes("secret repository text"));
  assertFalse(serialized.includes("Found a bug"));
  assertEquals(
    Object.keys(projectEvent(event)).sort(),
    ["action", "headSha", "installationId", "number", "repositoryId"],
  );
});

Deno.test("projection cuts every string to 256 characters", () => {
  assertEquals(PROJECTION_MAX_STRING, 256);
  const issues = supported("issues", payloads.issues);
  const longAction = projectEvent({ ...issues, action: "x".repeat(1000) });
  assertEquals(longAction.action?.length, 256);

  const pull = supported("pull_request", payloads.pull_request);
  assert(pull.eventName === "pull_request");
  const longSha = projectEvent({
    ...pull,
    action: "y".repeat(300),
    payload: {
      ...pull.payload,
      pull_request: {
        ...pull.payload.pull_request,
        head: { sha: "f".repeat(1000) },
      },
    },
  });
  assertEquals(longSha.action?.length, 256);
  assertEquals(longSha.headSha?.length, 256);

  const exact = projectEvent({ ...issues, action: "z".repeat(256) });
  assertEquals(exact.action, "z".repeat(256));

  for (const eventName of SUPPORTED_EVENTS) {
    const projection = projectEvent(supported(eventName, payloads[eventName]));
    for (const value of Object.values(projection)) {
      if (typeof value === "string") assert(value.length <= 256);
    }
  }
  assertFalse(
    IntakeProjectionSchema.safeParse({
      action: "a".repeat(257),
      installationId: null,
      repositoryId: null,
      number: null,
      headSha: null,
    }).success,
  );
});

Deno.test("a pull request item is any issue-list item with a pull_request key", () => {
  assertFalse(isPullRequestItem({ number: 1, state: "open" }));
  assertFalse(isPullRequestItem({}));
  assert(
    isPullRequestItem({
      number: 2,
      pull_request: { url: "https://api.github.com/repos/o/r/pulls/2" },
    }),
  );
  // Key presence decides: a pull request is never admitted as an issue.
  assert(isPullRequestItem({ number: 3, pull_request: null }));
  assert(isPullRequestItem({ number: 4, pull_request: {} }));
  // Inherited properties do not count.
  assertFalse(isPullRequestItem(Object.create({ pull_request: {} })));
});

Deno.test("every payload schema and every field carries a meaningful description", () => {
  assertEquals(
    Object.keys(INTAKE_PAYLOAD_SCHEMAS).sort(),
    [...SUPPORTED_EVENTS].sort(),
  );
  const defects: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (typeof node !== "object" || node === null) return;
    const schema = node as { description?: unknown; properties?: unknown };
    const defect = descriptionDefectKind(schema.description, path);
    if (defect !== undefined) defects.push(`${path}: ${defect}`);
    if (typeof schema.properties === "object" && schema.properties !== null) {
      for (const [name, child] of Object.entries(schema.properties)) {
        visit(child, `${path}.${name}`);
      }
    }
  };
  for (const [eventName, schema] of Object.entries(INTAKE_PAYLOAD_SCHEMAS)) {
    visit(z.toJSONSchema(schema), `schema.${eventName}`);
  }
  visit(z.toJSONSchema(IntakeProjectionSchema), "schema.projection");
  assertEquals(defects, []);
});
