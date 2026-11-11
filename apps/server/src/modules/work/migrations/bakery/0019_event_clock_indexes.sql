-- bakery:migration-mode: non-transactional
drop index concurrently if exists bakery.tasks_organization_created_id_idx;

create index concurrently tasks_organization_created_id_idx
  on bakery.tasks (organization_id, created_at desc, id desc);

drop index concurrently if exists bakery.tasks_organization_application_created_id_idx;

create index concurrently tasks_organization_application_created_id_idx
  on bakery.tasks (organization_id, application_id, created_at desc, id desc);

drop index concurrently if exists bakery.tasks_organization_repository_created_id_idx;

create index concurrently tasks_organization_repository_created_id_idx
  on bakery.tasks (organization_id, repository_id, created_at desc, id desc)
  where repository_id is not null;

drop index concurrently if exists bakery.tasks_organization_conversation_created_id_idx;

create index concurrently tasks_organization_conversation_created_id_idx
  on bakery.tasks (organization_id, conversation_id, created_at desc, id desc);

drop index concurrently if exists bakery.domain_events_organization_sequence_unique_idx;

create unique index concurrently domain_events_organization_sequence_unique_idx
  on bakery.domain_events (organization_id, organization_sequence);

drop index concurrently if exists bakery.domain_events_pending_organization_sequence_idx;

create index concurrently domain_events_pending_organization_sequence_idx
  on bakery.domain_events (sequence)
  where organization_sequence is null;

drop index concurrently if exists bakery.domain_events_application_sequence_idx;

create index concurrently domain_events_application_sequence_idx
  on bakery.domain_events (organization_id, application_id, organization_sequence)
  where application_id is not null;

drop index concurrently if exists bakery.domain_events_repository_sequence_idx;

create index concurrently domain_events_repository_sequence_idx
  on bakery.domain_events (organization_id, repository_id, organization_sequence)
  where repository_id is not null;

drop index concurrently if exists bakery.domain_events_task_sequence_idx;

create index concurrently domain_events_task_sequence_idx
  on bakery.domain_events (organization_id, task_id, organization_sequence)
  where task_id is not null;

drop index concurrently if exists bakery.domain_events_conversation_sequence_idx;

create index concurrently domain_events_conversation_sequence_idx
  on bakery.domain_events (organization_id, conversation_id, organization_sequence)
  where conversation_id is not null;
