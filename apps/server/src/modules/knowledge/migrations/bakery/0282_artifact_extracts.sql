-- Cached immutable extracts for bounded context packs (issue #14, chapter 17,
-- "Context is a measured budget envelope"; the projections themselves are the
-- index-first ones from #172 in modules/knowledge/context-projection.ts).
--
-- An extract is a pure function of (artifact version, digest, byte range,
-- extractor version), so it is cached by exactly those plus the organization and
-- the authorization scope: keying on the artifact alone would survive a new
-- version and hand a step text that no longer matches the digest it cited.
--
-- `scope` records the authorization scope the extract was produced under, and
-- it is part of the unique key. A reuse re-checks the caller's live access and
-- compares this scope, so a cached extract can never outlive, or cross, the
-- grant that permitted it. The column is deliberately opaque text: the cache
-- stores no authorization decision of its own and must not be able to answer
-- "may this caller read it" by itself.
--
-- `max_bytes` and `has_more` are stored because a caller looking a window up has
-- not read the content yet and so cannot name the range it will be given back;
-- the request it can name (start and limit) is what finds the row.
--
-- Structure only: whether an extract may be reused is decided in TypeScript by
-- verifyCitation and reusableCachedExtract (modules/knowledge/), which compare
-- the pinned digest, the extractor version and live access. Nothing here
-- validates or enforces it, and no row is trusted because it exists.

create table bakery.artifact_extracts (
  -- Canonical identity of the extract, from extractCacheKey(): organization,
  -- version, digest, byte range, extractor and a digest of the authorization
  -- scope, so another scope cannot find the row. It stores no authorization
  -- decision: whether a caller may read the version is decided by the live read.
  cache_key text primary key,
  organization_id uuid not null
    references bakery.organizations (id) on delete cascade,
  artifact_version_id uuid not null,
  -- Lowercase hex content digest of the version the extract was read from.
  digest text not null,
  -- Byte range of the excerpt. Both null for a reference-only projection, whose
  -- cached value is the reference cost rather than any content.
  start_byte integer,
  end_byte_exclusive integer,
  -- Authorization scope the extract was produced under, compared at reuse.
  scope text not null,
  -- Which extractor produced the value and at what version, so a reader judging
  -- the text knows whether it came from a window over stored bytes or a
  -- reference. A changed extractor version misses the cache.
  extractor_version text not null,
  media_type text not null,
  -- The bounded excerpt. Empty is allowed: a window at the end of a file can
  -- legitimately be empty, and refusing it would turn a valid extract into a
  -- permanent miss.
  text text not null,
  text_bytes integer not null,
  -- The requested window, so the same request finds this row.
  max_bytes integer not null,
  -- Whether the excerpt ends before the version does.
  has_more boolean not null,
  created_at timestamptz not null default now(),
  -- Same-tenant version, so an extract cannot cite another organization's
  -- version: artifact_versions carries unique (organization_id, id) for this.
  constraint artifact_extracts_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id) on delete cascade,
  -- One row per request under one scope. `on conflict do nothing` in the store
  -- resolves a concurrent duplicate, whose text is identical by construction.
  constraint artifact_extracts_request_unique
    unique (
      organization_id, artifact_version_id, digest, start_byte, max_bytes,
      extractor_version, scope
    )
);

grant select, insert, delete on bakery.artifact_extracts to bakery_app;
