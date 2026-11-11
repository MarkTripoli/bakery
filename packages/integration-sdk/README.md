# @bakery/integration-sdk

Authoring contracts for Bakery integrations: manifest, action, request template
and resource-kind schemas, plus pure validation. Independently versioned,
native-first.

## Trust model

- Definitions are data and handlers only. The host (server catalog gate) owns
  activation, credentials, origins, grants and the broker.
- Only explicitly deployed native integrations activate. No dynamic import.
- A manifest names a host-owned `authenticationProfile`. It never carries a URL,
  origin, header, credential or secret getter; strict schemas reject them.
- Requests are templates (`method`, fixed `pathTemplate`, allowlisted query,
  bounded response). Path params are `binding:<attr>` (host-supplied from the
  bound resource) or `input`. No arbitrary URL reaches the broker.
- Grants are exact action id plus version plus resource. No wildcard, prefix or
  `@latest` form exists.
- Every Zod schema must carry a meaningful description; activation fails on
  missing, filler or path-restating text.

## Layers

- `@bakery/contracts/integrations`: scopes, action references, resource kind
  ids.
- This package: manifest, request templates, description audit.
- Server: trusted gate and broker.

No Deno APIs, `fetch`, `node:*` or server imports belong here.

## Status

- Enforced: manifest/handler parity, strict input roots, described schemas,
  recovery result shape, request templates bound by the host broker.
- Proven end to end on a real loopback server in
  `tests/integration/implement-the-integration-sdk-manifests-and-capability-gate_test.ts`
  (redirect refusal, bearer only on the wire, deadline, size bound,
  `bakery.github` execute and reconcile).
- Deferred: OAuth and installation tokens, durable effect ledger and recovery
  scheduling, untrusted plugin isolation.
