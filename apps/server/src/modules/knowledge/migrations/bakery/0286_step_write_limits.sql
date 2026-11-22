-- Step write limits (O49, chapter 25 section 17.6, issue #448): how much one
-- run step attempt may write through an agent. Null means Bakery's default in
-- storage-areas.ts (2 GiB and 2,000 files), so existing rows keep the default
-- and an Admin who never saves them never pins today's value.
--   step_write_bytes  bytes the versions one attempt's puts and copies make;
--   step_write_files  distinct entries one attempt writes.
-- The limits are enforced in storage-working-areas.ts, in the write's
-- transaction under the organization's storage lock, not here.
alter table bakery.storage_settings
  add column step_write_bytes bigint,
  add column step_write_files integer;
