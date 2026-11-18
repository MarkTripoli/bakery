-- The inbox-changed signal and an undoable mark-all-read (chapter 24, #455).
--
-- One "mark all read" press. Rows it changed point back at it so an undo can
-- restore exactly those rows and nothing a later action touched.
create table bakery.notification_read_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  recipient_id uuid not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  constraint notification_read_batches_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint notification_read_batches_recipient_fk
    foreign key (recipient_id)
    references bakery.principals (id) on delete cascade,
  constraint notification_read_batches_organization_id_unique
    unique (organization_id, id)
);
create index notification_read_batches_recipient_idx
  on bakery.notification_read_batches (organization_id, recipient_id, created_at desc);
grant select, insert on bakery.notification_read_batches to bakery_app;
grant update (undone_at) on bakery.notification_read_batches to bakery_app;

alter table bakery.notifications add column read_batch_id uuid;
alter table bakery.notifications
  add constraint notifications_read_batch_fk
    foreign key (organization_id, read_batch_id)
    references bakery.notification_read_batches (organization_id, id);
create index notifications_read_batch_idx
  on bakery.notifications (organization_id, read_batch_id)
  where read_batch_id is not null;
grant update (read_batch_id) on bakery.notifications to bakery_app;

-- An inbox-changed event belongs to exactly one person. The events stream
-- delivers a row with recipient_id only to the subscription for that same
-- principal, so a count signal never reaches anyone else.
alter table bakery.domain_events add column recipient_id uuid;
create index domain_events_recipient_idx
  on bakery.domain_events (organization_id, recipient_id, organization_sequence)
  where recipient_id is not null;
