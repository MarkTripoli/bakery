import { assert, assertEquals } from "@std/assert";
import {
  createTelemetryRedactor,
  TELEMETRY_ATTRIBUTE_NAMES,
} from "../../packages/config/src/telemetry-attributes.ts";
import {
  type AlphabetName,
  alphabets,
  credentialShapes,
  draw,
  seeded,
  splitInThree,
} from "../helpers/telemetry-fragments.ts";
import {
  formatTraceparent,
  parseTraceparent,
} from "../../packages/config/src/telemetry-trace.ts";

// AC2: credentials, prompts, diffs or split secret chunks in error or output
// paths never reach a sink. Every case below is tried in every field it could
// try to ride in, and the whole result is searched for the sentinel afterwards,
// so a value that survives under any key fails the test.

const uuid = "0b9a1f0e-5a3c-4c1e-8f6a-2d4b7c9e1a30";

/** The filter as a consumer would build it, with names that resemble no credential. */
const vocabulary = {
  actions: ["agents.list", "installation.seats.get"],
  providerCategories: ["model", "git"],
  outcomes: ["AUTH_FORBIDDEN", "TIMEOUT"],
};
const redactTelemetryAttributes = createTelemetryRedactor(vocabulary);

/** Registered fields whose value is a string a call site could get wrong. */
const textFields = [
  "bakery.run.id",
  "bakery.attempt.id",
  "bakery.job.id",
  "bakery.task.id",
  "bakery.repository.id",
  "bakery.step.key",
  "bakery.action",
  "bakery.provider.category",
  "bakery.outcome",
  "bakery.actor.hash",
] as const;

/**
 * Joins fragments at run time. A credential-shaped literal in the source would
 * trip push protection and any secret scanner, so each fixture is assembled
 * from pieces that match no provider format on their own.
 */
const assemble = (...parts: string[]) => parts.join("");

