-- One active entry per topic, enforced where nothing can skip it (#22 AC1).
--
-- The "one active entry per topic" rule lived only in the application: every
-- write path had to remember to re-check before it could make an entry active
-- or move its topic. Two separate paths were found that did not, each leaving
-- two active entries on one topic. A partial unique index states the invariant
-- once, in the only place a path cannot go around, so a future write path that
-- forgets is refused by the database rather than by review.
--
-- The comparison is on `lower(topic)`: the topic label is what a reader
-- searches and groups by, and "Deploy" and "deploy" are one topic to them.
-- Retired and proposed entries are unlimited - the rule is about what a reader
-- retrieves, and a retired entry is not retrieved.
create unique index memory_entries_one_active_per_topic_idx
  on bakery.memory_entries (organization_id, repository_id, lower(topic))
  where status = 'active';
