-- AI-authored title and global importance score.
--
-- `title` is nullable on purpose: rows summarized before this migration have no
-- title and must keep publishing exactly as before (the digest falls back to the
-- summary alone). `importance` is written by the global ranking stage and stays
-- NULL until that stage has seen the row.

ALTER TABLE messages ADD COLUMN title TEXT;
ALTER TABLE messages ADD COLUMN importance INTEGER;