import type { ApiFailure, BakeryApiClient } from "../api/client.ts";
import type {
  ConsentGateway,
  ConsentOrganization,
  ConsentRequest,
} from "./connected-clients.ts";

const AUTH_BASE = "/api/auth";

function httpFailure(status: number): ApiFailure {
  return { kind: "invalid-response", status };
}

async function authFetch(
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(`${AUTH_BASE}${path}`, {
      credentials: "include",
      ...init,
      headers: { accept: "application/json", ...init.headers },
    });
  } catch {
    throw { kind: "network" } satisfies ApiFailure;
  }
  if (!response.ok) throw httpFailure(response.status);
  return response;
}

/** The name the operator registered for the client, from the provider's public read. */
async function clientName(
  fetchImpl: typeof fetch,
  clientId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await authFetch(
    fetchImpl,
    `/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
    { method: "GET", signal },
  );
  const body = await response.json() as {
    client_name?: unknown;
    name?: unknown;
  };
  const name = body.client_name ?? body.name;
  return typeof name === "string" && name !== "" ? name : clientId;
}

/** Organizations the person holds a live role in; a null role cannot connect a client. */
async function consentOrganizations(
  api: Pick<BakeryApiClient, "listOrganizations">,
  signal: AbortSignal | undefined,
): Promise<readonly ConsentOrganization[]> {
  const result = await api.listOrganizations(undefined, signal);
  if (!result.ok) throw result.error;
  return result.data.items.flatMap((organization) =>
    organization.role === null ? [] : [{
      id: organization.id,
      name: organization.name,
      role: organization.role,
    }]
  );
}

/**
 * Production `ConsentGateway` over the Better Auth OAuth provider. The
 * pending request travels in the page's own query string (`client_id`,
 * `scope` and the signed `oauth_query` the consent POST needs); only the
 * read-only public-client read, the organization choice and the consent
 * decision are called. The delete and update consent paths never are.
 *
 * The decision answers with the redirect the client is waiting on. It is
 * delivered with a credential-free, opaque (`no-cors`) background request so
 * the person stays on Bakery and sees the outcome screen; the client's own
 * listener receives the code (or `access_denied`) from that request.
 */
export function createConsentGateway(
  api: Pick<BakeryApiClient, "listOrganizations">,
  options: {
    readonly search?: () => string;
    readonly fetch?: typeof fetch;
  } = {},
): ConsentGateway {
  const search = options.search ?? (() => globalThis.location.search);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async get(signal) {
      const query = new URLSearchParams(search());
      const clientId = query.get("client_id");
      if (clientId === null) throw httpFailure(410);
      const [name, organizations] = await Promise.all([
        clientName(fetchImpl, clientId, signal),
        consentOrganizations(api, signal),
      ]);
      return {
        clientName: name,
        scopes: (query.get("scope") ?? "").split(" ").filter(Boolean),
        organizations,
        selectedOrganizationId: null,
      } satisfies ConsentRequest;
    },
    async selectOrganization(organizationId) {
      await authFetch(fetchImpl, "/bakery/oauth/select-organization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
    },
    async respond(accept) {
      const query = search().replace(/^\?/, "");
      const response = await authFetch(fetchImpl, "/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept, oauth_query: query }),
      });
      const body = await response.json().catch(() => ({})) as {
        url?: unknown;
      };
      if (typeof body.url === "string") {
        await fetchImpl(body.url, { mode: "no-cors", credentials: "omit" })
          .catch(() => undefined);
      }
    },
  };
}
