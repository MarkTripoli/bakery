-- Cached immutable extracts for bounded context packs (issue #14, chapter 17).
--
-- An extract is a pure function of (artifact version, extractor, limit), so it is
-- cached by exactly those. It is never a cache of "the artifact": keying on the
-- artifact alone would survive a new version and hand a step text that no longer
-- matches the cited digest.
--
-- `scope` is stored so a reader re-checks authorization against the scope the
-- extract was produced under. Without it a cached extract outlives the grant that
-- permitted it.

create table bakery.context_pack_extracts (
  id uuid primary key,
  organization_id uuid not null,
  artifact_version_id uuid not null,
  -- Algorithm-prefixed content digest, e.g. 'sha256:<64 hex>'. Part of the key:
  -- a mutated artifact must miss the cache rather than serve stale text.
  digest text not null,
  -- Authorization scope the extract was produced under, re-checked at read.
  scope text not null,
  -- Which extractor produced the value and at what version, so a reader judging
  -- the text knows whether it came from a parser, an OCR pass or a model.
  extractor_name text not null,
  extractor_version text not null,
  media_type text not null,
  -- The extracted text itself, always bounded at write time.
  text text not null,
  -- Whether the extract was cut short to fit its limit. A truncated extract must
  -- say so, so a partial document is never read as a whole one.
  truncated boolean not null,
  text_bytes integer not null,
  created_at timestamptz not null default now(),
  constraint context_pack_extracts_digest_is_prefixed
    check (digest ~ '^[a-z0-9]+:[0-9a-f]{64}$'),
  constraint context_pack_extracts_text_bytes_positive
    check (text_bytes > 0),
  -- One extract per version, digest, extractor, version and scope: the cache key
  -- and the uniqueness key are the same thing, so a lookup can never find two
  -- rows and pick one by accident.
  constraint context_pack_extracts_unique
    unique (artifact_version_id, digest, extractor_name, extractor_version, scope)
);

create index context_pack_extracts_by_organization
  on bakery.context_pack_extracts (organization_id, artifact_version_id);
