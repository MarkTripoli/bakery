-- A person restarts a queued step (#412 slice 3b): its job gets one more attempt
-- that starts fresh, with a note. That is four column updates on bakery.jobs.
--
-- Why these four and no more:
-- * max_attempts: the one more attempt.
-- * current_checkpoints: reset to '[]' so the next attempt resumes from nothing.
-- * input: the person's note is appended to `stepNotes`. The job's input is still
--   checked on every admission and claim against the run snapshot, and its
--   `stepNotes` against the recorded run_step_note_deliveries for that job, so a
--   write here that disagrees with either is refused there.
-- * available_at: the restarted job is claimable now, not after a retry backoff.
-- status, current_fence and cancel_requested_at already have their grants.
grant update (max_attempts, current_checkpoints, input, available_at)
  on bakery.jobs
  to bakery_app;
