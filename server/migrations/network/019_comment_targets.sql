-- comment_targets: m2m attachments of a comment to thoughts/links (L20,
-- docs/02-data-model.md §3.8). A chronological comment may be attached to
-- several owners at once; `comments.owner_type/owner_id` keep the primary
-- (first) attachment, while this table holds the full set. Permanent comments
-- always have exactly one target.
--
-- No SQL FK (polymorphic, same as comments); the service cleans rows on
-- comment delete and on owner delete cascades in its own transactions.

CREATE TABLE IF NOT EXISTS comment_targets (
  comment_id  TEXT NOT NULL,                      -- FK (no SQL constraint) → comments.id
  owner_type  TEXT NOT NULL,                      -- 'thought' | 'link'
  owner_id    TEXT NOT NULL,                      -- FK (no SQL constraint) → thoughts/links
  PRIMARY KEY (comment_id, owner_type, owner_id)
);

-- List comments attached to an owner (any m2m row, not only the primary one).
CREATE INDEX IF NOT EXISTS idx_comment_targets_owner ON comment_targets (owner_type, owner_id);

-- Backfill: every existing comment's primary owner becomes its single target.
INSERT OR IGNORE INTO comment_targets (comment_id, owner_type, owner_id)
  SELECT id, owner_type, owner_id FROM comments;
