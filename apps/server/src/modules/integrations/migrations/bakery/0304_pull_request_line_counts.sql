-- Line-count evidence for development metrics (chapter 18, issue #46).
--
-- One row is one count of a pull request's diff at one head commit under one
-- counter version (line-counter.ts). The fact sweep's line_counts stream
-- produces it for merged pull requests from the provider's own file list;
-- nothing else writes it. A newer head or a newer counter version adds a row
-- and never rewrites an old one, so every number a metric showed can be
-- traced to the exact count behind it.
--
--   coverage        complete, binary or truncated (TypeScript vocabulary in
--                   line-counter.ts, not a CHECK constraint); only a complete
--                   count is a known number of lines;
--   added, deleted  lines of the counted files;
--   counted_files, excluded_files, binary_files
--                   how the listed files were sorted: excluded files (lock
--                   files, vendored, generated) are never counted as lines,
--                   binary ones have unknown lines;
--   categories      at most four {category, added, deleted, files} entries
--                   (source, test, docs, config).
--
-- Nothing here enforces a rule or computes a metric.
create table bakery.pull_request_line_counts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pull_request_id uuid not null,
  head_sha text not null,
  counter_version text not null,
  coverage text not null,
  added integer not null,
  deleted integer not null,
  counted_files integer not null,
  excluded_files integer not null,
  binary_files integer not null,
  categories jsonb not null,
  counted_at timestamptz not null default now(),
  constraint pull_request_line_counts_identity_unique
    unique (pull_request_id, head_sha, counter_version),
  constraint pull_request_line_counts_pull_request_fk
    foreign key (organization_id, pull_request_id)
    references bakery.pull_requests (organization_id, id) on delete cascade
);

create index pull_request_line_counts_lookup_idx
  on bakery.pull_request_line_counts
  (organization_id, pull_request_id, counter_version);

grant select, insert on bakery.pull_request_line_counts to bakery_app;
