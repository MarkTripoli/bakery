alter table bakery.conversation_turns
  drop constraint conversation_turns_trigger_message_unique,
  add column retry_of_turn_id uuid,
  add constraint conversation_turns_retry_of_fk
  foreign key (organization_id, retry_of_turn_id)
  references bakery.conversation_turns (organization_id, id) on delete restrict;

create unique index conversation_turns_trigger_message_live_idx
  on bakery.conversation_turns (trigger_message_id)
  where status <> 'failed';

create index conversation_turns_retry_of_idx
  on bakery.conversation_turns (organization_id, retry_of_turn_id)
  where retry_of_turn_id is not null;
