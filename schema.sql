CREATE TABLE IF NOT EXISTS processed_updates (
  update_id BIGINT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_visits (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  utm_source TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_medium TEXT,
  page TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_web_visits_created_at ON web_visits(created_at);
CREATE INDEX IF NOT EXISTS idx_web_visits_source ON web_visits(source);

CREATE TABLE IF NOT EXISTS button_clicks (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  utm_source TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  destination TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_button_clicks_created_at ON button_clicks(created_at);
CREATE INDEX IF NOT EXISTS idx_button_clicks_source ON button_clicks(source);

CREATE TABLE IF NOT EXISTS invite_links (
  id BIGSERIAL PRIMARY KEY,
  invite_link TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS join_requests (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  telegram_user_id BIGINT NOT NULL,
  invite_link TEXT,
  invite_name TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  raw_update JSONB
);

CREATE INDEX IF NOT EXISTS idx_join_requests_requested_at ON join_requests(requested_at);
CREATE INDEX IF NOT EXISTS idx_join_requests_status ON join_requests(status);
CREATE INDEX IF NOT EXISTS idx_join_requests_source ON join_requests(source);
CREATE INDEX IF NOT EXISTS idx_join_requests_user ON join_requests(telegram_user_id);

CREATE TABLE IF NOT EXISTS member_events (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  telegram_user_id BIGINT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_update JSONB
);

CREATE INDEX IF NOT EXISTS idx_member_events_occurred_at ON member_events(occurred_at);

INSERT INTO settings(key, value)
VALUES ('channel_name', 'VISHAL QX')
ON CONFLICT (key) DO NOTHING;
