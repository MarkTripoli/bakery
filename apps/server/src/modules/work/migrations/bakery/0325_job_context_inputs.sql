-- The input slots a step declared, pinned when its job is admitted.
--
-- Each element is {slot, path, digest, sizeBytes, mediaType, kind}: the slot
-- name the workflow chose, the relative path the worker writes the bytes to,
-- and the digest, size and media type those bytes had at admission. The claim
-- copies the list onto the assignment, so the worker verifies the bytes the
-- admission pinned and never a re-fetched copy. A step without declared slots
-- keeps the empty list.
alter table bakery.jobs
  add column context_inputs jsonb not null default '[]'::jsonb;

alter table bakery.jobs
  add constraint jobs_context_inputs_array_check
  check (jsonb_typeof(context_inputs) = 'array');

-- Admission writes the list once with the job; no update grant is given, so a
-- pin cannot change under a claimed attempt.
grant insert (context_inputs) on bakery.jobs to bakery_app;
