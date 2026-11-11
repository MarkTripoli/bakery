alter table bakery.session_output_streams
  add column archive_state text not null default 'pending',
  add column archive_failure text,
  add column archive_attempted_at timestamptz,
  add column archived_at timestamptz,
  add column history_expires_at timestamptz;

create table bakery.output_transcript_segments (
  organization_id uuid not null,
  stream_id uuid not null,
  segment_index integer not null,
  first_sequence bigint not null,
  last_sequence bigint not null,
  size_bytes integer not null,
  sha256 text not null,
  completeness text not null,
  artifact_version_id uuid not null,
  primary key (organization_id, stream_id, segment_index),
  foreign key (organization_id, stream_id)
    references bakery.session_output_streams (organization_id, id) on delete cascade,
  constraint output_transcript_segments_artifact_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id) on delete cascade
);

create index output_archive_pending_idx on bakery.session_output_streams
  (archive_state, closed, id);
create index output_history_expiry_idx on bakery.session_output_streams
  (history_expires_at) where archive_state in ('archived', 'not_required');
grant select, insert on bakery.output_transcript_segments to bakery_app;
grant update (archive_state, archive_failure, archive_attempted_at, archived_at, history_expires_at)
  on bakery.session_output_streams to bakery_app;
grant delete on bakery.session_output_batches to bakery_app;
