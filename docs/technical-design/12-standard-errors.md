# Standard errors

Bakery’s shared error contract. Guards and application operations throw one error type; transport adapters serialize safe failures. Proposed design; runtime mapping remains unimplemented.

## What handlers throw

Throw **`StandardError({slug,status,params?,cause?})`**: an options object with exported `PROBLEM` slug, explicit `HTTP_STATUS`, optional safe params and internal cause. Guards throw it; handlers parse, call and return. `Fault` remains a serialized workflow value only; do not build a competing exception hierarchy. If an application operation returns `Result<T, Fault>`, its boundary converts the failure to `StandardError` once.

```ts
throw new StandardError({
  slug: PROBLEM.STATE_CONFLICT,
  status: HTTP_STATUS.CONFLICT,
});
```

`toProblem(error, catalog)` normalizes the value, then `problemResponse` handles HTTP serialization/headers. Hono `notFound` and `onError` use that same boundary, including isolated router tests. Unknown exceptions become generic `INTERNAL`/500 with the cause retained only in redacted server logs. Module handlers must not call `c.json({error: ...})`, duplicate catch/format logic, invent slugs, or hardcode user-facing detail text. HTTP constants live in the focused shared HTTP module.

`StandardError` carries explicit status. A problem slug need not imply one fixed status; the fault table documents current Bakery contracts, not a slug-to-status constructor lookup.

API and isolated module tests mount the same mapper. Include request/trace IDs and the configured type base. Per-request localization may change catalog text, never machine codes; do not log the language header.

**Provider failures:** translate provider errors into registered Bakery faults. Never send raw Octokit errors to clients or logs; they can retain request headers/body. Keep only allowlisted, redacted diagnostic fields with correlation IDs. Provider authentication failure must not become a Bakery-session `401`. Uncertain writes stay `EXTERNAL_EFFECT_UNCERTAIN`, never automatic replacements.

## Public Problem contract

The public machine code is uppercase `SCREAMING_SNAKE_CASE`; it is never localized or renamed. The RFC 9457 `type` is derived from the configured public origin:

```text
code: IDEMPOTENCY_PAYLOAD_MISMATCH
type: ${PUBLIC_BASE_URL}/problems/idempotency-payload-mismatch
```

`PUBLIC_BASE_URL` is configuration, so local operation can use `http://localhost:8788` while production uses the public Bakery origin. The body is one `application/problem+json` object:

```json
{
  "type": "https://bakery.example/problems/idempotency-payload-mismatch",
  "title": "Idempotency key payload mismatch",
  "status": 422,
  "detail": "The key was already used with a different request.",
  "instance": "urn:bakery:request:018f0b4a-82a2-4ef1-a100-842bde445332",
  "code": "IDEMPOTENCY_PAYLOAD_MISMATCH",
  "requestId": "018f0b4a-82a2-4ef1-a100-842bde445332",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "retryable": false
}
```

`type` is the primary RFC identifier; `code` is its stable Bakery registry alias and must agree with it. `title` and `detail` come from the problem catalog; clients use known type/code/status rather than parsing prose. `requestId` and `traceId` are safe correlation values. `issues` is present only for bounded validation details and on a `STATE_CONFLICT` that lists the failed checks behind its reason (`ticket_not_ready`); `retryAfterSeconds` is present for retryable throttling/unavailability. `reason` is present on a `STATE_CONFLICT` that names a state rule: a lowercase snake_case slug such as `approval_required`, `approval_unavailable` or `task_not_startable`, bounded to 64 characters. Never put a stack, SQL, credential, prompt, or provider response into `detail`.

The initial registry is below. All routes inherit applicable shared parser/router/rate-limit/unknown-error failures as declared in `errorHandling.commonHttpFaults`; generated OpenAPI and the operation explorer combine those with operation-specific faults. The SDK and OAuth framing exceptions remain explicit.

| Code | HTTP | Retryable |
|---|---:|---:|
| `AUTH_REQUIRED` | 401 | no |
| `AUTH_FORBIDDEN` | 403 | no |
| `RESOURCE_NOT_FOUND` | 404 | no |
| `ARTIFACT_CONTENT_EXPIRED` | 410 | no |
| `MALFORMED_REQUEST` | 400 | no |
| `UNPROCESSABLE` | 422 | no |
| `VALIDATION_FAILED` | 422 | no |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | 422 | no |
| `IDEMPOTENCY_IN_FLIGHT` | 409 | yes |
| `PRECONDITION_FAILED` | 412 | no |
| `STATE_CONFLICT` | 409 | no |
| `VERSION_CONFLICT` | 409 | no |
| `EXPECTED_SEQUENCE` | 409 | yes |
| `LEASE_EXPIRED` | 409 | yes |
| `LEASE_FENCED` | 409 | no |
| `CANCEL_REQUESTED` | 409 | no |
| `ALREADY_TERMINAL` | 409 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `PROVIDER_QUOTA_EXCEEDED` | 429 | yes |
| `BUDGET_CAP_EXCEEDED` | 429 | no |
| `EXTERNAL_EFFECT_UNCERTAIN` | 409 | no |
| `DEPENDENCY_UNAVAILABLE` | 503 | yes |
| `DEPENDENCY_TIMEOUT` | 504 | yes |
| `REVIEWER_UNAVAILABLE` | 503 | yes |
| `WORKER_UNAVAILABLE` | 503 | yes |
| `SNAPSHOT_SCOPE_TOO_LARGE` | 413 | no |
| `AUTH_INVALID` | 401 | no |
| `AUTH_EXPIRED` | 401 | no |
| `AUTH_FACTOR_REQUIRED` | 401 | no |
| `MALFORMED_JSON` | 400 | no |
| `BODY_TOO_LARGE` | 413 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `WORKER_PROTOCOL_UNSUPPORTED` | 426 | no |
| `METHOD_NOT_ALLOWED` | 405 | no |
| `PRECONDITION_REQUIRED` | 428 | no |
| `RATE_LIMITED` | 429 | yes |
| `INTERNAL` | 500 | no |
| `SKILL_CONTENT_INTEGRITY_FAILED` | 409 | no |
| `INVALID_CURSOR` | 400 | no |
| `ARTIFACT_CONTENT_EXPIRED` | 410 | no |
| `RANGE_NOT_SATISFIABLE` | 416 | no |

