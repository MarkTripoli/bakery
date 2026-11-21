-- Evaluation batches (chapter 23, issue #44).
--
-- Facts only: which scorer and case revisions exist, which immutable dataset
-- a batch measures, what it pinned, and one result row per required case x
-- scorer x side x repetition with append-only attempts. The vocabularies
-- (evaluator types, batch and result states, roles) live in TypeScript
-- (modules/evaluations/domain.ts), not in CHECK constraints: the PostgreSQL
-- boundary rail forbids them. Gates, coverage and comparison are computed in
-- TypeScript; nothing here enforces a rule.

-- A scorer revision: a deterministic check or a model rubric. A new revision
-- is a new row; rows are never edited after creation.
create table bakery.evaluation_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  slug text not null,
  revision integer not null,
  evaluator_type text not null,
  config jsonb not null,
  digest text not null,
  enabled boolean not null default true,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint evaluation_definitions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint evaluation_definitions_created_by_fk
    foreign key (created_by) references bakery.principals (id) on delete restrict,
  constraint evaluation_definitions_revision_unique
    unique (organization_id, slug, revision),
  constraint evaluation_definitions_organization_id_unique
    unique (organization_id, id)
);

-- A case revision: typed input, optional expected output and tags.
create table bakery.evaluation_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  repository_id uuid,
  name text not null,
  input_artifact_version_id uuid,
  expected jsonb,
  tags jsonb not null default '[]'::jsonb,
  revision integer not null default 1,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint evaluation_cases_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint evaluation_cases_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete restrict,
  constraint evaluation_cases_input_fk
    foreign key (organization_id, input_artifact_version_id)
    references bakery.artifact_versions (organization_id, id) on delete restrict,
  constraint evaluation_cases_created_by_fk
    foreign key (created_by) references bakery.principals (id) on delete restrict,
  constraint evaluation_cases_organization_id_unique
    unique (organization_id, id)
);
create index evaluation_cases_page_idx
  on bakery.evaluation_cases (organization_id, created_at desc, id desc);

-- An immutable dataset: an ordered list of case revisions and its digest.
create table bakery.evaluation_datasets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  cases jsonb not null,
  digest text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint evaluation_datasets_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint evaluation_datasets_created_by_fk
    foreign key (created_by) references bakery.principals (id) on delete restrict,
  constraint evaluation_datasets_organization_id_unique
    unique (organization_id, id)
);
create index evaluation_datasets_page_idx
  on bakery.evaluation_datasets (organization_id, created_at desc, id desc);

-- A batch measures a candidate (and optionally a baseline) on one dataset
-- with pinned scorer revisions, a gate rule and limits. Its pins are copied
-- in at admission and never change.
create table bakery.evaluation_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  dataset_id uuid not null,
  dataset_digest text not null,
  candidate jsonb not null,
  baseline jsonb,
  scorers jsonb not null,
  gate_rule jsonb not null,
  limits jsonb not null,
  state text not null,
  canceled_at timestamptz,
  canceled_by uuid,
  completed_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint evaluation_batches_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint evaluation_batches_dataset_fk
    foreign key (organization_id, dataset_id)
    references bakery.evaluation_datasets (organization_id, id) on delete restrict,
  constraint evaluation_batches_created_by_fk
    foreign key (created_by) references bakery.principals (id) on delete restrict,
  constraint evaluation_batches_canceled_by_fk
    foreign key (canceled_by) references bakery.principals (id) on delete restrict,
  constraint evaluation_batches_organization_id_unique
    unique (organization_id, id)
);
create index evaluation_batches_page_idx
  on bakery.evaluation_batches (organization_id, created_at desc, id desc);

-- One row per required case x scorer x side x repetition, written at
-- admission in state missing; an attempt moves it. ordinal is the case's
-- position in the dataset, for case-order paging.
create table bakery.evaluation_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  batch_id uuid not null,
  role text not null,
  case_id uuid not null,
  case_revision integer not null,
  ordinal integer not null,
  scorer_id uuid not null,
  scorer_revision integer not null,
  repetition integer not null default 1,
  required boolean not null default true,
  state text not null,
  reason text,
  score numeric,
  output_artifact_version_id uuid,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint evaluation_results_batch_fk
    foreign key (organization_id, batch_id)
    references bakery.evaluation_batches (organization_id, id) on delete cascade,
  constraint evaluation_results_case_fk
    foreign key (organization_id, case_id)
    references bakery.evaluation_cases (organization_id, id) on delete restrict,
  constraint evaluation_results_scorer_fk
    foreign key (organization_id, scorer_id)
    references bakery.evaluation_definitions (organization_id, id) on delete restrict,
  constraint evaluation_results_output_fk
    foreign key (organization_id, output_artifact_version_id)
    references bakery.artifact_versions (organization_id, id) on delete restrict,
  constraint evaluation_results_identity_unique
    unique (batch_id, role, case_id, case_revision, scorer_id, scorer_revision,
      repetition),
  constraint evaluation_results_organization_id_unique
    unique (organization_id, id)
);
create index evaluation_results_page_idx
  on bakery.evaluation_results (organization_id, batch_id, ordinal, id);

-- Append-only attempts per result. delivery_key is the identity of the
-- queue delivery that produced it, so a duplicate delivery adds nothing.
create table bakery.evaluation_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  result_id uuid not null,
  attempt_no integer not null,
  delivery_key text not null,
  state text not null,
  reason text,
  score numeric,
  started_at timestamptz,
  ended_at timestamptz,
  trace_ref text,
  created_at timestamptz not null default now(),
  constraint evaluation_attempts_result_fk
    foreign key (organization_id, result_id)
    references bakery.evaluation_results (organization_id, id) on delete cascade,
  constraint evaluation_attempts_number_unique unique (result_id, attempt_no),
  constraint evaluation_attempts_delivery_unique unique (result_id, delivery_key)
);

grant select, insert on bakery.evaluation_definitions to bakery_app;
grant select, insert on bakery.evaluation_cases to bakery_app;
grant select, insert on bakery.evaluation_datasets to bakery_app;
grant select, insert on bakery.evaluation_batches to bakery_app;
grant update (state, canceled_at, canceled_by, completed_at, updated_at, version)
  on bakery.evaluation_batches to bakery_app;
grant select, insert on bakery.evaluation_results to bakery_app;
grant update (state, reason, score, output_artifact_version_id, attempt_count,
  updated_at, version)
  on bakery.evaluation_results to bakery_app;
grant select, insert on bakery.evaluation_attempts to bakery_app;
