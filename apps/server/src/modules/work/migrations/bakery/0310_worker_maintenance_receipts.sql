-- Issue #25 slice B1: worker maintenance reports.
--
-- One row per accepted worker report on a maintenance operation
-- (docs/technical-design/21-machines.md, "Remote maintenance and recovery").
-- Reports are sequenced per operation from 1 with no gaps; the stored digest
-- and response let an exact duplicate delivery replay the original answer and
-- make a changed duplicate an IDEMPOTENCY_PAYLOAD_MISMATCH. Phase rules live
-- in TypeScript (execution/maintenance-delivery.ts): no CHECK constraints,
-- triggers or RLS here.
create table bakery.worker_maintenance_receipts (
  organization_id uuid not null,
  operation_id uuid not null,
  sequence integer not null,
  worker_host_id uuid not null,
  fence bigint not null,
  phase text not null,
  payload_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint worker_maintenance_receipts_pkey
    primary key (organization_id, operation_id, sequence),
  constraint worker_maintenance_receipts_operation_fk
    foreign key (organization_id, operation_id)
    references bakery.worker_maintenance_operations (organization_id, id)
    on delete cascade,
  constraint worker_maintenance_receipts_host_fk
    foreign key (organization_id, worker_host_id)
    references bakery.worker_hosts (organization_id, id) on delete cascade
);

grant select, insert
  on bakery.worker_maintenance_receipts
  to bakery_app;

-- Handing an operation to the host sets its execution deadline.
grant update (deadline_at)
  on bakery.worker_maintenance_operations
  to bakery_app;
