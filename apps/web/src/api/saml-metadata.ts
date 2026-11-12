/**
 * Reads what the server needs from SAML identity provider metadata an
 * administrator pastes. The server's SAML registration requires the provider's
 * single sign-on URL as `entryPoint` beside the metadata document, so the page
 * takes it from the document rather than asking for the same address twice.
 * The server still validates everything it receives; this only avoids sending
 * a request that cannot succeed.
 */

const METADATA_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:metadata";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

/**
 * The identity provider's single sign-on URL from SAML metadata XML, or null
 * when the text is not metadata or names no http(s) endpoint. The redirect
 * binding wins over the POST binding, which wins over any other.
 */
export function readSamlEntryPoint(metadata: string): string | null {
  const document = new DOMParser().parseFromString(metadata, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) return null;
  const services = Array.from(
    document.getElementsByTagNameNS(METADATA_NAMESPACE, "SingleSignOnService"),
  );
  const service =
    services.find((entry) =>
      entry.getAttribute("Binding") === REDIRECT_BINDING
    ) ??
      services.find((entry) =>
        entry.getAttribute("Binding") === POST_BINDING
      ) ??
      services[0];
  const location = service?.getAttribute("Location")?.trim() ?? "";
  try {
    const { protocol } = new URL(location);
    return protocol === "https:" || protocol === "http:" ? location : null;
  } catch {
    return null;
  }
}