## RFC 9457 across the transports

For Bakery-owned HTTP errors, return one `application/problem+json` object with its actual 4xx/5xx status. `type` identifies the problem; keep its URI stable and document it. Body `status` must match the HTTP response. Optional `instance` is a correlation URI, omitted when unavailable. Clients ignore unknown extensions. [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)

Use top-level extensions: `issues` for safe validation feedback, `limit` for body-size refusal, and Bakery's `code`, `requestId`, `traceId`, `retryable` and optional retry guidance. There is no nested `extensions` wrapper. Allowlisted params cannot overwrite reserved problem/correlation fields. Never expose exception messages, raw Zod input values, stack traces, SQL, tokens or provider bodies.

Malformed JSON syntax is `MALFORMED_JSON`/400. Valid JSON, path or query values that fail an ordinary schema are `MALFORMED_REQUEST`/400 with bounded `issues`; malformed/mismatched collection cursors use `INVALID_CURSOR`/400. Unsupported media types are 415; bounded body refusals are 413. Reserve 422 for valid content that cannot be processed under a domain rule, including the existing idempotency payload-mismatch contract.

Catalog title/detail localization uses per-request `Accept-Language`, with `Content-Language` and `Vary: Accept-Language`; never persist/log the language header. Preserve applicable `Allow`, authorized `ETag`, `Retry-After`, `Content-Range` for a 416 response, and OAuth `WWW-Authenticate` headers. HEAD remains bodyless. Once a stream is committed or upgraded, report its supported error frame or abort it and record the failure; never append Problem JSON to a binary download or attempt to change its HTTP status.

| Boundary | Wire failure |
|---|---|
| Bakery REST / worker / webhook HTTP request | Non-2xx + RFC 9457 Problem Details |
| MCP envelope/protocol failure | SDK JSON-RPC `error` with its prescribed numeric code and data |
| MCP valid tool call with validation/domain/provider failure | `resultType: "complete"`, `isError: true`, safe `content`, and `structuredContent.problem` |
| MCP missing/invalid token or insufficient scope | HTTP 401/403 and OAuth Bearer challenge before tool dispatch |
| OAuth token/authorization endpoint or Inngest SDK callback | Preserve that protocol's standard error document/redirect; the REST mapper must not rewrite it |
| Browser WebSocket or worker durable result | Existing protocol envelope with the same serialized Problem and correlation IDs |

MCP has its own error format. Reuse the Problem object **inside** a failed tool result, and declare each tool's structured output as its success schema or `McpToolFailure`. Unknown tools and malformed RPC envelopes remain protocol errors; missing OAuth scope remains a challenge. The embedded `problem.status` describes the equivalent REST/domain failure, while HTTP 200 means the RPC delivered a completed tool-error result. This is not a standalone HTTP Problem response. [MCP tool errors](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [MCP authorization errors](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

The same illustrative failure appears below through REST and MCP. These are declarative examples; the runtime mapper is still to be implemented.

### HTTP example

```json
{
  "status": 409,
  "headers": {
    "Content-Type": "application/problem+json",
    "Content-Language": "en",
    "Vary": "Accept-Language"
  },
  "body": {
    "type": "https://bakery.example/problems/state-conflict",
    "title": "State conflict",
    "status": 409,
    "detail": "This run cannot make the requested transition from its current state.",
    "instance": "urn:bakery:request:018f0b4a-82a2-4ef1-a100-842bde445332",
    "code": "STATE_CONFLICT",
    "requestId": "018f0b4a-82a2-4ef1-a100-842bde445332",
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "retryable": false
  }
}
```

### MCP tool example

```json
{
  "status": 200,
  "headers": {
    "Content-Type": "application/json"
  },
  "body": {
    "jsonrpc": "2.0",
    "id": 7,
    "result": {
      "resultType": "complete",
      "isError": true,
      "content": [
        {
          "type": "text",
          "text": "This run cannot make the requested transition from its current state."
        }
      ],
      "structuredContent": {
        "problem": {
          "type": "https://bakery.example/problems/state-conflict",
          "title": "State conflict",
          "status": 409,
          "detail": "This run cannot make the requested transition from its current state.",
          "instance": "urn:bakery:request:018f0b4a-82a2-4ef1-a100-842bde445332",
          "code": "STATE_CONFLICT",
          "requestId": "018f0b4a-82a2-4ef1-a100-842bde445332",
          "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
          "retryable": false
        }
      }
    }
  }
}
```
