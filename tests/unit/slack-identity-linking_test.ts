import { createHmac } from "node:crypto";
import { assert, assertEquals } from "@std/assert";
import {
  SLACK_OIDC_ISSUER,
  type SlackIdentityExpectation,
  type SlackIdentityKey,
  verifySlackIdentityToken,
} from "../../apps/server/src/modules/integrations/slack-identity.ts";

// Linking a Slack user to a Bakery member is an authentication decision, so the
// token that proves it is checked the way an attacker would try to get past it:
// a forged algorithm, a confused key, a tampered claim, a replayed nonce, the
// wrong workspace. Every failure is a reason code that carries none of the
// token, and nothing here throws.

const encoder = new TextEncoder();
const NOW = 1_800_000_000_000; // ms
const NOW_S = NOW / 1000;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}
const segment = (value: unknown) =>
  base64url(encoder.encode(JSON.stringify(value)));

type Pair = {
  readonly privateKey: CryptoKey;
  readonly jwk: JsonWebKey;
};

async function rsaPair(bits = 2048): Promise<Pair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: bits,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pair.privateKey,
    jwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

const main = await rsaPair();
const other = await rsaPair();
const small = await rsaPair(1024);

const KID = "key-1";
const keyOf = (pair: Pair, kid = KID, extra: Partial<SlackIdentityKey> = {}) =>
  ({
    kty: "RSA",
    n: pair.jwk.n!,
    e: pair.jwk.e!,
    kid,
    alg: "RS256",
    use: "sig",
    ...extra,
  }) as SlackIdentityKey;
const keys = [keyOf(main)];

const expectation: SlackIdentityExpectation = {
  issuer: SLACK_OIDC_ISSUER,
  audience: "1234567890.0987654321",
  nonce: "nonce-bound-to-this-attempt-7f3a",
  teamId: "T0ABC123",
};

function validClaims(): Record<string, unknown> {
  return {
    iss: SLACK_OIDC_ISSUER,
    aud: expectation.audience,
    sub: "U0USER123",
    iat: NOW_S - 30,
    exp: NOW_S + 300,
    nonce: expectation.nonce,
    "https://slack.com/team_id": "T0ABC123",
    "https://slack.com/user_id": "U0USER123",
  };
}

