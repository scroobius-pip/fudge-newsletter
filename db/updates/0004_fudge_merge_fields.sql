-- Fudge: per-recipient merge fields.
ALTER TABLE subscribers ADD COLUMN segment TEXT;
ALTER TABLE campaigns ADD COLUMN merge_json TEXT;
CREATE INDEX IF NOT EXISTS idx_subscribers_segment ON subscribers(newsletter_id, segment);