/** Credentials in the shapes real providers issue. None is a real secret. */
const credentials = {
  githubClassic: assemble("gh", "p_", "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5"),
  githubFineGrained: assemble(
    "github",
    "_pat_",
    "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJ",
  ),
  anthropic: assemble(
    "sk",
    "-ant-",
    "api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  ),
  slack: assemble(
    "xo",
    "xb-",
    "123456789012-",
    "1234567890123-",
    "AbCdEfGhIjKl",
  ),
  aws: assemble("AK", "IA", "IOSFODNN7EXAMPLE"),
  jwt: assemble(
    "ey",
    "JhbGciOiJIUzI1NiJ9.",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ),
  pem: assemble(
    "-----",
    "BEGIN PRIVATE KEY",
    "-----",
    "MIIEvQIBADANBgkqhkiG9w0B",
  ),
  bearer: assemble("Bear", "er ", "3f9c1e7a5b2d4f6a8c0e1b3d5f7a9c2e"),
  urlWithPassword: assemble(
    "https",
    "://deploy:",
    "hunter2@",
    "git.example.test/org/repo.git",
  ),
  base64Blob: "dGhpcyBpcyBhIHNlY3JldCB0b2tlbiBmb3IgdGVzdHM=",
  mixedToken: "zk3Lq9Xv2Rt7Yb5Nm1Cp8Hd4Wg6Sf0Ja2Ue9Ko",
  hexToken: "a9f86d081884c7d659a2feaa0c55ad015a3bf4f1",
};

/** Prose and code that an error, a prompt or an output stream carries. */
const content = {
  prompt: "Summarize the attached contract and email it to the customer",
  diff:
    "diff --git a/.env b/.env\n@@ -1 +1 @@\n-DATABASE_URL=old\n+DATABASE_URL=" +
    assemble("postgres", "://admin:", "s3cr3t@db/prod"),
  sourceCode: 'const apiKey = "abc123"; await fetch(url, { headers });',
  toolArguments: '{"path":"/etc/passwd","mode":"read"}',
  outputText: "stdout-before native-synthetic-secret stdout-after",
  errorMessage:
    "password authentication failed for user admin at 10.0.0.5:5432",
  stackTrace:
    "Error: boom\n    at run (file:///srv/app/worker.ts:41:11)\n    at main (file:///srv/app/main.ts:9:3)",
  header: "authorization: Bearer abc.def.ghi",
} as const;

function everywhere(values: Record<string, string>) {
  return Object.entries(values).flatMap(([label, value]) =>
    textFields.map((field) => ({ label, field, value }))
  );
}

Deno.test("a credential is refused in every field and never appears in the result", () => {
  let refused = 0;
  for (const { label, field, value } of everywhere(credentials)) {
    const result = redactTelemetryAttributes({ [field]: value });
    assertEquals(result.attributes, {}, `${label} in ${field}`);
    assertEquals(result.invalid, [field], `${label} in ${field}`);
    assert(
      !JSON.stringify(result).includes(value),
      `${label} leaked through ${field}`,
    );
    refused += 1;
  }
  assertEquals(refused, Object.keys(credentials).length * textFields.length);
});

Deno.test("prompts, diffs, source, tool arguments, output and errors have no field to ride in", () => {
  for (const { label, field, value } of everywhere(content)) {
    const result = redactTelemetryAttributes({ [field]: value });
    assertEquals(result.attributes, {}, `${label} in ${field}`);
    assert(
      !JSON.stringify(result).includes(value.slice(0, 12)),
      `${label} leaked through ${field}`,
    );
  }
  // Under names that are not registered, the same content is only counted.
  const unregistered = redactTelemetryAttributes({
    prompt: content.prompt,
    diff: content.diff,
    "error.message": content.errorMessage,
    "output.chunk": content.outputText,
    "exception.stacktrace": content.stackTrace,
    "http.request.header.authorization": content.header,
  });
  assertEquals(unregistered.attributes, {});
  assertEquals(unregistered.unregisteredCount, 6);
  const serialized = JSON.stringify(unregistered);
  for (const value of Object.values(content)) {
    assert(!serialized.includes(value.slice(0, 12)));
  }
  for (const name of ["prompt", "diff", "error.message", "authorization"]) {
    assert(!serialized.includes(name), `the name ${name} was echoed`);
  }
});

/**
 * Fragments of random credential-shaped material are fed to `bakery.step.key`,
 * the one open-ended string field, and the share it accepts is compared with a
 * stated bound. The generator is seeded, so the numbers below are the numbers
 * every run produces; a bound is exceeded only when the rule changes.
 *
 * Measured and stated, in percent of random fragments accepted:
 *
 *   alphabet       len 4   len 8   len 12  len 16  len 24
 *   base62/64/url   <= 10    <= 1    <= .5   <= .1   <= .1
 *   hex             <= 40   <= 10   <= 1    <= .1   <= .1
 *   base36 lower    <= 75   <= 68   <= 48   <= 30   <= 8
 *   base32 lower    <= 83   <= 82   <= 73   <= 59   <= 31
 *
 * The last two rows are the known weakness: a lowercase identifier grammar
 * cannot tell a fragment of a lowercase token from a word. They are recorded,
 * not defended. A snake_case sentence passes for the same reason.
 */
const fragmentBounds: Record<AlphabetName, readonly number[]> = {
  base62: [10, 1, 0.5, 0.1, 0.1],
  base64: [10, 1, 0.5, 0.1, 0.1],
  base64url: [10, 1, 0.5, 0.1, 0.1],
  hex: [40, 10, 1, 0.1, 0.1],
  base36lower: [75, 68, 48, 30, 8],
  base32lower: [83, 82, 73, 59, 31],
};
const fragmentLengths = [4, 8, 12, 16, 24];

Deno.test("random fragments of a secret reach the step key only within the stated bounds", () => {
  const random = seeded(20261111);
  const samples = 5000;
  for (const name of Object.keys(alphabets) as AlphabetName[]) {
    fragmentLengths.forEach((length, column) => {
      let accepted = 0;
      for (let index = 0; index < samples; index += 1) {
        const fragment = draw(random, alphabets[name], length);
        if (
          "bakery.step.key" in
            redactTelemetryAttributes({ "bakery.step.key": fragment })
              .attributes
        ) {
          accepted += 1;
        }
      }
      const percent = (100 * accepted) / samples;
      assert(
        percent <= fragmentBounds[name][column],
        `${name} fragments of ${length}: ${
          percent.toFixed(2)
        }% accepted, bound ${fragmentBounds[name][column]}%`,
      );
    });
  }
});

/** What a three-way split of each credential format may leave in the step key. */
const splitBounds: Record<string, { any: number; all: number }> = {
  githubClassic: { any: 15, all: 0.1 },
  githubFineGrained: { any: 15, all: 0.1 },
  awsSecretKey: { any: 6, all: 0.1 },
  jwtLike: { any: 3, all: 0.1 },
  slackLike: { any: 7, all: 0.1 },
  hex40: { any: 30, all: 0.1 },
  hex64: { any: 22, all: 0.1 },
  // The known weakness, stated so that it cannot grow unnoticed.
  base36lower32: { any: 95, all: 12 },
  base32lower32: { any: 99, all: 33 },
};

Deno.test("a randomly split credential has every piece accepted by the step key only within the stated bounds, and none by a closed field", () => {
  const random = seeded(7);
  const secrets = 4000;
  assertEquals(
    Object.keys(splitBounds).sort(),
    Object.keys(credentialShapes).sort(),
  );
  for (const [shape, make] of Object.entries(credentialShapes)) {
    let anyPiece = 0;
    let allPieces = 0;
    for (let index = 0; index < secrets; index += 1) {
      const pieces = splitInThree(random, make(random));
      const accepted = pieces.map((piece) =>
        "bakery.step.key" in
          redactTelemetryAttributes({ "bakery.step.key": piece }).attributes
      );
      if (accepted.some(Boolean)) anyPiece += 1;
      if (accepted.every(Boolean)) allPieces += 1;
      // The closed fields take none of it: no piece is a name on the list.
      for (const piece of pieces) {
        const closed = redactTelemetryAttributes({
          "bakery.action": piece,
          "bakery.provider.category": piece,
          "bakery.outcome": piece,
        });
        assertEquals(
          Object.keys(closed.attributes),
          [],
          `${shape}: ${piece.length} chars`,
        );
      }
    }
    const any = (100 * anyPiece) / secrets;
    const all = (100 * allPieces) / secrets;
    assert(
      any <= splitBounds[shape].any,
      `${shape}: ${any.toFixed(2)}% had a piece accepted, bound ${
        splitBounds[shape].any
      }%`,
    );
    assert(
      all <= splitBounds[shape].all,
      `${shape}: ${all.toFixed(2)}% had every piece accepted, bound ${
        splitBounds[shape].all
      }%`,
    );
  }
});

Deno.test("a secret cut into the token's own prefix and body is refused piece by piece", () => {
  // The first chunk of a prefixed token is its prefix; it is not a step key
  // (it has an uppercase letter or a dash) and it is on no vocabulary.
  const random = seeded(99);
  for (let index = 0; index < 500; index += 1) {
    const secret = credentialShapes.githubFineGrained(random);
    const [first] = splitInThree(random, secret, 4);
    const result = redactTelemetryAttributes({
      "bakery.action": first,
      "bakery.provider.category": first,
      "bakery.outcome": first,
    });
    assertEquals(result.attributes, {});
    assert(!JSON.stringify(result).includes(first));
  }
});

Deno.test("a field whose name says it holds a secret is dropped and its name not echoed", () => {
  const sentinel = "sentinel-value-7c1f";
  const names = [
    "authorization",
    "Authorization",
    "cookie",
    "set-cookie",
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "client_secret",
    "password",
    "private_key",
    "credential",
    "credentials",
    "x-api-key",
    "api_key",
  ];
  const result = redactTelemetryAttributes(
    Object.fromEntries(names.map((name) => [name, sentinel])),
  );
  assertEquals(result.attributes, {});
  assertEquals(result.unregisteredCount, names.length);
  const serialized = JSON.stringify(result);
  assert(!serialized.includes(sentinel));
  for (const name of names) assert(!serialized.includes(`"${name}"`));
});

Deno.test("no registered field name could hold a secret, now or after an addition", () => {
  const forbidden =
    /authorization|cookie|token|secret|password|private[_-]?key|credential|api[_-]?key|session|bearer/i;
  for (const name of TELEMETRY_ATTRIBUTE_NAMES) {
    assert(!forbidden.test(name), `${name} reads as a credential field`);
  }
});

Deno.test("structured values are refused rather than inspected", () => {
  const nested = {
    "bakery.step.key": { token: credentials.githubClassic },
    "bakery.action": [credentials.githubClassic],
    "bakery.outcome": new Map([["token", credentials.githubClassic]]),
    "bakery.provider.category": new Date(0),
    "bakery.job.id": () => credentials.githubClassic,
    "bakery.run.id": Symbol(credentials.githubClassic),
    "bakery.task.id": 10n,
    "bakery.attempt.id": new String(uuid),
  };
  const result = redactTelemetryAttributes(nested);
  assertEquals(result.attributes, {});
  assertEquals(result.invalid.length, Object.keys(nested).length);
  assert(!JSON.stringify(result).includes(credentials.githubClassic));
});

Deno.test("a record is examined only up to a fixed number of fields", () => {
  const attacker: Record<string, unknown> = {};
  for (let index = 0; index < 50_000; index += 1) {
    attacker[`attacker${index}`] = index;
  }
  // A real field ahead of the flood is kept; one buried behind it is not read,
  // which is what keeps the work per record fixed whatever the input holds.
  const first = redactTelemetryAttributes({
    "bakery.task.id": uuid,
    ...attacker,
  });
  assertEquals(first.attributes, { "bakery.task.id": uuid });
  assertEquals(first.unregisteredCount, 50_000);

  const buried = redactTelemetryAttributes({
    ...attacker,
    "bakery.task.id": uuid,
  });
  assertEquals(buried.attributes, {});
  assertEquals(buried.unregisteredCount, 50_001);
});

Deno.test("trace context carries only ids, even when the header carries more", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";
  const hostile = `01-${traceId}-${spanId}-01-${credentials.githubClassic}`;
  const parsed = parseTraceparent(hostile);
  assertEquals(Object.keys(parsed ?? {}).sort(), [
    "sampled",
    "spanId",
    "traceId",
  ]);
  assert(!JSON.stringify(parsed).includes(credentials.githubClassic));
  assert(!formatTraceparent(parsed!).includes(credentials.githubClassic));
  assertEquals(formatTraceparent(parsed!), `00-${traceId}-${spanId}-01`);
});
