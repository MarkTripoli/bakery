-- Remember the last update that did not start (#76).
--
-- An update pins another version of the package only after that version passes
-- its checks. When it does not (the host's SDK cannot run it, or its manifest
-- is invalid) the install keeps running on its prior version, which is the
-- right outcome but left nothing behind: a person who came back to the page
-- could not tell that an update had been tried and refused.
--
-- last_update_failure holds the version that was tried, why it was refused and
-- when, as one json object, and is null when there is nothing to show. It is
-- cleared by the next update that succeeds or by a person dismissing it. It is
-- plain data beside the install, written by the same writer that refused the
-- update, so it needs no constraint: the boundary rail forbids CHECK
-- constraints and triggers in new migrations, and the writer validates the
-- shape. bakery_app already holds table-level update on plugin_installs.
alter table bakery.plugin_installs
  add column last_update_failure jsonb;
