import * as samlify from "samlify";

// The IdP side only parses Bakery's AuthnRequest and signs a response; XML
// schema validation of those messages is not what these tests prove, so a
// pass-through validator keeps samlify's schema-validator requirement happy.
samlify.setSchemaValidator({ validate: () => Promise.resolve("skipped") });

/** Deliberate protocol faults, each applied before signing unless noted. */
export type SamlFaults = {
  /** Leave the assertion unsigned (the SP metadata handed to samlify says it need not be signed). */
  unsigned?: boolean;
  /** Audience restriction value. */
  audience?: string;
  /** Issuer (IdP entity ID) of response and assertion. */
  issuer?: string;
  /** Assertion and bearer confirmation expiry. */
  notOnOrAfter?: Date;
  /** InResponseTo of an unsolicited or foreign request. */
  inResponseTo?: string;
};

export type SamlIdp = {
  entityID: string;
  ssoUrl: string;
  /** PEM certificate Bakery is configured to trust for signatures. */
  certificatePem: string;
  /**
   * Answers one AuthnRequest URL (as returned by `POST /sign-in/sso`) with a
   * really signed login response for `email`, shaped for the SP described by
   * `spMetadata`. Returns the form fields to POST to the ACS.
   */
  respond(
    authnRequestUrl: string,
    spMetadata: string,
    email: string,
    faults?: SamlFaults,
  ): Promise<{ SAMLResponse: string; RelayState: string | null }>;
};

function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

async function openssl(...args: string[]) {
  const output = await new Deno.Command("openssl", {
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

/** A signing SAML identity provider with a freshly generated key and certificate. */
export async function startSamlIdp(port: number): Promise<SamlIdp> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-saml-idp-" });
  try {
    await openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${dir}/key.pem`,
      "-out",
      `${dir}/cert.pem`,
      "-days",
      "2",
      "-subj",
      "/CN=bakery-test-idp",
    );
    const privateKey = await Deno.readTextFile(`${dir}/key.pem`);
    const certificatePem = await Deno.readTextFile(`${dir}/cert.pem`);
    const entityID = `http://127.0.0.1:${port}/saml/metadata`;
    const ssoUrl = `http://127.0.0.1:${port}/saml/sso`;
    const idp = samlify.IdentityProvider({
      entityID,
      privateKey,
      signingCert: certificatePem,
      isAssertionEncrypted: false,
      nameIDFormat: ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"],
      singleSignOnService: [{
        Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
        Location: ssoUrl,
      }],
    });
    return {
      entityID,
      ssoUrl,
      certificatePem,
      async respond(authnRequestUrl, spMetadata, email, faults = {}) {
        const url = new URL(authnRequestUrl);
        const effectiveMetadata = faults.unsigned
          ? spMetadata.replace(
            /WantAssertionsSigned="true"/g,
            'WantAssertionsSigned="false"',
          )
          : spMetadata;
        const sp = samlify.ServiceProvider({ metadata: effectiveMetadata });
        const request = await idp.parseLoginRequest(sp, "redirect", {
          query: Object.fromEntries(url.searchParams),
        });
        const relayState = url.searchParams.get("RelayState");
        const acs = spMetadata.match(
          /AssertionConsumerService[^>]*Location="([^"]+)"/,
        )![1];
        const audience = spMetadata.match(/entityID="([^"]+)"/)![1];
        const requestId = (request.extract as { request: { id: string } })
          .request.id;
        const now = new Date();
        const response = await idp.createLoginResponse(
          sp,
          request as unknown as Parameters<typeof idp.createLoginResponse>[1],
          "post",
          { email },
          (template: string) => {
            const id = `_${crypto.randomUUID()}`;
            const expiry = faults.notOnOrAfter ??
              new Date(now.getTime() + 300_000);
            return {
              id,
              context: fillTemplate(template, {
                ID: id,
                AssertionID: `_${crypto.randomUUID()}`,
                IssueInstant: now.toISOString(),
                Destination: acs,
                InResponseTo: faults.inResponseTo ?? requestId,
                Issuer: faults.issuer ?? entityID,
                StatusCode: "urn:oasis:names:tc:SAML:2.0:status:Success",
                NameIDFormat:
                  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
                NameID: email,
                SubjectConfirmationDataNotOnOrAfter: expiry.toISOString(),
                SubjectRecipient: acs,
                ConditionsNotBefore: new Date(now.getTime() - 60_000)
                  .toISOString(),
                ConditionsNotOnOrAfter: expiry.toISOString(),
                Audience: faults.audience ?? audience,
                AuthnStatement: "",
                AttributeStatement: "",
              }),
            };
          },
          false,
          relayState ?? undefined,
        );
        return {
          SAMLResponse: response.context,
          RelayState: relayState,
        };
      },
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
