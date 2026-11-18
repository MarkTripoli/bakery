# #14 slice (b): the contextPack catalogue op and route

Design decisions taken before writing code, so review can attack the shape
rather than reverse-engineer it.

## What the doc requires

`docs/technical-design/17-context-and-handoffs.md` (line ~421) lists the pack
operations as **deliberately uncatalogued** and says: "Add their typed schemas
and descriptions before exposing REST, MCP, or UI controls." The pack itself is
"a view over durable records, not a second transcript" (line ~116), with this
shape: goal and required output, resolved model/harness and budget envelope,
minimum conversation cutoff and selected messages, allowed tools, artifact refs
with citation slices, repository commit and safe paths, unresolved questions.

## Decisions

1. **One action, `contextPacks.build`, POST `/v1/context-packs`, Developer.**
   The doc names "context-pack extraction" as one operation; splitting get/list
   from it would add two names for one thing before anything persists a pack.
2. **A pack is computed, never stored.** The doc says it is a view over durable
   records. Storing it would make a second transcript, and the digest exists
   precisely so a reader can tell two computations apart.
3. **Reuse, do not restate.** The handler calls `allocateContext` (admission and
   the unknown-is-not-zero rule), `projectArtifactVersion` (text/log windows,
   image/PDF/binary references) and, through `extractArtifactVersion`, the
   extract cache. This slice adds a surface, not a second engine.
4. **Wide fields are `json` in the transport, strict in the code.** The schema
   language has no unions of objects; `WorkflowValidation.definition` is the
   precedent. `envelope` and `candidates` are bounded `json` on the wire and
   parsed by their own Zod schemas in the module, so the nested rules (no
   negative tokens, no duplicate candidate ids) live where they can be tested.
5. **`packDigest` covers the selection, not the clock.** It is the SHA-256 of
   the canonical pack content so a run can pin exactly what a step was given,
   and is null when the decision selected nothing.
6. **Artifact candidates are authorized per candidate.** A candidate the caller
   cannot read is omitted with reason `not_authorized` rather than failing the
   whole build: the pack's job is to describe what a step may see, and the
   omissions are part of that description.

## Surface

- inputs: `ContextPackBuild` (envelope, candidates, optional conversation
  cutoff and repository).
- outputs: `ContextPack`, `ContextPackItem`, `ContextPackOmission`,
  `ContextPackEnvelope`.
- errors: `AUTH_REQUIRED`, `AUTH_FORBIDDEN`, `SCOPE_REQUIRED`,
  `RESOURCE_NOT_FOUND`, `UNPROCESSABLE`, `MALFORMED_REQUEST`.
- implemented action: `ContextPacksBuild`, so MCP and the client manifest pick
  it up the same way `ArtifactVersionsExtract` is picked up.

## Tests

- contract: the action exists, its input and output are described, its errors
  are the listed ones, and it is implemented (not in the unimplemented set).
- unit: an unknown unbounded candidate is omitted, not counted as zero; a
  candidate the caller cannot read is omitted with `not_authorized`; the digest
  changes when the selection changes and not when only the clock does.
- integration (when a stack slot exists): a granted Developer builds a pack over
  a real artifact version and the returned citation's digest matches the row.
