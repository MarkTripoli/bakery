-- Coordinator turn jobs. A standalone job (no run step, no repository pin)
-- answers one conversation turn; conversation_turn_id links the two so scope
-- derives through the turn. TypeScript owns the invariants (one attempt, the
-- null repository pin, admission); the PostgreSQL boundary rail forbids CHECK
-- constraints in new migrations. The application role may set the link at
-- insert time only: it has no UPDATE grant on the column.
alter table bakery.jobs
  add column conversation_turn_id uuid;

alter table bakery.jobs
  add constraint jobs_conversation_turn_fk
  foreign key (organization_id, conversation_turn_id)
  references bakery.conversation_turns (organization_id, id)
  on delete restrict;

create unique index jobs_conversation_turn_unique
  on bakery.jobs (organization_id, conversation_turn_id)
  where conversation_turn_id is not null;

grant insert (conversation_turn_id) on bakery.jobs to bakery_app;
