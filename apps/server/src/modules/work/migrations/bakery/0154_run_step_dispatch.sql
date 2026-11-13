-- A compiled-plan run appends its step rows on demand. The engine records the
-- dispatch it decided for a row (action, resolved input, requirements, agent
-- version, retry policy) beside the row, so the job, its claim eligibility and
-- every revalidation read what was decided, not a recomputation. Rows of
-- flat runs, which carry their action in the run snapshot, leave it null.
alter table bakery.run_steps
  add column dispatch jsonb;
