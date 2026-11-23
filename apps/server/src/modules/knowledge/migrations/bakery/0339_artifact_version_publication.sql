-- Binary publishing is staged, then current (chapter 25 section 17.5, O29,
-- #437 final slice).
--
-- A kind may compose rules only the sandboxed probe can answer: the media type
-- the bytes really are, an image's pixel count, a recording's length. The probe
-- runs after the publish transaction, so a version under such a kind cannot be
-- judged when it is written. It is written as staged instead, is not the
-- artifact's current version, and the probe runner promotes it to current or
-- refuses it in the same transaction that stores the probe's answer.
--
--   publication_status        current (every version before this migration, and
--                             every version under a kind with no probe-backed
--                             rule), staged (waiting for the probe), or refused
--                             (the probe answer failed a require rule, or the
--                             probe refused the file itself). The vocabulary is
--                             enforced by the writers in TypeScript: the
--                             PostgreSQL boundary rail refuses CHECK constraints.
--   refused_kind_version_id   the kind version whose rule refused it;
--   refused_rule_type         the platform rule type that refused it, or null
--                             when the probe refused the file (too-large,
--                             malformed, unreadable);
--   refused_reason            the finding's message or the probe refusal code;
--   settled_at                when the probe answer promoted or refused it.
--
-- No backfill: the default makes every existing version current, which is what
-- it already was.
alter table bakery.artifact_versions
  add column publication_status text not null default 'current',
  add column refused_kind_version_id uuid,
  add column refused_rule_type text,
  add column refused_reason text,
  add column settled_at timestamptz;

-- The target carries the organization, so a refusal can never name another
-- organization's kind version. A set null names only its own column.
alter table bakery.artifact_versions
  add constraint artifact_versions_refused_kind_version_fk
    foreign key (organization_id, refused_kind_version_id)
    references bakery.artifact_kind_versions (organization_id, id)
    on delete set null (refused_kind_version_id);

-- The runner looks up the staged versions a probe answer settles, by blob or
-- by version; staged rows are few, so a partial index keeps the lookup cheap.
create index artifact_versions_staged_idx
  on bakery.artifact_versions (organization_id, blob_id)
  where publication_status = 'staged';
