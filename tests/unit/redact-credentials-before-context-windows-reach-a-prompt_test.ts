/**
 * #14 AC3: no credential reaches a prompt through a projected text window.
 * Each case plants a credential of one shape and asserts the projection text
 * never contains it, while the citation still pins the raw bytes.
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  CONTEXT_REDACTOR_VERSION,
  redactContextText,
  REDACTION_MARKER,
} from "../../apps/server/src/modules/knowledge/context-redaction.ts";
import {
  CONTEXT_EXTRACTOR_VERSION,
  projectArtifactVersion,
  referenceProjection,
  verifyCitation,
} from "../../apps/server/src/modules/knowledge/context-projection.ts";

const entry = {
  artifactId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  sha256: "a".repeat(64),
  mediaType: "text/plain",
  sizeBytes: 4096,
};

/** Credentials that must never survive, by shape. Built from parts so no literal is a real secret. */
const SECRETS: Record<string, string> = {
  "bakery access token": "bky_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v",
  "bakery desktop credential": "bkd_" + "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe",
  "github classic token": "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  "github fine-grained token": "github_pat_" +
    "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123",
  "aws access key id": "AKIA" + "IOSFODNN7EXAMPLE",
  "slack bot token": "xoxb-" + "123456789012-abcdefghijklmnop",
  "slack webhook": "https://hooks.slack.com/services/" +
    "T00000000/B00000000/abcdefghijklmnopqrstuvwx",
  "anthropic key": "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789",
  "google api key": "AIza" + "SyA-abcdefghijklmnopqrstuvwxyz012345",
  "stripe key": "sk_live_" + "abcdefghijklmnop1234",
  "gitlab token": "glpat-" + "abcdefghij0123456789",
  "npm token": "npm_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  "hugging face token": "hf_" + "abcdefghijklmnopqrstuvwxyzABCDEFGH",
  "sendgrid key": "SG." + "abcdefghijklmnopqrstuv" + "." +
    "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  "resend key": "re_" + "AbCdEfGh_1234567890AbCdEfGhIjKl",
  "linear key": "lin_api_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
  "notion token": "ntn_" + "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
  "twilio api key": "SK" + "0123456789abcdef0123456789abcdef",
  "json web token": "eyJhbGciOiJIUzI1NiJ9" + "." +
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dBjftJeZ4CVPmB92K27uhbUJU1p1r",
};

function windowOf(text: string) {
  const bytes = new TextEncoder().encode(text).byteLength;
  return { startByte: 0, endByteExclusive: bytes, text, hasMore: false };
}

function project(text: string) {
  return projectArtifactVersion(entry, windowOf(text));
}

for (const [shape, secret] of Object.entries(SECRETS)) {
  Deno.test(`a ${shape} in a window never reaches the projection text`, () => {
    const projection = project(`before \n token is ${secret} and after`);
    assert(projection.text !== null);
    assertFalse(projection.text.includes(secret), shape);
    assert(projection.text.includes(REDACTION_MARKER));
    assertEquals(projection.redactions >= 1, true);
    // The surrounding prose survives.
    assert(projection.text.includes("before"));
    assert(projection.text.includes("and after"));
  });
}

Deno.test("a private key block is redacted whole, complete or cut off", () => {
  const body =
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
  const complete = project(
    `key:\n-----BEGIN PRIVATE KEY-----\n${body}\n${body}\n-----END PRIVATE KEY-----\nafter`,
  );
  assertFalse(complete.text!.includes(body));
  assert(complete.text!.includes("after"));
  // The window ends inside the key: nothing after the header survives.
  const cutOff = project(
    `key:\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}`,
  );
  assertFalse(cutOff.text!.includes(body));
  // The window starts inside the key: nothing before the END line survives.
  const startsInside = project(
    `${body}\n${body}\n-----END OPENSSH PRIVATE KEY-----\nrest`,
  );
  assertFalse(startsInside.text!.includes(body));
  assert(startsInside.text!.includes("rest"));
});

