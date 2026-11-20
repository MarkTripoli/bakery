-- Why a merge entry was blocked, so the queue can say it instead of showing a
-- silent dead end (#57 slice 2). Null unless the entry is blocked. The reasons
-- are a closed set kept in code, not here: not_open, head_moved, base_moved,
-- checks_not_passed, not_permitted, evidence_changed, github_refused,
-- not_merged, unavailable.
alter table bakery.merge_entries add column blocked_reason text;