async function sign(
  claims: unknown,
  options: {
    header?: Record<string, unknown>;
    pair?: Pair;
  } = {},
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: KID, ...options.header };
  const signingInput = `${segment(header)}.${segment(claims)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      (options.pair ?? main).privateKey,
      encoder.encode(signingInput),
    ),
  );
  return `${signingInput}.${base64url(signature)}`;
}

async function verify(
  token: unknown,
  overrides: Partial<SlackIdentityExpectation> = {},
  keySet: readonly SlackIdentityKey[] = keys,
  now = NOW,
) {
  return await verifySlackIdentityToken(
    token as string,
    { ...expectation, ...overrides },
    keySet,
    now,
  );
}

async function reasonOf(
  claims: Record<string, unknown>,
  overrides: Partial<SlackIdentityExpectation> = {},
): Promise<string> {
  const result = await verify(await sign(claims), overrides);
  assert(
    !result.ok,
    `accepted a token that must be refused: ${JSON.stringify(claims)}`,
  );
  return result.reason;
}

Deno.test("a valid token yields the workspace and the stable Slack user, and nothing from the token itself", async () => {
  const result = await verify(await sign(validClaims()));
  assert(result.ok);
  assertEquals(result.identity, {
    teamId: "T0ABC123",
    userId: "U0USER123",
    issuedAt: NOW_S - 30,
    expiresAt: NOW_S + 300,
  });
  assert(!("enterpriseId" in result.identity));
  assertEquals(Object.keys(result).sort(), ["identity", "ok"]);
});

Deno.test("an enterprise id is kept when the installation has the same one, and a mismatch either way is refused", async () => {
  const withEnterprise = {
    ...validClaims(),
    "https://slack.com/enterprise_id": "E0ENT1",
  };
  const ok = await verify(await sign(withEnterprise), {
    enterpriseId: "E0ENT1",
  });
  assert(ok.ok);
  assertEquals(ok.identity.enterpriseId, "E0ENT1");
  // The token names an enterprise the installation does not have.
  assertEquals(await reasonOf(withEnterprise), "wrong_workspace");
  // The installation has one and the token does not.
  assertEquals(
    await reasonOf(validClaims(), { enterpriseId: "E0ENT1" }),
    "wrong_workspace",
  );
  // A different one.
  assertEquals(
    await reasonOf(withEnterprise, { enterpriseId: "E0OTHER" }),
    "wrong_workspace",
  );
  assertEquals(
    await reasonOf({
      ...validClaims(),
      "https://slack.com/enterprise_id": "not-an-id",
    }, {
      enterpriseId: "E0ENT1",
    }),
    "malformed_identity",
  );
});

Deno.test("each claim that must match is refused when it does not, with its own reason", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["wrong issuer", { iss: "https://evil.example" }, "wrong_issuer"],
    [
      "issuer with a trailing slash",
      { iss: `${SLACK_OIDC_ISSUER}/` },
      "wrong_issuer",
    ],
    [
      "issuer in another case",
      { iss: SLACK_OIDC_ISSUER.toUpperCase() },
      "wrong_issuer",
    ],
    ["missing issuer", { iss: undefined }, "wrong_issuer"],
    ["wrong audience", { aud: "999.999" }, "wrong_audience"],
    ["audience array with another audience", {
      aud: [expectation.audience, "999.999"],
    }, "wrong_audience"],
    ["audience array without ours", { aud: ["999.999"] }, "wrong_audience"],
    ["empty audience array", { aud: [] }, "wrong_audience"],
    ["audience of the wrong type", { aud: 5 }, "wrong_audience"],
    ["missing audience", { aud: undefined }, "wrong_audience"],
    ["wrong nonce", { nonce: "another-attempts-nonce" }, "wrong_nonce"],
    ["nonce that is a prefix of the right one", {
      nonce: expectation.nonce.slice(0, -1),
    }, "wrong_nonce"],
    [
      "nonce with the right one as a prefix",
      { nonce: `${expectation.nonce}x` },
      "wrong_nonce",
    ],
    [
      "nonce in another case",
      { nonce: expectation.nonce.toUpperCase() },
      "wrong_nonce",
    ],
    ["empty nonce", { nonce: "" }, "wrong_nonce"],
    ["missing nonce", { nonce: undefined }, "wrong_nonce"],
    ["nonce of the wrong type", { nonce: 123 }, "wrong_nonce"],
    [
      "another workspace",
      { "https://slack.com/team_id": "T0OTHER9" },
      "wrong_workspace",
    ],
    [
      "missing workspace",
      { "https://slack.com/team_id": undefined },
      "wrong_workspace",
    ],
    [
      "workspace of the wrong type",
      { "https://slack.com/team_id": 5 },
      "wrong_workspace",
    ],
    [
      "workspace in another case",
      { "https://slack.com/team_id": "t0abc123" },
      "wrong_workspace",
    ],
    ["a user claim that contradicts the subject", {
      "https://slack.com/user_id": "U0OTHER99",
    }, "wrong_user"],
  ];
  for (const [name, change, reason] of cases) {
    assertEquals(await reasonOf({ ...validClaims(), ...change }), reason, name);
  }
});

Deno.test("the subject has to be a Slack user id; a handle, an email or a name proves nothing", async () => {
  for (
    const sub of [
      "alice",
      "alice@example.com",
      "@alice",
      "Alice Example",
      "u0user123",
      "U",
      "",
      "U0USER123 ",
      "U0USER123\n",
      "U".repeat(40),
      "C0CHANNEL1",
      "T0ABC123",
      "BOTUSER1",
      "../../etc/passwd",
      5,
      null,
      undefined,
      ["U0USER123"],
    ]
  ) {
    const claims = { ...validClaims(), sub, "https://slack.com/user_id": sub };
    if (sub === undefined) {
      delete (claims as Record<string, unknown>)["https://slack.com/user_id"];
    }
    assertEquals(
      await reasonOf(claims),
      "malformed_identity",
      JSON.stringify(sub),
    );
  }
  // A workspace-scoped user id (W) is a Slack user too.
  const ok = await verify(
    await sign({
      ...validClaims(),
      sub: "W0USER123",
      "https://slack.com/user_id": "W0USER123",
    }),
  );
  assert(ok.ok);
  assertEquals(ok.identity.userId, "W0USER123");
  // The user claim may be absent; the subject alone identifies.
  const bare = validClaims();
  delete bare["https://slack.com/user_id"];
  assert((await verify(await sign(bare))).ok);
});

Deno.test("time: a token is valid inside its window with a small allowance, and not outside it", async () => {
  const at = (claims: Record<string, unknown>, now = NOW) =>
    sign({ ...validClaims(), ...claims }).then((t) => verify(t, {}, keys, now));
  // Expiry: inside, on the edge, within the skew allowance, then past it.
  assert((await at({ exp: NOW_S + 1 })).ok);
  assert(
    (await at({ exp: NOW_S })).ok,
    "an exp at this very second is still inside the allowance",
  );
  assert((await at({ exp: NOW_S - 30 })).ok, "30 s of clock skew is allowed");
  for (const exp of [NOW_S - 61, NOW_S - 3600, 0, -1]) {
    const result = await at({ exp });
    assert(!result.ok && result.reason === "expired", `exp ${exp}`);
  }
  // Issued in the future beyond the allowance.
  assert((await at({ iat: NOW_S + 30 })).ok);
  const future = await at({ iat: NOW_S + 61 });
  assert(!future.ok && future.reason === "not_yet_valid");
  // Issued too long ago, however long its exp says it lives.
  assert((await at({ iat: NOW_S - 600, exp: NOW_S + 3000 })).ok);
  const stale = await at({ iat: NOW_S - 601, exp: NOW_S + 3000 });
  assert(!stale.ok && stale.reason === "too_old");
  // Missing and malformed times.
  for (const claims of [{ exp: undefined }, { iat: undefined }]) {
    const result = await at(claims);
    assert(!result.ok && result.reason === "malformed", JSON.stringify(claims));
  }
  for (
    const bad of [
      "1800000100",
      Number.NaN,
      Infinity,
      -Infinity,
      null,
      {},
      [],
      true,
    ]
  ) {
    for (const field of ["exp", "iat"]) {
      const token = await sign({ ...validClaims(), [field]: bad });
      const result = await verify(token);
      assert(
        !result.ok && result.reason === "malformed",
        `${field}=${String(bad)}`,
      );
    }
  }
  // The clock itself is not trusted blindly either.
  for (const now of [Number.NaN, Infinity, -1]) {
    const result = await verify(await sign(validClaims()), {}, keys, now);
    assert(!result.ok, `now=${now}`);
  }
});

Deno.test("an algorithm other than RS256 is refused, including none and the key-confusion attack", async () => {
  const claims = validClaims();
  const forge = (header: Record<string, unknown>, signature: string) =>
    `${segment(header)}.${segment(claims)}.${signature}`;
  // alg none, with and without a signature segment's content.
  for (const alg of ["none", "None", "NONE", "nOnE"]) {
    for (const signature of ["", "AAAA", base64url(new Uint8Array(256))]) {
      const result = await verify(
        forge({ alg, typ: "JWT", kid: KID }, signature),
      );
      assert(!result.ok, `alg ${alg} accepted`);
      // With no signature segment at all the token is malformed before its
      // algorithm is looked at; either way it is refused.
      assertEquals(
        result.reason,
        signature === "" ? "malformed" : "unsupported_algorithm",
        `alg ${alg}, signature ${signature.slice(0, 4)}`,
      );
    }
  }
  // HS256 signed with the public key's bytes as the shared secret: the classic
  // confusion that makes a verifier use the public key as an HMAC secret.
  for (
    const secret of [
      main.jwk.n!,
      JSON.stringify(keys[0]),
      `${main.jwk.n}${main.jwk.e}`,
    ]
  ) {
    const input = `${segment({ alg: "HS256", typ: "JWT", kid: KID })}.${
      segment(claims)
    }`;
    const mac = createHmac("sha256", secret).update(input).digest();
    const result = await verify(`${input}.${base64url(new Uint8Array(mac))}`);
    assert(!result.ok);
    assertEquals(result.reason, "unsupported_algorithm");
  }
  for (
    const alg of [
      "HS256",
      "HS512",
      "RS384",
      "RS512",
      "PS256",
      "ES256",
      "EdDSA",
      "",
      5,
      null,
      undefined,
      ["RS256"],
    ]
  ) {
    const result = await verify(forge({ alg, typ: "JWT", kid: KID }, "AAAA"));
    assert(
      !result.ok && result.reason === "unsupported_algorithm",
      `alg ${String(alg)}`,
    );
  }
  // RS256 with the right name in another case is not RS256.
  assertEquals(
    (await verify(forge({ alg: "rs256", kid: KID }, "AAAA"))).ok,
    false,
  );
});

Deno.test("header members that would make a verifier fetch or trust its own key are refused", async () => {
  for (
    const extra of [
      { jku: "https://evil.example/keys.json" },
      { jwk: { kty: "RSA", n: keys[0].n, e: keys[0].e } },
      { x5u: "https://evil.example/cert" },
      { x5c: ["AAAA"] },
      { crit: ["exp"] },
      { "b64": false },
    ]
  ) {
    const token = await sign(validClaims(), { header: extra });
    const result = await verify(token);
    assert(!result.ok, `accepted a header with ${Object.keys(extra)[0]}`);
    assertEquals(result.reason, "malformed");
  }
  // A harmless header member is not a reason to refuse an otherwise good token.
  const benign = await verify(
    await sign(validClaims(), { header: { typ: "JWT", cty: "x" } }),
  );
  assert(
    benign.ok,
    "a header member that cannot change which key is used must be allowed",
  );
});

Deno.test("only a key Slack published for this kid can verify, and only a strong RSA signing key", async () => {
  const token = await sign(validClaims());
  assertEquals((await verify(token, {}, [])).ok, false);
  // The signature is by another key under the same kid.
  const forged = await sign(validClaims(), { pair: other });
  const forgedResult = await verify(forged);
  assert(!forgedResult.ok);
  assertEquals(forgedResult.reason, "bad_signature");
  // Unknown or missing kid.
  for (const kid of ["key-2", "", "KEY-1", " key-1", undefined, 5, null]) {
    const result = await verify(await sign(validClaims(), { header: { kid } }));
    assert(!result.ok && result.reason === "unknown_key", `kid ${String(kid)}`);
  }
  const noKid = `${segment({ alg: "RS256", typ: "JWT" })}.${
    segment(validClaims())
  }.AAAA`;
  assertEquals((await verify(noKid)).ok, false);
  // The matching key is not usable: wrong type, wrong purpose, wrong algorithm, too small.
  const ineligible: SlackIdentityKey[] = [
    keyOf(main, KID, { kty: "EC" } as never),
    keyOf(main, KID, { use: "enc" }),
    keyOf(main, KID, { alg: "RS512" }),
    keyOf(small, KID),
    { ...keyOf(main), n: undefined } as never,
    { ...keyOf(main), e: "AA" },
    { ...keyOf(main), n: "***not base64url***" },
  ];
  for (const key of ineligible) {
    const result = await verify(token, {}, [key]);
    assert(
      !result.ok && result.reason === "unknown_key",
      JSON.stringify(key).slice(0, 60),
    );
  }
  // A key that is only ineligible when it is the first with that kid does not
  // hide a good one that follows.
  assert((await verify(token, {}, [keyOf(small, KID), keyOf(main, KID)])).ok);
  // And a 1024-bit signature is refused even though the key is "valid RSA".
  const weak = await sign(validClaims(), { pair: small });
  assertEquals((await verify(weak, {}, [keyOf(small)])).ok, false);
});

Deno.test("any change to the token, in any character, makes it fail", async () => {
  const token = await sign(validClaims());
  const base64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let checked = 0;
  // Every character position, replaced by a different valid base64url character.
  for (let index = 0; index < token.length; index += 1) {
    if (token[index] === ".") continue;
    const replacement =
      base64[(base64.indexOf(token[index]) + 1 + (index % 7)) % 64];
    if (replacement === token[index]) continue;
    const changed = `${token.slice(0, index)}${replacement}${
      token.slice(index + 1)
    }`;
    const result = await verify(changed);
    assert(!result.ok, `a change at character ${index} was accepted`);
    checked += 1;
  }
  assert(checked > 600, `only ${checked} positions checked`);
});

Deno.test("claims cannot be swapped under a signature made for other claims", async () => {
  const good = await sign(validClaims());
  const other_ = await sign({
    ...validClaims(),
    sub: "U0ATTACK1",
    "https://slack.com/user_id": "U0ATTACK1",
  });
  const [header, , signature] = good.split(".");
  const [, payload] = other_.split(".");
  assertEquals((await verify(`${header}.${payload}.${signature}`)).ok, false);
  // Another signature on this payload: the header is the other half.
  const [, , otherSignature] = other_.split(".");
  assertEquals(
    (await verify(`${header}.${good.split(".")[1]}.${otherSignature}`)).ok,
    false,
  );
});

Deno.test("the encoding is strict: padding, standard base64, whitespace, a short or long signature and extra segments are all refused", async () => {
  // A run of > guarantees the payload's base64url has "-" in it, which the
  // standard alphabet spells "+"; without one the swap below would change nothing.
  const token = await sign({ ...validClaims(), pad: ">".repeat(15) });
  const [header, payload, signature] = token.split(".");
  assert(
    /[-_]/.test(payload),
    "the test needs a payload with url-safe characters",
  );
  assert((await verify(token)).ok, "the unmodified token must be good");
  const refused: Array<[string, string]> = [
    ["padding on the payload", `${header}.${payload}=.${signature}`],
    ["padding on the signature", `${header}.${payload}.${signature}==`],
    [
      "standard base64 characters",
      `${header}.${
        payload.replaceAll("-", "+").replaceAll("_", "/")
      }.${signature}`,
    ],
    ["a trailing newline", `${token}\n`],
    ["a leading space", ` ${token}`],
    [
      "a space inside",
      `${header}.${payload.slice(0, 5)} ${payload.slice(5)}.${signature}`,
    ],
    ["a truncated signature", `${header}.${payload}.${signature.slice(0, -4)}`],
    ["a lengthened signature", `${header}.${payload}.${signature}AAAA`],
    ["an empty signature", `${header}.${payload}.`],
    ["two segments", `${header}.${payload}`],
    ["four segments", `${token}.AAAA`],
    ["one segment", header],
    ["empty segments", ".."],
    ["a unicode character", `${header}.${payload}é.${signature}`],
    ["a NUL byte", `${header}.${payload}\u0000.${signature}`],
    ["an extra character in the payload", `${header}.${payload}A.${signature}`],
  ];
  for (const [name, bad] of refused) {
    const result = await verify(bad);
    assert(!result.ok, `accepted: ${name}`);
  }
  // A 256-byte signature is 342 base64url characters, and the last one carries
  // four bits of data and two bits that must be zero. A character that differs
  // only in those two bits decodes to the same bytes, so a lenient decoder would
  // accept two spellings of one signature; this one must accept only one.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = signature.at(-1)!;
  const sibling = alphabet.split("").find((c) =>
    c !== last && alphabet.indexOf(c) >> 2 === alphabet.indexOf(last) >> 2
  )!;
  assert(sibling !== undefined, "the test needs a sibling spelling");
  assertEquals(
    (await verify(`${header}.${payload}.${signature.slice(0, -1)}${sibling}`))
      .ok,
    false,
    "a non-canonical spelling of the same signature bytes must not verify",
  );
});

Deno.test("structurally hostile tokens are refused, not thrown", async () => {
  const header = segment({ alg: "RS256", typ: "JWT", kid: KID });
  const hostile: unknown[] = [
    undefined,
    null,
    5,
    {},
    [],
    true,
    "",
    "a".repeat(100_000),
    "a.".repeat(50_000),
    `${segment("not an object")}.${segment(validClaims())}.AAAA`,
    `${segment([1, 2])}.${segment(validClaims())}.AAAA`,
    `${segment(null)}.${segment(validClaims())}.AAAA`,
    `${header}.${segment("a string")}.AAAA`,
    `${header}.${segment([1])}.AAAA`,
    `${header}.${segment(null)}.AAAA`,
    `${header}.${base64url(new Uint8Array([0xff, 0xfe, 0x80]))}.AAAA`,
    `${base64url(encoder.encode("{not json"))}.${segment(validClaims())}.AAAA`,
    `${header}.${base64url(encoder.encode("{not json"))}.AAAA`,
    `${header}.${
      base64url(encoder.encode(`{"iat":1,"exp":2,"__proto__":{"x":1}}`))
    }.AAAA`,
  ];
  for (const token of hostile) {
    const result = await verify(token);
    assert(!result.ok, `accepted ${String(token).slice(0, 40)}`);
  }
  // Prototype pollution through the payload does not leak into a later result.
  assertEquals(({} as Record<string, unknown>).x, undefined);
  // Hostile keys and expectations do not throw either.
  const token = await sign(validClaims());
  for (
    const keySet of [
      [null],
      [undefined],
      [5],
      ["key"],
      [{}],
      [{ kid: KID }],
      [{ kid: KID, kty: "RSA" }],
      [{ kid: KID, kty: "RSA", n: 5, e: 5 }],
      null,
      undefined,
      "keys",
    ]
  ) {
    const result = await verifySlackIdentityToken(
      token,
      expectation,
      keySet as never,
      NOW,
    );
    assert(!result.ok);
  }
  for (
    const bad of [
      null,
      undefined,
      {},
      { ...expectation, nonce: "" },
      { ...expectation, teamId: "x" },
      { ...expectation, audience: "" },
      { ...expectation, issuer: undefined },
    ]
  ) {
    const result = await verifySlackIdentityToken(
      token,
      bad as never,
      keys,
      NOW,
    );
    assert(!result.ok, JSON.stringify(bad));
  }
});

Deno.test("a refusal is a reason code and never echoes the token, the nonce or the user", async () => {
  const secrets = [
    expectation.nonce,
    "U0USER123",
    "T0ABC123",
    expectation.audience,
  ];
  const tokens = [
    await sign({ ...validClaims(), nonce: "x" }),
    await sign({ ...validClaims(), "https://slack.com/team_id": "T0OTHER9" }),
    await sign(validClaims(), { pair: other }),
    `${segment({ alg: "none", kid: KID })}.${segment(validClaims())}.`,
    await sign({ ...validClaims(), exp: 1 }),
  ];
  for (const token of tokens) {
    const result = await verify(token);
    assert(!result.ok);
    const text = JSON.stringify(result);
    for (const secret of secrets) {
      assert(!text.includes(secret), `leaked ${secret}`);
    }
    assertEquals(Object.keys(result).sort(), ["ok", "reason"]);
    assert(/^[a-z_]+$/.test(result.reason));
  }
});

Deno.test("the nonce comparison does not depend on where the strings differ", async () => {
  // Not a timing measurement, which would be flaky; this pins the property the
  // implementation relies on: strings of different length never compare equal
  // and equal-length strings are compared in full.
  const near = expectation.nonce.slice(0, -1) +
    (expectation.nonce.at(-1) === "a" ? "b" : "a");
  const far = (expectation.nonce[0] === "a" ? "b" : "a") +
    expectation.nonce.slice(1);
  for (
    const nonce of [
      near,
      far,
      `${expectation.nonce}\u0000`,
      expectation.nonce.slice(0, 5),
    ]
  ) {
    assertEquals(await reasonOf({ ...validClaims(), nonce }), "wrong_nonce");
  }
  // Non-ASCII that normalises to the same visible text is still different.
  assertEquals(
    await reasonOf({
      ...validClaims(),
      nonce: "nonce-bound-to-this-attempt-7f3a​",
    }),
    "wrong_nonce",
  );
});

Deno.test("verification touches no network and no secret: it needs only the token, the expectation and the keys", async () => {
  // The function takes the key set as data. If it fetched a key set itself, a
  // call with an empty set would still succeed, which this asserts it does not.
  const token = await sign(validClaims());
  assertEquals((await verify(token, {}, [])).ok, false);
  assert((await verify(token, {}, keys)).ok);
});

Deno.test("an even or tiny public exponent is refused as a key, and the usual 65537 is accepted", async () => {
  const token = await sign(validClaims());
  // The same modulus with exponents that make a signature trivial to forge:
  // 65536 is even (three bytes, so it passes a length check alone), 1 and 0 are
  // one byte, and 65539 is odd and large enough.
  for (
    const [name, e] of [["65536", "AQAA"], ["1", "AQ"], ["0", "AA"], [
      "2",
      "Ag",
    ], ["two bytes", "AQE"]]
  ) {
    const result = await verify(token, {}, [keyOf(main, KID, { e })]);
    assert(!result.ok && result.reason === "unknown_key", `exponent ${name}`);
  }
  assert(
    (await verify(token, {}, keys)).ok,
    "the real exponent, 65537, must verify",
  );
  assertEquals(main.jwk.e, "AQAB");
});

Deno.test("a token over the length limit is refused even when it is otherwise perfect", async () => {
  const small_ = await sign({ ...validClaims(), pad: "x".repeat(2000) });
  assert(
    (await verify(small_)).ok,
    "a 2 KB token with a valid signature is accepted",
  );
  const huge = await sign({ ...validClaims(), pad: "x".repeat(20_000) });
  assert(
    huge.length > 16 * 1024,
    `the test needs a token over 16 KiB, got ${huge.length}`,
  );
  const result = await verify(huge);
  assert(!result.ok);
  assertEquals(result.reason, "malformed");
});

Deno.test("an expectation that binds nothing is refused even when the token matches it exactly", async () => {
  // Each of these would "match" a token built to agree with it, so only the
  // expectation check itself can refuse them.
  const cases: Array<
    [string, Partial<SlackIdentityExpectation>, Record<string, unknown>]
  > = [
    ["an empty nonce", { nonce: "" }, { nonce: "" }],
    ["an empty audience", { audience: "" }, { aud: "" }],
    ["an empty issuer", { issuer: "" }, { iss: "" }],
    ["a workspace that is not an id", { teamId: "acme" }, {
      "https://slack.com/team_id": "acme",
    }],
    ["a lower-case workspace", { teamId: "t0abc123" }, {
      "https://slack.com/team_id": "t0abc123",
    }],
    ["an enterprise that is not an id", { enterpriseId: "org" }, {
      "https://slack.com/enterprise_id": "org",
    }],
  ];
  for (const [name, expectationChange, claimChange] of cases) {
    const result = await verify(
      await sign({ ...validClaims(), ...claimChange }),
      expectationChange,
    );
    assert(!result.ok, `accepted a token against ${name}`);
    assertEquals(result.reason, "malformed", name);
  }
});