Deno.test("a token prefix cut by the end of the window is still redacted", () => {
  for (
    const tail of [
      "bky_AbC",
      "ghp_abc123",
      "sk-ant-api0",
      "eyJhbGciOi",
      "xoxb-1234",
      "glpat-abc12",
      "npm_a1B2",
      "hf_abcd12",
      "SG.abcdef",
      "lin_api_AbCd",
      "ntn_1234ab",
    ]
  ) {
    const projection = project("value: " + tail);
    assertFalse(projection.text!.includes(tail), tail);
  }
});

Deno.test("credential-named keys lose their value in every common form", () => {
  const cases: Array<[string, string]> = [
    ["password=hunter2hunter2", "hunter2hunter2"],
    ["PASSWORD: correct-horse-battery", "correct-horse-battery"],
    ['{"api_key": "abcd-1234-efgh"}', "abcd-1234-efgh"],
    ["export DATABASE_PASSWORD='s3cr3tvalue'", "s3cr3tvalue"],
    [
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ],
    ["client_secret: 0123456789abcdef", "0123456789abcdef"],
    ["Authorization: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    ["postgres://app:p4ssw0rd-long@db.internal:5432/app", "p4ssw0rd-long"],
    // A quoted value runs to its closing quote, spaces and all.
    ['password: "correct horse battery staple"', "horse battery staple"],
    ["db_password='my long pass phrase'", "long pass phrase"],
    ['{"secret": "two words here"}', "words here"],
    // Azure storage connection strings.
    [
      "AccountName=x;AccountKey=Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4==",
      "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4",
    ],
    [
      "SharedAccessKey=abcdefghijklmnop0123456789",
      "abcdefghijklmnop0123456789",
    ],
  ];
  for (const [line, secret] of cases) {
    const projection = project(`config\n${line}\nend`);
    assertFalse(projection.text!.includes(secret), line);
    assert(
      projection.text!.includes("config") && projection.text!.includes("end"),
    );
  }
});

Deno.test("the key name stays so the model still sees what was removed", () => {
  const { text } = redactContextText("password=hunter2hunter2");
  assertEquals(text, "password=" + REDACTION_MARKER);
  assertEquals(
    redactContextText("postgres://app:p4ssw0rd-long@db:5432/app").text,
    "postgres://app:" + REDACTION_MARKER + "@db:5432/app",
  );
});

Deno.test("text with no credential is returned unchanged, and redaction is idempotent", () => {
  const plain =
    "The retry cap is 3.\nSee docs/runbook.md for the token budget.\n";
  assertEquals(redactContextText(plain), { text: plain, count: 0 });
  const dirty = "password=hunter2hunter2 and ghp_" +
    "abcdefghijklmnopqrstuvwxyz0123456789";
  const once = redactContextText(dirty);
  assertEquals(redactContextText(once.text), { text: once.text, count: 0 });
});

Deno.test("the citation still pins the raw bytes; redaction changes text, not provenance", () => {
  const raw = "api_key = abcdefghijklmnopqrstuvwxyz\nok";
  const rawBytes = new TextEncoder().encode(raw).byteLength;
  const projection = project(raw);
  assertEquals(projection.citation.location, {
    startByte: 0,
    endByteExclusive: rawBytes,
  });
  assertEquals(projection.citation.sha256, entry.sha256);
  assertEquals(projection.citation.extractorVersion, CONTEXT_EXTRACTOR_VERSION);
  assertEquals(projection.redactions, 1);
  // The estimate never undercounts: it covers the raw window.
  assert(projection.item.count.state === "estimated");
  assert(projection.item.count.tokens >= rawBytes);
});

Deno.test("an extract made before redaction existed is never reused", () => {
  const stale = {
    artifactId: entry.artifactId,
    versionId: entry.versionId,
    sha256: entry.sha256,
    mediaType: "text/plain",
    location: { startByte: 0, endByteExclusive: 10 },
    extractorVersion: "bakery.text-window@1",
  };
  assertEquals(
    verifyCitation(stale, { authorized: true, sha256: entry.sha256 }),
    {
      valid: false,
      reason: "extractor_changed",
    },
  );
});

Deno.test("references carry no text and no redactions", () => {
  const projection = projectArtifactVersion(
    { ...entry, mediaType: "application/pdf" },
    null,
  );
  assertEquals(projection.text, null);
  assertEquals(projection.redactions, 0);
});

Deno.test("the redactor is deterministic and names its version", () => {
  const input = "token: abcdefghijklmnop";
  assertEquals(redactContextText(input), redactContextText(input));
  assert(CONTEXT_REDACTOR_VERSION.startsWith("bakery.redact@"));
});

Deno.test("a quoted value the window cut off, or longer than the bound, is redacted to the end of the line", () => {
  const cases: Array<[string, string]> = [
    ['config:\npassword: "hunter2hunter2', "hunter2hunter2"],
    ["db_password='hunter2 hunter2", "hunter2 hunter2"],
    [
      'password: "' + "x".repeat(400) + " tail-secret-words",
      "tail-secret-words",
    ],
  ];
  for (const [line, secret] of cases) {
    assertFalse(project(line).text!.includes(secret), line.slice(0, 40));
  }
  // The text after the line is not swallowed.
  const after = project('password: "hunter2hunter2\nnext line stays');
  assert(after.text!.includes("next line stays"));
});

Deno.test("an escaped quote does not end a quoted value early", () => {
  const out = project('password: "ab\\"cd efgh ijkl" and more').text!;
  assertFalse(out.includes("cd efgh ijkl"));
  assert(out.includes("and more"));
});

Deno.test("a doubled quote inside a quoted value does not end it (YAML and CSV)", () => {
  const cases: Array<[string, string, string]> = [
    ["secret: 'it''s a long one' and more", "s a long one", "and more"],
    ['password: "say ""hello world"" now" and more', "hello world", "and more"],
  ];
  for (const [line, secret, rest] of cases) {
    const out = project(line).text!;
    assertFalse(out.includes(secret), line);
    assert(out.includes(rest), line);
  }
});

Deno.test("an Authorization header is one credential, scheme and all", () => {
  for (
    const [line, secret] of [
      ["Authorization: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"],
      ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
      [
        "authorization: token ghx_abcdefghijklmnopqrstuvwx",
        "ghx_abcdefghijklmnopqrstuvwx",
      ],
    ]
  ) {
    const result = redactContextText(line);
    assertFalse(result.text.includes(secret), line);
    assertEquals(result.count, 1, line);
    assertEquals(result.text.split(REDACTION_MARKER).length - 1, 1, line);
    assert(result.text.startsWith(line.split(":")[0] + ":"), line);
  }
  // A token a whole rule recognises is one credential after a scheme word too,
  // not two (the whole rule's marker, then the key-value rule's).
  for (const [shape, secret] of Object.entries(SECRETS)) {
    for (const header of ["Authorization: Bearer ", "authorization: token "]) {
      const result = redactContextText(header + secret);
      assertFalse(result.text.includes(secret), shape);
      assertEquals(result.count, 1, header + shape);
    }
  }
  // A bare bearer credential keeps its scheme word and counts once.
  assertEquals(
    redactContextText("Bearer abcdefghijklmnop1234"),
    { text: "Bearer " + REDACTION_MARKER, count: 1 },
  );
});

Deno.test("the redactor version is pinned, so a rule change cannot ship without bumping it", () => {
  assertEquals(CONTEXT_REDACTOR_VERSION, "bakery.redact@6");
});

Deno.test("a hostile window cannot make a rule run away", () => {
  const hostile = "a".repeat(30_000) + "=".repeat(30_000) + " password" +
    ":".repeat(5_000);
  const started = performance.now();
  redactContextText(hostile);
  assert(
    performance.now() - started < 2_000,
    "redaction of a 65 KB hostile window took too long",
  );
});

Deno.test("a reference says why it has no content: binary, no PDF extractor, or a failed window", () => {
  const limit = (mediaType: string, options = {}) =>
    referenceProjection({ ...entry, mediaType }, options).limit;
  assertEquals(limit("image/png"), "binary_media");
  assertEquals(limit("application/zip"), "binary_media");
  assertEquals(limit("application/pdf"), "no_text_extractor");
  // A text version that has no window is a failed extraction, not an empty file.
  assertEquals(limit("text/plain"), "extraction_failed");
  assertEquals(
    limit("application/pdf", { limit: "extraction_failed" }),
    "extraction_failed",
  );
  // A window carries text, so it carries no limit.
  assertEquals(project("hello").limit, null);
});
