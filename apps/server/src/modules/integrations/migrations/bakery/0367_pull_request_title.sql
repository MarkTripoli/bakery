-- The pull request's title, stored from the provider read (chapter 18, #75).
--
-- A metrics drilldown names the pull request it counts, so the title is kept
-- with the row instead of being fetched on every page view. It is not
-- lifecycle state: a read refreshes it without bumping the row version, and a
-- stale read leaves the stored title alone. Null until a read carries one. The
-- body stays out: only the title is stored.
alter table bakery.pull_requests
  add column title text;

grant update (title) on bakery.pull_requests to bakery_app;
